// © 2026 Dennis Thielsch – Alle Rechte vorbehalten / All rights reserved.
// Kein Kopieren, Verändern oder Weitergeben ohne schriftliche Genehmigung. Siehe LICENSE.
//
// Abenteuer-Planer: Abenteuer wählen → pro Lager die beste Aufstellung mit den eigenen
// Generälen/Einheiten. Erst sofort aus der Hall of Fame (gefiltert + exakter Talent-Match),
// dann optional per Knopf lokal berechnet (geteilte GA-Engine core.solveChainsGA, je Lager
// sequentiell, Live-Update, Mehrwellen-Autoerkennung). Verbesserungen gehen an die HoF zurück.
import * as core from "./core.js?v=20260628111218";
import { loadProfile } from "./profile_store.js?v=20260628111218";
const { ADVENTURES, NORMAL_UNITS, SPECIAL_UNITS, GENERALS, UMAP, TALENTS,
  byOrder, troopsSpec, specAbbr, parseTalents, parseSpec, lossRanges, wavesLossRangesA,
  enemyTotalStacks, enemyKeyFromSpec, enemySpecStr, hasMap, mapSrc } = core;

const PLAN_STEP = 25;          // feste Schrittweite im Planer (volle Truppen)
const PLAN_MAX_WAVES = 3;      // Obergrenze der Wellen-Autoerkennung
// Wie viele Lager NEBENLÄUFIG über die gemeinsame Worker-Queue gerechnet werden. Lastet die Worker
// aus, wenn ein einzelnes Lager-GA an seiner Generationen-Barriere hängt (wenige Sims) – die Sims
// der anderen Lager füllen die freien Worker. Lohnt sich bei den teuren echten Camp-Sims (~30 %
// schneller end-to-end gemessen); bei billigen Sims würde der Main-Thread limitieren, aber die
// realen Abenteuer liegen im teuren Regime. Speicher deckelt der Pro-Worker-Heap-Recycle (core.js).
const PLAN_CAMP_CONCURRENCY = 3;
// Suche über Einheiten-Kombinationen mit max. 4 verschiedenen Spielereinheiten (+ General):
// mehr als 4 Arten je Welle ist praktisch unrealistisch und vervielfacht nur die Kombinationsmenge.
// Die Berechnung läuft in Web-Workern (Hintergrund), aktualisiert die beste Aufstellung live und
// ist jederzeit abbrechbar. 0 = kein Typen-Deckel (Vollsuche).
const PLAN_MAX_TYPES = 4;

// ---- Sprache + UI-Texte ----
const LANGS = core.LANGS;
const norm = (l) => (LANGS.includes((l || "").toLowerCase()) ? l.toLowerCase() : null);
const pathLang = () => { const m = location.pathname.match(/^\/(en|pl)(\/|$)/); return m ? m[1] : null; };
let lang = norm(new URLSearchParams(location.search).get("lang"))
  || pathLang() || norm(localStorage.getItem("tso_lang")) || "de";

