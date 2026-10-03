// Utilidades de salida en consola (español, colores si la terminal los soporta).
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);

export const c = {
  bold: wrap("1"),
  dim: wrap("2"),
  red: wrap("31"),
  green: wrap("32"),
  yellow: wrap("33"),
  blue: wrap("34"),
  magenta: wrap("35"),
  cyan: wrap("36"),
};

export const ok = (msg: string) => console.log(`${c.green("✓")} ${msg}`);
export const fail = (msg: string) => console.log(`${c.red("✗")} ${msg}`);
export const warn = (msg: string) => console.log(`${c.yellow("!")} ${msg}`);
export const info = (msg: string) => console.log(`${c.cyan("•")} ${msg}`);
export const title = (msg: string) => console.log(`\n${c.bold(msg)}`);

export function duration(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds)) return "—";
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h} h ${m} min`;
  if (m > 0) return `${m} min`;
  return `${s} s`;
}

export function bytes(n: number | undefined): string {
  if (n === undefined) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1).replace(".", ",")} KB`;
  return `${(n / 1024 / 1024).toFixed(2).replace(".", ",")} MB`;
}

export function speed(bps: number | undefined): string {
  return bps === undefined ? "—" : `${bytes(bps)}/s`;
}

/** Número con coma decimal (es-CO). */
export function dec(n: number | undefined, digits = 1): string {
  if (n === undefined || !Number.isFinite(n)) return "—";
  return n.toLocaleString("es-CO", { minimumFractionDigits: 0, maximumFractionDigits: digits });
}

export function progressBar(fraction: number, width = 24): string {
  const f = Math.max(0, Math.min(1, fraction));
  const full = Math.round(f * width);
  return `[${"█".repeat(full)}${"░".repeat(width - full)}] ${String(Math.round(f * 100)).padStart(3)} %`;
}

/** Reescribe la línea actual (para barras de progreso). */
export function inline(text: string): void {
  if (process.stdout.isTTY) process.stdout.write(`\r\x1b[2K${text}`);
}

export function endInline(): void {
  if (process.stdout.isTTY) process.stdout.write("\n");
}

export function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}
