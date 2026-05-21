"""One-time fetcher: scrape eBay sold-listings counts and median prices per card.

Usage:
    python3 fetch_popularity.py            # fetch everything missing
    python3 fetch_popularity.py --refresh  # re-fetch all
    python3 fetch_popularity.py --limit 10 # only the first N cards (testing)

Be polite — the script sleeps between requests. If eBay blocks you, raise the delay
or run it in smaller batches. Scraping is brittle by nature; if eBay changes its
HTML, the parsers below need updating.
"""

import argparse
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from statistics import median

import pandas as pd
import requests
from bs4 import BeautifulSoup

HERE = os.path.dirname(os.path.abspath(__file__))
CARDS_CSV = os.path.join(HERE, "SCI 500 card data.csv")
CACHE_PATH = os.path.join(HERE, "popularity_cache.json")
PLACEHOLDER_NAME = "Randy Moss RC 1998 Topps Chrome #35 Refractor"

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 "
    "(KHTML, like Gecko) Version/17.0 Safari/605.1.15"
)


def load_cards():
    df = pd.read_csv(CARDS_CSV)
    df = df.loc[:, ~df.columns.str.startswith("Unnamed")]
    df = df.dropna(subset=["cardId", "cardName"])
    df["cardId"] = df["cardId"].astype(int)
    df = df[df["cardName"] != PLACEHOLDER_NAME].reset_index(drop=True)
    return df


def build_query(row):
    parts = [str(row.get("Player") or ""), str(row.get("Year") or ""),
             str(row.get("Set") or ""), str(row.get("Parallel") or "")]
    if row.get("Rookie"):
        parts.append("rookie")
    if row.get("Auto"):
        parts.append("auto")
    if row.get("Relic"):
        parts.append("relic")
    q = " ".join(p for p in parts if p and p.lower() not in ("nan", "0", "none"))
    return q.strip() or str(row["cardName"])


def fetch_one(query, session):
    url = "https://www.ebay.com/sch/i.html"
    params = {
        "_nkw": query,
        "_sacat": "0",
        "LH_Sold": "1",
        "LH_Complete": "1",
        "_ipg": "60",
    }
    r = session.get(url, params=params, timeout=20)
    r.raise_for_status()
    return r.text


def parse_results(html):
    soup = BeautifulSoup(html, "html.parser")

    sold_count = 0
    header = soup.find(class_="srp-controls__count-heading")
    if header:
        m = re.search(r"([\d,]+)", header.get_text(" ", strip=True))
        if m:
            sold_count = int(m.group(1).replace(",", ""))

    prices = []
    for el in soup.select("li.s-item span.s-item__price"):
        text = el.get_text(" ", strip=True)
        # Skip price ranges like "$10.00 to $20.00" — take the lower bound.
        m = re.search(r"\$([\d,]+\.\d{2})", text)
        if m:
            try:
                prices.append(float(m.group(1).replace(",", "")))
            except ValueError:
                pass

    return {
        "soldCount": sold_count,
        "medianPrice": round(median(prices), 2) if prices else None,
        "sampleSize": len(prices),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--refresh", action="store_true", help="re-fetch even if cached")
    parser.add_argument("--limit", type=int, default=None, help="only first N cards")
    parser.add_argument("--delay", type=float, default=2.5, help="seconds between requests")
    args = parser.parse_args()

    cards = load_cards()
    if args.limit:
        cards = cards.head(args.limit)

    cache = {}
    if os.path.isfile(CACHE_PATH):
        with open(CACHE_PATH) as f:
            cache = json.load(f)

    session = requests.Session()
    session.headers.update({"User-Agent": USER_AGENT, "Accept-Language": "en-US,en;q=0.9"})

    total = len(cards)
    for i, (_, row) in enumerate(cards.iterrows(), start=1):
        cid = str(int(row["cardId"]))
        if not args.refresh and cid in cache:
            print(f"[{i}/{total}] cardId={cid}  (cached, skip)")
            continue
        query = build_query(row)
        print(f"[{i}/{total}] cardId={cid}  query={query!r} ...", end=" ", flush=True)
        try:
            html = fetch_one(query, session)
            data = parse_results(html)
            data["query"] = query
            data["fetchedAt"] = datetime.now(timezone.utc).isoformat()
            cache[cid] = data
            print(f"sold={data['soldCount']} median={data['medianPrice']}")
        except requests.HTTPError as e:
            print(f"HTTP {e.response.status_code if e.response else '??'} — skip")
        except Exception as e:
            print(f"ERR {type(e).__name__}: {e}")

        # Persist after each request so a crash mid-run doesn't lose progress.
        with open(CACHE_PATH, "w") as f:
            json.dump(cache, f, indent=2)
        time.sleep(args.delay)

    print(f"\nDone. Cache: {CACHE_PATH}  ({len(cache)} entries)")


if __name__ == "__main__":
    sys.exit(main())
