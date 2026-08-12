const fs = require("fs"), path = require("path");
const { JSDOM } = require("jsdom");
const DOCS = path.join(__dirname, "..", "docs");
const html = fs.readFileSync(path.join(DOCS, "index.html"), "utf8");
let fails = 0;
const check = (l, c, e = "") => { if (c) console.log("ok   " + l); else { fails++; console.log(`FAIL ${l} ${e}`); } };
const dom = new JSDOM(html, {
  runScripts: "dangerously", url: "https://geraldno20.github.io/cards/",
  beforeParse(w) {
    w.fetch = u => {
        {
          const isApi = String(u).startsWith("https://api.github.com/");
          const m = String(u).match(/data\/(transactions|chase)\.csv$/);
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
  d.querySelector('.tab[data-tab="staging"]').click();
  const trs = [...d.querySelectorAll("#stageBody tr[data-id]")];
  const cell = (tr, k) => tr.querySelector(`td[data-key="${k}"]`)?.textContent ?? "";
  check("both rows picked up from the published queue", trs.length === 2, String(trs.length));
  check("Lillard identified", cell(trs[0], "athlete") === "Damian Lillard", cell(trs[0], "athlete"));
  check("Anunoby identified", cell(trs[1], "athlete") === "OG Anunoby", cell(trs[1], "athlete"));
  check("manufacturer read off the card", cell(trs[0], "manufacturer") === "Topps Chrome");
  check("serial numbering kept in the description", cell(trs[0], "description") === "Fortune 1/1" && cell(trs[1], "description") === "Red Refractor 1/5",
        `${cell(trs[0], "description")} | ${cell(trs[1], "description")}`);
  check("sport filled", cell(trs[0], "sport") === "Basketball");
  check("no amount invented", cell(trs[0], "amount") === "" && cell(trs[1], "amount") === "");
  check("both default to buy", [...trs].every(tr => tr.querySelector("select[data-key=kind]").value === "buy"));
  check("they land as loose rows, not a batch", cell(trs[0], "batch") === "" && cell(trs[1], "batch") === "");
  const group = d.querySelector("#stageBody .stage-groupcell");
  check("group header says Loose rows", /Loose rows/.test(group.textContent), group.textContent.replace(/\s+/g, " ").trim().slice(0, 80));
  check("not submittable until you add the money", /thing[s]? to fix/.test(group.textContent), group.textContent.replace(/\s+/g, " ").trim().slice(0, 90));
  check("the tooltip says exactly what's missing", /no amount/.test(trs[0].title), trs[0].title);
  check("status reports the pickup", /picked up from the published queue/.test(d.getElementById("stageStatus").textContent), d.getElementById("stageStatus").textContent);
  console.log(fails ? `\n${fails} FAILURE(S)` : "\nstaged rows load correctly");
  process.exit(fails ? 1 : 0);
}, 700);
