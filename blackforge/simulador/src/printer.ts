// Una impresora A1 simulada: broker MQTT con TLS (aedes) + FTPS falso + máquina
// de estados de impresión acelerada. Publica estado PARCIAL (solo lo que cambió),
// como la A1 real, y responde a pushall, get_version, project_file, pause,
// resume y stop. Ver docs/protocolo-a1.md.
import { mkdir } from "node:fs/promises";
import type net from "node:net";
import tls from "node:tls";
import { readSlicedFile } from "./threemf/index.js";
import { Aedes } from "aedes";
import { dropOutgoing } from "./ack-filter.js";
import type { KeyPairPem } from "./certs.js";
import { FakeFtpsServer, type FtpsQuirks } from "./ftps-server.js";

export interface SimTray {
  type: string;
  /** RRGGBB */
  color: string;
  remain?: number;
}

export type UrlStyleName = "ftp" | "sdcard" | "ftp3";

export interface SimQuirks extends FtpsQuirks {
  /** Modo desarrollador apagado: exige firma, ignora comandos de control. */
  devModeOff?: boolean;
  /** Formatos de URL que acepta project_file (por defecto todos). */
  acceptedUrlStyles?: UrlStyleName[];
  /** Si la impresora repite nuestro task_id en su estado (por defecto sí). */
  echoTaskId?: boolean;
  /** El broker no envía PUBACK (como se vio en la A1 real). Se aplica a conexiones nuevas. */
  noPubAck?: boolean;
}

export interface SimTiming {
  /** Duración de la preparación (nivelación, calentamiento). */
  prepareMs: number;
  /** Duración fija de la impresión; si no se da, se usa la predicción / speedFactor. */
  printMs?: number;
  /** Aceleración: 60 = una hora de impresión dura un minuto. */
  speedFactor: number;
  minPrintMs: number;
  /** Cada cuánto avanza la simulación. */
  tickMs: number;
  /** Cada cuánto envía algo estando quieta (0 = silencio total). */
  idleReportMs: number;
}

export interface SimPrinterConfig {
  serial: string;
  accessCode: string;
  name?: string;
  host?: string;
  mqttPort: number;
  ftpsPort: number;
  modelId?: "N2S" | "N1";
  firmware?: string;
  /** null = sin AMS lite; si no, 4 bandejas (null = vacía). */
  ams?: Array<SimTray | null> | null;
  externalSpool?: SimTray | null;
  nozzleDiameter?: number;
  timing?: Partial<SimTiming>;
  quirks?: SimQuirks;
  storageDir: string;
  cert: KeyPairPem;
  log?: (msg: string) => void;
}

export interface ReceivedCommand {
  at: number;
  type: string;
  command: string;
  body: Record<string, unknown>;
}

const DEFAULT_TIMING: SimTiming = {
  prepareMs: 3_000,
  speedFactor: 60,
  minPrintMs: 5_000,
  tickMs: 1_000,
  idleReportMs: 10_000,
};

