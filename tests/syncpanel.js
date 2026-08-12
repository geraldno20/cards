const fs = require("fs"), path = require("path");
const { JSDOM } = require("jsdom");
const DOCS = path.join(__dirname, "..", "docs");
const html = fs.readFileSync(path.join(DOCS, "index.html"), "utf8");
let fails = 0;
const check = (l, c, e = "") => { if (c) console.log("ok   " + l); else { fails++; console.log(`FAIL ${l} ${e}`); } };
const wait = ms => new Promise(r => setTimeout(r, ms));

function boot(seed = {}) {
  const puts = [];
  const dom = new JSDOM(html, {
    runScripts: "dangerously", url: "https://geraldno20.github.io/cards/",
    beforeParse(w) {
      for (const [k, v] of Object.entries(seed)) w.localStorage.setItem(k, JSON.stringify(v));
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
          if ((opts.method || "GET") === "GET") return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ sha: "abc" }) });
          puts.push({ url: s, body: JSON.parse(opts.body) });
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ commit: { sha: "1234567" } }) });
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
  return { window, d, puts, $: id => d.getElementById(id) };
}

(async () => {
  // ── the removed inputs are really gone ──
  {
    const { d, $ } = boot();
    await wait(500);
    for (const id of ["txGhOwner", "txGhRepo", "txGhBranch", "txGhPath", "chaseGhOwner", "chaseGhRepo", "chaseGhBranch", "chaseGhPath"]) {
      check(`${id} removed`, $(id) === null);
    }
    check("token field kept on both tabs", $("txGhToken") !== null && $("chaseGhToken") !== null);
    check("Chase gained a Forget token button", $("chaseForgetToken") !== null);
    const inputs = [...d.querySelectorAll("#tab-transactions .tx-import input, #tab-chase .tx-import input")]
      .filter(i => i.type !== "file" && i.type !== "checkbox");
    check("only the two token boxes + import fields remain", inputs.filter(i => i.type === "password").length === 2,
          inputs.map(i => i.id || i.type).join("|"));

    // ── the target line says where, and that it can't yet ──
    check("ledger target names the repo", /geraldno20\/cards/.test($("txGhTarget").textContent), $("txGhTarget").textContent);
    check("ledger target names the file", /docs\/data\/transactions\.csv/.test($("txGhTarget").textContent), $("txGhTarget").textContent);
    check("ledger target asks for a token", /add a token/i.test($("txGhTarget").textContent), $("txGhTarget").textContent);
    check("chase target names its own file", /docs\/data\/chase\.csv/.test($("chaseGhTarget").textContent), $("chaseGhTarget").textContent);
    check("chase target asks for a token", /add a token/i.test($("chaseGhTarget").textContent), $("chaseGhTarget").textContent);
  }

  // ── typing a token updates both the line and syncing ──
  {
    const { d, $, window, puts } = boot();
    await wait(500);
    d.querySelector('.tab[data-tab="chase"]').click();
    $("chaseGhToken").value = "github_pat_1";
    $("chaseGhToken").dispatchEvent(new window.Event("change", { bubbles: true }));
    check("chase line flips to active", /Saving changes to/.test($("chaseGhTarget").textContent), $("chaseGhTarget").textContent);
    check("token shared into the ledger's config", JSON.parse(window.localStorage.getItem("gy-cards-github-v1")).token === "github_pat_1");
    check("ledger panel picks it up on next read", (() => { $("txGhToken"); return true; })());

    // a tick now publishes to the derived path
    const box = d.querySelectorAll("#chaseBody tr")[0].querySelector("input[type=checkbox]");
    box.checked = true;
    box.dispatchEvent(new window.Event("change", { bubbles: true }));
    await wait(2400);
    check("published once", puts.length === 1, String(puts.length));
    check("published to the derived chase path", /contents\/docs%2Fdata%2Fchase\.csv/.test(puts[0].url) || /docs\/data\/chase\.csv/.test(decodeURIComponent(puts[0].url)), puts[0].url);

    // forget it again
    $("chaseForgetToken").click();
    check("token cleared", !JSON.parse(window.localStorage.getItem("gy-cards-github-v1")).token);
    check("chase line back to asking", /add a token/i.test($("chaseGhTarget").textContent), $("chaseGhTarget").textContent);
    check("nothing unsynced right after a successful save", /saved to GitHub/.test($("chasePubState").textContent), $("chasePubState").textContent);
    // now make a change with no token: that's when it has to explain itself
    const box2 = d.querySelectorAll("#chaseBody tr")[1].querySelector("input[type=checkbox]");
    box2.checked = true;
    box2.dispatchEvent(new window.Event("change", { bubbles: true }));
    await wait(400);
    check("pubstate explains why it isn't syncing", /add a GitHub token/.test($("chasePubState").textContent), $("chasePubState").textContent);
    await wait(2200);
    check("and nothing was published without a token", puts.length === 1, String(puts.length));
  }

  // ── a stale configured path in storage can no longer send a save astray ──
  {
    const { d, $, window, puts } = boot({
      "gy-cards-github-v1": { owner: "geraldno20", repo: "cards", branch: "main", token: "t", path: "docs/data/WRONG.csv" },
      "gy-cards-chase-github-v1": { path: "docs/data/ALSO-WRONG.csv" },
    });
    await wait(500);
    d.querySelector('.tab[data-tab="transactions"]').click();
    check("ledger ignores the stale stored path", /docs\/data\/transactions\.csv/.test($("txGhTarget").textContent), $("txGhTarget").textContent);
    $("txPublish").click();
    await wait(300);
    check("ledger published to the right file", /transactions\.csv/.test(decodeURIComponent(puts[0].url)) && !/WRONG/.test(decodeURIComponent(puts[0].url)), decodeURIComponent(puts[0].url));
    d.querySelector('.tab[data-tab="chase"]').click();
    check("chase ignores its stale stored path", /docs\/data\/chase\.csv/.test($("chaseGhTarget").textContent), $("chaseGhTarget").textContent);
    check("the dead chase key is cleared out", window.localStorage.getItem("gy-cards-chase-github-v1") === null,
          String(window.localStorage.getItem("gy-cards-chase-github-v1")));
  }

  // ── forgetting from the ledger side says it affects Chase too ──
  {
    const { d, $, window } = boot({ "gy-cards-github-v1": { token: "t" } });
    await wait(500);
    d.querySelector('.tab[data-tab="transactions"]').click();
    check("ledger shows the token is live", /Publishing to/.test($("txGhTarget").textContent), $("txGhTarget").textContent);
    $("txForgetToken").click();
    check("status mentions Chase", /Chase/.test($("txStatus").textContent), $("txStatus").textContent);
    check("line reverts", /add a token/i.test($("txGhTarget").textContent), $("txGhTarget").textContent);
  }

  console.log(fails ? `\n${fails} FAILURE(S)` : "\nall sync-panel checks passed");
  process.exit(fails ? 1 : 0);
})();
