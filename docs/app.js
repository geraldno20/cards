// Sports cards recommender — client-side hybrid scorer.
// Mirrors the Python app.py scoring exactly so behavior is consistent.

const DATA = {
  cards: null,        // [{cardId, ...}]
  cardsById: {},      // cardId -> card
  cf: null,           // {rateableIds: [], pairs: {"a-b": sim}}
  image: null,        // {ids: [], pairs: {"a-b": sim}}
  popularity: null,   // {cardId: {soldCount, medianPrice}}
  popMaxLog: 1.0,
  rateableSet: new Set(),
  imageSet: new Set(),
};

const DEFAULTS = { cf: 40, content: 25, image: 25, popularity: 10 };

const CONTENT_WEIGHTS = {
  Player: 3.0, Sport: 1.0, Set: 1.5, Year: 1.0,
  Parallel: 1.0, Rookie: 1.0, Auto: 1.5, Relic: 1.0,
};
const CONTENT_TOTAL = Object.values(CONTENT_WEIGHTS).reduce((a, b) => a + b, 0);

const SIGNAL_LABELS = {
  cf: "users with similar taste",
  content: "matching card attributes",
  image: "visual similarity",
  popularity: "eBay popularity",
};

const liked = new Set();
let lastReqId = 0;
let rerunTimer = null;

// ───────────────────────── data loading ─────────────────────────

async function loadAll() {
  const [cards, cf, image, pop, meta] = await Promise.all([
    fetch("data/cards.json").then(r => r.json()),
    fetch("data/cf_sims.json").then(r => r.json()),
    fetch("data/image_sims.json").then(r => r.json()),
    fetch("data/popularity.json").then(r => r.json()),
    fetch("data/meta.json").then(r => r.json()),
  ]);
  DATA.cards = cards;
  DATA.cardsById = Object.fromEntries(cards.map(c => [c.cardId, c]));
  DATA.cf = cf;
  DATA.image = image;
  DATA.popularity = pop;
  DATA.rateableSet = new Set(cf.rateableIds);
  DATA.imageSet = new Set(image.ids);

  let maxLog = 0;
  for (const v of Object.values(pop)) {
    const sold = (v && v.soldCount) || 0;
    if (sold > 0) {
      const lg = Math.log1p(sold);
      if (lg > maxLog) maxLog = lg;
    }
  }
  DATA.popMaxLog = maxLog || 1.0;

  return meta;
}

// ───────────────────────── scoring ─────────────────────────

function pairKey(a, b) {
  return a < b ? `${a}-${b}` : `${b}-${a}`;
}

function lookupPair(map, a, b) {
  if (a === b) return 1.0;
  return map[pairKey(a, b)] ?? 0.0;
}

function cfScore(cardId, seedIds) {
  if (!DATA.rateableSet.has(cardId)) return 0.0;
  const sims = [];
  for (const sid of seedIds) {
    if (!DATA.rateableSet.has(sid)) continue;
    sims.push(lookupPair(DATA.cf.pairs, cardId, sid));
  }
  if (!sims.length) return 0.0;
  return Math.max(0.0, sims.reduce((a, b) => a + b, 0) / sims.length);
}

function contentScore(cardId, seedIds) {
  const cand = DATA.cardsById[cardId];
  if (!cand) return 0.0;
  const seeds = seedIds.map(s => DATA.cardsById[s]).filter(Boolean);
  if (!seeds.length) return 0.0;

  const perSeed = seeds.map(seed => {
    let s = 0.0;
    for (const key of ["Player", "Sport", "Set", "Parallel"]) {
      const v = cand[key];
      if (v && v === seed[key] && v !== "0" && v !== 0) s += CONTENT_WEIGHTS[key];
    }
    if (cand.Year && seed.Year) {
      const diff = Math.abs(Number(cand.Year) - Number(seed.Year));
      if (diff <= 5) s += CONTENT_WEIGHTS.Year * (1 - diff / 5);
    }
    for (const flag of ["Rookie", "Auto", "Relic"]) {
      if (cand[flag] && seed[flag]) s += CONTENT_WEIGHTS[flag];
    }
    return s / CONTENT_TOTAL;
  });
  return perSeed.reduce((a, b) => a + b, 0) / perSeed.length;
}

