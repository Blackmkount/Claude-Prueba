// Módulo de impresora contra el simulador de A1.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Fleet } from "@blackforge/simulator";
import { buildSlicedFile } from "@blackforge/threemf/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  deleteRemoteFile,
  FTPS_MODES,
  isPrinterError,
  listRemoteFiles,
  PrinterConnection,
  probeCertificate,
  startPrint,
  uploadFile,
  type PrinterEndpoint,
} from "../src/index.js";
import { endpointFor, startTestFleet } from "./helpers/sim.js";

let dir: string;
let file: string;
let bigFile: string;
let fleet: Fleet;
const connections: PrinterConnection[] = [];

function connect(endpoint: PrinterEndpoint, options = {}): PrinterConnection {
  const conn = new PrinterConnection(endpoint, {
    backoffMinMs: 100,
    backoffMaxMs: 500,
    pushAllAfterReconnectMinMs: 0,
    ...options,
  });
  connections.push(conn);
  conn.start();
  return conn;
}

async function connected(endpoint: PrinterEndpoint, options = {}): Promise<PrinterConnection> {
  const conn = connect(endpoint, options);
  await conn.waitForOnline(5_000);
  await conn.waitForSnapshot(() => conn.stateValid, 5_000);
  return conn;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "bf-int-"));
  file = join(dir, "oso_x2.gcode.3mf");
  await writeFile(
    file,
    await buildSlicedFile({
      plates: [
        {
          index: 1,
          totalLayers: 40,
          predictionSeconds: 600,
          filaments: [{ id: 1, type: "PLA", color: "#FFFFFF", usedGrams: 10 }],
        },
      ],
    }),
  );
  bigFile = join(dir, "grande.gcode.3mf");
  await writeFile(
    bigFile,
    await buildSlicedFile({ plates: [{ index: 1 }], extraRandomBytes: 2 * 1024 * 1024 }),
  );
  fleet = await startTestFleet({ count: 3 });
});

afterEach(async () => {
  await Promise.all(connections.splice(0).map((c) => c.stop()));
  for (const p of fleet.printers) {
    p.setQuirks({
      noTransferComplete: false,
      protPHangs: false,
      requireSessionReuse: false,
      slowKBps: undefined,
      acceptedUrlStyles: undefined,
    });
    p.setDevMode(true);
    p.setSdCard(true);
    p.resetToIdle();
    p.received.length = 0;
  }
});

afterAll(async () => {
  await fleet?.close();
  await rm(dir, { recursive: true, force: true });
});

describe("TLS", () => {
  it("lee la serie del certificado y verifica la cadena", async () => {
    const ep = endpointFor(fleet, 0);
    const probe = await probeCertificate(ep.host, ep.mqttPort!, { settings: ep.tls });
    expect(probe.serial).toBe(ep.serial);
    expect(probe.trusted).toBe(true);
    expect(probe.protocol).toBe("TLSv1.2");
  });

  it("no confía en un certificado firmado por otra CA (la de Bambu)", async () => {
    const ep = endpointFor(fleet, 0);
    const probe = await probeCertificate(ep.host, ep.mqttPort!, { settings: { verify: true } });
    expect(probe.trusted).toBe(false);
  });

  it("se niega a conectar si la IP apunta a otra impresora (serie distinta)", async () => {
    const ep = { ...endpointFor(fleet, 0), serial: fleet.printers[1]!.serial };
    const conn = connect(ep);
    const err = await conn.waitForOnline(5_000).catch((e: unknown) => e);
    expect(isPrinterError(err, "tls_serial_mismatch")).toBe(true);
  });

  it("código de acceso incorrecto → auth_failed", async () => {
    const conn = connect({ ...endpointFor(fleet, 0), accessCode: "equivocado" });
    const err = await conn.waitForOnline(5_000).catch((e: unknown) => e);
    expect(isPrinterError(err, "auth_failed")).toBe(true);
  });
});

