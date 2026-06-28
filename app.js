// © 2026 Dennis Thielsch – Alle Rechte vorbehalten / All rights reserved.
// Kein Kopieren, Verändern oder Weitergeben ohne schriftliche Genehmigung. Siehe LICENSE.
//
// Web-Frontend für den analytischen Kampf-Löser (WASM-Kern).
// Spielereinheiten links, Gegner rechts; Reihenfolge = interne order-Zahl.
// Zweisprachig (DE/EN), umschaltbar über die Flaggen.
// Der WASM-Solver läuft in einem Pool von Web Workern (je ein WASM-Kern pro Worker),
// damit der Haupt-Thread während langer Berechnungen reagiert und mehrere CPU-Kerne
// genutzt werden. Den Katalog liefert der erste bereite Worker.
// Gemeinsamer, DOM-freier Kern (Daten, Worker-Pool, Solver, Scoring, Hall-of-Fame-Client).
// app.js ist nur noch die DOM-/Render-Schicht der Klassik-Seite; die Kampf-/Bewertungslogik
// teilt sie sich mit profil.js/planer.js über core.js (keine Duplikation der Engine-Mathematik).
import * as core from "./core.js?v=20260628111218";
const {
  catalog, UMAP, byOrder, GENERALS, LIST_A, DEFAULT_GEN, WORKER_COUNT,
  EPS, QUANT, API_BASE, NO_SUBMIT, AUTO_BEAM,
  ADVENTURES, LANGS, LUTS, TALENTS, TTREE, fmt,
  recycleWorkerPool, runBatch,
  autoCompositions, autoComboCount, collapseEnemyMain, rankAutoRows,
  enemyRemain, scoreOf, span, mean, troopsSpec, parseSpec, specAbbr,
  parseTalents, esc, lossRanges, wavesLossRangesA, prettyLosses,
  playerTotalStacks, enemyTotalStacks, genCapFor, enemyKeyFromSpec,
  submitSolution, submitWavesSolution, tCost, tEffLvl, tMaxLvl, tRows,
} = core;

// Bricht den Rechen-Status ab und zeigt einen Fehler (statt endlosem Spinner).
function showComputeError() {
  setComputing(false);
  if (out) out.innerHTML = `<p class="err">${T().err}</p>`;
}
core.setWorkerErrorHandler(showComputeError);              // Worker-Crash → Spinner zurücksetzen
core.setSolutionSavedHandler(() => { bestKey = null; });   // HoF-Speichern → Vorschlags-Cache leeren

// ---- Spieler-Einheiten/Generäle/Abenteuer/Talente: alle Daten kommen aus core.js ----
const DEFAULTS = {};   // alle Einheiten starten leer (0); Default-General bleibt „General"
// Forum-Thread, in dem Feedback gesammelt wird (Beta-Hinweis verlinkt darauf).
const FORUM_URL = "https://forum.diesiedleronline.de/threads/58444-Simulator-Webbasierter-Die-Siedler-Online-Kampfsimulator";
// Talentname je Sprache (Kern nimmt die aktive Sprache als Argument).
const tname = (k) => core.tname(k, lang);
// Angriffswellen: jede Welle hat eigenen General, Talente und Truppen. Die aktive
// Welle (curWave) wird über die bestehenden Widgets (#gen, #talents, #side_a)
// bearbeitet; talentLvl IST per Referenz die Talentauswahl der aktiven Welle.
const MAX_WAVES = 5;
const newWave = () => ({ general: DEFAULT_GEN, talents: {}, troops: {}, autoTypes: [], maxArmy: true });
let waves = [newWave()];
let curWave = 0;
let talentLvl = waves[0].talents;   // key -> gewählte Stufe (0..max); = aktive Welle
// ---- Auto-Modus: statt fester Stückzahlen wählt der Nutzer pro Welle nur Einheiten-TYPEN
// (Checkboxen) + eine gemeinsame Schrittweite; der Simulator variiert die Verteilung dieser
// Typen über die Generals-Kapazität (Summe = aufgefüllt) und sucht die beste Aufstellung. ----
let mode = localStorage.getItem("tso_mode") === "auto" ? "auto" : "manual";
let autoStep = parseInt(localStorage.getItem("tso_autostep"), 10) || 10;
const AUTO_STEPS = [5, 10, 20, 25, 50];
const AUTO_WARN_COMBOS = 200;   // ab hier Warnfarbe an der Schätzung
// AUTO_BEAM (Strahlbreite der Mehrwellen-Suche) kommt aus core.js.
let autoLast = null;            // letztes Auto-Ergebnis (für „Übernehmen")
let autoCancel = false;         // Auto-Suche abgebrochen (Cancel-Knopf) → GA-Suche stoppen
let curAdv = 0;
const advUnits = () => ADVENTURES[curAdv].units;
const advCamps = () => ADVENTURES[curAdv].camps;

// ---- Internationalisierung: alle Texte in web/i18n/<lang>.json (fmt kommt aus core.js) ----
// Sprache: 1. ?lang= (Alt-Links)  2. Pfad-Locale /en/ bzw. /pl/ (SEO-Sprachseiten)
// 3. gespeicherte Präferenz (nur auf der Wurzelseite)  4. Deutsch.
const norm = (l) => (LANGS.includes((l || "").toLowerCase()) ? l.toLowerCase() : null);
const pathLang = () => {
  const m = location.pathname.match(/^\/(en|pl)(\/|$)/);
  return m ? m[1] : null;
};
const qlang = new URLSearchParams(location.search).get("lang");
let lang = norm(qlang) || pathLang() || norm(localStorage.getItem("tso_lang")) || "de";
const T = () => LUTS[lang].ui;
const uname = (abbr) => core.uname(abbr, lang);

// ---- Einheiten-Icons (web/img/<id>.png) ----
// Markup kommt zentral aus core.iconInner (echtes scs-Icon, sonst Kürzel-Badge); hier nur
// die aktuelle Sprache anbinden. Das Manifest (core) verhindert 404-Proben.
const iconInner = (abbr) => core.iconInner(abbr, lang);

function modTarget(tg) {
  if (!tg) return "";
  const m = T().mod;
  if (m.grp[tg]) return m.grp[tg];
  // Modifier-Ziel ist jetzt direkt die scs-Klassen-Id == unser Kürzel (z. B. "Soldier").
  if (UMAP[tg]) return uname(tg);
  return tg;
}

// Fasst die Modifierliste eines Generals zu lesbaren Zeilen zusammen
// (gruppiert nach Seite+Ziel, Min/Max-Schaden verschmolzen).
function modSummary(mods) {
  const m = T().mod, groups = new Map();
  for (const x of mods) {
    const key = x.sd + "|" + x.tg;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(x);
  }
  // Effekt eines Stat-Modifiers (Regel: adder≠0 ⇒ additiv, sonst multiplikativ;
  // ×0 = harter Wegfall, z. B. Dazzle). isAcc: Genauigkeits-Adder in Prozentpunkten.
  const stat = (x, label, isAcc) => {
    if (x.a) return isAcc ? `${label} +${x.a} %` : `${label} +${x.a}`;
    if (x.m === 0) return isAcc ? m.accZero : `${label} ×0`;
    const p = Math.round((x.m - 1) * 100);
    return `${label} ${p > 0 ? "+" : ""}${p} %`;
  };
  const lines = [];
  for (const [key, list] of groups) {
    const [sd, tg] = key.split("|");
    const who = sd === "1" ? m.enemy : m.own;
    const tgt = modTarget(tg);
    const effs = [];
    const byItem = Object.fromEntries(list.map((x) => [x.it, x]));
    if (byItem.hp) effs.push(stat(byItem.hp, m.hp));
    // Min/Max-Schaden mit gleichem Effekt → eine "Schaden"-Angabe
    const dn = byItem.dmin, dx = byItem.dmax;
    if (dn && dx && dn.m === dx.m && dn.a === dx.a) effs.push(stat(dn, m.dmg));
    else { if (dn) effs.push(stat(dn, `${m.dmg} min`)); if (dx) effs.push(stat(dx, `${m.dmg} max`)); }
    if (byItem.acc) effs.push(stat(byItem.acc, m.acc, true));
    if (byItem.gain_splash) {
      const ch = byItem.gain_splash.c;
      effs.push(ch != null && ch < 1 ? fmt(m.splashChance, { p: Math.round(ch * 100) }) : m.gainSplash);
    }
    if (byItem.gain_flank) effs.push(m.gainFlank);
    if (byItem.lose_splash) effs.push(m.loseSplash);
    if (byItem.lose_flank) effs.push(m.loseFlank);
    if (byItem.battle_frenzy) effs.push(`${m.frenzy} +${byItem.battle_frenzy.a} %`);
    if (byItem.double_attack) effs.push(m.twice);
    if (effs.length) lines.push(`${who}${tgt ? " " + tgt : ""}: ${effs.join(", ")}`);
  }
  return lines;
}

function specials(u) {
  const ab = T().ab, s = [];
  if (u.phase === 1) s.push(ab.first);
  if (u.phase === 3) s.push(ab.last);
  if (u.flank) s.push(ab.flank);
  if (u.area) s.push(ab.area);
  if (u.mods && u.mods.length) s.push(...modSummary(u.mods));
  return s;
}
function tooltip(u) {
  const t = T(), sp = specials(u);
  return [uname(u.abbr),
          `${t.hp}: ${u.hp}`,
          `${t.dmg}: ${u.dmin}–${u.dmax}`,
          `${t.acc}: ${Math.round(u.acc * 100)} %`,
          ...(u.cap ? [fmt(t.maxTroops, { n: u.cap })] : []),   // nur Generäle haben eine Kapazität
          ...sp].join("\n");
}

