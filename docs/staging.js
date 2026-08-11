// Staging — where scanned or batch-entered cards wait until they're clean
// enough to go in the ledger.
//
// Called Staging rather than "holding area" because Holdings already means
// something in the ledger: unsold cards.
//
// A batch is a set of cards that arrived together for one amount of money — a
// card-show pickup, an eBay lot, a photo with six cards in it. The amount is
// split across the batch to exact cents; re-weighting it is the whole point of
// the cleanup step, since an even split is nearly always wrong for value.
//
// Sales are the delicate part. This ledger keeps one row per card with Purchase
// and Sold side by side, so a sale has to land on the row that recorded the
// buy — see the ledger's recordSale. Staging shows which holding each sale will
// update before you submit anything.
(function () {
"use strict";

const STAGE_KEY = "gy-cards-staging-v1";
const SHARED_GH_KEY = "gy-cards-github-v1";
const PUBLISHED_PATH = "data/staging.csv";
const AUTO_PUBLISH_DELAY = 2000;

let publishedCsv = null;

const COLUMNS = [
  { key: "photo",        label: "",       type: "photo" },
  { key: "kind",         label: "Kind",   type: "kind" },
  { key: "batch",        label: "Batch",  type: "batch" },
  { key: "sport",        label: "Sport" },
  { key: "year",         label: "Year" },
  { key: "manufacturer", label: "Manufacturer" },
  { key: "athlete",      label: "Athlete" },
  { key: "number",       label: "Number" },
  { key: "description",  label: "Description" },
  { key: "grade",        label: "Grade" },
  { key: "certNo",       label: "Certification No." },
  { key: "date",         label: "Date", type: "date" },
  { key: "party",        label: "From / To" },
  { key: "amount",       label: "Amount", type: "money" },
  { key: "match",        label: "Goes to", type: "match" },
];

const EDITABLE = COLUMNS.filter(c => !["match", "photo"].includes(c.key));
const TEXT_COLS = EDITABLE.filter(c => !["kind", "batch"].includes(c.key));
const CSV_COLS = COLUMNS.filter(c => !["match", "photo"].includes(c.key));
const CARD_KEYS = ["sport", "year", "manufacturer", "athlete", "number", "description", "grade", "certNo"];

let rows = [];
let view = [];
let saveTimer = null;
let autoTimer = null;
let syncing = false;
let pubBusy = false;
let nextId = 1;
let nextBatch = 1;
let editBefore = null;
let matchCache = new Map();   // row id -> resolved candidates, rebuilt each render

// ───────────────────────── helpers ─────────────────────────

const $ = id => document.getElementById(id);

function esc(s) {
  return String(s === null || s === undefined ? "" : s).replace(/[&<>"']/g, ch => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[ch]));
}

function num(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/[$,\s]/g, "").replace(/[()]/g, "");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function fmtMoney(n) {
  if (n === null || n === undefined) return "";
  return (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

// The ledger's own rows are m/d/yyyy; staging edits in yyyy-mm-dd.
function toLedgerDate(v) {
  const s = String(v || "").trim();
  const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) return s;
  return `${+m[2]}/${+m[3]}/${m[1]}`;
}

const isSell = r => r.kind === "sell";

// ───────────────────────── splitting ─────────────────────────

// Splits a total into n parts that add back up to it exactly. 100 across 3 is
// 33.34 / 33.33 / 33.33, not three lots of 33.33 that lose a cent.
function splitCents(total, n) {
  const cents = Math.round(Number(total) * 100);
  if (!Number.isFinite(cents) || n <= 0) return [];
  const base = Math.floor(Math.abs(cents) / n);
  let rem = Math.abs(cents) - base * n;
  const sign = cents < 0 ? -1 : 1;
  return Array.from({ length: n }, () => {
    const extra = rem > 0 ? 1 : 0;
    if (rem > 0) rem--;
    return ((base + extra) * sign) / 100;
  });
}

function batchIds() {
  const seen = [];
  for (const r of rows) {
    const b = String(r.batch || "").trim();
    if (b && !seen.includes(b)) seen.push(b);
  }
  return seen;
}

const batchRows = b => rows.filter(r => String(r.batch || "").trim() === String(b));

// What the batch says it cost, versus what its rows currently add up to.
function batchTotals(b) {
  const list = batchRows(b);
  const stated = num(list.find(r => r.batchTotal)?.batchTotal);
  const sum = list.reduce((a, r) => a + (num(r.amount) || 0), 0);
  return { list, stated, sum, balanced: stated === null || Math.abs(stated - sum) < 0.005 };
}

function respreadBatch(b) {
  const { list, stated } = batchTotals(b);
  if (stated === null || !list.length) return;
  const parts = splitCents(stated, list.length);
  list.forEach((r, i) => { r.amount = parts[i].toFixed(2); });
}

// ───────────────────────── storage ─────────────────────────

function blankRow(fields = {}) {
  const r = { id: nextId++, kind: "buy", batch: "", batchTotal: "", matchKey: "", soldNew: false, photoId: "" };
  for (const c of TEXT_COLS) r[c.key] = "";
  return Object.assign(r, fields);
}

function normalizeRow(raw) {
  const r = blankRow();
  r.kind = raw.kind === "sell" ? "sell" : "buy";
  r.batch = raw.batch == null ? "" : String(raw.batch).trim();
  r.batchTotal = raw.batchTotal == null ? "" : String(raw.batchTotal).trim();
  r.matchKey = raw.matchKey == null ? "" : String(raw.matchKey).trim();
  r.soldNew = raw.soldNew === true || raw.soldNew === "yes";
  r.photoId = raw.photoId == null ? "" : String(raw.photoId);
  for (const c of TEXT_COLS) r[c.key] = raw[c.key] == null ? "" : String(raw[c.key]).trim();
  return r;
}

function load() {
  try {
    const stored = JSON.parse(localStorage.getItem(STAGE_KEY) || "null");
    if (Array.isArray(stored)) return stored.map(normalizeRow);
  } catch (err) {
    console.warn("Could not read staged rows:", err);
  }
  return null;
}

function writeNow(quiet = false) {
  try {
    localStorage.setItem(STAGE_KEY, JSON.stringify(rows.map(r => {
      const out = { kind: r.kind };
      if (r.batch) out.batch = r.batch;
      if (r.batchTotal) out.batchTotal = r.batchTotal;
      if (r.matchKey) out.matchKey = r.matchKey;
      if (r.soldNew) out.soldNew = true;
      if (r.photoId) out.photoId = r.photoId;   // localStorage only; the CSV has no images
      for (const c of TEXT_COLS) if (r[c.key]) out[c.key] = r[c.key];
      return out;
    })));
    if (!quiet) setStatus(`Saved · ${rows.length} card${rows.length === 1 ? "" : "s"} staged`);
  } catch (err) {
    setStatus(`Could not save: ${err.message}`, true);
  }
  updatePubState();
  queueAutoPublish();
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveTimer = null; writeNow(); }, 200);
}

function saveQuiet() {
  clearTimeout(saveTimer);
  saveTimer = null;
  writeNow(true);
}

function flushSave() {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  writeNow(true);
}

// ───────────────────────── photos ─────────────────────────

// Thumbnails live in IndexedDB, not localStorage: a phone photo is 2–4MB and
// localStorage tops out around 5MB for everything this app stores. They're also
// deliberately never published — the repo is public, and the CSV carries only
// the id. A haul scanned on the phone therefore arrives on the laptop as rows
// without pictures, so do the looking-at-cards part on the device that took them.
const PHOTO_DB = "gy-cards-photos";
const PHOTO_STORE = "thumbs";
const THUMB_MAX = 220;
let photoDbPromise = null;
const thumbCache = new Map();   // photoId -> dataURL, so a render doesn't re-hit the DB

function photoDb() {
  if (photoDbPromise) return photoDbPromise;
  photoDbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") { reject(new Error("no IndexedDB")); return; }
    const req = indexedDB.open(PHOTO_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(PHOTO_STORE)) db.createObjectStore(PHOTO_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("IndexedDB refused to open"));
  }).catch(err => { photoDbPromise = null; throw err; });
  return photoDbPromise;
}

function photoPut(id, dataUrl) {
  thumbCache.set(id, dataUrl);
  return photoDb().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(PHOTO_STORE, "readwrite");
    tx.objectStore(PHOTO_STORE).put(dataUrl, id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  })).catch(() => {});   // a thumbnail is a convenience; never fail a row over it
}

