// Cliente FTPS implícito mínimo, escrito para las mañas de la A1:
// - Canal de datos con TLS reutilizando la sesión del canal de control (PROT P),
//   o sin cifrar (PROT C) si la A1 se cuelga con TLS en el canal de datos.
// - La respuesta 226 tras STOR puede no llegar: se espera con tiempo límite y,
//   si no llega, el llamador verifica el tamaño con SIZE.
// Solo implementa lo que necesitamos: USER/PASS, PBSZ, PROT, TYPE, PASV, STOR,
// SIZE, DELE, LIST, QUIT.
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import net from "node:net";
import tls from "node:tls";
import { fromNetworkError, PrinterError } from "./errors.js";

export interface FtpReply {
  code: number;
  message: string;
}

export interface MinimalFtpsOptions {
  host: string;
  port: number;
  user: string;
  password: string;
  tls: tls.ConnectionOptions;
  dataProtection: "P" | "C";
  timeoutMs: number;
}

export class FtpCommandError extends Error {
  constructor(
    readonly reply: FtpReply,
    readonly command: string,
  ) {
    super(`${command.split(" ")[0]} → ${reply.code} ${reply.message}`);
    this.name = "FtpCommandError";
  }
}

export class MinimalFtpsClient {
  private buffer = "";
  private replyLines: string[] = [];
  private waiters: Array<{ resolve: (r: FtpReply) => void; reject: (e: Error) => void }> = [];
  private queued: FtpReply[] = [];
  private closedError?: Error;