// ---- Panel aufbauen (Werte bleiben beim Sprachwechsel erhalten).
//      arrows: "full" (▲ Maximum / ▼ 0, Spieler) | "down" (nur ▼ 0, Gegner) ----
function buildPanel(el, abbrs, arrows) {
  const vals = {};
  el.querySelectorAll("input[data-abbr]").forEach((i) => { vals[i.dataset.abbr] = i.value; });
  el.innerHTML = abbrs.map((a) => {
    const u = UMAP[a];
    const v = vals[a] !== undefined ? vals[a] : (DEFAULTS[a] || "");
    const inp = `<input type="number" min="0" data-abbr="${a}" value="${v}" placeholder="0">`;
    let field = inp;
    if (arrows === "full")
      field = `<span class="field">${inp}<span class="arrows">`
        + `<button type="button" class="up" data-abbr="${a}">▲</button>`
        + `<button type="button" class="down" data-abbr="${a}">▼</button></span></span>`;
    else if (arrows === "down")
      field = `<span class="field">${inp}<span class="arrows">`
        + `<button type="button" class="down solo" data-abbr="${a}">▼</button></span></span>`;
    return `<div class="urow" data-tip="${tooltip(u)}">
      <span class="ic" data-ic="${a}">${iconInner(a)}</span>
      <span class="nm">${uname(a)}</span>
      ${field}</div>`;
  }).join("");
}

// Auto-Modus-Panel: optisch wie buildPanel (gleiche .urow-Zeilen mit Icon + Name + Tooltip),
// aber statt Zahlenfeld + ▲/▼ eine Checkbox zum An-/Abwählen des Einheiten-TYPS (beliebig viele).
function buildAutoPanel(el) {
  const sel = new Set(waves[curWave].autoTypes || []);
  el.innerHTML = LIST_A.map((a) => {
    const u = UMAP[a];
    return `<div class="urow auto" data-tip="${tooltip(u)}">
      <span class="ic" data-ic="${a}">${iconInner(a)}</span>
      <span class="nm">${uname(a)}</span>
      <span class="field"><input type="checkbox" data-abbr="${a}"${sel.has(a) ? " checked" : ""}></span></div>`;
  }).join("");
}
// Spieler-Panel je nach Modus aufbauen.
function buildSideA() {
  if (mode === "auto") buildAutoPanel($("side_a"));
  else buildPanel($("side_a"), LIST_A, "full");
}

// ▲ Auffüllen bis zur Generals-Kapazität (abzüglich anderer Spieler-Einheiten).
function fillMax(abbr) {
  const cap = genCap();
  let others = 0;
  document.querySelectorAll("#side_a input[data-abbr]").forEach((i) => {
    if (i.dataset.abbr !== abbr) others += parseInt(i.value, 10) || 0;
  });
  const v = Math.max(0, cap - others);
  document.querySelector(`#side_a input[data-abbr="${abbr}"]`).value = v > 0 ? v : "";
  updateCap();
}

// ---- Abenteuer- und Lager-Auswahl ----
function campContents(c) {
  return byOrder(Object.keys(c.e)).map((a) => `${c.e[a]}× ${uname(a)}`).join(", ");
}
const advName = (a) => core.advName(a, lang);
function buildAdvSelect(filter) {
  const q = (filter || "").trim().toLowerCase();
  const items = ADVENTURES.map((a, i) => ({ a, i }))
    .filter(({ a, i }) => i === curAdv || !q || advName(a).toLowerCase().includes(q))
    .sort((x, y) => advName(x.a).localeCompare(advName(y.a)));
  $("adv").innerHTML = items.map(({ a, i }) =>
    `<option value="${i}"${i === curAdv ? " selected" : ""}>${advName(a)}</option>`).join("");
}
function buildCampSelect() {
  const t = T();
  const adv = ADVENTURES[curAdv], camps = adv.camps;
  let html = `<option value="" selected>${t.campPick}</option>`;
  const opt = (c, i) => `<option value="${i}">${c.L ? "★ " : ""}${campContents(c)}</option>`;
  if (adv.sectors) {
    for (const s of [...new Set(camps.map((c) => c.s))]) {   // Sektoren des aktuellen Abenteuers
      html += `<optgroup label="${fmt(t.sector, { n: s })}">`;
      html += camps.map((c, i) => c.s !== s ? "" : opt(c, i)).join("");
      html += `</optgroup>`;
    }
  } else {
    html += camps.map(opt).join("");
  }
  $("camp").innerHTML = html;
}
// Klick auf ein Lager: Gegner mit der Lager-Aufstellung füllen, Spieler leeren.
function fillCamp(i) {
  const c = advCamps()[i];
  if (!c) return;
  document.querySelectorAll("#side_a input[data-abbr]").forEach((i) => { i.value = ""; });
  document.querySelectorAll("#side_b input[data-abbr]").forEach((i) => { i.value = c.e[i.dataset.abbr] || ""; });
  updateCap();
  clearSuggest();                            // andere Gegner-Aufstellung → alte Vorschläge verwerfen
}
// Abenteuerwechsel: Gegner-Spalte mit dem neuen Roster aufbauen, Lager-Liste neu.
function selectAdv(i) {
  curAdv = i;
  buildAdvSelect($("advsearch").value);     // Dropdown auf das gewählte Abenteuer setzen
  buildPanel($("side_b"), advUnits(), "down");
  buildCampSelect();
  clearSuggest();                            // anderes Abenteuer → alte Vorschläge verwerfen
}

const specOf = (panelId) => [...document.querySelectorAll(`#${panelId} input[data-abbr]`)]
  .map((i) => ({ abbr: i.dataset.abbr, n: parseInt(i.value, 10) || 0 }))
  .filter((e) => e.n > 0).map((e) => `${e.n}x${e.abbr}`).join(", ");
const specPlayer = () => [`1x${$("gen").value}`, specOf("side_a")].filter(Boolean).join(", ");

// ---- Angriffswellen: Zustand je Welle sichern/laden + Tableiste ----
function readTroops() {
  const t = {};
  document.querySelectorAll("#side_a input[data-abbr]").forEach((i) => {
    const n = parseInt(i.value, 10) || 0; if (n > 0) t[i.dataset.abbr] = n;
  });
  return t;
}
function setTroops(troops) {
  document.querySelectorAll("#side_a input[data-abbr]").forEach((i) => {
    i.value = troops[i.dataset.abbr] || "";
  });
}
// Auto-Modus: gewählte Einheiten-Typen (angekreuzte Checkboxen) ↔ Welle.
function readAutoTypes() {
  return LIST_A.filter((a) => {
    const i = document.querySelector(`#side_a input[type=checkbox][data-abbr="${a}"]`);
    return i && i.checked;
  });
}
function setAutoTypes(types) {
  const sel = new Set(types || []);
  document.querySelectorAll("#side_a input[type=checkbox][data-abbr]").forEach((i) => {
    i.checked = sel.has(i.dataset.abbr);
  });
}
function saveCurWave() {                     // Widgets → aktive Welle
  waves[curWave].general = $("gen").value;
  if (mode === "auto") { waves[curWave].autoTypes = readAutoTypes(); waves[curWave].maxArmy = $("automax").checked; }
  else waves[curWave].troops = readTroops();
  // talents (talentLvl) sind bereits per Referenz die der aktiven Welle.
}
function loadWave(idx) {                      // aktive Welle → Widgets
  curWave = idx;
  talentLvl = waves[idx].talents;
  $("gen").value = waves[idx].general;
  if (mode === "auto") setAutoTypes(waves[idx].autoTypes || []);
  else setTroops(waves[idx].troops);
  $("automax").checked = waves[idx].maxArmy !== false;
  buildTalentTree(); setTalentBtn(); updateCap();
}
function renderWaveTabs() {
  const el = $("wavetabs"); if (!el) return;
  const t = T();
  let html = "";
  waves.forEach((_, i) => {
    const x = waves.length > 1
      ? `<span class="wx" data-del="${i}" title="${t.waveRemove}">✕</span>` : "";
    html += `<button class="wavetab${i === curWave ? " on" : ""}" data-wave="${i}">`
      + `${fmt(t.wave, { n: i + 1 })}${x}</button>`;
  });
  if (waves.length < MAX_WAVES)
    html += `<button class="waveadd" id="waveadd">+ ${t.waveAdd}</button>`;
  el.innerHTML = html;
}
function selectWave(idx) {
  if (idx === curWave) return;
  saveCurWave(); loadWave(idx); renderWaveTabs();
}
function addWave() {
  if (waves.length >= MAX_WAVES) return;
  saveCurWave();
  waves.push(newWave());
  loadWave(waves.length - 1);
  renderWaveTabs();
}
function removeWave(idx) {
  if (waves.length <= 1) return;
  saveCurWave();
  waves.splice(idx, 1);
  let next = curWave;
  if (curWave === idx) next = Math.min(idx, waves.length - 1);
  else if (curWave > idx) next = curWave - 1;
  loadWave(next);
  renderWaveTabs();
}

// ---- Auto-Modus: Umschalten, Kombinatorik, Variations-Generator ----
function updateModeUI() {
  $("mode-manual").classList.toggle("on", mode === "manual");
  $("mode-auto").classList.toggle("on", mode === "auto");
  $("steprow").hidden = mode !== "auto";
}
function applyMode(m) {
  if (m === mode) return;
  saveCurWave();                              // aktuelles Panel in die Welle sichern (alter Modus)
  mode = m;
  localStorage.setItem("tso_mode", m);
  updateModeUI();
  buildSideA();                               // Panel im neuen Modus aufbauen
  if (mode === "auto") setAutoTypes(waves[curWave].autoTypes || []);
  else setTroops(waves[curWave].troops);
  updateCap();
  clearSuggest();
}
// Kombinatorik/Bewertung/Spec-Helfer liegen jetzt in core.js (geteilte Engine-Mathematik).
// Hier bleiben nur die DOM-/Sprach-Wrapper.

