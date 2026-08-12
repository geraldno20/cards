# tests/

jsdom harnesses that drive `docs/` the way a browser does — clicking tabs, typing in
cells, firing paste and change events — and assert on what the DOM ends up saying.
Roughly 300 assertions across 16 suites.

    ./tests/run-all.sh          # everything
    ./tests/run-all.sh money    # suites matching "money"
    node tests/staging.js       # one suite, full output

Needs jsdom: `npm install` (the only dependency; nothing here ships to Pages).

## Fixtures, and why

`fixtures/` holds frozen copies of the three CSVs, taken at commit 2e083c4, and every
harness's fetch stub serves those instead of `docs/data/`. This is not fussiness: the
suites were originally reading the live files, and the moment the app published real
work — 410 ledger rows became 455, 0 chase ticks became 22 — five suites went red
without a line of app code changing. Tests coupled to live data rot on contact.

`stagedin.js` is the exception: it deliberately reads the real `docs/data/staging.csv`,
because what it checks is that the actual queued rows load correctly.

## Things worth knowing about jsdom here

- No layout: `getBoundingClientRect` is all zeros and nothing scrolls, so anything
  positional needs a real browser. A floating suggestion list that vanished on scroll
  passed every assertion and was only caught in a screenshot.
- No `scrollIntoView`; the harnesses stub it.
- Focus doesn't land on a `contenteditable` `<td>`, so keyboard-navigation suites assert
  on where the caret went rather than on `document.activeElement`.
- Each `docs/*.js` is loaded with a separate `window.eval`, so their top-level `const`s
  stay private per file — the same isolation they get from being separate `<script>`s,
  but function declarations still land on `window`.
