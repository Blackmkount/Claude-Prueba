import type { SlicedFilament } from "@blackforge/threemf";
import { describe, expect, it } from "vitest";
import { colorDistance, normalizeMaterial, planFilament, toSnapshot } from "../src/index.js";

const brownPla: SlicedFilament = {
  id: 1,
  type: "PLA",
  color: "#9A6A42",
  usedGrams: 38,
  usedMeters: 12,
};

const withAms = toSnapshot({
  gcode_state: "IDLE",
  ams: {
    ams: [
      {
        id: "0",
        tray: [
          { id: "0", tray_type: "PLA", tray_color: "FFFFFFFF" },
          { id: "1", tray_type: "PETG", tray_color: "9A6A42FF" },
          { id: "2", tray_type: "PLA", tray_color: "8F6440FF" },
          { id: "3" },
        ],
      },
    ],
    ams_exist_bits: "1",
    tray_exist_bits: "7",
  },
  vt_tray: { tray_type: "", tray_color: "00000000" },
});

const external = (type: string, color: string) =>
  toSnapshot({ gcode_state: "IDLE", vt_tray: { tray_type: type, tray_color: color } });

describe("planFilament", () => {
  it("con AMS lite elige la bandeja del mismo tipo y color más cercano", () => {
    const plan = planFilament([brownPla], withAms);
    expect(plan.mapping).toEqual([2]);
    expect(plan.matches[0]).toMatchObject({ typeMatches: true, colorMatches: true });
    expect(plan.allMatch).toBe(true);
  });

  it("prefiere el tipo correcto sobre el color exacto", () => {
    const plan = planFilament([brownPla], withAms);
    expect(plan.matches[0]!.tray!.type).toBe("PLA"); // no el PETG del mismo color
  });

  it("sin AMS usa la bobina externa y compara", () => {
    const ok = planFilament([brownPla], external("PLA", "9A6A42FF"));
    expect(ok.mapping).toEqual([254]);
    expect(ok.allMatch).toBe(true);
    const wrong = planFilament([brownPla], external("PETG", "FFFFFFFF"));
    expect(wrong.mapping).toEqual([254]);
    expect(wrong.matches[0]).toMatchObject({ typeMatches: false, colorMatches: false });
    expect(wrong.allMatch).toBe(false);
  });

  it("bobina externa sin datos: se usa, pero no se puede confirmar", () => {
    const plan = planFilament([brownPla], external("", "00000000"));
    expect(plan.mapping).toEqual([254]);
    expect(plan.matches[0]!.typeMatches).toBeNull();
    expect(plan.allMatch).toBe(false);
  });

  it("respeta posiciones de filamentos no usados", () => {
    const plan = planFilament([{ ...brownPla, id: 3 }], withAms);
    expect(plan.mapping).toEqual([-1, -1, 2]);
  });

  it("multicolor: no repite bandeja", () => {
    const plan = planFilament(
      [brownPla, { id: 2, type: "PLA", color: "#FFFFFF", usedGrams: 5, usedMeters: 2 }],
      withAms,
    );
    expect(plan.mapping).toEqual([2, 0]);
  });

  it("AMS lite vacío y sin bobina externa: no hay dónde imprimir", () => {
    const empty = toSnapshot({
      gcode_state: "IDLE",
      ams: {
        ams: [{ id: "0", tray: [{ id: "0" }, { id: "1" }, { id: "2" }, { id: "3" }] }],
        ams_exist_bits: "1",
        tray_exist_bits: "0",
      },
      vt_tray: { tray_type: "", tray_color: "00000000" },
    });
    const plan = planFilament([brownPla], empty);
    expect(plan.missing).toBe(true);
    expect(plan.mapping).toEqual([-1]);
  });

  it("bandeja forzada", () => {
    expect(planFilament([brownPla], withAms, 0).mapping).toEqual([0]);
    expect(planFilament([brownPla], withAms, 254).mapping).toEqual([254]);
  });
});

describe("utilidades", () => {
  it("normaliza materiales", () => {
    expect(normalizeMaterial("PLA Basic")).toBe("PLA");
    expect(normalizeMaterial("PLA-CF")).toBe("PLA");
    expect(normalizeMaterial("PETG HF")).toBe("PETG");
    expect(normalizeMaterial("PCTG")).toBe("PCTG");
    expect(normalizeMaterial(undefined)).toBeUndefined();
  });
  it("distancia de color", () => {
    expect(colorDistance("#FFFFFF", "#FFFFFF")).toBe(0);
    expect(colorDistance("#000000", "#FFFFFF")).toBeGreaterThan(90);
    expect(colorDistance("#9A6A42", "#8F6440")).toBeLessThan(10);
  });
});
