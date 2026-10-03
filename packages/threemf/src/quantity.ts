// Sugerencia de cantidad a partir del nombre del archivo, p. ej.
// "oso_x2.gcode.3mf" → 2, "llavero 12u.gcode.3mf" → 12.
// Es solo una sugerencia: el administrador siempre confirma la cantidad.

const EXTENSION_RE = /(\.gcode)?\.3mf$/i;
const TIMES_RE = /(?:^|[^a-z0-9])x\s*(\d{1,3})(?![0-9])/i;
const UNITS_RE =
  /(?:^|[^a-z0-9])(\d{1,3})\s*(?:u|uds?|und|unds|unid|unidades|pcs|pzs|piezas)(?![a-z])/i;

export function suggestQuantityFromFilename(filename: string): number | undefined {
  const base = filename.split(/[\\/]/).pop() ?? filename;
  const stem = base.replace(EXTENSION_RE, "");
  const match = TIMES_RE.exec(stem) ?? UNITS_RE.exec(stem);
  if (!match) return undefined;
  const n = Number(match[1]);
  return Number.isInteger(n) && n >= 1 && n <= 999 ? n : undefined;
}
