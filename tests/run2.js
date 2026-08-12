const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const DOCS = path.join(__dirname, "..", "docs");
const html = fs.readFileSync(path.join(DOCS, "index.html"), "utf8");

const dom = new JSDOM(html, {
  runScripts: "dangerously",
  url: "https://geraldno20.github.io/cards/",
  beforeParse(window) {
    window.fetch = url => {
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
const { window } = dom;
const d = window.document;
for (const f of ["app.js", "transactions.js", "chase.js", "staging.js"]) window.eval(fs.readFileSync(path.join(DOCS, f), "utf8"));
window.eval(html.slice(html.lastIndexOf("<script>") + 8, html.lastIndexOf("</script>")));

const SEED = fs.readFileSync(path.join(DOCS, "data/chase.csv"), "utf8").trimEnd().split("\n").length - 1;
const $ = id => d.getElementById(id);
const rows = () => [...d.querySelectorAll("#chaseBody tr")];
const wait = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
const check = (label, cond, extra = "") => {
  if (cond) console.log(`ok   ${label}`);
  else { fails++; console.log(`FAIL ${label} ${extra}`); }
};
const fire = (el, type) => el.dispatchEvent(new window.Event(type, { bubbles: true }));

(async () => {
  await wait(200);
  d.querySelector('.tab[data-tab="chase"]').click();
  check("clean on load", $("chasePubState").className.includes("ok"), $("chasePubState").textContent);

  // ── ticking a box marks the list unpublished once the save lands ──
  const box = rows()[0].querySelector("input[type=checkbox]");
  box.checked = true;
  fire(box, "change");
  await wait(350);
  check("pubstate goes dirty after save", $("chasePubState").className.includes("dirty"), $("chasePubState").textContent);
  const saved = JSON.parse(window.localStorage.getItem("gy-cards-chase-v1"));
  check("persisted every seeded row", saved.length === SEED, String(saved.length));
  check("persisted the tick", saved[0].got === true, JSON.stringify(saved[0]));

  // ── untick puts it back to exactly the published bytes ──
  box.checked = false;
  fire(box, "change");
  await wait(350);
  check("pubstate clean again", $("chasePubState").className.includes("ok"), $("chasePubState").textContent);

  // ── keyboard: Enter moves down, Tab moves right, Escape reverts ──
  const cell = (r, key) => rows()[r].querySelector(`td[data-key="${key}"]`);
  const key = (el, k, shift = false) => el.dispatchEvent(new window.KeyboardEvent("keydown", { key: k, shiftKey: shift, bubbles: true }));
  const caretCell = () => {
    const sel = window.getSelection();
    let n = sel && sel.anchorNode;
    while (n && !(n.nodeType === 1 && n.matches?.("td"))) n = n.parentNode;
    return n;
  };
  const c0 = cell(0, "grade");
  c0.focus();
  fire(c0, "focusin");
  key(c0, "Enter");
  check("Enter moves down a row", caretCell() === cell(1, "grade"), caretCell()?.dataset?.key + "/" + [...rows()].indexOf(caretCell()?.closest("tr")));
  key(caretCell(), "Tab");
  check("Tab moves right", caretCell() === cell(1, "cost"), caretCell()?.dataset?.key);
  key(caretCell(), "Tab");
  key(caretCell(), "Tab");
  check("Tab wraps to the next row", caretCell() === cell(2, "set"), caretCell()?.dataset?.key + "/" + [...rows()].indexOf(caretCell()?.closest("tr")));
  key(caretCell(), "Tab", true);
  check("Shift+Tab wraps back", caretCell() === cell(1, "date"), caretCell()?.dataset?.key + "/" + [...rows()].indexOf(caretCell()?.closest("tr")));

  const g = cell(3, "grade");
  g.focus(); fire(g, "focusin");
  g.textContent = "BGS 9.5"; fire(g, "input");
  await wait(250);
  check("edit stored", JSON.parse(window.localStorage.getItem("gy-cards-chase-v1"))[3].grade === "BGS 9.5");
  key(g, "Escape");
  check("Escape reverts the cell", g.textContent === "", JSON.stringify(g.textContent));
  await wait(250);
  check("Escape reverts the model too", !JSON.parse(window.localStorage.getItem("gy-cards-chase-v1"))[3].grade);

  // ── pasting a block spills right and down, adding rows ──
  const LAST = SEED - 1;
  const target = cell(LAST, "grade");
  target.focus(); fire(target, "focusin");
  const paste = new window.Event("paste", { bubbles: true, cancelable: true });
  paste.clipboardData = { getData: () => "PSA 10\t500\t2026-08-01\nPSA 9\t250\t2026-08-02" };
  target.dispatchEvent(paste);
  await wait(250);
  check("paste added a row", rows().length === SEED + 1, String(rows().length));
  check("paste filled the last row", [cell(LAST, "grade").textContent, cell(LAST, "cost").textContent, cell(LAST, "date").textContent].join("|") === "PSA 10|500|2026-08-01",
        [cell(LAST,"grade").textContent, cell(LAST,"cost").textContent, cell(LAST,"date").textContent].join("|"));
  check("paste spilled onto the new row", cell(LAST + 1, "grade").textContent === "PSA 9", cell(LAST + 1, "grade").textContent);
  check("status reported the paste", /Pasted 2×3/.test($("chaseStatus").textContent), $("chaseStatus").textContent);

  // ── a single-value paste stays in its cell ──
  const one = cell(0, "grade");
  one.focus(); fire(one, "focusin");
  const p1 = new window.Event("paste", { bubbles: true, cancelable: true });
  p1.clipboardData = { getData: () => "SGC 8.5" };
  one.dispatchEvent(p1);
  check("single paste not intercepted as a block", rows().length === SEED + 1, String(rows().length));

  // ── Reload published throws local edits away ──
  $("chaseReload").click();
  await wait(300);
  check("reload restores the seeded rows", rows().length === SEED, String(rows().length));
  check("reload clears the grade", !cell(LAST, "grade").textContent, cell(LAST, "grade").textContent);
  check("reload is clean vs published", $("chasePubState").className.includes("ok"), $("chasePubState").textContent);

  // ── clear then reload ──
  $("chaseClear").click();
  await wait(250);
  check("clear empties the table", /Nothing on the chase list yet/.test($("chaseBody").textContent), $("chaseBody").textContent.trim().slice(0, 40));
  check("clear leaves no progress bars", $("chaseSets").innerHTML === "");
  $("chaseReload").click();
  await wait(300);
  check("reload brings it back", rows().length === SEED, String(rows().length));

  // ── sync panel: the token is the only input, and it's shared ──
  // (owner/repo/branch/path are derived now; syncpanel.js covers them in full)
  check("only a token input on the chase panel", $("chaseGhToken") !== null && $("chaseGhOwner") === null && $("chaseGhPath") === null);
  check("target line says where it saves", /docs\/data\/chase\.csv/.test($("chaseGhTarget").textContent), $("chaseGhTarget").textContent);

  window.localStorage.setItem("gy-cards-github-v1", JSON.stringify({ owner: "geraldno20", repo: "cards", branch: "main" }));
  $("chaseGhToken").value = "github_pat_test";
  fire($("chaseGhToken"), "change");
  const shared = JSON.parse(window.localStorage.getItem("gy-cards-github-v1"));
  check("token shared with the ledger", shared.token === "github_pat_test", JSON.stringify(shared));
  check("owner and repo in shared config untouched", shared.owner === "geraldno20" && shared.repo === "cards", JSON.stringify(shared));

  // ── publish refuses without credentials, doesn't throw ──
  window.localStorage.setItem("gy-cards-github-v1", JSON.stringify({ owner: "geraldno20", repo: "cards", branch: "main" }));
  $("chaseGhToken").value = "";
  fire($("chaseGhToken"), "change");
  $("chasePublish").click();
  await wait(50);
  check("publish without a token explains itself", /token/i.test($("chaseStatus").textContent), $("chaseStatus").textContent);
  check("publish button re-enabled", $("chasePublish").disabled === false);

  console.log(fails ? `\n${fails} FAILURE(S)` : "\nall interaction checks passed");
  process.exit(fails ? 1 : 0);
})();
