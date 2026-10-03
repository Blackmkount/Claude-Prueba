// Flujo para iniciar una impresión con todas las guardas:
//   1. comprobar que la impresora puede empezar (en línea, libre, microSD, modo desarrollador)
//   2. subir el archivo y verificar el tamaño en la microSD
//   3. volver a comprobar el estado JUSTO antes de publicar (la subida tarda)
//   4. publicar project_file
//   5. esperar a que la impresora confirme que arrancó con nuestro ID
// Si algo falla antes de que arranque, se borra el archivo de la microSD
// (la A1 puede arrancar sola archivos que quedan ahí al encenderse).
import {
  DEFAULT_PRINT_OPTIONS,
  newTaskId,
  projectFileCommand,
  remoteFileName,
  type FilamentMapping,
  type PrintOptions,
  type UrlStyle,
} from "./commands.js";
import type { CommandAck, PrinterConnection } from "./connection.js";
import { isPrinterError, PrinterError } from "./errors.js";
import { deleteRemoteFile, uploadFile, type FtpsOptions, type UploadResult } from "./ftps.js";
import { silentLogger, type Logger } from "./logger.js";
import {
  activeFaults,
  developerModeMissing,
  printErrorShort,
  STARTABLE_GCODE_STATES,
  wasCancelled,
  type PrinterSnapshot,
} from "./state.js";

export type PrintStep =
  "checking" | "uploading" | "verifying" | "starting" | "waiting_start" | "started";

export interface StartPrintInput {
  connection: PrinterConnection;
  localPath: string;
  plateIndex: number;
  /** Identificador del trabajo en nuestra base (se usa para el nombre en la microSD). */
  jobId: string;
  /** Lo que muestra la pantalla de la impresora, p. ej. "Oso x2". */
  displayName: string;
  filament: FilamentMapping;
  options?: PrintOptions;
  urlStyle?: UrlStyle;
  ftps?: FtpsOptions;
  /** Cuánto esperar a que la impresora confirme que arrancó. */
  confirmTimeoutMs?: number;
  /** ID de tarea a usar (por defecto uno nuevo). */
  taskId?: string;
  onStep?: (step: PrintStep) => void;
  onUploadProgress?: (sent: number, total: number) => void;
  logger?: Logger;
}

export interface StartPrintResult {
  taskId: string;
  remoteName: string;
  upload: UploadResult;
  /** Cómo se confirmó: la impresora repitió nuestro ID, o solo cambió de estado. */
  confirmedBy: "task_id" | "state_transition";
  snapshot: PrinterSnapshot;
  /** Mensajes de la impresora durante el arranque (para el diagnóstico). */
  acks: CommandAck[];
}

/** Lanza un PrinterError si la impresora no puede empezar una impresión ahora. */
export function assertCanStart(connection: PrinterConnection): void {
  if (!connection.online) {
    throw new PrinterError("not_connected", "La impresora no está conectada.");
  }
  if (!connection.stateValid) {
    throw new PrinterError(
      "not_connected",
      "Todavía no hay un estado confiable de la impresora; espera unos segundos.",
    );
  }
  const s = connection.snapshot;
  if (developerModeMissing(s)) {
    throw new PrinterError(
      "developer_mode_required",
      "La impresora exige comandos firmados: activa el «Modo desarrollador» en Ajustes → Red de la A1.",
    );
  }
  if (!STARTABLE_GCODE_STATES.has(s.gcodeState)) {
    throw new PrinterError("busy", `La impresora está ocupada (estado ${s.gcodeState}).`);
  }
  if (s.sdCard === "missing") throw new PrinterError("no_sdcard", "La impresora no tiene microSD.");
  if (s.sdCard === "abnormal")
    throw new PrinterError("no_sdcard", "La microSD de la impresora tiene un problema.");
}

async function safeDelete(input: StartPrintInput, remoteName: string, log: Logger): Promise<void> {
  try {
    await deleteRemoteFile(input.connection.endpoint, remoteName, input.ftps);
  } catch (err) {
    log.warn(
      { remoteName, err: (err as Error).message },
      "No se pudo borrar el archivo de la microSD",
    );
  }
}

