// © 2026 Dennis Thielsch – Alle Rechte vorbehalten / All rights reserved.
// Kein Kopieren, Verändern oder Weitergeben ohne schriftliche Genehmigung. Siehe LICENSE.
//
// Spielerprofil-Speicher (gemeinsam für profil.js und planer.js): versioniertes Datenmodell,
// localStorage-Persistenz und Migrations-Hook für ältere/fremde JSON-Dateien.
import * as core from "./core.js?v=20260628111218";
const { LIST_A, NORMAL_UNITS, UMAP, GENERALS, TALENTS } = core;

export const PROFILE_VERSION = 1;
export const PROFILE_FORMAT = "tso-player-profile";
const PROFILE_KEY = "tso_profile";

export const newId = () => "g" + Math.random().toString(36).slice(2, 9);
export const emptyProfile = () => ({ format: PROFILE_FORMAT, version: PROFILE_VERSION,
  units: [...NORMAL_UNITS], generals: [] });

// Talentbelegung säubern: nur bekannte Talente mit Stufe > 0, dann Zeilensperren erzwingen.
export function cleanTalents(raw) {
  const tl = {};
  if (raw && typeof raw === "object") {
    for (const k in raw) {
      const lvl = parseInt(raw[k], 10) || 0;
      if (lvl > 0 && TALENTS[k]) tl[k] = lvl;
    }
  }
  core.tEnforceLocks(tl);
  for (const k in tl) if (!tl[k]) delete tl[k];   // tEnforceLocks kann 0-Einträge hinterlassen
  return tl;
}
function normalizeGeneral(g) {
  if (!g || !UMAP[g.general] || !GENERALS.includes(g.general)) return null;
  return { id: typeof g.id === "string" ? g.id : newId(),
    general: g.general, label: typeof g.label === "string" ? g.label.slice(0, 80) : "",
    talents: cleanTalents(g.talents) };
}
// Älteres/Fremdformat auf das aktuelle Schema heben (Migrations-Hook für künftige Versionen).
export function migrateProfile(obj) {
  if (!obj || typeof obj !== "object" || obj.format !== PROFILE_FORMAT) throw new Error("bad format");
  const v = parseInt(obj.version, 10) || 0;
  if (v > PROFILE_VERSION) throw new Error("newer version");
  // while (v < PROFILE_VERSION) { /* künftige Migrationen je Version */ v++; }
  const units = Array.isArray(obj.units) ? obj.units.filter((a) => UMAP[a] && LIST_A.includes(a)) : [];
  const generals = Array.isArray(obj.generals) ? obj.generals.map(normalizeGeneral).filter(Boolean) : [];
  return { format: PROFILE_FORMAT, version: PROFILE_VERSION, units, generals };
}
export function loadProfile() {
  try { const raw = localStorage.getItem(PROFILE_KEY); if (raw) return migrateProfile(JSON.parse(raw)); }
  catch { /* defekt → frisches Profil */ }
  return emptyProfile();
}
export function saveProfile(profile) {
  for (const g of profile.generals) for (const k in g.talents) if (!g.talents[k]) delete g.talents[k];
  try { localStorage.setItem(PROFILE_KEY, JSON.stringify(profile)); } catch { /* Speicher voll/aus */ }
}
