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
    w.Element.prototype.scrollIntoView = function () {};
  },
});
const { window } = dom, d = window.document;
for (const f of ["app.js", "transactions.js", "chase.js", "staging.js"]) window.eval(fs.readFileSync(path.join(DOCS, f), "utf8"));
window.eval(html.slice(html.lastIndexOf("<script>") + 8, html.lastIndexOf("</script>")));
setTimeout(() => {
  d.querySelector('.tab[data-tab="transactions"]').click();
  const pub = d.getElementById("txPubState");
  console.log("rows loaded :", d.querySelectorAll("#txBody tr").length);
  console.log("publish state:", pub.textContent, `(${pub.className})`);
  console.log("round-trips byte-identically:", pub.className.includes("ok"));
  const snap = window.cardsLedger.snapshot();
  const sports = new Set(snap.map(r => r.sport).filter(Boolean));
  console.log("one Pokemon spelling:", [...sports].filter(s => /pok/i.test(s)));
  console.log("Van Horn spellings:", [...new Set(snap.filter(r => /horn/i.test(r.athlete)).map(r => r.athlete))]);
  console.log("blank sports:", snap.filter(r => !r.sport).length);
  process.exit(pub.className.includes("ok") ? 0 : 1);
}, 600);