// ---- Geteilter Lösungscache (Cloudflare Worker + D1) -----------------------------
// Kanonischer Gegner-Schlüssel "abbr:n|abbr:m" aus den Gegner-Eingabefeldern.
function enemyKey() {
  const spec = {};
  for (const i of document.querySelectorAll("#side_b input[data-abbr]")) {
    const n = parseInt(i.value, 10) || 0;
    if (n > 0) spec[i.dataset.abbr] = n;
  }
  return enemyKeyFromSpec(spec);
}
// Talentauswahl als URL-String "Key.lvl-Key.lvl" (Standard: aktive Welle).
const talentStr = (tl = talentLvl) => core.talentStr(tl);
// Nur KAMPF-relevante Talente (für Hall of Fame / DB).
const combatTalentStr = (tl = talentLvl) => core.combatTalentStr(tl);
// Talente einer Lösung als Liste "Name Stufe" (für eigene, gestapelte Spalte).
const talentList = (str) => Object.entries(parseTalents(str)).map(([k, v]) => `${tname(k)} ${v}`);
// Baut die /best-Abfrage (URL + Cache-Schlüssel). Der HoF-Filter schickt die ausgegrauten
// Einheiten/Generäle als exclude-Liste mit; Standard (nichts ausgegraut) → keine Einschränkung.
function bestQuery() {
  const key = enemyKey();
  if (!key) return null;
  let url = `${API_BASE}/best?key=${encodeURIComponent(key)}&limit=20`;
  let cacheKey = `${key}|${showMulti ? "M" : "m"}`;
  if (!showMulti) url += `&multi=0`;          // Mehrwellen-Lösungen ausblenden
  const ex = [...hofExclude].sort().join(",");
  if (ex) { url += `&exclude=${encodeURIComponent(ex)}`; cacheKey += `|X|${ex}`; }
  return { url, cacheKey };
}

let bestKey = null, bestCandidates = [], suggestVisible = false, suggestLoading = false;
// HoF-Filter: Menge AUSGEGRAUTER (ausgeschlossener) Einheiten/Generäle; Standard leer = alle aktiv.
let hofExclude = new Set((localStorage.getItem("tso_sgexclude") || "").split(",").filter(Boolean));
let showMulti = localStorage.getItem("tso_sgmulti") !== "0";   // Mehrwellen in HoF zeigen

// Vorschläge laden (nur auf Knopfdruck / Filter-Umschalten – kein Auto-Fetch).
async function lookupBest() {
  const q = bestQuery();
  if (!API_BASE || !q) { bestKey = null; bestCandidates = []; renderSuggest(); return; }
  if (q.cacheKey !== bestKey) {
    suggestLoading = true; renderSuggest();
    try {
      const r = await fetch(q.url);
      const d = await r.json();
      const q2 = bestQuery();
      if (!q2 || q2.cacheKey !== q.cacheKey) return;   // Eingaben inzwischen geändert
      bestCandidates = d.solutions || [];
      bestKey = q.cacheKey;
    } catch { bestCandidates = []; bestKey = q.cacheKey; }
    suggestLoading = false;
  }
  renderSuggest();
}
// Aufstellungs-Zelle (General + Einheiten-Kürzel); Mehrwellen als nummerierte Liste.
function solutionArmy(s) {
  if (s.n_waves > 1) {
    let wv = []; try { wv = JSON.parse(s.waves); } catch { /* defekt */ }
    const lines = wv.map((w, i) => `<div class="sgwv"><b>${i + 1}.</b> ${esc(uname(w.general))}: ${esc(specAbbr(w.player_spec))}</div>`);
    return `<span class="sgbadge">${fmt(T().waveCountBadge, { n: wv.length })}</span>` + lines.join("");
  }
  return `${esc(uname(s.general))}: ${esc(specAbbr(s.player_spec))}`;
}
// Talente-Zelle (eigene Spalte): mehrere Talente untereinander; Mehrwellen je Welle nummeriert.
function solutionTalents(s) {
  if (s.n_waves > 1) {
    let wv = []; try { wv = JSON.parse(s.waves); } catch { /* defekt */ }
    return wv.map((w, i) => {
      const items = talentList(w.talents);
      return `<div class="sgwv"><b>${i + 1}.</b> ${items.length ? items.map(esc).join("<br>") : "–"}</div>`;
    }).join("");
  }
  const items = talentList(s.talents);
  return items.length ? items.map((x) => `<div>${esc(x)}</div>`).join("") : "–";
}
// Filter-Panel: anklickbare Einheiten-/General-Symbole (Standard alle aktiv; Klick graut aus),
// „Mehrwellen anzeigen"-Schalter und „Filter anwenden"-Button.
function hofFilterPanel() {
  const t = T();
  const icons = (abbrs) => abbrs.map((a) =>
    `<button class="sgf-ic${hofExclude.has(a) ? " off" : ""}" data-abbr="${a}" title="${esc(uname(a))}">${iconInner(a)}</button>`).join("");
  return `<div class="sgfilter">`
    + `<div class="sgf-row"><span class="sgf-lbl">${t.suggestFilterUnits}</span><div class="sgf-icons">${icons(LIST_A)}</div></div>`
    + `<div class="sgf-row"><span class="sgf-lbl">${t.suggestFilterGenerals}</span><div class="sgf-icons">${icons(GENERALS)}</div></div>`
    + `<div class="sgf-foot"><label class="sg-filter"><input type="checkbox" id="sgmulti"${showMulti ? " checked" : ""}>${t.suggestMulti}</label>`
    + `<button class="sgf-apply" id="sgapply">${t.suggestApplyFilter}</button></div></div>`;
}
// Lösungsvorschläge als Tabelle in den Ergebnisbereich (#out) rendern.
function renderSuggest() {
  if (!API_BASE) return;
  const t = T();
  let html = `<div class="suggest"><div class="sg-head"><h4>${t.suggestTitle}</h4></div>${hofFilterPanel()}`;
  if (suggestLoading) {
    html += `<p class="sg-empty">${t.computing}</p>`;
  } else if (!bestCandidates.length) {
    html += `<p class="sg-empty">${hofExclude.size ? t.suggestNoFit : t.suggestNone}</p>`;
  } else {
    html += `<table class="sgtable"><tr><th>${t.suggestArmy}</th><th>${t.talentsLabel}</th>`
      + `<th>${t.suggestLossA}</th><th>${t.suggestLossB}</th>`
      + `<th class="num">${t.suggestScore}</th><th></th></tr>`;
    bestCandidates.forEach((s, i) => {
      html += `<tr><td>${solutionArmy(s)}</td>`
        + `<td class="tal">${solutionTalents(s)}</td>`
        + `<td class="loss">${prettyLosses(s.losses_a) || "–"}</td>`
        + `<td class="loss">${prettyLosses(s.losses_b) || "–"}</td>`
        + `<td class="num">${s.score.toFixed(1)}</td>`
        + `<td><button class="apply" data-i="${i}">${t.suggestRun}</button></td></tr>`;
    });
    html += `</table>`;
  }
  out.innerHTML = html + `</div>`;
  suggestVisible = true;
  // Symbol-Klick: nur ein-/ausgrauen (Tabelle erst per „Filter anwenden" neu laden).
  out.querySelectorAll(".sgf-ic").forEach((b) => b.addEventListener("click", () => {
    const a = b.dataset.abbr;
    if (hofExclude.has(a)) hofExclude.delete(a); else hofExclude.add(a);
    localStorage.setItem("tso_sgexclude", [...hofExclude].join(","));
    renderSuggest();
  }));
  $("sgapply").addEventListener("click", () => { bestKey = null; lookupBest(); });
  $("sgmulti").addEventListener("change", (e) => {
    showMulti = e.target.checked;
    localStorage.setItem("tso_sgmulti", showMulti ? "1" : "0");
    bestKey = null; lookupBest();
  });
  out.querySelectorAll(".apply").forEach((b) =>
    b.addEventListener("click", () => runSolution(bestCandidates[+b.dataset.i])));
}
// Geladene Vorschläge entwerten (z. B. wenn sich der Gegner ändert) – ohne Server-Anfrage.
function clearSuggest() {
  bestKey = null; bestCandidates = [];
  if (suggestVisible) { out.innerHTML = ""; suggestVisible = false; }
}
// Eine Lösung in die Eingaben schreiben (General + Talente + Spieler-Truppen).
function fillFromSolution(sol) {
  if (GENERALS.includes(sol.general)) $("gen").value = sol.general;
  for (const k in talentLvl) delete talentLvl[k];
  const st = parseTalents(sol.talents);
  for (const k in st) if (TALENTS[k]) talentLvl[k] = st[k];
  tEnforceLocks(); buildTalentTree(); setTalentBtn();
  document.querySelectorAll("#side_a input[data-abbr]").forEach((i) => { i.value = ""; });
  const need = parseSpec(sol.player_spec);
  for (const a in need) { const i = document.querySelector(`#side_a input[data-abbr="${a}"]`); if (i) i.value = need[a]; }
  updateCap();
}
// Mehrwellen-Lösung in die Wellen-Eingaben übernehmen.
function applyWavesSolution(sol) {
  let wv = []; try { wv = JSON.parse(sol.waves); } catch { /* defekt */ }
  if (!wv.length) return;
  waves = wv.slice(0, MAX_WAVES).map((w) => ({
    general: GENERALS.includes(w.general) ? w.general : DEFAULT_GEN,
    talents: parseTalents(w.talents),
    troops: parseSpec(w.player_spec),
    autoTypes: [],
  }));
  curWave = 0; talentLvl = waves[0].talents;
  loadWave(0); renderWaveTabs();
}
// In den manuellen Modus zurückschalten (für „Rechnen"/„Übernehmen" aus HoF & Auto-Tabelle):
// im Auto-Modus gibt es keine Zahlenfelder, und „Berechnen" würde sonst die Auto-Suche starten.
function ensureManualMode() {
  if (mode === "manual") return;
  mode = "manual";
  localStorage.setItem("tso_mode", "manual");
  updateModeUI();
  buildSideA();
}
// „Rechnen": Aufstellung der Lösung übernehmen UND sofort die Berechnung starten.
function runSolution(sol) {
  ensureManualMode();                         // sonst keine Zahlenfelder + falscher go-Pfad
  if (sol.n_waves > 1) {
    applyWavesSolution(sol);
  } else {
    waves = [newWave()]; curWave = 0; talentLvl = waves[0].talents;
    loadWave(0); renderWaveTabs();
    fillFromSolution(sol);
  }
  $("go").click();
}
// submitSolution / submitWavesSolution liegen in core.js (sie invalidieren über den
// setSolutionSavedHandler-Hook oben den Vorschlags-Cache bestKey).

