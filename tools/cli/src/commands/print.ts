// `imprimir`: sube un .gcode.3mf e inicia la impresión, con las mismas guardas
// que usará el servidor. Luego sigue el avance y limpia la microSD al terminar.
import { basename, resolve } from "node:path";
import {
  DEFAULT_PRINT_OPTIONS,
  deleteRemoteFile,
  isPrinterError,
  planFilament,
  startPrint,
  wasCancelled,
  type FtpsMode,
  type PrintOptions,
  type PrinterConnection,
  type PrinterSnapshot,
  type TriState,
  type UrlStyle,
} from "@blackforge/printer";
import { printerModelName, readSlicedFile, type SlicedPlate } from "@blackforge/threemf";
import { CliError, resolveEndpoint } from "../env.js";
import {
  bytes,
  c,
  dec,
  duration,
  endInline,
  fail,
  info,
  inline,
  ok,
  progressBar,
  speed,
  timestamp,
  title,
  warn,
} from "../format.js";
import {
  confirm,
  connectPrinter,
  explainError,
  printSnapshot,
  trayLabel,
} from "../printer-helpers.js";
import { Recorder } from "../recorder.js";

export interface PrintCliOptions {
  file: string;
  plate?: number;
  url: UrlStyle;
  mode: FtpsMode;
  tray?: number;
  external: boolean;
  leveling: TriState;
  quick: boolean;
  yes: boolean;
  follow: boolean;
  name?: string;
  force: boolean;
}

function choosePlate(plates: SlicedPlate[], requested?: number): SlicedPlate {
  if (requested !== undefined) {
    const p = plates.find((x) => x.index === requested);
    if (!p)
      throw new CliError(
        `El archivo no tiene la placa ${requested}. Placas laminadas: ${plates.map((x) => x.index).join(", ")}.`,
      );
    return p;
  }
  if (plates.length > 1) {
    throw new CliError(
      `El archivo tiene ${plates.length} placas laminadas (${plates.map((x) => x.index).join(", ")}). Indica cuál con --placa N.`,
    );
  }
  return plates[0]!;
}

