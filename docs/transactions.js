// Transaction ledger — mirrors the "GY_CY Cards Database" sheet.
// Data lives in localStorage (nothing is uploaded), with CSV in/out for backups
// and for pulling in eBay order reports.

const TX_KEY = "gy-cards-transactions-v1";
const GH_KEY = "gy-cards-github-v1";
// The published database, committed to the repo and served by GitHub Pages.
const PUBLISHED_PATH = "data/transactions.csv";
let publishedRows = null;
let publishedCsv = null;   // the published file's contents, to spot unpublished edits

const GROUPS = [
  { key: "card",     label: "Card" },
  { key: "purchase", label: "Purchase" },
  { key: "sold",     label: "Sold" },
  { key: "expenses", label: "Expenses" },
  { key: "margin",   label: "Margin Calculations" },
];

// `alias` entries are lowercased header names accepted on import.
const COLUMNS = [
  { key: "sport",           group: "card",     label: "Sport" },
  { key: "year",            group: "card",     label: "Year" },
  { key: "manufacturer",    group: "card",     label: "Manufacturer", alias: ["set", "brand"] },
  { key: "athlete",         group: "card",     label: "Athlete", alias: ["player", "pokemon", "name"] },
  { key: "number",          group: "card",     label: "Number", alias: ["card number", "#", "card no.", "card no"] },
  { key: "description",     group: "card",     label: "Description", alias: ["parallel", "notes", "item title", "title"] },
  { key: "grade",           group: "card",     label: "Grade" },
  { key: "certNo",          group: "card",     label: "Certification No.", alias: ["cert", "cert no", "cert no.", "certification number"] },

  { key: "purchaseDate",    group: "purchase", label: "Date", type: "date", alias: ["purchase date", "date bought", "order creation date"] },
  { key: "purchaseFrom",    group: "purchase", label: "From", alias: ["purchase from", "source", "seller", "bought from"] },
  { key: "purchasePrice",   group: "purchase", label: "Price", type: "money", alias: ["purchase price", "cost", "total price", "item price", "paid"] },

  { key: "soldDate",        group: "sold",     label: "Date", type: "date", alias: ["sold date", "sale date", "date sold"] },
  { key: "soldPrice",       group: "sold",     label: "Price", type: "money", alias: ["sold price", "sold for", "sale price"] },
  { key: "paymentReceived", group: "sold",     label: "Payment Received", type: "money", alias: ["payout", "net payout", "paid on date"] },

  { key: "shipping",        group: "expenses", label: "Shipping", type: "money", alias: ["shipping and handling", "shipping cost", "postage"] },
  { key: "grading",         group: "expenses", label: "Grading", type: "money", alias: ["grading cost", "grading fee"] },
  { key: "fees",            group: "expenses", label: "Fees", type: "money", alias: ["final value fee", "fee", "selling fees", "ebay fees"] },

  { key: "profit",          group: "margin",   label: "Profit", type: "money", computed: true },
  { key: "roi",             group: "margin",   label: "ROI", type: "pct", computed: true },
];

const EDITABLE = COLUMNS.filter(c => !c.computed);
const COL_BY_KEY = Object.fromEntries(COLUMNS.map(c => [c.key, c]));

// Column order for headerless (positional) imports. The database sheet itself
// has no Payment Received column, so a paste straight out of Numbers is one
// narrower than this app's table — pick the layout by row width. Trailing
// Profit/ROI columns are ignored either way, since both are recalculated.
const TABLE_ORDER = EDITABLE.map(c => c.key);
const SHEET_ORDER = TABLE_ORDER.filter(k => k !== "paymentReceived");

let rows = [];
let view = [];          // rows currently rendered, in display order
let sortKey = null;
let sortDir = 1;
let saveTimer = null;
let nextId = 1;

// Grid selection, in {row index into `view`, column index into COLUMNS} space.
let anchor = null;      // where the selection started
let head = null;        // where it currently ends
let dragging = false;
let editing = null;     // the <td> being edited, if any
let editBefore = "";    // its value on entry, for Escape

// ───────────────────────── numbers & dates ─────────────────────────

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

const cost = r => (num(r.purchasePrice) || 0) + (num(r.shipping) || 0) + (num(r.grading) || 0) + (num(r.fees) || 0);

function profit(r) {
  const sold = num(r.soldPrice);
  if (sold === null) return null;
  return sold - cost(r);
}

function roi(r) {
  const p = profit(r);
  const c = cost(r);
  if (p === null || !c) return null;
  return p / c;
}

const computed = { profit, roi };

function fmtMoney(n) {
  if (n === null || n === undefined) return "";
  return (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtPct(n) {
  if (n === null || n === undefined) return "";
  return (n * 100).toFixed(1) + "%";
}

function isSold(r) {
  return num(r.soldPrice) !== null || !!String(r.soldDate || "").trim();
}

// ───────────────────────── storage ─────────────────────────

function blankRow() {
  const r = { id: nextId++ };
  for (const c of EDITABLE) r[c.key] = "";
  return r;
}

function normalizeRow(raw) {
  const r = { id: nextId++ };
  for (const c of EDITABLE) r[c.key] = raw[c.key] == null ? "" : String(raw[c.key]).trim();
  return r;
}

function load() {
  try {
    const stored = JSON.parse(localStorage.getItem(TX_KEY) || "null");
    if (Array.isArray(stored)) return stored.map(normalizeRow);
  } catch (err) {
    console.warn("Could not read saved transactions:", err);
  }
  return null;
}

function writeNow(quiet = false) {
  try {
    localStorage.setItem(TX_KEY, JSON.stringify(rows.map(r => {
      const out = {};
      for (const c of EDITABLE) if (r[c.key]) out[c.key] = r[c.key];
      return out;
    })));
    if (!quiet) setTxStatus(`Saved · ${rows.length} row${rows.length === 1 ? "" : "s"}`);
  } catch (err) {
    setTxStatus(`Could not save: ${err.message}`, true);
  }
  updatePubState();
}

// Says plainly whether what's on screen matches the database on GitHub, so
// unpublished work can't sit here unnoticed.
function updatePubState() {
  const el = document.getElementById("txPubState");
  if (!el) return;
  if (publishedCsv === null) { el.textContent = ""; el.className = "tx-pubstate"; return; }
  if (toCSV(true).trim() === publishedCsv.trim()) {
    el.textContent = "✓ published";
    el.className = "tx-pubstate ok";
  } else {
    el.textContent = "● unpublished changes — in this browser only";
    el.className = "tx-pubstate dirty";
  }
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveTimer = null; writeNow(); }, 200);
}

// Writes any pending debounced save immediately, so an edit made a keystroke
// before the tab closes isn't lost.
function flushSave() {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  writeNow(true);
}

// ───────────────────────── CSV ─────────────────────────

// Splits on tabs when the text looks tab-separated (a Numbers/Excel copy),
// commas otherwise — so a value like "Kobbie Mainoo, RC" survives a paste.
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
  const src = text.replace(/\r\n?/g, "\n");
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
  // A trailing newline shouldn't add a phantom row.
  if (out.length > 1 && out[out.length - 1].length === 1 && out[out.length - 1][0] === "") out.pop();
  if (opts.keepEmpty) return out;
  return out.filter(r => r.some(c => String(c).trim() !== ""));
}

