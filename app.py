"""Local demo: rate cards, get hybrid recommendations.

Hybrid score = α·CF + β·content + γ·image + δ·popularity, weights from the UI sliders.

Run:  python3 app.py
Then: open http://localhost:8000
"""

import json
import os
import random
import math
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

import numpy as np
import pandas as pd
from scipy.sparse import csr_matrix

import image_embed
import popularity

HERE = os.path.dirname(os.path.abspath(__file__))
CARDS_CSV = os.path.join(HERE, "SCI 500 card data.csv")
RATINGS_CSV = os.path.join(HERE, "fake ratings data.csv")
IMAGES_DIR = os.path.join(HERE, "SCI 500 ")  # source folder name has a trailing space
PLACEHOLDER_NAME = "Randy Moss RC 1998 Topps Chrome #35 Refractor"

DEFAULT_WEIGHTS = {"cf": 0.4, "content": 0.25, "image": 0.25, "popularity": 0.1}


# ──────────────────────────── data loading ────────────────────────────

def load_data():
    cards = pd.read_csv(CARDS_CSV)
    cards = cards.loc[:, ~cards.columns.str.startswith("Unnamed")]
    cards = cards.dropna(subset=["cardId", "cardName"])
    cards["cardId"] = cards["cardId"].astype(int)
    cards = cards[cards["cardName"] != PLACEHOLDER_NAME].reset_index(drop=True)

    ratings = pd.read_csv(RATINGS_CSV)
    ratings.columns = [c.strip().lstrip("﻿") for c in ratings.columns]
    ratings = ratings.dropna()
    ratings["cardId"] = ratings["cardId"].astype(int)
    ratings["userId"] = ratings["userId"].astype(int)
    ratings = ratings[ratings["cardId"].isin(cards["cardId"])].reset_index(drop=True)
    return cards, ratings


def build_cf(ratings):
    user_ids = np.sort(ratings["userId"].unique())
    card_ids = np.sort(ratings["cardId"].unique())
    user_mapper = {u: i for i, u in enumerate(user_ids)}
    card_mapper = {c: i for i, c in enumerate(card_ids)}
    card_inv_mapper = {i: c for c, i in card_mapper.items()}

    rows = ratings["cardId"].map(card_mapper).to_numpy()
    cols = ratings["userId"].map(user_mapper).to_numpy()
    vals = ratings["rating"].to_numpy(dtype=float)
    X = csr_matrix((vals, (rows, cols)), shape=(len(card_ids), len(user_ids)))

    # Pre-normalize rows so cosine = dot.
    norms = np.sqrt(np.asarray(X.multiply(X).sum(axis=1)).ravel())
    norms[norms == 0] = 1.0
    return X, norms, card_mapper, card_inv_mapper


def card_to_dict(row):
    def clean(v):
        if isinstance(v, float) and math.isnan(v):
            return None
        return v

    def to_int(v, default=0):
        if v is None or (isinstance(v, float) and math.isnan(v)):
            return default
        try:
            return int(v)
        except (ValueError, TypeError):
            return default

    numbered_raw = row.get("NumberedTo")
    cid = int(row["cardId"])
    return {
        "cardId": cid,
        "cardName": clean(row["cardName"]),
        "Player": clean(row.get("Player")),
        "Year": to_int(row.get("Year"), default=None),
        "Sport": clean(row.get("Sport")),
        "Set": clean(row.get("Set")),
        "Rookie": to_int(row.get("Rookie")),
        "Auto": to_int(row.get("Auto")),
        "Relic": to_int(row.get("Relic")),
        "Parallel": clean(row.get("Parallel")),
        "NumberedTo": clean(numbered_raw) if isinstance(numbered_raw, str) else to_int(numbered_raw),
        "imageUrl": f"/images/{cid}",
    }


CARDS_DF, RATINGS_DF = load_data()
X, ROW_NORMS, CARD_MAPPER, CARD_INV_MAPPER = build_cf(RATINGS_DF)
CARDS_BY_ID = {int(r["cardId"]): card_to_dict(r) for _, r in CARDS_DF.iterrows()}
ALL_IDS = list(CARDS_BY_ID.keys())
RATEABLE_IDS = [cid for cid in ALL_IDS if cid in CARD_MAPPER]
print(f"Loaded {len(CARDS_BY_ID)} cards, {len(RATINGS_DF)} ratings, "
      f"{len(RATEABLE_IDS)} cards with rating vectors.")
print(f"Image embeddings cached: {image_embed.has_data()}   "
      f"Popularity cached: {popularity.has_data()}")


def sample_cards(n=12, seed=None):
    rng = random.Random(seed)
    pool = ALL_IDS  # sample from all real cards, even those without ratings
    chosen = rng.sample(pool, min(n, len(pool)))
    return [CARDS_BY_ID[c] for c in chosen]


