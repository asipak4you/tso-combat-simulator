// © 2026 Dennis Thielsch – Alle Rechte vorbehalten / All rights reserved.
// Kein Kopieren, Verändern oder Weitergeben ohne schriftliche Genehmigung. Siehe LICENSE.
//
// Gemeinsamer, DOM-FREIER Kern des Kampfsimulators: Daten (Katalog, Abenteuer, Talente, i18n),
// Worker-Pool (WASM-Solver), Kombinatorik/Scoring, Mehrwellen-Strahlsuche (solveChains) und der
// Hall-of-Fame-Client. Genutzt von der Klassik-Seite (app.js) UND den neuen Seiten
// (profil.js, planer.js), damit die Kampf-/Bewertungslogik nur EINMAL existiert.
//
// Alle Anzeige-/DOM-Texte liegen außerhalb (i18n-Helfer nehmen die Sprache als Argument).

// ---- Worker-Pool (je ein WASM-Kern pro Worker) ------------------------------------------
export const WORKER_COUNT = Math.min(navigator.hardwareConcurrency || 4, 8);
let workerPool = [], poolReady;
let onWorkerError = () => {};                 // von app.js gesetzt (Spinner zurücksetzen)
export const setWorkerErrorHandler = (fn) => { onWorkerError = fn || (() => {}); };
export const getPool = () => workerPool;      // aktueller Pool (recycle ersetzt das Array)
export const whenReady = () => poolReady;     // aktuelles Bereit-Promise (ändert sich beim Recycle)

// Pro-Worker-Heap-Obergrenze: Der WASM-Linearspeicher wächst auf den High-Water-Mark der größten
// je gerechneten Sim und schrumpft NIE. Gemessen bleibt er für normale Camps bei ~16–40 MB,
// einzelne Riesen-Sims (großer Zustandsraum) treiben ihn aber weit hoch. Reißt ein Worker diese
// Schwelle, wird er EINZELN (im Idle) erneuert, statt dass alle 8 dauerhaft am Peak kleben.
let workerHeapLimit = 64 * 1024 * 1024;
export const getWorkerHeapLimit = () => workerHeapLimit;
export const setWorkerHeapLimit = (bytes) => { if (bytes > 0) workerHeapLimit = bytes; };

// ---- Zentraler Dispatcher (eine globale Job-Queue über den ganzen Pool) ----
// Jeder Job ist EIN Kampf (specA vs specB + mods); ein freier Worker zieht den nächsten.
// Damit kann derselbe Pool von mehreren unabhängigen Suchen gefüttert werden, ohne dass eine
// Suche den Pool exklusiv belegt – Voraussetzung für spätere Camp-Concurrency im Planer.
// Job: { specA, specB, modsA, shouldSkip?, onRun(result), onSkip() }.
const idleWorkers = new Set();   // aktuell freie Worker DES LAUFENDEN Pools (recycle-fest)
const jobQueue = [];             // wartende Jobs (FIFO)
function pumpQueue() {
  while (jobQueue.length && idleWorkers.size) {
    const job = jobQueue.shift();
    if (job.shouldSkip && job.shouldSkip()) { job.onSkip(); continue; }   // abgebrochen: kein Worker nötig
    const w = idleWorkers.values().next().value;
    idleWorkers.delete(w);
    w.onmessage = (e) => {
      job.onRun(e.data.result);
      if (!workerPool.includes(w)) return;                  // schon raus (Pool-Recycle)
      if (e.data.heapBytes > workerHeapLimit) replaceWorker(w);   // aufgebläht → einzeln erneuern
      else { idleWorkers.add(w); pumpQueue(); }
    };
    w.postMessage({ specA: job.specA, specB: job.specB, eps: EPS, quant: QUANT, modsA: job.modsA });
  }
}
function submitJob(job) { jobQueue.push(job); pumpQueue(); }

// Einen Worker mit Bereit-Handshake erzeugen; onReady(w, catalog) feuert, sobald der WASM-Kern steht.
function makeWorker(onReady) {
  const w = new Worker(new URL("./worker.js?v=20260628111218", import.meta.url), { type: "module" });
  w.addEventListener("message", function rd(e) {
    if (e.data && e.data.ready) { w.removeEventListener("message", rd); onReady(w, e.data.catalog); }
  });
  w.onerror = (ev) => { if (ev.preventDefault) ev.preventDefault(); onWorkerError(); };
  return w;
}
// EINEN aufgeblähten Worker ersetzen, ohne den Rest des Pools anzuhalten: aus Pool/Idle nehmen,
// hart beenden, frischen nachziehen. Der neue Worker meldet sich später als idle und übernimmt
// wartende Jobs. Bis dahin laufen die übrigen Worker weiter (kurzzeitig N-1). idle wird er NICHT,
// solange er nicht bereit ist – darum hängt hier nichts.
function replaceWorker(oldW) {
  const i = workerPool.indexOf(oldW);
  if (i < 0) return;
  workerPool.splice(i, 1);
  idleWorkers.delete(oldW);
  oldW.terminate();
  workerPool.push(makeWorker((w) => { idleWorkers.add(w); pumpQueue(); }));
}

export function spawnWorkerPool() {
  workerPool = [];
  let readyCount = 0, cat = null;
  poolReady = new Promise((resolve) => {
    for (let i = 0; i < WORKER_COUNT; i++) {
      workerPool.push(makeWorker((w, catalog) => {
        if (!cat) cat = catalog;
        idleWorkers.add(w); pumpQueue();        // ab jetzt für Jobs verfügbar
        if (++readyCount === WORKER_COUNT) resolve(cat);
      }));
    }
  });
  return poolReady;
}
// Ganzen Pool hart neu starten (Altpfad; mit dem Pro-Worker-Recycle oben i.d.R. nicht mehr nötig).
// Wartende Jobs in der Queue bleiben erhalten und laufen auf den frischen Workern weiter (nur
// AUFRUFEN, wenn keine Jobs in-flight sind – sonst blieben deren onRun-Callbacks hängen).
export function recycleWorkerPool() {
  workerPool.forEach((w) => { idleWorkers.delete(w); w.terminate(); });
  return spawnWorkerPool();
}