function photoGet(id) {
  if (thumbCache.has(id)) return Promise.resolve(thumbCache.get(id));
  return photoDb().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(PHOTO_STORE, "readonly");
    const req = tx.objectStore(PHOTO_STORE).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  })).then(v => { if (v) thumbCache.set(id, v); return v; }).catch(() => null);
}

// Only drop a photo once no staged row still points at it — several rows share
// one image when a single shot held several cards.
function photoRelease(ids) {
  const stillUsed = new Set(rows.map(r => r.photoId).filter(Boolean));
  const orphans = [...new Set(ids)].filter(id => id && !stillUsed.has(id));
  if (!orphans.length) return Promise.resolve();
  orphans.forEach(id => thumbCache.delete(id));
  return photoDb().then(db => new Promise(resolve => {
    const tx = db.transaction(PHOTO_STORE, "readwrite");
    for (const id of orphans) tx.objectStore(PHOTO_STORE).delete(id);
    tx.oncomplete = resolve;
    tx.onerror = resolve;
  })).catch(() => {});
}

// Shrinks a camera photo to something a table cell can show and a browser can
// keep. imageOrientation lets Safari apply the EXIF rotation, so cards held
// sideways don't come out sideways.
async function makeThumb(file) {
  if (typeof createImageBitmap !== "function" || typeof document.createElement("canvas").getContext !== "function") return null;
  let bmp;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch (err) {
    try { bmp = await createImageBitmap(file); } catch (err2) { return null; }
  }
  const scale = Math.min(1, THUMB_MAX / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  try { return canvas.toDataURL("image/jpeg", 0.7); } catch (err) { return null; }
}

let photoSeq = 0;
const newPhotoId = () => `p${Date.now().toString(36)}${(photoSeq++).toString(36)}`;

// ───────────────────────── the recognizer seam ─────────────────────────
//
// Nothing here knows how a card gets identified. Register one and staged rows
// get prefilled from the photo; register nothing and you type into rows that
// already have the picture attached, which is the same workflow minus the
// guessing.
//
//   window.cardRecognizer = async (file) => ([
//     { sport, year, manufacturer, athlete, number, description, grade, confidence }
//   ])
//
// One entry per card found in that image, best first. Every field is optional —
// return what you're sure of. `confidence` is 0..1 and only used for display.
async function recognizePhoto(file) {
  const fn = window.cardRecognizer;
  if (typeof fn !== "function") return [];
  try {
    const out = await Promise.race([
      Promise.resolve(fn(file)),
      new Promise(resolve => setTimeout(() => resolve("timeout"), 20000)),
    ]);
    if (out === "timeout") { setStatus("The card recognizer took too long — rows are staged blank.", true); return null; }
    return Array.isArray(out) ? out : [];
  } catch (err) {
    setStatus(`The card recognizer failed (${err.message}) — rows are staged blank, nothing is lost.`, true);
    return null;
  }
}

// ───────────────────────── CSV ─────────────────────────

function parseCSV(text) {
  const out = [];
  let row = [];
  let field = "";
  let quoted = false;
  const src = String(text).replace(/\r\n?/g, "\n");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === ",") { row.push(field); field = ""; continue; }
    if (ch === "\n") { row.push(field); out.push(row); row = []; field = ""; continue; }
    field += ch;
  }
  row.push(field);
  out.push(row);
  if (out.length > 1 && out[out.length - 1].length === 1 && out[out.length - 1][0] === "") out.pop();
  return out.filter(r => r.some(c => String(c).trim() !== ""));
}