// ---- General-Talente: Budget, Zeilen-Sperren, Rendering, Modifier-String ----
// Budget-/Sperr-Mathematik liegt in core.js; hier nur Wrapper auf die aktive Welle (talentLvl).
// (tCost, tEffLvl, tRows, tMaxLvl sind direkt aus core importiert – brauchen kein talentLvl.)
const tRowPts = (r) => core.tRowPts(talentLvl, r);
const tPtsBelow = (r) => core.tPtsBelow(talentLvl, r);
const tTotal = () => core.tTotal(talentLvl);
const tRowUnlocked = (r) => core.tRowUnlocked(talentLvl, r);
function tEnforceLocks() { core.tEnforceLocks(talentLvl); }
function tCycle(r, key) {
  if (!tRowUnlocked(r)) return;
  const cur = talentLvl[key] || 0, mx = tMaxLvl(r, key), cost = tCost(key);
  let next = cur + 1;
  if (next > mx) next = 0;
  else if (tTotal() + (next - cur) * cost > TTREE.maxPoints) next = 0;   // Budget voll → zurück auf 0
  talentLvl[key] = next;
  tEnforceLocks();
  buildTalentTree();
  setTalentBtn();
  updateCap();          // Garnisonsanbau ändert das Truppenlimit
}
function tEffect(key, lvl) {           // Effektzeilen der Stufe (Stufe 1 als Vorschau bei 0)
  const tal = TALENTS[key]; if (!tal) return [];
  if (!tal.combat) return [T().talentNoCombat];
  return modSummary(tal.levels[tEffLvl(key, lvl || 1) - 1] || []);
}
function talentTip(key, lvl) {         // mehrzeiliger Tooltip-Text (Name + Effekte)
  const lines = [tname(key), ...tEffect(key, lvl)];
  if (tCost(key) > 1) lines.push(fmt(T().talentCost, { n: tCost(key) }));
  return lines.join("\n");
}
function buildTalentTree() {
  const el = $("talents"); if (!el || !tRows().length) return;
  const t = T();
  let html = `<div class="thead">${t.talentsLabel} <b>${tTotal()}/${TTREE.maxPoints}</b><a id="tclear">${t.reset}</a></div>`;
  for (let r = tRows().length - 1; r >= 0; r--) {
    const locked = !tRowUnlocked(r);
    html += `<div class="trow${locked ? " locked" : ""}">`;
    for (const key of tRows()[r]) {
      const lvl = talentLvl[key] || 0, mx = tMaxLvl(r, key), combat = TALENTS[key] && TALENTS[key].combat;
      const pips = Array.from({ length: mx }, (_, k) => `<i class="${k < lvl ? "on" : ""}"></i>`).join("");
      html += `<div class="tcell${lvl > 0 ? " active" : ""}${combat ? "" : " nocombat"}"`
            + ` data-row="${r}" data-key="${key}" data-tip="${talentTip(key, lvl)}">`
            + `<span class="tn">${tname(key)}</span><span class="pips">${pips}</span></div>`;
    }
    html += `</div>`;
  }
  el.innerHTML = html;
  el.querySelectorAll(".tcell").forEach((c) =>
    c.addEventListener("click", () => tCycle(+c.dataset.row, c.dataset.key)));
  $("tclear").addEventListener("click", () => { for (const k in talentLvl) delete talentLvl[k]; buildTalentTree(); setTalentBtn(); });
}
function setTalentBtn() {
  const b = $("talentbtn"); if (!b) return;
  const open = !$("talents").hidden;
  b.textContent = `${open ? "▾" : "▸"} ${T().talentsLabel}${tTotal() ? ` (${tTotal()}/${TTREE.maxPoints})` : ""}`;
}
// Kompakter Modifier-String für die Engine (nur Kampf-Talente) – aus core.js (Standard: aktive Welle).
const talentMods = (tl = talentLvl) => core.talentMods(tl);

// ---- Teilbarer Link: Welle 1 ohne Suffix (G=1&R=200), ab Welle 2 mit Nummer
//      (G2=1&M2=100, Talente t/t2/…). Gegner (global) ohne Suffix. ----
function buildShareURL() {
  const parts = [];
  if (curAdv > 0) parts.push(`adv=${ADVENTURES[curAdv].id}`);
  if (mode === "auto") { parts.push("mode=auto"); parts.push(`step=${autoStep}`); }
  waves.forEach((w, i) => {
    const suf = i === 0 ? "" : String(i + 1);
    parts.push(`${w.general}${suf}=1`);
    byOrder(Object.keys(w.troops).filter((a) => w.troops[a] > 0))
      .forEach((a) => parts.push(`${a}${suf}=${w.troops[a]}`));
    const tl = talentStr(w.talents);
    if (tl) parts.push(`t${suf}=${tl}`);
    if (mode === "auto" && w.autoTypes && w.autoTypes.length) {
      parts.push(`at${suf}=${w.autoTypes.join(",")}`);
      if (w.maxArmy === false) parts.push(`ma${suf}=0`);   // Standard (nur volle Armee) nicht serialisieren
    }
  });
  advUnits().forEach((a) => {                // Gegner global, ohne Suffix
    const i = document.querySelector(`#side_b input[data-abbr="${a}"]`);
    const n = i ? parseInt(i.value, 10) || 0 : 0;
    if (n > 0) parts.push(`${a}=${n}`);
  });
  // Sprach-URL aus der aktuellen Sprache (nicht aus dem Pfad), damit der geteilte
  // Link auch bei ?lang=-Altlinks zur angezeigten Sprache passt (/, /en/, /pl/).
  const base = location.origin + (lang === "de" ? "/" : `/${lang}/`);
  return base + "?" + parts.join("&");
}
function applyQuery() {
  const q = new URLSearchParams(location.search);
  const advId = q.get("adv");
  if (advId) { const k = ADVENTURES.findIndex((a) => a.id === advId); if (k > 0) selectAdv(k); }
  const lc = {};
  for (const u of catalog) lc[u.abbr.toLowerCase()] = u.abbr;
  // Kürzel + Wellen-Suffix auflösen. Falle: Kürzel können selbst auf Ziffern enden
  // (z. B. PirateBoss1) → Suffix nur abtrennen, wenn der Rest ein Kürzel ist und
  // die Zahl ≥ 2 ist (Welle 1 hat nie ein Suffix).
  const resolve = (key) => {
    if (lc[key.toLowerCase()]) return [lc[key.toLowerCase()], 0];
    const m = /^(.+?)(\d+)$/.exec(key);
    if (m && lc[m[1].toLowerCase()] && parseInt(m[2], 10) >= 2)
      return [lc[m[1].toLowerCase()], parseInt(m[2], 10) - 1];
    return null;
  };
  const wd = {};   // Wellen-Index -> { general, troops:{}, talents:"", autoTypes:[], maxArmy }
  const ens = (wi) => (wd[wi] || (wd[wi] = { general: null, troops: {}, talents: "", autoTypes: [], maxArmy: true }));
  const enemy = {};
  let any = false;
  for (const [rawK, v] of q) {
    if (rawK === "adv" || rawK === "mode" || rawK === "step") continue;
    const tm = /^t(\d*)$/.exec(rawK);
    if (tm) { ens(tm[1] ? parseInt(tm[1], 10) - 1 : 0).talents = v; any = true; continue; }
    const am = /^at(\d*)$/.exec(rawK);
    if (am) { ens(am[1] ? parseInt(am[1], 10) - 1 : 0).autoTypes = v.split(",").filter((a) => LIST_A.includes(a)); any = true; continue; }
    const mam = /^ma(\d*)$/.exec(rawK);
    if (mam) { ens(mam[1] ? parseInt(mam[1], 10) - 1 : 0).maxArmy = v !== "0"; any = true; continue; }
    const r = resolve(rawK); if (!r) continue;
    const [abbr, wi] = r; const n = parseInt(v, 10) || 0; any = true;
    if (GENERALS.includes(abbr)) ens(wi).general = abbr;
    else if (LIST_A.includes(abbr)) { if (n > 0) ens(wi).troops[abbr] = n; }
    else if (n > 0) enemy[abbr] = n;         // Gegnereinheit (global)
  }
  if (!any) return advId ? true : false;
  // Wellen aufbauen.
  const nWaves = Math.max(1, ...Object.keys(wd).map((k) => +k + 1));
  waves = [];
  for (let i = 0; i < nWaves; i++) {
    const w = newWave(); const d = wd[i];
    if (d) {
      if (d.general) w.general = d.general;
      w.troops = d.troops;
      w.autoTypes = d.autoTypes || [];
      w.maxArmy = d.maxArmy !== false;
      for (const seg of d.talents.split("-")) {
        const j = seg.lastIndexOf("."); if (j < 0) continue;
        const key = seg.slice(0, j), lv = parseInt(seg.slice(j + 1), 10) || 0;
        if (TALENTS[key] && lv > 0) w.talents[key] = lv;
      }
    }
    waves.push(w);
  }
  // Modus aus dem Link übernehmen (vor dem Panel-Aufbau, damit loadWave die Checkboxen setzt).
  if (q.get("mode") === "auto") {
    mode = "auto";
    const st = parseInt(q.get("step"), 10);
    if (AUTO_STEPS.includes(st)) autoStep = st;
    localStorage.setItem("tso_mode", "auto");
    $("autostep").value = autoStep;
    updateModeUI(); buildSideA();
  }
  // Gegner setzen.
  document.querySelectorAll("#side_b input[data-abbr]").forEach((i) => {
    i.value = enemy[i.dataset.abbr] || "";
  });
  curWave = 0; talentLvl = waves[0].talents;
  loadWave(0); tEnforceLocks(); buildTalentTree(); setTalentBtn();
  renderWaveTabs();
  return true;
}

