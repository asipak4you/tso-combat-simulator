// © 2026 Dennis Thielsch – Alle Rechte vorbehalten / All rights reserved.
// Kein Kopieren, Verändern oder Weitergeben ohne schriftliche Genehmigung. Siehe LICENSE.
//
// Spielerprofil: der Nutzer legt seine Generäle (mit fester Talentbelegung) und seine
// verfügbaren Einheiten an. Speicherung in localStorage + versionierter JSON-Export/Import.
// Kampf-/Daten-Logik kommt aus core.js; diese Datei ist reine Profil-UI.
import * as core from "./core.js?v=20260628111218";
import { loadProfile, saveProfile as storeSave, migrateProfile, newId } from "./profile_store.js?v=20260628111218";
const { NORMAL_UNITS, SPECIAL_UNITS, GENERALS, UMAP, TTREE, TALENTS } = core;

// ---- Sprache + UI-Texte (Einheiten-/Generals-/Talentnamen kommen aus core) ----
const LANGS = core.LANGS;
const norm = (l) => (LANGS.includes((l || "").toLowerCase()) ? l.toLowerCase() : null);
const pathLang = () => { const m = location.pathname.match(/^\/(en|pl)(\/|$)/); return m ? m[1] : null; };
let lang = norm(new URLSearchParams(location.search).get("lang"))
  || pathLang() || norm(localStorage.getItem("tso_lang")) || "de";

const STR = {
  de: { title: "Mein Profil", betaNote: "Beta · Dein Profil wird nur lokal in deinem Browser gespeichert.",
    navSim: "Simulator", navProfile: "Mein Profil", navPlanner: "Abenteuer-Planer",
    unitsHead: "Meine Einheiten", normal: "Normal-Einheiten", special: "Spezial-Einheiten",
    generalsHead: "Meine Generäle", addGen: "+ General hinzufügen", export: "Profil exportieren",
    import: "Profil importieren", labelPh: "Bezeichnung (optional)", del: "Entfernen", talents: "Talente",
    reset: "Zurücksetzen", emptyGen: "Noch keine Generäle angelegt – füge oben einen hinzu.",
    importErr: "Datei konnte nicht gelesen werden (falsches Format oder neuere Version)." },
  en: { title: "My Profile", betaNote: "Beta · Your profile is stored only locally in your browser.",
    navSim: "Simulator", navProfile: "My Profile", navPlanner: "Adventure Planner",
    unitsHead: "My Units", normal: "Normal units", special: "Special units",
    generalsHead: "My Generals", addGen: "+ Add general", export: "Export profile",
    import: "Import profile", labelPh: "Label (optional)", del: "Remove", talents: "Talents",
    reset: "Reset", emptyGen: "No generals yet – add one above.",
    importErr: "Could not read the file (wrong format or newer version)." },
  pl: { title: "Mój profil", betaNote: "Beta · Profil jest zapisywany tylko lokalnie w przeglądarce.",
    navSim: "Symulator", navProfile: "Mój profil", navPlanner: "Planer przygód",
    unitsHead: "Moje jednostki", normal: "Jednostki normalne", special: "Jednostki specjalne",
    generalsHead: "Moi generałowie", addGen: "+ Dodaj generała", export: "Eksportuj profil",
    import: "Importuj profil", labelPh: "Etykieta (opcjonalnie)", del: "Usuń", talents: "Talenty",
    reset: "Reset", emptyGen: "Brak generałów – dodaj jednego powyżej.",
    importErr: "Nie udało się odczytać pliku (zły format lub nowsza wersja)." },
};
const T = () => STR[lang] || STR.de;
const $ = (id) => document.getElementById(id);
const esc = core.esc;
const uname = (a) => core.uname(a, lang);
const tname = (k) => core.tname(k, lang);
const iconInner = (abbr) => core.iconInner(abbr, lang);   // echtes scs-Icon, sonst Kürzel-Badge

// Profil-Datenmodell/Speicher liegen in profile_store.js (geteilt mit dem Planer).
let profile = loadProfile();
const saveProfile = () => storeSave(profile);

// ---- Talentbaum-Komponente (geteilte Budget-/Sperr-Mathematik aus core) ---------------
// Rendert den Talentbaum in `el` für die Belegung `tl` (Referenz wird mutiert); ruft onChange().
function mountTalentTree(el, tl, onChange) {
  const maxPts = TTREE.maxPoints || 21;
  function cycle(r, key) {
    if (!core.tRowUnlocked(tl, r)) return;
    const cur = tl[key] || 0, mx = core.tMaxLvl(r, key), cost = core.tCost(key);
    let next = cur + 1;
    if (next > mx) next = 0;
    else if (core.tTotal(tl) + (next - cur) * cost > maxPts) next = 0;
    tl[key] = next;
    core.tEnforceLocks(tl);
    render();
    onChange();
  }
  function render() {
    const rows = core.tRows();
    let html = `<div class="thead">${T().talents} <b>${core.tTotal(tl)}/${maxPts}</b>`
      + `<a class="treset">${T().reset}</a></div>`;
    for (let r = rows.length - 1; r >= 0; r--) {
      const locked = !core.tRowUnlocked(tl, r);
      html += `<div class="trow${locked ? " locked" : ""}">`;
      for (const key of rows[r]) {
        const lvl = tl[key] || 0, mx = core.tMaxLvl(r, key), combat = TALENTS[key] && TALENTS[key].combat;
        const pips = Array.from({ length: mx }, (_, k) => `<i class="${k < lvl ? "on" : ""}"></i>`).join("");
        html += `<div class="tcell${lvl > 0 ? " active" : ""}${combat ? "" : " nocombat"}"`
          + ` data-row="${r}" data-key="${key}" title="${esc(tname(key))}">`
          + `<span class="tn">${esc(tname(key))}</span><span class="pips">${pips}</span></div>`;
      }
      html += `</div>`;
    }
    el.innerHTML = html;
    el.querySelectorAll(".tcell").forEach((c) =>
      c.addEventListener("click", () => cycle(+c.dataset.row, c.dataset.key)));
    el.querySelector(".treset").addEventListener("click", () => {
      for (const k in tl) delete tl[k]; render(); onChange();
    });
  }
  render();
}

