// Estado de la impresora.
//
// La A1 (como la P1) solo envía los campos que cambiaron, así que mantenemos un
// estado acumulado (`RawPrintState`) y fusionamos cada mensaje con `mergeReport`.
// `toSnapshot` convierte ese estado crudo en una vista tipada y estable que usa
// el resto de la app.

export type RawPrintState = Record<string, unknown>;

export const GCODE_STATES = [
  "IDLE",
  "PREPARE",
  "SLICING",
  "RUNNING",
  "PAUSE",
  "FINISH",
  "FAILED",
] as const;
export type GcodeState = (typeof GCODE_STATES)[number] | "UNKNOWN";

/** Estados en los que la impresora está trabajando: nunca se le envía otra impresión. */
export const ACTIVE_GCODE_STATES: ReadonlySet<GcodeState> = new Set([
  "PREPARE",
  "SLICING",
  "RUNNING",
  "PAUSE",
]);
/** Estados desde los que el firmware acepta iniciar una impresión. */
export const STARTABLE_GCODE_STATES: ReadonlySet<GcodeState> = new Set([
  "IDLE",
  "FINISH",
  "FAILED",
]);

/** `print_error` cuando la tarea fue cancelada por alguien (no es una falla). */
export const PRINT_ERROR_CANCELLED = 0x0300400c;
/** Códigos HMS cortos que solo confirman una cancelación. */
export const HMS_CANCEL_CODES: ReadonlySet<string> = new Set(["0300_400C", "0500_400E"]);
/** HMS completo: la impresora exige comandos firmados (Modo desarrollador apagado). */
export const HMS_MQTT_VERIFY_FAILED = "0500050000010007";
/** Bit de `print.fun` que indica que la impresora exige comandos firmados. */
export const FUN_MQTT_SIGNATURE_REQUIRED = 0x20000000;

const HOME_FLAG_SD_PRESENT = 0x100;
const HOME_FLAG_SD_ABNORMAL = 0x200;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIdArray(value: unknown): value is Array<Record<string, unknown>> {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (item) => isPlainObject(item) && (typeof item.id === "string" || typeof item.id === "number"),
    )
  );
}

/**
 * Fusión profunda: los objetos se fusionan campo a campo; los arreglos de
 * objetos con `id` (unidades AMS y sus bandejas) se fusionan por `id`; el resto
 * de arreglos (p. ej. `hms`) se reemplaza completo.
 */
export function deepMerge(target: unknown, patch: unknown): unknown {
  if (isPlainObject(target) && isPlainObject(patch)) {
    const out: Record<string, unknown> = { ...target };
    for (const [key, value] of Object.entries(patch)) {
      out[key] = key in target ? deepMerge(target[key], value) : value;
    }
    return out;
  }
  if (isIdArray(target) && isIdArray(patch)) {
    const out = target.map((item) => ({ ...item }));
    for (const item of patch) {
      const idx = out.findIndex((existing) => String(existing.id) === String(item.id));
      if (idx >= 0) out[idx] = deepMerge(out[idx], item) as Record<string, unknown>;
      else out.push(item);
    }
    return out;
  }
  return patch;
}

/**
 * Fusiona un mensaje de `device/<serie>/report` en el estado acumulado.
 * Solo los reportes de estado (`print.command === "push_status"`) se fusionan;
 * las respuestas a comandos no tocan el estado.
 */
export function mergeReport(state: RawPrintState, message: unknown): RawPrintState {
  if (!isPlainObject(message)) return state;
  const print = message.print;
  if (!isPlainObject(print)) return state;
  if (print.command !== undefined && print.command !== "push_status") return state;
  const { command: _command, sequence_id: _seq, msg: _msg, ...fields } = print;
  return deepMerge(state, fields) as RawPrintState;
}

// ---------------------------------------------------------------------------
// Vista tipada

