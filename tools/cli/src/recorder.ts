// Graba todo el tráfico MQTT en un archivo JSONL para ajustar el simulador a lo
// que hace la impresora real. Nunca contiene el código de acceso.
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { dirname } from "node:path";
import type { PrinterConnection } from "@blackforge/printer";

export class Recorder {
  private readonly stream: WriteStream;
  readonly path: string;

  constructor(path: string) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
    this.stream = createWriteStream(path, { flags: "a" });
  }

  attach(conn: PrinterConnection): void {
    conn.on("traffic", (t) => {
      let payload: unknown = t.payload;
      try {
        payload = JSON.parse(t.payload);
      } catch {
        // se guarda como texto
      }
      this.write({ at: new Date(t.at).toISOString(), dir: t.direction, topic: t.topic, payload });
    });
    conn.on("status", (s) =>
      this.write({
        at: new Date().toISOString(),
        dir: "status",
        status: s.kind,
        detail: s.kind === "offline" ? s.error.message : undefined,
      }),
    );
  }

  note(event: string, data: Record<string, unknown> = {}): void {
    this.write({ at: new Date().toISOString(), dir: "nota", event, ...data });
  }

  private write(obj: Record<string, unknown>): void {
    this.stream.write(`${JSON.stringify(obj)}\n`);
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.stream.end(() => resolve()));
  }
}
