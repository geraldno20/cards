const fs = require("fs");
const vm = require("vm");
const path = require("path");

let src = fs.readFileSync(path.join(__dirname, "..", "docs", "chase.js"), "utf8");
// Peel the IIFE so the module's internals are reachable from the test.
src = src.slice(src.indexOf('"use strict";') + 13, src.lastIndexOf("window.initChase"));

const store = {};
const ctx = {
  console,
  localStorage: {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
  },
  document: { getElementById: () => null, addEventListener: () => {}, querySelectorAll: () => [] },
  window: { addEventListener: () => {} },
  location: { hostname: "geraldno20.github.io", pathname: "/cards/" },
  setTimeout, clearTimeout, TextEncoder, btoa,
};
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(src + "\n;globalThis.__api = { splitChecklistLine, addSet, importRows, toCSV, parseCSV, natKey, rows: () => rows, setList, visibleRows, truthy, num };", ctx);
const api = ctx.__api;

let fails = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fails++; console.log(`FAIL ${label}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); }
  else console.log(`ok   ${label}`);
};

// ── checklist line parsing, in the shapes a set list actually arrives in ──
eq("tab",        api.splitChecklistLine("R1\tMichael Jordan"),   { number: "R1", player: "Michael Jordan" });
eq("wide space", api.splitChecklistLine("R10    Mitch Richmond"), { number: "R10", player: "Mitch Richmond" });
eq("one space",  api.splitChecklistLine("R9 Shaquille O'Neal"),  { number: "R9", player: "Shaquille O'Neal" });
eq("comma",      api.splitChecklistLine("R18, Kobe Bryant"),     { number: "R18", player: "Kobe Bryant" });
eq("swapped",    api.splitChecklistLine("Kevin Garnett\tR2"),    { number: "R2", player: "Kevin Garnett" });
eq("name only",  api.splitChecklistLine("Vin Baker"),            { number: "", player: "Vin Baker" });
eq("blank",      api.splitChecklistLine("   "),                  null);

// ── the published seed file round-trips ──
const csv = fs.readFileSync(path.join(__dirname, "..", "docs", "data", "chase.csv"), "utf8");
const SEED = csv.trimEnd().split("\n").length - 1;
const { added, skipped } = api.importRows(csv);
eq("seed row count", added, SEED);
eq("seed skipped", skipped, 0);
const r = api.rows();
eq("first row", [r[0].set, r[0].player, r[0].number, r[0].got], ["1998-99 Topps Roundball Royalty Refractor", "Michael Jordan", "R1", false]);
eq("row 20", [r[19].player, r[19].number], ["Vin Baker", "R20"]);
eq("last row", [r[SEED-1].player, r[SEED-1].number], ["Vince Carter", "T16C"]);
eq("trio row", [r[20].player, r[20].number], ["Kenny Anderson", "T1a"]);
eq("two sets seeded", api.setList().length, 2);
eq("first set name", api.setList()[0], "1998-99 Topps Roundball Royalty Refractor");
eq("csv round-trips byte-for-byte", api.toCSV(), csv);

// ── got / cost survive a round trip, and apostrophes don't break the CSV ──
r[8].got = true; r[8].grade = "PSA 9"; r[8].cost = "425.00"; r[8].date = "2026-07-14";
const out = api.toCSV();
eq("got serializes", out.split("\n")[9], "yes,1998-99 Topps Roundball Royalty Refractor,Shaquille O'Neal,R9,PSA 9,425.00,2026-07-14");
const reparsed = api.parseCSV(out);
eq("reparse width", reparsed[9].length, 7);

// ── natural sort puts R2 ahead of R10 ──
const nums = ["R1","R2","R10","R11","R20","R3"].map(api.natKey).sort();
eq("natural order", nums.map(k => k.replace(/^r0+/, "R")), ["R1","R2","R3","R10","R11","R20"]);

// ── truthy flags from the CSV ──
eq("truthy yes", [api.truthy("yes"), api.truthy("TRUE"), api.truthy("x"), api.truthy(""), api.truthy("no")], [true,true,true,false,false]);

// ── adding a second set from a pasted checklist ──
const n = api.addSet("2003-04 Topps Chrome Refractor", "111\tLeBron James\n222, Carmelo Anthony\nDwyane Wade");
eq("addSet count", n, 3);
eq("addSet sets", api.setList().length, 3);
const all = api.rows();
eq("addSet parsed", all.slice(-3).map(x => [x.number, x.player]), [["111","LeBron James"],["222","Carmelo Anthony"],["","Dwyane Wade"]]);

console.log(fails ? `\n${fails} FAILURE(S)` : "\nall assertions passed");
process.exit(fails ? 1 : 0);