describe("MQTT y estado", () => {
  it("conecta, recibe el estado completo y la versión", async () => {
    const conn = await connected(endpointFor(fleet, 0));
    expect(conn.snapshot.gcodeState).toBe("IDLE");
    expect(conn.snapshot.hasAms).toBe(true);
    expect(conn.snapshot.sdCard).toBe("present");
    expect(conn.snapshot.signatureRequired).toBe(false);
    const version = await conn.getVersion();
    expect(version.projectName).toBe("N2S");
    expect(version.firmware).toBe("01.08.01.00");
  });

  it("impresora sin AMS reporta la bobina externa", async () => {
    const conn = await connected(endpointFor(fleet, 1));
    expect(conn.snapshot.hasAms).toBe(false);
    expect(conn.snapshot.externalSpool?.loaded).toBe(true);
  });

  it("se reconecta sola tras un corte y recupera el estado", async () => {
    const conn = await connected(endpointFor(fleet, 0));
    const statuses: string[] = [];
    conn.on("status", (s) => statuses.push(s.kind));
    fleet.printers[0]!.disconnect(600);
    await conn.waitForSnapshot(() => false, 300).catch(() => {});
    expect(conn.online).toBe(false);
    await conn.waitForOnline(10_000);
    await conn.waitForSnapshot(() => conn.stateValid, 5_000);
    expect(statuses).toContain("offline");
    expect(conn.snapshot.gcodeState).toBe("IDLE");
  });

  it("detecta una conexión zombi y reconecta", async () => {
    const conn = await connected(endpointFor(fleet, 0), { silenceMs: 300, probeTimeoutMs: 300 });
    const statuses: string[] = [];
    conn.on("status", (s) => statuses.push(s.kind));
    fleet.printers[0]!.zombie(1_000);
    await new Promise((r) => setTimeout(r, 2_000));
    expect(statuses).toContain("connecting");
    await conn.waitForOnline(5_000);
  });

  it("una impresora apagada no afecta a las demás", async () => {
    const a = await connected(endpointFor(fleet, 0));
    const b = await connected(endpointFor(fleet, 2));
    fleet.printers[0]!.disconnect(2_000);
    await new Promise((r) => setTimeout(r, 300));
    expect(a.online).toBe(false);
    expect(b.online).toBe(true);
    await b.getVersion();
  });

  it("respeta el intervalo mínimo de pushall", async () => {
    const conn = await connected(endpointFor(fleet, 0));
    expect(await conn.requestPushAll()).toBe(false); // ya se pidió al conectar
    const pushalls = fleet.printers[0]!.received.filter((c) => c.command === "pushall");
    expect(pushalls.length).toBeGreaterThanOrEqual(1);
  });
});

