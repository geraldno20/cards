const fs = require("fs"), path = require("path");
const { JSDOM } = require("jsdom");
const DOCS = path.join(__dirname, "..", "docs");
const html = fs.readFileSync(path.join(DOCS, "index.html"), "utf8");
let fails = 0;
const check = (l, c, e = "") => { if (c) console.log("ok   " + l); else { fails++; console.log(`FAIL ${l} ${e}`); } };
const wait = ms => new Promise(r => setTimeout(r, ms));

function boot({ prompt = () => "1", confirm = () => true } = {}) {
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
      w.confirm = confirm;
      w.prompt = prompt;
      w.Element.prototype.scrollIntoView = function () {};
      if (!w.HTMLDialogElement.prototype.showModal) {
        w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
        w.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new w.Event("close")); };
      }
    },
  });
  const { window } = dom, d = window.document;
  for (const f of ["app.js", "transactions.js", "chase.js", "staging.js"]) window.eval(fs.readFileSync(path.join(DOCS, f), "utf8"));
  window.eval(html.slice(html.lastIndexOf("<script>") + 8, html.lastIndexOf("</script>")));
  return { window, d, $: id => d.getElementById(id) };
}

const dataRows = d => [...d.querySelectorAll("#stageBody tr[data-id]")];
const cell = (tr, k) => tr.querySelector(`td[data-key="${k}"]`);
const setCell = (window, tr, k, v) => {
  const td = cell(tr, k);
  td.textContent = v;
  td.dispatchEvent(new window.Event("input", { bubbles: true }));
  td.dispatchEvent(new window.FocusEvent("blur", { bubbles: false }));
};
const addBatch = (window, d, $, { total, count, kind = "buy", party = "eBay" }) => {
  $("stageAdd").click();
  $("batchTotal").value = String(total);
  $("batchCount").value = String(count);
  $("batchKind").value = kind;
  $("batchParty").value = party;
  $("batchForm").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
};

