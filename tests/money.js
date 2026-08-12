const fs = require("fs"), path = require("path");
const { JSDOM } = require("jsdom");
const DOCS = path.join(__dirname, "..", "docs");
const html = fs.readFileSync(path.join(DOCS, "index.html"), "utf8");
let fails = 0;
const check = (l, c, e = "") => { if (c) console.log("ok   " + l); else { fails++; console.log(`FAIL ${l} ${e}`); } };
const wait = ms => new Promise(r => setTimeout(r, ms));
const dom = new JSDOM(html, {
  runScripts: "dangerously", url: "https://geraldno20.github.io/cards/",
  beforeParse(w) {
    w.fetch = u => {
        {
          const isApi = String(u).startsWith("https://api.github.com/");
          const m = String(u).match(/data\/(transactions|chase|staging)\.csv$/);
          if (m && !isApi) {
            const fx = path.join(__dirname, "fixtures", m[1] + ".csv");
            const t = fs.readFileSync(fx, "utf8");
            return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(t) });
          }
        }
      const p = path.join(DOCS, String(u).replace(/^\.?\//, ""));
      if (!fs.existsSync(p)) return Promise.resolve({ ok: false, status: 404, statusText: "nf" });
      const t = fs.readFileSync(p, "utf8");
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(t), json: () => Promise.resolve(JSON.parse(t)) });
    };
    w.confirm = () => true;
    w.Element.prototype.scrollIntoView = function () {};
  },
});
const { window } = dom, d = window.document;
for (const f of ["app.js", "transactions.js", "chase.js", "staging.js"]) window.eval(fs.readFileSync(path.join(DOCS, f), "utf8"));
window.eval(html.slice(html.lastIndexOf("<script>") + 8, html.lastIndexOf("</script>")));
const $ = id => d.getElementById(id);
const trs = () => [...d.querySelectorAll("#txBody tr")];
const cell = (tr, k) => tr.querySelector(`td[data-key="${k}"]`);
const open = td => {
  td.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true }));
  td.dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true }));
};
const key = (k, shift = false) => $("txWrap").dispatchEvent(new window.KeyboardEvent("keydown", { key: k, shiftKey: shift, bubbles: true }));

(async () => {
  await wait(600);
  d.querySelector('.tab[data-tab="transactions"]').click();
  const snap = window.cardsLedger.snapshot();

  // ── stored "$100.00" and stored "4.25" both display the same way ──
  const withDollar = trs().find(tr => cell(tr, "athlete").textContent === "Aaron Donald");
  check("already-$ value formatted", cell(withDollar, "purchasePrice").textContent === "$100.00", cell(withDollar, "purchasePrice").textContent);
  const bareIdx = snap.findIndex(r => r.purchasePrice && !r.purchasePrice.includes("$"));
  check("a bare stored number gets a $ too", trs()[bareIdx] && /^\$[\d,]+\.\d\d$/.test(cell(trs()[bareIdx], "purchasePrice").textContent),
        `${snap[bareIdx].purchasePrice} -> ${cell(trs()[bareIdx], "purchasePrice").textContent}`);

  // ── thousands separator on the big one ──
  const bigIdx = snap.reduce((best, r, i) => (Number(String(r.purchasePrice).replace(/[$,]/g, "")) > Number(String(snap[best].purchasePrice).replace(/[$,]/g, "")) ? i : best), 0);
  check("thousands separated", cell(trs()[bigIdx], "purchasePrice").textContent === "$13,000.00", cell(trs()[bigIdx], "purchasePrice").textContent);

  // ── sold price too ──
  const soldIdx = snap.findIndex(r => r.soldPrice);
  check("sold price formatted", /^\$[\d,]+\.\d\d$/.test(cell(trs()[soldIdx], "soldPrice").textContent),
        `${snap[soldIdx].soldPrice} -> ${cell(trs()[soldIdx], "soldPrice").textContent}`);
  check("blank sold price stays blank", cell(withDollar, "soldPrice").textContent === "", `"${cell(withDollar, "soldPrice").textContent}"`);

  // ── the other money columns are deliberately left as stored ──
  const gradingIdx = snap.findIndex(r => r.grading);
  check("a filled Grading cell exists to check", gradingIdx >= 0, String(gradingIdx));
  check("Grading shown exactly as stored", cell(trs()[gradingIdx], "grading").textContent === snap[gradingIdx].grading,
        `${cell(trs()[gradingIdx], "grading").textContent} vs ${snap[gradingIdx].grading}`);
  check("non-money column untouched", cell(withDollar, "athlete").textContent === "Aaron Donald");

  // ── editing shows the plain figure, not the formatting ──
  // Uses a row stored without a $, so raw and displayed genuinely differ.
  const bareRow = trs()[bareIdx];
  const bareStored = snap[bareIdx].purchasePrice;
  const bareCell = cell(bareRow, "purchasePrice");
  check("displayed differs from stored on this row", bareCell.textContent !== bareStored, `${bareStored} -> ${bareCell.textContent}`);
  open(bareCell);
  check("edit strips the formatting back to the figure", bareCell.textContent === bareStored, `${bareCell.textContent} vs stored ${bareStored}`);
  key("Escape");
  await wait(150);
  const bareFormatted = "$" + Number(bareStored).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  check("escaping restores the formatted text", cell(trs()[bareIdx], "purchasePrice").textContent === bareFormatted,
        `${cell(trs()[bareIdx], "purchasePrice").textContent} vs ${bareFormatted}`);

  // ── commit reformats, model keeps what you typed ──
  const costBefore = $("txTotals").textContent;
  const priceCell = cell(trs()[0], "purchasePrice");
  open(priceCell);
  priceCell.textContent = "1234.5";
  priceCell.dispatchEvent(new window.Event("input", { bubbles: true }));
  key("Enter");
  await wait(250);
  check("reformatted on commit", cell(trs()[0], "purchasePrice").textContent === "$1,234.50", cell(trs()[0], "purchasePrice").textContent);
  check("model stored what was typed", window.cardsLedger.snapshot()[0].purchasePrice === "1234.5", window.cardsLedger.snapshot()[0].purchasePrice);
  check("Total Cost tile moved with the edit", $("txTotals").textContent !== costBefore);

  // ── escape restores the formatted display ──
  const p2 = cell(trs()[1], "purchasePrice");
  const stored2 = window.cardsLedger.snapshot()[1].purchasePrice;
  const shown2 = p2.textContent;
  open(p2);
  p2.textContent = "999";
  p2.dispatchEvent(new window.Event("input", { bubbles: true }));
  key("Escape");
  await wait(200);
  check("escape put the value back", window.cardsLedger.snapshot()[1].purchasePrice === stored2, window.cardsLedger.snapshot()[1].purchasePrice);
  check("escape put the formatting back", cell(trs()[1], "purchasePrice").textContent === shown2, cell(trs()[1], "purchasePrice").textContent);

  // ── selection total still adds up off the formatted text ──
  const target = cell(trs()[bigIdx], "purchasePrice");
  target.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true }));
  check("selection total parses $ and commas", /\$13,000\.00/.test($("txSelInfo").textContent), $("txSelInfo").textContent);

  // ── clearing empties the cell ──
  key("Backspace");
  await wait(200);
  check("cleared cell is empty", cell(trs()[bigIdx], "purchasePrice").textContent === "", `"${cell(trs()[bigIdx], "purchasePrice").textContent}"`);

  console.log(fails ? `\n${fails} FAILURE(S)` : "\nall money-format checks passed");
  process.exit(fails ? 1 : 0);
})();
