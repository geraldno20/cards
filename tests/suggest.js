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
const box = () => d.querySelector(".tx-suggest");
const visible = () => !!box() && box().hidden === false;
const items = () => [...(box()?.children || [])].map(c => c.querySelector("span").textContent);
const key = (el, k, shift = false) => el.dispatchEvent(new window.KeyboardEvent("keydown", { key: k, shiftKey: shift, bubbles: true }));
const cellIn = (tr, k) => tr.querySelector(`td[data-key="${k}"]`);

(async () => {
  await wait(500);
  d.querySelector('.tab[data-tab="transactions"]').click();
  const wrap = $("txWrap");
  const trs = () => [...d.querySelectorAll("#txBody tr")];

  // ── opens on a column with history, ranked by use ──
  const sportCell = cellIn(trs()[0], "sport");
  sportCell.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true }));
  sportCell.dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true }));
  check("list opens for Sport", visible(), String(visible()));
  check("ranked by how often used", items()[0] === "Basketball" && items()[1] === "Soccer", items().slice(0, 3).join("|"));
  check("shows a count per value", box().querySelector(".n").textContent.trim().length > 0);
  check("caps the list", items().length <= 8, String(items().length));

  // ── nothing preselected, so Enter commits what you typed ──
  check("nothing preselected", box().querySelector(".hot") === null);
  sportCell.textContent = "Hockey";
  sportCell.dispatchEvent(new window.Event("input", { bubbles: true }));
  key(wrap, "Enter");
  await wait(250);
  check("a genuinely new value survives Enter", window.cardsLedger.snapshot()[0].sport === "Hockey", window.cardsLedger.snapshot()[0].sport);

  // ── arrow into the list and accept ──
  const sport2 = cellIn(trs()[1], "sport");
  sport2.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true }));
  sport2.dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true }));
  check("list open on the second row", visible());
  key(wrap, "ArrowDown");
  check("first item highlighted", box().children[0].classList.contains("hot"));
  key(wrap, "ArrowDown");
  check("moves down", box().children[1].classList.contains("hot"));
  key(wrap, "ArrowUp");
  check("moves back up", box().children[0].classList.contains("hot"));
  const want = items()[0];
  key(wrap, "Enter");
  await wait(250);
  check("Enter accepted the highlighted value", sport2.textContent === want, `${sport2.textContent} vs ${want}`);
  check("model took it too", window.cardsLedger.snapshot()[1].sport === want);

  // ── filtering as you type, accent-insensitively ──
  const sport3 = cellIn(trs()[2], "sport");
  sport3.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true }));
  sport3.dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true }));
  sport3.textContent = "poke";
  sport3.dispatchEvent(new window.Event("input", { bubbles: true }));
  check("typing filters", items().every(v => /poke|poké/i.test(v)), items().join("|"));
  check("filter finds the surviving spelling", items().some(v => v === "Pokemon"), items().join("|"));
  // typing the accented form must still find the unaccented value
  sport3.textContent = "Pokémon";
  sport3.dispatchEvent(new window.Event("input", { bubbles: true }));
  check("accent-insensitive both ways", items().some(v => v === "Pokemon"), items().join("|"));

  // ── Escape closes the list without abandoning the edit ──
  sport3.textContent = "poke";   // a partial match, so the list is up
  sport3.dispatchEvent(new window.Event("input", { bubbles: true }));
  check("list up on a partial match", visible(), String(visible()));
  key(wrap, "Escape");
  check("Escape closed the list only", !visible() && sport3.classList.contains("editing"), `${visible()}/${sport3.className}`);

  // ── committing a case/accent variant snaps onto the value already in use ──
  sport3.textContent = "pokemon";
  sport3.dispatchEvent(new window.Event("input", { bubbles: true }));
  check("list self-hides when it only echoes what you typed", !visible(), String(visible()));
  key(wrap, "Enter");
  await wait(250);
  const snapped = window.cardsLedger.snapshot()[2].sport;
  check("snapped to the established spelling", snapped === "Pokemon", snapped);

  // ── no list for free-text columns ──
  const desc = cellIn(trs()[3], "description");
  desc.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true }));
  desc.dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true }));
  check("no list for Description", !visible());
  key(wrap, "Escape");

  // ── manufacturer and source get one ──
  for (const [k, first] of [["manufacturer", "Donruss"], ["purchaseFrom", "eBay"]]) {
    const c = cellIn(trs()[4], k);
    c.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true }));
    c.dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true }));
    check(`list for ${k}`, visible() && items()[0] === first, items().slice(0, 2).join("|"));
    key(wrap, "Escape");
    key(wrap, "Escape");
  }

  // ── a new row arrives with date and source filled ──
  const before = trs().length;
  $("txAdd").click();
  await wait(150);
  const fresh = trs()[trs().length - 1];
  const today = new Date();
  const expect = `${today.getMonth() + 1}/${today.getDate()}/${today.getFullYear()}`;
  check("row added", trs().length === before + 1);
  check("date prefilled as today", cellIn(fresh, "purchaseDate").textContent === expect, cellIn(fresh, "purchaseDate").textContent);
  check("source prefilled", cellIn(fresh, "purchaseFrom").textContent.length > 0, cellIn(fresh, "purchaseFrom").textContent);
  check("sport deliberately left blank", cellIn(fresh, "sport").textContent === "", cellIn(fresh, "sport").textContent);

  // ── the API snaps values on the way in ──
  window.cardsLedger.addPurchase({ sport: "pokémon", manufacturer: "donruss", athlete: "Test Card", purchasePrice: "1" });
  const last = window.cardsLedger.snapshot().slice(-1)[0];
  check("API snapped sport", ["Pokemon", "Pokémon"].includes(last.sport), last.sport);
  check("API snapped manufacturer", last.manufacturer === "Donruss", last.manufacturer);
  check("API left a new athlete alone", last.athlete === "Test Card", last.athlete);

  console.log(fails ? `\n${fails} FAILURE(S)` : "\nall suggestion checks passed");
  process.exit(fails ? 1 : 0);
})();