const STR = {
  de: { title: "Abenteuer-Planer", betaNote: "Beta · Vorschläge aus der Hall of Fame und lokaler Berechnung.",
    navSim: "Simulator", navProfile: "Mein Profil", navPlanner: "Abenteuer-Planer",
    adventure: "Abenteuer", searchPh: "Abenteuer suchen…", filterLabel: "Meine Einheiten & Generäle",
    applyFilter: "Filter anwenden",
    modeNormal: "Normal-Abenteuer", modeSpecial: "Spezial-Abenteuer", selectAll: "Alle Lager",
    compute: "Ausgewählte Lager berechnen", cancel: "Abbrechen", editProfile: "Profil bearbeiten",
    noProfile: "Du hast noch keine Generäle/Einheiten angelegt. ", noProfileLink: "Profil anlegen",
    thCamp: "Lager", thEnemy: "Gegner", thBest: "Beste Aufstellung",
    thLossA: "Verlust Spieler", thLossB: "Verlust Gegner", thStatus: "Status",
    sector: "Sektor", cleared: "✓ geräumt", remain: "Rest", noFit: "keine passende Aufstellung",
    noUnits: "keine passenden Einheiten", fromHof: "Hall of Fame", computed: "berechnet",
    computing: "rechne…", wave: "Welle", queued: "—", combos: "Kombinationen" },
  en: { title: "Adventure Planner", betaNote: "Beta · Suggestions from the Hall of Fame and local computation.",
    navSim: "Simulator", navProfile: "My Profile", navPlanner: "Adventure Planner",
    adventure: "Adventure", searchPh: "Search adventure…", filterLabel: "My units & generals",
    applyFilter: "Apply filter",
    modeNormal: "Normal adventure", modeSpecial: "Special adventure", selectAll: "All camps",
    compute: "Compute selected camps", cancel: "Cancel", editProfile: "Edit profile",
    noProfile: "You haven't set up any generals/units yet. ", noProfileLink: "Create profile",
    thCamp: "Camp", thEnemy: "Enemy", thBest: "Best setup",
    thLossA: "Your losses", thLossB: "Enemy losses", thStatus: "Status",
    sector: "Sector", cleared: "✓ cleared", remain: "Left", noFit: "no matching setup",
    noUnits: "no matching units", fromHof: "Hall of Fame", computed: "computed",
    computing: "computing…", wave: "Wave", queued: "—", combos: "combinations" },
  pl: { title: "Planer przygód", betaNote: "Beta · Propozycje z Hall of Fame i lokalnych obliczeń.",
    navSim: "Symulator", navProfile: "Mój profil", navPlanner: "Planer przygód",
    adventure: "Przygoda", searchPh: "Szukaj przygody…", filterLabel: "Moje jednostki i generałowie",
    applyFilter: "Zastosuj filtr",
    modeNormal: "Przygoda normalna", modeSpecial: "Przygoda specjalna", selectAll: "Wszystkie obozy",
    compute: "Oblicz wybrane obozy", cancel: "Anuluj", editProfile: "Edytuj profil",
    noProfile: "Nie masz jeszcze generałów/jednostek. ", noProfileLink: "Utwórz profil",
    thCamp: "Obóz", thEnemy: "Wróg", thBest: "Najlepszy układ",
    thLossA: "Straty gracza", thLossB: "Straty wroga", thStatus: "Status",
    sector: "Sektor", cleared: "✓ wyczyszczone", remain: "Reszta", noFit: "brak pasującego układu",
    noUnits: "brak pasujących jednostek", fromHof: "Hall of Fame", computed: "obliczone",
    computing: "liczę…", wave: "Fala", queued: "—", combos: "kombinacji" },
};
const T = () => STR[lang] || STR.de;
const $ = (id) => document.getElementById(id);
const esc = core.esc;
const uname = (a) => core.uname(a, lang);
const tname = (k) => core.tname(k, lang);
const advName = (a) => core.advName(a, lang);
const iconInner = (abbr) => core.iconInner(abbr, lang);   // echtes scs-Icon, sonst Kürzel-Badge

const profile = loadProfile();
let curAdv = 0;
let camps = [];
let campState = [];
let allowedUnits = [];
let computing = false, cancelRequested = false;
// Im Planer ausgeblendete Einheiten (per Kürzel) bzw. General-Configs (per id): NICHT in `excluded`.
// General-Configs werden EINZELN geführt (man kann denselben General mehrfach mit anderen Talenten
// haben) – das Aus-/Anwählen und der Talent-Match gelten je Config, nicht je General-Kürzel.
const excluded = new Set();
const activeUnits = () => allowedUnits.filter((a) => !excluded.has(a));
const activeGenerals = () => profile.generals.filter((g) => !excluded.has(g.id));

// ---- Talent-Match (kanonisch, identisch zur Server-Speicherung canonTalents) ----
const canonCombat = (tl) => Object.keys(tl)
  .filter((k) => tl[k] > 0 && TALENTS[k] && TALENTS[k].combat).sort()
  .map((k) => `${k}.${tl[k]}`).join("-");