export async function startPrint(input: StartPrintInput): Promise<StartPrintResult> {
  const log = input.logger ?? silentLogger;
  const conn = input.connection;
  const taskId = input.taskId ?? newTaskId();
  const remoteName = remoteFileName(input.jobId);

  input.onStep?.("checking");
  assertCanStart(conn);

  input.onStep?.("uploading");
  const upload = await uploadFile(conn.endpoint, input.localPath, remoteName, {
    ...input.ftps,
    onProgress: input.onUploadProgress,
  }).catch(async (err: unknown) => {
    await safeDelete(input, remoteName, log);
    throw err;
  });

  // Re-comprobación justo antes de publicar: la subida pudo tardar minutos y
  // alguien pudo iniciar otra impresión desde la pantalla. Enviar project_file a
  // una impresora ocupada puede cancelar lo que está imprimiendo.
  input.onStep?.("verifying");
  try {
    assertCanStart(conn);
    await conn.getVersion(8_000); // prueba de vida: descarta una conexión "zombi"
    assertCanStart(conn);
  } catch (err) {
    await safeDelete(input, remoteName, log);
    throw err;
  }

  input.onStep?.("starting");
  const before = conn.snapshot;
  const acks: CommandAck[] = [];
  const command = projectFileCommand({
    plateIndex: input.plateIndex,
    remoteName,
    urlStyle: input.urlStyle ?? "ftp",
    displayName: input.displayName,
    taskId,
    filament: input.filament,
    options: input.options ?? DEFAULT_PRINT_OPTIONS,
  });

  const outcome = waitForStart(conn, taskId, before, input.confirmTimeoutMs ?? 90_000, acks);
  try {
    await conn.publish(command);
  } catch (err) {
    outcome.cancel();
    await safeDelete(input, remoteName, log);
    throw err;
  }
  input.onStep?.("waiting_start");
  try {
    const { snapshot, confirmedBy } = await outcome.promise;
    input.onStep?.("started");
    return { taskId, remoteName, upload, confirmedBy, snapshot, acks };
  } catch (err) {
    // Si la impresora rechazó el comando, el archivo sobra. Si solo no confirmó
    // a tiempo, NO se borra: podría estar arrancando tarde.
    if (isPrinterError(err) && err.code !== "start_not_confirmed")
      await safeDelete(input, remoteName, log);
    throw err;
  }
}

function waitForStart(
  conn: PrinterConnection,
  taskId: string,
  before: PrinterSnapshot,
  timeoutMs: number,
  acks: CommandAck[],
): {
  promise: Promise<{ snapshot: PrinterSnapshot; confirmedBy: "task_id" | "state_transition" }>;
  cancel: () => void;
} {
  let cleanup = () => {};
  const promise = new Promise<{
    snapshot: PrinterSnapshot;
    confirmedBy: "task_id" | "state_transition";
  }>((resolve, reject) => {
    const started = new Set(["PREPARE", "SLICING", "RUNNING"]);
    const onSnapshot = (s: PrinterSnapshot) => {
      if (developerModeMissing(s)) {
        done();
        reject(
          new PrinterError(
            "developer_mode_required",
            "La impresora ignoró la orden: activa el «Modo desarrollador» en la A1.",
          ),
        );
        return;
      }
      if (s.hms.some((h) => h.short === "0500_4004") || s.printError === 0x05004004) {
        done();
        reject(new PrinterError("busy", "La impresora respondió que está ocupada (0500_4004)."));
        return;
      }
      const ours = s.taskId === taskId || s.subtaskId === taskId;
      if (started.has(s.gcodeState)) {
        // Si la impresora reporta OTRO ID de tarea (no "0"), arrancó un trabajo
        // ajeno (p. ej. desde la pantalla al mismo tiempo): no es el nuestro.
        const foreign = [s.taskId, s.subtaskId].some((id) => id && id !== "0" && id !== taskId);
        if (!ours && foreign) {
          done();
          reject(
            new PrinterError("busy", "Otra impresión empezó en esta impresora al mismo tiempo."),
          );
          return;
        }
        done();
        resolve({ snapshot: s, confirmedBy: ours ? "task_id" : "state_transition" });
        return;
      }
      if (
        s.gcodeState === "FAILED" &&
        s.printError !== 0 &&
        s.printError !== before.printError &&
        !wasCancelled(s)
      ) {
        done();
        reject(
          new PrinterError(
            "command_rejected",
            `La impresora no pudo iniciar (error ${printErrorShort(s.printError)}).`,
            s,
          ),
        );
        return;
      }
      const faults = activeFaults(s).filter((f) => !before.hms.some((b) => b.full === f.full));
      if (faults.length > 0 && s.gcodeState !== before.gcodeState) {
        done();
        reject(
          new PrinterError(
            "command_rejected",
            `La impresora reportó un error al iniciar (${faults.map((f) => f.short).join(", ")}).`,
            s,
          ),
        );
      }
    };
    const onAck = (ack: CommandAck) => {
      if (ack.command !== "project_file") return;
      acks.push(ack);
      if (ack.result && !/^success$/i.test(ack.result)) {
        done();
        reject(
          new PrinterError(
            "command_rejected",
            `La impresora rechazó la orden de imprimir: ${ack.reason || ack.result}`,
            ack.body,
          ),
        );
      }
    };
    const timer = setTimeout(() => {
      done();
      reject(
        new PrinterError(
          "start_not_confirmed",
          `La impresora no confirmó el inicio en ${Math.round(timeoutMs / 1000)} s. Revisa su pantalla antes de volver a intentar.`,
        ),
      );
    }, timeoutMs);
    const done = () => {
      clearTimeout(timer);
      conn.off("snapshot", onSnapshot);
      conn.off("ack", onAck);
    };
    cleanup = done;
    conn.on("snapshot", onSnapshot);
    conn.on("ack", onAck);
  });
  promise.catch(() => {}); // el llamador lo observa; evita rechazo no manejado si se cancela
  return { promise, cancel: () => cleanup() };
}
