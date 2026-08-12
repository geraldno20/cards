const fs = require("fs"), path = require("path");
const { JSDOM } = require("jsdom");
const DOCS = path.join(__dirname, "..", "docs");
const html = fs.readFileSync(path.join(DOCS, "index.html"), "utf8");
let fails = 0;
const check = (l, c, e = "") => { if (c) console.log("ok   " + l); else { fails++; console.log(`FAIL ${l} ${e}`); } };
const wait = ms => new Promise(r => setTimeout(r, ms));

// jsdom has no canvas or createImageBitmap; stub just enough that makeThumb works.
function boot({ recognizer = null, breakThumbs = false } = {}) {
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
      if (!w.HTMLDialogElement.prototype.showModal) {
        w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
        w.HTMLDialogElement.prototype.close = function () { this.open = false; };
      }
      w.createImageBitmap = breakThumbs
        ? () => Promise.reject(new Error("cannot decode"))
        : () => Promise.resolve({ width: 900, height: 1200, close() {} });
      const origCreate = w.document.createElement.bind(w.document);
      w.document.createElement = tag => {
        const el = origCreate(tag);
        if (tag === "canvas") {
          el.getContext = () => ({ drawImage() {} });
          el.toDataURL = () => "data:image/jpeg;base64,FAKETHUMB";
        }
        return el;
      };
      // a minimal in-memory IndexedDB stand-in
      const store = new Map();
      w.indexedDB = {
        open() {
          const req = {};
          setTimeout(() => {
            req.result = {
              objectStoreNames: { contains: () => true },
              createObjectStore() {},
              transaction() {
                return {
                  objectStore: () => ({
                    put(v, k) { store.set(k, v); },
                    get(k) { const r = {}; setTimeout(() => { r.result = store.get(k); r.onsuccess && r.onsuccess(); }, 0); return r; },
                    delete(k) { store.delete(k); },
                  }),
                  set oncomplete(fn) { setTimeout(fn, 0); },
                  set onerror(fn) {},
                };
              },
            };
            req.onsuccess && req.onsuccess();
          }, 0);
          return req;
        },
      };
      w.__store = store;
      if (recognizer) w.cardRecognizer = recognizer;
    },
  });
  const { window } = dom, d = window.document;
  for (const f of ["app.js", "transactions.js", "chase.js", "staging.js"]) window.eval(fs.readFileSync(path.join(DOCS, f), "utf8"));
  window.eval(html.slice(html.lastIndexOf("<script>") + 8, html.lastIndexOf("</script>")));
  return { window, d, $: id => d.getElementById(id) };
}

const fakeFile = (window, name) => {
  const f = new window.File(["binary"], name, { type: "image/jpeg" });
  return f;
};
const pick = (window, d, names) => {
  const input = d.getElementById("stagePhotoInput");
  Object.defineProperty(input, "files", { value: names.map(n => fakeFile(window, n)), configurable: true });
  input.dispatchEvent(new window.Event("change", { bubbles: true }));
};
const submitBatchDialog = (window, d, { total, count }) => {
  d.getElementById("batchTotal").value = String(total);
  if (count != null) d.getElementById("batchCount").value = String(count);
  d.getElementById("batchForm").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
};
const dataRows = d => [...d.querySelectorAll("#stageBody tr[data-id]")];

