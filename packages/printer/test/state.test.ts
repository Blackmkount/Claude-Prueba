import { describe, expect, it } from "vitest";
import {
  activeFaults,
  deepMerge,
  developerModeMissing,
  mergeReport,
  parseHms,
  printErrorShort,
  toSnapshot,
  wasCancelled,
  type RawPrintState,
} from "../src/index.js";

const fullReport = {
  print: {
    command: "push_status",
    sequence_id: "400",
    gcode_state: "IDLE",
    mc_percent: 0,
    mc_remaining_time: 0,
    nozzle_temper: 27.8,
    bed_temper: 29.7,
    print_error: 0,
    sdcard: true,
    home_flag: 0x100,
    nozzle_diameter: "0.4",
    fun: "3EC18FFF9CFF",
    hms: [],
    ams: {
      ams: [
        {
          id: "0",
          tray: [
            { id: "0" },
            { id: "1", tray_type: "PLA", tray_color: "9A6A42FF", remain: 80 },
            { id: "2", tray_type: "PETG", tray_color: "FFFFFFFF", remain: 50 },
            { id: "3", tray_type: "PLA", tray_color: "000000FF", remain: -1 },
          ],
        },
      ],
      ams_exist_bits: "1",
      tray_exist_bits: "e",
      tray_now: "255",
    },
    vt_tray: { id: "254", tray_type: "PLA", tray_color: "FFFFFFFF" },
  },
};

describe("mergeReport", () => {
  it("acumula mensajes parciales sin perder campos", () => {
    let state: RawPrintState = mergeReport({}, fullReport);
    state = mergeReport(state, {
      print: { command: "push_status", gcode_state: "RUNNING", mc_percent: 12 },
    });
    state = mergeReport(state, { print: { command: "push_status", nozzle_temper: 220.1 } });
    const s = toSnapshot(state);
    expect(s.gcodeState).toBe("RUNNING");
    expect(s.percent).toBe(12);
    expect(s.nozzleTemp).toBe(220.1);
    expect(s.bedTemp).toBe(29.7); // del primer mensaje
    expect(s.amsTrays).toHaveLength(4);
  });

  it("fusiona bandejas del AMS por id", () => {
    let state = mergeReport({}, fullReport);
    state = mergeReport(state, {
      print: {
        command: "push_status",
        ams: { ams: [{ id: "0", tray: [{ id: "1", remain: 75 }] }] },
      },
    });
    const s = toSnapshot(state);
    const tray1 = s.amsTrays.find((t) => t.globalId === 1)!;
    expect(tray1.remainPercent).toBe(75);
    expect(tray1.type).toBe("PLA");
    expect(tray1.color).toBe("#9A6A42");
  });

  it("reemplaza la lista de errores HMS completa", () => {
    let state = mergeReport(
      {},
      { print: { command: "push_status", hms: [{ attr: 0x05000500, code: 0x00010007 }] } },
    );
    expect(toSnapshot(state).hms).toHaveLength(1);
    state = mergeReport(state, { print: { command: "push_status", hms: [] } });
    expect(toSnapshot(state).hms).toHaveLength(0);
  });

  it("ignora respuestas a comandos", () => {
    const state = mergeReport(mergeReport({}, fullReport), {
      print: {
        command: "project_file",
        sequence_id: "9",
        result: "success",
        gcode_state: "RUNNING",
      },
    });
    expect(toSnapshot(state).gcodeState).toBe("IDLE");
    expect(state.result).toBeUndefined();
  });

  it("ignora mensajes que no son de estado", () => {
    const state = mergeReport({}, { info: { command: "get_version" } });
    expect(state).toEqual({});
  });
});