function toCSV() {
  const escField = v => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = CSV_COLS.map(c => c.label).concat(["Batch Total", "Sold As New"]);
  const lines = [head.map(escField).join(",")];
  for (const r of rows) {
    lines.push(CSV_COLS.map(c => escField(r[c.key]))
      .concat([escField(r.batchTotal), r.soldNew ? "yes" : ""])
      .join(","));
  }
  return lines.join("\n") + "\n";
}

function importCSV(text) {
  const table = parseCSV(text);
  if (table.length < 2) return 0;
  const header = table[0].map(h => String(h).trim().toLowerCase());
  const idx = name => header.indexOf(name.toLowerCase());
  const added = [];
  for (const line of table.slice(1)) {
    const at = name => {
      const i = idx(name);
      return i >= 0 && i < line.length ? String(line[i]).trim() : "";
    };
    const r = blankRow();
    r.kind = at("Kind").toLowerCase() === "sell" ? "sell" : "buy";
    r.batch = at("Batch");
    r.batchTotal = at("Batch Total");
    r.soldNew = /^y/i.test(at("Sold As New"));
    for (const c of TEXT_COLS) r[c.key] = at(c.label);
    if (!CARD_KEYS.some(k => r[k]) && !r.amount) continue;
    added.push(r);
  }
  rows = rows.concat(added);
  const used = added.map(r => Number(String(r.batch).replace(/\D/g, ""))).filter(Number.isFinite);
  if (used.length) nextBatch = Math.max(nextBatch, Math.max(...used) + 1);
  return added.length;
}

// ───────────────────────── matching a sale to a holding ─────────────────────────

// Ledger row ids are handed out at load time, so they mean nothing between
// sessions — a chosen holding is remembered by card identity and resolved fresh
// on every render.
const holdingKey = r => [r.athlete, r.manufacturer, r.number, r.year]
  .map(v => String(v || "").trim().toLowerCase()).join("|");

function resolveMatches() {
  matchCache = new Map();
  const L = window.cardsLedger;
  if (!L) return;
  for (const r of rows) {
    if (!isSell(r)) continue;
    const candidates = L.findHoldingCandidates(r);
    let chosen = null;
    if (r.matchKey) chosen = candidates.find(c => holdingKey(c) === r.matchKey) || null;
    matchCache.set(r.id, { candidates, chosen: chosen || candidates[0] || null, pinned: !!chosen });
  }
}

const matchFor = r => matchCache.get(r.id) || { candidates: [], chosen: null, pinned: false };

// ───────────────────────── validation ─────────────────────────

// What still has to be true before a batch can be handed to the ledger.
function rowProblems(r) {
  const out = [];
  if (num(r.amount) === null) out.push("no amount");
  if (!String(r.athlete || "").trim()) out.push("no player");
  if (isSell(r)) {
    const m = matchFor(r);
    if (!m.chosen && !r.soldNew) out.push("no holding matched");
  }
  return out;
}

function batchProblems(b) {
  const { list, stated, sum, balanced } = batchTotals(b);
  const out = [];
  for (const r of list) {
    for (const p of rowProblems(r)) out.push(`${r.athlete || "a row"}: ${p}`);
  }
  if (!balanced) out.push(`the amounts add to ${fmtMoney(sum)}, not the ${fmtMoney(stated)} for this batch`);
  return out;
}

// ───────────────────────── rendering ─────────────────────────

function setStatus(msg, bad = false) {
  const el = $("stageStatus");
  if (el) el.innerHTML = bad ? `<span class="miss">${esc(msg)}</span>` : esc(msg);
}

function updatePubState() {
  const el = $("stagePubState");
  if (!el) return;
  if (pubBusy) { el.textContent = "⟳ saving to GitHub…"; el.className = "tx-pubstate busy"; return; }
  if (publishedCsv === null) { el.textContent = ""; el.className = "tx-pubstate"; return; }
  if (toCSV().trim() === publishedCsv.trim()) {
    el.textContent = "✓ saved to GitHub";
    el.className = "tx-pubstate ok";
  } else if (autoPublishReady()) {
    el.textContent = "● saving shortly…";
    el.className = "tx-pubstate dirty";
  } else {
    el.textContent = "● in this browser only — add a GitHub token to sync";
    el.className = "tx-pubstate dirty";
  }
}

