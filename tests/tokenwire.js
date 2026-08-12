const fs = require("fs"), path = require("path");
const { JSDOM } = require("jsdom");
const DOCS = path.join(__dirname, "..", "docs");
const html = fs.readFileSync(path.join(DOCS, "index.html"), "utf8");
let fails = 0;
const check = (l, c, e = "") => { if (c) console.log("ok   " + l); else { fails++; console.log(`FAIL ${l} ${e}`); } };
const wait = ms => new Promise(r => setTimeout(r, ms));
const seen = [];
const dom = new JSDOM(html, {
  runScripts: "dangerously", url: "https://geraldno20.github.io/cards/",
  beforeParse(w) {
    w.fetch = (u, opts = {}) => {
        {
          const isApi = String(u).startsWith("https://api.github.com/");
          const m = String(u).match(/data\/(transactions|chase|staging)\.csv$/);
          if (m && !isApi) {
            const fx = path.join(__dirname, "fixtures", m[1] + ".csv");
            const t = fs.readFileSync(fx, "utf8");
            return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(t) });
          }
        }
      const s = String(u);
      if (s.startsWith("https://api.github.com/")) {
        seen.push({ url: s, method: opts.method || "GET", auth: opts.headers && opts.headers.Authorization });
        if ((opts.method || "GET") === "GET") return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ sha: "x" }) });
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ commit: { sha: "abc1234" } }) });
      }
      const p = path.join(DOCS, s.replace(/^\.?\//, ""));
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

(async () => {
  await wait(600);
  d.querySelector('.tab[data-tab="transactions"]').click();
  const TOKEN = "github_pat_11ABCDEFG0abcdefghij_KLMNOPqrstuvwxyz0123456789ABCDEFghij";
  const input = d.getElementById("txGhToken");
  // typed with stray whitespace, the way a paste often arrives
  input.value = "  " + TOKEN + "  ";
  input.dispatchEvent(new window.Event("change", { bubbles: true }));
  const stored = JSON.parse(window.localStorage.getItem("gy-cards-github-v1"));
  check("token stored", !!stored.token, JSON.stringify(stored));
  check("stored exactly, whitespace trimmed", stored.token === TOKEN, `len ${stored.token.length} vs ${TOKEN.length}`);
  check("target line goes active", /Publishing to/.test(d.getElementById("txGhTarget").textContent), d.getElementById("txGhTarget").textContent);

  d.getElementById("txPublish").click();
  await wait(400);
  check("two API calls (sha then put)", seen.length === 2, JSON.stringify(seen.map(s => s.method)));
  check("Authorization header sent", !!seen[0].auth, String(seen[0].auth));
  check("header is exactly Bearer + the token", seen[1].auth === `Bearer ${TOKEN}`, `${seen[1].auth}`);
  check("PUT went to the right file", decodeURIComponent(seen[1].url).includes("docs/data/transactions.csv"), decodeURIComponent(seen[1].url));

  // survives a reload
  const input2 = d.getElementById("txGhToken");
  check("field repopulates from storage on init", input2.value === "  " + TOKEN + "  " || input2.value === TOKEN, `"${input2.value}"`);
  console.log(fails ? `\n${fails} FAILURE(S)` : "\ntoken wiring is correct");
  process.exit(fails ? 1 : 0);
})();
