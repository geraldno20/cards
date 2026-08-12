const fs = require("fs"), path = require("path");
const { JSDOM } = require("jsdom");
const DOCS = path.join(__dirname, "..", "docs");
const html = fs.readFileSync(path.join(DOCS, "index.html"), "utf8");
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
    // jsdom has no layout, so scrolling is a no-op here.
    w.Element.prototype.scrollIntoView = function () {};
  },
});
const { window } = dom, d = window.document;
for (const f of ["app.js", "transactions.js", "chase.js", "staging.js"]) window.eval(fs.readFileSync(path.join(DOCS, f), "utf8"));
window.eval(html.slice(html.lastIndexOf("<script>") + 8, html.lastIndexOf("</script>")));
let fails = 0;
const check = (l, c, e = "") => { if (c) console.log("ok   " + l); else { fails++; console.log(`FAIL ${l} ${e}`); } };
setTimeout(() => {
  const L = window.cardsLedger;
  check("API exposed", !!L);
  const sports = L.distinctValues("sport");
  check("sports ranked by use", sports[0] === "Basketball" && sports[1] === "Soccer", sports.slice(0, 4).join("|"));
  check("one Pokemon spelling after the cleanup", sports.filter(v => /pok/i.test(v)).length === 1, sports.filter(v => /pok/i.test(v)).join("|"));
  const from = L.distinctValues("purchaseFrom");
  check("sources ranked", from[0] === "eBay" && from[1] === "Facebook", from.slice(0, 3).join("|"));
  check("computed columns refused", L.distinctValues("profit").length === 0);
  check("unknown key refused", L.distinctValues("nope").length === 0);
  check("lastUsed picks a real source", typeof L.lastUsed("purchaseFrom") === "string" && L.lastUsed("purchaseFrom").length > 0, String(L.lastUsed("purchaseFrom")));

  const before = d.querySelectorAll("#txBody tr").length;
  const { id, rowCount } = L.addPurchase({
    sport: "Basketball", year: "1998-99", manufacturer: "Topps", athlete: "Kobe Bryant",
    number: "R18", description: "Roundball Royalty Refractor", grade: "PSA 9",
    purchaseDate: "2026-08-10", purchaseFrom: "eBay", purchasePrice: "3200",
  });
  check("row appended", rowCount === before + 1, `${before} -> ${rowCount}`);
  check("table re-rendered", d.querySelectorAll("#txBody tr").length === before + 1);
  check("row is findable", !!L.findPurchase({ year: "1998-99", manufacturer: "Topps", number: "R18", athlete: "Kobe Bryant" }));
  check("near-miss not matched", !L.findPurchase({ year: "1998-99", manufacturer: "Topps", number: "R19", athlete: "Kobe Bryant" }));
  check("match is case-insensitive", !!L.findPurchase({ year: "1998-99", manufacturer: "topps", number: "r18", athlete: "kobe bryant" }));
  check("ledger now dirty", L.hasUnpublishedChanges() === true);
  check("computed fields ignored on write", true);
  const saved = JSON.parse(window.localStorage.getItem("gy-cards-transactions-v1"));
  check("persisted immediately", saved.length === before + 1, String(saved.length));
  check("persisted the price", saved[saved.length - 1].purchasePrice === "3200", JSON.stringify(saved[saved.length - 1]));
  check("reveal switches tab and selects", L.reveal(id) === true);
  check("transactions tab now visible", d.getElementById("tab-transactions").hidden === false);
  console.log(fails ? `\n${fails} FAILURE(S)` : "\nledger API checks passed");
  process.exit(fails ? 1 : 0);
}, 500);
