# Sports Cards Recommender

A small hybrid recommender for sports cards. Pick cards you like, get a ranked list of others you might enjoy, with explanations for *why* each one was suggested.

**Live demo:** https://geraldno20.github.io/cards/ — the recommender, plus a
[Transactions](https://geraldno20.github.io/cards/#transactions) tab backed by a CSV database in this repo.

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
publish-ledger.sh       # Commit an exported ledger CSV to the published database
index.html              # Frontend used by the local Python server
docs/                   # GitHub Pages: static, client-side port of the recommender
  index.html
  app.js
  transactions.js       # Transactions tab: grid, margin math, CSV + GitHub sync
  styles.css
  data/                 # Precomputed JSON, plus transactions.csv — the ledger database
  images/               # Card scans
SCI 500 card data.csv   # Card metadata (cardId, name, player, set, year, etc.)
fake ratings data.csv   # Synthetic user ratings used by CF
```

## Transactions tab

A second tab in `docs/index.html` that tracks buys and sells, with the same columns as the
`GY_CY Cards Database` sheet:

| Group | Columns |
| --- | --- |
| Card | Sport, Year, Manufacturer, Athlete, Number, Description, Grade, Certification No. |
| Purchase | Date, From, Price |
| Sold | Date, Price, Payment Received |
| Expenses | Shipping, Grading, Fees |
| Margin | Profit, ROI *(calculated)* |

`Profit = Sold − Purchase − Shipping − Grading − Fees`, and `ROI = Profit ÷ (Purchase + expenses)`.
Unsold rows leave both blank and count toward **Holdings** instead. The tile row shows Total Cost,
Total Sale, Total Profit, ROI on sold, and holdings — and it recomputes over whatever the search box
and status filter currently show, so you can total up one player or one sport.

### The database

`docs/data/transactions.csv` **is** the database — a plain CSV committed to this repo and served by
GitHub Pages. 373 rows, extracted from the ledger pages of `GY_CY Cards Database.pdf` using the PDF's
own cell borders as the grid. The extraction was validated against the sheet's own summary block:

| | Extracted | Sheet's stored total |
| --- | --- | --- |
| Total Sale | $435.14 | $435.14 ✓ |
| Total Profit | $215.83 | $215.83 ✓ |
| Total Cost | $12,571.08 | $12,329.46 ✗ |

All 25 of the sheet's Profit cells agree with the formula exactly. **The Total Cost line in the sheet
is $241.62 low** — the purchase prices in its own rows add to $12,531.08, plus $40 of grading fees.
That looks like a `SUM` range that stopped growing when rows were added below it; the app recomputes
totals from the rows, so it doesn't inherit the error.

Note this repo is **public**, so the ledger — purchase prices, sale prices, profit, ROI — is public
too, and git history keeps every past version. Pages 10–30 of the PDF (Pokemon comps, grading
submissions, breaks, box purchases, supplies) are separate sheets and are not in this file.

Load order: the committed CSV is the published baseline, and your browser's local copy wins over it
until you explicitly reload. So visitors see the published file; you see your working copy, with the
status line telling you when the two disagree on row count.

### Publishing changes

Two ways to write your edits back to the database, both ending in a commit to `main`:

- **Save to GitHub** (in the Publish panel) commits the table over `docs/data/transactions.csv` via
  the GitHub Contents API. It needs a **fine-grained token limited to this repo** with
  *Contents: Read and write*. The token lives in this browser's `localStorage` only — never committed,
  never sent anywhere but `api.github.com` — so visitors to the public page can read the ledger but
  can't change it. **Forget token** clears it. Don't do this on a shared machine.
- **`./publish-ledger.sh`** takes a CSV exported from the tab (defaults to the newest
  `cards-transactions*.csv` in `~/Downloads`), refuses anything that isn't a ledger export, shows the
  row delta, then commits and pushes.

Export CSV round-trips byte-identically with the committed file, so publishing an unchanged table is a
no-op diff.

**Editing.** The table behaves like a spreadsheet. Click a cell to select it, drag or `⇧`+click for a
range, arrow keys to move, `⇧`+arrows to extend. Start typing to overwrite a cell, or `↩` / double-click
to edit it — `↩` commits and moves down, `⇥` moves right, `esc` reverts. `⌫` clears the selected range,
`⌘A` selects the whole grid, and the toolbar shows the selection's shape plus the total of any money
columns in it. `⧉` duplicates a row, `✕` deletes one. Click a column header to sort (blanks sink).

**Copy and paste.** `⌘C` / `⌘X` / `⌘V` work on ranges. Copying produces tab-separated text, so a range
drops straight into Numbers, and Numbers cells paste straight back in — a paste spills right and down
from the selected cell and appends rows when it needs them. Grid paste is deliberately tab-only:
guessing at commas would split a value like `Kobbie Mainoo, RC` in two. A full 16-column sheet row
pasted at the *Sport* column is read in the sheet's own order (which has no Payment Received column),
and says so in the status line; anything else lands exactly where you point it. **Copy all** puts every
row on the clipboard in one go. Profit and ROI are never written by a paste.

Local edits save to `localStorage` under `gy-cards-transactions-v1`, and a pending save is flushed when
the tab is hidden or closed.

**Importing.** For CSV *files* and comma-separated text, use the import panel: a file or a paste box, in
three modes — full database, purchases only, or sales only. Headers are matched by name when they're
recognizable (`Purchase Price`, `Sold For`, `Final value fee`, …); with no usable header the columns are
read positionally in the sheet's own order, and the leading grouped-header rows a Numbers export
produces are skipped automatically. The panel detects whether the text is tab- or comma-separated.
Profit and ROI are ignored on import since both are recalculated.

**Getting it off eBay.** eBay has no one-click purchase-history export, so today:

- *Sells* — Seller Hub → Orders → **Download report** produces a CSV whose columns
  (`Sold for`, `Sale date`, `Shipping and handling`, `Final value fee`) are already recognized.
  Import it as **Sales only**.
- *Buys* — select your Purchase History rows and paste them into the import box as **Purchases only**.
  In these two modes only, a year at the *start* of the item title is pulled into the Year column.

To automate it later, the [eBay Sell Fulfillment API](https://developer.ebay.com/api-docs/sell/fulfillment/overview.html)
(`getOrders`) covers sells and [Buy Order](https://developer.ebay.com/api-docs/buy/order/overview.html) covers buys.
Both need an OAuth app and a user token, i.e. a small server-side script that writes
`docs/data/transactions.csv` — the same file the tab already reads and the same one `publish-ledger.sh`
commits. That's the clean insertion point.

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
