// API HTTP de control del simulador, para pruebas y para provocar situaciones a mano:
//   GET  /impresoras                         lista y estado
//   POST /impresoras/:serie/desconectar      { "ms": 5000 }
//   POST /impresoras/:serie/zombi            { "ms": 90000 }
//   POST /impresoras/:serie/fallar
//   POST /impresoras/:serie/terminar
//   POST /impresoras/:serie/microsd          { "presente": false }
//   POST /impresoras/:serie/modo-desarrollador { "activo": false }
//   POST /impresoras/:serie/filamento        { "ams": [...], "externa": {...} }
//   POST /impresoras/:serie/mañas            { "noTransferComplete": true, ... }
//   POST /impresoras/:serie/impresion-externa { "ms": 10000 }
//   POST /impresoras/:serie/reiniciar-estado
import http from "node:http";
import type { Fleet } from "./fleet.js";

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function startControlServer(
  fleet: Fleet,
  port: number,
  host = "127.0.0.1",
): Promise<http.Server> {
  const server = http.createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(body, null, 2));
    };
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      if (req.method === "GET" && parts[0] === "impresoras" && parts.length === 1) {
        const list = await Promise.all(
          fleet.printers.map(async (p) => ({
            ...fleet.describe().find((d) => d.serial === p.serial),
            estado: p.gcodeState,
            porcentaje: p.rawState.mc_percent,
            archivos: await p.listFiles(),
          })),
        );
        send(200, list);
        return;
      }
      if (req.method !== "POST" || parts[0] !== "impresoras" || parts.length !== 3) {
        send(404, { error: "Ruta desconocida" });
        return;
      }
      const printer = fleet.get(parts[1]!);
      if (!printer) {
        send(404, { error: "Impresora no encontrada" });
        return;
      }
      const body = await readJson(req);
      const ms = typeof body.ms === "number" ? body.ms : undefined;
      switch (parts[2]) {
        case "desconectar":
          printer.disconnect(ms ?? 5_000);
          break;
        case "zombi":
          printer.zombie(ms ?? 90_000);
          break;
        case "fallar":
          if (!printer.failPrint()) return send(409, { error: "No está imprimiendo" });
          break;
        case "terminar":
          if (!printer.finishNow()) return send(409, { error: "No está imprimiendo" });
          break;
        case "microsd":
          printer.setSdCard(body.presente !== false);
          break;
        case "modo-desarrollador":
          printer.setDevMode(body.activo !== false);
          break;
        case "filamento":
          printer.setFilament(body.ams as never, body.externa as never);
          break;
        case "mañas":
        case "manas":
          printer.setQuirks(body);
          break;
        case "impresion-externa":
          await printer.startExternalPrint(ms ?? 10_000);
          break;
        case "reiniciar-estado":
          printer.resetToIdle();
          break;
        default:
          send(404, { error: "Acción desconocida" });
          return;
      }
      send(200, { ok: true, estado: printer.gcodeState });
    } catch (err) {
      send(500, { error: (err as Error).message });
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}
