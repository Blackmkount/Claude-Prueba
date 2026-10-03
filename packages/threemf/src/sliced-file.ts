// Lectura de un archivo .gcode.3mf exportado por Bambu Studio.
//
// Estructura relevante (ver docs/protocolo-a1.md, sección 5):
//   Metadata/plate_N.gcode       G-code de la placa N (sin esto, no está laminado)
//   Metadata/plate_N.png         Miniatura de la placa
//   Metadata/slice_info.config   XML con tiempo, gramos, modelo, filamentos por placa
import { XMLParser } from "fast-xml-parser";
import { ZipReadError, ZipReader } from "./zip.js";

export interface SlicedFilament {
  /** Posición del filamento en el proyecto de Bambu Studio (empieza en 1). */
  id: number;
  /** Tipo de material: PLA, PETG, TPU… */
  type: string;
  /** Color en formato #RRGGBB (mayúsculas). */
  color: string;
  usedGrams: number;
  usedMeters: number;
  /** Identificador de perfil de filamento de Bambu (p. ej. GFA00). */
  trayInfoIdx?: string;
}

export interface SlicedPlate {
  /** Número de placa (el de `Metadata/plate_<N>.gcode`). */
  index: number;
  gcodePath: string;
  gcodeBytes: number;
  thumbnailPath?: string;
  predictionSeconds?: number;
  weightGrams?: number;
  printerModelId?: string;
  nozzleDiameter?: number;
  bedType?: string;
  totalLayers?: number;
  /** Solo los filamentos que la placa realmente usa (used_g > 0). */
  filaments: SlicedFilament[];
  objectNames: string[];
}

export interface SlicedFileInfo {
  plates: SlicedPlate[];
  slicerVersion?: string;
  /** Advertencias no fatales (p. ej. falta slice_info.config). */
  warnings: string[];
}

export type SlicedFileErrorCode = "not_zip" | "not_sliced" | "corrupt";

export class SlicedFileError extends Error {
  constructor(
    readonly code: SlicedFileErrorCode,
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "SlicedFileError";
  }
}

/** Nombres comerciales por identificador interno de modelo de Bambu Lab. */
export const PRINTER_MODEL_NAMES: Record<string, string> = {
  N2S: "A1",
  N1: "A1 mini",
  C11: "P1P",
  C12: "P1S",
  C13: "X1E",
  "BL-P001": "X1 Carbon",
  "BL-P002": "X1",
  N7: "P2S",
  O1D: "H2D",
  O1S: "H2S",
};

export function printerModelName(modelId: string | undefined): string | undefined {
  if (!modelId) return undefined;
  return PRINTER_MODEL_NAMES[modelId] ?? modelId;
}

const PLATE_GCODE_RE = /^Metadata\/plate_(\d+)\.gcode$/;
const MAX_XML_BYTES = 4 * 1024 * 1024;
const GCODE_HEAD_BYTES = 64 * 1024;

export async function readSlicedFile(path: string): Promise<SlicedFileInfo> {
  let zip: ZipReader;
  try {
    zip = await ZipReader.open(path);
  } catch (err) {
    throw new SlicedFileError(
      "not_zip",
      "El archivo no es un .3mf válido (no se pudo abrir como ZIP).",
      err,
    );
  }
  try {
    return await readFromZip(zip);
  } finally {
    zip.close();
  }
}

async function readFromZip(zip: ZipReader): Promise<SlicedFileInfo> {
  const warnings: string[] = [];
  const entries = zip.list();

  const gcodeEntries = entries
    .map((e) => ({ entry: e, match: PLATE_GCODE_RE.exec(e.name) }))
    .filter((x): x is { entry: (typeof entries)[number]; match: RegExpExecArray } => !!x.match)
    .map((x) => ({ index: Number(x.match[1]), entry: x.entry }))
    .sort((a, b) => a.index - b.index);

  if (gcodeEntries.length === 0) {
    throw new SlicedFileError(
      "not_sliced",
      "El archivo no está laminado: no contiene G-code. Lamínalo en Bambu Studio y exporta con «Exportar archivo de placa laminada».",
    );
  }

  let sliceInfo: ParsedSliceInfo | undefined;
  if (zip.has("Metadata/slice_info.config")) {
    try {
      const xml = await zip.read("Metadata/slice_info.config", MAX_XML_BYTES);
      sliceInfo = parseSliceInfo(xml.toString("utf8"));
    } catch (err) {
      if (err instanceof ZipReadError) {
        throw new SlicedFileError(
          "corrupt",
          "El archivo está dañado: no se pudo leer slice_info.config.",
          err,
        );
      }
      warnings.push(
        "No se pudo interpretar slice_info.config; faltarán tiempo, gramos y filamento.",
      );
    }
  } else {
    warnings.push("El archivo no trae slice_info.config; faltarán tiempo, gramos y filamento.");
  }

  const plates: SlicedPlate[] = [];
  for (const { index, entry } of gcodeEntries) {
    const info = sliceInfo?.plates.find((p) => p.index === index);
    let header: GcodeHeader = {};
    try {
      const head = await zip.read(entry.name, GCODE_HEAD_BYTES, true);
      header = parseGcodeHeader(head.toString("utf8"));
    } catch (err) {
      throw new SlicedFileError(
        "corrupt",
        `El archivo está dañado: no se pudo leer ${entry.name}.`,
        err,
      );
    }
    const thumbnailPath = `Metadata/plate_${index}.png`;
    plates.push({
      index,
      gcodePath: entry.name,
      gcodeBytes: entry.uncompressedSize,
      thumbnailPath: zip.has(thumbnailPath) ? thumbnailPath : undefined,
      predictionSeconds: info?.predictionSeconds,
      weightGrams: info?.weightGrams ?? header.totalWeightGrams,
      printerModelId: info?.printerModelId ?? sliceInfo?.printerModelId,
      nozzleDiameter: info?.nozzleDiameter,
      bedType: info?.bedType,
      totalLayers: header.totalLayers,
      filaments: info?.filaments ?? [],
      objectNames: info?.objectNames ?? [],
    });
  }

  return { plates, slicerVersion: sliceInfo?.slicerVersion, warnings };
}