function toCSV(includeComputed = true) {
  const cols = includeComputed ? COLUMNS : EDITABLE;
  const head = cols.map(c => {
    const g = GROUPS.find(g => g.key === c.group);
    return c.group === "card" || c.group === "margin" ? c.label : `${g.label} ${c.label}`;
  });
  const esc = v => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [head.map(esc).join(",")];
  for (const r of rows) {
    lines.push(cols.map(c => {
      if (!c.computed) return esc(r[c.key]);
      const v = computed[c.key](r);
      return v === null ? "" : esc(c.type === "pct" ? v.toFixed(4) : v.toFixed(2));
    }).join(","));
  }
  return lines.join("\n");
}

// Map a CSV header row onto column keys. Falls back to positional order when
// headers are missing or unrecognized (e.g. a Numbers export of the grouped
// two-row header, where "Date" and "Price" appear more than once).
function mapHeaders(header) {
  const seen = new Set();
  const mapped = header.map((h, i) => {
    const raw = String(h).trim().toLowerCase().replace(/\s+/g, " ");
    if (!raw) return null;
    const withGroup = COLUMNS.find(c => {
      const g = GROUPS.find(g => g.key === c.group);
      return raw === `${g.label} ${c.label}`.toLowerCase();
    });
    const direct = withGroup
      || COLUMNS.find(c => c.label.toLowerCase() === raw && !seen.has(c.key))
      || COLUMNS.find(c => c.key.toLowerCase() === raw)
      || COLUMNS.find(c => (c.alias || []).includes(raw) && !seen.has(c.key));
    if (direct && !direct.computed && !seen.has(direct.key)) {
      seen.add(direct.key);
      return direct.key;
    }
    return null;
  });
  const hits = mapped.filter(Boolean).length;
  if (hits >= 2) return mapped;
  return null;
}

// mode: "full" | "purchases" | "sales"
function importRows(text, mode = "full") {
  const table = parseCSV(text);
  if (!table.length) return { added: 0, skipped: 0 };

  let mapping = mapHeaders(table[0]);
  let body = table;
  if (mapping) {
    body = table.slice(1);
  } else {
    // Drop leading header-ish rows (the grouped header exports as two rows).
    while (body.length && looksLikeHeader(body[0])) body = body.slice(1);
    const width = body.reduce((w, line) => Math.max(w, line.length), 0);
    mapping = width > SHEET_ORDER.length + 2 ? TABLE_ORDER : SHEET_ORDER;
  }

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
      r[key] = val;
      filled = true;
    });
    if (!filled) { skipped++; continue; }
    if (mode === "purchases") {
      for (const k of ["soldDate", "soldPrice", "paymentReceived"]) r[k] = "";
      if (!r.purchaseDate && r.soldDate) r.purchaseDate = r.soldDate;
    } else if (mode === "sales") {
      if (!r.soldPrice && r.purchasePrice) { r.soldPrice = r.purchasePrice; r.purchasePrice = ""; }
      if (!r.soldDate && r.purchaseDate) { r.soldDate = r.purchaseDate; r.purchaseDate = ""; }
      r.purchaseFrom = "";
    }
    // Only title-shaped imports get their year mined out of the description.
    if (mode !== "full") splitTitle(r);
    added.push(r);
  }
  rows = rows.concat(added);
  save();
  render();
  return { added: added.length, skipped };
}

function looksLikeHeader(line) {
  const joined = line.join(" ").toLowerCase();
  return /sport|manufacturer|athlete|certification|margin|purchase|expenses/.test(joined)
    && !/\d{1,2}[/-]\d{1,2}/.test(joined);
}

// eBay reports carry everything in one item title, which starts with the year
// ("2023-24 Panini Prizm Steph Curry …"), so pull that out to make the rows
// sortable on arrival. Anchored at the start and limited to title-shaped
// imports on purpose: a description like "RC Gold /2012" is a print run, and
// "1985 mini refractor /50" is a design year — neither is the card's year.
function splitTitle(r) {
  if (r.year || !r.description) return;
  const m = String(r.description).match(/^((?:19|20)\d{2})(?:[-/](\d{2}))?\b/);
  if (m) r.year = m[2] ? `${m[1]}-${m[2]}` : m[1];
}


// ───────────────────────── rendering ─────────────────────────

const txStatusEl = () => document.getElementById("txStatus");
const txBody = () => document.getElementById("txBody");
const txWrap = () => document.getElementById("txWrap");

function setTxStatus(msg, bad = false) {
  const el = txStatusEl();
  if (el) el.innerHTML = bad ? `<span class="miss">${escapeHtml(msg)}</span>` : escapeHtml(msg);
}

