// Transferencia de archivos a la microSD de la impresora por FTPS implícito (990).
//
// Tres modos, para descubrir en la Fase 1 cuál funciona con la A1 real:
//   basic      → basic-ftp (TLS en datos con reutilización de sesión)
//   minimal-p  → cliente propio, TLS en datos con reutilización de sesión
//   minimal-c  → cliente propio, canal de datos sin cifrar (control cifrado)
// Tras la prueba real nos quedamos con uno (ver docs/protocolo-a1.md §4).
import { stat } from "node:fs/promises";
import { Client as BasicClient, FTPError } from "basic-ftp";
import type { PrinterEndpoint } from "./connection.js";
import { fromNetworkError, isPrinterError, PrinterError } from "./errors.js";
import { FtpCommandError, MinimalFtpsClient } from "./ftps-minimal.js";
import { DEFAULT_TLS, tlsOptionsFor } from "./tls.js";

export type FtpsMode = "basic" | "minimal-p" | "minimal-c";
export const FTPS_MODES: readonly FtpsMode[] = ["basic", "minimal-p", "minimal-c"];

export interface RemoteFile {
  name: string;
  size?: number;
  isDirectory: boolean;
}

export interface UploadResult {
  remoteName: string;
  mode: FtpsMode;
  bytes: number;
  /** Tamaño comprobado en la microSD (SIZE). */
  verifiedSize?: number;
  /** La impresora envió la confirmación final (226). */
  transferConfirmed: boolean;
  /** Solo modos con TLS en datos: si se reutilizó la sesión TLS. */
  sessionReused?: boolean;
  durationMs: number;
  bytesPerSecond: number;
}

export interface FtpsOptions {
  mode?: FtpsMode;
  /** Tiempo máximo sin actividad en la conexión. */
  timeoutMs?: number;
  /** Cuánto esperar la confirmación 226 tras enviar el archivo. */
  confirmTimeoutMs?: number;
}

interface Session {
  upload(
    localPath: string,
    remoteName: string,
    onProgress: ((sent: number, total: number) => void) | undefined,
    confirmTimeoutMs: number,
  ): Promise<{ bytes: number; confirmed: boolean; sessionReused?: boolean }>;
  size(remoteName: string): Promise<number | undefined>;
  remove(remoteName: string): Promise<boolean>;
  list(path: string): Promise<RemoteFile[]>;
  close(): Promise<void>;
}

function ftpReplyCode(err: unknown): number | undefined {
  if (err instanceof FtpCommandError) return err.reply.code;
  if (err instanceof FTPError) return err.code;
  return undefined;
}

/** Traduce errores FTP a PrinterError con mensajes útiles. */
export function classifyFtpError(err: unknown, what: string): PrinterError {
  if (isPrinterError(err)) return err;
  const code = ftpReplyCode(err);
  const msg = err instanceof Error ? err.message : String(err);
  if (code === 530)
    return new PrinterError("auth_failed", "FTPS: la impresora rechazó el código de acceso.", err);
  if (code === 553) {
    return new PrinterError(
      "no_sdcard",
      `${what}: la impresora no pudo crear el archivo (553). Revisa que tenga microSD, que no esté llena y que esté formateada en FAT32/exFAT.`,
      err,
    );
  }
  if (code === 552 || code === 452)
    return new PrinterError("sdcard_full", `${what}: la microSD está llena (${code}).`, err);
  if (code !== undefined)
    return new PrinterError(
      "upload_failed",
      `${what}: la impresora respondió ${code} (${msg}).`,
      err,
    );
  if (/timeout/i.test(msg))
    return new PrinterError("timeout", `${what}: la impresora dejó de responder.`, err);
  return fromNetworkError(err, what);
}