export interface HmsCode {
  /** Código completo de 16 hex: attr (8) + code (8). */
  full: string;
  /** Forma corta MMMM_EEEE usada en la wiki de Bambu (p. ej. 0500_4004). */
  short: string;
  attr: number;
  code: number;
}

export interface Tray {
  /** Identificador global: (ams_id * 4) + bandeja. 254 = bobina externa. */
  globalId: number;
  amsId: number;
  slot: number;
  loaded: boolean;
  type?: string;
  /** #RRGGBB */
  color?: string;
  remainPercent?: number;
}

export interface PrinterSnapshot {
  gcodeState: GcodeState;
  percent?: number;
  remainingMinutes?: number;
  layer?: number;
  totalLayers?: number;
  stage?: number;
  nozzleTemp?: number;
  nozzleTarget?: number;
  bedTemp?: number;
  bedTarget?: number;
  /** 0 = sin error. */
  printError: number;
  hms: HmsCode[];
  sdCard: "present" | "missing" | "abnormal" | "unknown";
  nozzleDiameter?: number;
  taskId?: string;
  subtaskId?: string;
  subtaskName?: string;
  gcodeFile?: string;
  hasAms: boolean;
  amsTrays: Tray[];
  externalSpool?: Tray;
  /** Bandeja en uso: 0–15 AMS, 254 externa, undefined si ninguna. */
  activeTray?: number;
  /** null = no se sabe todavía. */
  signatureRequired: boolean | null;
  wifiSignal?: string;
}

function toNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function toStr(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const s = String(value);
  return s === "" ? undefined : s;
}

function hex8(n: number): string {
  return (n >>> 0).toString(16).toUpperCase().padStart(8, "0");
}

export function parseHms(raw: unknown): HmsCode[] {
  if (!Array.isArray(raw)) return [];
  const out: HmsCode[] = [];
  for (const item of raw) {
    if (!isPlainObject(item)) continue;
    const attr = toNumber(item.attr);
    const code = toNumber(item.code);
    if (attr === undefined || code === undefined) continue;
    out.push({
      attr,
      code,
      full: hex8(attr) + hex8(code),
      short: `${hex8(attr).slice(0, 4)}_${hex8(code).slice(4)}`,
    });
  }
  return out;
}

/** Forma corta MMMM_EEEE de un `print_error` de 32 bits. */
export function printErrorShort(printError: number): string {
  const h = hex8(printError);
  return `${h.slice(0, 4)}_${h.slice(4)}`;
}

function colorFromTray(raw: unknown): string | undefined {
  const s = toStr(raw);
  if (!s || !/^[0-9a-fA-F]{6,8}$/.test(s)) return undefined;
  return `#${s.slice(0, 6).toUpperCase()}`;
}

function parseBits(raw: unknown): number | undefined {
  const s = toStr(raw);
  if (!s) return undefined;
  const n = parseInt(s, 16);
  return Number.isFinite(n) ? n : undefined;
}