describe("FTPS", () => {
  it.each(FTPS_MODES)("modo %s: sube, verifica tamaño, lista y borra", async (mode) => {
    const ep = endpointFor(fleet, 0);
    const name = `bf_test_${mode}.3mf`;
    const progress: number[] = [];
    const result = await uploadFile(ep, file, name, {
      mode,
      onProgress: (sent) => progress.push(sent),
    });
    expect(result.transferConfirmed).toBe(true);
    expect(result.verifiedSize).toBe(result.bytes);
    expect(progress.length).toBeGreaterThan(0);
    const files = await listRemoteFiles(ep, "/", { mode });
    expect(files.map((f) => f.name)).toContain(name);
    expect(await deleteRemoteFile(ep, name, { mode })).toBe(true);
    expect(await deleteRemoteFile(ep, name, { mode })).toBe(false);
  });

  it("la reutilización de sesión TLS funciona (como exige vsFTPd)", async () => {
    fleet.printers[0]!.setQuirks({ requireSessionReuse: true });
    const ep = endpointFor(fleet, 0);
    const r = await uploadFile(ep, file, "bf_reuse.3mf", { mode: "minimal-p" });
    expect(r.sessionReused).toBe(true);
    await uploadFile(ep, file, "bf_reuse2.3mf", { mode: "basic" });
  });

  it("si no llega el 226, verifica con SIZE y da la subida por buena", async () => {
    fleet.printers[0]!.setQuirks({ noTransferComplete: true });
    const ep = endpointFor(fleet, 0);
    const r = await uploadFile(ep, bigFile, "bf_sin226.3mf", {
      mode: "minimal-p",
      confirmTimeoutMs: 500,
    });
    expect(r.transferConfirmed).toBe(false);
    expect(r.verifiedSize).toBe(r.bytes);
    const rb = await uploadFile(ep, file, "bf_sin226b.3mf", { mode: "basic", timeoutMs: 1_500 });
    expect(rb.transferConfirmed).toBe(false);
    expect(rb.verifiedSize).toBe(rb.bytes);
  });

  it("si el canal de datos con TLS se cuelga, PROT C funciona", async () => {
    fleet.printers[0]!.setQuirks({ protPHangs: true });
    const ep = endpointFor(fleet, 0);
    const err = await uploadFile(ep, file, "bf_cuelga.3mf", {
      mode: "minimal-p",
      timeoutMs: 800,
    }).catch((e: unknown) => e);
    expect(isPrinterError(err)).toBe(true);
    const ok = await uploadFile(ep, file, "bf_protc.3mf", { mode: "minimal-c" });
    expect(ok.verifiedSize).toBe(ok.bytes);
  });

  it("sin microSD → no_sdcard", async () => {
    fleet.printers[0]!.setSdCard(false);
    const err = await uploadFile(endpointFor(fleet, 0), file, "bf_x.3mf", {
      mode: "minimal-p",
    }).catch((e: unknown) => e);
    expect(isPrinterError(err, "no_sdcard")).toBe(true);
  });
});

