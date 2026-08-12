const fs = require("fs"), path = require("path");
const { JSDOM } = require("jsdom");
const DOCS = path.join(__dirname, "..", "docs");
const html = fs.readFileSync(path.join(DOCS, "index.html"), "utf8");

let fails = 0;
const check = (l, c, e = "") => { if (c) console.log("ok   " + l); else { fails++; console.log(`FAIL ${l} ${e}`); } };
const wait = ms => new Promise(r => setTimeout(r, ms));

function boot(localChase) {
  const dom = new JSDOM(html, {
    runScripts: "dangerously", url: "https://geraldno20.github.io/cards/",
    beforeParse(w) {
      if (localChase) w.localStorage.setItem("gy-cards-chase-v1", JSON.stringify(localChase));
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
      // jsdom has no <dialog> modal behaviour in older builds; make it observable.
      if (!w.HTMLDialogElement.prototype.showModal) {
        w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
        w.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new w.Event("close")); };
      }
    },
  });
  const { window } = dom, d = window.document;
  for (const f of ["app.js", "transactions.js", "chase.js", "staging.js"]) window.eval(fs.readFileSync(path.join(DOCS, f), "utf8"));
  window.eval(html.slice(html.lastIndexOf("<script>") + 8, html.lastIndexOf("</script>")));
  return { window, d, $: id => d.getElementById(id) };
}

