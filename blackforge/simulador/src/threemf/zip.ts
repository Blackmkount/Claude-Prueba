// Acceso mínimo a un ZIP con yauzl: listar entradas y leer una entrada a memoria
// con un límite de tamaño (protección contra archivos ZIP maliciosos o enormes).
import yauzl from "yauzl";

export interface ZipEntryInfo {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
}

export class ZipReadError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ZipReadError";
  }
}

function openZip(path: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true, autoClose: false }, (err, zip) => {
      if (err || !zip) reject(new ZipReadError("No es un archivo ZIP válido", err));
      else resolve(zip);
    });
  });
}

/**
 * Abre el ZIP, recorre el índice y deja leer entradas concretas.
 * El llamador debe invocar `close()` al terminar.
 */
export class ZipReader {
  private constructor(
    private readonly zip: yauzl.ZipFile,
    private readonly entries: Map<string, yauzl.Entry>,
  ) {}

  static async open(path: string): Promise<ZipReader> {
    const zip = await openZip(path);
    const entries = new Map<string, yauzl.Entry>();
    await new Promise<void>((resolve, reject) => {
      zip.on("entry", (entry: yauzl.Entry) => {
        entries.set(entry.fileName, entry);
        zip.readEntry();
      });
      zip.on("end", () => resolve());
      zip.on("error", (err: unknown) =>
        reject(new ZipReadError("El índice del ZIP está dañado", err)),
      );
      zip.readEntry();
    });
    return new ZipReader(zip, entries);
  }

  list(): ZipEntryInfo[] {
    return [...this.entries.values()].map((e) => ({
      name: e.fileName,
      compressedSize: e.compressedSize,
      uncompressedSize: e.uncompressedSize,
    }));
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  /**
   * Lee una entrada completa. Si supera `maxBytes`, se corta en `maxBytes`
   * cuando `truncate` es true (útil para leer solo la cabecera del G-code) o
   * falla en caso contrario.
   */
  async read(name: string, maxBytes: number, truncate = false): Promise<Buffer> {
    const entry = this.entries.get(name);
    if (!entry) throw new ZipReadError(`No existe ${name} dentro del archivo`);
    if (!truncate && entry.uncompressedSize > maxBytes) {
      throw new ZipReadError(`${name} es demasiado grande (${entry.uncompressedSize} bytes)`);
    }
    const stream = await new Promise<NodeJS.ReadableStream>((resolve, reject) => {
      this.zip.openReadStream(entry, (err, s) => {
        if (err || !s) reject(new ZipReadError(`No se pudo leer ${name}`, err));
        else resolve(s);
      });
    });
    const chunks: Buffer[] = [];
    let total = 0;
    return new Promise<Buffer>((resolve, reject) => {
      const readable = stream as NodeJS.ReadableStream & { destroy?: () => void };
      readable.on("data", (chunk: Buffer) => {
        if (total >= maxBytes) return;
        const remaining = maxBytes - total;
        const piece = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
        chunks.push(piece);
        total += piece.length;
        if (total >= maxBytes) {
          if (!truncate) {
            reject(new ZipReadError(`${name} es demasiado grande`));
          }
          readable.destroy?.();
          resolve(Buffer.concat(chunks));
        }
      });
      readable.on("end", () => resolve(Buffer.concat(chunks)));
      readable.on("close", () => resolve(Buffer.concat(chunks)));
      readable.on("error", (err: unknown) => {
        if (total >= maxBytes) resolve(Buffer.concat(chunks));
        else reject(new ZipReadError(`Error leyendo ${name}`, err));
      });
    });
  }

  close(): void {
    this.zip.close();
  }
}
