// Servidor FTPS implícito falso que imita a la A1, con sus mañas activables:
//   noTransferComplete   no envía 226 tras recibir un archivo
//   protPHangs           con PROT P, el canal de datos se queda colgado
//   requireSessionReuse  con PROT P, exige reutilizar la sesión TLS del control (como vsFTPd)
//   slowKBps             limita la velocidad de subida
//   noSdCard             responde 553 al subir (sin microSD)
import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import net from "node:net";
import { join } from "node:path";
import tls from "node:tls";
import type { KeyPairPem } from "./certs.js";

export interface FtpsQuirks {
  noTransferComplete?: boolean;
  protPHangs?: boolean;
  requireSessionReuse?: boolean;
  slowKBps?: number;
  noSdCard?: boolean;
}

export interface FtpsServerOptions {
  host: string;
  port: number;
  accessCode: string;
  cert: KeyPairPem;
  storageDir: string;
  quirks: () => FtpsQuirks;
  /** Se llama al terminar de recibir un archivo. */
  onFileStored?: (name: string, bytes: number) => void;
  log?: (msg: string) => void;
}

interface Session {
  socket: tls.TLSSocket;
  user?: string;
  authed: boolean;
  prot: "C" | "P";
  pasv?: net.Server;
  pendingData?: Promise<net.Socket>;
}

function safeName(arg: string): string | undefined {
  const name = arg.replace(/^\/+/, "").trim();
  if (!name || name.includes("/") || name.includes("..")) return undefined;
  return name;
}

function listLine(name: string, size: number, mtime: Date): string {
  const month = mtime.toLocaleString("en-US", { month: "short" });
  const day = String(mtime.getDate()).padStart(2, " ");
  const time = `${String(mtime.getHours()).padStart(2, "0")}:${String(mtime.getMinutes()).padStart(2, "0")}`;
  return `-rw-r--r--    1 root     root     ${String(size).padStart(10, " ")} ${month} ${day} ${time} ${name}`;
}

export class FakeFtpsServer {
  private server?: tls.Server;
  private readonly sockets = new Set<net.Socket>();
  private readonly passiveServers = new Set<net.Server>();
  private readonly secureContext: tls.SecureContext;
  // Claves de ticket compartidas entre el canal de control y el de datos, para
  // que la reutilización de sesión TLS funcione como en vsFTPd.
  private readonly ticketKeys = randomBytes(48);

  constructor(private readonly opts: FtpsServerOptions) {
    this.secureContext = tls.createSecureContext({
      key: opts.cert.keyPem,
      cert: opts.cert.certPem,
      minVersion: "TLSv1.2",
      maxVersion: "TLSv1.2",
      ticketKeys: this.ticketKeys,
      sessionIdContext: "bf-sim-ftps",
    });
  }

