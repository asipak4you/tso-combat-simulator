// © 2026 Dennis Thielsch – Alle Rechte vorbehalten / All rights reserved. Siehe LICENSE.
//
// Web Worker: hält den WASM-Kern und löst Kämpfe abseits des Haupt-Threads,
// damit die Oberfläche während langer Berechnungen reagiert (Spinner/Abbrechen).
import createTsoModule from "./tso.js?v=20260628111218";

const Module = await createTsoModule({ locateFile: (p) => p + "?v=20260628111218" });
const catalog = JSON.parse(Module.ccall("tso_catalog_json", "string", [], []));

// Liest EINEN Ergebnisblock ab Index i (in doubles); gibt [Ergebnis|null, nextI].
function readBlock(H, i) {
  if (!H[i++]) return [null, i];
  const r = {
    win_a: H[i++], draw: H[i++], win_b: H[i++], rounds: H[i++], residual: H[i++],
    start_a: H[i++] | 0, start_b: H[i++] | 0, states: H[i++], nstack_a: H[i++] | 0, nstack_b: H[i++] | 0,
    rounds_min: H[i++] | 0, rounds_max: H[i++] | 0,
  };
  const arr = (n) => { const a = []; for (let k = 0; k < n; k++) a.push(H[i++]); return a; };
  r.loss_a = arr(r.start_a + 1); r.loss_b = arr(r.start_b + 1);
  const side = (ns) => { const s = []; for (let j = 0; j < ns; j++) { const ab = catalog[H[i++] | 0].abbr; const c = H[i++] | 0; s.push({ abbr: ab, count0: c, surv: arr(c + 1) }); } return s; };
  r.stacks_a = side(r.nstack_a); r.stacks_b = side(r.nstack_b);
  return [r, i];
}

function solve(specA, specB, eps, quant, modsA) {
  const lenPtr = Module._malloc(4);
  const ptr = Module.ccall("tso_solve", "number",
    ["string", "string", "number", "number", "string", "number"],
    [specA, specB, eps, quant, modsA || "", lenPtr]);
  Module._free(lenPtr);
  const [r] = readBlock(Module.HEAPF64, ptr / 8);
  Module.ccall("tso_solve_free", null, ["number"], [ptr]);
  return r;
}

// Mehrere Angriffswellen als Schleife von Einzelkämpfen: Zwischen den Wellen wird der
// Gegner auf EINEN deterministischen Worst-Case-Zustand kollabiert – je Stack die größte
// Überlebendenzahl, deren Wahrscheinlichkeit gerade noch an der Anzeige-Schwelle (HEPS)
// liegt. Folgewellen sind damit normale Einzelkämpfe gegen einen reduzierten Gegner
// (volle LP), was Pro-Welle-Gegnerverluste EXAKT macht und alles deutlich beschleunigt.
const WHEPS = 1e-6;
const worstDisplayed = (surv) => { let m = 0; for (let k = 0; k < surv.length; k++) if (surv[k] >= WHEPS) m = k; return m; };
const collapseEnemy = (stacks_b) => stacks_b
  .map((u) => ({ abbr: u.abbr, n: worstDisplayed(u.surv) }))
  .filter((e) => e.n > 0).map((e) => `${e.n}x${e.abbr}`).join(", ");

// Liefert { waves:[Ergebnis…], cleared } oder null.
function solveWaves(waves, specB, eps, quant) {
  const out = [];
  let enemy = specB;
  for (let w = 0; w < waves.length; w++) {
    if (!enemy) break;                          // Gegner (Worst-Case) bereits geräumt
    const r = solve(waves[w].specA, enemy, eps, quant, waves[w].modsA);
    if (!r) return null;
    out.push(r);
    enemy = collapseEnemy(r.stacks_b);          // deterministischer Eintritt der Folgewelle
  }
  // Gesamt-Siegchance (Worst-Case-Annahme): die letzte tatsächlich gekämpfte Welle räumt
  // ihren (reduzierten) Gegner mit dieser Wahrscheinlichkeit.
  const cleared = out.length ? out[out.length - 1].win_a : 0;
  return { waves: out, cleared };
}

self.onmessage = (e) => {
  const d = e.data;
  const result = d.waves ? solveWaves(d.waves, d.specB, d.eps, d.quant)
                         : solve(d.specA, d.specB, d.eps, d.quant, d.modsA);
  // heapBytes: aktuelle WASM-Linearspeichergröße. Der Dispatcher erneuert diesen Worker einzeln,
  // wenn der Heap eine Schwelle reißt (er schrumpft nie von selbst – siehe core.js recycleWorker).
  self.postMessage({ result, heapBytes: Module.HEAPF64.buffer.byteLength });
};

// Bereit melden + Katalog an den Haupt-Thread liefern (dort für die UI gebraucht).
self.postMessage({ ready: true, catalog });