// Hat der Spieler eine AKTIVE General-Config mit genau diesem General + diesen Kampftalenten?
const configMatches = (general, talentsStr) =>
  activeGenerals().some((g) => g.general === general && canonCombat(g.talents) === (talentsStr || ""));
// Mehrzeiliger Chip-Tooltip einer General-Config: Bezeichnung · Generalname + Talentliste.
function configTitle(g) {
  const tals = Object.keys(g.talents).map((k) => `${tname(k)} ${g.talents[k]}`).join(", ");
  return (g.label ? `${g.label} · ` : "") + uname(g.general) + "\n" + (tals || "—");
}
const talentListStr = (str) => {
  const m = parseTalents(str);
  return Object.keys(m).map((k) => `${tname(k)} ${m[k]}`).join(", ");
};

// ---- Plan-Ergebnis (vereinheitlicht: HoF-Lösung ODER lokale Kette) ----
function chainToPR(chain) {
  const single = chain.steps.length === 1;
  const resWaves = chain.steps.map((s) => s.res);
  return {
    source: "local", chain, remain: chain.remain, score: chain.score, cleared: chain.remain === 0,
    waves: chain.steps.map((s) => ({ general: s.general, talentsStr: canonCombat(s.talents), comp: s.comp })),
    lossesA: single ? lossRanges(chain.steps[0].res.stacks_a, true) : wavesLossRangesA(resWaves),
    lossesB: single ? lossRanges(chain.steps[0].res.stacks_b, false) : lossRanges(enemyTotalStacks(resWaves), false),
  };
}
// HoF-Lösung → PR, falls fieldbar (exakter Talent-Match je Welle); sonst null.
function solToPR(s) {
  if (s.n_waves > 1) {
    let wv = []; try { wv = JSON.parse(s.waves); } catch { return null; }
    if (!wv.length || !wv.every((w) => configMatches(w.general, w.talents))) return null;
    return { source: "hof", remain: s.remain_b, score: s.score, cleared: s.remain_b === 0,
      lossesA: s.losses_a, lossesB: s.losses_b,
      waves: wv.map((w) => ({ general: w.general, talentsStr: w.talents, specStr: w.player_spec })) };
  }
  if (!configMatches(s.general, s.talents)) return null;
  return { source: "hof", remain: s.remain_b, score: s.score, cleared: s.remain_b === 0,
    lossesA: s.losses_a, lossesB: s.losses_b,
    waves: [{ general: s.general, talentsStr: s.talents, specStr: s.player_spec }] };
}
const betterPR = (a, b) => !b || core.chainCmp(a, b) < 0;

