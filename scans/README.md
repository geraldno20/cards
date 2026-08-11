# scans/

Drop card photos here (HEIC or JPEG, straight off the phone) and ask me to identify
them. I read the card faces — player, set, parallel and the serial numbering — and
write the results into `docs/data/staging.csv` as rows with the money left blank,
because that's the part only you know.

Then in the app: **Staging** → set Buy/Sell, type the amount and date, and **Submit**.
A sale will find the holding it closes; a buy makes a new ledger row.

Photos in this folder are ignored by git — the repo is public and these are just
working files.

Why this rather than an image-recognition API: on a real phone photo of a card in a
toploader, CLIP scored two *completely different* cards at 0.706 similarity while an
unrelated card from another set scored 0.829 — the embedding is dominated by the
glare, the window and the toploader rather than the card. And the detail that decides
value on these is the parallel and the print run (`1/1`, `1/5`), which is small text
and hue. Reading the cards directly gets both right.