function imageScore(cardId, seedIds) {
  if (!DATA.imageSet.has(cardId)) return 0.0;
  const sims = [];
  for (const sid of seedIds) {
    if (!DATA.imageSet.has(sid)) continue;
    sims.push(lookupPair(DATA.image.pairs, cardId, sid));
  }
  if (!sims.length) return 0.0;
  return sims.reduce((a, b) => a + b, 0) / sims.length;
}

function popularityScore(cardId) {
  const entry = DATA.popularity[String(cardId)];
  if (!entry) return 0.0;
  const sold = entry.soldCount || 0;
  if (sold <= 0) return 0.0;
  return Math.log1p(sold) / DATA.popMaxLog;
}

function normalizeWeights(w) {
  const out = { ...DEFAULTS };
  for (const k of Object.keys(out)) {
    if (typeof w[k] === "number" && w[k] >= 0) out[k] = w[k];
  }
  const total = Object.values(out).reduce((a, b) => a + b, 0) || 1;
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v / total]));
}

function scoreCard(cardId, seedIds, weights) {
  const components = {
    cf: cfScore(cardId, seedIds),
    content: contentScore(cardId, seedIds),
    image: imageScore(cardId, seedIds),
    popularity: popularityScore(cardId),
  };
  const contributions = {};
  let combined = 0;
  for (const k of Object.keys(components)) {
    contributions[k] = weights[k] * components[k];
    combined += contributions[k];
  }
  return { combined, components, contributions };
}

function recommend(seedIds, rawWeights, k = 10) {
  const weights = normalizeWeights(rawWeights);
  const seedSet = new Set(seedIds);
  const scored = [];
  for (const card of DATA.cards) {
    if (seedSet.has(card.cardId)) continue;
    const { combined, components, contributions } = scoreCard(card.cardId, seedIds, weights);
    if (combined <= 0) continue;
    scored.push({ card, combined, components, contributions });
  }
  scored.sort((a, b) => b.combined - a.combined);
  return scored.slice(0, k);
}

// ───────────────────────── explanations ─────────────────────────

function sharedAttributes(rec, seed) {
  const out = [];
  if (rec.Player && rec.Player === seed.Player) out.push(`same player (${rec.Player})`);
  if (rec.Sport && rec.Sport === seed.Sport) out.push(`same sport (${rec.Sport})`);
  if (rec.Set && rec.Set === seed.Set) out.push(`same set (${rec.Set})`);
  if (rec.Year && rec.Year === seed.Year) out.push(`same year (${rec.Year})`);
  if (rec.Parallel && rec.Parallel === seed.Parallel && rec.Parallel !== "0" && rec.Parallel !== 0) {
    out.push(`same parallel (${rec.Parallel})`);
  }
  if (rec.Rookie && seed.Rookie) out.push("both are rookie cards");
  if (rec.Auto && seed.Auto) out.push("both are autographs");
  if (rec.Relic && seed.Relic) out.push("both are relics");
  return out;
}

function explain(rec, seedIds, components, contributions) {
  const seeds = seedIds.map(s => DATA.cardsById[s]).filter(Boolean);
  const perSeed = seeds.map(seed => ({
    seedId: seed.cardId,
    seedName: seed.cardName,
    shared: sharedAttributes(rec, seed),
  }));

  const top = Object.entries(contributions).sort((a, b) => b[1] - a[1])[0];
  const topLabel = SIGNAL_LABELS[top[0]] || top[0];
  const parts = [`Top signal: **${topLabel}** (raw ${components[top[0]].toFixed(2)}).`];

  const pop = DATA.popularity[String(rec.cardId)];
  if (pop && pop.soldCount) {
    let msg = `eBay sold listings: ${pop.soldCount}`;
    if (pop.medianPrice) msg += `, median $${pop.medianPrice}`;
    parts.push(msg + ".");
  }

  const overlaps = [];
  for (const entry of perSeed) {
    for (const s of entry.shared) {
      if (!overlaps.includes(s)) overlaps.push(s);
    }
  }
  if (overlaps.length) parts.push("Shares with your picks: " + overlaps.join(", ") + ".");

  return { summary: parts.join(" "), perSeed };
}