// ---- WASM-Aufruf ----

// ---- Statistik & Ergebnis-Rendering ----
// Anzeigeschwelle/Mittelwert/Spanne (mean, span) liegen in core.js (geteiltes Tail-Quantil).
// Prozentformat fürs Histogramm: gewöhnliche Werte mit 4 Nachkommastellen, sehr kleine
// Schwanzwerte (< 0,0001 %) wissenschaftlich, damit sie nicht als „0,0000" verschwinden.
const pct = (p) => { const v = p * 100; return v > 0 && v < 1e-4 ? v.toExponential(1) : v.toFixed(4); };
let lastResult = null, lastURL = "";

// Balken über den GANZEN angezeigten Bereich [lo, hi] (= span()-Grenzen), nicht pro
// Einzelwert nach p ≥ HEPS gefiltert. Sonst klaffte das Range-Label (kumulativ, z. B. „…–161")
// mit dem letzten sichtbaren Balken (Einzel-p, z. B. 149) auseinander. Werte mit winziger
// Einzelwahrscheinlichkeit im Schwanz erscheinen als dünne Balken – konsistent zur Spanne.
function histogram(dist, label, kind, lo, hi) {
  const peak = Math.max(...dist, 1e-12);
  let rows = "";
  if (lo >= 0) for (let k = lo; k <= hi; k++) {
    const p = dist[k] || 0;
    const w = Math.max(p > 0 ? 1 : 0, Math.round((p / peak) * 100));
    rows += `<div class="hrow"><span class="k">${k}</span><span class="bar ${kind}" style="width:${w}%"></span><span class="p">${pct(p)} %</span></div>`;
  }
  return `<div class="hist"><div class="hl">${label} <span class="hr">${lo}–${hi}</span></div>${rows}</div>`;
}
// mode: "both" (Überlebende + Verluste), "surv" (nur Überlebende), "loss" (nur Verluste)
function unitBlocks(stacks, title, mode = "both") {
  const t = T();
  if (!stacks.length) return "";
  let html = `<h4>${title}</h4>`;
  for (const u of stacks) {
    let [smn, smx] = span(u.surv);
    const loss = u.surv.map((_, k) => u.surv[u.count0 - k]);
    let [lmn, lmx] = span(loss);
    // Mehrwellen-Gesamt: additive Verlustspanne (Σ der Wellen) statt schwellenbehafteter
    // Faltungsspanne; Überlebenden-Spanne entsprechend als count0 − Verlustspanne.
    if (u.lmn !== undefined) { lmn = u.lmn; lmx = u.lmx; smn = u.count0 - lmx; smx = u.count0 - lmn; }
    const lavg = u.count0 - mean(u.surv);
    const survH = histogram(u.surv, t.survivors, "surv", smn, smx);
    const lossH = histogram(loss, t.losses, "loss", lmn, lmx);
    const cols = mode === "surv" ? survH : mode === "loss" ? lossH : survH + lossH;
    const sub = mode === "surv"
      ? `${t.survivors} ${mean(u.surv).toFixed(2)}`
      : `${fmt(t.lossesOf, { who: "" }).trim()} ${lavg.toFixed(2)}`;
    html += `<div class="unit"><b>${uname(u.abbr)}</b> (${u.count0})
      <span class="sub">${sub}</span>
      <div class="cols">${cols}</div></div>`;
  }
  return html;
}
// Einzelne Welle: eigene (frische) Truppen + Verluste sowie der Gegner DIESER Welle
// (deterministischer Eintrittsbestand) – mit exakten Überlebenden UND Verlusten, da der
// Eintrittsbestand fest ist. In Folgewellen enthält stacks_b nur noch die tatsächlich
// eingetretenen Gegner-Stacks (der Kollaps lässt bereits getötete weg).
function waveBlock(w, i) {
  const t = T();
  return `<h3 class="wavehd">${fmt(t.wave, { n: i + 1 })}</h3>
    <div class="summary"><p>${t.rounds} <b>${w.rounds.toFixed(2)}</b> · `
    + `${fmt(t.lossesOf, { who: t.attacker })} <b>${mean(w.loss_a).toFixed(2)}</b></p></div>
    <div class="sides"><div>${unitBlocks(w.stacks_a, t.attacker, "both")}</div>`
    + `<div>${unitBlocks(w.stacks_b, t.defender, "both")}</div></div>`;
}

// playerTotalStacks / enemyTotalStacks (Wellen-Aggregate, Faltung) liegen in core.js.

// Gesamtergebnis (nach der letzten Welle): Detail-Histogramme wie der Einzelkampf
// (Siegchance/Verluste stehen in der Übersicht oben, daher hier keine Siegrate-Tabelle).
function totalBlock(res) {
  const t = T();
  const sides = `<div class="sides"><div>${unitBlocks(playerTotalStacks(res.waves), t.attacker, "both")}</div>`
    + `<div>${unitBlocks(enemyTotalStacks(res.waves), t.defender, "both")}</div></div>`;
  return `<h3 class="wavehd">${t.waveTotal}</h3>` + sides
    + `<p class="meta">${res.ms.toFixed(0)} ms</p>`;
}

// ---- Verlust-Übersicht (ganz oben, über den Detail-Histogrammen) ----
// Forum-Feedback #2: auf einen Blick „gewonnen?" (nur Siegchance; Unentschieden =
// Niederlage) und „wie viele Einheiten weg?" – Tabelle Einheit · min · Ø · max je
// Seite (Spieler/Gegner), je Welle und Gesamt. Detail-Histogramme bleiben darunter.
// Verlust-Kennzahlen eines Stacks: Ø sowie min/max der verbrauchten Einheiten. `count0`
// ist der Eintrittsbestand (bei Folgewellen der kollabierte Worst-Case), daher exakt.
function lossStat(u) {
  const loss = u.surv.map((_, k) => u.surv[u.count0 - k]);
  let [mn, mx] = span(loss);
  if (u.lmn !== undefined) { mn = u.lmn; mx = u.lmx; }   // Mehrwellen-Gesamt: additive Spanne
  return { abbr: u.abbr, name: uname(u.abbr), avg: u.count0 - mean(u.surv), mn, mx };
}
const lossIcon = (abbr) => `<span class="ic" data-ic="${abbr}">${iconInner(abbr)}</span>`;
// Eine Seite als Tabelle: Einheit · min · Ø · max (verbrauchte Einheiten).
function lossSideTable(stacks, title, extra) {
  const head = `<div class="lo-side-t">${title}`
    + (extra ? ` <span class="lo-meta">${extra}</span>` : "") + `</div>`;
  if (!stacks.length) return `<div class="lo-side">${head}<p class="lo-none">—</p></div>`;
  const body = stacks.map(lossStat).map((s) =>
    `<tr><td class="lo-tn">${lossIcon(s.abbr)}<span>${s.name}</span></td>`
    + `<td>${s.mn}</td><td>${s.avg.toFixed(1)}</td><td>${s.mx}</td></tr>`).join("");
  return `<div class="lo-side">${head}<table class="lotab">`
    + `<tr><th></th><th>min</th><th>∅</th><th>max</th></tr>${body}</table></div>`;
}
function lossWave(stacksA, stacksB, extraA) {
  const t = T();
  return `<div class="sides">${lossSideTable(stacksA, t.attacker, extraA)}`
    + `${lossSideTable(stacksB, t.defender)}</div>`;
}
// Rundenangabe „Runden min–max (Ø avg)".
const roundsTxt = (mn, mx, avg) =>
  `${T().roundsLabel} ${mn === mx ? mn : `${mn}–${mx}`} (∅ ${avg.toFixed(2)})`;
const winLine = (winA, mn, mx, avg) =>
  `${T().winChance} ${(winA * 100).toFixed(1)} % · ${roundsTxt(mn, mx, avg)}`;