(async () => {
  // ── the set-name split, against the user's own manufacturer vocabulary ──
  {
    const { d, $, window } = boot();
    await wait(500);
    d.querySelector('.tab[data-tab="chase"]').click();
    const rows = [...d.querySelectorAll("#chaseBody tr")];
    check("buy button on every row", rows[0].querySelector(".chase-buy") !== null);

    rows[17].querySelector(".chase-buy").click();     // R18 Kobe Bryant
    check("dialog opened", $("buyDialog").open === true);
    check("card named", /Kobe Bryant · R18/.test($("buyCard").textContent), $("buyCard").textContent);
    check("year parsed off the set name", $("buyYear").value === "1998-99", $("buyYear").value);
    check("manufacturer matched the ledger's own", $("buyManufacturer").value === "Topps Roundball Royalty", $("buyManufacturer").value);
    check("description is the remainder", $("buyDescription").value === "Refractor", $("buyDescription").value);
    check("sport inferred from that manufacturer", $("buySport").value === "Basketball", $("buySport").value);
    check("date defaults to today", $("buyDate").value === new Date().toISOString().slice(0, 10), $("buyDate").value);
    check("from defaults to a real source", $("buyFrom").value.length > 0, $("buyFrom").value);
    check("template panel open on a new set", $("buyTemplateWrap").open === true);
    check("datalists populated", d.querySelectorAll("#ledgerFromList option").length > 3, String(d.querySelectorAll("#ledgerFromList option").length));

    // log it
    const ledgerBefore = d.querySelectorAll("#txBody tr").length;
    $("buyPrice").value = "3200";
    $("buyGrade").value = "PSA 9";
    $("buyFrom").value = "eBay";
    $("buyForm").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await wait(250);

    const kobe = [...d.querySelectorAll("#chaseBody tr")].find(tr => tr.children[3].textContent === "R18");
    check("chase row ticked", kobe.querySelector("input").checked === true);
    check("cost written to chase", kobe.querySelector('td[data-key="cost"]').textContent === "3200");
    check("grade written to chase", kobe.querySelector('td[data-key="grade"]').textContent === "PSA 9");
    check("date written to chase", kobe.querySelector('td[data-key="date"]').textContent === new Date().toISOString().slice(0, 10));
    check("ledger gained exactly one row", d.querySelectorAll("#txBody tr").length === ledgerBefore + 1, `${ledgerBefore} -> ${d.querySelectorAll("#txBody tr").length}`);
    const led = window.cardsLedger.snapshot().slice(-1)[0];
    check("ledger row has the player", led.athlete === "Kobe Bryant", led.athlete);
    check("ledger row has the number", led.number === "R18", led.number);
    check("ledger row has the split", [led.sport, led.year, led.manufacturer, led.description].join("|") === "Basketball|1998-99|Topps Roundball Royalty|Refractor", [led.sport, led.year, led.manufacturer, led.description].join("|"));
    check("ledger row has the money", led.purchasePrice === "3200" && led.purchaseFrom === "eBay", `${led.purchasePrice}/${led.purchaseFrom}`);
    const t = new Date();
    check("ledger date matches the ledger's own format", led.purchaseDate === `${t.getMonth() + 1}/${t.getDate()}/${t.getFullYear()}`, led.purchaseDate);
    check("chase date stays ISO", kobe.querySelector('td[data-key="date"]').textContent === t.toISOString().slice(0, 10), kobe.querySelector('td[data-key="date"]').textContent);
    check("status mentions both sides", /added to the ledger/.test($("chaseStatus").textContent), $("chaseStatus").textContent.trim());
    check("status warns the ledger needs publishing", /Save to GitHub on the Transactions tab/.test($("chaseStatus").textContent), $("chaseStatus").textContent.trim());
    check("template remembered", !!JSON.parse(window.localStorage.getItem("gy-cards-set-templates-v1"))["1998-99 topps roundball royalty refractor"]);

    // second purchase from the same set: nothing left to confirm
    const rows2 = [...d.querySelectorAll("#chaseBody tr")];
    rows2.find(tr => tr.children[3].textContent === "R1").querySelector(".chase-buy").click();
    check("template panel stays shut once known", $("buyTemplateWrap").open === false);
    check("summary shows the remembered split", /Filing as 1998-99 Topps Roundball Royalty Refractor/.test($("buyTemplateSummary").textContent), $("buyTemplateSummary").textContent);
    check("manufacturer prefilled from template", $("buyManufacturer").value === "Topps Roundball Royalty");
    check("price starts empty for a new card", $("buyPrice").value === "", $("buyPrice").value);
    $("buyCancel").click();
    check("cancel closes without logging", $("buyDialog").open === false);
    check("cancel left the row alone", [...d.querySelectorAll("#chaseBody tr")].find(tr => tr.children[3].textContent === "R1").querySelector("input").checked === false);

    // the other set parses on its own vocabulary too
    [...d.querySelectorAll("#chaseBody tr")].find(tr => tr.children[3].textContent === "T2a").querySelector(".chase-buy").click();
    check("second set: manufacturer", $("buyManufacturer").value === "Topps Stadium Club Triumvirate", $("buyManufacturer").value);
    check("second set: description", $("buyDescription").value === "Illuminator", $("buyDescription").value);
    check("second set: its own template panel opens", $("buyTemplateWrap").open === true);
    $("buyCancel").click();

    // duplicate guard
    [...d.querySelectorAll("#chaseBody tr")].find(tr => tr.children[3].textContent === "R18").querySelector(".chase-buy").click();
    check("warns when the ledger already has it", $("buyWarn").hidden === false, $("buyWarn").textContent);
    $("buyCancel").click();
  }

  // ── Match ledger ticks what you already bought ──
  {
    const { d, $, window } = boot();
    await wait(500);
    d.querySelector('.tab[data-tab="chase"]').click();
    check("starts with nothing ticked", /Got0/.test($("chaseTotals").textContent.replace(/\s/g, "")), $("chaseTotals").textContent);
    $("chaseReconcile").click();
    await wait(250);
    const trs = [...d.querySelectorAll("#chaseBody tr")];
    const hardaway = trs.find(tr => tr.children[3].textContent === "R6");
    const jamison = trs.find(tr => tr.children[3].textContent === "T15A");
    check("Hardaway R6 matched from the ledger", hardaway.querySelector("input").checked === true);
    check("his grade came across", hardaway.querySelector('td[data-key="grade"]').textContent === "PSA 9", hardaway.querySelector('td[data-key="grade"]').textContent);
    check("his price came across", hardaway.querySelector('td[data-key="cost"]').textContent === "465.99", hardaway.querySelector('td[data-key="cost"]').textContent);
    check("his date came across as ISO", hardaway.querySelector('td[data-key="date"]').textContent === "2026-08-02", hardaway.querySelector('td[data-key="date"]').textContent);
    check("Jamison T15A matched", jamison.querySelector("input").checked === true);
    check("raw card left ungraded", jamison.querySelector('td[data-key="grade"]').textContent === "", jamison.querySelector('td[data-key="grade"]').textContent);
    const mourning = trs.find(tr => tr.children[3].textContent === "T10B");
    check("Mourning T10B matched despite a looser manufacturer", mourning.querySelector("input").checked === true);
    check("exactly three matched", /Got3/.test($("chaseTotals").textContent.replace(/\s/g, "")), $("chaseTotals").textContent);
    check("status names all three", ["Anfernee Hardaway R6", "Antawn Jamison T15A", "Alonzo Mourning T10B"].every(n => $("chaseStatus").textContent.includes(n)), $("chaseStatus").textContent.trim());
    check("no ledger rows were added", window.cardsLedger.snapshot().length === 410, String(window.cardsLedger.snapshot().length));
    $("chaseReconcile").click();
    await wait(150);
    check("second run is a no-op", /Nothing new to match/.test($("chaseStatus").textContent), $("chaseStatus").textContent.trim());
  }

  console.log(fails ? `\n${fails} FAILURE(S)` : "\nall purchase-flow checks passed");
  process.exit(fails ? 1 : 0);
})();
