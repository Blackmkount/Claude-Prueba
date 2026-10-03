// Conexión MQTT con una impresora.
//
// - Una conexión por impresora, independiente de las demás.
// - Reconexión automática con espera creciente (1 s → 60 s, con variación aleatoria).
// - Estado acumulado: fusiona los reportes parciales de la A1.
// - `pushall` al conectar y como máximo cada 5 min (tras una reconexión se
//   permite si pasó al menos 1 min, para no mostrar un estado viejo).
// - Vigilante: si pasan 60 s sin mensajes se pregunta `get_version`; si no
//   responde en 10 s, se fuerza la reconexión (conexión "zombi").
import { EventEmitter } from "node:events";
import mqtt, { type IClientOptions, type MqttClient } from "mqtt";
import { getVersionCommand, nextSequenceId, pushAllCommand } from "./commands.js";
import { fromNetworkError, PrinterError } from "./errors.js";
import { silentLogger, type Logger } from "./logger.js";
import { mergeReport, toSnapshot, type PrinterSnapshot, type RawPrintState } from "./state.js";
import { DEFAULT_TLS, tlsOptionsFor, type TlsSettings } from "./tls.js";

export interface PrinterEndpoint {
  host: string;
  serial: string;
  accessCode: string;
  mqttPort?: number;
  ftpsPort?: number;
  tls?: TlsSettings;
}

export interface ConnectionOptions {
  logger?: Logger;
  connectTimeoutMs?: number;
  backoffMinMs?: number;
  backoffMaxMs?: number;
  silenceMs?: number;
  probeTimeoutMs?: number;
  pushAllMinIntervalMs?: number;
  pushAllAfterReconnectMinMs?: number;
  clientIdPrefix?: string;
}

export type ConnectionStatus =
  | { kind: "idle" }
  | { kind: "connecting"; attempt: number }
  | { kind: "online"; since: number }
  | { kind: "offline"; error: PrinterError; retryAt: number; attempt: number };

export interface CommandAck {
  /** Sección del mensaje: print, info, pushing, system… */
  type: string;
  command: string;
  sequenceId?: string;
  result?: string;
  reason?: string;
  body: Record<string, unknown>;
}

export interface VersionInfo {
  modules: Array<{
    name: string;
    projectName?: string;
    swVer?: string;
    hwVer?: string;
    sn?: string;
  }>;
  /** N2S = A1, N1 = A1 mini. */
  projectName?: string;
  firmware?: string;
}

interface PendingRequest {
  key: string;
  type: string;
  command: string;
  sequenceId: string;
  resolve: (ack: CommandAck) => void;
  reject: (err: PrinterError) => void;
  timer: NodeJS.Timeout;
}

export interface PrinterConnectionEvents {
  status: [ConnectionStatus];
  snapshot: [PrinterSnapshot, RawPrintState];
  ack: [CommandAck];
  /** Todo mensaje que entra o sale (para grabar capturas). Nunca incluye el código de acceso. */
  traffic: [{ direction: "in" | "out"; topic: string; payload: string; at: number }];
}

let instanceCounter = 0;

/**
 * Un reporte completo (respuesta a pushall) trae `msg: 0` o, al menos, el estado
 * de impresión junto con muchos otros campos. Los parciales traen pocos campos.
 */
export function isFullReport(print: Record<string, unknown>): boolean {
  if (print.msg === 0) return true;
  return "gcode_state" in print && Object.keys(print).length >= 20;
}

export class PrinterConnection extends EventEmitter<PrinterConnectionEvents> {
  readonly endpoint: PrinterEndpoint;
  private readonly opts: Required<Omit<ConnectionOptions, "logger">>;
  private readonly log: Logger;
  private client?: MqttClient;
  private raw: RawPrintState = {};
  private snap: PrinterSnapshot = toSnapshot({});
  private _status: ConnectionStatus = { kind: "idle" };
  private attempt = 0;
  private stopped = true;
  private reconnectTimer?: NodeJS.Timeout;
  private silenceTimer?: NodeJS.Timeout;
  private pushAllTimer?: NodeJS.Timeout;
  private probing = false;
  private lastMessageAt = 0;
  private lastFullStateAt = 0;
  private onlineSince = 0;
  private lastPushAllAt = 0;
  private hasConnectedBefore = false;
  private readonly pending = new Map<string, PendingRequest>();