  async start(): Promise<void> {
    await mkdir(this.opts.storageDir, { recursive: true });
    const server = tls.createServer(
      {
        key: this.opts.cert.keyPem,
        cert: this.opts.cert.certPem,
        minVersion: "TLSv1.2",
        maxVersion: "TLSv1.2",
        ticketKeys: this.ticketKeys,
        sessionIdContext: "bf-sim-ftps",
      },
      (socket) => this.onConnection(socket),
    );
    server.on("tlsClientError", () => {});
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.opts.port, this.opts.host, () => resolve());
    });
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    for (const p of this.passiveServers) p.close();
    this.passiveServers.clear();
    const server = this.server;
    this.server = undefined;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** Cierra las conexiones abiertas (simula un corte de red). */
  dropConnections(): void {
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
  }

  async listFiles(): Promise<Array<{ name: string; size: number }>> {
    const names = await readdir(this.opts.storageDir).catch(() => [] as string[]);
    const out: Array<{ name: string; size: number }> = [];
    for (const name of names) {
      const st = await stat(join(this.opts.storageDir, name)).catch(() => undefined);
      if (st?.isFile()) out.push({ name, size: st.size });
    }
    return out;
  }

  filePath(name: string): string {
    return join(this.opts.storageDir, name);
  }

  private track(socket: net.Socket): void {
    this.sockets.add(socket);
    socket.on("close", () => this.sockets.delete(socket));
    socket.on("error", () => {});
  }

  private onConnection(socket: tls.TLSSocket): void {
    this.track(socket);
    const session: Session = { socket, authed: false, prot: "C" };
    const reply = (line: string) => {
      if (!socket.destroyed) socket.write(`${line}\r\n`);
    };
    reply("220 Bambu FTP server ready (simulador BlackForge)");
    let buffer = "";
    let queue = Promise.resolve();
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, "");
        buffer = buffer.slice(idx + 1);
        queue = queue
          .then(() => this.handle(session, line, reply))
          .catch((err: unknown) => {
            this.opts.log?.(`FTPS error: ${(err as Error).message}`);
            reply("451 Error local");
          });
      }
    });
    socket.on("close", () => session.pasv?.close());
  }

  private async handle(session: Session, line: string, reply: (l: string) => void): Promise<void> {
    const space = line.indexOf(" ");
    const cmd = (space < 0 ? line : line.slice(0, space)).toUpperCase();
    const arg = space < 0 ? "" : line.slice(space + 1);
    this.opts.log?.(`FTPS < ${cmd === "PASS" ? "PASS ****" : line}`);
    const open = ["USER", "PASS", "QUIT", "FEAT", "SYST", "NOOP", "AUTH", "PBSZ", "PROT", "OPTS"];
    if (!session.authed && !open.includes(cmd)) {
      reply("530 Please login with USER and PASS.");
      return;
    }
    switch (cmd) {
      case "USER":
        session.user = arg;
        reply("331 Please specify the password.");
        return;
      case "PASS":
        if (session.user === "bblp" && arg === this.opts.accessCode) {
          session.authed = true;
          reply("230 Login successful.");
        } else {
          reply("530 Login incorrect.");
        }
        return;
      case "PBSZ":
        reply("200 PBSZ=0");
        return;
      case "PROT":
        if (arg.toUpperCase() === "P" || arg.toUpperCase() === "C") {
          session.prot = arg.toUpperCase() as "P" | "C";
          reply(`200 PROT now ${session.prot === "P" ? "Private" : "Clear"}.`);
        } else {
          reply("504 Unsupported PROT level.");
        }
        return;
      case "TYPE":
        reply("200 Switching to Binary mode.");
        return;
      case "SYST":
        reply("215 UNIX Type: L8");
        return;
      case "FEAT":
        reply("211-Features:\r\n PASV\r\n SIZE\r\n PBSZ\r\n PROT\r\n211 End");
        return;
      case "OPTS":
      case "NOOP":
        reply("200 OK");
        return;
      case "PWD":
        reply('257 "/" is the current directory');
        return;
      case "CWD":
        reply(
          arg === "/" || arg === ""
            ? "250 Directory successfully changed."
            : "550 Failed to change directory.",
        );
        return;
      case "PASV":
        await this.openPassive(session, reply);
        return;
      case "STOR":
        await this.stor(session, arg, reply);
        return;
      case "SIZE": {
        const name = safeName(arg);
        const st = name ? await stat(this.filePath(name)).catch(() => undefined) : undefined;
        reply(st?.isFile() ? `213 ${st.size}` : "550 Could not get file size.");
        return;
      }
      case "DELE": {
        const name = safeName(arg);
        const st = name ? await stat(this.filePath(name)).catch(() => undefined) : undefined;
        if (!name || !st) {
          reply("550 Delete operation failed.");
          return;
        }
        await rm(this.filePath(name));
        reply("250 Delete operation successful.");
        return;
      }
      case "LIST":
      case "NLST":
        await this.list(session, cmd, reply);
        return;
      case "QUIT":
        reply("221 Goodbye.");
        session.socket.end();
        return;
      default:
        reply("502 Command not implemented.");
    }
  }

  private async openPassive(session: Session, reply: (l: string) => void): Promise<void> {
    session.pasv?.close();
    const server = net.createServer();
    this.passiveServers.add(server);
    server.on("close", () => this.passiveServers.delete(server));
    session.pasv = server;
    session.pendingData = new Promise<net.Socket>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("sin conexión de datos")), 15_000);
      server.once("connection", (raw) => {
        clearTimeout(timer);
        this.track(raw);
        server.close();
        resolve(raw);
      });
    });
    session.pendingData.catch(() => {});
    await new Promise<void>((resolve) => server.listen(0, this.opts.host, () => resolve()));
    const port = (server.address() as net.AddressInfo).port;
    const ip = (this.opts.host === "0.0.0.0" ? "127.0.0.1" : this.opts.host).split(".").join(",");
    reply(`227 Entering Passive Mode (${ip},${Math.floor(port / 256)},${port % 256}).`);
  }

  /** Obtiene el canal de datos ya listo (con TLS si PROT P). Devuelve null si debe colgarse o rechazarse. */
  private async dataSocket(
    session: Session,
    reply: (l: string) => void,
  ): Promise<net.Socket | null> {
    if (!session.pendingData) {
      reply("425 Use PASV first.");
      return null;
    }
    let raw: net.Socket;
    try {
      raw = await session.pendingData;
    } catch {
      reply("425 Failed to establish connection.");
      return null;
    } finally {
      session.pendingData = undefined;
    }
    reply("150 Ok to send data.");
    if (session.prot === "C") return raw;
    const quirks = this.opts.quirks();
    if (quirks.protPHangs) {
      // La A1 se queda esperando sin completar el TLS del canal de datos.
      return null;
    }
    const secure = new tls.TLSSocket(raw, {
      isServer: true,
      secureContext: this.secureContext,
      server: this.server,
    });
    this.track(secure);
    await new Promise<void>((resolve, reject) => {
      secure.once("secure", () => resolve());
      secure.once("error", reject);
    });
    if (quirks.requireSessionReuse && !secure.isSessionReused()) {
      secure.destroy();
      reply("522 SSL connection failed: session reuse required");
      return null;
    }
    return secure;
  }

  private async stor(session: Session, arg: string, reply: (l: string) => void): Promise<void> {
    const name = safeName(arg);
    const quirks = this.opts.quirks();
    if (!name) {
      reply("553 Could not create file.");
      return;
    }
    if (quirks.noSdCard) {
      session.pendingData?.then((s) => s.destroy()).catch(() => {});
      session.pendingData = undefined;
      reply("553 Could not create file.");
      return;
    }
    const data = await this.dataSocket(session, reply);
    if (!data) return;
    const path = this.filePath(name);
    const out = createWriteStream(path);
    let bytes = 0;
    const kbps = quirks.slowKBps;
    await new Promise<void>((resolve) => {
      data.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        out.write(chunk);
        if (kbps && kbps > 0) {
          data.pause();
          setTimeout(() => data.resume(), Math.ceil((chunk.length / (kbps * 1024)) * 1000));
        }
      });
      const finish = () => out.end(() => resolve());
      data.once("end", finish);
      data.once("close", finish);
      data.once("error", finish);
    });
    this.opts.onFileStored?.(name, bytes);
    if (!this.opts.quirks().noTransferComplete) reply("226 Transfer complete.");
  }

  private async list(session: Session, cmd: string, reply: (l: string) => void): Promise<void> {
    const data = await this.dataSocket(session, reply);
    if (!data) return;
    const names = await readdir(this.opts.storageDir).catch(() => [] as string[]);
    const lines: string[] = [];
    for (const name of names) {
      const st = await stat(this.filePath(name)).catch(() => undefined);
      if (!st?.isFile()) continue;
      lines.push(cmd === "NLST" ? name : listLine(name, st.size, st.mtime));
    }
    await new Promise<void>((resolve) =>
      data.end(lines.map((l) => `${l}\r\n`).join(""), () => resolve()),
    );
    reply("226 Directory send OK.");
  }
}
