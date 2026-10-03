// Comandos sencillos: estado, info, subir, pausar/reanudar/cancelar, archivos, limpiar.
import { randomBytes } from "node:crypto";
import { basename, resolve } from "node:path";
import {
  ACTIVE_GCODE_STATES,
  deleteRemoteFile,
  listRemoteFiles,
  pauseCommand,
  REMOTE_FILE_PREFIX,
  resumeCommand,
  stopCommand,
  uploadFile,
  type FtpsMode,
} from "@blackforge/printer";
import { printerModelName, readSlicedFile, suggestQuantityFromFilename } from "@blackforge/threemf";
import { resolveEndpoint } from "../env.js";
import {
  bytes,
  c,
  dec,
  duration,
  endInline,
  info,
  inline,
  ok,
  progressBar,
  speed,
  timestamp,
  title,
  warn,
} from "../format.js";
import { confirm, connectPrinter, printSnapshot, STATE_NAMES } from "../printer-helpers.js";
import { Recorder } from "../recorder.js";

export async function statusCommand(opts: { follow: boolean; record: boolean }): Promise<number> {
  const { endpoint } = await resolveEndpoint();
  const recorder = opts.record
    ? new Recorder(resolve("capturas", `estado_${timestamp()}.jsonl`))
    : undefined;
  info(`Conectando con ${endpoint.host} (${endpoint.serial})…`);
  const conn = await connectPrinter(endpoint, recorder);
  try {
    const version = await conn.getVersion().catch(() => undefined);
    title(
      `Impresora ${endpoint.serial}${version ? ` · ${printerModelName(version.projectName)} · firmware ${version.firmware}` : ""}`,
    );
    printSnapshot(conn.snapshot);
    if (opts.follow) {
      title("Siguiendo cambios (Ctrl+C para salir)");
      conn.on("snapshot", (s) => {
        inline(
          `  ${STATE_NAMES[s.gcodeState]} · ${s.percent ?? 0} % · capa ${s.layer ?? 0}/${s.totalLayers ?? "?"} · boquilla ${s.nozzleTemp ?? "?"} °C · cama ${s.bedTemp ?? "?"} °C · ${s.wifiSignal ?? ""}`,
        );
      });
      await new Promise<void>((r) => process.once("SIGINT", () => r()));
      endInline();
    }
  } finally {
    await conn.stop();
    await recorder?.close();
  }
  return 0;
}

export async function infoCommand(file: string): Promise<number> {
  const path = resolve(file);
  const data = await readSlicedFile(path);
  title(basename(path));
  if (data.slicerVersion) info(`Bambu Studio ${data.slicerVersion}`);
  const q = suggestQuantityFromFilename(path);
  if (q) info(`Cantidad sugerida por el nombre: ${q}`);
  for (const w of data.warnings) warn(w);
  for (const p of data.plates) {
    console.log(`\n  ${c.bold(`Placa ${p.index}`)}  (${p.gcodePath}, ${bytes(p.gcodeBytes)})`);
    console.log(
      `    Modelo:     ${printerModelName(p.printerModelId) ?? "?"} (${p.printerModelId ?? "?"}) · boquilla ${p.nozzleDiameter ?? "?"} mm`,
    );
    console.log(
      `    Tiempo:     ${duration(p.predictionSeconds)} · ${dec(p.weightGrams)} g · ${p.totalLayers ?? "?"} capas`,
    );
    console.log(
      `    Filamento:  ${p.filaments.map((f) => `#${f.id} ${f.type} ${f.color} (${f.usedGrams} g)`).join(", ") || "sin datos"}`,
    );
    if (p.objectNames.length) console.log(`    Objetos:    ${p.objectNames.join(", ")}`);
    console.log(`    Miniatura:  ${p.thumbnailPath ?? "no tiene"}`);
  }
  return 0;
}

