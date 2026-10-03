import { describe, expect, it } from "vitest";
import { suggestQuantityFromFilename } from "../src/index.js";

describe("suggestQuantityFromFilename", () => {
  it.each([
    ["oso_x2.gcode.3mf", 2],
    ["oso-x4.gcode.3mf", 4],
    ["oso x 3.gcode.3mf", 3],
    ["Oso X12.gcode.3mf", 12],
    ["llavero 12u.gcode.3mf", 12],
    ["llavero_6uds.gcode.3mf", 6],
    ["maceta 2 piezas.gcode.3mf", 2],
    ["soporte_10pcs.gcode.3mf", 10],
    ["carpeta/oso_x2.gcode.3mf", 2],
    ["oso.gcode.3mf", undefined],
    ["box2.gcode.3mf", undefined],
    ["max3d.gcode.3mf", undefined],
    ["oso_x0.gcode.3mf", undefined],
  ])("%s → %s", (name, expected) => {
    expect(suggestQuantityFromFilename(name)).toBe(expected);
  });
});