// ---- Rendering der Lager-Tabelle ----
const enemyContents = (c) => byOrder(Object.keys(c.e)).map((a) => `<div>${c.e[a]}× ${esc(uname(a))}</div>`).join("");
function bestCellHTML(pr) {
  if (!pr) return "–";
  return pr.waves.map((w, i) => {
    const army = w.specStr != null ? specAbbr(w.specStr) : specAbbr(troopsSpec(w.comp));
    const tal = talentListStr(w.talentsStr);
    const pre = pr.waves.length > 1 ? `<b>${i + 1}.</b> ` : "";
    return `<div class="sgwv">${pre}${esc(uname(w.general))}: ${esc(army)}${tal ? ` · ${esc(tal)}` : ""}</div>`;
  }).join("");
}
function statusHTML(i) {
  const cs = campState[i], t = T();
  if (cs.status === "noUnits") return `<span class="cstatus">${t.noUnits}</span>`;
  if (cs.computing) {
    const p = cs.prog, pct = p && p.total ? Math.round((p.done / p.total) * 100) : 0;
    const combos = p && p.total ? ` · ${p.done} / ${p.total} ${t.combos}` : "";
    const lbl = `${t.computing} (${t.wave} ${cs.curWaves})${combos}`;
    return `<span class="cstatus">${lbl}</span><div class="cbar"><i style="width:${pct}%"></i></div>`;
  }
  if (cs.best) {
    const tag = cs.best.source === "hof" ? t.fromHof : t.computed;
    const remain = cs.best.cleared ? t.cleared : `${t.remain} ${Math.round(cs.best.remain)}`;
    return `<span class="cstatus">${remain} · ${tag}</span>`;
  }
  return `<span class="cstatus">${t.queued}</span>`;
}
function rowHTML(i) {
  const cs = campState[i], c = camps[i], t = T();
  const lossCell = (str) => cs.best ? (core.prettyLosses(str, lang) || "–") : "–";
  return `<tr id="camp-${i}" class="${cs.computing ? "computing" : ""}">`
    + `<td><input type="checkbox" class="csel" data-i="${i}"${cs.selected ? " checked" : ""}></td>`
    + `<td class="enemy">${enemyContents(c)}</td>`
    + `<td class="best">${bestCellHTML(cs.best)}</td>`
    + `<td class="loss">${lossCell(cs.best && cs.best.lossesA)}</td>`
    + `<td class="loss">${lossCell(cs.best && cs.best.lossesB)}</td>`
    + `<td>${statusHTML(i)}</td></tr>`;
}
function renderRow(i) {
  const tr = $(`camp-${i}`); if (!tr) return;
  tr.outerHTML = rowHTML(i);
  wireRow(i);
}
function renderRowStatus(i) {
  const tr = $(`camp-${i}`); if (!tr) return;
  const cell = tr.querySelector("td:last-child");
  if (cell) cell.innerHTML = statusHTML(i);
  tr.classList.toggle("computing", !!campState[i].computing);
}
function wireRow(i) {
  const tr = $(`camp-${i}`); if (!tr) return;
  tr.querySelector(".csel").addEventListener("change", (e) => { campState[i].selected = e.target.checked; syncSelAll(); });
}
function renderTable() {
  const t = T();
  if (!camps.length) { $("camps").innerHTML = ""; return; }
  let html = `<table class="ctable"><tr><th></th><th>${t.thEnemy}</th>`
    + `<th>${t.thBest}</th><th>${t.thLossA}</th><th>${t.thLossB}</th><th>${t.thStatus}</th></tr>`;
  html += camps.map((_, i) => rowHTML(i)).join("");
  html += `</table>`;
  $("camps").innerHTML = html;
  camps.forEach((_, i) => wireRow(i));
}

// ---- Einheiten/Generäle-Filter (aus dem Profil, je Modus eingeschränkt; an-/abwählbar) ----
// Einheiten: ein Chip je Kürzel (data-key = Kürzel). Generäle: ein Chip JE CONFIG (data-key = id),
// mit Tooltip aus Bezeichnung + Talenten, damit doppelte Generäle unterscheidbar bleiben.
function renderFilter() {
  const unitChip = (a) => `<button class="uchip${excluded.has(a) ? " off" : ""}" data-key="${a}" `
    + `title="${esc(uname(a))}">${iconInner(a)}</button>`;
  const genChip = (g) => `<button class="uchip${excluded.has(g.id) ? " off" : ""}" data-key="${g.id}" `
    + `title="${esc(configTitle(g))}">${iconInner(g.general)}</button>`;
  $("filter").innerHTML = `<div class="uchips">${allowedUnits.map(unitChip).join("")}`
    + `${profile.generals.map(genChip).join("")}</div>`
    + `<button class="go" id="applyfilter" style="width:auto;margin-top:8px">${esc(T().applyFilter)}</button>`;
  // Chips schalten nur die Auswahl lokal um – die HoF wird NICHT pro Klick neu geladen (spart
  // D1-Lesezugriffe). Mehrere Einheiten lassen sich (de)aktivieren; erst „Filter anwenden“ lädt.
  $("filter").querySelectorAll(".uchip").forEach((b) => b.addEventListener("click", () => {
    const k = b.dataset.key;
    if (excluded.has(k)) excluded.delete(k); else excluded.add(k);
    b.classList.toggle("off");
  }));
  $("applyfilter").addEventListener("click", onFilterChange);
}
// In einer Welle eingesetzte Einheiten-Kürzel (lokal: comp-Objekt, HoF: player_spec-String).
const waveUnits = (w) => w.comp
  ? Object.keys(w.comp).filter((a) => w.comp[a] > 0)
  : Object.keys(parseSpec(w.specStr));