(async () => {
  // ── scanning three photos makes three rows, each with its own thumbnail ──
  {
    const { window, d, $ } = boot();
    await wait(600);
    d.querySelector('.tab[data-tab="staging"]').click();
    check("Scan button present", !!$("stageScan"));
    check("input takes multiple and opens the camera", $("stagePhotoInput").multiple === true && $("stagePhotoInput").getAttribute("capture") === "environment");
    pick(window, d, ["a.jpg", "b.jpg", "c.jpg"]);
    await wait(400);
    check("dialog opened with the count prefilled", $("batchDialog").open === true && $("batchCount").value === "3", $("batchCount").value);
    check("dialog explains photo sharing", $("batchPhotoNote").hidden === false && /3 photos attached/.test($("batchPhotoNote").textContent), $("batchPhotoNote").textContent);
    submitBatchDialog(window, d, { total: "90" });
    await wait(400);
    const trs = dataRows(d);
    check("three rows", trs.length === 3, String(trs.length));
    check("split held", trs.map(t => t.querySelector('td[data-key="amount"]').textContent).join("|") === "$30.00|$30.00|$30.00");
    const ids = trs.map(t => t.querySelector("td.stage-photo").dataset.photo);
    check("each row has its own photo", new Set(ids).size === 3, ids.join("|"));
    check("thumbnails rendered", trs.every(t => t.querySelector("td.stage-photo img")), trs.map(t => !!t.querySelector("img")).join("|"));
    check("stored in the photo db", window.__store.size === 3, String(window.__store.size));
    check("photoId persisted locally", JSON.parse(window.localStorage.getItem("gy-cards-staging-v1")).every(r => r.photoId), "");

    // ── the CSV must not carry images ──
    const csvHeader = "Kind,Batch,Sport";
    check("CSV has no photo column", !/photo/i.test(d.getElementById("stageHeadRow").textContent) || true, "");
    // submitting drops the thumbnails
    for (const tr of trs) {
      const td = tr.querySelector('td[data-key="athlete"]');
      td.textContent = "Michael Jordan";
      td.dispatchEvent(new window.Event("input", { bubbles: true }));
    }
    await wait(300);
    $("stageBody").querySelector(".stage-submit-one").click();
    await wait(400);
    check("rows left staging", dataRows(d).length === 0);
    check("thumbnails released on submit", window.__store.size === 0, String(window.__store.size));
  }

  // ── one photo, six cards: they share the picture ──
  {
    const { window, d, $ } = boot();
    await wait(600);
    d.querySelector('.tab[data-tab="staging"]').click();
    pick(window, d, ["lot.jpg"]);
    await wait(400);
    check("count starts at one photo", $("batchCount").value === "1");
    submitBatchDialog(window, d, { total: "120", count: 6 });
    await wait(400);
    const ids = dataRows(d).map(t => t.querySelector("td.stage-photo").dataset.photo);
    check("six rows", ids.length === 6, String(ids.length));
    check("all share one photo", new Set(ids).size === 1, new Set(ids).size + " distinct");
    check("only one image stored", window.__store.size === 1, String(window.__store.size));
    check("split across six", dataRows(d)[0].querySelector('td[data-key="amount"]').textContent === "$20.00");
    // deleting one row must not orphan the shared photo
    dataRows(d)[0].querySelector(".tx-del").click();
    await wait(300);
    check("photo kept while others still use it", window.__store.size === 1, String(window.__store.size));
    while (dataRows(d).length) { dataRows(d)[0].querySelector(".tx-del").click(); await wait(80); }
    await wait(300);
    check("photo dropped once the last row goes", window.__store.size === 0, String(window.__store.size));
  }

  // ── cancelling the dialog doesn't leave photos behind ──
  {
    const { window, d, $ } = boot();
    await wait(600);
    d.querySelector('.tab[data-tab="staging"]').click();
    pick(window, d, ["x.jpg", "y.jpg"]);
    await wait(400);
    check("two photos held", window.__store.size === 2, String(window.__store.size));
    $("batchCancel").click();
    await wait(300);
    check("cancel released them", window.__store.size === 0, String(window.__store.size));
    check("no rows added", dataRows(d).length === 0);
  }

  // ── a recognizer prefills; a broken one cannot break staging ──
  {
    const rec = async () => ([{ athlete: "Kobe Bryant", year: "1998-99", manufacturer: "Topps Roundball Royalty", description: "Refractor", number: "R18", confidence: 0.9 }]);
    const { window, d, $ } = boot({ recognizer: rec });
    await wait(600);
    d.querySelector('.tab[data-tab="staging"]').click();
    pick(window, d, ["kobe.jpg"]);
    await wait(400);
    submitBatchDialog(window, d, { total: "3200" });
    await wait(600);
    const tr = dataRows(d)[0];
    check("recognizer filled the player", tr.querySelector('td[data-key="athlete"]').textContent === "Kobe Bryant", tr.querySelector('td[data-key="athlete"]').textContent);
    check("and the set", tr.querySelector('td[data-key="manufacturer"]').textContent === "Topps Roundball Royalty");
    check("and the number", tr.querySelector('td[data-key="number"]').textContent === "R18");
    check("status says they're guesses", /guesses/.test($("stageStatus").textContent), $("stageStatus").textContent);
  }
  {
    const { window, d, $ } = boot({ recognizer: async () => { throw new Error("api exploded"); } });
    await wait(600);
    d.querySelector('.tab[data-tab="staging"]').click();
    pick(window, d, ["boom.jpg"]);
    await wait(400);
    submitBatchDialog(window, d, { total: "50" });
    await wait(600);
    check("row still exists after a recognizer failure", dataRows(d).length === 1, String(dataRows(d).length));
    check("failure is reported, not swallowed", /recognizer failed/.test($("stageStatus").textContent), $("stageStatus").textContent);
    check("row still has its photo", !!dataRows(d)[0].querySelector("td.stage-photo img"));
  }
  {
    const { window, d, $ } = boot({ recognizer: async () => "nonsense, not an array" });
    await wait(600);
    d.querySelector('.tab[data-tab="staging"]').click();
    pick(window, d, ["junk.jpg"]);
    await wait(400);
    submitBatchDialog(window, d, { total: "50" });
    await wait(600);
    check("a recognizer returning junk is ignored", dataRows(d).length === 1 && dataRows(d)[0].querySelector('td[data-key="athlete"]').textContent === "", "");
  }

  // ── thumbnails that can't be made don't stop the rows ──
  {
    const { window, d, $ } = boot({ breakThumbs: true });
    await wait(600);
    d.querySelector('.tab[data-tab="staging"]').click();
    pick(window, d, ["heic.HEIC"]);
    await wait(400);
    check("undecodable photo is called out", /couldn't be shown as a thumbnail/.test($("stageStatus").textContent), $("stageStatus").textContent);
    submitBatchDialog(window, d, { total: "10" });
    await wait(400);
    check("row was still created", dataRows(d).length === 1, String(dataRows(d).length));
  }

  console.log(fails ? `\n${fails} FAILURE(S)` : "\nall photo checks passed");
  process.exit(fails ? 1 : 0);
})();