function overviewSingle(r) {
  const t = T();
  return `<div class="overview"><div class="ovh">${t.lossOverview}</div>`
    + lossWave(r.stacks_a, r.stacks_b, winLine(r.win_a, r.rounds_min, r.rounds_max, r.rounds)) + `</div>`;
}
function overviewWaves(res) {
  const t = T();
  let html = `<div class="ovh">${t.lossOverview}</div>`;
  res.waves.forEach((w, i) => {
    html += `<div class="ovwh">${fmt(t.wave, { n: i + 1 })}</div>`
      + lossWave(w.stacks_a, w.stacks_b, roundsTxt(w.rounds_min, w.rounds_max, w.rounds));
  });
  const tot = res.waves.reduce((s, w) => ({ mn: s.mn + w.rounds_min, mx: s.mx + w.rounds_max, avg: s.avg + w.rounds }),
    { mn: 0, mx: 0, avg: 0 });
  html += `<div class="ovwh">${t.waveTotal}</div>`
    + lossWave(playerTotalStacks(res.waves), enemyTotalStacks(res.waves), winLine(res.cleared, tot.mn, tot.mx, tot.avg));
  return `<div class="overview">${html}</div>`;
}
// Detail-Histogramme (Überlebende/Verluste je Einheit) – unverändert, ohne Siegrate-Tabelle.
function detailBlock(r) {
  const t = T();
  return `<div class="sides"><div>${unitBlocks(r.stacks_a, t.attacker)}</div>`
    + `<div>${unitBlocks(r.stacks_b, t.defender)}</div></div>`;
}

function renderWaves(share, res) {
  let detail = "";
  res.waves.forEach((w, i) => { detail += waveBlock(w, i); });
  detail += totalBlock(res);
  out.innerHTML = `<div class="res-summary">${share}${overviewWaves(res)}</div>`
    + `<div class="res-detail">${detail}</div>`;
  $("shareurl").value = lastURL;
}
function render() {
  const t = T();
  suggestVisible = false;                    // Ergebnis ersetzt die Vorschlagstabelle
  const share = `<div class="share"><input id="shareurl" readonly><button id="copybtn">${t.copy}</button></div>`;
  const r = lastResult;
  if (!r) { out.innerHTML = share + `<p class="err">${t.err}</p>`; $("shareurl").value = lastURL; return; }
  if (r.waves) { renderWaves(share, r); return; }
  out.innerHTML = `<div class="res-summary">${share}${overviewSingle(r)}</div>`
    + `<div class="res-detail">${detailBlock(r)}<p class="meta">${r.ms.toFixed(0)} ms</p></div>`;
  $("shareurl").value = lastURL;
}

// ---- statische Oberflächentexte je Sprache setzen ----
// Seiten-Navigation (Simulator | Profil | Planer); Labels lokal, damit die i18n-JSONs unberührt bleiben.
const NAVSTR = {
  de: ["Simulator", "Mein Profil", "Abenteuer-Planer"],
  en: ["Simulator", "My Profile", "Adventure Planner"],
  pl: ["Symulator", "Mój profil", "Planer przygód"],
};
function renderNav() {
  const nav = $("nav"); if (!nav) return;
  const [sim, prof, plan] = NAVSTR[lang] || NAVSTR.de;
  nav.innerHTML = [["/", sim, true], ["profil.html", prof, false], ["planer.html", plan, false]]
    .map(([href, label, on]) => `<a href="${href}" class="${on ? "on" : ""}">${esc(label)}</a>`).join("");
}
function applyLang() {
  const t = T();
  renderNav();
  document.documentElement.lang = lang;
  document.title = t.docTitle;
  const md = document.querySelector('meta[name="description"]');
  if (md) md.setAttribute("content", t.metaDesc);
  $("title").textContent = t.title;
  // Beta-Hinweis + Aufruf zum Mithelfen mit Link auf den Forum-Thread (HTML, daher innerHTML).
  // {a}…{/a} im i18n-Text → Anker; Inhalt ist eigener, fester Text (kein Nutzer-Input).
  const forumLink = `<a href="${FORUM_URL}" target="_blank" rel="noopener">`;
  $("betanote").innerHTML = t.betaNotice + " "
    + t.betaFeedback.replace("{a}", forumLink).replace("{/a}", "</a>");
  // Ergebnis-Spalten heißen jetzt „Spieler"/„Gegner" → Panel-Zusatz (Angreifer/Verteidiger) entfällt.
  $("head_a").textContent = t.yours; $("hint_a").textContent = "";
  $("head_b").textContent = t.enemy; $("hint_b").textContent = "";
  $("genlabel").textContent = t.general;
  $("advlabel").textContent = t.adventure;
  $("advsearch").placeholder = t.advSearch;
  $("camplabel").textContent = t.camp;
  buildAdvSelect($("advsearch").value);
  buildCampSelect();
  $("imprintlink").textContent = t.imprint;
  $("privacylink").textContent = t.privacy;
  $("cookielink").textContent = t.cookies;
  document.querySelectorAll(".reset").forEach((b) => { b.textContent = t.reset; });
  $("go").textContent = t.compute;
  $("mode-manual").textContent = t.modeManual;
  $("mode-auto").textContent = t.modeAuto;
  $("steplabel").textContent = t.stepSize;
  $("automaxlabel").textContent = t.fullArmyOnly;
  $("autostep").innerHTML = AUTO_STEPS.map((v) => `<option value="${v}"${v === autoStep ? " selected" : ""}>${v}</option>`).join("");
  updateModeUI();
  $("suggestbtn").textContent = t.suggestLoad;
  $("suggestbtn").hidden = !API_BASE;        // Feature nur sichtbar, wenn Backend gesetzt
  $("lang-de").classList.toggle("on", lang === "de");
  $("lang-en").classList.toggle("on", lang === "en");
  $("lang-pl").classList.toggle("on", lang === "pl");
  // Generäle alphabetisch nach LOKALISIERTEM Namen (wird bei jedem applyLang neu gebaut → bei
  // Sprachwechsel automatisch neu sortiert).
  $("gen").innerHTML = [...GENERALS].sort((a, b) => uname(a).localeCompare(uname(b))).map((a) =>
    `<option value="${a}"${a === ($("gen").value || DEFAULT_GEN) ? " selected" : ""}>${uname(a)}</option>`).join("");
  buildSideA();
  buildPanel($("side_b"), advUnits(), "down");
  buildTalentTree();
  setTalentBtn();
  renderWaveTabs();
  updateCap();
  if (out.innerHTML.trim()) render();   // Ergebnis neu in der gewählten Sprache
}

// genCapFor (General-Truppenlimit inkl. Talent-Bonus) liegt in core.js.
function genCap() { return genCapFor($("gen").value, talentLvl); }
// Überschreitet eine Welle das Truppenlimit ihres Generals? Solche (unrealistischen)
// Aufstellungen dürfen gerechnet, aber NICHT in die Hall of Fame gespeichert werden.
const waveOverCap = (w) =>
  Object.values(w.troops).reduce((s, n) => s + (n > 0 ? n : 0), 0) > genCapFor(w.general, w.talents);

// Geschätzte Gesamtzahl der Kämpfe über alle aktiven Auto-Wellen (Prefix mit gewählten Typen).
// Welle 1 zählt einfach, jede Folgewelle AUTO_BEAM× (Strahlbreite). Aktuelle Welle aus den Live-
// Widgets (Kapazität kann ungespeichert sein), übrige Wellen aus dem gesicherten Wellenzustand.
function autoTotalBattles() {
  let total = 0, i = 0;
  for (const w of waves) {
    if (!(w.autoTypes && w.autoTypes.length)) break;
    const cap = i === curWave ? genCap() : genCapFor(w.general, w.talents);
    const fill = i === curWave ? $("automax").checked : w.maxArmy !== false;
    total += (i === 0 ? 1 : AUTO_BEAM) * autoComboCount(w.autoTypes.length, cap, autoStep, fill);
    i++;
  }
  return total;
}

function updateCap() {
  const cap = genCap();
  $("gen").dataset.tip = tooltip(UMAP[$("gen").value]);   // LP/Schaden/Genauigkeit/Fähigkeiten beim Hovern
  const el = $("capinfo");
  if (mode === "auto") {
    // Auto-Modus: statt „Truppen: s/c" die geschätzte Gesamtzahl der zu rechnenden Kämpfe –
    // inkl. Strahlbreite: Welle 1 einfach, jede Folgewelle AUTO_BEAM× (je verfolgter Teilkette).
    const n = autoTotalBattles();
    el.textContent = fmt(T().autoEstimate, { n });
    el.classList.toggle("over", n > AUTO_WARN_COMBOS);
    return;
  }
  const sum = [...document.querySelectorAll("#side_a input[data-abbr]")].reduce((s, i) => s + (parseInt(i.value, 10) || 0), 0);
  el.textContent = fmt(T().troops, { s: sum, c: cap });
  el.classList.toggle("over", sum > cap);
}

// ---- UI-Verdrahtung ----
const $ = (id) => document.getElementById(id);
const out = $("out");

// Sprachwechsel = Navigation zur Sprach-URL (/, /en/, /pl/) damit jede Sprache eine
// eigene, indexierbare Adresse hat. Deeplink (Query + Hash, z. B. geteilte Aufstellung)
// bleibt erhalten. Sind wir schon auf der Zielsprache, nur lokal umschalten.
const langHref = (l) => (l === "de" ? "/" : `/${l}/`) + location.search + location.hash;
function setLang(l) {
  localStorage.setItem("tso_lang", l);
  if (l === lang) return;
  location.assign(langHref(l));
}
$("lang-de").addEventListener("click", () => setLang("de"));
$("lang-en").addEventListener("click", () => setLang("en"));
$("lang-pl").addEventListener("click", () => setLang("pl"));

