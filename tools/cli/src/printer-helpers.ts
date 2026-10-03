// Ayudas comunes del CLI: conectar, mostrar el estado y explicar errores.
import { createInterface } from "node:readline/promises";
import {
  activeFaults,
  developerModeMissing,
  isPrinterError,
  PrinterConnection,
  printErrorShort,
  type PrinterEndpoint,
  type PrinterSnapshot,
} from "@blackforge/printer";
import { c, duration, fail, info, warn } from "./format.js";
import type { Recorder } from "./recorder.js";

export const STATE_NAMES: Record<string, string> = {
  IDLE: "Libre (IDLE)",
  PREPARE: "Preparando (PREPARE)",
  SLICING: "Preparando (SLICING)",
  RUNNING: "Imprimiendo (RUNNING)",
  PAUSE: "En pausa (PAUSE)",
  FINISH: "Terminó (FINISH)",
  FAILED: "Falló o se canceló (FAILED)",
  UNKNOWN: "Desconocido",
};

export async function connectPrinter(
  endpoint: PrinterEndpoint,
  recorder?: Recorder,
  timeoutMs = 20_000,
): Promise<PrinterConnection> {
  const conn = new PrinterConnection(endpoint, { connectTimeoutMs: 10_000 });
  if (recorder) recorder.attach(conn);
  conn.start();
  try {
    await conn.waitForOnline(timeoutMs);
    await conn.waitForSnapshot(() => conn.stateValid, timeoutMs);
  } catch (err) {
    await conn.stop();
    throw err;
  }
  return conn;
}

export function trayLabel(globalId: number | undefined): string {
  if (globalId === undefined) return "—";
  if (globalId === 254) return "bobina externa";
  return `AMS ${Math.floor(globalId / 4) + 1}, bandeja ${(globalId % 4) + 1}`;
}

export function printSnapshot(s: PrinterSnapshot): void {
  console.log(`  Estado:        ${c.bold(STATE_NAMES[s.gcodeState] ?? s.gcodeState)}`);
  if (s.subtaskName)
    console.log(
      `  Trabajo:       ${s.subtaskName}${s.taskId ? c.dim(` (task_id ${s.taskId})`) : ""}`,
    );
  if (s.gcodeState === "RUNNING" || s.gcodeState === "PAUSE" || s.gcodeState === "PREPARE") {
    console.log(
      `  Avance:        ${s.percent ?? 0} % · capa ${s.layer ?? 0} de ${s.totalLayers ?? "?"} · faltan ${duration((s.remainingMinutes ?? 0) * 60)}`,
    );
  }
  console.log(
    `  Boquilla:      ${s.nozzleTemp ?? "?"} °C (objetivo ${s.nozzleTarget ?? 0}) · diámetro ${s.nozzleDiameter ?? "?"} mm`,
  );
  console.log(`  Cama:          ${s.bedTemp ?? "?"} °C (objetivo ${s.bedTarget ?? 0})`);
  const sd = {
    present: c.green("puesta"),
    missing: c.red("NO HAY"),
    abnormal: c.red("con problema"),
    unknown: "desconocida",
  }[s.sdCard];
  console.log(`  microSD:       ${sd}`);
  const dev =
    s.signatureRequired === null
      ? "desconocido"
      : developerModeMissing(s)
        ? c.red("APAGADO (las órdenes de imprimir se ignorarán)")
        : c.green("activo");
  console.log(`  Modo desarrollador: ${dev}`);
  if (s.hasAms) {
    console.log(`  AMS lite:`);
    for (const t of s.amsTrays) {
      const active = s.activeTray === t.globalId ? c.cyan(" ← en uso") : "";
      console.log(
        `    Bandeja ${t.slot + 1}: ${t.loaded ? `${t.type} ${t.color}${t.remainPercent !== undefined ? ` (${t.remainPercent} %)` : ""}` : c.dim("vacía")}${active}`,
      );
    }
  } else {
    console.log(`  AMS lite:      no tiene`);
  }
  const ext = s.externalSpool;
  console.log(
    `  Bobina externa: ${ext?.loaded ? `${ext.type} ${ext.color ?? ""}` : c.dim("sin datos")}`,
  );
  if (s.printError) console.log(`  Error de impresión: ${printErrorShort(s.printError)}`);
  const faults = activeFaults(s);
  if (faults.length) console.log(`  Avisos HMS:    ${faults.map((f) => f.full).join(", ")}`);
  if (s.wifiSignal) console.log(`  Wi-Fi:         ${s.wifiSignal}`);
}

const HINTS: Record<string, string> = {
  unreachable:
    "Revisa que la impresora esté encendida, en la misma red que este computador y que la IP sea la correcta. En macOS, permite que la Terminal acceda a la «Red local» (Ajustes del Sistema → Privacidad y seguridad → Red local).",
  auth_failed:
    "Revisa el código de acceso en la pantalla de la A1 (Ajustes → Modo solo LAN). Cambia cada vez que se desactiva y reactiva el modo LAN.",
  tls_untrusted:
    "El certificado no lo firmó la CA de Bambu conocida. Si estás seguro de que es tu impresora, prueba con PRINTER_TLS_VERIFY=false en el .env y avísame para revisarlo.",
  tls_serial_mismatch:
    "La IP corresponde a otra impresora. Borra PRINTER_SERIAL del .env para que se detecte solo, o corrige la IP.",
  developer_mode_required:
    "En la pantalla de la A1: Ajustes → Red (WLAN) → activa «Modo solo LAN» y luego «Modo desarrollador».",
  no_sdcard: "Pon una microSD en la impresora (FAT32 o exFAT) y reinténtalo.",
  busy: "Espera a que la impresora termine o quede libre.",
  start_not_confirmed:
    "Mira la pantalla de la impresora: puede que esté arrancando tarde o mostrando un mensaje.",
};

export function explainError(err: unknown): void {
  if (isPrinterError(err)) {
    fail(err.message);
    const hint = HINTS[err.code];
    if (hint) info(hint);
    if (process.env.BF_DEBUG && err.detail)
      console.log(c.dim(String((err.detail as Error)?.stack ?? JSON.stringify(err.detail))));
    return;
  }
  fail((err as Error)?.message ?? String(err));
  if (process.env.BF_DEBUG) console.log(c.dim(String((err as Error)?.stack)));
}

export async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${c.yellow("?")} ${question} `)).trim().toLowerCase();
    return answer === "si" || answer === "sí" || answer === "s";
  } finally {
    rl.close();
  }
}

export function warnIfDevModeMissing(s: PrinterSnapshot): void {
  if (developerModeMissing(s))
    warn("El Modo desarrollador parece APAGADO: la impresora ignorará las órdenes de imprimir.");
}