// ───────────────────────── rendering ─────────────────────────

const grid = document.getElementById("grid");
const recGrid = document.getElementById("recGrid");
const results = document.getElementById("results");
const seedBanner = document.getElementById("seedBanner");
const statusEl = document.getElementById("status");
const recommendBtn = document.getElementById("recommend");
const reshuffleBtn = document.getElementById("reshuffle");
const resetBtn = document.getElementById("resetWeights");
const countEl = document.getElementById("count");

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, ch => ({
    "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"
  }[ch]));
}

function badges(c) {
  const b = [];
  if (c.Rookie) b.push(["rookie", "Rookie"]);
  if (c.Auto) b.push(["auto", "Auto"]);
  if (c.Relic) b.push(["relic", "Relic"]);
  if (c.Parallel && c.Parallel !== "0") b.push(["parallel", c.Parallel]);
  if (c.NumberedTo && c.NumberedTo !== 0 && c.NumberedTo !== "0") b.push(["numbered", "/" + c.NumberedTo]);
  return b.map(([cls, txt]) => `<span class="badge ${cls}">${escapeHtml(txt)}</span>`).join("");
}

function signalBars(components) {
  const order = ["cf", "content", "image", "popularity"];
  const labels = { cf: "CF", content: "Content", image: "Image", popularity: "Pop" };
  return `<div class="signal-bars">` + order.map(k => {
    const raw = components[k] ?? 0;
    const pct = Math.max(0, Math.min(1, raw)) * 100;
    return `
      <div class="signal-bar ${k}" title="${labels[k]} ${raw.toFixed(2)}">
        <div class="fill" style="transform: scaleX(${pct/100})"></div>
        <span class="label">${labels[k]} ${raw.toFixed(2)}</span>
      </div>`;
  }).join("") + `</div>`;
}

function renderSummary(text) {
  return text.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}

function cardEl(c, { interactive = true, score = null, components = null, why = null } = {}) {
  const el = document.createElement("div");
  el.className = "card";
  if (liked.has(c.cardId) && interactive) el.classList.add("liked");
  const meta = [c.Player, c.Year, c.Sport, c.Set].filter(Boolean).join(" · ");
  const img = c.imageUrl ? `<img class="card-img" src="${escapeHtml(c.imageUrl)}" alt="" loading="lazy" onerror="this.classList.add('broken')">` : "";
  const scoreLine = score != null ? `<div class="score">score ${score.toFixed(3)}</div>` : "";
  const bars = components ? signalBars(components) : "";
  let whyHtml = "";
  if (why) {
    const items = (why.perSeed || []).map(p => {
      const shared = p.shared && p.shared.length ? " — " + p.shared.join(", ") : "";
      return `<span class="why-detail-item"><em>${escapeHtml(p.seedName || "")}</em>${escapeHtml(shared)}</span>`;
    }).join("");
    whyHtml = `<div class="why">${renderSummary(why.summary || "")}<div class="why-detail">${items}</div></div>`;
  }
  el.innerHTML = `
    ${img}
    <div class="card-name">${escapeHtml(c.cardName || "")}</div>
    <div class="card-meta">${escapeHtml(meta)}</div>
    <div class="badges">${badges(c)}</div>
    ${scoreLine}
    ${bars}
    ${whyHtml}
  `;
  if (interactive) {
    el.addEventListener("click", () => {
      if (liked.has(c.cardId)) {
        liked.delete(c.cardId);
        el.classList.remove("liked");
      } else {
        liked.add(c.cardId);
        el.classList.add("liked");
      }
      updateCount();
    });
  }
  return el;
}