export const catalog = await spawnWorkerPool();
export const UMAP = Object.fromEntries(catalog.map((u) => [u.abbr, u]));

// Anzeige-Kürzel (z. B. „R", „Pl") vorab aus web/unit_shortcuts.json.
const SHORTCUTS = await fetch("./unit_shortcuts.json?v=20260628111218").then((r) => r.json()).catch(() => ({}));
for (const u of catalog) u.shortcut = SHORTCUTS[u.abbr] || u.abbr;

// ---- Einheiten-Icons (web/img/<id>.png) ----
// Manifest listet die Einheiten, für die ein echtes Icon ausgeliefert wird (scs-Grafik).
// Fehlt eins, zeigt iconInner den Kürzel-Platzhalter – kein 404, da nie geprobt wird.
const ICON_SET = new Set(
  await fetch("./img/units.json?v=20260628111218").then((r) => r.json()).catch(() => []));
export const hasIcon = (abbr) => ICON_SET.has(abbr);
// Gemeinsames Icon-Markup für alle Seiten (Simulator, Planer, Profil): Bild falls vorhanden,
// sonst Kürzel-Badge. `esc` ist optional (Planer/Profil escapen Titel separat).
export function iconInner(abbr, lang) {
  if (ICON_SET.has(abbr)) {
    const alt = uname(abbr, lang).replace(/"/g, "&quot;");
    return `<img class="ic-img" src="img/${abbr}.png" alt="${alt}" loading="lazy">`;
  }
  const u = UMAP[abbr];
  return `<span class="ic-ph">${u ? u.shortcut : abbr}</span>`;
}

// ---- Abenteuerkarten (web/img/maps/<id>.jpg) ----
// Manifest listet die Abenteuer, für die eine Blankokarte ausgeliefert wird.
const MAP_SET = new Set(
  await fetch("./img/maps.json?v=20260628111218").then((r) => r.json()).catch(() => []));
export const hasMap = (advId) => MAP_SET.has(advId);
export const mapSrc = (advId) => `img/maps/${advId}.jpg`;

// ---- Konstanten ----
export const EPS = 1e-8, QUANT = 512;
export const API_BASE = "https://tso-solutions.asipak4you.workers.dev";
export const NO_SUBMIT = ["localhost", "127.0.0.1", ""].includes(location.hostname);
// Strahlbreite der Mehrwellen-Suche: pro Welle die besten AUTO_BEAM Teilketten behalten.
export const AUTO_BEAM = 8;

// ---- Spieler-Einheiten ----
// Normal-Einheiten (Rekrut…Kanonier) vs. Spezial-Einheiten (Schwertkämpfer…Belagerer):
// Ein Abenteuer wird nur mit der EINEN ODER der ANDEREN Klasse bereist (Planer-Filter).
export const A_SET = ["Recruit", "Militia", "Soldier", "EliteSoldier", "Cavalry", "Bowman",
  "Longbowman", "Crossbowman", "Cannoneer", "Swordsman", "MountedSwordsman",
  "Knight", "Marksman", "ArmoredMarksman", "MountedMarksman", "Besieger"];
export const NORMAL_UNITS = A_SET.slice(0, 9);   // Rekrut … Kanonier
export const SPECIAL_UNITS = A_SET.slice(9);     // Schwertkämpfer … Belagerer
export const DEFAULT_GEN = "General";

export const byOrder = (set) => [...set].sort((a, b) => UMAP[a].order - UMAP[b].order);
export const GENERALS = byOrder(["General", "EasterGeneral", "MajorGeneral", "ResoluteGeneral",
  "StarGeneral3", "HalloweenGeneralDracul", "GeneralVargus", "GeneralNusala", "GeneralAnslem",
  "MasterGeneral", "Bighelm", "Reaper", "RetailBox2General", "MedicGeneral", "GeneralMary",
  "Anniversary2019General", "MiraculousGeneral", "GeneralJuan", "GeneralTrembleBeard",
  "StarGeneral2", "MadScientistGeneral", "BorisGeneral", "Halloween2019General",
  "Xmas2019General", "AssassinGeneral", "SylvanaGeneral", "GhostGeneral", "FrostyGeneral",
  "LonerGeneral", "GeneralLoudmouth", "NutcrackerGeneral", "Narz", "Broh"]);
export const LIST_A = byOrder(A_SET);

// ---- Abenteuer ----
export const ADV_DATA = await fetch("./adventures.json?v=20260628111218").then((r) => r.json()).catch(() => []);
const UNIT_VALUES = await fetch("./unit_values.json?v=20260628111218").then((r) => r.json()).catch(() => ({}));
export const unitValue = (a) => (UNIT_VALUES[a] != null ? UNIT_VALUES[a] : 1);
// Normal- vs. Spezial-Abenteuer. Quelle: kuratierte Override-Datei adventure_modes.json
// (id → "special"/"normal"; aus tsowiki zu pflegen) bzw. ein adv.unitMode-Feld; Fallback „normal".
// So lässt sich die Liste ohne Neugenerierung von adventures.json in EINER Datei nachtragen.
const ADV_MODES = await fetch("./adventure_modes.json?v=20260628111218").then((r) => r.json()).catch(() => ({}));
export const advUnitMode = (a) =>
  ((a && (ADV_MODES[a.id] || a.unitMode)) === "special" ? "special" : "normal");
export const ADVENTURES = ADV_DATA.map((a) => ({
  id: a.id, name: a.name, units: byOrder(a.units), camps: a.camps,
  sectors: !!a.sectors, unitMode: advUnitMode(a),
}));

// ---- Internationalisierung (Sprache als Argument) ----
export const LANGS = ["de", "en", "pl"];
export const LUTS = {};
for (const l of LANGS)
  LUTS[l] = await fetch(`./i18n/${l}.json?v=20260628111218`).then((r) => r.json())
    .catch(() => ({ adventures: {}, units: {}, talents: {}, ui: {} }));
export const fmt = (str, params) => str.replace(/\{(\w+)\}/g, (_, k) => params[k]);
export const TALENTS = await fetch("./talents.json?v=20260628111218").then((r) => r.json()).catch(() => ({}));
export const TTREE = await fetch("./talents_tree.json?v=20260628111218").then((r) => r.json())
  .catch(() => ({ rows: [], maxPoints: 21, maxPerRow: [], rowUnlockBelow: [] }));
const lut = (lang) => LUTS[lang] || LUTS.de || { adventures: {}, units: {}, talents: {}, ui: {} };
export const tname = (k, lang) => lut(lang).talents[k] || (TALENTS[k] ? TALENTS[k].name : k);
export const uname = (abbr, lang) => lut(lang).units[abbr] || (UMAP[abbr] ? UMAP[abbr].name : abbr);
export const advName = (a, lang) => lut(lang).adventures[a.id] || a.name;
export const uiText = (lang) => lut(lang).ui || {};

// ---- Kombinatorik (Auto-Aufstellungen) ----
export function binom(n, r) {
  if (r < 0 || r > n) return 0;
  r = Math.min(r, n - r);
  let c = 1;
  for (let i = 0; i < r; i++) c = (c * (n - i)) / (i + 1);
  return Math.round(c);
}
export const autoComboCount = (k, cap, step, fill = true) => {
  if (k <= 0 || step <= 0 || cap < step) return 0;
  const M = Math.floor(cap / step);
  return fill ? binom(M + k - 1, k - 1) : binom(M + k, k) - 1;
};
// maxTypes (optional): nur Aufstellungen mit höchstens so vielen verschiedenen Einheitenarten
// behalten. Bei vielen Typen (Planer nutzt alle verfügbaren) verhindert das die kombinatorische
// Explosion (C(M+k-1,k-1) Kämpfe); realistische Optima nutzen ohnehin nur 1–3 Arten. 0/undef = aus.
export function autoCompositions(types, step, cap, fill = true, maxTypes = 0) {
  const k = types.length, M = Math.floor(cap / step), res = [];
  if (k === 0 || M <= 0) return res;
  // Rest, falls cap nicht glatt durch step teilbar ist (z. B. cap=215, step=25 → 15).
  // Die Maximalarmee (alle M Schritte belegt) wird damit exakt auf cap aufgefüllt, indem der
  // Rest dem größten Stack zugeschlagen wird; kleinere Armeen bleiben Vielfache von step.
  // Im Fill-Modus ist jede Aufstellung maximal; im No-Fill-Modus nur die mit voller Schrittzahl.
  const extra = cap - M * step;
  const cur = new Array(k).fill(0);
  (function rec(i, rem) {
    if (i === k - 1) {
      for (let v = fill ? rem : 0; v <= rem; v++) {
        cur[i] = v;
        const m = {};
        let topAbbr = null, topCur = 0;
        for (let j = 0; j < k; j++) if (cur[j] > 0) {
          m[types[j]] = cur[j] * step;
          if (cur[j] > topCur) { topCur = cur[j]; topAbbr = types[j]; }
        }
        const n = Object.keys(m).length;
        if (extra && topAbbr && v === rem) m[topAbbr] += extra;  // v===rem ⇒ Maximalarmee (M Schritte)
        if (n && (!maxTypes || n <= maxTypes)) res.push(m);
        if (fill) break;
      }
      return;
    }
    for (let v = 0; v <= rem; v++) { cur[i] = v; rec(i + 1, rem - v); }
  })(0, M);
  return res;
}

// ---- Tail-Quantil / Verteilungs-Kennzahlen ----
export const HEPS = 1e-6;
export const mean = (d) => d.reduce((s, p, k) => s + (p >= HEPS ? k * p : 0), 0);
// Min–Max-Spanne als KUMULATIVES Tail-Quantil (monoton: mehr Schaden ⇒ nie kleinerer Worst Case).
export const span = (d) => {
  let lo = -1, hi = -1, cum = 0;
  for (let k = 0; k < d.length; k++) { cum += d[k] || 0; if (cum >= HEPS) { lo = k; break; } }
  cum = 0;
  for (let k = d.length - 1; k >= 0; k--) { cum += d[k] || 0; if (cum >= HEPS) { hi = k; break; } }
  return [lo, hi];
};

// ---- Gegner-Kollaps zwischen Wellen (Spiegel von worker.js) ----
export function collapseEnemyMain(stacks_b) {
  return stacks_b.map((u) => {
    const [, hi] = span(u.surv);
    return { abbr: u.abbr, n: Math.max(0, hi) };
  }).filter((e) => e.n > 0).map((e) => `${e.n}x${e.abbr}`).join(", ");
}

// ---- Bewertung (kleiner = besser) ----
// Gewichteter Worst-Case-Truppenverlust des Spielers (General zählt nicht mit).
export function scoreOf(result) {
  let s = 0;
  for (const u of result.stacks_a) {
    if (GENERALS.includes(u.abbr)) continue;
    const loss = u.surv.map((_, k) => u.surv[u.count0 - k]);
    const [, lmx] = span(loss);
    s += Math.max(0, lmx) * unitValue(u.abbr);
  }
  return s;
}
// Worst-Case-Wert des überlebenden Restgegners (0 = sicher geräumt) – primärer Ranking-Schlüssel.
export function enemyRemain(result) {
  let s = 0;
  for (const u of result.stacks_b) {
    const [, smx] = span(u.surv);
    s += Math.max(0, smx) * unitValue(u.abbr);
  }
  return s;
}
// Auto-Ergebnisse ranken: Restgegner aufsteigend, dann eigener Verlustwert aufsteigend.
export function rankAutoRows(rows) {
  rows.forEach((r) => { r.remain = enemyRemain(r.res); r.score = scoreOf(r.res); });
  rows.sort((a, b) => (a.remain - b.remain) || (a.score - b.score));
}

// ---- Spec-/Talent-Strings ----
export const troopsSpec = (troops) => byOrder(Object.keys(troops).filter((a) => troops[a] > 0))
  .map((a) => `${troops[a]}x${a}`).join(", ");
export function parseSpec(spec) {
  const m = {};
  for (const tok of String(spec).split(",")) {
    const t = tok.trim(); if (!t) continue;
    const k = t.indexOf("x"); if (k < 0) continue;
    const n = parseInt(t.slice(0, k), 10) || 0, a = t.slice(k + 1).trim();
    if (a && n > 0) m[a] = (m[a] || 0) + n;
  }
  return m;
}
export function parseTalents(str) {
  const m = {};
  for (const seg of String(str || "").split("-")) {
    const i = seg.lastIndexOf("."); if (i < 0) continue;
    const k = seg.slice(0, i), v = parseInt(seg.slice(i + 1), 10) || 0;
    if (k && v > 0) m[k] = v;
  }
  return m;
}
export const specAbbr = (spec) => {
  const m = parseSpec(spec);
  return byOrder(Object.keys(m).filter((a) => m[a] > 0))
    .map((a) => `${m[a]} ${UMAP[a] ? UMAP[a].shortcut : a}`).join(", ");
};
export const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
// Talentauswahl als URL-String "Key.lvl-Key.lvl".
export const talentStr = (tl) => Object.keys(tl).filter((k) => tl[k] > 0)
  .map((k) => `${k}.${tl[k]}`).join("-");
// Nur KAMPF-relevante Talente (für Hall of Fame / DB).
export const combatTalentStr = (tl) => Object.keys(tl)
  .filter((k) => tl[k] > 0 && TALENTS[k] && TALENTS[k].combat)
  .map((k) => `${k}.${tl[k]}`).join("-");

// ---- Per-Einheit-Verluste (für die DB / Anzeige) ----
export function lossRanges(stacks, skipGeneral) {
  const parts = [];
  for (const u of stacks) {
    if (skipGeneral && GENERALS.includes(u.abbr)) continue;
    const loss = u.surv.map((_, k) => u.surv[u.count0 - k]);
    let [mn, mx] = span(loss);
    if (mn < 0) { mn = 0; mx = 0; }
    parts.push(`${u.abbr}:${mn}-${mx}`);
  }
  return parts.join(",");
}
export function wavesLossRangesA(resWaves) {
  const agg = {};
  for (const r of resWaves) {
    for (const u of r.stacks_a) {
      if (GENERALS.includes(u.abbr)) continue;
      const loss = u.surv.map((_, k) => u.surv[u.count0 - k]);
      let [mn, mx] = span(loss);
      if (mn < 0) { mn = 0; mx = 0; }
      const a = agg[u.abbr] || (agg[u.abbr] = [0, 0]);
      a[0] += mn; a[1] += mx;
    }
  }
  return byOrder(Object.keys(agg)).map((a) => `${a}:${agg[a][0]}-${agg[a][1]}`).join(",");
}
export function prettyLosses(str, lang) {
  return String(str || "").split(",").filter(Boolean).map((tok) => {
    const i = tok.indexOf(":"); if (i < 0) return "";
    const abbr = tok.slice(0, i), rng = tok.slice(i + 1).replace("-", "–");
    const sc = UMAP[abbr] ? UMAP[abbr].shortcut : abbr;
    return `${esc(rng)} ${esc(sc)}`;
  }).filter(Boolean).join("<br>");
}

// ---- Faltung / Wellen-Aggregate ----
export function convolve(a, b) {
  const out = new Array(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i++) if (a[i]) for (let j = 0; j < b.length; j++) if (b[j]) out[i + j] += a[i] * b[j];
  return out;
}
export function playerTotalStacks(waves) {
  const map = new Map();
  for (const w of waves) {
    for (const u of w.stacks_a) {
      const e = map.get(u.abbr) || { abbr: u.abbr, count0: 0, surv: [1], nwaves: 0, lmn: 0, lmx: 0 };
      const [smn, smx] = span(u.surv.map((_, k) => u.surv[u.count0 - k]));
      e.count0 += u.count0; e.surv = convolve(e.surv, u.surv); e.nwaves += 1;
      e.lmn += Math.max(smn, 0); e.lmx += Math.max(smx, 0);
      map.set(u.abbr, e);
    }
  }
  return [...map.values()];
}
export function enemyTotalStacks(waves) {
  const first = waves[0].stacks_b, last = waves[waves.length - 1].stacks_b;
  const lastBy = new Map(last.map((u) => [u.abbr, u]));
  return first.map((u0) => {
    const lu = lastBy.get(u0.abbr);
    const surv = new Array(u0.count0 + 1).fill(0);
    if (lu) for (let j = 0; j < lu.surv.length && j <= u0.count0; j++) surv[j] = lu.surv[j];
    else surv[0] = 1;
    return { abbr: u0.abbr, count0: u0.count0, surv };
  });
}

// ---- Talent-Budget/Sperren (reine Mathematik, talentLvl als Argument) ----
// Cleave + Unstoppable Charge: nur eine Stufe (Splash-Chance 100 %), kostet aber 3 Skillpunkte.
export const FULL_SPLASH = { IncreaseEliteSoldierSplashAndAD: 1, IncreaseSwiftSplashAndAD: 1 };
export const tCost = (k) => (FULL_SPLASH[k] ? 3 : 1);
export const tEffLvl = (k, lvl) => (FULL_SPLASH[k] && lvl > 0 ? 3 : lvl);
export const tRows = () => TTREE.rows || [];
export const tMaxLvl = (r, key) => (FULL_SPLASH[key] ? 1 : (TTREE.maxPerRow && TTREE.maxPerRow[r]) || 3);
export const tRowPts = (tl, r) => tRows()[r].reduce((s, k) => s + (tl[k] || 0) * tCost(k), 0);
export const tPtsBelow = (tl, r) => { let s = 0; for (let i = 0; i < r; i++) s += tRowPts(tl, i); return s; };
export const tTotal = (tl) => tRows().reduce((s, _, r) => s + tRowPts(tl, r), 0);
export const tRowUnlocked = (tl, r) => tPtsBelow(tl, r) >= ((TTREE.rowUnlockBelow && TTREE.rowUnlockBelow[r]) || 0);
export function tEnforceLocks(tl) {
  for (let r = 0; r < tRows().length; r++)
    if (!tRowUnlocked(tl, r)) for (const k of tRows()[r]) tl[k] = 0;
}
// Truppenlimit eines Generals inkl. Garnisonsanbau-Talent.
export function genCapFor(general, tl) {
  let b = 0;
  for (const k in tl) {
    const lvl = tl[k], tal = TALENTS[k];
    if (lvl && tal && tal.cap) b += tal.cap[lvl - 1] || 0;
  }
  return UMAP[general].cap + b;
}
// Kompakter Modifier-String für die Engine (nur Kampf-Talente).
export function talentMods(tl) {
  const recs = [];
  for (const key in tl) {
    const lvl = tl[key]; if (!lvl) continue;
    const tal = TALENTS[key]; if (!tal || !tal.combat) continue;
    for (const m of (tal.levels[tEffLvl(key, lvl) - 1] || [])) {
      if (m.it === "gain_splash") {
        recs.push(`gain_splash:${m.sd}:${m.tg || "*"}:${m.c != null ? m.c : 1}:0`);
        continue;
      }
      recs.push(`${m.it}:${m.sd}:${m.tg || "*"}:${m.m}:${m.a}`);
    }
  }
  return recs.join(";");
}

// ---- Gegner-Schlüssel ----
// Kanonischer Schlüssel "abbr:n|abbr:m" aus einem Bestand {abbr:n} (nach order, dann abbr).
export function enemyKeyFromSpec(specObj) {
  return Object.keys(specObj)
    .map((a) => ({ a, n: parseInt(specObj[a], 10) || 0 }))
    .filter((e) => e.n > 0)
    .sort((x, y) => (UMAP[x.a].order - UMAP[y.a].order) || x.a.localeCompare(y.a))
    .map((e) => `${e.a}:${e.n}`).join("|");
}
// Gegner-Spec-String "10xBanditRecruit, 5xBanditBowman" aus einem Bestand {abbr:n}.
export const enemySpecStr = (specObj) => byOrder(Object.keys(specObj).filter((a) => specObj[a] > 0))
  .map((a) => `${specObj[a]}x${a}`).join(", ");

// ---- Worker-Batch (Work-Stealing über den Pool) ----
// Verteilt `specs` dynamisch auf alle Worker; onItem(i, result, completed) je fertigem Kampf.
// shouldStop() → unterbricht: keine neuen Specs mehr verteilen, sobald die noch
// laufenden Worker fertig sind wird (teilweise gefüllt) aufgelöst.
export function runBatch(pool, specs, enemySpec, modsA, onItem, shouldStop = () => false) {
  return new Promise((resolve) => {
    if (!specs.length) { resolve([]); return; }
    const results = new Array(specs.length).fill(null);
    let completed = 0, settled = 0;
    const done = () => { if (++settled === specs.length) resolve(results); };
    // Jeder Spec wird als eigener Job in die globale Queue gegeben (Work-Stealing macht der
    // Dispatcher). shouldStop wird je Job VOR der Verteilung geprüft – schon laufende Jobs
    // laufen aus, noch wartende werden übersprungen (results bleiben null) – wie zuvor.
    specs.forEach((spec, i) => {
      const ti = performance.now();
      submitJob({
        specA: spec, specB: enemySpec, modsA,
        shouldSkip: shouldStop,
        onRun: (res) => {
          results[i] = res;
          if (res) res.ms = performance.now() - ti;
          onItem(i, res, ++completed);
          done();
        },
        onSkip: done,
      });
    });
  });
}

// ---- Ketten-Verschmelzung (Einzel- + Mehrwellen-Lösungen in EINER Rangliste) ----
export const chainCmp = (a, b) => (a.remain - b.remain) || (a.score - b.score);
export function mergeChains(lists, keep = 20) {
  const seen = new Set(), out = [];
  for (const c of [].concat(...lists).sort(chainCmp)) {
    if (c.steps.length === 1) {
      const key = `${c.steps[0].general}|${troopsSpec(c.steps[0].comp)}`;
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push(c);
    if (out.length >= keep) break;
  }
  return out;
}

// ---- Mehrwellen-Strahlsuche (geteilte Engine; mehrere General-Configs je Welle) ------------
// active: [{ generals:[{general,talents}…], units:[abbr…], step, maxArmy }]  — eine Welle je Eintrag.
// Spiegelt die Schleife aus app.js/runAutoSearch, generalisiert auf mehrere Generäle pro Welle.
// Liefert { chains, wave0Rows, total, done }. Callbacks: onProgress(done,total), onLive(chains),
// shouldStop() → bricht ab. Throttling/Recycling macht der Aufrufer.
export async function solveChains(active, enemySpec, opts = {}) {
  const { onProgress = () => {}, onLive = () => {}, shouldStop = () => false,
    beamWidth = AUTO_BEAM, finalKeep = 20 } = opts;
  const pool = getPool();
  // Gitter je Welle je General vorab.
  const waveGrids = active.map((w) => w.generals.map((g) => ({
    g, grid: autoCompositions(w.units, w.step, genCapFor(g.general, g.talents), w.maxArmy !== false, w.maxTypes || 0),
  })));
  const total = waveGrids.reduce((s, gs, wi) =>
    s + (wi === 0 ? 1 : beamWidth) * gs.reduce((a, x) => a + x.grid.length, 0), 0);

  const extend = (st, row, enemy2) => ({
    steps: [...st.steps, { comp: row.comp, res: row.res, general: row.general, talents: row.talents }],
    enemy: enemy2, remain: enemyRemain(row.res), score: st.score + scoreOf(row.res),
  });

  let beam = [{ steps: [], enemy: enemySpec, remain: Infinity, score: 0 }];
  const terminal = [];
  let wave0Rows = [], singleChains = [], done = 0;
  const liveSnapshot = (extraChains) => mergeChains([terminal, extraChains, singleChains], finalKeep);

  for (let wi = 0; wi < active.length; wi++) {
    const gens = waveGrids[wi], isLast = wi === active.length - 1;
    if (!gens.some((x) => x.grid.length)) break;
    const expanded = [];
    for (const st of beam) {
      if (!st.enemy) continue;
      if (shouldStop()) return { chains: liveSnapshot(expanded), wave0Rows, total, done };
      const liveRows = [];
      let lastTs = 0;
      // Jede General-Config dieser Welle gegen den (kollabierten) Gegner der Teilkette rechnen.
      for (const { g, grid } of gens) {
        if (!grid.length) continue;
        if (shouldStop()) break;
        const specs = grid.map((c) => [`1x${g.general}`, troopsSpec(c)].filter(Boolean).join(", "));
        const mods = talentMods(g.talents);
        const base = done;
        const results = await runBatch(pool, specs, st.enemy, mods, (i, res, got) => {
          onProgress(base + got, total);
          if (res) liveRows.push({ comp: grid[i], res, general: g.general, talents: g.talents });
          const now = performance.now();
          if (now - lastTs > 150) {
            lastTs = now;
            const part = liveRows.slice(); rankAutoRows(part);
            const extra = part.slice(0, isLast ? finalKeep : beamWidth).map((row) => extend(st, row, null));
            onLive(liveSnapshot([...expanded, ...extra]));
          }
        }, shouldStop);
        done = base + specs.length;
      }
      if (!liveRows.length) continue;
      rankAutoRows(liveRows);
      if (wi === 0) {
        wave0Rows = liveRows;
        singleChains = liveRows.map((r) => ({
          steps: [{ comp: r.comp, res: r.res, general: r.general, talents: r.talents }],
          remain: r.remain, score: r.score,
        }));
      }
      for (const row of (isLast ? liveRows : liveRows.slice(0, beamWidth))) {
        const enemy2 = isLast ? null : collapseEnemyMain(row.res.stacks_b);
        const nx = extend(st, row, enemy2);
        (!isLast && !enemy2 ? terminal : expanded).push(nx);
      }
      onLive(liveSnapshot(expanded));
    }
    expanded.sort(chainCmp);
    beam = isLast ? expanded.slice(0, finalKeep) : expanded.slice(0, beamWidth);
    if (!beam.length && !terminal.length) break;
  }
  const chains = mergeChains([terminal, beam, singleChains], finalKeep);
  return { chains, wave0Rows, total, done };
}

// ---- Genetischer Algorithmus (Einzelwelle, ein General) --------------------------------
// Schnelle Alternative zur Gitter-Vollsuche: eine ganze Population (Truppenvektoren) wird PRO
// Generation gebatcht ausgewertet – das lastet den Worker-Pool voll aus. Rekombination =
// positionsweiser Mittelwert der Eltern, per Largest-Remainder exakt auf die Ziel-Armeegröße
// gerundet (Constraint bleibt erhalten); Mutation = einige „A runter, B rauf"-Züge (bei nicht
// voller Armee auch ±Block). Elitismus trägt die Besten weiter; Memoisierung spart Doppel-Sims.
// Liefert { rows, sims, gens, budget } (rows wie wave0Rows).
//
// Adaptives GA-Budget aus der Vollsuche-Größe: kleines Gitter → GA wertet fast alles aus
// (≈ Vollsuche, also faktisch optimal); großes Gitter → nur ein gedeckelter Bruchteil. Nie mehr
// als das Gitter selbst (die Memoisierung deckelt die echten Sims ohnehin auf die Gittergröße).
export const GA_FRACTION = 0.25, GA_MIN_SIMS = 150, GA_MAX_SIMS = 2500;
export const gaBudget = (gridSize) =>
  Math.min(gridSize, Math.max(GA_MIN_SIMS, Math.min(GA_MAX_SIMS, Math.round(gridSize * GA_FRACTION))));

export async function gaWave(g, units, step, enemySpec, opts = {}) {
  const { onProgress = () => {}, onLive = () => {}, shouldStop = () => false,
    maxTypes = 0, fill = true, pop: P = 24, elite: E = 3, mutRate = 0.6, maxSims = 0,
    patience = 25, keep = 20, seeds = [] } = opts;
  const pool = getPool();
  const cap = genCapFor(g.general, g.talents), mods = talentMods(g.talents);
  const k = units.length, M = Math.floor(cap / step), extra = cap - M * step;
  if (!k || M <= 0) return { rows: [], sims: 0, gens: 0, budget: 0 };
  const mt = maxTypes > 0 ? Math.min(maxTypes, k) : k;
  // Such-Budget adaptiv aus der Vollsuche-Größe ableiten (maxSims 0 = automatisch).
  const gridSize = autoComboCount(k, cap, step, fill);
  const budget = Math.min(maxSims || gaBudget(gridSize), gridSize);
  const BIG = 1e9, rnd = (n) => Math.floor(Math.random() * n);
  const sum = (x) => { let s = 0; for (const v of x) s += v; return s; };

  const compOf = (x) => {
    const m = {}; let topAbbr = null, topCur = 0, s = 0;
    for (let j = 0; j < k; j++) if (x[j] > 0) {
      m[units[j]] = x[j] * step; s += x[j];
      if (x[j] > topCur) { topCur = x[j]; topAbbr = units[j]; }
    }
    if (extra && topAbbr && s === M) m[topAbbr] += extra;   // „extra"-Rest nur bei voller Armee
    return m;
  };
  const keyOf = (x) => x.join(",");
  const nnz = (x) => { let c = 0; for (const v of x) if (v > 0) c++; return c; };

  // Zufälliger Start: 1..mt Typen; volle Armee = M Blöcke, sonst zufällige Größe 1..M.
  const randomState = () => {
    const x = new Array(k).fill(0), idx = [...Array(k).keys()];
    for (let i = idx.length - 1; i > 0; i--) { const j = rnd(i + 1); [idx[i], idx[j]] = [idx[j], idx[i]]; }
    const used = idx.slice(0, 1 + rnd(mt));
    const tot = fill ? M : 1 + rnd(M);
    for (let b = 0; b < tot; b++) x[used[rnd(used.length)]] += 1;
    return x;
  };
  // Nachbar: bei voller Armee nur „Block A→B" (Summe bleibt M); sonst auch +Block/−Block (Armeegröße variiert).
  const neighbor = (x) => {
    for (let t = 0; t < 20; t++) {
      const nz = []; for (let j = 0; j < k; j++) if (x[j] > 0) nz.push(j);
      const mode = fill ? 0 : rnd(3);
      if (mode === 1) {
        if (sum(x) >= M) continue;
        const y = x.slice(); y[rnd(k)] += 1;
        if (nnz(y) > mt) continue;
        return y;
      }
      if (mode === 2) {
        if (sum(x) <= 1) continue;
        const y = x.slice(); y[nz[rnd(nz.length)]] -= 1;
        return y;
      }
      const i = nz[rnd(nz.length)], j = rnd(k);
      if (i === j) continue;
      const y = x.slice(); y[i] -= 1; y[j] += 1;
      if (nnz(y) > mt) continue;
      return y;
    }
    return null;
  };
  // Zu viele Typen (nach Rekombination) → kleinsten Stack in den größten falten, bis nnz ≤ mt.
  const repairMt = (x) => {
    const y = x.slice();
    while (nnz(y) > mt) {
      let small = -1, large = -1;
      for (let j = 0; j < k; j++) if (y[j] > 0) {
        if (small < 0 || y[j] < y[small]) small = j;
        if (large < 0 || y[j] > y[large]) large = j;
      }
      if (large === small) break;
      y[large] += y[small]; y[small] = 0;
    }
    return y;
  };
  // Rekombination: Mittelwert je Position, per Largest-Remainder exakt auf die Ziel-Gesamtgröße T
  // gerundet (volle Armee: T = M; sonst Mittel der beiden Eltern-Armeegrößen).
  const crossover = (a, b) => {
    const T = fill ? M : Math.max(1, Math.min(M, Math.round((sum(a) + sum(b)) / 2)));
    const fsum = sum(a) + sum(b) || 1;
    const f = a.map((v, i) => (v + b[i]) * T / fsum), base = f.map(Math.floor);
    let rem = T - base.reduce((s, v) => s + v, 0);
    const ord = f.map((v, i) => [v - Math.floor(v), i]).sort((x, y) => y[0] - x[0]);
    for (let t = 0; t < ord.length && rem > 0; t++) { base[ord[t][1]]++; rem--; }
    return repairMt(base);
  };
  const mutate = (x) => { let y = x; while (Math.random() < mutRate) { const n = neighbor(y); if (!n) break; y = n; } return y; };

  const memo = new Map();
  let sims = 0;
  const evalStates = async (states) => {
    const miss = [];
    for (const x of states) { const key = keyOf(x); if (!memo.has(key)) { memo.set(key, null); miss.push({ key, x }); } }
    if (miss.length) {
      const specs = miss.map((m) => [`1x${g.general}`, troopsSpec(compOf(m.x))].filter(Boolean).join(", "));
      const results = await runBatch(pool, specs, enemySpec, mods, () => {}, shouldStop);
      for (let i = 0; i < miss.length; i++) {
        const res = results[i];
        if (!res) { memo.delete(miss[i].key); continue; }
        const remain = enemyRemain(res), score = scoreOf(res);
        memo.set(miss[i].key, { res, remain, score, cost: remain * BIG + score });
        sims++;
      }
      onProgress(sims, budget);
    }
    return states.map((x) => memo.get(keyOf(x)) || null);
  };

  const top = new Map();
  const record = (x, cell) => { if (cell) top.set(keyOf(x), { comp: compOf(x), res: cell.res, general: g.general, talents: g.talents, remain: cell.remain, score: cell.score }); };
  const rankRows = () => { const rows = [...top.values()]; rows.sort(chainCmp); return rows.slice(0, keep); };
  const tournament = (pp) => { let best = null; for (let t = 0; t < 3; t++) { const c = pp[rnd(pp.length)]; if (!best || c.cell.cost < best.cell.cost) best = c; } return best; };

  // Startpopulation (Seeds + Zufall).
  const initStates = [];
  for (const s of seeds) if (Array.isArray(s) && s.length === k) initStates.push(s.slice());
  while (initStates.length < P) initStates.push(randomState());
  let cells = await evalStates(initStates);
  let popArr = initStates.map((x, i) => ({ x, cell: cells[i] })).filter((p) => p.cell);
  popArr.forEach((p) => record(p.x, p.cell));
  let bestCost = popArr.length ? Math.min(...popArr.map((p) => p.cell.cost)) : Infinity;
  let stale = 0, gens = 0;

  while (sims < budget && stale < patience && !shouldStop()) {
    gens++;
    popArr.sort((a, b) => a.cell.cost - b.cell.cost);
    const elites = popArr.slice(0, Math.min(E, popArr.length));
    const childStates = [];
    while (childStates.length < P - elites.length) {
      const a = tournament(popArr), b = tournament(popArr);
      childStates.push(mutate(crossover(a.x, b.x)));
    }
    const cc = await evalStates(childStates);
    const children = childStates.map((x, i) => ({ x, cell: cc[i] })).filter((p) => p.cell);
    children.forEach((p) => record(p.x, p.cell));
    popArr = elites.concat(children);
    const gb = Math.min(...popArr.map((p) => p.cell.cost));
    stale = gb < bestCost ? (bestCost = gb, 0) : stale + 1;
    onLive(rankRows());
  }
  return { rows: rankRows(), sims, gens, budget };
}

// Mehrwellen-Variante des GA: gleiches Beam-/Ketten-Gerüst wie solveChains, aber gaWave je Knoten.
export async function solveChainsGA(active, enemySpec, opts = {}) {
  const { onProgress = () => {}, onLive = () => {}, shouldStop = () => false,
    beamWidth = AUTO_BEAM, finalKeep = 20, maxSims = 0, gaOpts = {} } = opts;
  // Fortschritts-Obergrenze: je Wellen-Knoten das (adaptive) GA-Budget dieser Welle.
  const waveBudget = (w) => {
    const g0 = w.generals[0]; if (!g0) return 0;
    const gs = autoComboCount(w.units.length, genCapFor(g0.general, g0.talents), w.step, w.maxArmy !== false);
    return Math.min(maxSims || gaBudget(gs), gs);
  };
  const total = active.reduce((s, w, wi) =>
    s + (wi === 0 ? 1 : beamWidth) * w.generals.length * waveBudget(w), 0);
  let done = 0;
  const bump = (d) => { if (d > 0) { done += d; onProgress(done, total); } };
  const extend = (st, row, enemy2) => ({
    steps: [...st.steps, { comp: row.comp, res: row.res, general: row.general, talents: row.talents }],
    enemy: enemy2, remain: enemyRemain(row.res), score: st.score + scoreOf(row.res),
  });
  let beam = [{ steps: [], enemy: enemySpec, remain: Infinity, score: 0 }];
  const terminal = [];
  let wave0Rows = [], singleChains = [];
  const liveSnapshot = (extra) => mergeChains([terminal, extra, singleChains], finalKeep);

  for (let wi = 0; wi < active.length; wi++) {
    const w = active[wi], isLast = wi === active.length - 1;
    const expanded = [];
    for (const st of beam) {
      if (!st.enemy) continue;
      if (shouldStop()) return { chains: liveSnapshot(expanded), wave0Rows, total, done };
      const liveRows = [];
      for (const g of w.generals) {
        if (shouldStop()) break;
        let last = 0;
        const { rows } = await gaWave(g, w.units, w.step, st.enemy, {
          ...gaOpts, maxTypes: w.maxTypes || 0, fill: w.maxArmy !== false,
          maxSims, keep: isLast ? finalKeep : beamWidth,
          shouldStop, onProgress: (s) => { bump(s - last); last = s; },
        });
        liveRows.push(...rows);
      }
      if (!liveRows.length) continue;
      rankAutoRows(liveRows);
      if (wi === 0) {
        wave0Rows = liveRows;
        singleChains = liveRows.map((r) => ({
          steps: [{ comp: r.comp, res: r.res, general: r.general, talents: r.talents }],
          remain: r.remain, score: r.score,
        }));
      }
      for (const row of (isLast ? liveRows : liveRows.slice(0, beamWidth))) {
        const enemy2 = isLast ? null : collapseEnemyMain(row.res.stacks_b);
        const nx = extend(st, row, enemy2);
        (!isLast && !enemy2 ? terminal : expanded).push(nx);
      }
      onLive(liveSnapshot(expanded));
    }
    expanded.sort(chainCmp);
    beam = isLast ? expanded.slice(0, finalKeep) : expanded.slice(0, beamWidth);
    if (!beam.length && !terminal.length) break;
  }
  const chains = mergeChains([terminal, beam, singleChains], finalKeep);
  return { chains, wave0Rows, total, done };
}

// ---- Hall-of-Fame-Client --------------------------------------------------------------
let onSolutionSaved = () => {};               // app.js invalidiert damit seinen Vorschlags-Cache
export const setSolutionSavedHandler = (fn) => { onSolutionSaved = fn || (() => {}); };

// GET /best – Bestenliste für eine Gegnerkonstellation (Fit-Filter serverseitig).
export async function fetchBest(key, { limit = 20, multi = true, exclude = [], config = null } = {}) {
  if (!API_BASE || !key) return [];
  let url = `${API_BASE}/best?key=${encodeURIComponent(key)}&limit=${limit}`;
  if (!multi) url += `&multi=0`;
  const ex = [...exclude].filter(Boolean).sort().join(",");
  if (ex) url += `&exclude=${encodeURIComponent(ex)}`;
  // Talent/General-Fit: erlaubte Config-Tupel "General|Talente" → Server liefert nur fieldbare
  // Lösungen, sodass schon LIMIT 1 die beste passende ist (spart D1-Lesezugriffe).
  if (config && config.length) {
    url += `&config=${encodeURIComponent(JSON.stringify([...config]))}`;
  }
  const r = await fetch(url);
  const d = await r.json();
  return d.solutions || [];
}

// POST /submit – berechnetes Einzelwellen-Ergebnis anonym speichern (fire-and-forget).
export async function submitSolution(result, ctx) {
  if (!API_BASE || NO_SUBMIT || !ctx.enemy_key || !ctx.player_spec) return;
  const body = {
    ...ctx, win_a: result.win_a, draw: result.draw, win_b: result.win_b,
    mean_loss_a: mean(result.loss_a), score: scoreOf(result), remain_b: enemyRemain(result),
    losses_a: lossRanges(result.stacks_a, true), losses_b: lossRanges(result.stacks_b, false),
    compute_ms: Math.round(result.ms || 0), eps: EPS, quant: QUANT,
  };
  try {
    await fetch(`${API_BASE}/submit`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    onSolutionSaved();
  } catch { /* still: Speichern ist optional */ }
}
// POST /submit – Mehrwellen-Ergebnis (Aggregat über alle Wellen).
export async function submitWavesSolution(res, ctx) {
  if (!API_BASE || NO_SUBMIT || !ctx.enemy_key || !res.waves || res.waves.length < 2) return;
  const body = {
    enemy_key: ctx.enemy_key, adventure_id: ctx.adventure_id, waves: ctx.waveSetup,
    win_a: res.cleared, draw: 0, win_b: 1 - res.cleared,
    mean_loss_a: res.waves.reduce((s, r) => s + mean(r.loss_a), 0),
    score: res.waves.reduce((s, r) => s + scoreOf(r), 0),
    remain_b: enemyRemain(res.waves[res.waves.length - 1]),
    losses_a: wavesLossRangesA(res.waves),
    losses_b: lossRanges(enemyTotalStacks(res.waves), false),
    compute_ms: Math.round(res.ms || 0), eps: EPS, quant: QUANT,
  };
  try {
    await fetch(`${API_BASE}/submit`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    onSolutionSaved();
  } catch { /* optional */ }
}
