const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const DOCS = path.join(__dirname, "..", "docs");
const html = fs.readFileSync(path.join(DOCS, "index.html"), "utf8");
const SEED = fs.readFileSync(path.join(DOCS, "data/chase.csv"), "utf8").trimEnd().split("\n").length - 1;
const SEED_SETS = 2;

// Serve the page's own fetches (data/*.csv, data/*.json) off disk.
const dom = new JSDOM(html, {
  runScripts: "dangerously",
  url: "https://geraldno20.github.io/cards/",
  resources: undefined,
  beforeParse(window) {
    window.fetch = (url) => {
        {
          const isApi = String(url).startsWith("https://api.github.com/");
          const m = String(url).match(/data\/(transactions|chase|staging)\.csv$/);
          if (m && !isApi) {
            const fx = path.join(__dirname, "fixtures", m[1] + ".csv");
            const t = fs.readFileSync(fx, "utf8");
            return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(t) });
          }
        }
      const p = path.join(DOCS, String(url).replace(/^\.?\//, ""));
      if (!fs.existsSync(p)) return Promise.resolve({ ok: false, status: 404, statusText: "Not Found" });
      const text = fs.readFileSync(p, "utf8");
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(text), json: () => Promise.resolve(JSON.parse(text)) });
    };
    window.confirm = () => true;
  },
});

// jsdom doesn't run <script src>, so load them in order by hand.
const { window } = dom;
for (const f of ["app.js", "transactions.js", "chase.js", "staging.js"]) {
  window.eval(fs.readFileSync(path.join(DOCS, f), "utf8"));
}
// Re-run the inline bootstrap (tab wiring + init calls).
const inline = html.slice(html.lastIndexOf("<script>") + 8, html.lastIndexOf("</script>"));
window.eval(inline);

const errs = [];
window.addEventListener("error", e => errs.push(e.message));