function readWeights() {
  const w = {};
  document.querySelectorAll(".weight-row").forEach(row => {
    w[row.dataset.key] = Number(row.querySelector("input").value);
  });
  return w;
}

function setWeights(values) {
  document.querySelectorAll(".weight-row").forEach(row => {
    const key = row.dataset.key;
    const input = row.querySelector("input");
    const val = row.querySelector(".val");
    input.value = values[key];
    val.textContent = values[key];
  });
}

function updateCount() {
  countEl.textContent = `${liked.size} liked`;
  recommendBtn.disabled = liked.size === 0;
}

function loadSample() {
  liked.clear();
  results.style.display = "none";
  recGrid.innerHTML = "";
  grid.innerHTML = "";
  // Sample 12 random cards from the full pool (not just rateable).
  const pool = DATA.cards.slice();
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const sample = pool.slice(0, 12);
  for (const c of sample) grid.appendChild(cardEl(c));
  updateCount();
}

function getRecs() {
  if (liked.size === 0) return;
  const reqId = ++lastReqId;
  recommendBtn.disabled = true;
  recommendBtn.textContent = "Thinking…";
  // setTimeout so the spinner can paint before the synchronous scoring runs.
  setTimeout(() => {
    if (reqId !== lastReqId) return;
    try {
      const seeds = [...liked];
      const recs = recommend(seeds, readWeights(), 10);
      const seedNames = seeds.map(id => DATA.cardsById[id]?.cardName).filter(Boolean);
      seedBanner.innerHTML = `Based on ${seedNames.length} liked card${seedNames.length === 1 ? "" : "s"}: ${escapeHtml(seedNames.join(" · "))}`;
      recGrid.innerHTML = "";
      if (!recs.length) {
        recGrid.innerHTML = '<div class="empty">No recommendations found. Try liking different cards or adjusting weights.</div>';
      } else {
        for (const r of recs) {
          const why = explain(r.card, seeds, r.components, r.contributions);
          recGrid.appendChild(cardEl(r.card, {
            interactive: false,
            score: r.combined,
            components: r.components,
            why,
          }));
        }
      }
      results.style.display = "block";
    } finally {
      recommendBtn.textContent = "Recommend";
      recommendBtn.disabled = liked.size === 0;
    }
  }, 0);
}

function debounceRerun() {
  clearTimeout(rerunTimer);
  rerunTimer = setTimeout(() => getRecs(), 250);
}

document.querySelectorAll(".weight-row input").forEach(input => {
  input.addEventListener("input", () => {
    const row = input.closest(".weight-row");
    row.querySelector(".val").textContent = input.value;
    if (liked.size > 0 && results.style.display !== "none") debounceRerun();
  });
});

resetBtn.addEventListener("click", () => {
  setWeights(DEFAULTS);
  if (liked.size > 0 && results.style.display !== "none") getRecs();
});

reshuffleBtn.addEventListener("click", loadSample);
recommendBtn.addEventListener("click", getRecs);

// ───────────────────────── boot ─────────────────────────

loadAll().then(meta => {
  const imgOk = meta.imageEmbeddings > 0
    ? `<span class="ok">✓ ${meta.imageEmbeddings} image embeddings</span>`
    : `<span class="miss">⚠ no image embeddings</span>`;
  const popOk = meta.popularityEntries > 0
    ? `<span class="ok">✓ ${meta.popularityEntries} popularity entries</span>`
    : `<span class="miss">⚠ no popularity data (slider has no effect until you run fetch_popularity.py)</span>`;
  statusEl.innerHTML = `${meta.totalCards} cards · ${meta.rateableCards} with rating vectors. ${imgOk} · ${popOk}`;
  loadSample();
}).catch(err => {
  statusEl.innerHTML = `<span class="miss">Failed to load data: ${escapeHtml(err.message)}</span>`;
});
