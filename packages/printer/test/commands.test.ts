import { describe, expect, it } from "vitest";
import {
  buildFileUrl,
  DEFAULT_PRINT_OPTIONS,
  EXTERNAL_SPOOL,
  newTaskId,
  projectFileCommand,
  remoteFileName,
  type ProjectFileParams,
} from "../src/index.js";

const base: ProjectFileParams = {
  plateIndex: 3,
  remoteName: "bf_job42.3mf",
  urlStyle: "ftp",
  displayName: "Oso x2",
  taskId: "123456",
  filament: [2],
  options: DEFAULT_PRINT_OPTIONS,
};

describe("projectFileCommand", () => {
  it("usa la placa real, nuestro ID y QoS de campos de Bambu Studio", () => {
    const cmd = projectFileCommand(base, "77").print;
    expect(cmd).toMatchObject({
      sequence_id: "77",
      command: "project_file",
      param: "Metadata/plate_3.gcode",
      url: "ftp://bf_job42.3mf",
      file: "bf_job42.3mf",
      md5: "",
      bed_type: "auto",
      bed_leveling: false,
      auto_bed_leveling: 2,
      flow_cali: false,
      extrude_cali_flag: 2,
      vibration_cali: true,
      timelapse: false,
      use_ams: true,
      ams_mapping: [2],
      ams_mapping2: [{ ams_id: 0, slot_id: 2 }],
      subtask_name: "Oso x2",
      task_id: "123456",
      subtask_id: "123456",
      project_id: "123456",
      profile_id: "0",
    });
  });

  it("bobina externa: -1 en el arreglo plano, ams_id 255 y use_ams false", () => {
    const cmd = projectFileCommand({ ...base, filament: [EXTERNAL_SPOOL] }).print;
    expect(cmd.use_ams).toBe(false);
    expect(cmd.ams_mapping).toEqual([-1]);
    expect(cmd.ams_mapping2).toEqual([{ ams_id: 255, slot_id: 0 }]);
  });

  it("filamentos no usados van en -1", () => {
    const cmd = projectFileCommand({ ...base, filament: [-1, -1, 1] }).print;
    expect(cmd.ams_mapping).toEqual([-1, -1, 1]);
    expect(cmd.ams_mapping2).toEqual([
      { ams_id: 255, slot_id: 255 },
      { ams_id: 255, slot_id: 255 },
      { ams_id: 0, slot_id: 1 },
    ]);
  });

  it("nivelación forzada", () => {
    const cmd = projectFileCommand({
      ...base,
      options: { ...DEFAULT_PRINT_OPTIONS, bedLeveling: "on" },
    }).print;
    expect(cmd.bed_leveling).toBe(true);
    expect(cmd.auto_bed_leveling).toBe(1);
  });
});

describe("URLs y nombres", () => {
  it.each([
    ["ftp", "ftp://bf_1.3mf"],
    ["sdcard", "file:///sdcard/bf_1.3mf"],
    ["ftp3", "ftp:///bf_1.3mf"],
  ] as const)("%s → %s", (style, url) => {
    expect(buildFileUrl(style, "/bf_1.3mf")).toBe(url);
  });

  it("nombre remoto ASCII y sin espacios", () => {
    expect(remoteFileName("42")).toBe("bf_42.3mf");
    expect(remoteFileName("ñandú x 2/../")).toBe("bf_andx2.3mf");
  });

  it("IDs de tarea dentro de int32 y no cero", () => {
    for (let i = 0; i < 200; i++) {
      const id = Number(newTaskId());
      expect(id).toBeGreaterThan(0);
      expect(id).toBeLessThan(2 ** 31 - 1);
    }
  });
});