setTimeout(() => {
  const d = window.document;
  const $ = id => d.getElementById(id);
  let fails = 0;
  const check = (label, cond, extra = "") => {
    if (cond) console.log(`ok   ${label}`);
    else { fails++; console.log(`FAIL ${label} ${extra}`); }
  };

  // ── tab exists and switches ──
  const tab = d.querySelector('.tab[data-tab="chase"]');
  check("Chase tab button rendered", !!tab);
  tab.click();
  check("Chase section shown", $("tab-chase").hidden === false);
  check("Transactions section hidden", $("tab-transactions").hidden === true);
  check("Recommender section hidden", $("tab-recommender").hidden === true);
  check("body not wide on Chase", !d.body.classList.contains("wide"));
  check("hash set", window.location.hash === "#chase");

  // ── table built from the published CSV ──
  const heads = [...d.querySelectorAll("#chaseHeadRow th")].map(th => th.textContent);
  check("headers", JSON.stringify(heads) === JSON.stringify(["Got","Set","Player","Card Number","Grade","Cost","Date",""]), heads.join("|"));
  const trs = [...d.querySelectorAll("#chaseBody tr")];
  check("every seeded row loaded", trs.length === SEED, `got ${trs.length}`);
  const cells = [...trs[0].children].map(td => td.textContent.trim());
  check("row 1 = Jordan R1", cells[2] === "Michael Jordan" && cells[3] === "R1", cells.join("|"));
  check("row 18 = Kobe R18", [...trs[17].children][2].textContent === "Kobe Bryant");
  check("cells editable", trs[0].children[1].getAttribute("contenteditable") === "plaintext-only");

  // ── tiles + per-set progress ──
  const tiles = $("chaseTotals").textContent;
  check("tiles count the seeded rows", tiles.replace(/\s/g, "").includes("Onthelist" + SEED), tiles);
  check("tiles show 0 got", /Got0/.test(tiles.replace(/\s/g, "")));
  check("set progress bar", /0 \/ 20/.test($("chaseSets").textContent), $("chaseSets").textContent.trim());
  check("set filter lists every set", [...$("chaseSetFilter").options].length === SEED_SETS + 1, [...$("chaseSetFilter").options].map(o=>o.value).join("|"));
  check("published state clean", $("chasePubState").className.includes("ok"), $("chasePubState").textContent);

  // ── tick a checkbox ──
  const box = trs[8].querySelector('input[type=checkbox]');
  box.checked = true;
  box.dispatchEvent(new window.Event("change", { bubbles: true }));
  check("row marked done", trs[8].classList.contains("chase-done"));
  check("tiles now show 1 got", /Got1/.test($("chaseTotals").textContent.replace(/\s/g, "")), $("chaseTotals").textContent);
  check("progress now 1 / 20", /1 \/ 20/.test($("chaseSets").textContent));

  // ── edit a cell ──
  const gradeCell = trs[8].querySelector('td[data-key="grade"]');
  gradeCell.textContent = "PSA 9";
  gradeCell.dispatchEvent(new window.Event("input", { bubbles: true }));
  const costCell = trs[8].querySelector('td[data-key="cost"]');
  costCell.textContent = "425";
  costCell.dispatchEvent(new window.Event("input", { bubbles: true }));
  check("spent tile picks up cost", /\$425\.00/.test($("chaseTotals").textContent), $("chaseTotals").textContent);

  // ── filters ──
  $("chaseFilter").value = "got";
  $("chaseFilter").dispatchEvent(new window.Event("change", { bubbles: true }));
  check("got filter -> 1 row", d.querySelectorAll("#chaseBody tr").length === 1);
  $("chaseFilter").value = "chasing";
  $("chaseFilter").dispatchEvent(new window.Event("change", { bubbles: true }));
  check("chasing filter drops the ticked row", d.querySelectorAll("#chaseBody tr").length === SEED - 1, String(d.querySelectorAll("#chaseBody tr").length));
  $("chaseFilter").value = "all";
  $("chaseFilter").dispatchEvent(new window.Event("change", { bubbles: true }));
  $("chaseSearch").value = "kobe";
  $("chaseSearch").dispatchEvent(new window.Event("input", { bubbles: true }));
  check("search finds every Kobe", d.querySelectorAll("#chaseBody tr").length === 3, String(d.querySelectorAll("#chaseBody tr").length));
  $("chaseSearch").value = "";
  $("chaseSearch").dispatchEvent(new window.Event("input", { bubbles: true }));

  // ── sorting: card number is natural, third click restores checklist order ──
  const numTh = d.querySelector('#chaseHeadRow th[data-key="number"]');
  numTh.click();
  let order = [...d.querySelectorAll("#chaseBody tr")].map(tr => tr.children[3].textContent);
  check("natural sort R1,R2,R3", order.slice(0, 3).join(",") === "R1,R2,R3", order.slice(0,5).join(","));
  numTh.click();
  order = [...d.querySelectorAll("#chaseBody tr")].map(tr => tr.children[3].textContent);
  check("reverse sort puts the highest number first", order[0] === "T16C", order.slice(0,3).join(","));
  numTh.click();
  order = [...d.querySelectorAll("#chaseBody tr")].map(tr => tr.children[3].textContent);
  check("third click restores checklist order", order[0] === "R1" && order[9] === "R10" && order[20] === "T1a", order.slice(0,3).join(","));

  // ── add a second set from a pasted checklist ──
  $("chaseNewSet").value = "2003-04 Topps Chrome Refractor";
  $("chaseNewRows").value = "111\tLeBron James\n112\tCarmelo Anthony";
  $("chaseSetGo").click();
  check("extra set added", d.querySelectorAll("#chaseBody tr").length === SEED + 2, String(d.querySelectorAll("#chaseBody tr").length));
  check("new set in the filter", [...$("chaseSetFilter").options].length === SEED_SETS + 2);
  check("a progress bar per set", $("chaseSets").querySelectorAll(".chase-prog").length === SEED_SETS + 1);

  // ── add row inherits the filtered set ──
  $("chaseSetFilter").value = "2003-04 Topps Chrome Refractor";
  $("chaseSetFilter").dispatchEvent(new window.Event("change", { bubbles: true }));
  check("set filter narrows to that set", d.querySelectorAll("#chaseBody tr").length === 2);
  $("chaseAdd").click();
  const newRows = [...d.querySelectorAll("#chaseBody tr")];
  check("add row inherits set", newRows.length === 3 && newRows[2].children[1].textContent === "2003-04 Topps Chrome Refractor", newRows.length + "|" + newRows[2]?.children[1]?.textContent);

  // ── delete it again ──
  newRows[2].querySelector(".tx-del").click();
  check("delete row", d.querySelectorAll("#chaseBody tr").length === 2);
  // ── duplicate ──
  d.querySelectorAll("#chaseBody tr")[0].querySelector(".tx-dup").click();
  check("duplicate row", d.querySelectorAll("#chaseBody tr").length === 3);

  // ── localStorage persistence, separate from the ledger ──
  check("ledger key untouched by chase", window.localStorage.getItem("gy-cards-transactions-v1") === null || !JSON.parse(window.localStorage.getItem("gy-cards-transactions-v1")).some(r => r.player));

  // ── the ledger tab still works ──
  d.querySelector('.tab[data-tab="transactions"]').click();
  check("ledger still renders", d.querySelectorAll("#txBody tr").length > 100, String(d.querySelectorAll("#txBody tr").length));
  check("body wide on ledger", d.body.classList.contains("wide"));

  check("no uncaught errors", errs.length === 0, errs.join(" / "));
  console.log(fails ? `\n${fails} FAILURE(S)` : "\nall DOM checks passed");
  process.exit(fails ? 1 : 0);
}, 300);
