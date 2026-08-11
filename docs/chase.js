// Chase list — a checklist of the cards still being hunted, set by set.
//
// docs/data/chase.csv is the database. Unlike the ledger next door, sets arrive
// here by commit while ticks and costs are typed in the browser, so neither copy
// is simply the newer one: on load the published file is taken as the checklist
// of record and whatever you'd filled in is re-applied on top. With a token set,
// an edit commits itself a couple of seconds later, so there's no publish step
// to remember. localStorage is the offline cache, not a second database.
//
// Wrapped in an IIFE because transactions.js is a plain script too, and the two
// share a lot of names (rows, render, COLUMNS…). Only initChase gets out.
(function () {
"use strict";

const CHASE_KEY = "gy-cards-chase-v1";
const CHASE_GH_KEY = "gy-cards-chase-github-v1";   // just the file path
const SHARED_GH_KEY = "gy-cards-github-v1";        // owner/repo/branch/token, shared with the ledger
const PUBLISHED_PATH = "data/chase.csv";
const AUTO_PUBLISH_DELAY = 2000;   // coalesce a burst of ticks into one commit
const TEMPLATE_KEY = "gy-cards-set-templates-v1";

let publishedCsv = null;   // the committed file's contents, to spot unpublished edits

// `alias` entries are lowercased header names accepted on import.
const COLUMNS = [
  { key: "got",    label: "Got",         type: "check", alias: ["acquired", "have", "owned", "done"] },
  { key: "set",    label: "Set",                        alias: ["set name", "product", "manufacturer"] },
  { key: "player", label: "Player",                     alias: ["athlete", "name"] },
  { key: "number", label: "Card Number", type: "id",    alias: ["number", "card no.", "card no", "card #", "#"] },
  { key: "grade",  label: "Grade",                      alias: ["grading"] },
  { key: "cost",   label: "Cost",        type: "money", alias: ["price", "purchase price", "paid"] },
  { key: "date",   label: "Date",        type: "date",  alias: ["purchase date", "date bought", "acquired"] },
];

const TEXT_COLS = COLUMNS.filter(c => c.type !== "check");
const COL_BY_KEY = Object.fromEntries(COLUMNS.map(c => [c.key, c]));
const ORDER = COLUMNS.map(c => c.key);

let rows = [];
let view = [];          // rows currently rendered, in display order
let sortKey = null;     // null keeps checklist order
let sortDir = 1;
let saveTimer = null;
let autoTimer = null;
let syncing = false;    // true while merging or reloading, so nothing auto-commits
let pubBusy = false;    // a commit is in flight
let nextId = 1;
let editBefore = null;  // a cell's value on focus, for Escape

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

function parseDate(v) {
  if (!v) return null;
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]).getTime();
  m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4}|\d{2})/);
  if (m) {
    let y = +m[3];
    if (y < 100) y += y < 70 ? 2000 : 1900;
    return new Date(y, +m[1] - 1, +m[2]).getTime();
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

function fmtMoney(n) {
  if (n === null || n === undefined) return "";
  return (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Sorts R2 before R10 — zero-pad every run of digits so a card number sorts
// the way the checklist is printed rather than alphabetically.
function natKey(v) {
  return String(v || "").toLowerCase().replace(/\d+/g, d => d.padStart(10, "0"));
}

const isGot = r => r.got === true;
const truthy = v => /^(y|yes|true|1|x|✓|got|have)$/i.test(String(v || "").trim());

// ───────────────────────── storage ─────────────────────────

function blankRow() {
  const r = { id: nextId++, got: false };
  for (const c of TEXT_COLS) r[c.key] = "";
  return r;
}

function normalizeRow(raw) {
  const r = { id: nextId++, got: raw.got === true || truthy(raw.got) };
  for (const c of TEXT_COLS) r[c.key] = raw[c.key] == null ? "" : String(raw[c.key]).trim();
  return r;
}

function load() {
  try {
    const stored = JSON.parse(localStorage.getItem(CHASE_KEY) || "null");
    if (Array.isArray(stored)) return stored.map(normalizeRow);
  } catch (err) {
    console.warn("Could not read the saved chase list:", err);
  }
  return null;
}

function writeNow(quiet = false) {
  try {
    localStorage.setItem(CHASE_KEY, JSON.stringify(rows.map(r => {
      const out = {};
      if (r.got) out.got = true;
      for (const c of TEXT_COLS) if (r[c.key]) out[c.key] = r[c.key];
      return out;
    })));
    if (!quiet) setStatus(`Saved · ${rows.length} card${rows.length === 1 ? "" : "s"} on the list`);
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

// Writes straight away without announcing it, for the actions that report
// something more useful than "Saved" — otherwise the debounced save would
// overwrite their summary a fifth of a second later.
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

// ───────────────────────── CSV ─────────────────────────

function detectDelim(text) {
  const firstLine = String(text).split(/\r\n?|\n/)[0] || "";
  return firstLine.includes("\t") ? "\t" : ",";
}

function parseCSV(text, opts = {}) {
  const delim = opts.delim || detectDelim(text);
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
    if (ch === delim) { row.push(field); field = ""; continue; }
    if (ch === "\n") { row.push(field); out.push(row); row = []; field = ""; continue; }
    field += ch;
  }
  row.push(field);
  out.push(row);
  if (out.length > 1 && out[out.length - 1].length === 1 && out[out.length - 1][0] === "") out.pop();
  if (opts.keepEmpty) return out;
  return out.filter(r => r.some(c => String(c).trim() !== ""));
}

function toCSV() {
  const escField = v => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [COLUMNS.map(c => escField(c.label)).join(",")];
  for (const r of rows) {
    lines.push(COLUMNS.map(c => (c.type === "check" ? (r.got ? "yes" : "") : escField(r[c.key]))).join(","));
  }
  return lines.join("\n") + "\n";
}

function mapHeaders(header) {
  const seen = new Set();
  const mapped = header.map(h => {
    const raw = String(h).trim().toLowerCase().replace(/\s+/g, " ");
    if (!raw) return null;
    const hit = COLUMNS.find(c => c.label.toLowerCase() === raw && !seen.has(c.key))
      || COLUMNS.find(c => c.key === raw && !seen.has(c.key))
      || COLUMNS.find(c => (c.alias || []).includes(raw) && !seen.has(c.key));
    if (!hit) return null;
    seen.add(hit.key);
    return hit.key;
  });
  return mapped.filter(Boolean).length >= 2 ? mapped : null;
}

function importRows(text) {
  const table = parseCSV(text);
  if (!table.length) return { added: 0, skipped: 0 };
  let mapping = mapHeaders(table[0]);
  let body = table;
  if (mapping) body = table.slice(1);
  else mapping = ORDER;

  const added = [];
  let skipped = 0;
  for (const line of body) {
    const r = blankRow();
    let filled = false;
    line.forEach((cell, i) => {
      const key = mapping[i];
      if (!key) return;
      const val = String(cell).trim();
      if (!val) return;
      if (key === "got") { r.got = truthy(val); if (r.got) filled = true; return; }
      r[key] = val;
      filled = true;
    });
    if (!filled) { skipped++; continue; }
    added.push(r);
  }
  rows = rows.concat(added);
  saveQuiet();
  render();
  return { added: added.length, skipped };
}

// ───────────────────────── adding a set ─────────────────────────

// One checklist line per row, copied straight off a set list: "R1<tab>Michael
// Jordan", "R1  Michael Jordan", or "R1, Michael Jordan" all work, and the two
// fields are swapped if they arrive the other way round.
function splitChecklistLine(line) {
  const s = line.trim();
  if (!s) return null;
  let parts;
  if (s.includes("\t")) parts = s.split("\t");
  else if (/\s{2,}/.test(s)) parts = s.split(/\s{2,}/);
  else if (s.includes(",")) parts = s.split(",");
  else {
    const m = s.match(/^(\S+)\s+(.*)$/);
    parts = m && looksLikeNumber(m[1]) ? [m[1], m[2]] : ["", s];
  }
  parts = parts.map(p => p.trim());
  let [number, player] = [parts[0] || "", parts.slice(1).join(" ").trim()];
  if (!player) { player = number; number = ""; }
  if (!looksLikeNumber(number) && looksLikeNumber(player)) [number, player] = [player, number];
  return { number, player };
}

function looksLikeNumber(s) {
  const t = String(s || "").trim();
  return !!t && t.length <= 8 && !/\s/.test(t) && /\d/.test(t);
}

function addSet(setName, text) {
  const added = [];
  for (const line of String(text).split(/\r\n?|\n/)) {
    const parsed = splitChecklistLine(line);
    if (!parsed || (!parsed.number && !parsed.player)) continue;
    const r = blankRow();
    r.set = setName;
    r.number = parsed.number;
    r.player = parsed.player;
    added.push(r);
  }
  if (!added.length) return 0;
  rows = rows.concat(added);
  saveQuiet();
  render();
  return added.length;
}

// ───────────────────────── rendering ─────────────────────────

function setStatus(msg, bad = false) {
  const el = $("chaseStatus");
  if (el) el.innerHTML = bad ? `<span class="miss">${esc(msg)}</span>` : esc(msg);
}

function setPubBusy(on) {
  pubBusy = on;
  updatePubState();
}

function updatePubState() {
  const el = $("chasePubState");
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

// Auto-publish needs somewhere to publish to and something to authenticate with.
function autoPublishReady() {
  const cfg = ghConfig();
  return !!(cfg.owner && cfg.repo && cfg.token);
}

function setList() {
  const seen = [];
  for (const r of rows) {
    const s = String(r.set || "").trim();
    if (s && !seen.includes(s)) seen.push(s);
  }
  return seen;
}

function visibleRows() {
  const q = ($("chaseSearch")?.value || "").trim().toLowerCase();
  const status = $("chaseFilter")?.value || "all";
  const set = $("chaseSetFilter")?.value || "all";
  let out = rows.filter(r => {
    if (status === "got" && !isGot(r)) return false;
    if (status === "chasing" && isGot(r)) return false;
    if (set !== "all" && String(r.set || "").trim() !== set) return false;
    if (!q) return true;
    return TEXT_COLS.some(c => String(r[c.key] || "").toLowerCase().includes(q));
  });
  if (sortKey) {
    const col = COL_BY_KEY[sortKey];
    const val = r => {
      if (col.type === "check") return isGot(r) ? 1 : 0;
      if (col.type === "money") return num(r[sortKey]);
      if (col.type === "date") return parseDate(r[sortKey]);
      if (col.type === "id") return natKey(r[sortKey]);
      return String(r[sortKey] || "").toLowerCase();
    };
    out = out.slice().sort((a, b) => {
      const x = val(a), y = val(b);
      const xEmpty = x === null || x === "" || x === undefined;
      const yEmpty = y === null || y === "" || y === undefined;
      if (xEmpty && yEmpty) return 0;
      if (xEmpty) return 1;   // blanks always sink
      if (yEmpty) return -1;
      if (x < y) return -sortDir;
      if (x > y) return sortDir;
      return 0;
    });
  }
  return out;
}

function buildHead() {
  const head = $("chaseHeadRow");
  if (!head) return;
  head.innerHTML = COLUMNS.map(c =>
    `<th class="sortable chase-${c.key}" data-key="${c.key}" title="Sort by ${esc(c.label)}">${esc(c.label)}</th>`
  ).join("") + "<th></th>";
}

function cellHtml(r, c) {
  if (c.type === "check") {
    return `<td class="chase-check"><input type="checkbox" ${r.got ? "checked" : ""} aria-label="Got this card"></td>`;
  }
  const cls = ["chase-cell", `chase-${c.key}`];
  if (c.type === "money") cls.push("num");
  return `<td class="${cls.join(" ")}" data-key="${c.key}" contenteditable="plaintext-only">${esc(r[c.key])}</td>`;
}

function render() {
  const body = $("chaseBody");
  if (!body) return;
  syncSetFilter();
  view = visibleRows();
  body.innerHTML = view.map(r => `
    <tr data-id="${r.id}"${r.got ? ' class="chase-done"' : ""}>
      ${COLUMNS.map(c => cellHtml(r, c)).join("")}
      <td class="tx-actions">
        <button class="chase-buy" title="Log a purchase — ticks Got and writes the ledger row" aria-label="Log a purchase">$</button>
        <button class="tx-dup" title="Duplicate row" aria-label="Duplicate row">⧉</button>
        <button class="tx-del" title="Delete row" aria-label="Delete row">✕</button>
      </td>
    </tr>`).join("");
  if (!view.length) {
    body.innerHTML = `<tr><td class="tx-empty" colspan="${COLUMNS.length + 1}">${
      rows.length ? "No cards match this filter." : "Nothing on the chase list yet — add a set below, or hit “Add row”."
    }</td></tr>`;
  }
  document.querySelectorAll("#chaseTable th.sortable").forEach(th => {
    th.classList.toggle("sorted-asc", th.dataset.key === sortKey && sortDir === 1);
    th.classList.toggle("sorted-desc", th.dataset.key === sortKey && sortDir === -1);
  });
  renderTotals(view);
  renderSetProgress();
  const count = $("chaseCount");
  if (count) count.textContent = view.length === rows.length ? "" : `${view.length} of ${rows.length} shown`;
}

function renderTotals(list) {
  const el = $("chaseTotals");
  if (!el) return;
  const got = list.filter(isGot);
  const spend = got.reduce((a, r) => a + (num(r.cost) || 0), 0);
  const priced = got.filter(r => num(r.cost) !== null).length;
  const tiles = [
    ["On the list", `${list.length}`, ""],
    ["Got", `${got.length}`, got.length ? "pos" : ""],
    ["Still chasing", `${list.length - got.length}`, ""],
    ["Complete", list.length ? `${Math.round((got.length / list.length) * 100)}%` : "—", ""],
    ["Spent", fmtMoney(spend), ""],
    ["Avg cost", priced ? fmtMoney(spend / priced) : "—", ""],
  ];
  el.innerHTML = tiles.map(([label, value, cls]) =>
    `<div class="tx-tile"><span class="tx-tile-label">${label}</span><span class="tx-tile-value ${cls}">${value}</span></div>`
  ).join("");
}

// One progress bar per set, so a half-finished rainbow is obvious at a glance.
function renderSetProgress() {
  const el = $("chaseSets");
  if (!el) return;
  const sets = setList();
  if (sets.length < 1) { el.innerHTML = ""; return; }
  el.innerHTML = sets.map(name => {
    const inSet = rows.filter(r => String(r.set || "").trim() === name);
    const got = inSet.filter(isGot).length;
    const pct = inSet.length ? (got / inSet.length) * 100 : 0;
    const done = got === inSet.length;
    return `
      <div class="chase-prog${done ? " done" : ""}">
        <div class="chase-prog-top">
          <span class="chase-prog-name">${esc(name)}</span>
          <span class="chase-prog-count">${got} / ${inSet.length}${done ? " ✓" : ""}</span>
        </div>
        <div class="chase-prog-bar"><div class="fill" style="width:${pct.toFixed(1)}%"></div></div>
      </div>`;
  }).join("");
}

function syncSetFilter() {
  const sel = $("chaseSetFilter");
  if (!sel) return;
  const sets = setList();
  const want = ["all", ...sets].join(" ");
  if (sel.dataset.sets === want) return;
  const current = sel.value;
  sel.dataset.sets = want;
  sel.innerHTML = `<option value="all">All sets</option>` +
    sets.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join("");
  sel.value = sets.includes(current) ? current : "all";
}

// ───────────────────────── editing ─────────────────────────

const rowById = id => rows.find(r => String(r.id) === String(id));

function cellAt(r, c) {
  const tr = $("chaseBody")?.rows[r];
  const td = tr?.children[c];
  // The class, not isContentEditable: the checkbox and actions columns are the
  // only non-editable ones, and this stays true however the cell is rendered.
  return td && td.classList.contains("chase-cell") ? td : null;
}

function coords(td) {
  const tr = td.closest("tr");
  const body = $("chaseBody");
  if (!tr || !body) return null;
  return { r: [...body.rows].indexOf(tr), c: [...tr.children].indexOf(td) };
}

// Steps to the next editable cell in the given direction, skipping the checkbox
// and actions columns and wrapping across rows on Tab.
function moveFocus(td, dr, dc) {
  const pos = coords(td);
  if (!pos) return;
  let { r, c } = pos;
  for (let guard = 0; guard < 200; guard++) {
    r += dr;
    c += dc;
    if (dc) {
      if (c >= COLUMNS.length) { c = 1; r += 1; }
      else if (c < 1) { c = COLUMNS.length - 1; r -= 1; }
    }
    if (r < 0 || r >= view.length) return;
    const next = cellAt(r, c);
    if (next) { next.focus(); placeCaretEnd(next); return; }
    if (!dc) return;
  }
}

function placeCaretEnd(el) {
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

// Drops plain text in at the caret, replacing whatever was selected. Done with
// the Range API rather than execCommand so the cell can never end up holding
// pasted markup.
function insertTextAtCaret(td, text) {
  const sel = window.getSelection();
  const range = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
  if (!range || !td.contains(range.commonAncestorContainer)) {
    td.textContent = (td.textContent + text).trim();
    return;
  }
  range.deleteContents();
  const node = document.createTextNode(text);
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

// A multi-cell paste spills right and down from the cell it lands in, adding
// rows if it needs them — the way Numbers behaves. Anything that's a single
// value goes in as plain text, so the cell can't collect markup.
function handlePaste(td, text) {
  const grid = parseCSV(text, { delim: text.includes("\t") ? "\t" : ",", keepEmpty: true });
  const width = Math.max(...grid.map(l => l.length));
  if (grid.length <= 1 && width <= 1) {
    insertTextAtCaret(td, String(text).replace(/\s+/g, " ").trim());
    const r = rowById(td.closest("tr").dataset.id);
    if (r) {
      r[td.dataset.key] = td.textContent.trim();
      renderTotals(view);
      renderSetProgress();
      save();
    }
    return;
  }
  const pos = coords(td);
  if (!pos) return;
  const startC = pos.c;
  const targets = view.slice(pos.r);
  let appended = 0;
  while (targets.length < grid.length) {
    const nr = blankRow();
    rows.push(nr);
    targets.push(nr);
    appended++;
  }
  let written = 0;
  let dropped = 0;
  grid.forEach((line, i) => {
    const row = targets[i];
    if (!row) return;
    line.forEach((raw, j) => {
      const col = COLUMNS[startC + j];
      if (!col) { dropped++; return; }
      const val = String(raw).trim();
      if (col.type === "check") row.got = truthy(val);
      else row[col.key] = val;
      written++;
    });
  });
  if (appended) {
    // New rows are pointless if a filter would hide them.
    for (const id of ["chaseSearch", "chaseFilter", "chaseSetFilter"]) {
      const el = $(id);
      if (!el) continue;
      if (el.tagName === "SELECT") el.value = "all";
      else el.value = "";
    }
  }
  saveQuiet();
  render();
  const notes = [`Pasted ${grid.length}×${width} (${written} cell${written === 1 ? "" : "s"})`];
  if (appended) notes.push(`${appended} new row${appended === 1 ? "" : "s"} added`);
  if (dropped) notes.push(`${dropped} value${dropped === 1 ? "" : "s"} past the last column ignored`);
  setStatus(notes.join(" · "));
}

// ───────────────────────── GitHub publishing ─────────────────────────

// On a Pages URL like geraldno20.github.io/cards/ the owner and repo are in the
// URL already; served from anywhere else there's nothing to read them from.
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

// Owner, repo, branch and token are the same repo credentials the ledger uses,
// so they're read from — and written back to — its config. Only the file path
// is this tab's own.
function ghConfig() {
  const shared = readJson(SHARED_GH_KEY);
  const auto = ghDetect();
  return {
    owner: shared.owner || auto.owner || "",
    repo: shared.repo || auto.repo || "",
    branch: shared.branch || "main",
    // Derived from the path this page reads, never edited: the two have to be
    // the same file or a save would quietly go nowhere the page can see.
    path: `docs/${PUBLISHED_PATH}`,
    token: shared.token || "",
  };
}

// Everything that's left is the repo credential the ledger tab uses too, so it
// lives in one place. (CHASE_GH_KEY used to hold this tab's own file path; that
// path is derived now, and the key is cleared on sight.)
function ghSaveConfig(patch) {
  const shared = { ...readJson(SHARED_GH_KEY) };
  let touched = false;
  for (const key of ["owner", "repo", "branch", "token"]) {
    if (key in patch) { shared[key] = patch[key]; touched = true; }
  }
  if (touched) localStorage.setItem(SHARED_GH_KEY, JSON.stringify(shared));
}

function toBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
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

// Where this saves, and whether it can — in place of the four inputs that were
// either derived from the URL or fixed.
function showGhTarget() {
  const el = $("chaseGhTarget");
  if (!el) return;
  const cfg = ghConfig();
  if (!cfg.owner || !cfg.repo) {
    el.innerHTML = `<span class="miss">Can't work out which repo this page belongs to, so saving is off.</span>`;
    return;
  }
  const where = `<code>${esc(cfg.owner)}/${esc(cfg.repo)}</code> on <code>${esc(cfg.branch)}</code>, `
    + `file <code>${esc(cfg.path)}</code>`;
  el.innerHTML = cfg.token
    ? `Saving changes to ${where} as you make them.`
    : `Would save to ${where} — add a token above and it starts syncing.`;
}

async function ghPublish({ auto = false } = {}) {
  const cfg = ghConfig();
  if (!cfg.owner || !cfg.repo) {
    if (!auto) setStatus("Set the GitHub owner and repo in the Publish panel first.", true);
    return;
  }
  if (!cfg.token) {
    if (!auto) setStatus("Add a GitHub token in the Publish panel first.", true);
    return;
  }

  const api = `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/${cfg.path.split("/").map(encodeURIComponent).join("/")}`;
  const headers = {
    Authorization: `Bearer ${cfg.token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const btn = $("chasePublish");
  if (btn && !auto) { btn.disabled = true; btn.textContent = "Saving…"; }
  setPubBusy(true);
  setStatus(auto ? "Saving your change to GitHub…" : "Saving to GitHub…");
  try {
    // The API needs the blob sha of the file being replaced.
    let sha;
    const cur = await fetch(`${api}?ref=${encodeURIComponent(cfg.branch)}`, { headers, cache: "no-store" });
    if (cur.ok) sha = (await cur.json()).sha;
    else if (cur.status !== 404) throw new Error(`${cur.status} — ${await ghMessage(cur)}`);

    const body = {
      message: `Update chase list (${rows.length} cards)`,
      content: toBase64(toCSV()),
      branch: cfg.branch,
    };
    if (sha) body.sha = sha;

    const put = await fetch(api, { method: "PUT", headers, body: JSON.stringify(body) });
    if (put.status === 409 || put.status === 422) {
      throw new Error(`${put.status} — the published file changed since this page loaded. Hit “Reload published” first (that discards local edits), or re-open the page.`);
    }
    if (!put.ok) throw new Error(`${put.status} — ${await ghMessage(put)}`);

    const out = await put.json();
    publishedCsv = toCSV();
    updatePubState();
    const short = out.commit?.sha ? out.commit.sha.slice(0, 7) : "committed";
    setStatus(auto
      ? `Saved to GitHub · commit ${short}. ${rows.length} cards; the live page catches up once Pages rebuilds.`
      : `Published ${rows.length} cards to ${cfg.owner}/${cfg.repo} · commit ${short}. The live page updates once Pages rebuilds (a minute or two).`);
  } catch (err) {
    setStatus(`GitHub save failed: ${err.message}${auto ? " — your change is still saved in this browser. It'll retry on your next edit, or hit “Save to GitHub”." : ""}`, true);
  } finally {
    setPubBusy(false);
    if (btn && !auto) { btn.disabled = false; btn.textContent = "Save to GitHub"; }
  }
}

async function reloadPublished() {
  if (rows.length && !confirm("Replace this browser's chase list with the published one from GitHub? Local edits you haven't published will be lost.")) return;
  setStatus("Fetching the published chase list…");
  try {
    const res = await fetch(PUBLISHED_PATH, { cache: "no-store" });
    if (!res.ok) throw new Error(String(res.status));
    const text = await res.text();
    syncing = true;
    rows = [];
    publishedCsv = text;
    const { added } = importRows(text);
    syncing = false;
    flushSave();
    setStatus(`Loaded ${added} cards from the published chase list.`);
  } catch (err) {
    setStatus(`Could not load ${PUBLISHED_PATH}: ${err.message}`, true);
  }
}

function loadPublished() {
  const fallbackToEmpty = () => {
    if (rows.length) return;
    render();
    setStatus("Empty chase list. Add a set below, or hit “Add row”.");
  };
  if (typeof fetch !== "function") { fallbackToEmpty(); return; }
  let req;
  try {
    req = fetch(PUBLISHED_PATH, { cache: "no-store" });
  } catch (err) {
    fallbackToEmpty();
    return;
  }
  req
    .then(r => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
    .then(text => {
      publishedCsv = text;
      adoptPublished(text);
      updatePubState();
    })
    .catch(fallbackToEmpty);
}

// Sets arrive here by commit, while ticks and costs are typed in the browser —
// so neither copy is simply newer than the other. The published file is taken
// as the checklist of record and whatever you'd typed is re-applied on top,
// which means a new set shows up on its own and can't cost you any progress.
function adoptPublished(text) {
  syncing = true;
  try {
    const mine = rows;
    rows = [];
    importRows(text);              // published rows, in published order
    const merged = mergeProgress(rows, mine);
    rows = merged.rows;
    render();
    if (!mine.length) {
      setStatus(`${rows.length} cards loaded from the published chase list.`);
      saveQuiet();
      return;
    }
    const notes = [];
    if (merged.added) notes.push(`${merged.added} new card${merged.added === 1 ? "" : "s"} from the published list`);
    if (merged.carried) notes.push(`kept your ${merged.carried} filled-in card${merged.carried === 1 ? "" : "s"}`);
    if (merged.localOnly) notes.push(`${merged.localOnly} card${merged.localOnly === 1 ? "" : "s"} only in this browser`);
    setStatus(notes.length
      ? `${rows.length} cards · ${notes.join(", ")}.`
      : `${rows.length} cards · up to date with the published list.`);
    saveQuiet();
  } finally {
    syncing = false;
  }
  // A merge that changed anything is worth publishing, but only once you touch
  // the list — an automatic commit on page load would be too surprising.
  updatePubState();
}

const hasProgress = r => !!(r.got || String(r.grade || "").trim() || String(r.cost || "").trim() || String(r.date || "").trim());
// A card's identity is its number within its set — the player is a label, and
// keying on it would turn an upstream spelling fix into a duplicate row. Rows
// with no number yet fall back to the player name.
const rowKey = r => {
  const norm = v => String(v || "").trim().toLowerCase();
  const number = norm(r.number);
  return number ? `${norm(r.set)}|${number}` : `${norm(r.set)}||${norm(r.player)}`;
};

// Copies got/grade/cost/date from `mine` onto the matching published rows, then
// appends anything of yours the published list doesn't know about.
function mergeProgress(published, mine) {
  const mineKeys = new Set(mine.map(rowKey));
  const byKey = new Map();
  for (const r of mine) {
    const k = rowKey(r);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(r);
  }
  let carried = 0;
  for (const p of published) {
    const bucket = byKey.get(rowKey(p));
    const l = bucket && bucket.length ? bucket.shift() : null;
    if (!l) continue;
    if (!hasProgress(l)) continue;
    p.got = l.got;
    for (const k of ["grade", "cost", "date"]) if (l[k]) p[k] = l[k];
    carried++;
  }
  // Leftovers: rows you added or filled in that aren't in the published file.
  // Untouched leftovers are dropped — the published checklist supersedes them.
  const pubKeys = new Set(published.map(rowKey));
  const localOnly = [];
  for (const bucket of byKey.values()) {
    for (const l of bucket) {
      if (hasProgress(l) || !pubKeys.has(rowKey(l))) localOnly.push(l);
    }
  }
  return {
    rows: published.concat(localOnly),
    carried,
    localOnly: localOnly.length,
    added: published.filter(p => !mineKeys.has(rowKey(p))).length,
  };
}

// ───────────────────────── set templates ─────────────────────────

// A chase row knows the set, the player and the card number; the ledger wants
// Sport / Year / Manufacturer / Description as separate columns. Rather than
// carry a list of card brands, the split is worked out against the manufacturers
// already in the ledger — your own naming wins, and it gets better as you buy.
// "1998-99 Topps Roundball Royalty Refractor" lands on the "Topps Roundball
// Royalty" you already use, leaving "Refractor" as the description.
function parseSetName(set) {
  const raw = String(set || "").trim();
  const out = { sport: "", year: "", manufacturer: "", description: "" };
  if (!raw) return out;

  let rest = raw;
  const ym = rest.match(/^((?:19|20)\d{2})(?:\s*[-/]\s*(\d{2}|\d{4}))?\s+/);
  if (ym) {
    out.year = ym[2] ? `${ym[1]}-${ym[2].slice(-2)}` : ym[1];
    rest = rest.slice(ym[0].length).trim();
  }

  const known = (window.cardsLedger?.distinctValues("manufacturer", { limit: 500 }) || [])
    .slice()
    .sort((a, b) => b.length - a.length);
  const lower = rest.toLowerCase();
  const hit = known.find(m => {
    const k = m.trim().toLowerCase();
    return k && (lower === k || lower.startsWith(k + " "));
  });
  if (hit) {
    out.manufacturer = hit;
    out.description = rest.slice(hit.length).trim();
  } else {
    // Nothing recognized: first word is the brand, the rest describes the card.
    const m = rest.match(/^(\S+)\s+(.*)$/);
    out.manufacturer = m ? m[1] : rest;
    out.description = m ? m[2] : "";
  }

  // Sport and year are whatever you normally file that manufacturer under.
  const profile = window.cardsLedger?.profileFor(out.manufacturer) || {};
  if (profile.sport) out.sport = profile.sport;
  if (!out.year && profile.year) out.year = profile.year;
  return out;
}

function readTemplates() {
  try { return JSON.parse(localStorage.getItem(TEMPLATE_KEY) || "{}") || {}; } catch (err) { return {}; }
}

const templateKey = set => String(set || "").trim().toLowerCase();

function templateFor(set) {
  const saved = readTemplates()[templateKey(set)];
  const guess = parseSetName(set);
  return { fields: { ...guess, ...(saved || {}) }, remembered: !!saved };
}

function rememberTemplate(set, fields) {
  const all = readTemplates();
  all[templateKey(set)] = {
    sport: fields.sport || "",
    year: fields.year || "",
    manufacturer: fields.manufacturer || "",
    description: fields.description || "",
  };
  try { localStorage.setItem(TEMPLATE_KEY, JSON.stringify(all)); } catch (err) { /* quota — not worth failing the purchase */ }
}

// ───────────────────────── logging a purchase ─────────────────────────

let buyRow = null;   // the chase row the dialog is working on

const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

function fillDatalists() {
  const L = window.cardsLedger;
  if (!L) return;
  const pairs = [
    ["ledgerSportList", "sport"],
    ["ledgerManufacturerList", "manufacturer"],
    ["ledgerFromList", "purchaseFrom"],
    ["ledgerGradeList", "grade"],
    ["ledgerYearList", "year"],
  ];
  for (const [id, key] of pairs) {
    const el = $(id);
    if (!el) continue;
    el.innerHTML = L.distinctValues(key).map(v => `<option value="${esc(v)}"></option>`).join("");
  }
}

function openBuyDialog(row) {
  const dlg = $("buyDialog");
  if (!dlg || !row) return;
  if (!window.cardsLedger) { setStatus("The ledger isn't loaded, so there's nowhere to write the purchase.", true); return; }
  buyRow = row;
  fillDatalists();

  const { fields, remembered } = templateFor(row.set);
  $("buyCard").textContent = [row.player, row.number, row.set].filter(Boolean).join(" · ");
  $("buySport").value = fields.sport || "";
  $("buyYear").value = fields.year || "";
  $("buyManufacturer").value = fields.manufacturer || "";
  $("buyDescription").value = fields.description || "";
  $("buyGrade").value = row.grade || "";
  $("buyCert").value = "";
  $("buyPrice").value = row.cost || "";
  $("buyDate").value = toISODate(row.date) || todayISO();
  $("buyFrom").value = window.cardsLedger.lastUsed("purchaseFrom") || "";
  $("buyRemember").checked = true;

  // Once a set's split is known, the panel stays shut — nothing left to confirm.
  const wrap = $("buyTemplateWrap");
  wrap.open = !remembered;
  $("buyTemplateSummary").textContent = remembered
    ? `Filing as ${[fields.year, fields.manufacturer, fields.description].filter(Boolean).join(" ")} — change`
    : "Check how this set files in the ledger";

  const dupe = window.cardsLedger.findPurchase({
    year: fields.year, manufacturer: fields.manufacturer, number: row.number, athlete: row.player,
  });
  const warn = $("buyWarn");
  warn.hidden = !dupe;
  if (dupe) warn.textContent = "The ledger already has this card. Logging it again will add a second row.";

  dlg.showModal();
  $("buyPrice").focus();
  $("buyPrice").select?.();
}

// The chase list stores yyyy-mm-dd, but the ledger's own 400-odd rows are
// m/d/yyyy — a purchase written into it should look like its neighbours.
function toLedgerDate(v) {
  const t = parseDate(v);
  if (t === null) return String(v || "").trim();
  const d = new Date(t);
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}

// The date input needs yyyy-mm-dd; the ledger and chase both accept looser text.
function toISODate(v) {
  const t = parseDate(v);
  if (t === null) return "";
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function commitBuy() {
  const row = buyRow;
  if (!row) return;
  const price = $("buyPrice").value.trim();
  const fields = {
    sport: $("buySport").value.trim(),
    year: $("buyYear").value.trim(),
    manufacturer: $("buyManufacturer").value.trim(),
    description: $("buyDescription").value.trim(),
  };
  const grade = $("buyGrade").value.trim();
  const date = $("buyDate").value.trim();
  const from = $("buyFrom").value.trim();
  const cert = $("buyCert").value.trim();

  if ($("buyRemember").checked) rememberTemplate(row.set, fields);

  // The chase row first — that's the checklist you look at.
  row.got = true;
  row.grade = grade;
  row.cost = price;
  row.date = date;

  const added = window.cardsLedger.addPurchase({
    ...fields,
    athlete: row.player,
    number: row.number,
    grade,
    certNo: cert,
    purchaseDate: toLedgerDate(date),
    purchaseFrom: from,
    purchasePrice: price,
  });

  saveQuiet();
  render();
  buyRow = null;
  const dirty = window.cardsLedger.hasUnpublishedChanges();
  setStatus(`Logged ${row.player} ${row.number} at ${fmtMoney(num(price)) || price} — ticked here and added to the ledger `
    + `(${added.rowCount} rows).${dirty ? " The ledger publishes by hand: hit Save to GitHub on the Transactions tab." : ""}`);
}

// ───────────────────────── reconciling with the ledger ─────────────────────────

// Cards bought before this tab existed are sitting in the ledger already. Match
// them up rather than asking for them again: the ledger has no card number on
// most rows, so this goes on player plus the set name containing the ledger's
// manufacturer (and description, when it has one).
const decade = v => (String(v || "").match(/(?:19|20)\d{2}/) || [""])[0];

function reconcileWithLedger() {
  if (!window.cardsLedger) { setStatus("The ledger isn't loaded, so there's nothing to match against.", true); return; }
  const ledger = window.cardsLedger.snapshot();
  const norm = v => String(v || "").trim().toLowerCase();
  let ticked = 0;
  const filled = [];

  for (const r of rows) {
    if (isGot(r)) continue;
    const set = norm(r.set);
    const player = norm(r.player);
    if (!set || !player) continue;
    const setYear = decade(parseSetName(r.set).year);
    const hit = ledger.find(l => {
      if (norm(l.athlete) !== player) return false;
      const man = norm(l.manufacturer);
      if (!man || !set.includes(man)) return false;
      const desc = norm(l.description);
      if (desc && !set.includes(desc)) return false;
      const n = norm(l.number);
      if (n && norm(r.number) && n !== norm(r.number)) return false;
      // A manufacturer as broad as "Topps" is inside half the set names ever
      // printed, so when both sides name a year they have to agree. "1998" and
      // "1998-99" are the same season written two ways.
      const lYear = decade(l.year);
      if (setYear && lYear && setYear !== lYear) return false;
      return true;
    });
    if (!hit) continue;
    r.got = true;
    if (!r.grade && hit.grade) r.grade = hit.grade;
    if (!r.cost && hit.purchasePrice) r.cost = hit.purchasePrice;
    if (!r.date && hit.purchaseDate) r.date = toISODate(hit.purchaseDate) || hit.purchaseDate;
    ticked++;
    filled.push(`${r.player} ${r.number}`.trim());
  }

  if (!ticked) {
    setStatus("Nothing new to match — the ledger has no purchases for cards still open on this list.");
    return;
  }
  saveQuiet();
  render();
  setStatus(`Matched ${ticked} card${ticked === 1 ? "" : "s"} against the ledger: ${filled.join(", ")}.`);
}

// ───────────────────────── auto-publish ─────────────────────────

// With a token set, an edit goes straight to the repo a beat later, so there's
// no publish step to remember and no second copy drifting out of date. Without
// one, everything still works locally and the toolbar says so.
function queueAutoPublish() {
  if (syncing || !autoPublishReady()) return;
  if (publishedCsv !== null && toCSV().trim() === publishedCsv.trim()) return;
  clearTimeout(autoTimer);
  autoTimer = setTimeout(() => {
    autoTimer = null;
    ghPublish({ auto: true });
  }, AUTO_PUBLISH_DELAY);
}

// ───────────────────────── wiring ─────────────────────────

function initChase() {
  const body = $("chaseBody");
  if (!body) return;
  buildHead();

  window.addEventListener("pagehide", flushSave);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushSave();
  });

  const stored = load();
  if (stored && stored.length) {
    rows = stored;
    render();
    setStatus(`${rows.length} card${rows.length === 1 ? "" : "s"} — this browser's copy.`);
  }

  // ── cell editing ──
  body.addEventListener("focusin", e => {
    const td = e.target.closest("td.chase-cell");
    if (!td) return;
    editBefore = td.textContent;
  });

  body.addEventListener("input", e => {
    const td = e.target.closest("td.chase-cell");
    if (!td) return;
    const r = rowById(td.closest("tr").dataset.id);
    if (!r) return;
    r[td.dataset.key] = td.textContent.trim();
    renderTotals(view);
    renderSetProgress();
    save();
  });

  body.addEventListener("keydown", e => {
    const td = e.target.closest("td.chase-cell");
    if (!td) return;
    if (e.key === "Enter") { e.preventDefault(); moveFocus(td, 1, 0); }
    else if (e.key === "Tab") { e.preventDefault(); moveFocus(td, 0, e.shiftKey ? -1 : 1); }
    else if (e.key === "ArrowDown") { e.preventDefault(); moveFocus(td, 1, 0); }
    else if (e.key === "ArrowUp") { e.preventDefault(); moveFocus(td, -1, 0); }
    else if (e.key === "Escape") {
      e.preventDefault();
      if (editBefore === null) return;
      td.textContent = editBefore;
      const r = rowById(td.closest("tr").dataset.id);
      if (r) { r[td.dataset.key] = editBefore.trim(); save(); }
      td.blur();
    }
  });

  body.addEventListener("paste", e => {
    const td = e.target.closest("td.chase-cell");
    if (!td) return;
    const text = e.clipboardData.getData("text/plain");
    if (!text) return;
    e.preventDefault();
    handlePaste(td, text);
  });

  // ── checkbox, duplicate, delete ──
  body.addEventListener("change", e => {
    if (e.target.type !== "checkbox") return;
    const tr = e.target.closest("tr");
    const r = rowById(tr.dataset.id);
    if (!r) return;
    r.got = e.target.checked;
    tr.classList.toggle("chase-done", r.got);
    save();
    renderTotals(view);
    renderSetProgress();
    // Re-render only when the row no longer belongs in the current filter.
    const filter = $("chaseFilter")?.value || "all";
    if (filter !== "all") render();
  });

  body.addEventListener("click", e => {
    const tr = e.target.closest("tr");
    if (!tr) return;
    if (e.target.closest(".chase-buy")) {
      const r = rowById(tr.dataset.id);
      if (r) openBuyDialog(r);
      return;
    }
    if (e.target.closest(".tx-del")) {
      rows = rows.filter(r => String(r.id) !== String(tr.dataset.id));
      save();
      render();
    } else if (e.target.closest(".tx-dup")) {
      const src = rowById(tr.dataset.id);
      if (!src) return;
      const copy = normalizeRow(src);
      rows.splice(rows.indexOf(src) + 1, 0, copy);
      save();
      render();
    }
  });

  // ── toolbar ──
  $("chaseAdd").addEventListener("click", () => {
    const r = blankRow();
    // A new row inherits whichever set is being filtered, since that's almost
    // always the one being worked on.
    const set = $("chaseSetFilter")?.value;
    if (set && set !== "all") r.set = set;
    rows.push(r);
    save();
    render();
    const idx = view.findIndex(v => v.id === r.id);
    const td = idx >= 0 ? cellAt(idx, 1) : null;
    if (td) { td.focus(); placeCaretEnd(td); }
  });

  // ── logging a purchase ──
  const buyForm = $("buyForm");
  if (buyForm) {
    buyForm.addEventListener("submit", e => {
      // method="dialog" closes the dialog for us; commit before it goes.
      if (!$("buyPrice").value.trim()) { e.preventDefault(); $("buyPrice").focus(); return; }
      commitBuy();
      $("buyDialog").close();     // method="dialog" handles this on a real click; be explicit
    });
    $("buyCancel").addEventListener("click", () => { buyRow = null; $("buyDialog").close(); });
    $("buyDialog").addEventListener("close", () => { buyRow = null; });
  }
  $("chaseReconcile").addEventListener("click", reconcileWithLedger);

  $("chaseSearch").addEventListener("input", render);
  $("chaseFilter").addEventListener("change", render);
  $("chaseSetFilter").addEventListener("change", render);

  $("chaseHeadRow").addEventListener("click", e => {
    const th = e.target.closest("th.sortable");
    if (!th) return;
    if (sortKey === th.dataset.key) {
      if (sortDir === -1) { sortKey = null; sortDir = 1; }   // third click restores checklist order
      else sortDir = -1;
    } else { sortKey = th.dataset.key; sortDir = 1; }
    render();
  });

  $("chaseExport").addEventListener("click", () => {
    const blob = new Blob([toCSV()], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "cards-chase.csv";
    a.click();
    URL.revokeObjectURL(a.href);
    setStatus(`Exported ${rows.length} cards to cards-chase.csv.`);
  });

  $("chaseCopyAll").addEventListener("click", async () => {
    const tsv = [COLUMNS.map(c => c.label).join("\t")]
      .concat(rows.map(r => COLUMNS.map(c => (c.type === "check" ? (r.got ? "yes" : "") : r[c.key] || "")).join("\t")))
      .join("\n");
    try {
      await navigator.clipboard.writeText(tsv);
      setStatus(`Copied all ${rows.length} cards — paste straight into Numbers.`);
    } catch (err) {
      setStatus(`Could not reach the clipboard (${err.message}). Use Export CSV instead.`, true);
    }
  });

  // ── add-a-set panel ──
  $("chaseSetGo").addEventListener("click", () => {
    const nameEl = $("chaseNewSet");
    const listEl = $("chaseNewRows");
    const name = nameEl.value.trim();
    if (!name) { setStatus("Give the set a name first.", true); nameEl.focus(); return; }
    if (!listEl.value.trim()) { setStatus("Paste the checklist rows first.", true); listEl.focus(); return; }
    const added = addSet(name, listEl.value);
    if (!added) { setStatus("Couldn't read any rows out of that.", true); return; }
    listEl.value = "";
    setStatus(`Added ${added} card${added === 1 ? "" : "s"} for ${name}.`);
  });

  $("chaseFile").addEventListener("change", async e => {
    const file = e.target.files[0];
    if (!file) return;
    const { added, skipped } = importRows(await file.text());
    setStatus(`Imported ${added} card${added === 1 ? "" : "s"} from ${file.name}${skipped ? ` (${skipped} blank skipped)` : ""}.`);
    e.target.value = "";
  });

  $("chaseClear").addEventListener("click", () => {
    if (!rows.length) return;
    if (!confirm(`Remove all ${rows.length} cards from this browser's chase list? Export a CSV first if you want a backup.`)) return;
    rows = [];
    saveQuiet();
    render();
    setStatus("Chase list cleared. The published list on GitHub is untouched — “Reload published” brings it back.");
  });

  // ── sync panel ──
  localStorage.removeItem(CHASE_GH_KEY);   // only ever held the now-derived path
  const tokenInput = $("chaseGhToken");
  if (tokenInput) {
    tokenInput.value = ghConfig().token || "";
    tokenInput.addEventListener("change", () => {
      ghSaveConfig({ token: tokenInput.value.trim() });
      showGhTarget();
      updatePubState();
      queueAutoPublish();               // a token arriving is reason to catch up
    });
  }
  showGhTarget();
  $("chasePublish").addEventListener("click", () => ghPublish());
  $("chaseReload").addEventListener("click", reloadPublished);
  $("chaseForgetToken").addEventListener("click", () => {
    ghSaveConfig({ token: "" });
    if (tokenInput) tokenInput.value = "";
    showGhTarget();
    updatePubState();
    setStatus("GitHub token removed from this browser. Changes stay here until you add one again.");
  });

  // Last, so a network hiccup can never leave the table without its handlers.
  loadPublished();
}

window.initChase = initChase;

// The ledger's title parser matches player names against everything it knows
// about; the chase list knows about players you haven't bought yet.
window.cardsChase = {
  players() {
    const seen = new Set();
    for (const r of rows) {
      const v = String(r.player || "").trim();
      if (v) seen.add(v);
    }
    return [...seen];
  },
};
})();