// Ist das (lokale oder HoF) Ergebnis mit den aktuell aktiven Generälen/Einheiten noch erreichbar?
const prValidForFilter = (pr) => pr.waves.every((w) =>
  configMatches(w.general, w.talentsStr) && waveUnits(w).every((a) => !excluded.has(a)));
// Filter geändert → Ergebnisse verwerfen, die eine ausgeblendete General-Config/Einheit nutzen,
// danach HoF-Vorschläge für leere Lager neu laden.
function onFilterChange() {
  camps.forEach((c, i) => {
    if (campState[i].best && !prValidForFilter(campState[i].best)) { campState[i].best = null; renderRow(i); }
  });
  fillHofAll();
}

// ---- HoF-Sofortbefüllung ----
function computeExclude() {
  const avail = new Set([...activeUnits(), ...activeGenerals().map((g) => g.general)]);
  return [...core.LIST_A, ...GENERALS].filter((a) => !avail.has(a));
}
// Erlaubte Config-Tupel "General|Talente" aus den aktiven General-Configs des Profils
// (Format identisch zur Server-Speicherung). Server filtert damit serverseitig auf fieldbar.
function allowedConfigs() {
  return activeGenerals().map((g) => `${g.general}|${canonCombat(g.talents)}`);
}
function fillHofAll() {
  const exclude = computeExclude();
  const config = allowedConfigs();
  camps.forEach((c, i) => {
    (async () => {
      try {
        // LIMIT 1: dank serverseitigem Fit (exclude + config) ist die erste Zeile schon
        // die beste fieldbare Lösung – kein clientseitiges Durchscannen von 20 mehr nötig.
        const sols = await core.fetchBest(enemyKeyFromSpec(c.e), { limit: 1, multi: true, exclude, config });
        // Besten fieldbaren HoF-Vorschlag übernehmen, wenn er das aktuelle Ergebnis (lokal oder HoF)
        // schlägt – so wird nach Filteränderung (Einheit (de)aktiviert) stets neu bewertet.
        for (const s of sols) {
          const pr = solToPR(s);
          if (pr) { if (betterPR(pr, campState[i].best)) { campState[i].best = pr; renderRow(i); } break; }
        }
      } catch { /* HoF optional */ }
    })();
  });
}