  private constructor(
    private readonly socket: tls.TLSSocket,
    private readonly opts: MinimalFtpsOptions,
  ) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.onData(chunk));
    socket.on("error", (err) => this.onClose(err));
    socket.on("close", () => this.onClose(new Error("El canal de control se cerró")));
  }

  static async connect(opts: MinimalFtpsOptions): Promise<MinimalFtpsClient> {
    const socket = await new Promise<tls.TLSSocket>((resolve, reject) => {
      const s = tls.connect({ host: opts.host, port: opts.port, ...opts.tls });
      const timer = setTimeout(() => {
        s.destroy();
        reject(new PrinterError("timeout", "FTPS: la impresora no respondió a tiempo."));
      }, opts.timeoutMs);
      s.once("secureConnect", () => {
        clearTimeout(timer);
        resolve(s);
      });
      s.once("error", (err) => {
        clearTimeout(timer);
        reject(fromNetworkError(err, "FTPS"));
      });
    });
    const client = new MinimalFtpsClient(socket, opts);
    try {
      const welcome = await client.readReply(opts.timeoutMs);
      if (welcome.code !== 220) throw new FtpCommandError(welcome, "CONNECT");
      const user = await client.send(`USER ${opts.user}`);
      if (user.code === 331) {
        const pass = await client.send(`PASS ${opts.password}`);
        if (pass.code !== 230) {
          throw new PrinterError(
            "auth_failed",
            "FTPS: la impresora rechazó el código de acceso.",
            pass,
          );
        }
      } else if (user.code !== 230) {
        throw new FtpCommandError(user, "USER");
      }
      await client.expect("PBSZ 0", [200]);
      await client.expect(`PROT ${opts.dataProtection}`, [200]);
      await client.expect("TYPE I", [200]);
      return client;
    } catch (err) {
      client.destroy();
      throw err;
    }
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).replace(/\r$/, "");
      this.buffer = this.buffer.slice(idx + 1);
      this.onLine(line);
    }
  }

  private onLine(line: string): void {
    this.replyLines.push(line);
    const first = this.replyLines[0]!;
    const code = first.slice(0, 3);
    // Respuesta multilínea: "123-..." hasta "123 ...".
    const done = /^\d{3}( |$)/.test(first) ? true : line.startsWith(`${code} `);
    if (!done) return;
    const reply: FtpReply = {
      code: Number(code),
      message: this.replyLines
        .map((l) => l.replace(/^\d{3}[ -]?/, ""))
        .join("\n")
        .trim(),
    };
    this.replyLines = [];
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve(reply);
    else this.queued.push(reply);
  }

  private onClose(err: Error): void {
    if (this.closedError) return;
    this.closedError = err;
    for (const w of this.waiters.splice(0)) w.reject(err);
  }

  /** Lee la siguiente respuesta del servidor. */
  readReply(timeoutMs = this.opts.timeoutMs): Promise<FtpReply> {
    const queued = this.queued.shift();
    if (queued) return Promise.resolve(queued);
    if (this.closedError) return Promise.reject(this.closedError);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.waiters.findIndex((w) => w.resolve === wrapped);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new PrinterError("timeout", "FTPS: la impresora no respondió a tiempo."));
      }, timeoutMs);
      const wrapped = (r: FtpReply) => {
        clearTimeout(timer);
        resolve(r);
      };
      this.waiters.push({
        resolve: wrapped,
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
  }

  async send(command: string, timeoutMs?: number): Promise<FtpReply> {
    if (this.closedError) throw this.closedError;
    this.socket.write(`${command}\r\n`);
    return this.readReply(timeoutMs);
  }

  async expect(command: string, codes: number[]): Promise<FtpReply> {
    const reply = await this.send(command);
    if (!codes.includes(reply.code)) throw new FtpCommandError(reply, command);
    return reply;
  }

  /** Abre el canal de datos en modo pasivo (con o sin TLS según PROT). */
  private async openDataChannel(): Promise<{ socket: net.Socket; ready: Promise<void> }> {
    const pasv = await this.expect("PASV", [227]);
    const m = /(\d+),(\d+),(\d+),(\d+),(\d+),(\d+)/.exec(pasv.message);
    if (!m) throw new FtpCommandError(pasv, "PASV");
    const port = Number(m[5]) * 256 + Number(m[6]);
    // Se usa la IP del canal de control: algunos servidores embebidos anuncian otra.
    const raw = await new Promise<net.Socket>((resolve, reject) => {
      const s = net.connect({ host: this.opts.host, port });
      const timer = setTimeout(() => {
        s.destroy();
        reject(new PrinterError("timeout", "FTPS: no se pudo abrir el canal de datos."));
      }, this.opts.timeoutMs);
      s.once("connect", () => {
        clearTimeout(timer);
        resolve(s);
      });
      s.once("error", (err) => {
        clearTimeout(timer);
        reject(fromNetworkError(err, "FTPS datos"));
      });
    });
    if (this.opts.dataProtection === "C") return { socket: raw, ready: Promise.resolve() };
    const secure = tls.connect({
      ...this.opts.tls,
      socket: raw,
      session: this.socket.getSession(),
    });
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        secure.destroy();
        reject(new PrinterError("timeout", "FTPS: el TLS del canal de datos no respondió."));
      }, this.opts.timeoutMs);
      secure.once("secureConnect", () => {
        clearTimeout(timer);
        resolve();
      });
      secure.once("error", (err) => {
        clearTimeout(timer);
        reject(fromNetworkError(err, "FTPS datos TLS"));
      });
    });
    ready.catch(() => {}); // se observa más abajo; evita rechazos no manejados
    return { socket: secure, ready };
  }

  /**
   * Sube un archivo. Devuelve `confirmed = false` si la impresora no envió la
   * respuesta final (226) en `confirmTimeoutMs`; el llamador debe verificar con SIZE.
   */
  async upload(
    localPath: string,
    remoteName: string,
    options: { onProgress?: (sent: number, total: number) => void; confirmTimeoutMs: number },
  ): Promise<{
    bytes: number;
    confirmed: boolean;
    finalReply?: FtpReply;
    sessionReused?: boolean;
  }> {
    const total = (await stat(localPath)).size;
    const { socket: data, ready: secure } = await this.openDataChannel();
    const stor = await this.send(`STOR ${remoteName}`);
    if (stor.code !== 150 && stor.code !== 125) {
      data.destroy();
      throw new FtpCommandError(stor, "STOR");
    }
    await secure;
    const sessionReused = data instanceof tls.TLSSocket ? data.isSessionReused() : undefined;

    let sent = 0;
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(localPath, { highWaterMark: 64 * 1024 });
      let idle = setTimeout(onIdle, this.opts.timeoutMs);
      function onIdle() {
        stream.destroy();
        data.destroy();
        reject(new PrinterError("timeout", "FTPS: la subida se detuvo (sin avance)."));
      }
      stream.on("data", (chunk: string | Buffer) => {
        const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        sent += buf.length;
        options.onProgress?.(sent, total);
        if (!data.write(buf)) {
          stream.pause();
          data.once("drain", () => stream.resume());
        }
        clearTimeout(idle);
        idle = setTimeout(onIdle, this.opts.timeoutMs);
      });
      stream.on("end", () => {
        clearTimeout(idle);
        data.end(() => resolve());
      });
      stream.on("error", (err) => {
        clearTimeout(idle);
        data.destroy();
        reject(err);
      });
      data.on("error", (err) => {
        clearTimeout(idle);
        stream.destroy();
        reject(fromNetworkError(err, "FTPS datos"));
      });
    });

    try {
      const final = await this.readReply(options.confirmTimeoutMs);
      if (final.code >= 400) throw new FtpCommandError(final, "STOR");
      return {
        bytes: sent,
        confirmed: final.code === 226 || final.code === 250,
        finalReply: final,
        sessionReused,
      };
    } catch (err) {
      if (err instanceof FtpCommandError) throw err;
      return { bytes: sent, confirmed: false, sessionReused };
    }
  }

  async size(remoteName: string): Promise<number | undefined> {
    const reply = await this.send(`SIZE ${remoteName}`);
    if (reply.code === 213) {
      const n = Number(reply.message.trim().split(/\s+/).pop());
      return Number.isFinite(n) ? n : undefined;
    }
    if (reply.code === 550) return undefined;
    throw new FtpCommandError(reply, "SIZE");
  }

  async remove(remoteName: string): Promise<boolean> {
    const reply = await this.send(`DELE ${remoteName}`);
    if (reply.code === 250 || reply.code === 200) return true;
    if (reply.code === 550) return false;
    throw new FtpCommandError(reply, "DELE");
  }

  async list(path = "/"): Promise<Array<{ name: string; size?: number; isDirectory: boolean }>> {
    const { socket: data, ready: secure } = await this.openDataChannel();
    const reply = await this.send(`LIST ${path}`);
    if (reply.code !== 150 && reply.code !== 125) {
      data.destroy();
      throw new FtpCommandError(reply, "LIST");
    }
    await secure;
    const text = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      data.on("data", (c: Buffer) => chunks.push(c));
      data.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      data.on("error", (err) => reject(fromNetworkError(err, "FTPS datos")));
    });
    await this.readReply().catch(() => undefined);
    return parseListing(text);
  }

  async quit(): Promise<void> {
    try {
      if (!this.closedError) await this.send("QUIT", 3000);
    } catch {
      // da igual: cerramos de todas formas
    } finally {
      this.destroy();
    }
  }

  destroy(): void {
    this.socket.destroy();
  }
}

/** Interpreta un listado tipo `ls -l` (el formato habitual de servidores embebidos). */
export function parseListing(
  text: string,
): Array<{ name: string; size?: number; isDirectory: boolean }> {
  const out: Array<{ name: string; size?: number; isDirectory: boolean }> = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || /^total\s+\d+/i.test(line)) continue;
    const unix =
      /^([\-dlrwxsStT]{10})\s+\S+\s+\S+\s+\S+\s+(\d+)\s+\w{3}\s+\d{1,2}\s+[\d:]{4,5}\s+(.+)$/.exec(
        line,
      );
    if (unix) {
      out.push({ name: unix[3]!, size: Number(unix[2]), isDirectory: unix[1]!.startsWith("d") });
      continue;
    }
    out.push({ name: line.trim(), isDirectory: false });
  }
  return out.filter((f) => f.name !== "." && f.name !== "..");
}