# ──────────────────────────── component scores ────────────────────────────

def cf_score(card_id, seed_ids):
    """Mean cosine similarity (rating-vector) between candidate and seed cards."""
    if card_id not in CARD_MAPPER:
        return 0.0
    cand_idx = CARD_MAPPER[card_id]
    cand = X[cand_idx].toarray().ravel()
    cand_norm = ROW_NORMS[cand_idx]
    sims = []
    for sid in seed_ids:
        if sid not in CARD_MAPPER:
            continue
        sidx = CARD_MAPPER[sid]
        seed = X[sidx].toarray().ravel()
        denom = cand_norm * ROW_NORMS[sidx]
        if denom == 0:
            continue
        sims.append(float(np.dot(cand, seed) / denom))
    if not sims:
        return 0.0
    return max(0.0, sum(sims) / len(sims))


# Content-feature weights — sum doesn't need to be 1, normalized below.
_CONTENT_WEIGHTS = {
    "Player": 3.0,
    "Sport": 1.0,
    "Set": 1.5,
    "Year": 1.0,
    "Parallel": 1.0,
    "Rookie": 1.0,
    "Auto": 1.5,
    "Relic": 1.0,
}
_CONTENT_TOTAL = sum(_CONTENT_WEIGHTS.values())


def content_score(card_id, seed_ids):
    """Weighted attribute overlap with the average seed."""
    cand = CARDS_BY_ID.get(card_id)
    if not cand:
        return 0.0
    seeds = [CARDS_BY_ID[s] for s in seed_ids if s in CARDS_BY_ID]
    if not seeds:
        return 0.0

    per_seed_scores = []
    for seed in seeds:
        s = 0.0
        # Categorical exact-match features
        for key in ("Player", "Sport", "Set", "Parallel"):
            v = cand.get(key)
            if v and v == seed.get(key) and v not in ("0", 0):
                s += _CONTENT_WEIGHTS[key]
        # Year: 1.0 if same, fall off linearly within 5 years
        cy, sy = cand.get("Year"), seed.get("Year")
        if cy and sy:
            diff = abs(int(cy) - int(sy))
            if diff <= 5:
                s += _CONTENT_WEIGHTS["Year"] * (1.0 - diff / 5.0)
        # Boolean flags: only credit when both true
        for flag in ("Rookie", "Auto", "Relic"):
            if cand.get(flag) and seed.get(flag):
                s += _CONTENT_WEIGHTS[flag]
        per_seed_scores.append(s / _CONTENT_TOTAL)

    return sum(per_seed_scores) / len(per_seed_scores)


def image_score(card_id, seed_ids):
    return image_embed.similarity_to_seeds(card_id, seed_ids)


def popularity_score(card_id):
    return popularity.score(card_id)


# ──────────────────────────── hybrid scoring ────────────────────────────

def normalize_weights(w):
    out = dict(DEFAULT_WEIGHTS)
    for k, v in (w or {}).items():
        if k in out:
            try:
                out[k] = max(0.0, float(v))
            except (TypeError, ValueError):
                pass
    total = sum(out.values()) or 1.0
    return {k: v / total for k, v in out.items()}


def score_card(card_id, seed_ids, weights):
    components = {
        "cf": cf_score(card_id, seed_ids),
        "content": content_score(card_id, seed_ids),
        "image": image_score(card_id, seed_ids),
        "popularity": popularity_score(card_id),
    }
    combined = sum(weights[k] * components[k] for k in components)
    contributions = {k: round(weights[k] * components[k], 4) for k in components}
    return combined, components, contributions


# ──────────────────────────── explanation ────────────────────────────

def _shared_attributes(rec, seed):
    shared = []
    if rec.get("Player") and rec["Player"] == seed.get("Player"):
        shared.append(f"same player ({rec['Player']})")
    if rec.get("Sport") and rec["Sport"] == seed.get("Sport"):
        shared.append(f"same sport ({rec['Sport']})")
    if rec.get("Set") and rec["Set"] == seed.get("Set"):
        shared.append(f"same set ({rec['Set']})")
    if rec.get("Year") and rec["Year"] == seed.get("Year"):
        shared.append(f"same year ({rec['Year']})")
    if rec.get("Parallel") and rec["Parallel"] == seed.get("Parallel") and rec["Parallel"] not in (None, "0", 0):
        shared.append(f"same parallel ({rec['Parallel']})")
    for key, label in (("Rookie", "rookie card"), ("Auto", "autograph"), ("Relic", "relic")):
        if rec.get(key) and seed.get(key):
            shared.append(f"both are {label}s")
    return shared


