# Sports Cards Recommender

A small hybrid recommender for sports cards. Pick cards you like, get a ranked list of others you might enjoy, with explanations for *why* each one was suggested.

**Live demo:** _will appear at_ `https://<your-username>.github.io/<repo-name>/` _once GitHub Pages is enabled._

## How it works

The recommender blends four signals — and the weights are user-tunable via sliders in the UI:

| Signal | Source | What it captures |
| --- | --- | --- |
| **CF** (collaborative filtering) | Cosine similarity of cards' user-rating vectors | "Users who rated your picks similarly also rated these" |
| **Content** | Card metadata (Player, Sport, Set, Year, Parallel, Rookie/Auto/Relic) | Same player, same set, same era, etc. |
| **Image** | CLIP ViT-B/32 image embeddings | Visually similar cards (refractors, parallels, era look) |
| **Popularity** | Log-scaled eBay sold-listings count | Cards with active resale demand |

Final score = α·CF + β·Content + γ·Image + δ·Popularity, with weights normalized to sum to 1.

## Repo layout

```
app.py                  # Python server (full version, runs locally)
hello.py                # Original notebook-style script that started the project
image_embed.py          # Loads cached CLIP embeddings
embed_images.py         # Standalone CLI: embed all card images with CLIP
popularity.py           # Loads cached eBay popularity data
fetch_popularity.py     # Standalone CLI: scrape eBay sold listings
precompute.py           # Generate static JSON for the GitHub Pages demo
index.html              # Frontend used by the local Python server
docs/                   # GitHub Pages: static, client-side port of the recommender
  index.html
  app.js
  styles.css
  data/                 # Precomputed JSON: cards, CF pairs, image pairs, popularity
  images/               # Card scans
SCI 500 card data.csv   # Card metadata (cardId, name, player, set, year, etc.)
fake ratings data.csv   # Synthetic user ratings used by CF
```

## Running locally (full Python version)

```bash
pip3 install --user numpy pandas scipy scikit-learn torch open_clip_torch pillow requests beautifulsoup4
python3 embed_images.py        # ~2 min on CPU; downloads ~150MB CLIP weights first time
python3 fetch_popularity.py    # ~7 min to scrape all 162 cards politely (eBay HTML may change)
python3 app.py                 # then open http://localhost:8000
```

The Python server reads cached image embeddings and popularity from disk; it gracefully no-ops if either is missing.

## Rebuilding the static demo

After re-fetching popularity or re-embedding images, regenerate the static data:

```bash
python3 precompute.py
```

This writes `docs/data/*.json` and copies images into `docs/images/`. Commit the changes and push — GitHub Pages will redeploy automatically.

## Notes on the data

- The `SCI 500 card data.csv` file contains 500 rows but only **162 unique real cards** — the remaining 338 rows are placeholder duplicates. `precompute.py` filters them out.
- `fake ratings data.csv` is synthetic. Of the 162 real cards, only **74** have ratings, so CF can only score those directly. Content and image signals fill in the cold-start gap.
- Card images are scans of trading cards. Underlying card designs are © their respective manufacturers.