  constructor(endpoint: PrinterEndpoint, options: ConnectionOptions = {}) {
    super();
    this.endpoint = endpoint;
    this.log = options.logger ?? silentLogger;
    this.opts = {
      connectTimeoutMs: options.connectTimeoutMs ?? 10_000,
      backoffMinMs: options.backoffMinMs ?? 1_000,
      backoffMaxMs: options.backoffMaxMs ?? 60_000,
      silenceMs: options.silenceMs ?? 60_000,
      probeTimeoutMs: options.probeTimeoutMs ?? 10_000,
      pushAllMinIntervalMs: options.pushAllMinIntervalMs ?? 5 * 60_000,
      pushAllAfterReconnectMinMs: options.pushAllAfterReconnectMinMs ?? 60_000,
      clientIdPrefix: options.clientIdPrefix ?? "blackforge",
    };
  }

  get status(): ConnectionStatus {
    return this._status;
  }
  get online(): boolean {
    return this._status.kind === "online";
  }
  get snapshot(): PrinterSnapshot {
    return this.snap;
  }
  get rawState(): RawPrintState {
    return this.raw;
  }
  /** Milisegundos desde el último mensaje recibido (Infinity si nunca). */
  get silenceForMs(): number {
    return this.lastMessageAt ? Date.now() - this.lastMessageAt : Number.POSITIVE_INFINITY;
  }
  /** Ya se recibió al menos un reporte de estado completo o parcial con gcode_state. */
  get hasState(): boolean {
    return this.snap.gcodeState !== "UNKNOWN";
  }
  /**
   * El estado es confiable: hay conexión y llegó un reporte COMPLETO después de
   * la última (re)conexión. Mientras la conexión siga viva no se pierden cambios
   * (TCP); tras un corte, solo un reporte completo garantiza que nada quedó viejo.
   */
  get stateValid(): boolean {
    return this.online && this.hasState && this.lastFullStateAt >= this.onlineSince;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.silenceTimer);
    clearTimeout(this.pushAllTimer);
    this.rejectAllPending(new PrinterError("not_connected", "La conexión se cerró."));
    const client = this.client;
    this.client = undefined;
    if (client) await client.endAsync(true).catch(() => {});
    this.setStatus({ kind: "idle" });
  }

  private setStatus(status: ConnectionStatus): void {
    this._status = status;
    this.emit("status", status);
  }

  private topicReport(): string {
    return `device/${this.endpoint.serial}/report`;
  }
  private topicRequest(): string {
    return `device/${this.endpoint.serial}/request`;
  }

  private connect(): void {
    if (this.stopped) return;
    this.attempt += 1;
    this.setStatus({ kind: "connecting", attempt: this.attempt });
    instanceCounter += 1;
    const clientId = `${this.opts.clientIdPrefix}_${this.endpoint.serial}_${process.pid}_${instanceCounter}`;
    const tlsOpts = tlsOptionsFor(this.endpoint.serial, this.endpoint.tls ?? DEFAULT_TLS);
    const client = mqtt.connect({
      protocol: "mqtts",
      host: this.endpoint.host,
      port: this.endpoint.mqttPort ?? 8883,
      username: "bblp",
      password: this.endpoint.accessCode,
      clientId,
      protocolVersion: 4,
      keepalive: 30,
      clean: true,
      reconnectPeriod: 0, // la reconexión la manejamos nosotros, con espera creciente
      connectTimeout: this.opts.connectTimeoutMs,
      // mqtt.js pasa estas opciones a tls.connect.
      ca: tlsOpts.ca as string,
      servername: tlsOpts.servername,
      rejectUnauthorized: tlsOpts.rejectUnauthorized,
      minVersion: tlsOpts.minVersion,
      maxVersion: tlsOpts.maxVersion,
    } as IClientOptions);
    this.client = client;
    let failed = false;

    const fail = (err: unknown) => {
      if (failed || this.client !== client) return;
      failed = true;
      const error = this.classify(err);
      this.log.warn(
        { serial: this.endpoint.serial, code: error.code, err: error.message },
        "MQTT desconectado",
      );
      this.teardown(client);
      this.scheduleReconnect(error);
    };

    client.on("connect", () => {
      if (this.client !== client) return;
      this.attempt = 0;
      this.onlineSince = Date.now();
      this.setStatus({ kind: "online", since: this.onlineSince });
      this.log.info({ serial: this.endpoint.serial }, "MQTT conectado");
      client.subscribe(this.topicReport(), { qos: 0 }, (err) => {
        if (err) {
          fail(err);
          return;
        }
        void this.onSubscribed();
      });
      this.armSilenceWatchdog();
    });
    client.on("message", (topic, payload) => this.onMessage(topic, payload));
    client.on("error", (err) => fail(err));
    client.on("close", () =>
      fail(new PrinterError("not_connected", "La impresora cerró la conexión MQTT.")),
    );
    client.on("offline", () => fail(new PrinterError("not_connected", "Sin conexión MQTT.")));
  }

  private classify(err: unknown): PrinterError {
    if (err instanceof PrinterError) return err;
    const e = err as { code?: number | string; message?: string };
    // CONNACK 4 = usuario/clave incorrectos, 5 = no autorizado.
    if (
      e?.code === 4 ||
      e?.code === 5 ||
      /bad user ?name or password|not authorized/i.test(e?.message ?? "")
    ) {
      return new PrinterError(
        "auth_failed",
        "La impresora rechazó el código de acceso. Revisa el código en Ajustes → Modo solo LAN de la impresora.",
        err,
      );
    }
    return fromNetworkError(err, "MQTT");
  }

  private teardown(client: MqttClient): void {
    clearTimeout(this.silenceTimer);
    clearTimeout(this.pushAllTimer);
    this.probing = false;
    client.removeAllListeners();
    client.on("error", () => {}); // evita errores no manejados durante el cierre
    client.end(true);
    if (this.client === client) this.client = undefined;
    this.rejectAllPending(
      new PrinterError("not_connected", "Se perdió la conexión con la impresora."),
    );
  }

  private scheduleReconnect(error: PrinterError): void {
    if (this.stopped) return;
    const base = Math.min(
      this.opts.backoffMaxMs,
      this.opts.backoffMinMs * 2 ** Math.max(0, this.attempt - 1),
    );
    // Código de acceso incorrecto: no insistir rápido.
    const raw = error.code === "auth_failed" ? this.opts.backoffMaxMs : base;
    const delay = Math.round(raw * (0.8 + Math.random() * 0.4));
    this.setStatus({ kind: "offline", error, retryAt: Date.now() + delay, attempt: this.attempt });
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  /** Fuerza una reconexión inmediata (p. ej. tras detectar conexión zombi). */
  reconnectNow(reason = "reconexión solicitada"): void {
    const client = this.client;
    if (client) this.teardown(client);
    this.attempt = 0;
    this.log.info({ serial: this.endpoint.serial, reason }, "MQTT reconectando");
    clearTimeout(this.reconnectTimer);
    if (!this.stopped) this.connect();
  }

  private async onSubscribed(): Promise<void> {
    const sinceLast = Date.now() - this.lastPushAllAt;
    const minGap = this.hasConnectedBefore ? this.opts.pushAllAfterReconnectMinMs : 0;
    this.hasConnectedBefore = true;
    if (this.lastPushAllAt === 0 || sinceLast >= minGap) {
      await this.requestPushAll(true).catch(() => {});
    } else {
      clearTimeout(this.pushAllTimer);
      this.pushAllTimer = setTimeout(
        () => void this.requestPushAll(true).catch(() => {}),
        minGap - sinceLast,
      );
    }
  }

  private armSilenceWatchdog(): void {
    clearTimeout(this.silenceTimer);
    this.silenceTimer = setTimeout(() => void this.onSilence(), this.opts.silenceMs);
  }

  private async onSilence(): Promise<void> {
    if (!this.online || this.probing) return;
    this.probing = true;
    this.log.debug({ serial: this.endpoint.serial }, "Sin mensajes; comprobando con get_version");
    try {
      await this.request(getVersionCommand(), { timeoutMs: this.opts.probeTimeoutMs });
      this.probing = false;
      this.armSilenceWatchdog();
    } catch {
      this.probing = false;
      this.reconnectNow("la impresora dejó de responder");
    }
  }

  private onMessage(topic: string, payload: Buffer): void {
    this.lastMessageAt = Date.now();
    if (!this.probing) this.armSilenceWatchdog();
    const text = payload.toString("utf8");
    this.emit("traffic", { direction: "in", topic, payload: text, at: this.lastMessageAt });
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      this.log.debug({ serial: this.endpoint.serial }, "Mensaje no JSON ignorado");
      return;
    }
    if (typeof message !== "object" || message === null) return;
    const body = message as Record<string, unknown>;

    const print = body.print as Record<string, unknown> | undefined;
    if (print && (print.command === undefined || print.command === "push_status")) {
      this.raw = mergeReport(this.raw, message);
      this.snap = toSnapshot(this.raw);
      if (isFullReport(print)) this.lastFullStateAt = this.lastMessageAt;
      this.emit("snapshot", this.snap, this.raw);
    }

    for (const [type, section] of Object.entries(body)) {
      if (typeof section !== "object" || section === null) continue;
      const s = section as Record<string, unknown>;
      const command = typeof s.command === "string" ? s.command : undefined;
      if (!command || command === "push_status") continue;
      const ack: CommandAck = {
        type,
        command,
        sequenceId: s.sequence_id === undefined ? undefined : String(s.sequence_id),
        result: typeof s.result === "string" ? s.result : undefined,
        reason: typeof s.reason === "string" ? s.reason : undefined,
        body: s,
      };
      this.emit("ack", ack);
      this.resolvePending(ack);
    }
  }

  private resolvePending(ack: CommandAck): void {
    const exact = ack.sequenceId
      ? this.pending.get(`${ack.type}:${ack.command}:${ack.sequenceId}`)
      : undefined;
    const match =
      exact ??
      [...this.pending.values()].find(
        (p) => p.type === ack.type && p.command === ack.command && !ack.sequenceId,
      );
    if (!match) return;
    clearTimeout(match.timer);
    this.pending.delete(match.key);
    if (ack.result && !/^success$/i.test(ack.result)) {
      match.reject(
        new PrinterError(
          "command_rejected",
          `La impresora rechazó «${ack.command}»: ${ack.reason || ack.result}`,
          ack.body,
        ),
      );
    } else {
      match.resolve(ack);
    }
  }

  private rejectAllPending(err: PrinterError): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  /** Publica un comando con QoS 1 (sin esperar respuesta de la impresora). */
  async publish(command: Record<string, unknown>): Promise<void> {
    const client = this.client;
    if (!client || !this.online) {
      throw new PrinterError("not_connected", "No hay conexión con la impresora.");
    }
    const payload = JSON.stringify(command);
    this.emit("traffic", { direction: "out", topic: this.topicRequest(), payload, at: Date.now() });
    await client.publishAsync(this.topicRequest(), payload, { qos: 1 }).catch((err: unknown) => {
      throw this.classify(err);
    });
  }

  /** Publica un comando y espera la respuesta con el mismo `sequence_id`. */
  async request(
    command: Record<string, unknown>,
    options: { timeoutMs?: number } = {},
  ): Promise<CommandAck> {
    const [type, section] = Object.entries(command)[0] ?? [];
    if (!type || typeof section !== "object" || section === null) {
      throw new PrinterError("unknown", "Comando mal formado.");
    }
    const s = section as Record<string, unknown>;
    const sequenceId = String(s.sequence_id ?? nextSequenceId());
    s.sequence_id = sequenceId;
    const commandName = String(s.command);
    const key = `${type}:${commandName}:${sequenceId}`;
    const timeoutMs = options.timeoutMs ?? 10_000;
    const promise = new Promise<CommandAck>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(
          new PrinterError(
            "timeout",
            `La impresora no respondió a «${commandName}» en ${Math.round(timeoutMs / 1000)} s.`,
          ),
        );
      }, timeoutMs);
      this.pending.set(key, {
        key,
        type,
        command: commandName,
        sequenceId,
        resolve,
        reject,
        timer,
      });
    });
    try {
      await this.publish(command);
    } catch (err) {
      const p = this.pending.get(key);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(key);
      }
      throw err;
    }
    return promise;
  }

  /**
   * Pide el estado completo. Respeta el intervalo mínimo salvo `force`
   * (que solo se usa al conectar). Devuelve false si se omitió por el límite.
   */
  async requestPushAll(force = false): Promise<boolean> {
    const since = Date.now() - this.lastPushAllAt;
    if (!force && this.lastPushAllAt !== 0 && since < this.opts.pushAllMinIntervalMs) return false;
    this.lastPushAllAt = Date.now();
    await this.publish(pushAllCommand());
    return true;
  }

  async getVersion(timeoutMs = 10_000): Promise<VersionInfo> {
    const ack = await this.request(getVersionCommand(), { timeoutMs });
    const modules = Array.isArray(ack.body.module)
      ? (ack.body.module as Array<Record<string, unknown>>)
      : [];
    const parsed = modules.map((m) => ({
      name: String(m.name ?? ""),
      projectName: m.project_name ? String(m.project_name) : undefined,
      swVer: m.sw_ver ? String(m.sw_ver) : undefined,
      hwVer: m.hw_ver ? String(m.hw_ver) : undefined,
      sn: m.sn ? String(m.sn) : undefined,
    }));
    const ota = parsed.find((m) => m.name === "ota");
    const projectName = parsed.find((m) => m.projectName)?.projectName;
    return { modules: parsed, projectName, firmware: ota?.swVer };
  }

  /** Espera a que la conexión esté en línea. */
  waitForOnline(timeoutMs: number): Promise<void> {
    if (this.online) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off("status", onStatus);
        const s = this._status;
        reject(
          s.kind === "offline"
            ? s.error
            : new PrinterError("timeout", "No se pudo conectar con la impresora a tiempo."),
        );
      }, timeoutMs);
      const onStatus = (status: ConnectionStatus) => {
        if (status.kind === "online") {
          clearTimeout(timer);
          this.off("status", onStatus);
          resolve();
        } else if (
          status.kind === "offline" &&
          (status.error.code === "auth_failed" || status.error.code.startsWith("tls_"))
        ) {
          // Errores que no se arreglan reintentando: avisar de una vez.
          clearTimeout(timer);
          this.off("status", onStatus);
          reject(status.error);
        }
      };
      this.on("status", onStatus);
    });
  }

  /** Espera a que el estado cumpla una condición. */
  waitForSnapshot(
    predicate: (s: PrinterSnapshot) => boolean,
    timeoutMs: number,
  ): Promise<PrinterSnapshot> {
    if (predicate(this.snap)) return Promise.resolve(this.snap);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off("snapshot", onSnap);
        reject(new PrinterError("timeout", "La impresora no llegó al estado esperado a tiempo."));
      }, timeoutMs);
      const onSnap = (s: PrinterSnapshot) => {
        if (predicate(s)) {
          clearTimeout(timer);
          this.off("snapshot", onSnap);
          resolve(s);
        }
      };
      this.on("snapshot", onSnap);
    });
  }
}