function cellHtml(r, c) {
  if (c.key === "photo") {
    if (!r.photoId) return `<td class="stage-photo empty"></td>`;
    const cached = thumbCache.get(r.photoId);
    return `<td class="stage-photo" data-photo="${esc(r.photoId)}">${
      cached ? `<img src="${esc(cached)}" alt="Photo of this card" loading="lazy">` : `<span class="ph">…</span>`
    }</td>`;
  }
  if (c.key === "kind") {
    return `<td class="stage-kind"><select data-key="kind" aria-label="Buy or sell">
      <option value="buy"${r.kind === "buy" ? " selected" : ""}>Buy</option>
      <option value="sell"${r.kind === "sell" ? " selected" : ""}>Sell</option>
    </select></td>`;
  }
  if (c.key === "batch") {
    return `<td class="stage-batch">${esc(r.batch)}</td>`;
  }
  if (c.key === "match") {
    if (!isSell(r)) return `<td class="stage-match muted">new row</td>`;
    const m = matchFor(r);
    if (!m.chosen) {
      return `<td class="stage-match ${r.soldNew ? "warn" : "bad"}">${
        r.soldNew ? "sold-only row" : "no holding found"
      }</td>`;
    }
    const label = [m.chosen.year, m.chosen.manufacturer, m.chosen.description].filter(Boolean).join(" ");
    const more = m.candidates.length > 1 ? ` <span class="n">+${m.candidates.length - 1}</span>` : "";
    return `<td class="stage-match ok" title="${esc(label)}">${esc(label || "a holding")}${more}</td>`;
  }
  const cls = ["stage-cell", `stage-${c.key}`];
  if (c.type === "money") cls.push("num");
  const shown = c.type === "money" ? (num(r[c.key]) === null ? r[c.key] || "" : fmtMoney(num(r[c.key]))) : r[c.key] || "";
  return `<td class="${cls.join(" ")}" data-key="${c.key}" contenteditable="plaintext-only">${esc(shown)}</td>`;
}

function groupHtml(batch) {
  if (!batch) {
    const loose = rows.filter(r => !String(r.batch || "").trim());
    const problems = loose.flatMap(r => rowProblems(r));
    return `<strong>Loose rows</strong> · ${loose.length}`
      + (problems.length
        ? ` <span class="bad">· ${problems.length} thing${problems.length === 1 ? "" : "s"} to fix</span>`
        : ` <span class="ok">· ready</span>`)
      + ` <button class="stage-submit-one primary" data-batch=""${problems.length || !loose.length ? " disabled" : ""}>Submit these</button>`;
  }
  const { list, stated, sum, balanced } = batchTotals(batch);
  const problems = batchProblems(batch);
  return `<strong>${esc(batch)}</strong> · ${list.length} card${list.length === 1 ? "" : "s"}`
    + (stated !== null ? ` · stated ${fmtMoney(stated)}` : "")
    + ` · amounts ${fmtMoney(sum)}`
    + (balanced ? ` <span class="ok">✓</span>` : ` <span class="bad">✗ off by ${fmtMoney(Math.abs((stated || 0) - sum))}</span>`)
    + (problems.length
      ? ` <span class="bad">· ${problems.length} thing${problems.length === 1 ? "" : "s"} to fix</span>`
      : ` <span class="ok">· ready</span>`)
    + ` <button class="stage-respread" data-batch="${esc(batch)}" title="Split the stated total evenly across this batch again">Re-split evenly</button>`
    + ` <button class="stage-submit-one primary" data-batch="${esc(batch)}"${problems.length ? " disabled" : ""}>Submit batch</button>`;
}

// Batches with nothing left to fix, "" meaning the loose rows.
function readyBatches() {
  const out = batchIds().filter(b => batchRows(b).length && !batchProblems(b).length);
  const loose = rows.filter(r => !String(r.batch || "").trim());
  if (loose.length && !loose.flatMap(rowProblems).length) out.push("");
  return out;
}

function render() {
  const body = $("stageBody");
  if (!body) return;
  resolveMatches();
  view = rows.slice();
  const batches = batchIds();
  const loose = rows.filter(r => !String(r.batch || "").trim());
  const chunks = [];
  for (const b of batches) chunks.push({ batch: b, list: batchRows(b) });
  if (loose.length) chunks.push({ batch: "", list: loose });

  body.innerHTML = chunks.map(({ batch, list }) => {
    const headCells = `<td class="stage-groupcell" data-batch="${esc(batch)}" colspan="${COLUMNS.length + 1}">${groupHtml(batch)}</td>`;
    const rowsHtml = list.map(r => {
      const probs = rowProblems(r);
      return `<tr data-id="${r.id}"${probs.length ? ' class="stage-problem"' : ""} title="${esc(probs.join("; "))}">
        ${COLUMNS.map(c => cellHtml(r, c)).join("")}
        <td class="tx-actions">
          <button class="stage-pick" title="Choose which holding this sale closes">⇄</button>
          <button class="tx-del" title="Remove from staging" aria-label="Remove from staging">✕</button>
        </td>
      </tr>`;
    }).join("");
    return `<tr class="stage-group">${headCells}</tr>${rowsHtml}`;
  }).join("");

  if (!rows.length) {
    body.innerHTML = `<tr><td class="tx-empty" colspan="${COLUMNS.length + 1}">Nothing staged. Hit “Add batch” for a show pickup or an eBay lot.</td></tr>`;
  }
  fillThumbs();
  renderTotals();
  const count = $("stageCount");
  if (count) count.textContent = rows.length ? `${rows.length} staged` : "";
  const submitAll = $("stageSubmit");
  if (submitAll) submitAll.disabled = !readyBatches().length;
}