/** Lee una entrada (p. ej. la miniatura) del archivo. */
export async function readSlicedFileEntry(
  path: string,
  entryName: string,
  maxBytes = 8 * 1024 * 1024,
): Promise<Buffer> {
  const zip = await ZipReader.open(path);
  try {
    return await zip.read(entryName, maxBytes);
  } finally {
    zip.close();
  }
}

// ---------------------------------------------------------------------------
// slice_info.config

interface ParsedSlicePlate {
  index: number;
  predictionSeconds?: number;
  weightGrams?: number;
  printerModelId?: string;
  nozzleDiameter?: number;
  bedType?: string;
  filaments: SlicedFilament[];
  objectNames: string[];
}

export interface ParsedSliceInfo {
  slicerVersion?: string;
  printerModelId?: string;
  plates: ParsedSlicePlate[];
}

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  isArray: (name) =>
    ["plate", "metadata", "filament", "object", "header_item", "warning"].includes(name),
});

type XmlNode = Record<string, unknown>;

function asArray(value: unknown): XmlNode[] {
  if (Array.isArray(value)) return value as XmlNode[];
  if (value && typeof value === "object") return [value as XmlNode];
  return [];
}

function str(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const s = String(value).trim();
  return s === "" ? undefined : s;
}

function num(value: unknown): number | undefined {
  const s = str(value);
  if (s === undefined) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

export function normalizeColor(raw: string | undefined): string {
  if (!raw) return "#000000";
  let hex = raw.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{8}$/.test(hex)) hex = hex.slice(0, 6); // RRGGBBAA → RRGGBB
  if (/^[0-9a-fA-F]{3}$/.test(hex))
    hex = hex
      .split("")
      .map((c) => c + c)
      .join("");
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return "#000000";
  return `#${hex.toUpperCase()}`;
}

export function parseSliceInfo(xml: string): ParsedSliceInfo {
  const doc = xmlParser.parse(xml) as XmlNode;
  const config = (doc.config ?? {}) as XmlNode;
  const header = (config.header ?? {}) as XmlNode;
  const headerItems = asArray(header.header_item);
  const slicerVersion = str(headerItems.find((h) => h.key === "X-BBL-Client-Version")?.value);

  const plates: ParsedSlicePlate[] = [];
  let fileModel: string | undefined;
  for (const plate of asArray(config.plate)) {
    const meta = new Map<string, string>();
    for (const m of asArray(plate.metadata)) {
      const key = str(m.key);
      const value = str(m.value);
      if (key && value !== undefined) meta.set(key, value);
    }
    const index = num(meta.get("index"));
    if (index === undefined) continue;
    const filaments: SlicedFilament[] = asArray(plate.filament)
      .map((f) => ({
        id: num(f.id) ?? 0,
        type: str(f.type) ?? "Desconocido",
        color: normalizeColor(str(f.color)),
        usedGrams: num(f.used_g) ?? 0,
        usedMeters: num(f.used_m) ?? 0,
        trayInfoIdx: str(f.tray_info_idx),
      }))
      .filter((f) => f.usedGrams > 0 && f.id > 0);
    const printerModelId = meta.get("printer_model_id");
    fileModel ??= printerModelId;
    const nozzle = meta.get("nozzle_diameters")?.split(",")[0];
    plates.push({
      index,
      predictionSeconds: num(meta.get("prediction")),
      weightGrams: num(meta.get("weight")),
      printerModelId,
      nozzleDiameter: num(nozzle),
      bedType: meta.get("curr_bed_type"),
      filaments,
      objectNames: asArray(plate.object)
        .filter((o) => str(o.skipped)?.toLowerCase() !== "true")
        .map((o) => str(o.name))
        .filter((n): n is string => !!n),
    });
  }
  return { slicerVersion, printerModelId: fileModel, plates };
}

// ---------------------------------------------------------------------------
// Cabecera del G-code (comentarios que escribe Bambu Studio)

export interface GcodeHeader {
  totalLayers?: number;
  totalWeightGrams?: number;
}

export function parseGcodeHeader(text: string): GcodeHeader {
  const header: GcodeHeader = {};
  const layers = /^;\s*total layer number:\s*(\d+)/im.exec(text);
  if (layers) header.totalLayers = Number(layers[1]);
  const weight = /^;\s*total filament weight \[g\]\s*:\s*([\d.,]+)/im.exec(text);
  if (weight) {
    const grams = weight[1]!.split(",").reduce((sum, v) => sum + (Number(v) || 0), 0);
    if (grams > 0) header.totalWeightGrams = grams;
  }
  return header;
}
