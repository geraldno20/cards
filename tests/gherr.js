const fs = require("fs"), path = require("path");
const { JSDOM } = require("jsdom");
const DOCS = path.join(__dirname, "..", "docs");
const html = fs.readFileSync(path.join(DOCS, "index.html"), "utf8");
let fails = 0;
const check = (l, c, e = "") => { if (c) console.log("ok   " + l); else { fails++; console.log(`FAIL ${l} ${e}`); } };
const wait = ms => new Promise(r => setTimeout(r, ms));

function boot(putStatus, putMessage) {
  const dom = new JSDOM(html, {
    runScripts: "dangerously", url: "https://geraldno20.github.io/cards/",
    beforeParse(w) {
      w.localStorage.setItem("gy-cards-github-v1", JSON.stringify({ owner: "geraldno20", repo: "cards", branch: "main", token: "t" }));
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
          const method = opts.method || "GET";
          if (method === "GET") {
            if (putStatus === 401) return Promise.resolve({ ok: false, status: 401, statusText: "Unauthorized", json: () => Promise.resolve({ message: putMessage }) });
            return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ sha: "x" }) });
          }
          return Promise.resolve({ ok: false, status: putStatus, statusText: "err", json: () => Promise.resolve({ message: putMessage }) });
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
  return { window, d, $: id => d.getElementById(id) };
}

(async () => {
  // 401 on the ledger
  {
    const { d, $ } = boot(401, "Bad credentials");
    await wait(500);
    d.querySelector('.tab[data-tab="transactions"]').click();
    $("txPublish").click();
    await wait(300);
    const t = $("txStatus").textContent;
    check("401 says the token is the problem", /token isn't valid/.test(t), t);
    check("401 tells you to make a fresh one", /fresh fine-grained token/.test(t), "");
    check("401 keeps GitHub's own words", /Bad credentials/.test(t), "");
    check("401 does not blame permissions", !/Contents/.test(t), t);
    check("button re-enabled after failure", $("txPublish").disabled === false);
  }
  // 403 on the ledger
  {
    const { d, $ } = boot(403, "Resource not accessible by personal access token");
    await wait(500);
    d.querySelector('.tab[data-tab="transactions"]').click();
    $("txPublish").click();
    await wait(300);
    const t = $("txStatus").textContent;
    check("403 says the token is valid but not allowed", /valid but isn't allowed to write/.test(t), t);
    check("403 names Contents: Read and write", /Contents.*Read and write/.test(t), "");
    check("403 warns about the read-only default", /read-only/.test(t), "");
    check("403 keeps GitHub's own words", /Resource not accessible/.test(t), "");
  }
  // 404
  {
    const { d, $ } = boot(404, "Not Found");
    await wait(500);
    d.querySelector('.tab[data-tab="transactions"]').click();
    $("txPublish").click();
    await wait(300);
    check("404 explained too", /can't see that file/.test($("txStatus").textContent), $("txStatus").textContent);
  }
  // chase auto-publish surfaces the same explanation
  {
    const { window, d, $ } = boot(403, "Resource not accessible by personal access token");
    await wait(500);
    d.querySelector('.tab[data-tab="chase"]').click();
    const box = d.querySelectorAll("#chaseBody tr")[0].querySelector("input[type=checkbox]");
    box.checked = true;
    box.dispatchEvent(new window.Event("change", { bubbles: true }));
    await wait(2600);
    const t = $("chaseStatus").textContent;
    check("chase explains 403 as well", /valid but isn't allowed to write/.test(t), t);
    check("chase says the tick is still saved locally", /still saved in this browser/.test(t), t);
  }
  console.log(fails ? `\n${fails} FAILURE(S)` : "\nall GitHub-error checks passed");
  process.exit(fails ? 1 : 0);
})();