export async function uploadCommand(opts: {
  file?: string;
  mode: FtpsMode;
  keep: boolean;
}): Promise<number> {
  const { endpoint } = await resolveEndpoint();
  let path = opts.file ? resolve(opts.file) : undefined;
  if (!path) {
    const { writeFile, mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(resolve(tmpdir(), "bf-"));
    path = resolve(dir, "prueba.bin");
    await writeFile(path, randomBytes(1024 * 1024));
    info("Sin archivo: se sube 1 MB de prueba.");
  }
  const remote = `${REMOTE_FILE_PREFIX}prueba_${Date.now().toString(36)}${opts.file ? ".3mf" : ".bin"}`;
  info(`Subiendo a ${endpoint.host} en modo ${opts.mode}…`);
  const r = await uploadFile(endpoint, path, remote, {
    mode: opts.mode,
    onProgress: (sent, total) =>
      inline(`  ${progressBar(sent / total)} ${bytes(sent)} de ${bytes(total)}`),
  });
  endInline();
  ok(
    `${bytes(r.bytes)} en ${dec(r.durationMs / 1000)} s (${speed(r.bytesPerSecond)}) · 226 ${r.transferConfirmed ? "sí" : "no (verificado por tamaño)"}${r.sessionReused !== undefined ? ` · sesión TLS reutilizada: ${r.sessionReused ? "sí" : "no"}` : ""}`,
  );
  if (!opts.keep) {
    await deleteRemoteFile(endpoint, remote, { mode: opts.mode });
    ok(`Borrado de la microSD (${remote}).`);
  } else {
    info(`Se dejó en la microSD como ${remote}. Bórralo con: npm run cli -- limpiar`);
  }
  return 0;
}

export async function controlCommand(
  action: "pausar" | "reanudar" | "cancelar",
  opts: { yes: boolean },
): Promise<number> {
  const { endpoint } = await resolveEndpoint();
  const conn = await connectPrinter(endpoint);
  try {
    const s = conn.snapshot;
    info(
      `Estado actual: ${STATE_NAMES[s.gcodeState]}${s.subtaskName ? ` · ${s.subtaskName}` : ""}`,
    );
    if (action === "pausar" && !["RUNNING", "PREPARE"].includes(s.gcodeState)) {
      warn("No hay una impresión en curso para pausar.");
      return 1;
    }
    if (action === "reanudar" && s.gcodeState !== "PAUSE") {
      warn("La impresora no está en pausa.");
      return 1;
    }
    if (action === "cancelar") {
      if (!ACTIVE_GCODE_STATES.has(s.gcodeState)) {
        warn("No hay una impresión en curso para cancelar.");
        return 1;
      }
      if (
        !opts.yes &&
        !(await confirm("Cancelar no se puede deshacer. Escribe «si» para cancelar la impresión:"))
      ) {
        info("No se canceló nada.");
        return 0;
      }
    }
    const command =
      action === "pausar"
        ? pauseCommand()
        : action === "reanudar"
          ? resumeCommand()
          : stopCommand();
    await conn.request(command, { timeoutMs: 15_000 });
    const target =
      action === "pausar"
        ? ["PAUSE"]
        : action === "reanudar"
          ? ["RUNNING", "PREPARE"]
          : ["FAILED", "IDLE", "FINISH"];
    const after = await conn.waitForSnapshot((x) => target.includes(x.gcodeState), 30_000);
    ok(`Hecho: ${STATE_NAMES[after.gcodeState]}`);
    return 0;
  } finally {
    await conn.stop();
  }
}

export async function filesCommand(opts: { mode: FtpsMode }): Promise<number> {
  const { endpoint } = await resolveEndpoint();
  const files = await listRemoteFiles(endpoint, "/", { mode: opts.mode });
  title(`Raíz de la microSD (${files.length})`);
  for (const f of files)
    console.log(
      `  ${f.isDirectory ? c.blue(`${f.name}/`) : f.name}${f.size !== undefined && !f.isDirectory ? c.dim(`  ${bytes(f.size)}`) : ""}${f.name.startsWith(REMOTE_FILE_PREFIX) ? c.yellow("  ← subido por esta app") : ""}`,
    );
  return 0;
}

export async function cleanCommand(opts: { mode: FtpsMode; yes: boolean }): Promise<number> {
  const { endpoint } = await resolveEndpoint();
  const conn = await connectPrinter(endpoint);
  try {
    const s = conn.snapshot;
    const files = (await listRemoteFiles(endpoint, "/", { mode: opts.mode })).filter(
      (f) => !f.isDirectory && f.name.startsWith(REMOTE_FILE_PREFIX),
    );
    // Nunca borrar el archivo que se está imprimiendo.
    const inUse = ACTIVE_GCODE_STATES.has(s.gcodeState) ? s.gcodeFile : undefined;
    const targets = files.filter((f) => f.name !== inUse);
    if (inUse && files.some((f) => f.name === inUse))
      info(`Se conserva ${inUse}: se está imprimiendo.`);
    if (targets.length === 0) {
      ok("No hay archivos de esta app para borrar.");
      return 0;
    }
    for (const f of targets) info(`${f.name} ${c.dim(bytes(f.size))}`);
    if (!opts.yes && !(await confirm(`¿Borrar estos ${targets.length} archivos? Escribe «si»:`)))
      return 0;
    for (const f of targets) {
      await deleteRemoteFile(endpoint, f.name, { mode: opts.mode });
      ok(`Borrado ${f.name}`);
    }
    return 0;
  } finally {
    await conn.stop();
  }
}
