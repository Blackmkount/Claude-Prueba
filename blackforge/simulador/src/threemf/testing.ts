// Constructor de archivos .gcode.3mf de prueba (solo para pruebas y simulador).
// Imita la estructura que exporta Bambu Studio, con contenido inventado.
import { randomBytes } from "node:crypto";
import yazl from "yazl";

export interface FixtureFilament {
  id: number;
  type: string;
  color: string;
  usedGrams: number;
  usedMeters?: number;
  trayInfoIdx?: string;
}

export interface FixturePlate {
  index: number;
  predictionSeconds?: number;
  weightGrams?: number;
  totalLayers?: number;
  filaments?: FixtureFilament[];
  objectNames?: string[];
  /** Tamaño aproximado del G-code en bytes (relleno), para probar subidas. */
  gcodeBytes?: number;
  withThumbnail?: boolean;
}

export interface FixtureOptions {
  plates?: FixturePlate[];
  printerModelId?: string;
  nozzleDiameter?: number;
  includeSliceInfo?: boolean;
  /** Si es false, genera un 3MF de proyecto sin laminar (sin G-code). */
  sliced?: boolean;
  slicerVersion?: string;
  /** Bytes aleatorios (incompresibles) extra, para probar subidas lentas o grandes. */
  extraRandomBytes?: number;
}

/** PNG transparente de 1×1 px. */
export const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function sliceInfoXml(
  opts: Required<Pick<FixtureOptions, "printerModelId" | "nozzleDiameter" | "slicerVersion">>,
  plates: FixturePlate[],
): string {
  const platesXml = plates
    .map((p) => {
      const filaments = (
        p.filaments ?? [{ id: 1, type: "PLA", color: "#FFFFFF", usedGrams: p.weightGrams ?? 10 }]
      )
        .map(
          (f) =>
            `    <filament id="${f.id}" tray_info_idx="${f.trayInfoIdx ?? "GFA00"}" type="${escapeXml(f.type)}" color="${f.color}" used_m="${(f.usedMeters ?? f.usedGrams / 3).toFixed(2)}" used_g="${f.usedGrams.toFixed(2)}" />`,
        )
        .join("\n");
      const objects = (p.objectNames ?? ["pieza.stl"])
        .map(
          (name, i) =>
            `    <object identify_id="${100 + i}" name="${escapeXml(name)}" skipped="false" />`,
        )
        .join("\n");
      return `  <plate>
    <metadata key="index" value="${p.index}"/>
    <metadata key="printer_model_id" value="${opts.printerModelId}"/>
    <metadata key="nozzle_diameters" value="${opts.nozzleDiameter}"/>
    <metadata key="timelapse_type" value="0"/>
    <metadata key="prediction" value="${p.predictionSeconds ?? 1800}"/>
    <metadata key="weight" value="${(p.weightGrams ?? 10).toFixed(2)}"/>
    <metadata key="outside" value="false"/>
    <metadata key="support_used" value="false"/>
    <metadata key="label_object_enabled" value="true"/>
    <metadata key="curr_bed_type" value="Textured PEI Plate"/>
${objects}
${filaments}
  </plate>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <header>
    <header_item key="X-BBL-Client-Type" value="slicer"/>
    <header_item key="X-BBL-Client-Version" value="${opts.slicerVersion}"/>
  </header>
${platesXml}
</config>
`;
}

function gcodeFor(plate: FixturePlate, modelName: string): string {
  const layers = plate.totalLayers ?? 100;
  const header = `; HEADER_BLOCK_START
; BambuStudio 02.02.00.85
; model printing time: 30m 0s; total estimated time: 32m 0s
; total layer number: ${layers}
; total filament weight [g] : ${(plate.weightGrams ?? 10).toFixed(2)}
; printer_model = Bambu Lab ${modelName}
; HEADER_BLOCK_END
G28
`;
  const target = plate.gcodeBytes ?? 2048;
  if (header.length >= target) return header;
  const line = "G1 X10 Y10 E0.1 ; relleno de prueba\n";
  return header + line.repeat(Math.ceil((target - header.length) / line.length));
}

/** Genera un archivo .gcode.3mf en memoria. */
export function buildSlicedFile(options: FixtureOptions = {}): Promise<Buffer> {
  const plates = options.plates ?? [{ index: 1 }];
  const printerModelId = options.printerModelId ?? "N2S";
  const modelName =
    printerModelId === "N2S" ? "A1" : printerModelId === "N1" ? "A1 mini" : printerModelId;
  const zip = new yazl.ZipFile();
  zip.addBuffer(
    Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="gcode" ContentType="text/x.gcode"/></Types>\n`,
    ),
    "[Content_Types].xml",
  );
  zip.addBuffer(
    Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources/><build/></model>\n`,
    ),
    "3D/3dmodel.model",
  );
  if (options.sliced !== false) {
    for (const plate of plates) {
      zip.addBuffer(Buffer.from(gcodeFor(plate, modelName)), `Metadata/plate_${plate.index}.gcode`);
      zip.addBuffer(
        Buffer.from("d41d8cd98f00b204e9800998ecf8427e"),
        `Metadata/plate_${plate.index}.gcode.md5`,
      );
      if (plate.withThumbnail !== false)
        zip.addBuffer(TINY_PNG, `Metadata/plate_${plate.index}.png`);
    }
    if (options.includeSliceInfo !== false) {
      zip.addBuffer(
        Buffer.from(
          sliceInfoXml(
            {
              printerModelId,
              nozzleDiameter: options.nozzleDiameter ?? 0.4,
              slicerVersion: options.slicerVersion ?? "02.02.00.85",
            },
            plates,
          ),
        ),
        "Metadata/slice_info.config",
      );
    }
  }
  if (options.extraRandomBytes && options.extraRandomBytes > 0) {
    zip.addBuffer(randomBytes(options.extraRandomBytes), "Metadata/relleno.bin", {
      compress: false,
    });
  }
  zip.end();
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    zip.outputStream.on("data", (c: Buffer) => chunks.push(c));
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on("error", reject);
  });
}