_SIGNAL_LABELS = {
    "cf": "users with similar taste",
    "content": "matching card attributes",
    "image": "visual similarity",
    "popularity": "eBay popularity",
}


def explain(rec, seed_ids, components, contributions):
    seeds = [CARDS_BY_ID[s] for s in seed_ids if s in CARDS_BY_ID]
    per_seed = []
    for seed in seeds:
        per_seed.append({
            "seedId": seed["cardId"],
            "seedName": seed["cardName"],
            "shared": _shared_attributes(rec, seed),
        })

    # Top driver = component with the largest weighted contribution.
    top = max(contributions.items(), key=lambda kv: kv[1])
    top_label = _SIGNAL_LABELS.get(top[0], top[0])
    summary_parts = [f"Top signal: **{top_label}** (raw {components[top[0]]:.2f})."]

    pop = popularity.raw(rec["cardId"])
    if pop and pop.get("soldCount"):
        msg = f"eBay sold listings: {pop['soldCount']}"
        if pop.get("medianPrice"):
            msg += f", median ${pop['medianPrice']}"
        summary_parts.append(msg + ".")

    overlaps = []
    for entry in per_seed:
        for s in entry["shared"]:
            if s not in overlaps:
                overlaps.append(s)
    if overlaps:
        summary_parts.append("Shares with your picks: " + ", ".join(overlaps) + ".")

    return {"summary": " ".join(summary_parts), "perSeed": per_seed}


# ──────────────────────────── main API ────────────────────────────

def recommend(liked_ids, weights=None, k=10):
    valid = [cid for cid in liked_ids if cid in CARDS_BY_ID]
    if not valid:
        return []
    weights = normalize_weights(weights)

    seen = set(valid)
    scored = []
    for cid in ALL_IDS:
        if cid in seen:
            continue
        combined, components, contributions = score_card(cid, valid, weights)
        if combined <= 0:
            continue
        scored.append((combined, cid, components, contributions))

    scored.sort(key=lambda r: r[0], reverse=True)
    out = []
    for combined, cid, components, contributions in scored[:k]:
        card = dict(CARDS_BY_ID[cid])
        card["score"] = round(combined, 4)
        card["components"] = {k: round(v, 4) for k, v in components.items()}
        card["contributions"] = contributions
        card["why"] = explain(card, valid, components, contributions)
        out.append(card)
    return out


# ──────────────────────────── HTTP server ────────────────────────────

INDEX_HTML_PATH = os.path.join(HERE, "index.html")


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print("[%s] %s" % (self.address_string(), fmt % args))

    def _send_json(self, payload, status=200):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_html(self, path):
        with open(path, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_image(self, raw_id):
        if not raw_id.isdigit():
            self.send_error(400, "Invalid image id")
            return
        path = os.path.join(IMAGES_DIR, f"SCI_{int(raw_id)}.jpeg")
        if not os.path.isfile(path):
            self.send_error(404, "Image not found")
            return
        with open(path, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", "image/jpeg")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "public, max-age=86400")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        url = urlparse(self.path)
        if url.path in ("/", "/index.html"):
            self._send_html(INDEX_HTML_PATH)
            return
        if url.path.startswith("/images/"):
            self._send_image(url.path[len("/images/"):])
            return
        if url.path == "/api/sample":
            qs = parse_qs(url.query)
            n = int(qs.get("n", ["12"])[0])
            seed = qs.get("seed", [None])[0]
            seed = int(seed) if seed and seed.isdigit() else None
            self._send_json({"cards": sample_cards(n=n, seed=seed)})
            return
        if url.path == "/api/status":
            self._send_json({
                "totalCards": len(CARDS_BY_ID),
                "rateableCards": len(RATEABLE_IDS),
                "imageEmbeddings": image_embed.has_data(),
                "popularity": popularity.has_data(),
                "defaultWeights": DEFAULT_WEIGHTS,
            })
            return
        self.send_error(404, "Not found")

    def do_POST(self):
        url = urlparse(self.path)
        if url.path != "/api/recommend":
            self.send_error(404, "Not found")
            return
        length = int(self.headers.get("Content-Length", "0"))
        try:
            data = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            self._send_json({"error": "invalid json"}, status=400)
            return
        liked_ids = [int(x) for x in data.get("likedIds", []) if str(x).lstrip("-").isdigit()]
        weights = data.get("weights") or {}
        k = int(data.get("k", 10))
        recs = recommend(liked_ids, weights=weights, k=k)
        self._send_json({
            "recommendations": recs,
            "weights": normalize_weights(weights),
        })


def main():
    port = int(os.environ.get("PORT", "8000"))
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"Serving on http://localhost:{port}  (Ctrl+C to stop)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")
        server.server_close()


if __name__ == "__main__":
    main()