function visibleRows() {
  const q = (document.getElementById("txSearch")?.value || "").trim().toLowerCase();
  const status = document.getElementById("txStatusFilter")?.value || "all";
  let out = rows.filter(r => {
    if (status === "sold" && !isSold(r)) return false;
    if (status === "unsold" && isSold(r)) return false;
    if (!q) return true;
    return EDITABLE.some(c => String(r[c.key] || "").toLowerCase().includes(q));
  });
  if (sortKey) {
    const col = COL_BY_KEY[sortKey];
    const val = r => {
      if (col.computed) return computed[sortKey](r);
      if (col.type === "money") return num(r[sortKey]);
      if (col.type === "date") return parseDate(r[sortKey]);
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

// Purchase and Sold price read as money — "$13,000.00" rather than "13000" —
// while the file keeps whatever was typed, so the published CSV is untouched
// until you actually edit a cell. Opening a cell swaps the plain number back in
// so you're editing the figure, not its formatting.
const MONEY_DISPLAY = new Set(["purchasePrice", "soldPrice"]);

function displayValue(key, raw) {
  if (!MONEY_DISPLAY.has(key)) return raw || "";
  const n = num(raw);
  return n === null ? (raw || "") : fmtMoney(n);
}

function cellHtml(r, c) {
  if (c.computed) {
    const v = computed[c.key](r);
    const cls = v === null ? "" : v < 0 ? " neg" : v > 0 ? " pos" : "";
    return `<td class="tx-computed${cls}" data-key="${c.key}">${c.type === "pct" ? fmtPct(v) : fmtMoney(v)}</td>`;
  }
  const align = c.type === "money" ? " num" : "";
  return `<td class="tx-edit${align}" data-key="${c.key}">${escapeHtml(displayValue(c.key, r[c.key]))}</td>`;
}

function render() {
  const body = txBody();
  if (!body) return;
  view = visibleRows();
  body.innerHTML = view.map(r => `
    <tr data-id="${r.id}">
      ${COLUMNS.map(c => cellHtml(r, c)).join("")}
      <td class="tx-actions">
        <button class="tx-dup" title="Duplicate row" aria-label="Duplicate row">⧉</button>
        <button class="tx-del" title="Delete row" aria-label="Delete row">✕</button>
      </td>
    </tr>`).join("");
  if (!view.length) {
    body.innerHTML = `<tr><td class="tx-empty" colspan="${COLUMNS.length + 1}">${
      rows.length ? "No rows match this filter." : "No transactions yet — hit “Add row”, or paste a block of cells."
    }</td></tr>`;
  }
  document.querySelectorAll("#txTable th.sortable").forEach(th => {
    th.classList.toggle("sorted-asc", th.dataset.key === sortKey && sortDir === 1);
    th.classList.toggle("sorted-desc", th.dataset.key === sortKey && sortDir === -1);
  });
  clampSel();
  paintSel();
  renderTotals(view);
}

function renderTotals(list) {
  const el = document.getElementById("txTotals");
  if (!el) return;
  const sold = list.filter(isSold);
  const totalCost = list.reduce((a, r) => a + cost(r), 0);
  const totalSale = list.reduce((a, r) => a + (num(r.soldPrice) || 0), 0);
  const totalProfit = sold.reduce((a, r) => a + (profit(r) || 0), 0);
  const soldCost = sold.reduce((a, r) => a + cost(r), 0);
  const holdings = list.filter(r => !isSold(r));
  const sign = n => (n > 0 ? "pos" : n < 0 ? "neg" : "");
  const tiles = [
    ["Rows", `${list.length}`, ""],
    ["Total Cost", fmtMoney(totalCost), ""],
    ["Total Sale", fmtMoney(totalSale), ""],
    ["Total Profit", fmtMoney(totalProfit), sign(totalProfit)],
    ["ROI (sold)", soldCost ? fmtPct(totalProfit / soldCost) : "—", sign(totalProfit)],
    ["Holdings", `${holdings.length} · ${fmtMoney(holdings.reduce((a, r) => a + cost(r), 0))}`, ""],
  ];
  el.innerHTML = tiles.map(([label, value, cls]) =>
    `<div class="tx-tile"><span class="tx-tile-label">${label}</span><span class="tx-tile-value ${cls}">${value}</span></div>`
  ).join("");
}

function buildHead() {
  const groupRow = document.getElementById("txGroupRow");
  const colRow = document.getElementById("txColRow");
  if (!groupRow || !colRow) return;
  const spans = GROUPS.map(g => [g, COLUMNS.filter(c => c.group === g.key).length]);
  groupRow.innerHTML = spans.map(([g, n]) => `<th class="tx-group ${g.key}" colspan="${n}">${g.label}</th>`).join("")
    + `<th class="tx-group"></th>`;
  colRow.innerHTML = COLUMNS.map(c =>
    `<th class="sortable ${c.group}" data-key="${c.key}" title="Sort by ${c.label}">${c.label}</th>`
  ).join("") + `<th></th>`;
}

// ───────────────────────── selection ─────────────────────────

const cellAt = (r, c) => {
  const tr = txBody()?.rows[r];
  if (!tr || !tr.children[c] || tr.children[c].classList.contains("tx-empty")) return null;
  return tr.children[c];
};

function selRange() {
  if (!anchor || !head || !view.length) return null;
  return {
    r1: Math.min(anchor.r, head.r), r2: Math.max(anchor.r, head.r),
    c1: Math.min(anchor.c, head.c), c2: Math.max(anchor.c, head.c),
  };
}

function clampSel() {
  const maxR = view.length - 1;
  const maxC = COLUMNS.length - 1;
  if (maxR < 0) { anchor = head = null; return; }
  for (const p of [anchor, head]) {
    if (!p) continue;
    p.r = Math.min(Math.max(p.r, 0), maxR);
    p.c = Math.min(Math.max(p.c, 0), maxC);
  }
}

function paintSel() {
  const body = txBody();
  if (!body) return;
  body.querySelectorAll("td.sel, td.sel-head").forEach(td => td.classList.remove("sel", "sel-head"));
  const s = selRange();
  if (!s) { setSelInfo(null); return; }
  for (let r = s.r1; r <= s.r2; r++) {
    for (let c = s.c1; c <= s.c2; c++) cellAt(r, c)?.classList.add("sel");
  }
  cellAt(head.r, head.c)?.classList.add("sel-head");
  setSelInfo(s);
}

// Shows the shape of the selection and totals it, the way a spreadsheet status
// bar does — money columns only, since summing card numbers means nothing.
function setSelInfo(s) {
  const el = document.getElementById("txSelInfo");
  if (!el) return;
  if (!s) { el.textContent = ""; return; }
  const nCells = (s.r2 - s.r1 + 1) * (s.c2 - s.c1 + 1);
  let sum = 0, numeric = 0;
  for (let c = s.c1; c <= s.c2; c++) {
    if (COLUMNS[c]?.type !== "money") continue;
    for (let r = s.r1; r <= s.r2; r++) {
      const v = num(cellAt(r, c)?.textContent);
      if (v !== null) { sum += v; numeric++; }
    }
  }
  const total = numeric ? ` · ${numeric > 1 ? "sum " : ""}${fmtMoney(sum)}` : "";
  el.textContent = nCells === 1 ? `1 cell${total}` : `${s.r2 - s.r1 + 1}×${s.c2 - s.c1 + 1} selected${total}`;
}

function select(r, c, extend = false) {
  if (!view.length) return;
  const p = { r, c };
  if (!extend || !anchor) anchor = p;
  head = { ...p };
  clampSel();
  paintSel();
  cellAt(head.r, head.c)?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function move(dr, dc, extend) {
  if (!head) { select(0, 0); return; }
  select(head.r + dr, head.c + dc, extend);
}

function cellCoords(td) {
  const tr = td.closest("tr");
  if (!tr || tr.dataset.id === undefined) return null;
  const c = [...tr.children].indexOf(td);
  const r = [...txBody().rows].indexOf(tr);
  if (r < 0 || c < 0 || c >= COLUMNS.length) return null;
  return { r, c };
}

// ───────────────────────── editing ─────────────────────────

function placeCaretEnd(el) {
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

function beginEdit(td, initial = null) {
  if (!td || !td.classList.contains("tx-edit") || editing) return;
  const r = rowById(td.closest("tr").dataset.id);
  if (!r) return;
  editing = td;
  editBefore = r[td.dataset.key] || "";
  td.setAttribute("contenteditable", "plaintext-only");
  td.classList.add("editing");
  if (initial !== null) {
    td.textContent = initial;
    r[td.dataset.key] = initial;
  } else if (MONEY_DISPLAY.has(td.dataset.key)) {
    td.textContent = editBefore;          // the figure, without its formatting
  }
  td.focus();
  placeCaretEnd(td);
  showSuggest(td, { filter: initial !== null });
}

function endEdit(commit = true) {
  if (!editing) return;
  const td = editing;
  editing = null;
  const tr = td.closest("tr");
  const r = rowById(tr.dataset.id);
  hideSuggest();
  if (r) {
    if (commit) r[td.dataset.key] = snapValue(td.dataset.key, td.textContent, r);
    else r[td.dataset.key] = editBefore;
    td.textContent = displayValue(td.dataset.key, r[td.dataset.key]);
    refreshComputed(tr, r);
    save();
  }
  td.removeAttribute("contenteditable");
  td.classList.remove("editing");
  txWrap()?.focus();
}

function rowById(id) {
  return rows.find(r => String(r.id) === String(id));
}

function refreshComputed(tr, r) {
  for (const c of COLUMNS) {
    if (!c.computed) continue;
    const td = tr.querySelector(`td[data-key="${c.key}"]`);
    if (!td) continue;
    const v = computed[c.key](r);
    td.textContent = c.type === "pct" ? fmtPct(v) : fmtMoney(v);
    td.classList.toggle("pos", v !== null && v > 0);
    td.classList.toggle("neg", v !== null && v < 0);
  }
  renderTotals(view);
}

// The ledger's dates are mostly m/d/yyyy, so a new row matches its neighbours.
function todayLedgerDate() {
  const d = new Date();
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}

// ───────────────────────── parsing an item title ─────────────────────────

const GRADERS = "PSA|BGS|BVG|SGC|CGC|CSG|TAG|HGA|KSA|GMA|ISA";

// Every player name the app knows: the ledger's own athletes plus the chase
// list's, so a card for someone you've never bought still gets recognized.
// Longest first, because "Ja Morant" must not win inside "Ja Morant Jr".
function knownAthletes() {
  const seen = new Set();
  for (const r of rows) {
    const v = String(r.athlete || "").trim();
    if (v.length > 3) seen.add(v);
  }
  for (const v of window.cardsChase?.players() || []) {
    if (String(v).trim().length > 3) seen.add(String(v).trim());
  }
  return [...seen].sort((a, b) => b.length - a.length);
}

function knownManufacturers() {
  const seen = new Set();
  for (const r of rows) {
    const v = String(r.manufacturer || "").trim();
    if (v) seen.add(v);
  }
  return [...seen].sort((a, b) => b.length - a.length);
}

// Finds a card year without being fooled by a print run: "/2012" is a serial
// numbering, not a season. Done with a scan rather than a lookbehind, which
// isn't safe on older iOS.
function findYear(s) {
  const re = /((?:19|20)\d{2})(?:\s*[-/]\s*(\d{2}|\d{4}))?/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const before = s[m.index - 1];
    if (before === "/" || before === "#") continue;          // /2012, #2012
    if (/\d/.test(before || "")) continue;                   // part of a longer number
    return { text: m[0], index: m.index, year: m[2] ? `${m[1]}-${m[2].slice(-2)}` : m[1] };
  }
  return null;
}

// Pulls a listing title apart into ledger columns. Heuristic by nature, so the
// UI shows what it found and waits for a nod before writing a row.
function parseItemTitle(text) {
  const out = { sport: "", year: "", manufacturer: "", athlete: "", number: "", description: "", grade: "" };
  let s = String(text || "").replace(/\s+/g, " ").trim();
  if (!s) return out;
  const cut = (str, index, length) => (str.slice(0, index) + " " + str.slice(index + length)).replace(/\s+/g, " ").trim();

  const g = s.match(new RegExp(`\\b(${GRADERS})\\s*#?\\s*(10(?:\\.0)?|[1-9](?:\\.5)?)\\b`, "i"));
  if (g) {
    out.grade = `${g[1].toUpperCase()} ${g[2]}`;
    s = cut(s, g.index, g[0].length);
  }

  const n = s.match(/#\s*([A-Za-z]*\d+[A-Za-z0-9-]*|[A-Za-z]+-?[A-Za-z0-9]*)/);
  if (n) {
    out.number = n[1];
    s = cut(s, n.index, n[0].length);
  }

  const y = findYear(s);
  if (y) {
    out.year = y.year;
    s = cut(s, y.index, y.text.length);
  }

  const lower = s.toLowerCase();
  const athlete = knownAthletes().find(nm => lower.includes(nm.toLowerCase()));
  if (athlete) {
    out.athlete = athlete;
    s = cut(s, lower.indexOf(athlete.toLowerCase()), athlete.length);
  }

  const brand = knownManufacturers().find(m => {
    const k = m.toLowerCase();
    const l = s.toLowerCase();
    return l === k || l.startsWith(k + " ");
  });
  if (brand) {
    out.manufacturer = brand;
    s = s.slice(brand.length).trim();
  } else {
    const m = s.match(/^(\S+)\s+(.*)$/);
    if (m) { out.manufacturer = m[1]; s = m[2]; }
    else { out.manufacturer = s; s = ""; }
  }

  out.description = s.replace(/^[-–,·]+\s*/, "").trim();
  const profile = window.cardsLedger?.profileFor(out.manufacturer) || {};
  if (profile.sport) out.sport = profile.sport;
  return out;
}

// ───────────────────────── suggestions ─────────────────────────

// Columns where you're nearly always reusing a value you've typed before. The
// ledger had 95 manufacturers and 13 spellings of 6 purchase sources before
// this existed, most of the spread being retyping rather than real variety.
const SUGGEST_KEYS = new Set(["sport", "year", "manufacturer", "athlete", "purchaseFrom", "grade"]);

let suggestBox = null;
let suggestItems = [];
let suggestIndex = -1;
let suggestFor = null;   // the cell it's attached to, so it can follow on scroll

// Accent- and case-insensitive, whitespace-collapsed: the shape of a value
// rather than its exact characters, so "pokemon" finds "Pokémon".
function foldValue(v) {
  return String(v || "").normalize("NFD").replace(/\p{Diacritic}/gu, "").replace(/\s+/g, " ").trim().toLowerCase();
}

function valueCounts(key, exceptRow) {
  const counts = new Map();
  for (const r of rows) {
    if (r === exceptRow) continue;
    const v = String(r[key] || "").trim();
    if (!v) continue;
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  return counts;
}

// Snaps a typed value onto one you already use when the two differ only in case,
// accents or spacing — so a new row can't quietly add a 14th spelling. An
// exact match, or anything genuinely new, is left alone.
function snapValue(key, value, exceptRow) {
  const v = String(value || "").trim();
  if (!v || !SUGGEST_KEYS.has(key)) return v;
  const counts = valueCounts(key, exceptRow);
  if (counts.has(v)) return v;
  const folded = foldValue(v);
  let best = null;
  let bestN = 0;
  for (const [existing, n] of counts) {
    if (foldValue(existing) === folded && n > bestN) { best = existing; bestN = n; }
  }
  return best || v;
}

function suggestEl() {
  if (suggestBox) return suggestBox;
  suggestBox = document.createElement("div");
  suggestBox.className = "tx-suggest";
  suggestBox.hidden = true;
  document.body.appendChild(suggestBox);
  suggestBox.addEventListener("mousedown", e => {
    const item = e.target.closest("[data-value]");
    if (!item) return;
    e.preventDefault();                       // don't blur the cell being edited
    applySuggestion(item.dataset.value);
  });
  return suggestBox;
}

const suggestVisible = () => !!suggestBox && !suggestBox.hidden;

function hideSuggest() {
  if (suggestBox) suggestBox.hidden = true;
  suggestItems = [];
  suggestIndex = -1;
  suggestFor = null;
}

// Opening a cell can scroll it into view, and the list has to come along rather
// than vanish — so scrolling repositions instead of closing.
function positionSuggest() {
  if (!suggestBox || suggestBox.hidden || !suggestFor || !suggestFor.isConnected) return;
  const rect = suggestFor.getBoundingClientRect();
  suggestBox.style.left = `${Math.round(rect.left + window.scrollX)}px`;
  suggestBox.style.top = `${Math.round(rect.bottom + window.scrollY)}px`;
  suggestBox.style.minWidth = `${Math.round(rect.width)}px`;
}

// `filter` is off when a cell is merely opened for editing: at that point the
// text is the value already stored, and filtering by it would leave a list of
// one thing you can already see. Typing switches filtering on.
function showSuggest(td, { filter = true } = {}) {
  if (!td) return hideSuggest();
  const key = td.dataset.key;
  if (!SUGGEST_KEYS.has(key)) return hideSuggest();
  const row = rowById(td.closest("tr").dataset.id);
  const counts = valueCounts(key, row);
  const ranked = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([v]) => v);
  const typed = filter ? foldValue(td.textContent) : "";
  let list = ranked;
  if (typed) {
    const starts = ranked.filter(v => foldValue(v).startsWith(typed));
    const rest = ranked.filter(v => !foldValue(v).startsWith(typed) && foldValue(v).includes(typed));
    list = starts.concat(rest);
  }
  list = list.slice(0, 8);
  if (!list.length || (list.length === 1 && foldValue(list[0]) === typed)) return hideSuggest();

  const el = suggestEl();
  suggestItems = list;
  suggestIndex = -1;                          // nothing preselected: Enter must
  el.innerHTML = list.map(v =>                // still commit exactly what you typed
    `<div data-value="${escapeHtml(v)}"><span>${escapeHtml(v)}</span><span class="n">${counts.get(v)}</span></div>`
  ).join("");
  el.hidden = false;
  suggestFor = td;
  positionSuggest();
}

function moveSuggest(delta) {
  if (!suggestItems.length) return;
  suggestIndex = (suggestIndex + delta + suggestItems.length + 1) % (suggestItems.length + 1);
  if (suggestIndex === suggestItems.length) suggestIndex = -1;   // wraps back to "what I typed"
  [...suggestBox.children].forEach((child, i) => child.classList.toggle("hot", i === suggestIndex));
}

function applySuggestion(value) {
  if (!editing) return hideSuggest();
  const td = editing;
  const row = rowById(td.closest("tr").dataset.id);
  td.textContent = value;
  if (row) {
    row[td.dataset.key] = value;
    refreshComputed(td.closest("tr"), row);
    save();
  }
  hideSuggest();
  placeCaretEnd(td);
}

// ───────────────────────── clipboard ─────────────────────────

function selectionTSV() {
  const s = selRange();
  if (!s) return "";
  const lines = [];
  for (let r = s.r1; r <= s.r2; r++) {
    const cells = [];
    for (let c = s.c1; c <= s.c2; c++) cells.push(cellAt(r, c)?.textContent ?? "");
    lines.push(cells.join("\t"));
  }
  return lines.join("\n");
}

function clearSelection() {
  const s = selRange();
  if (!s) return 0;
  let touched = 0;
  for (let r = s.r1; r <= s.r2; r++) {
    const row = view[r];
    if (!row) continue;
    for (let c = s.c1; c <= s.c2; c++) {
      const col = COLUMNS[c];
      if (!col || col.computed || !row[col.key]) continue;
      row[col.key] = "";
      touched++;
    }
    const tr = txBody().rows[r];
    if (tr) {
      for (let c = s.c1; c <= s.c2; c++) {
        const col = COLUMNS[c];
        if (col && !col.computed) tr.children[c].textContent = displayValue(col.key, "");
      }
      refreshComputed(tr, row);
    }
  }
  if (touched) save();
  return touched;
}

// Paste a block of cells anchored at the selection's top-left, spilling right
// and down and adding rows as needed — the way Numbers/Excel behave.
// Tab-delimited only: a spreadsheet copy is always TSV, and guessing at commas
// would split a value like "Kobbie Mainoo, RC" in two. CSV text belongs in the
// Import panel, which does detect its delimiter.
function pasteBlock(text) {
  const grid = parseCSV(text, { delim: "\t", keepEmpty: true });
  if (!grid.length) return;

  if (!view.length) {
    rows.push(blankRow());
    render();
    select(0, 0);
  }
  const s = selRange();
  if (!s) return;

  const startC = s.c1;
  const targets = view.slice(s.r1);
  let appended = 0;
  while (targets.length < grid.length) {
    const nr = blankRow();
    rows.push(nr);
    targets.push(nr);
    appended++;
  }

  // A full-width block dropped at column 0 is almost certainly whole rows out of
  // the database sheet, which has no Payment Received column — so 16 (or 18 with
  // Profit/ROI) wide gets mapped to the sheet's order rather than shifting
  // Shipping/Grading/Fees over by one. Anything else pastes literally.
  const width = Math.max(...grid.map(l => l.length));
  const sheetPaste = startC === 0 && (width === SHEET_ORDER.length || width === SHEET_ORDER.length + 2);
  const keyAt = j => {
    if (sheetPaste) return SHEET_ORDER[j] || null;
    const col = COLUMNS[startC + j];
    if (!col) return undefined;              // spilled past the last column
    return col.computed ? null : col.key;    // Profit/ROI are recalculated
  };

  let dropped = 0;
  let written = 0;
  grid.forEach((line, i) => {
    const row = targets[i];
    if (!row) return;
    line.forEach((raw, j) => {
      const key = keyAt(j);
      if (key === undefined) { dropped++; return; }
      if (key === null) return;
      row[key] = String(raw).trim();
      written++;
    });
  });

  // New rows are pointless if a filter would hide them.
  if (appended) {
    const search = document.getElementById("txSearch");
    const filter = document.getElementById("txStatusFilter");
    if (search?.value || (filter && filter.value !== "all")) {
      if (search) search.value = "";
      if (filter) filter.value = "all";
    }
  }

  const firstId = targets[0]?.id;
  save();
  render();
  const newIdx = view.findIndex(r => r.id === firstId);
  if (newIdx >= 0) {
    anchor = { r: newIdx, c: startC };
    head = { r: newIdx + grid.length - 1, c: startC + width - 1 };
    clampSel();
    paintSel();
  }

  const notes = [`Pasted ${grid.length}×${width} (${written} cell${written === 1 ? "" : "s"})`];
  if (sheetPaste) notes.push("read in the sheet's column order — Payment Received skipped");
  if (appended) notes.push(`${appended} new row${appended === 1 ? "" : "s"} added`);
  if (dropped) notes.push(`${dropped} value${dropped === 1 ? "" : "s"} past the last column ignored`);
  setTxStatus(notes.join(" · "));
}

// ───────────────────────── GitHub publishing ─────────────────────────

// On a Pages URL like geraldno20.github.io/cards/ the owner and repo are in the
// URL already. Served from anywhere else (a local python -m http.server, say)
// there's nothing to read them from, so fall back to this repo — otherwise the
// Save button refuses to work on localhost.
const GH_FALLBACK = { owner: "geraldno20", repo: "cards" };

function ghDetect() {
  const host = location.hostname || "";
  const seg = location.pathname.split("/").filter(Boolean);
  if (host.endsWith("github.io")) return { owner: host.split(".")[0], repo: seg[0] || "" };
  return { ...GH_FALLBACK };
}

function ghConfig() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(GH_KEY) || "{}"); } catch (err) { saved = {}; }
  const auto = ghDetect();
  return {
    owner: saved.owner || auto.owner || "",
    repo: saved.repo || auto.repo || "",
    branch: saved.branch || "main",
    // Not configurable on purpose. The page reads PUBLISHED_PATH relative to
    // itself and writes through the API by repo path; letting the second be
    // edited meant you could publish to a file the page never reads back, which
    // looks exactly like a save that silently did nothing.
    path: `docs/${PUBLISHED_PATH}`,
    token: saved.token || "",
  };
}

function ghSaveConfig(patch) {
  const next = { ...ghConfig(), ...patch };
  localStorage.setItem(GH_KEY, JSON.stringify(next));
  return next;
}

// btoa needs a binary string; chunked so a big ledger can't blow the stack.
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

// Where this will publish, and whether it's able to — the four inputs this
// replaced were all either derived from the URL or fixed.
function showGhTarget() {
  const el = document.getElementById("txGhTarget");
  if (!el) return;
  const cfg = ghConfig();
  if (!cfg.owner || !cfg.repo) {
    el.innerHTML = `<span class="miss">Can't work out which repo this page belongs to, so publishing is off.</span>`;
    return;
  }
  const where = `<code>${escapeHtml(cfg.owner)}/${escapeHtml(cfg.repo)}</code> on <code>${escapeHtml(cfg.branch)}</code>, `
    + `file <code>${escapeHtml(cfg.path)}</code>`;
  el.innerHTML = cfg.token
    ? `Publishing to ${where}.`
    : `Would publish to ${where} — add a token above first.`;
}

async function ghPublish() {
  const cfg = ghConfig();
  if (!cfg.owner || !cfg.repo) { setTxStatus("Set the GitHub owner and repo in the Publish panel first.", true); return; }
  if (!cfg.token) { setTxStatus("Add a GitHub token in the Publish panel first.", true); return; }

  const api = `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/${cfg.path.split("/").map(encodeURIComponent).join("/")}`;
  const headers = {
    Authorization: `Bearer ${cfg.token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const btn = document.getElementById("txPublish");
  if (btn) { btn.disabled = true; btn.textContent = "Saving…"; }
  setTxStatus("Saving to GitHub…");
  try {
    // The API needs the blob sha of the file being replaced.
    let sha;
    const cur = await fetch(`${api}?ref=${encodeURIComponent(cfg.branch)}`, { headers, cache: "no-store" });
    if (cur.ok) sha = (await cur.json()).sha;
    else if (cur.status !== 404) throw new Error(`${cur.status} — ${await ghMessage(cur)}`);

    const body = {
      message: `Update card ledger (${rows.length} rows)`,
      content: toBase64(toCSV(true)),
      branch: cfg.branch,
    };
    if (sha) body.sha = sha;

    const put = await fetch(api, { method: "PUT", headers, body: JSON.stringify(body) });
    if (put.status === 409 || put.status === 422) {
      throw new Error(`${put.status} — the published file changed since this page loaded. Hit “Reload published” first (that discards local edits), or re-open the page.`);
    }
    if (!put.ok) throw new Error(`${put.status} — ${await ghMessage(put)}`);

    const out = await put.json();
    publishedRows = rows.length;
    publishedCsv = toCSV(true);
    updatePubState();
    const short = out.commit?.sha ? out.commit.sha.slice(0, 7) : "committed";
    setTxStatus(`Published ${rows.length} rows to ${cfg.owner}/${cfg.repo} · commit ${short}. The live page updates once Pages rebuilds (a minute or two).`);
  } catch (err) {
    setTxStatus(`GitHub save failed: ${err.message}`, true);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Save to GitHub"; }
  }
}

async function reloadPublished() {
  if (rows.some(r => EDITABLE.some(c => r[c.key])) &&
      !confirm("Replace this browser's copy with the published database from GitHub? Local edits you haven't published will be lost.")) return;
  setTxStatus("Fetching the published database…");
  try {
    const res = await fetch(PUBLISHED_PATH, { cache: "no-store" });
    if (!res.ok) throw new Error(`${res.status}`);
    const text = await res.text();
    rows = [];
    anchor = head = null;
    publishedCsv = text;
    const { added } = importRows(text, "full");
    flushSave();
    publishedRows = added;
    setTxStatus(`Loaded ${added} rows from the published database.`);
  } catch (err) {
    setTxStatus(`Could not load ${PUBLISHED_PATH}: ${err.message}`, true);
  }
}

// ───────────────────────── wiring ─────────────────────────

function initTransactions() {
  buildHead();

  // Don't let a debounced save die with the tab.
  window.addEventListener("pagehide", flushSave);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") { if (editing) endEdit(true); flushSave(); }
  });

  const stored = load();
  if (stored && stored.length) {
    rows = stored;
    render();
    setTxStatus(`${rows.length} row${rows.length === 1 ? "" : "s"} — this browser's copy.`);
  }

  const body = txBody();
  const wrap = txWrap();

  // ── mouse: click selects, drag extends ──
  body.addEventListener("mousedown", e => {
    const td = e.target.closest("td.tx-edit, td.tx-computed");
    if (!td) return;
    if (editing === td) return;           // clicking inside the cell being edited
    if (editing) endEdit(true);
    const pos = cellCoords(td);
    if (!pos) return;
    e.preventDefault();                   // don't start a text selection
    wrap.focus();
    dragging = true;
    select(pos.r, pos.c, e.shiftKey);
  });

  body.addEventListener("mouseover", e => {
    if (!dragging) return;
    const td = e.target.closest("td.tx-edit, td.tx-computed");
    if (!td) return;
    const pos = cellCoords(td);
    if (pos) select(pos.r, pos.c, true);
  });

  window.addEventListener("mouseup", () => { dragging = false; });
  wrap.addEventListener("scroll", positionSuggest);
  window.addEventListener("scroll", positionSuggest, { passive: true });
  window.addEventListener("resize", positionSuggest);

  body.addEventListener("dblclick", e => {
    const td = e.target.closest("td.tx-edit");
    if (td) beginEdit(td);
  });

  // ── keyboard ──
  wrap.addEventListener("keydown", e => {
    if (editing) {
      // While the suggestion list is up it takes the keys it needs, and nothing
      // is preselected — so Enter still commits exactly what you typed unless
      // you've walked into the list on purpose.
      if (suggestVisible()) {
        if (e.key === "ArrowDown") { e.preventDefault(); moveSuggest(1); return; }
        if (e.key === "ArrowUp") { e.preventDefault(); moveSuggest(-1); return; }
        if ((e.key === "Enter" || e.key === "Tab") && suggestIndex >= 0) {
          e.preventDefault();
          applySuggestion(suggestItems[suggestIndex]);
          return;
        }
        if (e.key === "Escape") { e.preventDefault(); hideSuggest(); return; }
      }
      if (e.key === "Enter") { e.preventDefault(); endEdit(true); move(1, 0, false); }
      else if (e.key === "Escape") { e.preventDefault(); endEdit(false); }
      else if (e.key === "Tab") { e.preventDefault(); endEdit(true); move(0, e.shiftKey ? -1 : 1, false); }
      return;
    }
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "a") {
      e.preventDefault();
      anchor = { r: 0, c: 0 };
      head = { r: view.length - 1, c: COLUMNS.length - 1 };
      paintSel();
      return;
    }
    if (mod) return;                       // let copy/cut/paste events through
    switch (e.key) {
      case "ArrowUp":    e.preventDefault(); move(-1, 0, e.shiftKey); return;
      case "ArrowDown":  e.preventDefault(); move(1, 0, e.shiftKey); return;
      case "ArrowLeft":  e.preventDefault(); move(0, -1, e.shiftKey); return;
      case "ArrowRight": e.preventDefault(); move(0, 1, e.shiftKey); return;
      case "Tab":        e.preventDefault(); move(0, e.shiftKey ? -1 : 1, false); return;
      case "Enter":
      case "F2":         e.preventDefault(); if (head) beginEdit(cellAt(head.r, head.c)); return;
      case "Backspace":
      case "Delete": {
        e.preventDefault();
        const n = clearSelection();
        if (n) setTxStatus(`Cleared ${n} cell${n === 1 ? "" : "s"}.`);
        return;
      }
      case "Escape":     anchor = head = null; paintSel(); return;
    }
    // Typing a character starts editing with it, like a spreadsheet.
    if (e.key.length === 1 && !e.altKey && head) {
      const td = cellAt(head.r, head.c);
      if (td?.classList.contains("tx-edit")) {
        e.preventDefault();
        beginEdit(td, e.key);
      }
    }
  });

  wrap.addEventListener("copy", e => {
    if (editing) return;
    const tsv = selectionTSV();
    if (!tsv) return;
    e.clipboardData.setData("text/plain", tsv);
    e.preventDefault();
    const s = selRange();
    setTxStatus(`Copied ${s.r2 - s.r1 + 1}×${s.c2 - s.c1 + 1} to the clipboard.`);
  });

  wrap.addEventListener("cut", e => {
    if (editing) return;
    const tsv = selectionTSV();
    if (!tsv) return;
    e.clipboardData.setData("text/plain", tsv);
    e.preventDefault();
    const n = clearSelection();
    setTxStatus(`Cut ${n} cell${n === 1 ? "" : "s"} to the clipboard.`);
  });

  wrap.addEventListener("paste", e => {
    if (editing) return;
    const text = e.clipboardData.getData("text/plain");
    if (!text) return;
    e.preventDefault();
    pasteBlock(text);
  });

  // Live-update Profit/ROI while typing in a cell.
  body.addEventListener("input", e => {
    const td = e.target.closest("td.tx-edit");
    if (!td || editing !== td) return;
    const tr = td.closest("tr");
    const r = rowById(tr.dataset.id);
    if (!r) return;
    r[td.dataset.key] = td.textContent.trim();
    refreshComputed(tr, r);
    showSuggest(td);
    save();
  });

  body.addEventListener("blur", e => {
    if (editing && e.target === editing) endEdit(true);
  }, true);

  // ── row actions ──
  body.addEventListener("click", e => {
    const tr = e.target.closest("tr");
    if (!tr) return;
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
      const idx = view.findIndex(r => r.id === copy.id);
      if (idx >= 0) select(idx, 0);
    }
  });

  document.getElementById("txAdd").addEventListener("click", () => {
    const r = blankRow();
    // Buys arrive in runs from the same place on the same day, so these two are
    // free. Sport is left blank on purpose — guessing it would mislabel cards.
    r.purchaseDate = todayLedgerDate();
    r.purchaseFrom = window.cardsLedger.lastUsed("purchaseFrom") || "";
    rows.push(r);
    save();
    render();
    const idx = view.findIndex(v => v.id === r.id);
    if (idx >= 0) {
      select(idx, 0);
      beginEdit(cellAt(idx, 0));
    }
  });

  document.getElementById("txSearch").addEventListener("input", render);
  document.getElementById("txStatusFilter").addEventListener("change", render);

  document.getElementById("txColRow").addEventListener("click", e => {
    const th = e.target.closest("th.sortable");
    if (!th) return;
    if (sortKey === th.dataset.key) sortDir = -sortDir;
    else { sortKey = th.dataset.key; sortDir = 1; }
    render();
  });

  document.getElementById("txExport").addEventListener("click", () => {
    const blob = new Blob([toCSV(true)], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "cards-transactions.csv";
    a.click();
    URL.revokeObjectURL(a.href);
    setTxStatus(`Exported ${rows.length} rows to cards-transactions.csv.`);
  });

  document.getElementById("txCopyAll").addEventListener("click", async () => {
    const tsv = [COLUMNS.map(c => c.label).join("\t")]
      .concat(rows.map(r => COLUMNS.map(c => {
        if (!c.computed) return r[c.key] || "";
        const v = computed[c.key](r);
        return v === null ? "" : c.type === "pct" ? fmtPct(v) : fmtMoney(v);
      }).join("\t"))).join("\n");
    try {
      await navigator.clipboard.writeText(tsv);
      setTxStatus(`Copied all ${rows.length} rows — paste straight into Numbers.`);
    } catch (err) {
      setTxStatus(`Could not reach the clipboard (${err.message}). Use Export CSV instead.`, true);
    }
  });

  document.getElementById("txFile").addEventListener("change", async e => {
    const file = e.target.files[0];
    if (!file) return;
    const mode = document.getElementById("txImportMode").value;
    const { added, skipped } = importRows(await file.text(), mode);
    setTxStatus(`Imported ${added} row${added === 1 ? "" : "s"} from ${file.name}${skipped ? ` (${skipped} blank skipped)` : ""}.`);
    e.target.value = "";
  });

  document.getElementById("txPasteGo").addEventListener("click", () => {
    const ta = document.getElementById("txPaste");
    const text = ta.value.trim();
    if (!text) { setTxStatus("Nothing pasted yet.", true); return; }
    const mode = document.getElementById("txImportMode").value;
    const { added, skipped } = importRows(text, mode);
    setTxStatus(`Imported ${added} pasted row${added === 1 ? "" : "s"}${skipped ? ` (${skipped} blank skipped)` : ""}.`);
    ta.value = "";
  });

  // ── one item title at a time ──
  const titleInput = document.getElementById("txTitle");
  const titlePreview = document.getElementById("txTitlePreview");
  const titleGo = document.getElementById("txTitleGo");
  const titleNote = document.getElementById("txTitleNote");
  let parsedTitle = null;

  function renderParsedTitle() {
    const raw = titleInput.value.trim();
    if (!raw) {
      parsedTitle = null;
      titlePreview.hidden = true;
      titleGo.disabled = true;
      titleNote.textContent = "";
      return;
    }
    parsedTitle = parseItemTitle(raw);
    const shown = [
      ["Sport", parsedTitle.sport],
      ["Year", parsedTitle.year],
      ["Manufacturer", parsedTitle.manufacturer],
      ["Athlete", parsedTitle.athlete],
      ["Number", parsedTitle.number],
      ["Description", parsedTitle.description],
      ["Grade", parsedTitle.grade],
    ];
    titlePreview.innerHTML = shown.map(([k, v]) =>
      `<div class="field${v ? "" : " empty"}"><span class="k">${k}</span><span class="v">${escapeHtml(v || "—")}</span></div>`
    ).join("");
    titlePreview.hidden = false;
    const missing = ["athlete", "manufacturer"].filter(k => !parsedTitle[k]);
    titleNote.textContent = missing.length
      ? `No ${missing.join(" or ")} recognized — add the row and fix it in the grid.`
      : "";
    titleGo.disabled = false;
  }

  titleInput.addEventListener("input", renderParsedTitle);
  titleInput.addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); titleGo.click(); }
  });

  titleGo.addEventListener("click", () => {
    if (!parsedTitle) return;
    const r = blankRow();
    for (const c of EDITABLE) {
      if (parsedTitle[c.key] == null) continue;
      r[c.key] = snapValue(c.key, parsedTitle[c.key], r);
    }
    r.purchaseDate = todayLedgerDate();
    r.purchaseFrom = window.cardsLedger.lastUsed("purchaseFrom") || "";
    rows.push(r);
    writeNow(true);
    // A parsed row is pointless behind a filter that hides it.
    const search = document.getElementById("txSearch");
    const filter = document.getElementById("txStatusFilter");
    if (search) search.value = "";
    if (filter) filter.value = "all";
    sortKey = null;
    render();
    titleInput.value = "";
    renderParsedTitle();
    const idx = view.findIndex(v => v.id === r.id);
    const priceCol = COLUMNS.findIndex(c => c.key === "purchasePrice");
    if (idx >= 0) {
      select(idx, priceCol);
      txWrap()?.focus();
      beginEdit(cellAt(idx, priceCol));   // the one thing a title can't tell us
    }
    setTxStatus(`Added ${[r.year, r.manufacturer, r.athlete].filter(Boolean).join(" ")} — type the price.`);
  });

  document.getElementById("txClear").addEventListener("click", () => {
    if (!rows.length) return;
    if (!confirm(`Delete all ${rows.length} rows from this browser? Export a CSV first if you want a backup.`)) return;
    rows = [blankRow()];
    anchor = head = null;
    save();
    render();
    setTxStatus("Ledger cleared. The published database on GitHub is untouched — “Reload published” brings it back.");
  });

  // ── sync panel ──
  const tokenInput = document.getElementById("txGhToken");
  if (tokenInput) {
    tokenInput.value = ghConfig().token || "";
    tokenInput.addEventListener("change", () => {
      ghSaveConfig({ token: tokenInput.value.trim() });
      showGhTarget();
    });
  }
  showGhTarget();
  document.getElementById("txPublish").addEventListener("click", ghPublish);
  document.getElementById("txReload").addEventListener("click", reloadPublished);
  document.getElementById("txForgetToken").addEventListener("click", () => {
    ghSaveConfig({ token: "" });
    const el = document.getElementById("txGhToken");
    if (el) el.value = "";
    showGhTarget();
    setTxStatus("GitHub token removed from this browser. The Chase tab shared it, so it stops syncing too.");
  });

  // Last, so that a network hiccup can never leave the grid without its
  // handlers: the committed CSV is the published baseline, and a local copy
  // wins until you explicitly reload from GitHub.
  loadPublished();
}

