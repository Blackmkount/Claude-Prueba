// Constructores de los mensajes que se publican en `device/<serie>/request`.
// Formato verificado en docs/protocolo-a1.md (secciones 2.3, 3 y 3.4).

/** Cómo se le dice a la impresora dónde está el archivo. Ver protocolo-a1.md §3.1. */
export type UrlStyle =
  /** `ftp://archivo.3mf` (Bambuddy; el más usado hoy en A1). */
  | "ftp"
  /** `file:///sdcard/archivo.3mf` (ha-bambulab para A1/P1/X1). */
  | "sdcard"
  /** `ftp:///archivo.3mf` (variante de OpenBambuAPI). */
  | "ftp3";

export const URL_STYLES: readonly UrlStyle[] = ["ftp", "sdcard", "ftp3"];

export function buildFileUrl(style: UrlStyle, remoteName: string): string {
  const name = remoteName.replace(/^\/+/, "");
  switch (style) {
    case "ftp":
      return `ftp://${name}`;
    case "sdcard":
      return `file:///sdcard/${name}`;
    case "ftp3":
      return `ftp:///${name}`;
  }
}

/** Nivelación / calibración de flujo: nunca, siempre o automática (la impresora decide). */
export type TriState = "off" | "on" | "auto";
const TRI_STATE_WIRE: Record<TriState, number> = { off: 0, on: 1, auto: 2 };

export interface PrintOptions {
  bedLeveling: TriState;
  flowCalibration: TriState;
  vibrationCalibration: boolean;
  layerInspect: boolean;
  timelapse: boolean;
}

export const DEFAULT_PRINT_OPTIONS: PrintOptions = {
  bedLeveling: "auto",
  flowCalibration: "auto",
  vibrationCalibration: true,
  layerInspect: false,
  timelapse: false,
};

/** Valor de mapeo para la bobina externa. */
export const EXTERNAL_SPOOL = 254;
/** Valor de mapeo para un filamento del archivo que no se usa. */
export const UNUSED_FILAMENT = -1;

/**
 * Mapeo de filamento: posición = filamento del archivo (id − 1); valor = bandeja
 * global del AMS lite (0–15), EXTERNAL_SPOOL (254) o UNUSED_FILAMENT (-1).
 */
export type FilamentMapping = number[];

export interface ProjectFileParams {
  plateIndex: number;
  remoteName: string;
  urlStyle: UrlStyle;
  /** Texto que muestra la pantalla de la impresora, p. ej. "Oso x2". */
  displayName: string;
  /** ID único de este envío (< 2³¹−1). Lo usamos para reconocer nuestro trabajo. */
  taskId: string;
  filament: FilamentMapping;
  options: PrintOptions;
}

let sequence = Math.floor(Math.random() * 10_000);
/** `sequence_id` creciente para emparejar respuestas. */
export function nextSequenceId(): string {
  sequence = (sequence + 1) % 1_000_000_000;
  return String(sequence);
}

/** ID único de envío, dentro del rango de int32 que aceptan los firmwares. */
export function newTaskId(): string {
  const ms = Date.now() % 2_147_483_647;
  const jitter = Math.floor(Math.random() * 1000);
  return String(((ms + jitter) % 2_147_483_646) + 1);
}

export function pushAllCommand(sequenceId = nextSequenceId()) {
  return { pushing: { sequence_id: sequenceId, command: "pushall", version: 1, push_target: 1 } };
}

export function getVersionCommand(sequenceId = nextSequenceId()) {
  return { info: { sequence_id: sequenceId, command: "get_version" } };
}

export function pauseCommand(sequenceId = nextSequenceId()) {
  return { print: { sequence_id: sequenceId, command: "pause", param: "" } };
}

export function resumeCommand(sequenceId = nextSequenceId()) {
  return { print: { sequence_id: sequenceId, command: "resume", param: "" } };
}

export function stopCommand(sequenceId = nextSequenceId()) {
  return { print: { sequence_id: sequenceId, command: "stop", param: "" } };
}

export function projectFileCommand(p: ProjectFileParams, sequenceId = nextSequenceId()) {
  const mapping = p.filament.length > 0 ? p.filament : [EXTERNAL_SPOOL];
  const useAms = mapping.some((t) => t >= 0 && t < EXTERNAL_SPOOL);
  // La bobina externa va como -1 en el arreglo plano (el firmware no acepta 254)
  // y como ams_id 255 en ams_mapping2, que es lo que envía Bambu Studio en
  // impresoras de una boquilla como la A1. Ver protocolo-a1.md §3.2.
  const flat = mapping.map((t) => (t >= 0 && t < EXTERNAL_SPOOL ? t : UNUSED_FILAMENT));
  const detailed = mapping.map((t) => {
    if (t >= 0 && t < EXTERNAL_SPOOL) return { ams_id: Math.floor(t / 4), slot_id: t % 4 };
    if (t === EXTERNAL_SPOOL) return { ams_id: 255, slot_id: 0 };
    return { ams_id: 255, slot_id: 255 };
  });
  return {
    print: {
      sequence_id: sequenceId,
      command: "project_file",
      param: `Metadata/plate_${p.plateIndex}.gcode`,
      url: buildFileUrl(p.urlStyle, p.remoteName),
      file: p.remoteName.replace(/^\/+/, ""),
      md5: "",
      bed_type: "auto",
      timelapse: p.options.timelapse,
      bed_leveling: p.options.bedLeveling === "on",
      auto_bed_leveling: TRI_STATE_WIRE[p.options.bedLeveling],
      flow_cali: p.options.flowCalibration === "on",
      extrude_cali_flag: TRI_STATE_WIRE[p.options.flowCalibration],
      extrude_cali_manual_mode: 0,
      vibration_cali: p.options.vibrationCalibration,
      layer_inspect: p.options.layerInspect,
      use_ams: useAms,
      ams_mapping: flat,
      ams_mapping2: detailed,
      subtask_name: p.displayName,
      profile_id: "0",
      project_id: p.taskId,
      subtask_id: p.taskId,
      task_id: p.taskId,
    },
  };
}

/** Nombre del archivo en la microSD: ASCII, sin espacios, una sola extensión. */
export function remoteFileName(jobId: string): string {
  const safe = jobId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) || "trabajo";
  return `bf_${safe}.3mf`;
}

/** Prefijo de los archivos que sube esta app (para la limpieza de la microSD). */
export const REMOTE_FILE_PREFIX = "bf_";
