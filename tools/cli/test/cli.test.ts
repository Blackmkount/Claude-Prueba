// El CLI de prueba contra el simulador (como lo usará el dueño con su A1).
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { Fleet } from "@blackforge/simulator";
import { startTestFleet } from "@blackforge/simulator/testing";
import { buildSlicedFile } from "@blackforge/threemf/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const run = promisify(execFile);
const root = resolve(import.meta.dirname, "../../..");
const tsx = join(root, "node_modules/.bin/tsx");
const main = join(root, "tools/cli/src/main.ts");

let fleet: Fleet;
let dir: string;
let file: string;
let env: NodeJS.ProcessEnv;

async function cli(...args: string[]): Promise<{ code: number; out: string }> {
  try {
    const { stdout, stderr } = await run(tsx, [main, ...args], { cwd: dir, env, timeout: 60_000 });
    return { code: 0, out: stdout + stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof e.code === "number" ? e.code : 1,
      out: (e.stdout ?? "") + (e.stderr ?? ""),
    };
  }
}

beforeAll(async () => {
  fleet = await startTestFleet({ count: 1 });
  dir = await mkdtemp(join(tmpdir(), "bf-cli-"));
  file = join(dir, "cubo_x1.gcode.3mf");
  await writeFile(
    file,
    await buildSlicedFile({
      plates: [{ index: 1, filaments: [{ id: 1, type: "PLA", color: "#FFFFFF", usedGrams: 5 }] }],
    }),
  );
  const caPath = join(dir, "ca.pem");
  await writeFile(caPath, fleet.ca.certPem);
  const p = fleet.describe()[0]!;
  // Sin PRINTER_SERIAL: el CLI debe detectarla en el certificado.
  env = {
    ...process.env,
    NO_COLOR: "1",
    PRINTER_IP: p.host,
    PRINTER_ACCESS_CODE: p.accessCode,
    PRINTER_MQTT_PORT: String(p.mqttPort),
    PRINTER_FTPS_PORT: String(p.ftpsPort),
    PRINTER_CA_FILE: caPath,
  };
});

afterAll(async () => {
  await fleet?.close();
  await rm(dir, { recursive: true, force: true });
});

describe("CLI", () => {
  it("ayuda", async () => {
    const r = await cli("ayuda");
    expect(r.code).toBe(0);
    expect(r.out).toContain("diagnostico");
  });

  it("diagnostico completo y reporte sin el código de acceso", async () => {
    const r = await cli(
      "diagnostico",
      "--reposo",
      "1",
      "--archivo",
      file,
      "--salida",
      join(dir, "reporte.md"),
    );
    expect(r.code).toBe(0);
    expect(r.out).toContain("Modos FTPS que funcionan: basic, minimal-p, minimal-c");
    const { readFile } = await import("node:fs/promises");
    const report = await readFile(join(dir, "reporte.md"), "utf8");
    expect(report).toContain(fleet.printers[0]!.serial);
    expect(report).not.toContain(fleet.printers[0]!.config.accessCode);
  }, 60_000);

  it("imprime de principio a fin y limpia la microSD", async () => {
    const r = await cli("imprimir", file, "--si", "--rapido", "--nombre", "Cubo x1");
    expect(r.code).toBe(0);
    expect(r.out).toContain("La impresora arrancó");
    expect(r.out).toContain("Impresión terminada");
    expect(r.out).toContain("borrado de la microSD");
    expect(await fleet.printers[0]!.listFiles()).toEqual([]);
    const sent = fleet.printers[0]!.received.find((c) => c.command === "project_file")!;
    expect(sent.body).toMatchObject({
      subtask_name: "Cubo x1",
      bed_leveling: false,
      auto_bed_leveling: 0,
      vibration_cali: false,
    });
  }, 60_000);

  it("rechaza un 3MF sin laminar", async () => {
    const raw = join(dir, "proyecto.3mf");
    await writeFile(raw, await buildSlicedFile({ sliced: false }));
    const r = await cli("imprimir", raw, "--si");
    expect(r.code).toBe(1);
    expect(r.out).toContain("no está laminado");
  });
});
