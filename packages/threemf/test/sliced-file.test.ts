import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  normalizeColor,
  parseGcodeHeader,
  printerModelName,
  readSlicedFile,
  readSlicedFileEntry,
  SlicedFileError,
} from "../src/index.js";
import { buildSlicedFile, TINY_PNG } from "../src/testing.js";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "bf-3mf-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function fixture(name: string, data: Buffer | string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, data);
  return path;
}

describe("readSlicedFile", () => {
  it("lee un archivo laminado para A1 con su metadato", async () => {
    const path = await fixture(
      "oso_x2.gcode.3mf",
      await buildSlicedFile({
        plates: [
          {
            index: 1,
            predictionSeconds: 8040,
            weightGrams: 38.2,
            totalLayers: 180,
            filaments: [{ id: 1, type: "PLA", color: "#9a6a42", usedGrams: 38.2 }],
            objectNames: ["oso.stl", "oso.stl"],
          },
        ],
      }),
    );
    const info = await readSlicedFile(path);
    expect(info.warnings).toEqual([]);
    expect(info.slicerVersion).toBe("02.02.00.85");
    expect(info.plates).toHaveLength(1);
    const plate = info.plates[0]!;
    expect(plate).toMatchObject({
      index: 1,
      gcodePath: "Metadata/plate_1.gcode",
      thumbnailPath: "Metadata/plate_1.png",
      predictionSeconds: 8040,
      weightGrams: 38.2,
      printerModelId: "N2S",
      nozzleDiameter: 0.4,
      totalLayers: 180,
      objectNames: ["oso.stl", "oso.stl"],
    });
    expect(plate.filaments).toEqual([
      {
        id: 1,
        type: "PLA",
        color: "#9A6A42",
        usedGrams: 38.2,
        usedMeters: expect.any(Number),
        trayInfoIdx: "GFA00",
      },
    ]);
    expect(printerModelName(plate.printerModelId)).toBe("A1");
  });

  it("usa el número real de la placa (exportar solo la placa 3)", async () => {
    const path = await fixture(
      "placa3.gcode.3mf",
      await buildSlicedFile({ plates: [{ index: 3 }] }),
    );
    const info = await readSlicedFile(path);
    expect(info.plates.map((p) => p.index)).toEqual([3]);
    expect(info.plates[0]!.gcodePath).toBe("Metadata/plate_3.gcode");
  });

  it("devuelve todas las placas laminadas, ordenadas", async () => {
    const path = await fixture(
      "varias.gcode.3mf",
      await buildSlicedFile({ plates: [{ index: 2 }, { index: 1 }, { index: 4 }] }),
    );
    const info = await readSlicedFile(path);
    expect(info.plates.map((p) => p.index)).toEqual([1, 2, 4]);
  });

  it("ignora filamentos que la placa no usa", async () => {
    const path = await fixture(
      "multi.gcode.3mf",
      await buildSlicedFile({
        plates: [
          {
            index: 1,
            filaments: [
              { id: 1, type: "PLA", color: "#FFFFFF", usedGrams: 0 },
              { id: 3, type: "PETG", color: "#FF0000FF", usedGrams: 12.5 },
            ],
          },
        ],
      }),
    );
    const info = await readSlicedFile(path);
    expect(info.plates[0]!.filaments.map((f) => [f.id, f.type, f.color])).toEqual([
      [3, "PETG", "#FF0000"],
    ]);
  });

  it("detecta un archivo laminado para otro modelo", async () => {
    const path = await fixture("p1s.gcode.3mf", await buildSlicedFile({ printerModelId: "C12" }));
    const info = await readSlicedFile(path);
    expect(info.plates[0]!.printerModelId).toBe("C12");
    expect(printerModelName("C12")).toBe("P1S");
  });

  it("rechaza un 3MF sin laminar con un mensaje claro", async () => {
    const path = await fixture("proyecto.3mf", await buildSlicedFile({ sliced: false }));
    const err = await readSlicedFile(path).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SlicedFileError);
    expect((err as SlicedFileError).code).toBe("not_sliced");
    expect((err as SlicedFileError).message).toMatch(/no está laminado/);
  });

  it("rechaza un archivo que no es ZIP", async () => {
    const path = await fixture("falso.gcode.3mf", "esto no es un zip");
    const err = await readSlicedFile(path).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SlicedFileError);
    expect((err as SlicedFileError).code).toBe("not_zip");
  });

  it("rechaza un ZIP truncado", async () => {
    const full = await buildSlicedFile();
    const path = await fixture("truncado.gcode.3mf", full.subarray(0, Math.floor(full.length / 2)));
    const err = await readSlicedFile(path).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SlicedFileError);
  });

  it("acepta un archivo sin slice_info.config, con advertencia", async () => {
    const path = await fixture(
      "sin-info.gcode.3mf",
      await buildSlicedFile({ includeSliceInfo: false }),
    );
    const info = await readSlicedFile(path);
    expect(info.plates).toHaveLength(1);
    expect(info.plates[0]!.predictionSeconds).toBeUndefined();
    expect(info.plates[0]!.totalLayers).toBe(100);
    expect(info.warnings[0]).toMatch(/slice_info/);
  });

  it("lee la miniatura de la placa", async () => {
    const path = await fixture("mini.gcode.3mf", await buildSlicedFile());
    const png = await readSlicedFileEntry(path, "Metadata/plate_1.png");
    expect(png.equals(TINY_PNG)).toBe(true);
  });

  it("lee la cabecera aunque el G-code sea grande", async () => {
    const path = await fixture(
      "grande.gcode.3mf",
      await buildSlicedFile({
        plates: [{ index: 1, gcodeBytes: 3 * 1024 * 1024, totalLayers: 420 }],
      }),
    );
    const info = await readSlicedFile(path);
    expect(info.plates[0]!.totalLayers).toBe(420);
    expect(info.plates[0]!.gcodeBytes).toBeGreaterThan(3 * 1024 * 1024 - 100);
  });
});

describe("normalizeColor", () => {
  it.each([
    ["#ff5a1f", "#FF5A1F"],
    ["FF5A1FFF", "#FF5A1F"],
    ["#abc", "#AABBCC"],
    ["", "#000000"],
    ["rojo", "#000000"],
    [undefined, "#000000"],
  ])("%s → %s", (input, expected) => {
    expect(normalizeColor(input)).toBe(expected);
  });
});

describe("parseGcodeHeader", () => {
  it("suma el peso de varios filamentos", () => {
    expect(
      parseGcodeHeader("; total filament weight [g] : 1.50,2.25\n; total layer number: 12\n"),
    ).toEqual({
      totalLayers: 12,
      totalWeightGrams: 3.75,
    });
  });
});