export async function printCommand(opts: PrintCliOptions): Promise<number> {
  const path = resolve(opts.file);
  const fileInfo = await readSlicedFile(path);
  const plate = choosePlate(fileInfo.plates, opts.plate);
  const { endpoint } = await resolveEndpoint();
  const recorder = new Recorder(resolve("capturas", `imprimir_${timestamp()}.jsonl`));
  recorder.note("archivo", {
    archivo: basename(path),
    placa: plate.index,
    url: opts.url,
    modo: opts.mode,
  });
  info(`Conectando con ${endpoint.host} (${endpoint.serial})…`);
  const conn = await connectPrinter(endpoint, recorder);
  let code = 0;
  try {
    title("Impresora");
    printSnapshot(conn.snapshot);

    title("Archivo");
    const model = printerModelName(plate.printerModelId);
    info(
      `${basename(path)} · placa ${plate.index} · ${model ?? "modelo desconocido"} · ${duration(plate.predictionSeconds)} · ${dec(plate.weightGrams)} g · ${bytes(plate.gcodeBytes)} de G-code`,
    );
    if (plate.printerModelId && plate.printerModelId !== "N2S") {
      warn(`El archivo fue laminado para ${model}, no para A1.`);
      if (!opts.force) throw new CliError("Usa --forzar si de verdad quieres enviarlo.");
    }
    const nozzle = conn.snapshot.nozzleDiameter;
    if (plate.nozzleDiameter && nozzle && Math.abs(plate.nozzleDiameter - nozzle) > 0.01) {
      warn(
        `El archivo es para boquilla de ${plate.nozzleDiameter} mm y la impresora tiene ${nozzle} mm.`,
      );
      if (!opts.force) throw new CliError("Usa --forzar si de verdad quieres enviarlo.");
    }

    const forced = opts.external ? 254 : opts.tray !== undefined ? opts.tray - 1 : undefined;
    const plan = planFilament(plate.filaments, conn.snapshot, forced);
    title("Filamento");
    if (plan.matches.length === 0)
      info(`El archivo no trae datos de filamento; se usará ${trayLabel(plan.mapping[0])}.`);
    for (const m of plan.matches) {
      const verdict =
        m.typeMatches === true && m.colorMatches === true
          ? c.green("coincide")
          : m.typeMatches === null
            ? c.yellow("no se sabe qué hay cargado")
            : m.typeMatches === false
              ? c.red(`¡tipo distinto! (${m.tray?.type})`)
              : c.yellow(`color distinto (${m.tray?.color})`);
      info(
        `Filamento ${m.filament.id}: ${m.filament.type} ${m.filament.color} → ${trayLabel(m.tray?.globalId)} · ${verdict}`,
      );
    }
    info(`ams_mapping: ${JSON.stringify(plan.mapping)}`);
    if (plan.missing) {
      throw new CliError(
        "No hay filamento cargado que se pueda usar (AMS lite vacío y sin bobina externa). Carga filamento o indica --bandeja N o --externa.",
      );
    }

    const options: PrintOptions = opts.quick
      ? {
          ...DEFAULT_PRINT_OPTIONS,
          bedLeveling: "off",
          flowCalibration: "off",
          vibrationCalibration: false,
        }
      : { ...DEFAULT_PRINT_OPTIONS, bedLeveling: opts.leveling };
    info(
      `Opciones: nivelación ${options.bedLeveling} · calibración de flujo ${options.flowCalibration} · vibración ${options.vibrationCalibration ? "sí" : "no"} · URL «${opts.url}» · FTPS «${opts.mode}»`,
    );

    if (!opts.yes) {
      const sure = await confirm(
        "¿La cama está limpia y vacía, y el filamento correcto está cargado? Escribe «si» para imprimir:",
      );
      if (!sure) {
        info("Cancelado. No se envió nada.");
        return 0;
      }
    }

    title("Envío");
    const displayName = opts.name ?? basename(path).replace(/(\.gcode)?\.3mf$/i, "");
    const jobId = `cli${Date.now().toString(36)}`;
    const stepNames: Record<string, string> = {
      checking: "Comprobando que la impresora esté libre…",
      uploading: "Subiendo archivo…",
      verifying: "Verificando antes de iniciar…",
      starting: "Enviando la orden de imprimir…",
      waiting_start: "Esperando a que la impresora arranque (hasta 90 s)…",
      started: "¡La impresora arrancó!",
    };
    const startedAt = Date.now();
    // Ctrl+C a mitad del envío podría dejar el archivo en la microSD (y la A1
    // puede arrancarlo sola al encenderse): el primer Ctrl+C solo avisa.
    let sigints = 0;
    const onSigint = () => {
      sigints += 1;
      if (sigints === 1) {
        endInline();
        warn(
          "Espera unos segundos a que termine el envío para no dejar archivos sueltos en la microSD. Ctrl+C otra vez para salir de todos modos (luego ejecuta «npm run cli -- limpiar»).",
        );
      } else {
        process.exit(130);
      }
    };
    process.on("SIGINT", onSigint);
    const result = await startPrint({
      connection: conn,
      localPath: path,
      plateIndex: plate.index,
      jobId,
      displayName,
      filament: plan.mapping,
      options,
      urlStyle: opts.url,
      ftps: { mode: opts.mode, timeoutMs: 30_000, confirmTimeoutMs: 30_000 },
      onStep: (step) => {
        if (step !== "uploading") endInline();
        if (step === "started") ok(stepNames[step]!);
        else info(stepNames[step]!);
        recorder.note("paso", { paso: step, ms: Date.now() - startedAt });
      },
      onUploadProgress: (sent, total) =>
        inline(`  ${progressBar(sent / total)} ${bytes(sent)} de ${bytes(total)}`),
    }).finally(() => process.off("SIGINT", onSigint));
    endInline();
    ok(
      `Subida: ${bytes(result.upload.bytes)} en ${dec(result.upload.durationMs / 1000)} s (${speed(result.upload.bytesPerSecond)}) · 226 ${result.upload.transferConfirmed ? "recibido" : c.yellow("no llegó (verificado por tamaño)")}`,
    );
    ok(
      `Confirmado por: ${result.confirmedBy === "task_id" ? "la impresora repitió nuestro ID de tarea" : c.yellow("cambio de estado (la impresora no repitió nuestro ID)")}`,
    );
    recorder.note("arranque", {
      confirmadoPor: result.confirmedBy,
      taskId: result.taskId,
      acks: result.acks.map((a) => a.body),
    });

    if (!opts.follow) {
      info(`Listo. Cuando termine, borra el archivo de la microSD con: npm run cli -- limpiar`);
      return 0;
    }
    code = await follow(conn, result.remoteName, opts.mode, recorder);
  } catch (err) {
    endInline();
    explainError(err);
    if (
      isPrinterError(err) &&
      (err.code === "command_rejected" || err.code === "start_not_confirmed")
    ) {
      const next = opts.url === "ftp" ? "sdcard" : opts.url === "sdcard" ? "ftp3" : undefined;
      if (next)
        info(`Si la impresora no encontró el archivo, prueba el siguiente formato: --url ${next}`);
    }
    recorder.note("error", {
      mensaje: (err as Error).message,
      codigo: isPrinterError(err) ? err.code : undefined,
    });
    code = 1;
  } finally {
    await conn.stop();
    await recorder.close();
    console.log(`${c.dim(`Captura guardada en ${recorder.path}`)}`);
  }
  return code;
}