(async () => {
  // ── tab exists and is wide ──
  {
    const { d, $ } = boot();
    await wait(600);
    const tab = d.querySelector('.tab[data-tab="staging"]');
    check("Staging tab present", !!tab);
    tab.click();
    check("section shown", $("tab-staging").hidden === false);
    check("gets the wide layout", d.body.classList.contains("wide"));
    check("empty message", /Nothing staged/.test($("stageBody").textContent), $("stageBody").textContent.trim().slice(0, 40));
    check("other tabs still fine", $("tab-transactions").hidden === true && $("tab-chase").hidden === true);
  }

  // ── the split is cent-exact ──
  {
    const { window, d, $ } = boot();
    await wait(600);
    d.querySelector('.tab[data-tab="staging"]').click();
    addBatch(window, d, $, { total: "100", count: 3 });
    await wait(150);
    const amounts = dataRows(d).map(tr => cell(tr, "amount").textContent);
    check("three rows", dataRows(d).length === 3, String(dataRows(d).length));
    check("100 across 3 keeps every cent", amounts.join("|") === "$33.34|$33.33|$33.33", amounts.join("|"));
    const sum = amounts.reduce((a, v) => a + Number(v.replace(/[$,]/g, "")), 0);
    check("adds back to exactly 100", Math.abs(sum - 100) < 1e-9, String(sum));
    check("batch header says balanced", /✓/.test($("stageBody").querySelector(".stage-groupcell").textContent));
    check("header states the total", /stated \$100\.00/.test($("stageBody").querySelector(".stage-groupcell").textContent),
          $("stageBody").querySelector(".stage-groupcell").textContent.replace(/\s+/g, " ").trim().slice(0, 90));
    check("status explains the split", /33\.34/.test($("stageStatus").textContent), $("stageStatus").textContent);

    // ── re-weighting is allowed, and a broken total is called out ──
    setCell(window, dataRows(d)[0], "amount", "50");
    await wait(150);
    check("off-total flagged", /✗ off by/.test($("stageBody").querySelector(".stage-groupcell").textContent),
          $("stageBody").querySelector(".stage-groupcell").textContent.replace(/\s+/g, " ").trim().slice(0, 120));
    $("stageBody").querySelector(".stage-respread").click();
    await wait(150);
    check("re-split evenly restores it", dataRows(d).map(tr => cell(tr, "amount").textContent).join("|") === "$33.34|$33.33|$33.33",
          dataRows(d).map(tr => cell(tr, "amount").textContent).join("|"));

    // ── odd totals ──
    addBatch(window, d, $, { total: "10", count: 3 });
    await wait(150);
    const b2 = dataRows(d).filter(tr => cell(tr, "batch") === null || true).slice(3).map(tr => cell(tr, "amount").textContent);
    check("10 across 3 = 3.34/3.33/3.33", b2.join("|") === "$3.34|$3.33|$3.33", b2.join("|"));
  }

  // ── a buy submits as a new ledger row ──
  {
    const { window, d, $ } = boot();
    await wait(600);
    d.querySelector('.tab[data-tab="staging"]').click();
    const before = window.cardsLedger.snapshot().length;
    addBatch(window, d, $, { total: "60", count: 2, party: "SJ Card Show" });
    await wait(150);
    let trs = dataRows(d);
    check("batch cannot submit while incomplete", $("stageBody").querySelector(".stage-submit-one").disabled === true);
    setCell(window, trs[0], "athlete", "Michael Jordan");
    setCell(window, trs[1], "athlete", "Scottie Pippen");
    setCell(window, trs[0], "manufacturer", "Topps Roundball Royalty");
    await wait(200);
    check("batch now ready", $("stageBody").querySelector(".stage-submit-one").disabled === false);
    check("header says ready", /ready/.test($("stageBody").querySelector(".stage-groupcell").textContent));
    $("stageBody").querySelector(".stage-submit-one").click();
    await wait(250);
    check("ledger gained two rows", window.cardsLedger.snapshot().length === before + 2, `${before} -> ${window.cardsLedger.snapshot().length}`);
    check("staging emptied", dataRows(d).length === 0, String(dataRows(d).length));
    const added = window.cardsLedger.snapshot().slice(-2);
    check("purchase price carried", added.map(r => r.purchasePrice).join("|") === "30.00|30.00", added.map(r => r.purchasePrice).join("|"));
    check("source carried", added[0].purchaseFrom === "SJ Card Show", added[0].purchaseFrom);
    check("date is the ledger's m/d/yyyy", /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(added[0].purchaseDate), added[0].purchaseDate);
    check("submit warns the ledger publishes by hand", /Save to GitHub/.test($("stageStatus").textContent), $("stageStatus").textContent);
  }

  // ── a sell lands on the holding, and does NOT create a row ──
  {
    const { window, d, $ } = boot();
    await wait(600);
    // pick a real holding to sell
    const holding = window.cardsLedger.holdings().find(r => r.athlete === "Dennis Rodman") || window.cardsLedger.holdings()[0];
    d.querySelector('.tab[data-tab="staging"]').click();
    const before = window.cardsLedger.snapshot().length;
    const holdingsBefore = window.cardsLedger.holdings().length;
    addBatch(window, d, $, { total: "500", count: 1, kind: "sell", party: "eBay" });
    await wait(150);
    let tr = dataRows(d)[0];
    setCell(window, tr, "athlete", holding.athlete);
    setCell(window, tr, "manufacturer", holding.manufacturer);
    setCell(window, tr, "year", holding.year);
    await wait(200);
    tr = dataRows(d)[0];
    check("match column found the holding", tr.querySelector(".stage-match").classList.contains("ok"),
          tr.querySelector(".stage-match").textContent);
    $("stageBody").querySelector(".stage-submit-one").click();
    await wait(250);
    const after = window.cardsLedger.snapshot();
    check("NO new ledger row for a sale", after.length === before, `${before} -> ${after.length}`);
    const sold = after.find(r => r.id === holding.id);
    check("the holding is now sold", sold.soldPrice === "500.00", sold.soldPrice);
    check("sold date written", /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(sold.soldDate), sold.soldDate);
    check("holdings count dropped by one", window.cardsLedger.holdings().length === holdingsBefore - 1,
          `${holdingsBefore} -> ${window.cardsLedger.holdings().length}`);
    check("purchase price untouched", sold.purchasePrice === holding.purchasePrice, `${sold.purchasePrice} vs ${holding.purchasePrice}`);
    // profit shows up in the ledger tiles
    d.querySelector('.tab[data-tab="transactions"]').click();
    await wait(100);
    const cost = Number(String(holding.purchasePrice).replace(/[$,]/g, ""));
    check("profit is sold minus cost", /Total Profit/.test($("txTotals").textContent), "");
    const profitCell = [...d.querySelectorAll("#txBody tr")].map(t => t.querySelector('td[data-key="profit"]'))
      .find(td => td && td.textContent && td.textContent !== "");
    check("a profit cell is populated", !!profitCell, String(profitCell && profitCell.textContent));
  }

  // ── a sale with no match is blocked until you say what to do ──
  {
    const { window, d, $ } = boot({ confirm: () => false });
    await wait(600);
    d.querySelector('.tab[data-tab="staging"]').click();
    const before = window.cardsLedger.snapshot().length;
    addBatch(window, d, $, { total: "20", count: 1, kind: "sell" });
    await wait(150);
    setCell(window, dataRows(d)[0], "athlete", "Nobody I Have Ever Owned");
    await wait(200);
    check("unmatched sale flagged", dataRows(d)[0].querySelector(".stage-match").classList.contains("bad"),
          dataRows(d)[0].querySelector(".stage-match").textContent);
    check("batch blocked from submitting", $("stageBody").querySelector(".stage-submit-one").disabled === true);
    check("toolbar Submit is disabled with nothing ready", $("stageSubmit").disabled === true);
    $("stageSubmit").click();
    await wait(150);
    check("submit-all writes nothing", window.cardsLedger.snapshot().length === before, String(window.cardsLedger.snapshot().length));
    check("per-batch header names the problem", /thing[s]? to fix/.test($("stageBody").querySelector(".stage-groupcell").textContent),
          $("stageBody").querySelector(".stage-groupcell").textContent.replace(/\s+/g, " ").trim().slice(0, 100));
    check("row tooltip says what's missing", /no holding matched/.test(dataRows(d)[0].title), dataRows(d)[0].title);
    // declining the prompt leaves it alone
    dataRows(d)[0].querySelector(".stage-pick").click();
    await wait(100);
    check("declining leaves it unresolved", dataRows(d)[0].querySelector(".stage-match").classList.contains("bad"));
  }

  // ── ...or explicitly becomes a sold-only row ──
  {
    const { window, d, $ } = boot({ confirm: () => true });
    await wait(600);
    d.querySelector('.tab[data-tab="staging"]').click();
    const before = window.cardsLedger.snapshot().length;
    addBatch(window, d, $, { total: "20", count: 1, kind: "sell" });
    await wait(150);
    setCell(window, dataRows(d)[0], "athlete", "Nobody I Have Ever Owned");
    await wait(200);
    dataRows(d)[0].querySelector(".stage-pick").click();
    await wait(150);
    check("now marked sold-only", dataRows(d)[0].querySelector(".stage-match").classList.contains("warn"),
          dataRows(d)[0].querySelector(".stage-match").textContent);
    check("batch unblocked", $("stageBody").querySelector(".stage-submit-one").disabled === false);
    $("stageBody").querySelector(".stage-submit-one").click();
    await wait(250);
    check("a sold-only row was added", window.cardsLedger.snapshot().length === before + 1);
    const r = window.cardsLedger.snapshot().slice(-1)[0];
    check("it has sold money and no purchase", r.soldPrice === "20.00" && r.purchasePrice === "", `${r.soldPrice}/${r.purchasePrice}`);
  }

  // ── staging survives a reload and round-trips as CSV ──
  {
    const { window, d, $ } = boot();
    await wait(600);
    d.querySelector('.tab[data-tab="staging"]').click();
    addBatch(window, d, $, { total: "99.99", count: 2 });
    await wait(150);
    setCell(window, dataRows(d)[0], "athlete", "Kobe Bryant");
    await wait(300);
    const saved = JSON.parse(window.localStorage.getItem("gy-cards-staging-v1"));
    check("persisted", saved.length === 2, String(saved.length));
    check("persisted the split", saved.map(r => r.amount).join("|") === "50.00|49.99", saved.map(r => r.amount).join("|"));
    check("persisted the batch label", saved[0].batch === "B1", saved[0].batch);
    check("persisted the batch total", saved[0].batchTotal === "99.99", saved[0].batchTotal);
    check("persisted the player", saved[0].athlete === "Kobe Bryant");
  }

  console.log(fails ? `\n${fails} FAILURE(S)` : "\nall staging checks passed");
  process.exit(fails ? 1 : 0);
})();