$("gen").addEventListener("change", updateCap);
$("mode-manual").addEventListener("click", () => applyMode("manual"));
$("mode-auto").addEventListener("click", () => applyMode("auto"));
$("autostep").addEventListener("change", (e) => {
  autoStep = parseInt(e.target.value, 10) || 10;
  localStorage.setItem("tso_autostep", autoStep);
  updateCap();
});
// „Nur volle Armee" je Welle: merken + Schätzung (mit/ohne kleinere Armeen) aktualisieren.
$("automax").addEventListener("change", () => {
  if (mode !== "auto") return;
  waves[curWave].maxArmy = $("automax").checked;
  updateCap();
});
// Auto-Modus: Checkbox an-/abwählen → Typen der aktiven Welle merken + Schätzung aktualisieren.
$("side_a").addEventListener("change", (e) => {
  if (mode !== "auto") return;
  if (!e.target.closest("input[type=checkbox][data-abbr]")) return;
  waves[curWave].autoTypes = readAutoTypes();
  updateCap();
});
$("wavetabs").addEventListener("click", (e) => {
  if (e.target.id === "waveadd") return addWave();
  const del = e.target.closest(".wx");
  if (del) { e.stopPropagation(); return removeWave(+del.dataset.del); }
  const tab = e.target.closest(".wavetab");
  if (tab) selectWave(+tab.dataset.wave);
});
$("talentbtn").addEventListener("click", () => {
  const p = $("talents"); p.hidden = !p.hidden;
  if (!p.hidden) buildTalentTree();
  setTalentBtn();
});

// ---- Eigener mehrzeiliger Tooltip (ersetzt das native title-Attribut) ----
const tipEl = $("tip");
let tipText = null;
function placeTip(x, y) {
  const r = tipEl.getBoundingClientRect();
  let px = x + 14, py = y + 16;
  if (px + r.width > innerWidth - 8) px = x - r.width - 14;
  if (py + r.height > innerHeight - 8) py = y - r.height - 16;
  tipEl.style.left = Math.max(8, px) + "px";
  tipEl.style.top = Math.max(8, py) + "px";
}
function showTip(text, x, y) {
  if (text !== tipText) {
    tipText = text;
    tipEl.innerHTML = text.split("\n")
      .map((l, i) => `<div class="${i ? "r" : "h"}">${l}</div>`).join("");
  }
  tipEl.hidden = false;
  placeTip(x, y);
}
function hideTip() { tipEl.hidden = true; tipText = null; }
document.addEventListener("mouseover", (e) => {
  const el = e.target.closest("[data-tip]");
  if (el && el.dataset.tip) showTip(el.dataset.tip, e.clientX, e.clientY);
});
document.addEventListener("mousemove", (e) => {
  if (tipEl.hidden) return;
  const el = e.target.closest("[data-tip]");
  if (el && el.dataset.tip) placeTip(e.clientX, e.clientY); else hideTip();
});
document.addEventListener("mouseout", (e) => {
  if (e.target.closest("[data-tip]")) hideTip();
});
$("side_a").addEventListener("input", updateCap);
$("side_b").addEventListener("input", clearSuggest);
$("adv").addEventListener("change", (e) => selectAdv(parseInt(e.target.value, 10)));
$("advsearch").addEventListener("input", (e) => buildAdvSelect(e.target.value));
$("camp").addEventListener("change", (e) => { if (e.target.value) fillCamp(parseInt(e.target.value, 10)); });

// Pfeile: Spieler ▲ = bis Generals-Maximum, ▼ = 0; Gegner nur ▼ = 0.
$("side_a").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-abbr]");
  if (!b) return;
  if (b.classList.contains("up")) fillMax(b.dataset.abbr);
  else { document.querySelector(`#side_a input[data-abbr="${b.dataset.abbr}"]`).value = ""; updateCap(); }
});
$("side_b").addEventListener("click", (e) => {
  const b = e.target.closest("button.down[data-abbr]");
  if (b) { document.querySelector(`#side_b input[data-abbr="${b.dataset.abbr}"]`).value = ""; clearSuggest(); }
});
document.querySelectorAll(".reset").forEach((el) => el.addEventListener("click", () => {
  document.querySelectorAll(`#side_${el.dataset.reset} input[data-abbr]`).forEach((i) => {
    if (i.type === "checkbox") i.checked = false; else i.value = "";
  });
  if (el.dataset.reset === "a") { if (mode === "auto") waves[curWave].autoTypes = []; updateCap(); }
  else clearSuggest();                      // Gegner geleert → alte Vorschläge verwerfen
}));
out.addEventListener("click", (e) => {
  if (e.target.id !== "copybtn") return;
  navigator.clipboard.writeText($("shareurl").value).then(() => {
    e.target.textContent = T().copied;
    setTimeout(() => { e.target.textContent = T().copy; }, 1500);
  });
});
// ---- Auto-Modus: genetische Suche über die Wellen (core.solveChainsGA, geteilte Engine) ----
async function runAutoSearch() {
  saveCurWave();
  // Aktive Wellen: bis zur ersten Welle ohne gewählte Typen.
  const active = [];
  for (const w of waves) { if (!(w.autoTypes && w.autoTypes.length)) break; active.push(w); }
  if (!active.length) { showComputeError(); return; }

  // Eine General-Config je Welle; kein Typen-Deckel. maxArmy aus der „automax"-Wahl der Welle.
  const activeSpec = active.map((w) => ({
    generals: [{ general: w.general, talents: w.talents }],
    units: w.autoTypes, step: autoStep, maxArmy: w.maxArmy !== false, maxTypes: 0,
  }));

  const specB = specOf("side_b");
  const eKey = enemyKey(), advId = ADVENTURES[curAdv].id;
  lastURL = buildShareURL();
  autoCancel = false;
  setComputing(true);
  setProgress(0, 1);
  await core.whenReady();
  const t0 = performance.now();

  const multi = active.length > 1;
  // Auto-Suche nutzt den genetischen Algorithmus (core.solveChainsGA): die exakte Wellen-Verkettung
  // (Gegner-Kollaps), das Ranking (Restgegner, dann Eigenverlust) und das adaptive Such-Budget
  // stecken in der geteilten Engine; hier bleibt nur Fortschritt, Live-Anzeige, Abbruch und HoF.
  let chains = [], wave0Rows = [];
  try {
    const r = await core.solveChainsGA(activeSpec, specB, {
      onProgress: (d, tot) => setProgress(d, tot),
      onLive: (live) => {
        if (multi) renderAutoLiveChains(live);
        else renderAutoLiveSingle(active[0], live.map((c) => ({ comp: c.steps[0].comp, res: c.steps[0].res })));
      },
      shouldStop: () => autoCancel,
    });
    chains = r.chains; wave0Rows = r.wave0Rows;
  } catch (err) { console.error(err); await recycleWorkerPool(); showComputeError(); return; }
  if (autoCancel) return;                       // abgebrochen → cancelCompute hat bereits aufgeräumt

  // Reine Rechenzeit messen, BEVOR das Recycling sie verfälscht; dann den WASM-Heap zurückgeben.
  const ms = performance.now() - t0;
  await recycleWorkerPool();
  setComputing(false);
  if (!chains.length && !wave0Rows.length) { showComputeError(); return; }
  autoLast = multi
    ? { chains, ms }
    : { perWave: [{ wave: 0, general: active[0].general, talents: active[0].talents, rows: wave0Rows }], ms };
  renderAutoResults(autoLast);

  // Hall of Fame: genau die angezeigten besten 20 Lösungen – Einzelwellen (Länge 1) und Mehrwellen-
  // Ketten gleichberechtigt, je nach Länge als Einwellen-Eintrag bzw. Wellen-Kette. Max. 20 Einträge,
  // sonst tausende D1-Schreibvorgänge.
  if (API_BASE && eKey && chains.length) {
    (async () => {
      for (const ch of chains) {
        if (ch.steps.length === 1) {
          const s = ch.steps[0];
          await submitSolution(s.res, { enemy_key: eKey, adventure_id: advId, player_spec: troopsSpec(s.comp), general: s.general, talents: combatTalentStr(s.talents) });
        } else {
          await submitWavesSolution(
            { waves: ch.steps.map((s) => s.res), cleared: ch.steps[ch.steps.length - 1].res.win_a },
            { enemy_key: eKey, adventure_id: advId,
              waveSetup: ch.steps.map((s) => ({ general: s.general, talents: combatTalentStr(s.talents), player_spec: troopsSpec(s.comp) })) });
        }
      }
    })();
  }
}
// Eine Wellen-Tabelle im Hall-of-Fame-Stil bauen. limit: nur die besten N Zeilen (0 = alle);
// withApply: „Übernehmen"-Spalte; multi: Wellen-Überschrift zeigen.
function autoTableHTML(pw, limit, withApply, multi) {
  const t = T();
  let html = multi ? `<div class="ovwh">${fmt(t.wave, { n: pw.wave + 1 })}</div>` : "";
  html += `<table class="sgtable"><tr><th>${t.suggestArmy}</th>`
    + `<th>${t.suggestLossA}</th><th>${t.suggestLossB}</th><th class="num">${t.suggestScore}</th>${withApply ? "<th></th>" : ""}</tr>`;
  (limit ? pw.rows.slice(0, limit) : pw.rows).forEach((r, i) => {
    html += `<tr>`
      + `<td>${esc(uname(pw.general))}: ${esc(specAbbr(troopsSpec(r.comp)))}</td>`
      + `<td class="loss">${prettyLosses(lossRanges(r.res.stacks_a, true)) || "–"}</td>`
      + `<td class="loss">${prettyLosses(lossRanges(r.res.stacks_b, false)) || "–"}</td>`
      + `<td class="num">${(r.score != null ? r.score : scoreOf(r.res)).toFixed(1)}</td>`
      + (withApply ? `<td><button class="apply" data-w="${pw.wave}" data-i="${i}">${t.suggestRun}</button></td>` : "")
      + `</tr>`;
  });
  return html + `</table>`;
}
// Mehrwellen-Auto-Ergebnis als zusammengefasste Ketten im HoF-Stil: je Zeile eine vollständige
// Kette (nummerierte Aufstellung je Welle, Badge mit Wellenzahl) mit gemeinsamer Siegrate, über
// alle Wellen summierten Spieler- und Gegnerverlusten (Gegner: Original − End-Überlebende) und Score.
// chains: [{ steps:[{comp,res,general,talents}], win, score }], bereits absteigend sortiert.
function chainRowsTableHTML(chains, limit, withApply) {
  const t = T();
  let html = `<table class="sgtable"><tr><th>${t.suggestArmy}</th>`
    + `<th>${t.suggestLossA}</th><th>${t.suggestLossB}</th><th class="num">${t.suggestScore}</th>${withApply ? "<th></th>" : ""}</tr>`;
  chains.slice(0, limit).forEach((ch, ci) => {
    const steps = ch.steps, chainRes = steps.map((s) => s.res);
    const army = `<span class="sgbadge">${fmt(t.waveCountBadge, { n: steps.length })}</span>`
      + steps.map((s, k) => `<div class="sgwv"><b>${k + 1}.</b> ${esc(uname(s.general))}: ${esc(specAbbr(troopsSpec(s.comp)))}</div>`).join("");
    html += `<tr><td>${army}</td>`
      + `<td class="loss">${prettyLosses(wavesLossRangesA(chainRes)) || "–"}</td>`
      + `<td class="loss">${prettyLosses(lossRanges(enemyTotalStacks(chainRes), false)) || "–"}</td>`
      + `<td class="num">${chainRes.reduce((s, r) => s + scoreOf(r), 0).toFixed(1)}</td>`
      + (withApply ? `<td><button class="apply" data-ci="${ci}">${t.suggestRun}</button></td>` : "")
      + `</tr>`;
  });
  return html + `</table>`;
}
// Live-Anzeige (in #autolive) während der Berechnung. Mehrwellig: die besten 20 Teilketten als
// Kettentabelle (kein „Übernehmen", da sich die Reihen noch sortieren).
function renderAutoLiveChains(chains) {
  const el = $("autolive"); if (el) el.innerHTML = chains.length ? chainRowsTableHTML(chains, 20, false) : "";
}
// Einwellig: die bisher besten 20 Aufstellungen der laufenden Welle als Tabelle.
function renderAutoLiveSingle(w, liveRows) {
  const el = $("autolive"); if (!el) return;
  const ranked = liveRows.slice(); rankAutoRows(ranked);
  el.innerHTML = ranked.length ? autoTableHTML({ wave: 0, general: w.general, rows: ranked }, 20, false, false) : "";
}
// Auto-Ergebnisse (final) im Hall-of-Fame-Stil. Einwellig: eine Tabelle mit den besten 20
// Aufstellungen. Mehrwellig: die besten 20 zusammengefassten Ketten wie in der HoF.
function renderAutoResults(data) {
  const t = T();
  let html = `<div class="suggest"><div class="sg-head"><h4>${t.autoResultsTitle}</h4></div>`;
  if (data.chains) html += chainRowsTableHTML(data.chains, 20, true);
  else html += autoTableHTML(data.perWave[0], 20, true, false);
  out.innerHTML = html + `<p class="meta">${data.ms.toFixed(0)} ms</p></div>`;
  suggestVisible = true;
  out.querySelectorAll(".apply").forEach((b) => b.addEventListener("click", () =>
    (b.dataset.ci != null ? runAutoApplyChain(+b.dataset.ci) : runAutoApply(+b.dataset.w, +b.dataset.i))));
}
// „Übernehmen" (einwellig): die angeklickte Aufstellung in den manuellen Modus laden und rechnen.
function runAutoApply(wi, rowIdx) {
  if (!autoLast || !autoLast.perWave) return;
  const setups = autoLast.perWave.map((pw, idx) => {
    const row = pw.rows[idx === wi ? rowIdx : 0];
    return { general: pw.general, talents: pw.talents, troops: row.comp };
  });
  loadManualWaves(setups);
}
// „Übernehmen" (mehrwellig): die gewählte vollständige Kette in den manuellen Modus laden und rechnen.
function runAutoApplyChain(ci) {
  if (!autoLast || !autoLast.chains || !autoLast.chains[ci]) return;
  loadManualWaves(autoLast.chains[ci].steps.map((s) => ({ general: s.general, talents: s.talents, troops: s.comp })));
}
function loadManualWaves(setups) {
  ensureManualMode();
  waves = setups.map((s) => ({ general: s.general, talents: { ...s.talents }, troops: { ...s.troops }, autoTypes: [] }));
  curWave = 0; talentLvl = waves[0].talents;
  loadWave(0); renderWaveTabs();
  $("go").click();
}