/** Sigue la impresión hasta que termine (Ctrl+C deja de seguir; la impresora continúa). */
async function follow(
  conn: PrinterConnection,
  remoteName: string,
  mode: FtpsMode,
  recorder: Recorder,
): Promise<number> {
  title("Avance (Ctrl+C para dejar de seguir; la impresora continúa)");
  let interrupted = false;
  const onSigint = () => {
    interrupted = true;
  };
  process.once("SIGINT", onSigint);
  let last = "";
  let lastPlain = "";
  const render = (s: PrinterSnapshot) => {
    const line = `  ${s.gcodeState.padEnd(8)} ${progressBar((s.percent ?? 0) / 100)} capa ${s.layer ?? 0}/${s.totalLayers ?? "?"} · faltan ${duration((s.remainingMinutes ?? 0) * 60)} · boquilla ${dec(s.nozzleTemp)} °C · cama ${dec(s.bedTemp)} °C`;
    if (process.stdout.isTTY) {
      if (line !== last) inline(line);
      last = line;
      return;
    }
    // Sin terminal interactiva: una línea por cambio de estado o cada 10 %.
    const plain = `${s.gcodeState} ${Math.floor((s.percent ?? 0) / 10) * 10}`;
    if (plain !== lastPlain) console.log(line);
    lastPlain = plain;
  };
  conn.on("snapshot", render);
  render(conn.snapshot);
  const final = await new Promise<PrinterSnapshot | undefined>((resolvePromise) => {
    const timer = setInterval(() => {
      const s = conn.snapshot;
      if (interrupted) {
        clearInterval(timer);
        resolvePromise(undefined);
      } else if (s.gcodeState === "FINISH" || s.gcodeState === "FAILED") {
        clearInterval(timer);
        resolvePromise(s);
      }
    }, 500);
  });
  conn.off("snapshot", render);
  process.off("SIGINT", onSigint);
  endInline();
  if (!final) {
    info(
      "Dejaste de seguir la impresión. Cuando termine, borra el archivo con: npm run cli -- limpiar",
    );
    return 0;
  }
  recorder.note("fin", { estado: final.gcodeState, printError: final.printError });
  if (final.gcodeState === "FINISH") ok("Impresión terminada. Retira la pieza.");
  else if (wasCancelled(final)) warn("La impresión fue cancelada.");
  else fail("La impresión falló. Revisa la pantalla de la impresora.");
  try {
    const deleted = await deleteRemoteFile(conn.endpoint, remoteName, { mode });
    if (deleted) ok(`Archivo ${remoteName} borrado de la microSD.`);
  } catch (err) {
    warn(
      `No se pudo borrar ${remoteName} de la microSD: ${(err as Error).message}. Usa: npm run cli -- limpiar`,
    );
  }
  return final.gcodeState === "FINISH" ? 0 : 1;
}