describe("startPrint", () => {
  it("imprime de principio a fin, confirma con nuestro ID y deja la microSD lista para limpiar", async () => {
    const conn = await connected(endpointFor(fleet, 0));
    const steps: string[] = [];
    const result = await startPrint({
      connection: conn,
      localPath: file,
      plateIndex: 1,
      jobId: "job1",
      displayName: "Oso x2",
      filament: [0],
      onStep: (s) => steps.push(s),
      ftps: { mode: "minimal-p" },
    });
    expect(steps).toEqual([
      "checking",
      "uploading",
      "verifying",
      "starting",
      "waiting_start",
      "started",
    ]);
    expect(result.confirmedBy).toBe("task_id");
    expect(result.remoteName).toBe("bf_job1.3mf");
    const sent = fleet.printers[0]!.received.find((c) => c.command === "project_file")!;
    expect(sent.body).toMatchObject({
      param: "Metadata/plate_1.gcode",
      url: "ftp://bf_job1.3mf",
      use_ams: true,
      ams_mapping: [0],
      subtask_name: "Oso x2",
      task_id: result.taskId,
    });
    const done = await conn.waitForSnapshot((s) => s.gcodeState === "FINISH", 10_000);
    expect(done.percent).toBe(100);
    expect(done.subtaskName).toBe("Oso x2");
    expect(await deleteRemoteFile(conn.endpoint, result.remoteName, { mode: "minimal-p" })).toBe(
      true,
    );
  });

  it("reconoce el inicio aunque la impresora no repita nuestro ID", async () => {
    fleet.printers[0]!.setQuirks({ echoTaskId: false });
    try {
      const conn = await connected(endpointFor(fleet, 0));
      const r = await startPrint({
        connection: conn,
        localPath: file,
        plateIndex: 1,
        jobId: "job2",
        displayName: "X",
        filament: [0],
      });
      expect(r.confirmedBy).toBe("state_transition");
    } finally {
      fleet.printers[0]!.setQuirks({ echoTaskId: true });
    }
  });

  it("nunca envía a una impresora ocupada (y no sube nada)", async () => {
    const conn = await connected(endpointFor(fleet, 0));
    await fleet.printers[0]!.startExternalPrint(5_000);
    await conn.waitForSnapshot((s) => s.gcodeState === "RUNNING", 3_000);
    const err = await startPrint({
      connection: conn,
      localPath: file,
      plateIndex: 1,
      jobId: "job3",
      displayName: "X",
      filament: [0],
    }).catch((e: unknown) => e);
    expect(isPrinterError(err, "busy")).toBe(true);
    expect(fleet.printers[0]!.received.some((c) => c.command === "project_file")).toBe(false);
    expect((await fleet.printers[0]!.listFiles()).map((f) => f.name)).not.toContain("bf_job3.3mf");
  });

  it("si alguien empieza a imprimir durante la subida, aborta y borra el archivo", async () => {
    const printer = fleet.printers[0]!;
    printer.setQuirks({ slowKBps: 400 });
    const conn = await connected(endpointFor(fleet, 0));
    const promise = startPrint({
      connection: conn,
      localPath: bigFile,
      plateIndex: 1,
      jobId: "job4",
      displayName: "X",
      filament: [0],
      ftps: { mode: "minimal-p" },
      onStep: (s) => {
        if (s === "uploading") setTimeout(() => void printer.startExternalPrint(10_000), 200);
      },
    });
    const err = await promise.catch((e: unknown) => e);
    expect(isPrinterError(err, "busy")).toBe(true);
    expect(printer.received.some((c) => c.command === "project_file")).toBe(false);
    expect((await printer.listFiles()).map((f) => f.name)).not.toContain("bf_job4.3mf");
  });

  it("Modo desarrollador apagado: lo detecta antes de subir", async () => {
    fleet.printers[0]!.setDevMode(false);
    const conn = await connected(endpointFor(fleet, 0));
    await conn.waitForSnapshot((s) => s.signatureRequired === true, 3_000);
    const err = await startPrint({
      connection: conn,
      localPath: file,
      plateIndex: 1,
      jobId: "job5",
      displayName: "X",
      filament: [0],
    }).catch((e: unknown) => e);
    expect(isPrinterError(err, "developer_mode_required")).toBe(true);
  });

  it("URL no aceptada por la impresora → falla clara y limpia la microSD", async () => {
    fleet.printers[0]!.setQuirks({ acceptedUrlStyles: ["sdcard"] });
    const conn = await connected(endpointFor(fleet, 0));
    const err = await startPrint({
      connection: conn,
      localPath: file,
      plateIndex: 1,
      jobId: "job6",
      displayName: "X",
      filament: [0],
      urlStyle: "ftp",
    }).catch((e: unknown) => e);
    expect(isPrinterError(err, "command_rejected")).toBe(true);
    expect((await fleet.printers[0]!.listFiles()).map((f) => f.name)).not.toContain("bf_job6.3mf");
    fleet.printers[0]!.resetToIdle();
    await conn.waitForSnapshot((s) => s.gcodeState === "IDLE", 3_000);
    const ok = await startPrint({
      connection: conn,
      localPath: file,
      plateIndex: 1,
      jobId: "job7",
      displayName: "X",
      filament: [0],
      urlStyle: "sdcard",
    });
    expect(ok.confirmedBy).toBe("task_id");
  });

  it("pausa, reanuda y cancela; la cancelación se distingue de una falla", async () => {
    const conn = await connected(endpointFor(fleet, 0));
    fleet.printers[0]!.setQuirks({});
    await startPrint({
      connection: conn,
      localPath: file,
      plateIndex: 1,
      jobId: "job8",
      displayName: "X",
      filament: [0],
    });
    await conn.waitForSnapshot((s) => s.gcodeState === "RUNNING", 5_000);
    await conn.request({ print: { command: "pause", param: "" } });
    await conn.waitForSnapshot((s) => s.gcodeState === "PAUSE", 3_000);
    await conn.request({ print: { command: "resume", param: "" } });
    await conn.waitForSnapshot((s) => s.gcodeState === "RUNNING", 3_000);
    await conn.request({ print: { command: "stop", param: "" } });
    const s = await conn.waitForSnapshot((x) => x.gcodeState === "FAILED", 3_000);
    expect(s.printError).toBe(0x0300400c);
  });
});