// Rebuilding the table while you're typing would take the caret with it — and
// worse, a full re-render on blur destroys the Submit button under the very
// click that blurred the cell. So everything derived (batch sums, readiness,
// the match column, tiles) refreshes in place, and a full render is kept for
// structural changes: rows added or removed, kind switched, a batch submitted.
function refreshGroups() {
  const body = $("stageBody");
  if (!body) return;
  resolveMatches();
  for (const groupCell of body.querySelectorAll(".stage-groupcell[data-batch]")) {
    groupCell.innerHTML = groupHtml(groupCell.dataset.batch);
  }
  for (const tr of body.querySelectorAll("tr[data-id]")) {
    const r = rowById(tr.dataset.id);
    if (!r) continue;
    const probs = rowProblems(r);
    tr.classList.toggle("stage-problem", probs.length > 0);
    tr.title = probs.join("; ");
    const matchTd = tr.querySelector("td.stage-match");
    if (matchTd) matchTd.outerHTML = cellHtml(r, { key: "match", type: "match" });
  }
  renderTotals();
  const submitAll = $("stageSubmit");
  if (submitAll) submitAll.disabled = !readyBatches().length;
}

// Thumbnails arrive from IndexedDB after the table is already on screen.
function fillThumbs() {
  const body = $("stageBody");
  if (!body) return;
  for (const td of body.querySelectorAll("td.stage-photo[data-photo]")) {
    if (td.querySelector("img")) continue;
    const id = td.dataset.photo;
    photoGet(id).then(url => {
      if (!url || !td.isConnected) return;
      td.innerHTML = `<img src="${esc(url)}" alt="Photo of this card" loading="lazy">`;
    });
  }
}

function renderTotals() {
  const el = $("stageTotals");
  if (!el) return;
  const buys = rows.filter(r => !isSell(r));
  const sells = rows.filter(isSell);
  const sum = list => list.reduce((a, r) => a + (num(r.amount) || 0), 0);
  const ready = batchIds().filter(b => !batchProblems(b).length).length;
  const tiles = [
    ["Staged", `${rows.length}`, ""],
    ["Batches", `${batchIds().length}`, ""],
    ["Buys", `${buys.length} · ${fmtMoney(sum(buys))}`, ""],
    ["Sells", `${sells.length} · ${fmtMoney(sum(sells))}`, ""],
    ["Batches ready", `${ready}`, ready ? "pos" : ""],
    ["Needs a look", `${rows.filter(r => rowProblems(r).length).length}`, ""],
  ];
  el.innerHTML = tiles.map(([label, value, cls]) =>
    `<div class="tx-tile"><span class="tx-tile-label">${label}</span><span class="tx-tile-value ${cls}">${value}</span></div>`
  ).join("");
}

function buildHead() {
  const head = $("stageHeadRow");
  if (!head) return;
  head.innerHTML = COLUMNS.map(c => `<th class="stage-${c.key}">${esc(c.label)}</th>`).join("") + "<th></th>";
}

// ───────────────────────── submitting ─────────────────────────

function submitBatch(batch) {
  flushSave();                 // so no pending "Saved · N" lands on top of the report
  const L = window.cardsLedger;
  if (!L) { setStatus("The ledger isn't loaded, so there's nowhere to submit to.", true); return null; }
  const list = batch ? batchRows(batch) : rows.filter(r => !String(r.batch || "").trim());
  if (!list.length) return null;
  const problems = batch ? batchProblems(batch) : list.flatMap(r => rowProblems(r));
  if (problems.length) {
    setStatus(`${batch || "Loose rows"} not submitted — ${problems.join("; ")}.`, true);
    return null;
  }

  const done = [];
  const failed = [];
  for (const r of list) {
    const card = {};
    for (const k of CARD_KEYS) card[k] = r[k];
    if (isSell(r)) {
      const m = matchFor(r);
      if (m.chosen) {
        const res = L.recordSale(m.chosen.id, { soldDate: toLedgerDate(r.date), soldPrice: r.amount });
        if (res.ok) done.push(r);
        else failed.push(`${r.athlete}: ${res.reason}`);
      } else {
        // Deliberately a sold-only row: nothing in the ledger matched, and you
        // said to add it anyway.
        L.addPurchase({ ...card, soldDate: toLedgerDate(r.date), soldPrice: r.amount });
        done.push(r);
      }
    } else {
      L.addPurchase({
        ...card,
        purchaseDate: toLedgerDate(r.date),
        purchaseFrom: r.party,
        purchasePrice: r.amount,
      });
      done.push(r);
    }
  }

  const ids = new Set(done.map(r => r.id));
  const photos = done.map(r => r.photoId);
  rows = rows.filter(r => !ids.has(r.id));
  photoRelease(photos);          // the ledger has nowhere to keep an image
  saveQuiet();
  render();
  return { submitted: done.length, failed };
}

function submitAllReady() {
  flushSave();
  const targets = readyBatches();
  if (!targets.length) { setStatus("No batch is ready yet — the row tooltips say what's missing.", true); return; }
  let submitted = 0;
  const failed = [];
  for (const b of targets) {
    const res = submitBatch(b);
    if (!res) continue;
    submitted += res.submitted;
    failed.push(...res.failed);
  }
  const dirty = window.cardsLedger?.hasUnpublishedChanges();
  setStatus(`Submitted ${submitted} card${submitted === 1 ? "" : "s"} to the ledger.`
    + (failed.length ? ` ${failed.length} didn't go: ${failed.join("; ")}.` : "")
    + (dirty ? " The ledger publishes by hand — hit Save to GitHub on the Transactions tab." : ""));
}