function loadPublished() {
  const fallbackToEmpty = () => {
    if (rows.length) return;
    rows = [blankRow()];
    render();
    setTxStatus("Empty ledger. Type in a cell, or paste a block of cells from Numbers.");
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
      publishedRows = Math.max(0, parseCSV(text).length - 1);
      if (!rows.length) {
        importRows(text, "full");
        flushSave();   // write now, so the debounce can't overwrite the message below
        setTxStatus(`${rows.length} rows loaded from the published database.`);
      } else if (publishedRows !== rows.length) {
        setTxStatus(`${rows.length} rows here · the published database has ${publishedRows}. “Save to GitHub” publishes yours; “Reload published” replaces yours.`);
      } else {
        setTxStatus(`${rows.length} rows · same row count as the published database.`);
      }
      updatePubState();
    })
    .catch(fallbackToEmpty);
}

// ───────────────────────── API for the other tabs ─────────────────────────

// The Chase tab needs to write a purchase in here without a second round of
// typing, and both tabs want to offer the values you've already used rather
// than a blank box. Keeping that behind a narrow surface means the ledger's
// own state stays private to this file.
window.cardsLedger = {
  // Frequency-ranked values you've actually used for a column, most-used first.
  distinctValues(key, { limit = 60 } = {}) {
    if (!COL_BY_KEY[key] || COL_BY_KEY[key].computed) return [];
    const counts = new Map();
    for (const r of rows) {
      const v = String(r[key] || "").trim();
      if (!v) continue;
      counts.set(v, (counts.get(v) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, limit).map(([v]) => v);
  },

  // The value on the most recent purchase — the sensible default for a new row,
  // since buys arrive in runs from the same place.
  lastUsed(key) {
    let best = null;
    let bestAt = -Infinity;
    for (const r of rows) {
      const v = String(r[key] || "").trim();
      if (!v) continue;
      const at = parseDate(r.purchaseDate) ?? -Infinity;
      if (at >= bestAt) { bestAt = at; best = v; }
    }
    return best;
  },

  // Same card already in the ledger? Matched on set + number + athlete, the
  // fields a chase row can supply, so a double-click can't silently double-buy.
  findPurchase({ year, manufacturer, number, athlete }) {
    const norm = v => String(v || "").trim().toLowerCase();
    return rows.find(r =>
      norm(r.number) === norm(number) &&
      norm(r.athlete) === norm(athlete) &&
      norm(r.year) === norm(year) &&
      norm(r.manufacturer) === norm(manufacturer)) || null;
  },

  // A read-only copy of every row, for callers that need to match against the
  // ledger without being able to disturb it.
  snapshot() {
    return rows.map(r => {
      const out = { id: r.id };
      for (const c of EDITABLE) out[c.key] = r[c.key] || "";
      return out;
    });
  },

  // What you normally record alongside a given manufacturer. Lets a caller fill
  // in Sport and Year for a brand you've bought before instead of asking.
  profileFor(manufacturer) {
    const want = String(manufacturer || "").trim().toLowerCase();
    if (!want) return {};
    const hits = rows.filter(r => String(r.manufacturer || "").trim().toLowerCase() === want);
    if (!hits.length) return {};
    const commonest = key => {
      const c = new Map();
      for (const r of hits) {
        const v = String(r[key] || "").trim();
        if (v) c.set(v, (c.get(v) || 0) + 1);
      }
      return [...c.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "";
    };
    return { sport: commonest("sport"), year: commonest("year"), description: commonest("description") };
  },

  // Unsold rows, i.e. what's actually on hand to sell.
  holdings() {
    return this.snapshot().filter(r => !num(r.soldPrice) && !String(r.soldDate || "").trim());
  },

  // Which holdings could be this card? Same shape of evidence "Match ledger"
  // uses: the athlete has to agree, and anything else both sides name has to
  // agree too. Returns best-first so a caller can show one and offer the rest.
  findHoldingCandidates(card) {
    const norm = v => String(v || "").trim().toLowerCase();
    const year4 = v => (String(v || "").match(/(?:19|20)\d{2}/) || [""])[0];
    const want = {
      athlete: norm(card.athlete),
      number: norm(card.number),
      manufacturer: norm(card.manufacturer),
      description: norm(card.description),
      year: year4(card.year),
    };
    if (!want.athlete) return [];
    const scored = [];
    for (const r of this.holdings()) {
      if (norm(r.athlete) !== want.athlete) continue;
      let score = 1;
      for (const k of ["number", "manufacturer", "description"]) {
        const a = want[k];
        const b = norm(r[k]);
        if (!a || !b) continue;                 // silence isn't disagreement
        if (a === b) score += 2;
        else if (k === "manufacturer" && (a.includes(b) || b.includes(a))) score += 1;
        else score -= 3;                        // a stated mismatch counts against
      }
      const ya = want.year, yb = year4(r.year);
      if (ya && yb) score += ya === yb ? 1 : -3;
      if (score > 0) scored.push({ row: r, score });
    }
    return scored.sort((a, b) => b.score - a.score).map(s => ({ ...s.row, _score: s.score }));
  },

  // A sale belongs on the row that recorded the purchase: this ledger keeps one
  // row per card and computes Profit and ROI across it. Writing a second row
  // instead would leave the buy sitting in Holdings and show an ROI on a cost
  // of nothing.
  recordSale(id, { soldDate, soldPrice, paymentReceived, fees, shipping } = {}) {
    const r = rows.find(x => String(x.id) === String(id));
    if (!r) return { ok: false, reason: "that row is no longer in the ledger" };
    if (num(r.soldPrice) !== null || String(r.soldDate || "").trim()) {
      return { ok: false, reason: "that row is already marked sold" };
    }
    if (soldDate != null) r.soldDate = String(soldDate).trim();
    if (soldPrice != null) r.soldPrice = String(soldPrice).trim();
    if (paymentReceived != null) r.paymentReceived = String(paymentReceived).trim();
    if (fees != null) r.fees = String(fees).trim();
    if (shipping != null) r.shipping = String(shipping).trim();
    writeNow(true);
    render();
    return { ok: true, id: r.id, profit: profit(r), roi: roi(r) };
  },

  addPurchase(fields) {
    const r = blankRow();
    for (const c of EDITABLE) {
      if (fields[c.key] == null) continue;
      r[c.key] = snapValue(c.key, String(fields[c.key]), r);
    }
    rows.push(r);
    writeNow(true);            // quiet: the caller has a better message to show
    render();
    return { id: r.id, rowCount: rows.length };
  },

  // True when the ledger holds edits that aren't in the published CSV yet.
  // Chase publishes itself; the ledger doesn't, so a caller writing a row in
  // here has to say so.
  hasUnpublishedChanges() {
    return publishedCsv !== null && toCSV(true).trim() !== publishedCsv.trim();
  },

  // Opens the Transactions tab with one row selected, for "see it in the ledger".
  reveal(id) {
    const tab = document.querySelector('.tab[data-tab="transactions"]');
    if (tab) tab.click();
    sortKey = null;
    const search = document.getElementById("txSearch");
    const filter = document.getElementById("txStatusFilter");
    if (search) search.value = "";
    if (filter) filter.value = "all";
    render();
    const idx = view.findIndex(r => String(r.id) === String(id));
    if (idx >= 0) {
      select(idx, 0);
      txWrap()?.focus();
      cellAt(idx, 0)?.scrollIntoView({ block: "center" });
    }
    return idx >= 0;
  },
};