// ---- Lokale Berechnung ----
function submitPR(pr, camp) {
  const key = enemyKeyFromSpec(camp.e), advId = ADVENTURES[curAdv].id;
  const steps = pr.chain.steps;
  if (steps.length === 1) {
    const s = steps[0];
    core.submitSolution(s.res, { enemy_key: key, adventure_id: advId,
      player_spec: troopsSpec(s.comp), general: s.general, talents: canonCombat(s.talents) });
  } else {
    core.submitWavesSolution(
      { waves: steps.map((s) => s.res), cleared: steps[steps.length - 1].res.win_a },
      { enemy_key: key, adventure_id: advId,
        waveSetup: steps.map((s) => ({ general: s.general, talents: canonCombat(s.talents), player_spec: troopsSpec(s.comp) })) });
  }
}
async function computeCamp(i) {
  const cs = campState[i], camp = camps[i];
  cs.status = null;
  const genConfigs = activeGenerals().map((g) => ({ general: g.general, talents: g.talents }));
  const units = activeUnits();
  if (!genConfigs.length || !units.length) { cs.status = "noUnits"; renderRow(i); return; }
  const enemySpec = enemySpecStr(camp.e);
  const waveTpl = () => ({ generals: genConfigs, units, step: PLAN_STEP, maxArmy: true, maxTypes: PLAN_MAX_TYPES });
  const minN = cs.waveMode === "auto" ? 1 : cs.waveMode;
  const maxN = cs.waveMode === "auto" ? PLAN_MAX_WAVES : cs.waveMode;
  cs.computing = true; cs.prog = null; renderRow(i);
  let best = cs.best && cs.best.source === "local" ? cs.best : null;
  // Bestes lokales Ergebnis JE GENERAL-CONFIG sammeln (Signatur über alle Wellen), damit die HoF
  // nicht nur die allerbeste Aufstellung, sondern für jeden General seine beste Lösung erhält.
  const bestByGen = new Map();
  const genKey = (pr) => pr.waves.map((w) => `${w.general}:${w.talentsStr}`).join(">");
  const consider = (pr) => { const k = genKey(pr); if (betterPR(pr, bestByGen.get(k))) bestByGen.set(k, pr); };
  for (let n = minN; n <= maxN; n++) {
    if (cancelRequested) break;
    cs.curWaves = n; renderRowStatus(i);
    // Mehrwellen: die 1. Welle darf eine kleinere Armee nutzen (maxArmy=false) – sie weicht den
    // Gegner nur auf, eine volle Armee dort verschenkt oft Truppen. Die Folgewellen bleiben voll.
    const active = Array.from({ length: n }, (_, wi) =>
      (n > 1 && wi === 0) ? { ...waveTpl(), maxArmy: false } : waveTpl());
    const { chains, wave0Rows } = await core.solveChainsGA(active, enemySpec, {
      onProgress: (done, total) => { cs.prog = { done, total }; renderRowStatus(i); },
      onLive: (live) => { if (live && live[0]) { const pr = chainToPR(live[0]); if (betterPR(pr, best)) { best = pr; cs.best = pr; renderRow(i); } } },
      shouldStop: () => cancelRequested,
    });
    const prs = chains.map(chainToPR);
    prs.forEach(consider);
    // chains ist auf 20 gedeckelt und kann von einem starken General dominiert werden → für die
    // restlichen Generäle die beste Einzelwellen-Zeile aus wave0Rows ergänzen (je Config einmal).
    const seenG = new Set();
    for (const r of wave0Rows) {
      const gk = `${r.general}:${canonCombat(r.talents)}`;
      if (seenG.has(gk)) continue;
      seenG.add(gk);
      consider(chainToPR({ steps: [{ comp: r.comp, res: r.res, general: r.general, talents: r.talents }],
        remain: r.remain, score: r.score }));
    }
    if (prs.length) { if (betterPR(prs[0], best)) best = prs[0]; cs.best = best; renderRow(i); }
    if (best && best.remain === 0) break;          // geräumt → keine weitere Welle nötig
  }
  cs.computing = false; cs.prog = null; renderRow(i);
  for (const pr of bestByGen.values()) if (pr.chain) submitPR(pr, camp);
}
async function computeSelected() {
  if (computing) return;
  computing = true; cancelRequested = false; toggleCompute();
  await core.whenReady();
  // Ausgewählte Lager auf PLAN_CAMP_CONCURRENCY „Lanes" verteilen, die parallel laufen und sich die
  // Lager der Reihe nach greifen. Alle teilen sich die EINE globale Worker-Queue (core.js), sodass
  // freie Worker immer von irgendeinem Lager Arbeit bekommen. Den Speicher deckelt der Pro-Worker-
  // Heap-Recycle – deshalb kein globales Pool-Recycle zwischen den Lagern (würde fremde, gerade
  // laufende Lager mitten in der Sim beenden).
  const todo = camps.map((_, i) => i).filter((i) => campState[i].selected);
  let next = 0;
  const lane = async () => {
    while (!cancelRequested) {
      const k = next++;
      if (k >= todo.length) break;
      await computeCamp(todo[k]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PLAN_CAMP_CONCURRENCY, todo.length) }, lane));
  computing = false; cancelRequested = false; toggleCompute();
}
function toggleCompute() {
  $("compute").disabled = computing;
  $("cancel").hidden = !computing;
}