// ───────────────────────── GitHub sync ─────────────────────────

const GH_FALLBACK = { owner: "geraldno20", repo: "cards" };

function ghDetect() {
  const host = location.hostname || "";
  const seg = location.pathname.split("/").filter(Boolean);
  if (host.endsWith("github.io")) return { owner: host.split(".")[0], repo: seg[0] || "" };
  return { ...GH_FALLBACK };
}

function readJson(key) {
  try { return JSON.parse(localStorage.getItem(key) || "{}") || {}; } catch (err) { return {}; }
}

function ghConfig() {
  const shared = readJson(SHARED_GH_KEY);
  const auto = ghDetect();
  return {
    owner: shared.owner || auto.owner || "",
    repo: shared.repo || auto.repo || "",
    branch: shared.branch || "main",
    path: `docs/${PUBLISHED_PATH}`,
    token: shared.token || "",
  };
}

function autoPublishReady() {
  const cfg = ghConfig();
  return !!(cfg.owner && cfg.repo && cfg.token);
}

function queueAutoPublish() {
  if (syncing || !autoPublishReady()) return;
  if (publishedCsv !== null && toCSV().trim() === publishedCsv.trim()) return;
  clearTimeout(autoTimer);
  autoTimer = setTimeout(() => { autoTimer = null; ghPublish(); }, AUTO_PUBLISH_DELAY);
}

function toBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}

async function ghMessage(res) {
  try {
    const j = await res.json();
    return j.message || res.statusText;
  } catch (err) {
    return res.statusText;
  }
}

// GitHub's status codes are all "no" with very different fixes, and the raw
// number sends you to the wrong place: 401 is the token, 403 is its permissions.
function ghExplain(status, message) {
  const detail = message ? ` (${message})` : "";
  if (status === 401) {
    return `the token isn't valid${detail}. It's expired, been revoked, or a character is missing — `
      + `make a fresh fine-grained token and paste it in again.`;
  }
  if (status === 403) {
    return `the token is valid but isn't allowed to write here${detail}. On GitHub, the token needs `
      + `Repository access set to this repo specifically, and Permissions → Contents set to `
      + `"Read and write" — the default "Public repositories" option is read-only.`;
  }
  if (status === 404) {
    return `this token can't see that file${detail}. Usually the same permission problem as a 403, `
      + `or the repo name doesn't match.`;
  }
  return `${status}${detail}`;
}