const FUN_DEV_MODE_ON = "3EC18FFF9CFF";
const FUN_DEV_MODE_OFF = "3EC1AFFF9CFF";
const HOME_FLAG_BASE = 0x00000007 | 0x00000400; // ejes en home + auto-cambio AMS
const SD_PRESENT = 0x100;

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function equal(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

interface ActiveJob {
  file: string;
  displayName: string;
  taskId: string;
  totalLayers: number;
  predictionSeconds: number;
  durationMs: number;
  elapsedMs: number;
  phase: "prepare" | "print";
  prepareElapsedMs: number;
  nozzleTarget: number;
  bedTarget: number;
}

export class SimulatedPrinter {
  readonly config: SimPrinterConfig;
  readonly timing: SimTiming;
  quirks: SimQuirks;
  readonly received: ReceivedCommand[] = [];
  private state: Record<string, unknown> = {};
  private published: Record<string, unknown> = {};
  private broker?: Aedes;
  private mqttServer?: tls.Server;
  private readonly mqttSockets = new Set<net.Socket>();
  private readonly ftps: FakeFtpsServer;
  private ticker?: NodeJS.Timeout;
  private idleTimer?: NodeJS.Timeout;
  private job?: ActiveJob;
  private seq = 0;
  private refuseUntil = 0;
  private zombieUntil = 0;
  private running = false;

  constructor(config: SimPrinterConfig) {
    this.config = config;
    this.timing = { ...DEFAULT_TIMING, ...config.timing };
    this.quirks = { echoTaskId: true, ...config.quirks };
    this.state = this.initialState();
    this.ftps = new FakeFtpsServer({
      host: config.host ?? "127.0.0.1",
      port: config.ftpsPort,
      accessCode: config.accessCode,
      cert: config.cert,
      storageDir: config.storageDir,
      quirks: () => this.quirks,
      log: config.log,
    });
  }

  get serial(): string {
    return this.config.serial;
  }
  get rawState(): Readonly<Record<string, unknown>> {
    return this.state;
  }
  get gcodeState(): string {
    return String(this.state.gcode_state);
  }
  get topicReport(): string {
    return `device/${this.serial}/report`;
  }
  get topicRequest(): string {
    return `device/${this.serial}/request`;
  }

  private initialState(): Record<string, unknown> {
    const c = this.config;
    const ams =
      c.ams === undefined
        ? [{ type: "PLA", color: "FFFFFF" }, { type: "PLA", color: "000000" }, null, null]
        : c.ams;
    const external =
      c.externalSpool === undefined ? { type: "PLA", color: "FFFFFF" } : c.externalSpool;
    const state: Record<string, unknown> = {
      upgrade_state: {
        sequence_id: 0,
        progress: "",
        status: "IDLE",
        consistency_request: false,
        dis_state: 0,
        err_code: 0,
        force_upgrade: false,
        message: "0%, 0B/s",
        module: "",
        new_version_state: 2,
        new_ver_list: [],
      },
      ipcam: {
        ipcam_dev: "1",
        ipcam_record: "disable",
        timelapse: "disable",
        resolution: "1080p",
        tutk_server: "disable",
        mode_bits: 3,
      },
      xcam: { buildplate_marker_detector: true },
      upload: { status: "idle", progress: 0, message: "" },
      net: { conf: 0, info: [{ ip: 16777343, mask: 16777215 }] },
      nozzle_temper: 25,
      nozzle_target_temper: 0,
      bed_temper: 25,
      bed_target_temper: 0,
      chamber_temper: 5,
      mc_print_stage: "1",
      heatbreak_fan_speed: "0",
      cooling_fan_speed: "0",
      big_fan1_speed: "0",
      big_fan2_speed: "0",
      mc_percent: 0,
      mc_remaining_time: 0,
      ams_status: 0,
      ams_rfid_status: 0,
      hw_switch_state: 0,
      spd_mag: 100,
      spd_lvl: 2,
      print_error: 0,
      lifecycle: "product",
      wifi_signal: "-48dBm",
      gcode_state: "IDLE",
      gcode_file_prepare_percent: "0",
      queue_number: 0,
      project_id: "0",
      profile_id: "0",
      task_id: "0",
      subtask_id: "0",
      subtask_name: "",
      gcode_file: "",
      stg: [],
      stg_cur: 0,
      print_type: "idle",
      home_flag: HOME_FLAG_BASE | (this.quirks.noSdCard ? 0 : SD_PRESENT),
      mc_print_line_number: "0",
      mc_print_sub_stage: 0,
      sdcard: !this.quirks.noSdCard,
      force_upgrade: false,
      mess_production_state: "active",
      layer_num: 0,
      total_layer_num: 0,
      s_obj: [],
      filam_bak: [],
      fan_gear: 0,
      nozzle_diameter: String(c.nozzleDiameter ?? 0.4),
      nozzle_type: "stainless_steel",
      fun: this.quirks.devModeOff ? FUN_DEV_MODE_OFF : FUN_DEV_MODE_ON,
      hms: [],
      online: { ahb: false, rfid: false, version: 1804806695 },
      vt_tray: this.trayJson(254, external),
      lights_report: [{ node: "chamber_light", mode: "off" }],
    };
    if (ams) state.ams = this.amsJson(ams);
    return state;
  }

  private trayJson(id: number, tray: SimTray | null | undefined): Record<string, unknown> {
    if (!tray)
      return {
        id: String(id),
        tray_type: "",
        tray_color: "00000000",
        tray_info_idx: "",
        remain: 0,
      };
    return {
      id: String(id),
      tag_uid: "0000000000000000",
      tray_id_name: "",
      tray_info_idx: tray.type.toUpperCase().startsWith("PETG") ? "GFG00" : "GFA00",
      tray_type: tray.type,
      tray_sub_brands: "",
      tray_color: `${tray.color.replace("#", "").toUpperCase()}FF`,
      tray_weight: "1000",
      tray_diameter: "1.75",
      nozzle_temp_max: "240",
      nozzle_temp_min: "190",
      remain: tray.remain ?? 100,
      cols: [`${tray.color.replace("#", "").toUpperCase()}FF`],
    };
  }

  private amsJson(trays: Array<SimTray | null>): Record<string, unknown> {
    let bits = 0;
    trays.forEach((t, i) => {
      if (t) bits |= 1 << i;
    });
    return {
      ams: [
        {
          id: "0",
          humidity: "5",
          temp: "0.0",
          tray: trays.slice(0, 4).map((t, i) => (t ? this.trayJson(i, t) : { id: String(i) })),
        },
      ],
      ams_exist_bits: "1",
      tray_exist_bits: bits.toString(16),
      tray_is_bbl_bits: bits.toString(16),
      tray_read_done_bits: bits.toString(16),
      tray_reading_bits: "0",
      tray_now: "255",
      tray_pre: "255",
      tray_tar: "255",
      version: 4,
      insert_flag: true,
      power_on_flag: false,
    };
  }

  // -------------------------------------------------------------------------
  // Ciclo de vida

  async start(): Promise<void> {
    if (this.running) return;
    await mkdir(this.config.storageDir, { recursive: true });
    const broker = await Aedes.createBroker();
    broker.authenticate = (_client, username, password, done) => {
      const ok = username === "bblp" && password?.toString() === this.config.accessCode;
      if (ok) {
        done(null, true);
      } else {
        const err = Object.assign(new Error("Bad user name or password"), { returnCode: 4 });
        done(err as Parameters<typeof done>[0], false);
      }
    };
    broker.authorizePublish = (client, packet, done) => {
      if (!client || packet.topic === this.topicRequest) done(null);
      else done(new Error("Solo se permite publicar en el topic de request"));
    };
    broker.on("publish", (packet, client) => {
      if (!client || packet.topic !== this.topicRequest) return;
      this.onRequest(packet.payload.toString());
    });
    this.broker = broker;

    const server = tls.createServer(
      {
        key: this.config.cert.keyPem,
        cert: this.config.cert.certPem,
        minVersion: "TLSv1.2",
        maxVersion: "TLSv1.2",
      },
      (socket) => {
        if (Date.now() < this.refuseUntil) {
          socket.destroy();
          return;
        }
        this.mqttSockets.add(socket);
        socket.on("close", () => this.mqttSockets.delete(socket));
        socket.on("error", () => {});
        if (this.quirks.noPubAck) {
          broker.handle(dropOutgoing(socket, (cmd) => cmd === "puback" && !!this.quirks.noPubAck));
        } else {
          broker.handle(socket);
        }
      },
    );
    server.on("tlsClientError", () => {});
    this.mqttServer = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.config.mqttPort, this.config.host ?? "127.0.0.1", () => resolve());
    });
    await this.ftps.start();
    this.published = clone(this.state);
    this.running = true;
    this.ticker = setInterval(() => this.tick(), this.timing.tickMs);
    this.armIdleReport();
  }

  async stop(): Promise<void> {
    this.running = false;
    clearInterval(this.ticker);
    clearTimeout(this.idleTimer);
    for (const s of this.mqttSockets) s.destroy();
    this.mqttSockets.clear();
    const server = this.mqttServer;
    this.mqttServer = undefined;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    const broker = this.broker;
    this.broker = undefined;
    if (broker) await new Promise<void>((resolve) => broker.close(() => resolve()));
    await this.ftps.stop();
  }

  // -------------------------------------------------------------------------
  // Publicación

  private publish(message: Record<string, unknown>): void {
    const broker = this.broker;
    if (!broker || Date.now() < this.zombieUntil) return;
    broker.publish(
      {
        cmd: "publish",
        topic: this.topicReport,
        payload: Buffer.from(JSON.stringify(message)),
        qos: 0,
        dup: false,
        retain: false,
      },
      () => {},
    );
  }

  private nextSeq(): string {
    this.seq += 1;
    return String(this.seq);
  }

  /** Publica solo los campos de primer nivel que cambiaron (como la A1). */
  commit(): void {
    const changed: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(this.state)) {
      if (!equal(value, this.published[key])) changed[key] = clone(value);
    }
    if (Object.keys(changed).length === 0) return;
    this.published = clone(this.state);
    this.publish({
      print: { ...changed, command: "push_status", msg: 1, sequence_id: this.nextSeq() },
    });
  }

  private publishFull(): void {
    this.published = clone(this.state);
    this.publish({
      print: { ...clone(this.state), command: "push_status", msg: 0, sequence_id: this.nextSeq() },
    });
  }

  private ack(
    type: string,
    body: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ): void {
    this.publish({
      [type]: { ...body, ...extra, result: extra.result ?? "success", reason: extra.reason ?? "" },
    });
  }

  private armIdleReport(): void {
    clearTimeout(this.idleTimer);
    if (!this.running || this.timing.idleReportMs <= 0) return;
    this.idleTimer = setTimeout(() => {
      if (!this.job) {
        const wifi = -45 - Math.floor(Math.random() * 8);
        this.state.wifi_signal = `${wifi}dBm`;
        this.commit();
      }
      this.armIdleReport();
    }, this.timing.idleReportMs);
  }

  // -------------------------------------------------------------------------
  // Comandos

  private onRequest(payload: string): void {
    if (Date.now() < this.zombieUntil) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      return;
    }
    for (const [type, section] of Object.entries(msg)) {
      if (typeof section !== "object" || section === null) continue;
      const body = section as Record<string, unknown>;
      const command = String(body.command ?? "");
      this.received.push({ at: Date.now(), type, command, body });
      this.config.log?.(`${this.serial} MQTT < ${type}.${command}`);
      void this.handleCommand(type, command, body);
    }
  }

  private async handleCommand(
    type: string,
    command: string,
    body: Record<string, unknown>,
  ): Promise<void> {
    if (type === "pushing" && command === "pushall") {
      this.publishFull();
      return;
    }
    if (type === "info" && command === "get_version") {
      this.ack("info", { command, sequence_id: body.sequence_id }, {
        module: this.versionModules(),
      } as Record<string, unknown>);
      return;
    }
    if (type !== "print") {
      this.ack(type, { command, sequence_id: body.sequence_id });
      return;
    }
    // Sin modo desarrollador, la A1 ignora en silencio los comandos de control.
    if (
      this.quirks.devModeOff &&
      ["project_file", "pause", "resume", "stop", "gcode_line"].includes(command)
    ) {
      this.state.hms = [{ attr: 0x05000500, code: 0x00010007 }];
      this.commit();
      return;
    }
    switch (command) {
      case "project_file":
        await this.projectFile(body);
        return;
      case "pause":
        this.ack("print", { command, sequence_id: body.sequence_id, param: "" });
        if (this.gcodeState === "RUNNING" || this.gcodeState === "PREPARE") {
          this.state.gcode_state = "PAUSE";
          this.commit();
        }
        return;
      case "resume":
        this.ack("print", { command, sequence_id: body.sequence_id, param: "" });
        if (this.gcodeState === "PAUSE") {
          this.state.gcode_state = this.job?.phase === "prepare" ? "PREPARE" : "RUNNING";
          this.commit();
        }
        return;
      case "stop":
        this.ack("print", { command, sequence_id: body.sequence_id, param: "" });
        if (this.job) this.endJob("FAILED", 0x0300400c, []);
        return;
      default:
        this.ack("print", { command, sequence_id: body.sequence_id });
    }
  }

  private versionModules(): Array<Record<string, unknown>> {
    const project = this.config.modelId ?? "N2S";
    const modules: Array<Record<string, unknown>> = [
      {
        name: "ota",
        project_name: project,
        sw_ver: this.config.firmware ?? "01.08.01.00",
        hw_ver: "OTA",
        sn: this.serial,
        flag: 3,
      },
      {
        name: "esp32",
        project_name: project,
        sw_ver: "01.13.33.99",
        hw_ver: "AP05",
        sn: "SIMULADO",
        flag: 0,
      },
      {
        name: "mc",
        project_name: project,
        sw_ver: "00.01.29.83",
        hw_ver: "MC02",
        sn: "SIMULADO",
        flag: 0,
      },
      {
        name: "th",
        project_name: project,
        sw_ver: "00.00.07.69",
        hw_ver: "TH01",
        sn: "SIMULADO",
        flag: 0,
      },
    ];
    if (this.state.ams)
      modules.push({
        name: "ams_f1/0",
        project_name: "",
        sw_ver: "00.00.07.94",
        hw_ver: "AMS_F102",
        sn: `${this.serial}-AMS0`,
        flag: 0,
      });
    return modules;
  }

  private resolveFile(body: Record<string, unknown>): string | undefined {
    const url = String(body.url ?? "");
    const accepted = this.quirks.acceptedUrlStyles ?? ["ftp", "sdcard", "ftp3"];
    let m: RegExpExecArray | null;
    if ((m = /^ftp:\/\/\/(.+)$/.exec(url))) return accepted.includes("ftp3") ? m[1] : undefined;
    if ((m = /^ftp:\/\/(.+)$/.exec(url))) return accepted.includes("ftp") ? m[1] : undefined;
    if ((m = /^file:\/\/\/sdcard\/(.+)$/.exec(url)))
      return accepted.includes("sdcard") ? m[1] : undefined;
    return undefined;
  }

  private async projectFile(body: Record<string, unknown>): Promise<void> {
    this.ack("print", {
      command: "project_file",
      sequence_id: body.sequence_id,
      param: body.param,
      url: body.url,
      subtask_name: body.subtask_name,
    });
    if (this.job || ["PREPARE", "RUNNING", "PAUSE", "SLICING"].includes(this.gcodeState)) {
      // Ocupada: rechazo 0500_4004 (en la A1 mini real, además cancela lo que imprime).
      this.state.hms = [{ attr: 0x05000400, code: 0x00024004 }];
      this.commit();
      setTimeout(() => {
        this.state.hms = [];
        this.commit();
      }, 3_000);
      return;
    }
    const name = this.resolveFile(body);
    const files = await this.ftps.listFiles();
    const file = name ? files.find((f) => f.name === name) : undefined;
    const plateMatch = /plate_(\d+)\.gcode$/.exec(String(body.param ?? ""));
    if (!file || !plateMatch) {
      // Archivo no encontrado o URL no aceptada: la impresora no arranca.
      this.state.gcode_state = "FAILED";
      this.state.print_error = 0x0500c010;
      this.state.hms = [{ attr: 0x0500c000, code: 0x00020010 }];
      this.commit();
      return;
    }
    let totalLayers = 100;
    let predictionSeconds = 1800;
    try {
      const info = await readSlicedFile(this.ftps.filePath(file.name));
      const plate = info.plates.find((p) => p.index === Number(plateMatch[1])) ?? info.plates[0];
      totalLayers = plate?.totalLayers ?? totalLayers;
      predictionSeconds = plate?.predictionSeconds ?? predictionSeconds;
    } catch {
      // archivo no legible: se imprime con valores por defecto
    }
    const durationMs =
      this.timing.printMs ??
      Math.max(this.timing.minPrintMs, (predictionSeconds * 1000) / this.timing.speedFactor);
    const taskId = String(body.task_id ?? "0");
    this.job = {
      file: file.name,
      displayName: String(body.subtask_name ?? file.name),
      taskId,
      totalLayers,
      predictionSeconds,
      durationMs,
      elapsedMs: 0,
      phase: "prepare",
      prepareElapsedMs: 0,
      nozzleTarget: 220,
      bedTarget: 65,
    };
    const echo = this.quirks.echoTaskId !== false;
    Object.assign(this.state, {
      gcode_state: "PREPARE",
      print_error: 0,
      hms: [],
      gcode_file: file.name,
      subtask_name: this.job.displayName,
      task_id: echo ? taskId : "0",
      subtask_id: echo ? taskId : "0",
      project_id: echo ? taskId : "0",
      print_type: "local",
      mc_percent: 0,
      layer_num: 0,
      total_layer_num: totalLayers,
      mc_remaining_time: Math.ceil(predictionSeconds / 60),
      gcode_file_prepare_percent: "0",
      stg: [2, 1, 7],
      stg_cur: 2,
      nozzle_target_temper: 150,
      bed_target_temper: this.job.bedTarget,
    });
    if (this.state.ams && Array.isArray(body.ams_mapping) && body.use_ams) {
      const first = (body.ams_mapping as number[]).find((t) => t >= 0);
      if (first !== undefined) (this.state.ams as Record<string, unknown>).tray_now = String(first);
    }
    this.commit();
  }

  private tick(): void {
    const job = this.job;
    const s = this.state;
    const approach = (key: string, target: number, rate: number) => {
      const cur = Number(s[key]);
      const next = Math.abs(target - cur) < rate ? target : cur + Math.sign(target - cur) * rate;
      s[key] = Math.round(next * 10) / 10;
    };
    if (job && s.gcode_state === "PREPARE") {
      job.prepareElapsedMs += this.timing.tickMs;
      const p = Math.min(1, job.prepareElapsedMs / this.timing.prepareMs);
      s.gcode_file_prepare_percent = String(Math.round(p * 100));
      s.stg_cur = p < 0.4 ? 2 : p < 0.8 ? 1 : 7;
      approach("bed_temper", job.bedTarget, 8);
      approach("nozzle_temper", 150, 30);
      if (p >= 1) {
        job.phase = "print";
        s.gcode_state = "RUNNING";
        s.stg_cur = 0;
        s.nozzle_target_temper = job.nozzleTarget;
        s.mc_print_stage = "2";
      }
      this.commit();
      return;
    }
    if (job && s.gcode_state === "RUNNING") {
      job.elapsedMs += this.timing.tickMs;
      const p = Math.min(1, job.elapsedMs / job.durationMs);
      s.mc_percent = Math.floor(p * 100);
      s.layer_num = Math.max(1, Math.ceil(p * job.totalLayers));
      s.mc_remaining_time = Math.max(0, Math.ceil((job.predictionSeconds * (1 - p)) / 60));
      approach("nozzle_temper", job.nozzleTarget, 40);
      approach("bed_temper", job.bedTarget, 8);
      s.cooling_fan_speed = "15";
      if (p >= 1) {
        this.endJob("FINISH", 0, []);
        return;
      }
      this.commit();
      return;
    }
    if (!job && (Number(s.nozzle_temper) > 26 || Number(s.bed_temper) > 26)) {
      approach("nozzle_temper", 25, 15);
      approach("bed_temper", 25, 3);
      this.commit();
    }
  }

  private endJob(
    finalState: "FINISH" | "FAILED",
    printError: number,
    hms: Array<{ attr: number; code: number }>,
  ): void {
    this.job = undefined;
    Object.assign(this.state, {
      gcode_state: finalState,
      print_error: printError,
      hms,
      mc_percent: finalState === "FINISH" ? 100 : this.state.mc_percent,
      mc_remaining_time: 0,
      nozzle_target_temper: 0,
      bed_target_temper: 0,
      stg_cur: finalState === "FINISH" ? 255 : 0,
      mc_print_stage: "1",
      cooling_fan_speed: "0",
    });
    if (this.state.ams) (this.state.ams as Record<string, unknown>).tray_now = "255";
    this.commit();
  }

  // -------------------------------------------------------------------------
  // Controles para pruebas

  /** Corta las conexiones y rechaza nuevas durante `ms`. */
  disconnect(ms: number): void {
    this.refuseUntil = Date.now() + ms;
    for (const s of this.mqttSockets) s.destroy();
    this.mqttSockets.clear();
    this.ftps.dropConnections();
  }

  /** La conexión sigue abierta pero la impresora no publica ni responde durante `ms`. */
  zombie(ms: number): void {
    this.zombieUntil = Date.now() + ms;
  }

  /** Hace fallar la impresión en curso con un error HMS. */
  failPrint(hms = { attr: 0x07000100, code: 0x00028011 }, printError = 0x07008011): boolean {
    if (!this.job) return false;
    this.endJob("FAILED", printError, [hms]);
    return true;
  }

  /** Termina la impresión en curso ya. */
  finishNow(): boolean {
    if (!this.job) return false;
    if (this.state.gcode_state === "PREPARE") {
      this.job.phase = "print";
      this.state.gcode_state = "RUNNING";
    }
    this.job.elapsedMs = this.job.durationMs;
    this.tick();
    return true;
  }

  setFilament(ams: Array<SimTray | null> | null | undefined, external?: SimTray | null): void {
    if (ams !== undefined) {
      if (ams === null) delete this.state.ams;
      else this.state.ams = this.amsJson(ams);
    }
    if (external !== undefined) this.state.vt_tray = this.trayJson(254, external);
    this.commit();
  }

  setSdCard(present: boolean): void {
    this.quirks.noSdCard = !present;
    this.state.sdcard = present;
    this.state.home_flag = HOME_FLAG_BASE | (present ? SD_PRESENT : 0);
    this.commit();
  }

  setDevMode(on: boolean): void {
    this.quirks.devModeOff = !on;
    this.state.fun = on ? FUN_DEV_MODE_ON : FUN_DEV_MODE_OFF;
    if (on) this.state.hms = [];
    this.commit();
  }

  setQuirks(quirks: Partial<SimQuirks>): void {
    this.quirks = { ...this.quirks, ...quirks };
  }

  /** Vuelve a IDLE (como cuando alguien inicia otra cosa o reinicia la impresora). */
  resetToIdle(): void {
    this.job = undefined;
    Object.assign(this.state, {
      gcode_state: "IDLE",
      print_error: 0,
      hms: [],
      mc_percent: 0,
      mc_remaining_time: 0,
      layer_num: 0,
    });
    this.commit();
  }

  /** Simula que alguien inicia una impresión desde la pantalla de la impresora. */
  async startExternalPrint(durationMs = 10_000): Promise<void> {
    this.job = {
      file: "externo.3mf",
      displayName: "Impresión desde la pantalla",
      taskId: "0",
      totalLayers: 50,
      predictionSeconds: 600,
      durationMs,
      elapsedMs: 0,
      phase: "print",
      prepareElapsedMs: 0,
      nozzleTarget: 220,
      bedTarget: 60,
    };
    Object.assign(this.state, {
      gcode_state: "RUNNING",
      subtask_name: this.job.displayName,
      task_id: "0",
      subtask_id: "0",
      print_error: 0,
      hms: [],
    });
    this.commit();
  }

  listFiles(): Promise<Array<{ name: string; size: number }>> {
    return this.ftps.listFiles();
  }
}
