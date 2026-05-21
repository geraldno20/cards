"""Generate the static JSON data files that the GitHub Pages demo loads.

Run:  python3 precompute.py
Outputs: docs/data/{cards,cf_sims,image_sims,popularity,meta}.json
"""

import json
import math
import os
import shutil
import sys

import numpy as np
import pandas as pd
from scipy.sparse import csr_matrix

HERE = os.path.dirname(os.path.abspath(__file__))
DOCS = os.path.join(HERE, "docs")
DATA_DIR = os.path.join(DOCS, "data")
IMAGES_OUT = os.path.join(DOCS, "images")
SRC_IMAGES = os.path.join(HERE, "SCI 500 ")  # source folder has trailing space

CARDS_CSV = os.path.join(HERE, "SCI 500 card data.csv")
RATINGS_CSV = os.path.join(HERE, "fake ratings data.csv")
EMBED_CACHE = os.path.join(HERE, "image_embeddings.npz")
POP_CACHE = os.path.join(HERE, "popularity_cache.json")
PLACEHOLDER_NAME = "Randy Moss RC 1998 Topps Chrome #35 Refractor"


def load_cards():
    df = pd.read_csv(CARDS_CSV)
    df = df.loc[:, ~df.columns.str.startswith("Unnamed")]
    df = df.dropna(subset=["cardId", "cardName"])
    df["cardId"] = df["cardId"].astype(int)
    df = df[df["cardName"] != PLACEHOLDER_NAME].reset_index(drop=True)
    return df


def load_ratings(card_ids):
    df = pd.read_csv(RATINGS_CSV)
    df.columns = [c.strip().lstrip("﻿") for c in df.columns]
    df = df.dropna()
    df["cardId"] = df["cardId"].astype(int)
    df["userId"] = df["userId"].astype(int)
    df = df[df["cardId"].isin(card_ids)].reset_index(drop=True)
    return df


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
        "imageUrl": f"images/SCI_{cid}.jpeg",
    }


def pair_key(a, b):
    a, b = int(a), int(b)
    return f"{min(a,b)}-{max(a,b)}"


def cf_similarities(ratings):
    user_ids = np.sort(ratings["userId"].unique())
    card_ids = np.sort(ratings["cardId"].unique())
    user_mapper = {u: i for i, u in enumerate(user_ids)}
    card_mapper = {c: i for i, c in enumerate(card_ids)}

    rows = ratings["cardId"].map(card_mapper).to_numpy()
    cols = ratings["userId"].map(user_mapper).to_numpy()
    vals = ratings["rating"].to_numpy(dtype=float)
    X = csr_matrix((vals, (rows, cols)), shape=(len(card_ids), len(user_ids))).toarray()
    norms = np.linalg.norm(X, axis=1)
    norms[norms == 0] = 1.0
    Xn = X / norms[:, None]
    sims = Xn @ Xn.T  # (C, C)

    pairs = {}
    for i in range(len(card_ids)):
        for j in range(i + 1, len(card_ids)):
            v = float(sims[i, j])
            if v <= 0:
                continue
            pairs[pair_key(card_ids[i], card_ids[j])] = round(v, 4)
    return [int(c) for c in card_ids], pairs


def image_similarities():
    if not os.path.isfile(EMBED_CACHE):
        return [], {}
    data = np.load(EMBED_CACHE)
    ids = data["ids"].astype(int)
    vecs = data["vectors"].astype(np.float32)
    norms = np.linalg.norm(vecs, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    vecs = vecs / norms
    sims = vecs @ vecs.T

    pairs = {}
    for i in range(len(ids)):
        for j in range(i + 1, len(ids)):
            v = float(sims[i, j])
            # CLIP cosines tend to live in [0.5, 0.9]; rescale to [0,1] for comparability.
            scaled = max(0.0, min(1.0, (v - 0.5) / 0.5))
            if scaled <= 0:
                continue
            pairs[pair_key(ids[i], ids[j])] = round(scaled, 4)
    return [int(c) for c in ids], pairs


def load_popularity():
    if not os.path.isfile(POP_CACHE):
        return {}
    with open(POP_CACHE) as f:
        try:
            raw = json.load(f)
        except json.JSONDecodeError:
            return {}
    return {int(k): v for k, v in raw.items()}


def copy_images(card_ids):
    if not os.path.isdir(SRC_IMAGES):
        print(f"  ! source images dir missing: {SRC_IMAGES}")
        return 0
    os.makedirs(IMAGES_OUT, exist_ok=True)
    n = 0
    for cid in card_ids:
        src = os.path.join(SRC_IMAGES, f"SCI_{cid}.jpeg")
        dst = os.path.join(IMAGES_OUT, f"SCI_{cid}.jpeg")
        if os.path.isfile(src) and not os.path.isfile(dst):
            shutil.copy2(src, dst)
            n += 1
    return n


def main():
    os.makedirs(DATA_DIR, exist_ok=True)

    print("Loading cards + ratings ...")
    cards_df = load_cards()
    ratings_df = load_ratings(set(cards_df["cardId"]))
    cards_list = [card_to_dict(r) for _, r in cards_df.iterrows()]
    print(f"  {len(cards_list)} cards, {len(ratings_df)} ratings")

    print("Computing CF similarities ...")
    rateable_ids, cf_pairs = cf_similarities(ratings_df)
    print(f"  {len(rateable_ids)} rateable cards, {len(cf_pairs)} CF pairs")

    print("Loading image similarities ...")
    image_ids, image_pairs = image_similarities()
    print(f"  {len(image_ids)} image embeddings, {len(image_pairs)} image pairs")

    print("Loading popularity cache ...")
    pop = load_popularity()
    print(f"  {len(pop)} popularity entries")

    print("Copying card images ...")
    n_copied = copy_images([c["cardId"] for c in cards_list])
    print(f"  {n_copied} new images copied to {IMAGES_OUT}")

    # Write outputs
    out = {
        "cards.json": cards_list,
        "cf_sims.json": {"rateableIds": rateable_ids, "pairs": cf_pairs},
        "image_sims.json": {"ids": image_ids, "pairs": image_pairs},
        "popularity.json": {str(k): v for k, v in pop.items()},
        "meta.json": {
            "totalCards": len(cards_list),
            "rateableCards": len(rateable_ids),
            "imageEmbeddings": len(image_ids),
            "popularityEntries": len(pop),
        },
    }
    for fname, payload in out.items():
        path = os.path.join(DATA_DIR, fname)
        with open(path, "w") as f:
            json.dump(payload, f, separators=(",", ":"))
        print(f"  wrote {fname}  ({os.path.getsize(path) // 1024} KB)")

    print("Done.")


if __name__ == "__main__":
    sys.exit(main())