async function openSession(
  endpoint: PrinterEndpoint,
  mode: FtpsMode,
  timeoutMs: number,
): Promise<Session> {
  const tlsOpts = tlsOptionsFor(endpoint.serial, endpoint.tls ?? DEFAULT_TLS);
  const port = endpoint.ftpsPort ?? 990;
  if (mode === "basic") {
    const client = new BasicClient(timeoutMs);
    try {
      await client.access({
        host: endpoint.host,
        port,
        user: "bblp",
        password: endpoint.accessCode,
        secure: "implicit",
        secureOptions: tlsOpts,
      });
      await client.send("TYPE I");
    } catch (err) {
      client.close();
      throw classifyFtpError(err, "FTPS");
    }
    return {
      // basic-ftp espera la confirmación con su propio tiempo límite de inactividad.
      async upload(localPath, remoteName, onProgress) {
        const total = (await stat(localPath)).size;
        let sent = 0;
        client.trackProgress((info) => {
          sent = info.bytes;
          onProgress?.(sent, total);
        });
        try {
          await client.uploadFrom(localPath, remoteName);
          return { bytes: sent || total, confirmed: true };
        } catch (err) {
          // Si se envió todo y solo faltó la confirmación, el llamador verifica con SIZE.
          if (sent >= total && /timeout/i.test(String((err as Error)?.message))) {
            return { bytes: sent, confirmed: false };
          }
          throw err;
        } finally {
          client.trackProgress();
        }
      },
      async size(remoteName) {
        try {
          return await client.size(remoteName);
        } catch (err) {
          if (ftpReplyCode(err) === 550) return undefined;
          throw err;
        }
      },
      async remove(remoteName) {
        try {
          await client.remove(remoteName);
          return true;
        } catch (err) {
          if (ftpReplyCode(err) === 550) return false;
          throw err;
        }
      },
      async list(path) {
        const files = await client.list(path);
        return files.map((f) => ({ name: f.name, size: f.size, isDirectory: f.isDirectory }));
      },
      async close() {
        client.close();
      },
    };
  }

  const client = await MinimalFtpsClient.connect({
    host: endpoint.host,
    port,
    user: "bblp",
    password: endpoint.accessCode,
    tls: tlsOpts,
    dataProtection: mode === "minimal-c" ? "C" : "P",
    timeoutMs,
  }).catch((err: unknown) => {
    throw classifyFtpError(err, "FTPS");
  });
  return {
    async upload(localPath, remoteName, onProgress, confirmTimeoutMs) {
      const r = await client.upload(localPath, remoteName, { onProgress, confirmTimeoutMs });
      return { bytes: r.bytes, confirmed: r.confirmed, sessionReused: r.sessionReused };
    },
    size: (remoteName) => client.size(remoteName),
    remove: (remoteName) => client.remove(remoteName),
    list: (path) => client.list(path),
    close: () => client.quit(),
  };
}

async function withSession<T>(
  endpoint: PrinterEndpoint,
  options: FtpsOptions,
  fn: (s: Session) => Promise<T>,
): Promise<T> {
  const session = await openSession(endpoint, options.mode ?? "basic", options.timeoutMs ?? 30_000);
  try {
    return await fn(session);
  } finally {
    await session.close().catch(() => {});
  }
}

/**
 * Sube un archivo y comprueba que quedó completo en la microSD. Si la
 * impresora no confirma (226), verifica el tamaño con SIZE (en la misma
 * sesión o en una nueva).
 */
export async function uploadFile(
  endpoint: PrinterEndpoint,
  localPath: string,
  remoteName: string,
  options: FtpsOptions & { onProgress?: (sent: number, total: number) => void } = {},
): Promise<UploadResult> {
  const mode = options.mode ?? "basic";
  const timeoutMs = options.timeoutMs ?? 30_000;
  const confirmTimeoutMs = options.confirmTimeoutMs ?? 30_000;
  const total = (await stat(localPath)).size;
  const started = Date.now();
  const session = await openSession(endpoint, mode, timeoutMs);
  let result: { bytes: number; confirmed: boolean; sessionReused?: boolean };
  let verifiedSize: number | undefined;
  try {
    result = await session.upload(localPath, remoteName, options.onProgress, confirmTimeoutMs);
    verifiedSize = await session.size(remoteName).catch(() => undefined);
  } catch (err) {
    await session.close().catch(() => {});
    throw classifyFtpError(err, "Subida FTPS");
  }
  await session.close().catch(() => {});
  if (verifiedSize === undefined) {
    // La sesión pudo quedar inutilizable si faltó el 226: se verifica en otra.
    verifiedSize = await withSession(endpoint, { mode, timeoutMs }, (s) =>
      s.size(remoteName),
    ).catch(() => undefined);
  }
  const durationMs = Date.now() - started;
  if (verifiedSize !== total) {
    throw new PrinterError(
      "upload_incomplete",
      `El archivo no quedó completo en la microSD (esperados ${total} bytes, hay ${verifiedSize ?? "ninguno"}).`,
      { total, verifiedSize, confirmed: result.confirmed },
    );
  }
  return {
    remoteName,
    mode,
    bytes: result.bytes,
    verifiedSize,
    transferConfirmed: result.confirmed,
    sessionReused: result.sessionReused,
    durationMs,
    bytesPerSecond: durationMs > 0 ? Math.round((total / durationMs) * 1000) : total,
  };
}

export async function deleteRemoteFile(
  endpoint: PrinterEndpoint,
  remoteName: string,
  options: FtpsOptions = {},
): Promise<boolean> {
  try {
    return await withSession(endpoint, options, (s) => s.remove(remoteName));
  } catch (err) {
    throw classifyFtpError(err, "Borrar archivo de la microSD");
  }
}

export async function remoteFileSize(
  endpoint: PrinterEndpoint,
  remoteName: string,
  options: FtpsOptions = {},
): Promise<number | undefined> {
  try {
    return await withSession(endpoint, options, (s) => s.size(remoteName));
  } catch (err) {
    throw classifyFtpError(err, "Consultar archivo en la microSD");
  }
}

export async function listRemoteFiles(
  endpoint: PrinterEndpoint,
  path = "/",
  options: FtpsOptions = {},
): Promise<RemoteFile[]> {
  try {
    return await withSession(endpoint, options, (s) => s.list(path));
  } catch (err) {
    throw classifyFtpError(err, "Listar la microSD");
  }
}