// ---- Einheiten-Auswahl (besitze ich) --------------------------------------------------
function unitGroupHTML(title, abbrs) {
  const owned = new Set(profile.units);
  const chips = abbrs.map((a) =>
    `<button class="uchip${owned.has(a) ? "" : " off"}" data-abbr="${a}" title="${esc(uname(a))}">`
    + `${iconInner(a)}</button>`).join("");
  return `<div class="umode-h">${esc(title)}</div><div class="uchips">${chips}</div>`;
}
function renderUnits() {
  $("units").innerHTML = unitGroupHTML(T().normal, NORMAL_UNITS) + unitGroupHTML(T().special, SPECIAL_UNITS);
  $("units").querySelectorAll(".uchip").forEach((b) => b.addEventListener("click", () => {
    const a = b.dataset.abbr, set = new Set(profile.units);
    if (set.has(a)) set.delete(a); else set.add(a);
    profile.units = core.byOrder([...set]);
    saveProfile();
    b.classList.toggle("off");
  }));
}

// ---- Generals-Konfiguration -----------------------------------------------------------
function renderGenerals() {
  const host = $("generals");
  if (!profile.generals.length) { host.innerHTML = `<p class="sg-empty">${esc(T().emptyGen)}</p>`; return; }
  host.innerHTML = "";
  for (const g of profile.generals) host.appendChild(generalCard(g));
}
function generalCard(g) {
  const card = document.createElement("div");
  card.className = "pcard";
  const opts = GENERALS.slice().sort((a, b) => uname(a).localeCompare(uname(b), lang))
    .map((a) =>
      `<option value="${a}"${a === g.general ? " selected" : ""}>${esc(uname(a))}</option>`).join("");
  card.innerHTML = `<div class="pcard-head">`
    + `<select class="genrow-sel">${opts}</select>`
    + `<input class="lbl-in" type="text" maxlength="80" placeholder="${esc(T().labelPh)}" value="${esc(g.label || "")}">`
    + `<button class="pcard-del">${esc(T().del)}</button></div>`
    + `<div class="talents"></div>`;
  card.querySelector(".genrow-sel").addEventListener("change", (e) => { g.general = e.target.value; saveProfile(); });
  card.querySelector(".lbl-in").addEventListener("input", (e) => { g.label = e.target.value; saveProfile(); });
  card.querySelector(".pcard-del").addEventListener("click", () => {
    profile.generals = profile.generals.filter((x) => x !== g); saveProfile(); renderGenerals();
  });
  mountTalentTree(card.querySelector(".talents"), g.talents, saveProfile);
  return card;
}

// ---- Export / Import ------------------------------------------------------------------
function exportProfile() {
  const blob = new Blob([JSON.stringify(profile, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "tso-profil.json";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function importProfile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      profile = migrateProfile(JSON.parse(reader.result));
      saveProfile(); renderUnits(); renderGenerals();
    } catch { alert(T().importErr); }
  };
  reader.readAsText(file);
}

// ---- Navigation + Sprache -------------------------------------------------------------
function renderNav() {
  const t = T();
  $("nav").innerHTML = [
    ["/", t.navSim, false], ["profil.html", t.navProfile, true], ["planer.html", t.navPlanner, false],
  ].map(([href, label, on]) => `<a href="${href}" class="${on ? "on" : ""}">${esc(label)}</a>`).join("");
}
function applyLang() {
  document.documentElement.lang = lang;
  const t = T();
  $("title").textContent = t.title;
  document.title = `${t.title} – Die Siedler Online Kampfsimulator`;
  $("betanote").textContent = t.betaNote;
  $("unitshead").textContent = t.unitsHead;
  $("generalshead").textContent = t.generalsHead;
  $("addgen").textContent = t.addGen;
  $("exportbtn").textContent = t.export;
  $("importbtn").textContent = t.import;
  for (const l of LANGS) $(`lang-${l}`).classList.toggle("on", l === lang);
  renderNav();
  renderUnits();
  renderGenerals();
}
for (const l of LANGS) $(`lang-${l}`).addEventListener("click", () => {
  lang = l; localStorage.setItem("tso_lang", l); applyLang();
});
$("addgen").addEventListener("click", () => {
  profile.generals.push({ id: newId(), general: GENERALS[0], label: "", talents: {} });
  saveProfile(); renderGenerals();
});
$("exportbtn").addEventListener("click", exportProfile);
$("importbtn").addEventListener("click", () => $("importfile").click());
$("importfile").addEventListener("change", (e) => { if (e.target.files[0]) importProfile(e.target.files[0]); e.target.value = ""; });

applyLang();