async function ghPublish() {
  const cfg = ghConfig();
  if (!cfg.owner || !cfg.repo || !cfg.token) return;
  const api = `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/${cfg.path.split("/").map(encodeURIComponent).join("/")}`;
  const headers = {
    Authorization: `Bearer ${cfg.token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  pubBusy = true;
  updatePubState();
  try {
    let sha;
    const cur = await fetch(`${api}?ref=${encodeURIComponent(cfg.branch)}`, { headers, cache: "no-store" });
    if (cur.ok) sha = (await cur.json()).sha;
    else if (cur.status !== 404) throw new Error(ghExplain(cur.status, await ghMessage(cur)));
    const body = { message: `Update staging (${rows.length} cards)`, content: toBase64(toCSV()), branch: cfg.branch };
    if (sha) body.sha = sha;
    const put = await fetch(api, { method: "PUT", headers, body: JSON.stringify(body) });
    if (!put.ok) throw new Error(ghExplain(put.status, await ghMessage(put)));
    publishedCsv = toCSV();
  } catch (err) {
    setStatus(`Staging didn't reach GitHub: ${err.message} — it's still saved in this browser.`, true);
  } finally {
    pubBusy = false;
    updatePubState();
  }
}

function loadPublished() {
  if (typeof fetch !== "function") { render(); return; }
  let req;
  try { req = fetch(PUBLISHED_PATH, { cache: "no-store" }); } catch (err) { render(); return; }
  req
    .then(r => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
    .then(text => {
      publishedCsv = text;
      // Staging is a queue, not a record: whatever's here locally is what you
      // were working on, and the published copy only fills an empty one.
      if (!rows.length) {
        syncing = true;
        const added = importCSV(text);
        syncing = false;
        render();
        saveQuiet();
        if (added) setStatus(`${added} staged card${added === 1 ? "" : "s"} picked up from the published queue.`);
        else setStatus("Nothing staged. Hit “Add batch” for a show pickup or an eBay lot.");
      } else {
        render();
      }
      updatePubState();
    })
    .catch(() => { render(); });
}

// ───────────────────────── wiring ─────────────────────────

function initStaging() {
  const body = $("stageBody");
  if (!body) return;
  buildHead();

  window.addEventListener("pagehide", flushSave);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushSave();
  });

  const stored = load();
  if (stored && stored.length) {
    rows = stored;
    const used = rows.map(r => Number(String(r.batch).replace(/\D/g, ""))).filter(Number.isFinite);
    if (used.length) nextBatch = Math.max(...used) + 1;
    render();
  }

  // ── cell editing ──
  body.addEventListener("focusin", e => {
    const td = e.target.closest("td.stage-cell");
    if (td) editBefore = td.textContent;
  });

  body.addEventListener("input", e => {
    const td = e.target.closest("td.stage-cell");
    if (!td) return;
    const r = rowById(td.closest("tr").dataset.id);
    if (!r) return;
    r[td.dataset.key] = td.textContent.trim();
    refreshGroups();
    save();
  });

  body.addEventListener("keydown", e => {
    const td = e.target.closest("td.stage-cell");
    if (!td) return;
    if (e.key === "Enter" || e.key === "Escape") {
      e.preventDefault();
      if (e.key === "Escape" && editBefore !== null) {
        td.textContent = editBefore;
        const r = rowById(td.closest("tr").dataset.id);
        if (r) r[td.dataset.key] = editBefore.trim();
      }
      td.blur();
      save();
      refreshGroups();
    }
  });

  body.addEventListener("blur", e => {
    const td = e.target.closest?.("td.stage-cell");
    if (td) refreshGroups();
  }, true);

  body.addEventListener("change", e => {
    const sel = e.target.closest("select[data-key=kind]");
    if (!sel) return;
    const r = rowById(sel.closest("tr").dataset.id);
    if (!r) return;
    r.kind = sel.value === "sell" ? "sell" : "buy";
    r.matchKey = "";
    r.soldNew = false;
    saveQuiet();
    render();
  });

  body.addEventListener("click", e => {
    const tr = e.target.closest("tr");
    if (e.target.closest(".stage-respread")) {
      respreadBatch(e.target.closest(".stage-respread").dataset.batch);
      saveQuiet();
      render();
      setStatus("Split evenly again across the batch.");
      return;
    }
    if (e.target.closest(".stage-submit-one")) {
      const b = e.target.closest(".stage-submit-one").dataset.batch;
      const res = submitBatch(b);
      if (res) {
        const dirty = window.cardsLedger?.hasUnpublishedChanges();
        setStatus(`Submitted ${res.submitted} card${res.submitted === 1 ? "" : "s"} from ${b} to the ledger.`
          + (res.failed.length ? ` ${res.failed.join("; ")}.` : "")
          + (dirty ? " The ledger publishes by hand — hit Save to GitHub on the Transactions tab." : ""));
      }
      return;
    }
    if (!tr || !tr.dataset.id) return;
    if (e.target.closest(".tx-del")) {
      const gone = rowById(tr.dataset.id);
      rows = rows.filter(r => String(r.id) !== String(tr.dataset.id));
      if (gone) photoRelease([gone.photoId]);
      saveQuiet();
      render();
      return;
    }
    if (e.target.closest("td.stage-photo[data-photo]")) {
      showPhoto(e.target.closest("td.stage-photo").dataset.photo);
      return;
    }
    if (e.target.closest(".stage-pick")) {
      pickHolding(rowById(tr.dataset.id));
    }
  });

  $("stageAdd").addEventListener("click", () => { pendingPhotos = []; openBatchDialog(); });
  const photoInput = $("stagePhotoInput");
  if (photoInput) {
    $("stageScan").addEventListener("click", () => photoInput.click());
    photoInput.addEventListener("change", async e => {
      const files = e.target.files;
      e.target.value = "";                 // so the same photo can be picked twice
      if (files && files.length) await beginCapture(files);
    });
  }
  $("photoDialogClose").addEventListener("click", () => $("photoDialog").close());
  $("stageAddRow").addEventListener("click", () => {
    rows.push(blankRow({ date: todayISO() }));
    saveQuiet();
    render();
  });
  $("stageSubmit").addEventListener("click", submitAllReady);
  $("stageClear").addEventListener("click", () => {
    if (!rows.length) return;
    if (!confirm(`Throw away all ${rows.length} staged card${rows.length === 1 ? "" : "s"}? The ledger isn't touched.`)) return;
    const photos = rows.map(r => r.photoId);
    rows = [];
    photoRelease(photos);
    saveQuiet();
    render();
    setStatus("Staging cleared. Nothing was written to the ledger.");
  });

  // ── the add-batch dialog ──
  const form = $("batchForm");
  if (form) {
    form.addEventListener("submit", e => {
      const count = Math.max(1, Math.min(60, parseInt($("batchCount").value, 10) || 1));
      const total = $("batchTotal").value.trim();
      if (num(total) === null) { e.preventDefault(); $("batchTotal").focus(); return; }
      addBatch({
        count,
        total,
        kind: $("batchKind").value === "sell" ? "sell" : "buy",
        date: $("batchDate").value || todayISO(),
        party: $("batchParty").value.trim(),
      });
      $("batchDialog").close();   // method="dialog" handles this on a real click; be explicit
    });
    $("batchCancel").addEventListener("click", () => {
      const orphans = pendingPhotos.map(p => p.id);
      pendingPhotos = [];
      photoRelease(orphans);               // nothing points at them now
      $("batchDialog").close();
    });
  }

  loadPublished();
}

const rowById = id => rows.find(r => String(r.id) === String(id));

let pendingPhotos = [];   // files chosen but not yet turned into rows

