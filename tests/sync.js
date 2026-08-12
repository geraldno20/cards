const fs = require("fs"), path = require("path");
const { JSDOM } = require("jsdom");
const DOCS = path.join(__dirname, "..", "docs");
const html = fs.readFileSync(path.join(DOCS, "index.html"), "utf8");
const SEED = fs.readFileSync(path.join(DOCS, "data/chase.csv"), "utf8").trimEnd().split("\n").length - 1;

let fails = 0;
const check = (label, cond, extra = "") => {
  if (cond) console.log(`ok   ${label}`);
  else { fails++; console.log(`FAIL ${label} ${extra}`); }
};
const wait = ms => new Promise(r => setTimeout(r, ms));

// A browser whose saved copy predates the second set.
function boot({ local, token }) {
  const puts = [];
  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    url: "https://geraldno20.github.io/cards/",
    beforeParse(window) {
      if (local) window.localStorage.setItem("gy-cards-chase-v1", JSON.stringify(local));
      if (token) window.localStorage.setItem("gy-cards-github-v1", JSON.stringify({ owner: "geraldno20", repo: "cards", branch: "main", token }));
      window.fetch = (url, opts = {}) => {
        {
          const isApi = String(url).startsWith("https://api.github.com/");
          const m = String(url).match(/data\/(transactions|chase|staging)\.csv$/);
          if (m && !isApi) {
            const fx = path.join(__dirname, "fixtures", m[1] + ".csv");
            const t = fs.readFileSync(fx, "utf8");
            return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(t) });
          }
        }
        const u = String(url);
        if (u.startsWith("https://api.github.com/")) {
          if ((opts.method || "GET") === "GET") return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ sha: "deadbeef" }) });
          puts.push(JSON.parse(opts.body));
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ commit: { sha: "abc1234567" } }) });
        }
        const p = path.join(DOCS, u.replace(/^\.?\//, ""));
        if (!fs.existsSync(p)) return Promise.resolve({ ok: false, status: 404, statusText: "Not Found" });
        const text = fs.readFileSync(p, "utf8");
        return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(text), json: () => Promise.resolve(JSON.parse(text)) });
      };
      window.confirm = () => true;
    },
  });
  const { window } = dom, d = window.document;
  for (const f of ["app.js", "transactions.js", "chase.js", "staging.js"]) window.eval(fs.readFileSync(path.join(DOCS, f), "utf8"));
  window.eval(html.slice(html.lastIndexOf("<script>") + 8, html.lastIndexOf("</script>")));
  return { window, d, puts, decode: b64 => Buffer.from(b64, "base64").toString("utf8") };
}

const NAMES = ["Michael Jordan", "Kevin Garnett", "David Robinson", "Allen Iverson", "Hakeem Olajuwon", "Anfernee Hardaway", "Gary Payton", "Scottie Pippen", "Shaquille O'Neal", "Mitch Richmond", "John Stockton", "Grant Hill", "Charles Barkley", "Dikembe Mutombo", "Karl Malone", "Shawn Kemp", "Patrick Ewing", "Kobe Bryant", "Terrell Brandon", "Vin Baker"];
const stale20 = NAMES.map((player, i) => ({
  set: "1998-99 Topps Roundball Royalty Refractor", player, number: "R" + (i + 1),
}));