describe("toSnapshot", () => {
  it("interpreta AMS lite, bobina externa y microSD", () => {
    const s = toSnapshot(mergeReport({}, fullReport));
    expect(s.hasAms).toBe(true);
    expect(s.amsTrays.map((t) => [t.globalId, t.loaded, t.type])).toEqual([
      [0, false, undefined],
      [1, true, "PLA"],
      [2, true, "PETG"],
      [3, true, "PLA"],
    ]);
    expect(s.amsTrays[3]!.remainPercent).toBeUndefined();
    expect(s.externalSpool).toMatchObject({
      globalId: 254,
      loaded: true,
      type: "PLA",
      color: "#FFFFFF",
    });
    expect(s.activeTray).toBeUndefined();
    expect(s.sdCard).toBe("present");
    expect(s.nozzleDiameter).toBe(0.4);
    expect(s.signatureRequired).toBe(false);
  });

  it("detecta impresora sin AMS", () => {
    const s = toSnapshot({
      gcode_state: "IDLE",
      vt_tray: { tray_type: "PETG", tray_color: "FF0000FF" },
    });
    expect(s.hasAms).toBe(false);
    expect(s.amsTrays).toEqual([]);
    expect(s.externalSpool?.type).toBe("PETG");
  });

  it("detecta microSD ausente o dañada", () => {
    expect(toSnapshot({ sdcard: false }).sdCard).toBe("missing");
    expect(toSnapshot({ home_flag: 0x300, sdcard: true }).sdCard).toBe("abnormal");
    expect(toSnapshot({}).sdCard).toBe("unknown");
  });

  it("detecta el Modo desarrollador apagado por el bit de fun o por HMS", () => {
    expect(developerModeMissing(toSnapshot({ fun: "3EC1AFFF9CFF" }))).toBe(true);
    expect(developerModeMissing(toSnapshot({ fun: "3EC18FFF9CFF" }))).toBe(false);
    expect(
      developerModeMissing(toSnapshot({ hms: [{ attr: 0x05000500, code: 0x00010007 }] })),
    ).toBe(true);
    expect(toSnapshot({}).signatureRequired).toBeNull();
  });

  it("distingue cancelación de falla", () => {
    const cancelled = toSnapshot({ gcode_state: "FAILED", print_error: 0x0300400c });
    expect(wasCancelled(cancelled)).toBe(true);
    const failed = toSnapshot({
      gcode_state: "FAILED",
      print_error: 0x07008011,
      hms: [{ attr: 0x05000400, code: 0x0002400e }],
    });
    expect(wasCancelled(failed)).toBe(true); // HMS 0500_400E = impresión cancelada
    const fault = toSnapshot({
      gcode_state: "FAILED",
      print_error: 0x07008011,
      hms: [{ attr: 0x07000100, code: 0x00028011 }],
    });
    expect(wasCancelled(fault)).toBe(false);
    expect(activeFaults(fault).map((h) => h.short)).toEqual(["0700_8011"]);
  });

  it("estado desconocido si no llegó gcode_state", () => {
    expect(toSnapshot({}).gcodeState).toBe("UNKNOWN");
    expect(toSnapshot({ gcode_state: "running" }).gcodeState).toBe("RUNNING");
  });
});

describe("HMS", () => {
  it("arma los códigos completo y corto", () => {
    expect(parseHms([{ attr: 0x05000500, code: 0x00010007 }])).toEqual([
      { attr: 0x05000500, code: 0x00010007, full: "0500050000010007", short: "0500_0007" },
    ]);
    expect(printErrorShort(0x0300400c)).toBe("0300_400C");
  });
});

describe("deepMerge", () => {
  it("reemplaza arreglos sin id", () => {
    expect(deepMerge({ a: [1, 2, 3] }, { a: [4] })).toEqual({ a: [4] });
  });
  it("agrega elementos nuevos por id", () => {
    expect(deepMerge({ t: [{ id: "0", x: 1 }] }, { t: [{ id: "1", x: 2 }] })).toEqual({
      t: [
        { id: "0", x: 1 },
        { id: "1", x: 2 },
      ],
    });
  });
});