// A photo can hold one card or six, so the count stays yours to set — it just
// starts at however many photos you picked.
async function beginCapture(files) {
  const list = [...files].filter(f => f && (f.type || "").startsWith("image"));
  if (!list.length) { setStatus("No images in that selection.", true); return; }
  setStatus(`Reading ${list.length} photo${list.length === 1 ? "" : "s"}…`);
  pendingPhotos = [];
  for (const file of list) {
    const id = newPhotoId();
    const thumb = await makeThumb(file);
    if (thumb) await photoPut(id, thumb);
    pendingPhotos.push({ id, file, thumb });
  }
  const missing = pendingPhotos.filter(p => !p.thumb).length;
  openBatchDialog({ count: pendingPhotos.length });
  setStatus(missing
    ? `${pendingPhotos.length} photo${pendingPhotos.length === 1 ? "" : "s"} read — ${missing} couldn't be shown as a thumbnail (HEIC on a non-Apple browser does this), but the rows still work.`
    : `${pendingPhotos.length} photo${pendingPhotos.length === 1 ? "" : "s"} ready — say how many cards they hold and what they cost.`);
}

function showPhoto(id) {
  const dlg = $("photoDialog");
  if (!dlg) return;
  photoGet(id).then(url => {
    if (!url) { setStatus("That photo isn't on this device — thumbnails stay where they were taken.", true); return; }
    $("photoDialogImg").src = url;
    dlg.showModal();
  });
}

function openBatchDialog({ count = 1 } = {}) {
  const dlg = $("batchDialog");
  if (!dlg) return;
  $("batchCount").value = String(count);
  $("batchTotal").value = "";
  $("batchKind").value = "buy";
  $("batchDate").value = todayISO();
  $("batchParty").value = window.cardsLedger?.lastUsed("purchaseFrom") || "";
  const note = $("batchPhotoNote");
  if (note) {
    note.hidden = !pendingPhotos.length;
    note.textContent = pendingPhotos.length
      ? `${pendingPhotos.length} photo${pendingPhotos.length === 1 ? "" : "s"} attached. `
        + `More cards than photos and they'll share the picture — a single shot of six cards is fine.`
      : "";
  }
  dlg.showModal();
  $("batchTotal").focus();
}

function addBatch({ count, total, kind, date, party }) {
  const label = `B${nextBatch++}`;
  const parts = splitCents(num(total), count);
  const photos = pendingPhotos.slice();
  pendingPhotos = [];
  const made = [];
  for (let i = 0; i < count; i++) {
    // One photo each while they last, then everyone shares the last one — which
    // is what a single shot of a row of cards means.
    const photo = photos.length ? photos[Math.min(i, photos.length - 1)] : null;
    const r = blankRow({
      kind,
      batch: label,
      batchTotal: String(num(total).toFixed(2)),
      date,
      party,
      amount: parts[i].toFixed(2),
      photoId: photo ? photo.id : "",
    });
    rows.push(r);
    made.push(r);
  }
  saveQuiet();
  render();
  setStatus(`${label}: ${count} card${count === 1 ? "" : "s"} at ${fmtMoney(num(total))} — `
    + `${count > 1 ? `split to ${parts.map(p => fmtMoney(p)).join(" / ")}. ` : ""}`
    + (photos.length ? "Tap a thumbnail to see the card. " : "")
    + "Fill in who's on each card.");
  if (photos.length && typeof window.cardRecognizer === "function") prefillFromPhotos(made, photos, label);
}

// Recognition is an accelerator, not a gate: rows already exist and are usable
// before this runs, and anything it fills is yours to correct.
async function prefillFromPhotos(made, photos, label) {
  setStatus(`${label}: reading the cards…`);
  let filled = 0;
  let broke = false;
  for (const photo of photos) {
    const guesses = await recognizePhoto(photo.file);
    if (guesses === null) { broke = true; continue; }   // it already explained itself
    if (!guesses.length) continue;
    const mine = made.filter(r => r.photoId === photo.id && !CARD_KEYS.some(k => r[k]));
    guesses.slice(0, mine.length).forEach((g, i) => {
      const row = mine[i];
      for (const k of CARD_KEYS) if (g[k]) row[k] = String(g[k]).trim();
      filled++;
    });
  }
  saveQuiet();
  render();
  if (filled) {
    setStatus(`${label}: filled ${filled} card${filled === 1 ? "" : "s"} from the photos — check them, they're guesses.`);
  } else if (!broke) {
    // Don't paper over the recognizer's own error message with a cheerier one.
    setStatus(`${label}: nothing recognized in the photos, so the rows are blank. Type over them.`);
  }
}

// Sales with more than one possible holding, or none, get a chooser.
function pickHolding(r) {
  if (!r) return;
  if (!isSell(r)) { setStatus("Only a sale needs a holding — switch Kind to Sell first."); return; }
  const m = matchFor(r);
  if (!m.candidates.length) {
    const ok = confirm(`Nothing in the ledger looks like ${r.athlete || "this card"}.\n\n`
      + `OK: add it as a sold-only row (no purchase price, so no profit).\nCancel: leave it alone.`);
    if (ok) { r.soldNew = true; saveQuiet(); render(); }
    return;
  }
  const lines = m.candidates.map((c, i) =>
    `${i + 1}. ${[c.year, c.manufacturer, c.description, c.grade && `(${c.grade})`].filter(Boolean).join(" ")}`
    + ` — bought ${c.purchaseDate || "?"} for ${c.purchasePrice || "?"}`).join("\n");
  const answer = prompt(`Which holding does this sale close?\n\n${lines}\n\nType a number:`, "1");
  if (answer === null) return;
  const pick = m.candidates[(parseInt(answer, 10) || 0) - 1];
  if (!pick) return;
  r.matchKey = holdingKey(pick);
  r.soldNew = false;
  saveQuiet();
  render();
}

window.initStaging = initStaging;
})();