export function toSnapshot(state: RawPrintState): PrinterSnapshot {
  const rawState = toStr(state.gcode_state)?.toUpperCase();
  const gcodeState: GcodeState = (GCODE_STATES as readonly string[]).includes(rawState ?? "")
    ? (rawState as GcodeState)
    : "UNKNOWN";

  // microSD: el campo `sdcard` es directo; `home_flag` da además "dañada".
  let sdCard: PrinterSnapshot["sdCard"] = "unknown";
  const homeFlag = toNumber(state.home_flag);
  if (homeFlag !== undefined) {
    if (homeFlag & HOME_FLAG_SD_ABNORMAL) sdCard = "abnormal";
    else if (homeFlag & HOME_FLAG_SD_PRESENT) sdCard = "present";
    else sdCard = "missing";
  }
  if (typeof state.sdcard === "boolean" && sdCard !== "abnormal")
    sdCard = state.sdcard ? "present" : "missing";

  // AMS lite
  const ams = isPlainObject(state.ams) ? state.ams : undefined;
  const amsUnits = Array.isArray(ams?.ams) ? (ams.ams as unknown[]) : [];
  const amsExistBits = parseBits(ams?.ams_exist_bits);
  const trayExistBits = parseBits(ams?.tray_exist_bits);
  const amsTrays: Tray[] = [];
  for (const unit of amsUnits) {
    if (!isPlainObject(unit)) continue;
    const amsId = toNumber(unit.id) ?? 0;
    if (amsExistBits !== undefined && !(amsExistBits & (1 << amsId))) continue;
    const trays = Array.isArray(unit.tray) ? unit.tray : [];
    for (const tray of trays) {
      if (!isPlainObject(tray)) continue;
      const slot = toNumber(tray.id) ?? 0;
      const globalId = amsId * 4 + slot;
      const type = toStr(tray.tray_type);
      const present = trayExistBits !== undefined ? (trayExistBits & (1 << globalId)) !== 0 : true;
      const remain = toNumber(tray.remain);
      amsTrays.push({
        globalId,
        amsId,
        slot,
        loaded: present && !!type,
        type: present ? type : undefined,
        color: present ? colorFromTray(tray.tray_color) : undefined,
        remainPercent: remain !== undefined && remain >= 0 ? remain : undefined,
      });
    }
  }
  const hasAms = amsTrays.length > 0 && (amsExistBits === undefined || amsExistBits !== 0);

  let externalSpool: Tray | undefined;
  if (isPlainObject(state.vt_tray)) {
    const type = toStr(state.vt_tray.tray_type);
    externalSpool = {
      globalId: 254,
      amsId: 255,
      slot: 0,
      loaded: !!type,
      type,
      color: colorFromTray(state.vt_tray.tray_color),
    };
  }

  const trayNow = toNumber(ams?.tray_now);
  const fun = parseBits(state.fun);

  return {
    gcodeState,
    percent: toNumber(state.mc_percent),
    remainingMinutes: toNumber(state.mc_remaining_time),
    layer: toNumber(state.layer_num),
    totalLayers: toNumber(state.total_layer_num),
    stage: toNumber(state.stg_cur),
    nozzleTemp: toNumber(state.nozzle_temper),
    nozzleTarget: toNumber(state.nozzle_target_temper),
    bedTemp: toNumber(state.bed_temper),
    bedTarget: toNumber(state.bed_target_temper),
    printError: toNumber(state.print_error) ?? 0,
    hms: parseHms(state.hms),
    sdCard,
    nozzleDiameter: toNumber(state.nozzle_diameter),
    taskId: toStr(state.task_id),
    subtaskId: toStr(state.subtask_id),
    subtaskName: toStr(state.subtask_name),
    gcodeFile: toStr(state.gcode_file),
    hasAms,
    amsTrays: hasAms ? amsTrays : [],
    externalSpool,
    activeTray: trayNow !== undefined && trayNow !== 255 ? trayNow : undefined,
    signatureRequired: fun === undefined ? null : (fun & FUN_MQTT_SIGNATURE_REQUIRED) !== 0,
    wifiSignal: toStr(state.wifi_signal),
  };
}

/** Errores HMS que no son de cancelación (los que de verdad son problemas). */
export function activeFaults(snapshot: PrinterSnapshot): HmsCode[] {
  return snapshot.hms.filter((h) => !HMS_CANCEL_CODES.has(h.short));
}

export function wasCancelled(snapshot: PrinterSnapshot): boolean {
  return (
    snapshot.printError === PRINT_ERROR_CANCELLED ||
    snapshot.hms.some((h) => HMS_CANCEL_CODES.has(h.short))
  );
}

export function developerModeMissing(snapshot: PrinterSnapshot): boolean {
  return (
    snapshot.signatureRequired === true ||
    snapshot.hms.some((h) => h.full === HMS_MQTT_VERIFY_FAILED)
  );
}