$("suggestbtn").addEventListener("click", lookupBest);
$("go").addEventListener("click", async () => {
  if (mode === "auto") { runAutoSearch(); return; }
  saveCurWave();                            // aktive Welle aus den Widgets sichern
  // Aktive Wellen: bis zur ERSTEN Welle ohne Truppen – diese und alle danach werden
  // ignoriert (auch wenn dort Einheiten stehen). Nur General = keine Truppen.
  const active = [];
  for (const w of waves) { if (troopsSpec(w.troops) === "") break; active.push(w); }
  if (active.length === 0) { showComputeError(); return; }   // keine Truppen → nichts zu rechnen

  const specB = specOf("side_b");
  lastURL = buildShareURL();
  setComputing(true);
  await core.whenReady();                  // nach einem Abbruch erst neuen Worker abwarten
  const t0 = performance.now();

  const eKey = enemyKey(), advId = ADVENTURES[curAdv].id;
  const wavePayload = (w) => ({ specA: [`1x${w.general}`, troopsSpec(w.troops)].filter(Boolean).join(", "), modsA: talentMods(w.talents) });
  const waveCtx = (w) => ({ general: w.general, talents: combatTalentStr(w.talents), player_spec: troopsSpec(w.troops) });

  if (active.length === 1) {
    // Einzelkampf inkl. Hall-of-Fame-Speicherung.
    const w = active[0], p = wavePayload(w);
    const overCap = waveOverCap(w);           // über Limit → rechnen, aber nicht speichern
    const ctx = { enemy_key: eKey, adventure_id: advId, player_spec: troopsSpec(w.troops), general: w.general, talents: combatTalentStr(w.talents) };
    core.getPool()[0].onmessage = (e) => {
      lastResult = e.data.result;
      if (lastResult) lastResult.ms = performance.now() - t0;
      setComputing(false);
      try { render(); } catch (err) { console.error(err); showComputeError(); return; }
      if (lastResult && !overCap) submitSolution(lastResult, ctx);
    };
    core.getPool()[0].postMessage({ specA: p.specA, specB, eps: EPS, quant: QUANT, modsA: p.modsA });
  } else {
    // Mehrere Wellen: per-Welle Spec + Talent-Modifier; Aggregat in die Hall of Fame.
    const payload = active.map(wavePayload);
    let setup = active.map(waveCtx);
    core.getPool()[0].onmessage = (e) => {
      let res = e.data.result;
      let overCap = false;
      if (res) {
        res.ms = performance.now() - t0;
        // Der Worker kämpft nur so viele Wellen, wie der (Worst-Case-)Gegner überlebt, und
        // bricht ab, sobald er geräumt ist → res.waves ist bereits die gekämpfte Menge.
        const keep = res.waves.length;
        overCap = active.slice(0, keep).some(waveOverCap);   // über Limit → nicht speichern
        setup = setup.slice(0, keep);
        // Auf eine effektive Welle reduziert → wie Einzelkampf behandeln/speichern.
        if (res.waves.length === 1) { const ms = res.ms; res = res.waves[0]; res.ms = ms; }
      }
      lastResult = res;
      setComputing(false);
      try { render(); } catch (err) { console.error(err); showComputeError(); return; }
      if (!res || overCap) return;              // unrealistisch (über Generalslimit) → nicht in die DB
      if (res.waves) submitWavesSolution(res, { enemy_key: eKey, adventure_id: advId, waveSetup: setup });
      else submitSolution(res, { enemy_key: eKey, adventure_id: advId, player_spec: setup[0].player_spec, general: setup[0].general, talents: setup[0].talents });
    };
    core.getPool()[0].postMessage({ waves: payload, specB, eps: EPS, quant: QUANT });
  }
});

// Rechen-Status: Spinner + Abbrechen-Knopf; Abbruch beendet den Worker hart.
function setComputing(on) {
  $("go").disabled = on;
  $("suggestbtn").disabled = on;            // Hall of Fame während der Rechnung sperren
  if (on) {
    suggestVisible = false;
    out.innerHTML = `<div class="busy"><span class="spinner"></span><span id="progresslbl">${T().computing}</span>`
      + `<button id="cancelbtn" class="cancel-btn">${T().cancel}</button></div>`
      + `<div id="autolive"></div>`;   // Auto-Modus: live mitwachsende Ergebnistabelle
    $("cancelbtn").addEventListener("click", cancelCompute);
  }
}
// Live-Fortschritt im Spinner (Auto-Modus): nur das Label ersetzen, damit der Abbrechen-Knopf bleibt.
function setProgress(done, total) {
  const el = $("progresslbl");
  if (el) el.textContent = fmt(T().autoProgress, { done, total, workers: WORKER_COUNT });
}
function cancelCompute() {
  autoCancel = true;                         // laufende GA-Suche (Auto-Modus) stoppen
  recycleWorkerPool();                       // Worker hart beenden + frischen Pool hochfahren
  setComputing(false);
  lastResult = null;
  suggestVisible = false;
  out.innerHTML = "";
}

// ---- Start ----
buildSideA();
buildPanel($("side_b"), advUnits(), "down");
applyLang();
const fromUrl = applyQuery();
if (fromUrl || location.hash === "#run" || new URLSearchParams(location.search).has("run"))
  $("go").click();