// ---- Abenteuerwahl ----
function buildAdvSelect(filter) {
  const q = (filter || "").trim().toLowerCase();
  const opts = ADVENTURES.map((a, i) => ({ a, i }))
    .filter(({ a, i }) => i === curAdv || !q || advName(a).toLowerCase().includes(q))
    .sort((x, y) => advName(x.a).localeCompare(advName(y.a)));
  $("adv").innerHTML = opts.map(({ a, i }) =>
    `<option value="${i}"${i === curAdv ? " selected" : ""}>${esc(advName(a))}</option>`).join("");
}
// Blankokarte zum Abenteuer (web/img/maps/<id>.jpg), falls vorhanden – sonst leer (CSS blendet aus).
function renderAdvMap(adv) {
  $("advmap").innerHTML = hasMap(adv.id)
    ? `<img src="${mapSrc(adv.id)}" alt="${esc(advName(adv))}" loading="lazy">` : "";
}

function selectAdv(i) {
  curAdv = i;
  const adv = ADVENTURES[curAdv];
  const modeSet = new Set(adv.unitMode === "special" ? SPECIAL_UNITS : NORMAL_UNITS);
  allowedUnits = byOrder(profile.units.filter((a) => modeSet.has(a)));
  camps = adv.camps;
  campState = camps.map(() => ({ selected: true, waveMode: "auto", best: null, computing: false, prog: null, curWaves: 0, status: null }));
  const t = T();
  $("modebadge").className = `modebadge${adv.unitMode === "special" ? " special" : ""}`;
  $("modebadge").textContent = adv.unitMode === "special" ? t.modeSpecial : t.modeNormal;
  renderAdvMap(adv);
  renderFilter();
  renderTable();
  syncSelAll();
  fillHofAll();
}

// ---- Navigation + Sprache ----
function renderNav() {
  const t = T();
  $("nav").innerHTML = [
    ["/", t.navSim, false], ["profil.html", t.navProfile, false], ["planer.html", t.navPlanner, true],
  ].map(([href, label, on]) => `<a href="${href}" class="${on ? "on" : ""}">${esc(label)}</a>`).join("");
}
function syncSelAll() {
  const all = campState.length && campState.every((c) => c.selected);
  $("selall").checked = all;
}
function applyLang() {
  document.documentElement.lang = lang;
  const t = T();
  $("title").textContent = t.title;
  document.title = `${t.title} – Die Siedler Online Kampfsimulator`;
  $("betanote").textContent = t.betaNote;
  $("advlabel").textContent = t.adventure;
  $("advsearch").placeholder = t.searchPh;
  $("filterlabel").textContent = t.filterLabel;
  $("selalllabel").textContent = t.selectAll;
  $("compute").textContent = t.compute;
  $("cancel").textContent = t.cancel;
  for (const l of LANGS) $(`lang-${l}`).classList.toggle("on", l === lang);
  // Profil leer?
  const empty = !profile.generals.length || !profile.units.length;
  const np = $("noprofile");
  np.hidden = !empty;
  np.innerHTML = empty ? `${esc(t.noProfile)}<a href="profil.html">${esc(t.noProfileLink)}</a>` : "";
  $("compute").disabled = empty || computing;
  renderNav();
  buildAdvSelect($("advsearch").value);
  selectAdv(curAdv);
}

// ---- Verdrahtung ----
$("adv").addEventListener("change", (e) => selectAdv(parseInt(e.target.value, 10) || 0));
$("advsearch").addEventListener("input", (e) => buildAdvSelect(e.target.value));
$("selall").addEventListener("change", (e) => {
  campState.forEach((c, i) => { c.selected = e.target.checked; const cb = document.querySelector(`#camp-${i} .csel`); if (cb) cb.checked = e.target.checked; });
});
$("compute").addEventListener("click", computeSelected);
$("cancel").addEventListener("click", () => { cancelRequested = true; });
for (const l of LANGS) $(`lang-${l}`).addEventListener("click", () => {
  lang = l; localStorage.setItem("tso_lang", l); applyLang();
});

applyLang();
