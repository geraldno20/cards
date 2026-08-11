# Sports Cards Recommender

A small hybrid recommender for sports cards. Pick cards you like, get a ranked list of others you might enjoy, with explanations for *why* each one was suggested.

**Live demo:** https://geraldno20.github.io/cards/ — the recommender, plus a
[Transactions](https://geraldno20.github.io/cards/#transactions) tab and a
[Chase](https://geraldno20.github.io/cards/#chase) checklist and a
[Staging](https://geraldno20.github.io/cards/#staging) queue, all backed by CSV databases in this repo.

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
  chase.js              # Chase tab: set checklists, progress, CSV + GitHub sync
  staging.js            # Staging tab: batches, cent-exact splits, sale matching, submit
  styles.css
  data/                 # Precomputed JSON, plus transactions.csv, chase.csv and staging.csv
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
GitHub Pages. 410 rows today, of which the first 373 were extracted from the ledger pages of
`GY_CY Cards Database.pdf` using the PDF's own cell borders as the grid. The extraction was validated against the sheet's own summary block:

| | Extracted | Sheet's stored total |
| --- | --- | --- |
| Total Sale | $435.14 | $435.14 ✓ |
| Total Profit | $215.83 | $215.83 ✓ |
| Total Cost | $12,571.08 | $12,329.46 ✗ |

All 25 of the sheet's Profit cells agree with the formula exactly. **The Total Cost line in the sheet
is $241.62 low** — the purchase prices in its own rows add to $12,531.08, plus $40 of grading fees.
That looks like a `SUM` range that stopped growing when rows were added below it; the app recomputes
totals from the rows, so it doesn't inherit the error.

**Cleanup, and one inference that had to be thrown away.** An early pass normalized the ledger: `Pokémon`
folded into `Pokemon` (the majority spelling, and what value-snapping now settles on), `Keith van Horn` into
`Keith Van Horn` (correct, and the spelling the chase list matches on), and 81 blank Sport cells filled —
Tiger Woods to Golf, Ronda Rousey to WWE, and so on. 88 cells in all, no rows added or removed.

Sport was filled **only** where this ledger's own rows for that athlete agree unanimously. Filling it from the
manufacturer was tried and rejected: every `Topps Chrome` row that *has* a sport says Football, but the blank
ones include Pau Gasol, Dikembe Mutombo and Roy Keane — brand unanimity would have mislabelled at least five
rows. 115 Sport cells are still blank because nothing in the file justifies a value.

Deliberately left alone: the purchase sources. `SJ Card Show`, `Card show`, `San Mateo` and
`Santa Clara card show` are not spelling variants of one another — San Mateo and Santa Clara are different
places, and collapsing them would invent information. Same for Description casing (`Rookie green` /
`Rookie Green`), which is your own note-taking, and for the mixed money and date formats, which every reader
in the app already parses.

Note this repo is **public**, so the ledger — purchase prices, sale prices, profit, ROI — is public
too, and git history keeps every past version. Pages 10–30 of the PDF (Pokemon comps, grading
submissions, breaks, box purchases, supplies) are separate sheets and are not in this file.

Load order: the committed CSV is the published baseline, and your browser's local copy wins over it
until you explicitly reload. So visitors see the published file; you see your working copy, with the
status line telling you when the two disagree on row count.

### Publishing changes

Two ways to write your edits back to the database, both ending in a commit to `main`:

- **Save to GitHub** (in the Sync panel) commits the table over `docs/data/transactions.csv` via
  the GitHub Contents API. It needs a **fine-grained token limited to this repo** with
  *Contents: Read and write*. The token lives in this browser's `localStorage` only — never committed,
  never sent anywhere but `api.github.com` — so visitors to the public page can read the ledger but
  can't change it. **Forget token** clears it, on both tabs, since they share one credential. Don't do
  this on a shared machine.

  The panel asks for the token and nothing else. Owner and repo are read off the Pages URL (with a
  fallback so `localhost` still works), the branch is `main`, and the file path is derived from the path
  the page already reads. That last one used to be an editable field, which meant you could publish to a
  file the page never reads back — indistinguishable from a save that silently did nothing. A line under
  the token says exactly where it will write.
- **`./publish-ledger.sh`** takes a CSV exported from the tab (defaults to the newest
  `cards-transactions*.csv` in `~/Downloads`), refuses anything that isn't a ledger export, shows the
  row delta, then commits and pushes.

Export CSV round-trips byte-identically with the committed file, so publishing an unchanged table is a
no-op diff.

### Entering a purchase once, not twice

A card used to be typed into both tabs: eleven-ish fields here and four in Chase. Now:

- **`$` on a chase row** opens a small dialog, ticks Got, writes the grade/cost/date into the chase row, *and*
  adds the ledger row. The Year / Manufacturer / Description split comes from the set name matched against the
  manufacturers already in this ledger — `1998-99 Topps Roundball Royalty Refractor` lands on the
  `Topps Roundball Royalty` that's already in there, leaving `Refractor` — and Sport comes from how that
  manufacturer is normally filed. The split is remembered per set, so from the second purchase onward you type
  the price and nothing else. No brand list is bundled; the vocabulary is your own data, and it improves as
  you buy.
- **Match ledger** (Chase toolbar) runs the other way for cards bought before the tab existed: it ticks chase
  rows the ledger already has and copies their grade, cost and date over. Matching is on player plus the set
  name containing the ledger's manufacturer and description, with years required to agree when both name one.
  The description check matters — a `Stadium Club … Luminous` Keith Van Horn is a different parallel from the
  `Illuminator` on the chase list, and is correctly left alone.
- **Suggestion lists** on Sport, Year, Manufacturer, Athlete, From and Grade cells offer what you already use,
  ranked by frequency with counts. Opening a cell lists everything; typing filters accent- and
  case-insensitively. Nothing is preselected, so <kbd>↩</kbd> still commits exactly what you typed — you have
  to arrow into the list on purpose.
- **Committing a near-duplicate snaps it** onto the established spelling when the only difference is case,
  accents or spacing, so a fourteenth spelling of a purchase source can't creep in. Genuinely new values are
  left alone.
- **New rows** arrive with the date set to today and From set to your most recent source. Sport is left blank
  on purpose: guessing it mislabels cards (see below).
- **One item title** in the Import panel is pulled apart into columns — grade, `#number`, season, player,
  brand, and the rest as description — then shows you what it found before writing anything, and parks the
  cursor on Price. A print run like `/2012` is not mistaken for a year.

The endgame is still the eBay API pulling buys in automatically; that needs a server and OAuth, and the
insertion point is unchanged (see below).

**Money columns.** Purchase Price and Sold Price display as money — `$13,000.00` — while the file keeps
whatever was typed, so formatting them changed no data and the published CSV still round-trips
byte-identically. Opening a cell swaps the plain figure back in, so you edit `13000` and not `$13,000.00`;
committing re-formats it. Sorting and the totals read the number, not the text. Payment Received, Shipping,
Grading and Fees are shown as stored.

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

## Chase tab

A checklist of the cards still being hunted, one row per card in a set:

| Column | Notes |
| --- | --- |
| Got | Checkbox — tick it when the card lands |
| Set, Player, Card Number | The checklist itself |
| Grade, Cost, Date | Filled in once you have it |

The tiles count what's on the list, what's in hand, and what it cost (spend and average are over the
*acquired* rows only), and there's a progress bar per set that turns green when a set is complete.
Filters narrow by set, by got/still-chasing, or by free text; the tiles follow the filter.

**Adding a set.** The *Add a set* panel takes a set name plus one card per line, card number then
player. Tabs, commas, or two-or-more spaces all separate the two, and they're swapped automatically if
the paste arrives player-first — so a checklist copied straight off a set list goes in as-is:

```
R1	Michael Jordan
R2	Kevin Garnett
R3	David Robinson
```

**Editing.** Click any cell and type. `↩` and `↓` move down, `⇥` / `⇧⇥` move right and left and wrap
across rows, `esc` reverts the cell. Pasting a block of cells spills right and down from the cell you
paste into and appends rows when it needs them. Column headers sort — card numbers sort naturally, so
`R2` comes before `R10` — and a third click puts the checklist back in its printed order. `⧉`
duplicates a row, `✕` deletes one.

**The database, and why it syncs differently from the ledger.** `docs/data/chase.csv` is the database.
The ledger's rule is *your browser's copy wins until you publish*, which is right there — you're the only
one editing 410 rows. Chase is the opposite: sets arrive by commit while ticks and costs are typed in the
browser, so neither copy is simply the newer one. So Chase does two things instead:

- **On load it merges.** The committed file is the checklist of record, and whatever you'd ticked, graded,
  or priced is re-applied on top of it. A newly committed set just appears; your progress can't be lost to
  it. Rows only your browser knows about are kept and flagged. Matching is by *set + card number* — not the
  player name, since keying on that would turn an upstream spelling fix into a duplicate row.
- **Edits publish themselves.** With a token set, a change commits about two seconds later (a burst of ticks
  coalesces into one commit), and the toolbar reads **⟳ saving** → **✓ saved to GitHub**. There's no publish
  step to remember. Without a token everything still works locally and the toolbar says
  **● in this browser only — add a GitHub token to sync**.

Same token as the Transactions tab; set it in either panel and both use it. The buttons in the
Sync panel are escape hatches: force a commit now, or throw this browser's copy away and re-read the
committed file. `localStorage` (`gy-cards-chase-v1`) is the offline cache, not a second database. Export CSV
round-trips byte-identically with the committed file. Seeded with two sets — 1998-99 Topps Roundball
Royalty Refractor (R1–R20) and 1998-99 Topps Stadium Club Triumvirate Illuminator (T1a–T16C, 48 cards in
16 trios).

## Staging tab

Where cards wait until they're clean enough for the ledger. Called Staging, not "holding area", because
Holdings already means something here: unsold cards.

A **batch** is whatever arrived together for one amount — a show pickup, an eBay lot, eventually one photo
with six cards in it. You give it a total and a count; the amount is split to **exact cents**, so three cards
out of $100 come to $33.34 / $33.33 / $33.33 rather than losing a penny. An even split is nearly always
*wrong* for value, though — a lot with a Jordan and four commons wasn't priced evenly — so the Amount cells
are editable and the batch header says when they stop adding up to what you paid. **Re-split evenly** puts
them back.

**Sells land on the card you already own.** This is the part that would quietly corrupt the numbers if it
were done the obvious way. The ledger keeps one row per card with Purchase and Sold side by side, and
`Profit = Sold − Purchase − expenses`; a sale that created its own row would leave the purchase sitting in
Holdings *and* show an ROI against a cost of nothing — double-counted in both directions. So a staged sale
resolves to an existing holding (same evidence Match ledger uses: player, then anything else both sides
name), shows which one in the **Goes to** column, and fills in that row's Sold columns on submit. `⇄` picks
when several holdings could be it. If nothing matches, `⇄` can add a sold-only row instead, which records
the money but can't show a profit — and until you make that call, the batch can't be submitted.

Ledger row ids are handed out at load time, so a chosen holding is remembered by card identity and re-resolved
on every render rather than stored as an id.

Nothing reaches the ledger until **Submit**, and a batch with anything missing can't be submitted — the row
tooltip and the batch header both say what's needed. Staging publishes itself to `docs/data/staging.csv` with
the same machinery as the chase list, so a haul entered on a phone is waiting on the laptop. Submitting writes
to the ledger, which still publishes by hand.

### Photos, and the recognizer seam

**📷 Scan cards** opens the camera on a phone or the file picker on a laptop, takes several shots at once, and
turns them into staged rows. Say how many cards the photos hold — more cards than photos and they share a
picture, so one shot of a row of six cards works — and each row keeps a thumbnail you tap to see while you
type. Each photo is downscaled to a ~220px JPEG through a canvas, honouring EXIF orientation so a card held
sideways isn't stored sideways.

Thumbnails live in **IndexedDB**, not `localStorage`: a phone photo is 2–4MB and `localStorage` holds about
5MB for everything here. They are also **never published** — the repo is public, and `staging.csv` carries
only an id. So a haul scanned on a phone reaches the laptop as rows *without* pictures; do the
looking-at-cards part on the device that shot them. Thumbnails are released when a row is submitted, deleted,
or when the batch dialog is cancelled, and a photo shared by several rows survives until the last of them
goes.

**Recognition plugs in here and nowhere else:**

```js
window.cardRecognizer = async (file) => ([
  { sport, year, manufacturer, athlete, number, description, grade, confidence }
])
```

One entry per card found in that image, best first; every field optional. Staging calls it per photo and
prefills rows that are still empty. It is deliberately an accelerator, not a gate — rows exist and are usable
before it runs, a failure or a 20-second timeout leaves them blank and says so, and anything that returns
something other than an array is ignored. That's what makes ~80% accuracy safe: nothing reaches the ledger
unreviewed.

Nothing is registered yet, so scanning today gives you rows with pictures attached — which is the same
workflow minus the guessing, and already faster than typing from the cards in hand.

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
