// Emparejar los filamentos que pide el archivo con lo que tiene cargado la
// impresora (AMS lite o bobina externa) y armar el mapeo para `project_file`.
import type { SlicedFilament } from "@blackforge/threemf";
import { EXTERNAL_SPOOL, UNUSED_FILAMENT, type FilamentMapping } from "./commands.js";
import type { PrinterSnapshot, Tray } from "./state.js";

export interface FilamentMatch {
  filament: SlicedFilament;
  /** Bandeja elegida (globalId 254 = bobina externa). */
  tray?: Tray;
  /** El tipo coincide (PLA con PLA…). null = no se sabe qué hay cargado. */
  typeMatches: boolean | null;
  /** El color se parece (ΔE < 20). null = no se sabe. */
  colorMatches: boolean | null;
  colorDistance?: number;
}

export interface FilamentPlan {
  mapping: FilamentMapping;
  matches: FilamentMatch[];
  /** Todo coincide en tipo y color. */
  allMatch: boolean;
  /** Algún filamento no tiene dónde imprimirse (AMS sin bandeja y sin bobina). */
  missing: boolean;
}

/** "PLA Basic", "PLA-S" → "PLA"; "PETG HF" → "PETG". */
export function normalizeMaterial(type: string | undefined): string | undefined {
  if (!type) return undefined;
  const t = type.toUpperCase().trim();
  for (const base of ["PETG", "PET", "PLA", "ABS", "ASA", "TPU", "PA", "PC", "PVA", "HIPS"]) {
    if (
      t === base ||
      t.startsWith(`${base}-`) ||
      t.startsWith(`${base} `) ||
      t.startsWith(`${base}+`)
    )
      return base;
  }
  return t;
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function rgbToLab([r, g, b]: [number, number, number]): [number, number, number] {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  const y = R * 0.2126 + G * 0.7152 + B * 0.0722;
  const z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

/** Diferencia de color perceptual (CIE76). < 10 casi igual; > 30 claramente distinto. */
export function colorDistance(a: string, b: string): number {
  const [l1, a1, b1] = rgbToLab(hexToRgb(a));
  const [l2, a2, b2] = rgbToLab(hexToRgb(b));
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

const COLOR_MATCH_THRESHOLD = 20;

function score(
  filament: SlicedFilament,
  tray: Tray,
): { score: number; typeMatches: boolean | null; distance?: number } {
  const want = normalizeMaterial(filament.type);
  const have = normalizeMaterial(tray.type);
  const typeMatches = have === undefined ? null : want === have;
  const distance = tray.color ? colorDistance(filament.color, tray.color) : undefined;
  // Prioridad: tipo correcto (muy importante) y luego color más cercano.
  let s = 0;
  if (typeMatches === true) s += 1000;
  if (typeMatches === null) s += 400;
  s += distance === undefined ? 0 : Math.max(0, 200 - distance);
  if (tray.globalId !== EXTERNAL_SPOOL) s += 1; // a igualdad, preferir AMS
  return { score: s, typeMatches, distance };
}

/**
 * Elige, para cada filamento usado, la bandeja más parecida. Con AMS lite se
 * consideran sus bandejas cargadas y la bobina externa; sin AMS, solo la externa.
 * `forceTray` permite imponer una bandeja (0–15) o la externa (254) para todos.
 */
export function planFilament(
  filaments: SlicedFilament[],
  snapshot: PrinterSnapshot,
  forceTray?: number,
): FilamentPlan {
  const used = filaments.filter((f) => f.id > 0);
  const maxId = used.reduce((m, f) => Math.max(m, f.id), 0);
  const mapping: FilamentMapping = new Array(Math.max(1, maxId)).fill(UNUSED_FILAMENT);

  const candidates: Tray[] = [];
  if (snapshot.hasAms) candidates.push(...snapshot.amsTrays.filter((t) => t.loaded));
  const external: Tray = snapshot.externalSpool ?? {
    globalId: EXTERNAL_SPOOL,
    amsId: 255,
    slot: 0,
    loaded: false,
  };
  if (!snapshot.hasAms || external.loaded) candidates.push(external);

  const matches: FilamentMatch[] = [];
  const taken = new Set<number>();
  for (const filament of used) {
    let tray: Tray | undefined;
    let typeMatches: boolean | null = null;
    let distance: number | undefined;
    if (forceTray !== undefined) {
      tray =
        forceTray === EXTERNAL_SPOOL
          ? external
          : (snapshot.amsTrays.find((t) => t.globalId === forceTray) ?? {
              globalId: forceTray,
              amsId: Math.floor(forceTray / 4),
              slot: forceTray % 4,
              loaded: false,
            });
      const s = score(filament, tray);
      typeMatches = s.typeMatches;
      distance = s.distance;
    } else {
      let best:
        { tray: Tray; score: number; typeMatches: boolean | null; distance?: number } | undefined;
      for (const candidate of candidates) {
        if (taken.has(candidate.globalId) && candidate.globalId !== EXTERNAL_SPOOL) continue;
        const s = score(filament, candidate);
        if (!best || s.score > best.score) best = { tray: candidate, ...s };
      }
      if (best) {
        tray = best.tray;
        typeMatches = best.typeMatches;
        distance = best.distance;
        taken.add(best.tray.globalId);
      }
    }
    if (tray) mapping[filament.id - 1] = tray.globalId;
    matches.push({
      filament,
      tray,
      typeMatches,
      colorMatches: distance === undefined ? null : distance < COLOR_MATCH_THRESHOLD,
      colorDistance: distance,
    });
  }
  if (used.length === 0)
    mapping[0] = snapshot.hasAms ? (candidates[0]?.globalId ?? EXTERNAL_SPOOL) : EXTERNAL_SPOOL;

  return {
    mapping,
    matches,
    allMatch: matches.every((m) => m.typeMatches === true && m.colorMatches === true),
    missing: matches.some((m) => !m.tray),
  };
}