(async () => {
  // ── 1. a clean stale copy is simply replaced by the published list ──
  {
    const { d } = boot({ local: stale20 });
    await wait(400);
    d.querySelector('.tab[data-tab="chase"]').click();
    const rows = d.querySelectorAll("#chaseBody tr").length;
    check("stale copy picks up the new set with no button press", rows === SEED, String(rows));
    check("both sets shown", d.getElementById("chaseSets").querySelectorAll(".chase-prog").length === 2);
    check("status explains what happened", /new cards from the published list/.test(d.getElementById("chaseStatus").textContent), d.getElementById("chaseStatus").textContent.trim());
    check("clean merge matches the published file", /saved to GitHub/.test(d.getElementById("chasePubState").textContent), d.getElementById("chasePubState").textContent);
  }

  // ── 2. a copy with progress keeps it, and still gains the new set ──
  {
    const withProgress = stale20.map((r, i) =>
      i === 17 ? { ...r, got: true, grade: "PSA 9", cost: "3200.00", date: "2026-03-11" } : r);
    const { d } = boot({ local: withProgress });
    await wait(400);
    d.querySelector('.tab[data-tab="chase"]').click();
    const trs = [...d.querySelectorAll("#chaseBody tr")];
    check("merged to the full list", trs.length === SEED, String(trs.length));
    const kobe = trs.find(tr => tr.children[2].textContent === "Kobe Bryant" && tr.children[3].textContent === "R18");
    check("Kobe row still there once", !!kobe);
    check("tick survived the merge", kobe.querySelector("input").checked === true);
    check("grade survived", kobe.querySelector('td[data-key="grade"]').textContent === "PSA 9");
    check("cost survived", kobe.querySelector('td[data-key="cost"]').textContent === "3200.00");
    check("tiles count the kept card", /Got1/.test(d.getElementById("chaseTotals").textContent.replace(/\s/g, "")), d.getElementById("chaseTotals").textContent);
    check("status mentions what was kept", /kept your 1 filled-in card/.test(d.getElementById("chaseStatus").textContent), d.getElementById("chaseStatus").textContent.trim());
    check("no duplicate Kobe R18", trs.filter(tr => tr.children[3].textContent === "R18").length === 1);
  }

  // ── 3. a row only this browser knows about is not thrown away ──
  {
    const mine = [{ set: "2003-04 Topps Chrome", player: "LeBron James", number: "111", got: true, cost: "900" }];
    const { d } = boot({ local: mine });
    await wait(400);
    d.querySelector('.tab[data-tab="chase"]').click();
    const trs = [...d.querySelectorAll("#chaseBody tr")];
    check("local-only row kept alongside published", trs.length === SEED + 1, String(trs.length));
    check("local-only row is last", trs[trs.length - 1].children[2].textContent === "LeBron James");
    check("status flags it", /only in this browser/.test(d.getElementById("chaseStatus").textContent), d.getElementById("chaseStatus").textContent.trim());
  }

  // ── 3b. an upstream spelling fix must not fork the row ──
  {
    const drift = [{ set: "1998-99 Topps Roundball Royalty Refractor", player: "Micheal Jordan", number: "R1", got: true, grade: "PSA 8" }];
    const { d } = boot({ local: drift });
    await wait(400);
    d.querySelector('.tab[data-tab="chase"]').click();
    const trs = [...d.querySelectorAll("#chaseBody tr")];
    check("misspelled row didn't fork", trs.length === SEED, String(trs.length));
    check("published spelling wins", trs[0].children[2].textContent === "Michael Jordan", trs[0].children[2].textContent);
    check("progress still carried over", trs[0].querySelector("input").checked === true && trs[0].querySelector('td[data-key="grade"]').textContent === "PSA 8");
  }

  // ── 4. with a token, ticking a box commits itself ──
  {
    const { d, puts, decode } = boot({ token: "github_pat_x" });
    await wait(400);
    d.querySelector('.tab[data-tab="chase"]').click();
    check("nothing published on a plain load", puts.length === 0, String(puts.length));
    check("state starts clean", /saved to GitHub/.test(d.getElementById("chasePubState").textContent), d.getElementById("chasePubState").textContent);
    const box = d.querySelectorAll("#chaseBody tr")[0].querySelector("input");
    box.checked = true;
    box.dispatchEvent(new d.defaultView.Event("change", { bubbles: true }));
    await wait(400);
    check("shows it's about to save", /saving shortly/.test(d.getElementById("chasePubState").textContent), d.getElementById("chasePubState").textContent);
    check("hasn't fired yet (debounced)", puts.length === 0, String(puts.length));
    await wait(2200);
    check("committed on its own", puts.length === 1, String(puts.length));
    check("commit carries the tick", decode(puts[0].content).split("\n")[1].startsWith("yes,"), decode(puts[0].content).split("\n")[1]);
    check("commit message", /Update chase list \(\d+ cards\)/.test(puts[0].message), puts[0].message);
    check("toolbar back to saved", /saved to GitHub/.test(d.getElementById("chasePubState").textContent), d.getElementById("chasePubState").textContent);
    check("status names the commit", /commit abc1234/.test(d.getElementById("chaseStatus").textContent), d.getElementById("chaseStatus").textContent.trim());

    // a burst of ticks coalesces into one commit
    const trs = [...d.querySelectorAll("#chaseBody tr")];
    for (const i of [1, 2, 3, 4]) {
      const b = trs[i].querySelector("input");
      b.checked = true;
      b.dispatchEvent(new d.defaultView.Event("change", { bubbles: true }));
      await wait(120);
    }
    await wait(2400);
    check("four ticks -> one extra commit", puts.length === 2, String(puts.length));
    const lines = decode(puts[1].content).split("\n");
    check("all five ticks in that commit", lines.slice(1, 6).every(l => l.startsWith("yes,")), lines.slice(1, 6).map(l => l.slice(0, 4)).join("|"));
  }

  // ── 5. without a token nothing leaves the browser ──
  {
    const { d, puts } = boot({});
    await wait(400);
    d.querySelector('.tab[data-tab="chase"]').click();
    const box = d.querySelectorAll("#chaseBody tr")[0].querySelector("input");
    box.checked = true;
    box.dispatchEvent(new d.defaultView.Event("change", { bubbles: true }));
    await wait(2500);
    check("no commit without a token", puts.length === 0, String(puts.length));
    check("still saved locally", JSON.parse(d.defaultView.localStorage.getItem("gy-cards-chase-v1"))[0].got === true);
    check("toolbar explains why it isn't syncing", /add a GitHub token/.test(d.getElementById("chasePubState").textContent), d.getElementById("chasePubState").textContent);
  }

  console.log(fails ? `\n${fails} FAILURE(S)` : "\nall sync checks passed");
  process.exit(fails ? 1 : 0);
})();
