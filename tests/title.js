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

(async () => {
  await wait(500);
  d.querySelector('.tab[data-tab="transactions"]').click();
  const fields = () => Object.fromEntries([...$("txTitlePreview").querySelectorAll(".field")]
    .map(f => [f.querySelector(".k").textContent, f.querySelector(".v").textContent]));
  const type = t => { $("txTitle").value = t; $("txTitle").dispatchEvent(new window.Event("input", { bubbles: true })); };

  // ── the headline case ──
  type("1998-99 Topps Roundball Royalty Refractor #R18 Kobe Bryant PSA 9");
  let f = fields();
  check("year", f.Year === "1998-99", f.Year);
  check("manufacturer from ledger vocabulary", f.Manufacturer === "Topps Roundball Royalty", f.Manufacturer);
  check("athlete from chase vocabulary", f.Athlete === "Kobe Bryant", f.Athlete);
  check("number", f.Number === "R18", f.Number);
  check("description is the leftover", f.Description === "Refractor", f.Description);
  check("grade normalized", f.Grade === "PSA 9", f.Grade);
  check("sport inferred", f.Sport === "Basketball", f.Sport);
  check("button enabled", $("txTitleGo").disabled === false);

  // ── a print run must not be read as a year ──
  type("2023-24 Prizm Purple Cracked Ice /149 Victor Wembanyama");
  f = fields();
  check("season year, not the print run", f.Year === "2023-24", f.Year);
  check("print run stays in the description", /\/149/.test(f.Description), f.Description);
  type("Panini Gold Standard Gold /2012 Grant Hill");
  f = fields();
  check("/2012 is not a year", f.Year === "—", f.Year);
  check("/2012 kept in the description", /\/2012/.test(f.Description), f.Description);

  // ── name before the brand still works ──
  type("Kobe Bryant 1998-99 Topps Stadium Club Triumvirate Illuminator #T13A");
  f = fields();
  check("athlete found mid-title", f.Athlete === "Kobe Bryant", f.Athlete);
  check("brand still matched after removal", f.Manufacturer === "Topps Stadium Club Triumvirate", f.Manufacturer);
  check("number with letters", f.Number === "T13A", f.Number);

  // ── grader variants ──
  for (const [t, want] of [["BGS 9.5", "BGS 9.5"], ["sgc 10", "SGC 10"], ["CGC 8.5", "CGC 8.5"]]) {
    type(`2003-04 Topps Chrome LeBron James ${t}`);
    check(`grade ${t}`, fields().Grade === want, fields().Grade);
  }
  type("2003-04 Topps Chrome Refractor LeBron James");
  check("no grade means raw", fields().Grade === "—", fields().Grade);

  // ── unknown player is flagged, not invented ──
  type("2024-25 Prizm Some Unknown Rookie Guy #42");
  check("unrecognized athlete noted", /No athlete recognized/.test($("txTitleNote").textContent), $("txTitleNote").textContent);
  check("still addable", $("txTitleGo").disabled === false);

  // ── empties out ──
  type("");
  check("preview hidden when empty", $("txTitlePreview").hidden === true);
  check("button disabled when empty", $("txTitleGo").disabled === true);

  // ── committing lands a row and parks on Price ──
  const before = d.querySelectorAll("#txBody tr").length;
  type("1998-99 Topps Roundball Royalty Refractor #R2 Kevin Garnett PSA 8");
  $("txTitleGo").click();
  await wait(250);
  check("row added", d.querySelectorAll("#txBody tr").length === before + 1, `${before} -> ${d.querySelectorAll("#txBody tr").length}`);
  const last = window.cardsLedger.snapshot().slice(-1)[0];
  check("row carries the parse", [last.year, last.manufacturer, last.athlete, last.number, last.description, last.grade].join("|")
        === "1998-99|Topps Roundball Royalty|Kevin Garnett|R2|Refractor|PSA 8",
        [last.year, last.manufacturer, last.athlete, last.number, last.description, last.grade].join("|"));
  check("date defaulted", last.purchaseDate.length > 0, last.purchaseDate);
  check("source defaulted", last.purchaseFrom.length > 0, last.purchaseFrom);
  check("price left for you", last.purchasePrice === "", `"${last.purchasePrice}"`);
  const editing = d.querySelector("#txBody td.editing");
  check("cursor parked on Price", editing && editing.dataset.key === "purchasePrice", editing && editing.dataset.key);
  check("input cleared", $("txTitle").value === "");
  check("status says what to do", /type the price/.test($("txStatus").textContent), $("txStatus").textContent.trim());

  console.log(fails ? `\n${fails} FAILURE(S)` : "\nall title-parser checks passed");
  process.exit(fails ? 1 : 0);
})();
