// Arranca varias impresoras simuladas a la vez (por defecto 10, como el taller).
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCa, createPrinterCert, loadOrCreateCa, type SimulatorCa } from "./certs.js";
import {
  SimulatedPrinter,
  type SimPrinterConfig,
  type SimQuirks,
  type SimTiming,
  type SimTray,
} from "./printer.js";

export interface FleetOptions {
  count?: number;
  /** Puerto MQTT de la impresora i = basePort + 2i; FTPS = basePort + 2i + 1. */
  basePort?: number;
  host?: string;
  /** Directorio para la CA y las microSD simuladas. Si no se da, uno temporal. */
  dataDir?: string;
  timing?: Partial<SimTiming>;
  quirks?: SimQuirks;
  /** Ajustes por impresora (se combinan con los generados). */
  overrides?: Array<Partial<Omit<SimPrinterConfig, "cert" | "storageDir">> | undefined>;
  log?: (msg: string) => void;
}

export interface FleetPrinterInfo {
  name: string;
  serial: string;
  accessCode: string;
  host: string;
  mqttPort: number;
  ftpsPort: number;
  hasAms: boolean;
}

export interface Fleet {
  ca: SimulatorCa;
  printers: SimulatedPrinter[];
  describe(): FleetPrinterInfo[];
  get(serial: string): SimulatedPrinter | undefined;
  close(): Promise<void>;
}

const COLORS: SimTray[] = [
  { type: "PLA", color: "FFFFFF" },
  { type: "PLA", color: "000000" },
  { type: "PLA", color: "9A6A42" },
  { type: "PETG", color: "D62839" },
  { type: "PLA", color: "1F6FD1" },
  { type: "PLA", color: "45C486" },
];

export function simSerial(i: number): string {
  return `03900SIM${String(i + 1).padStart(7, "0")}`;
}

export function simAccessCode(i: number): string {
  return `sim${String(i + 1).padStart(5, "0")}`;
}

/** Mezcla realista: las impresoras pares con AMS lite, las impares con bobina externa. */
function defaultFilament(i: number): Pick<SimPrinterConfig, "ams" | "externalSpool"> {
  if (i % 2 === 0) {
    return {
      ams: [
        COLORS[i % COLORS.length]!,
        COLORS[(i + 1) % COLORS.length]!,
        COLORS[(i + 2) % COLORS.length]!,
        null,
      ],
      externalSpool: null,
    };
  }
  return { ams: null, externalSpool: COLORS[i % COLORS.length]! };
}

export async function startFleet(options: FleetOptions = {}): Promise<Fleet> {
  const count = options.count ?? 10;
  const basePort = options.basePort ?? 18800;
  const host = options.host ?? "127.0.0.1";
  const dataDir = options.dataDir ?? join(tmpdir(), `bf-sim-${process.pid}-${Date.now()}`);
  const ca = options.dataDir ? await loadOrCreateCa(dataDir) : await createCa();
  const printers: SimulatedPrinter[] = [];
  for (let i = 0; i < count; i++) {
    const serial = options.overrides?.[i]?.serial ?? simSerial(i);
    const cert = await createPrinterCert(ca, serial);
    const config: SimPrinterConfig = {
      serial,
      accessCode: simAccessCode(i),
      name: `A1-${String(i + 1).padStart(2, "0")}`,
      host,
      mqttPort: basePort + i * 2,
      ftpsPort: basePort + i * 2 + 1,
      ...defaultFilament(i),
      timing: options.timing,
      quirks: { ...options.quirks },
      log: options.log,
      ...options.overrides?.[i],
      cert,
      storageDir: join(dataDir, "microsd", serial),
    };
    printers.push(new SimulatedPrinter(config));
  }
  try {
    await Promise.all(printers.map((p) => p.start()));
  } catch (err) {
    await Promise.all(printers.map((p) => p.stop().catch(() => {})));
    throw err;
  }
  return {
    ca,
    printers,
    describe: () =>
      printers.map((p) => ({
        name: p.config.name ?? p.serial,
        serial: p.serial,
        accessCode: p.config.accessCode,
        host: p.config.host ?? host,
        mqttPort: p.config.mqttPort,
        ftpsPort: p.config.ftpsPort,
        hasAms: !!p.rawState.ams,
      })),
    get: (serial) => printers.find((p) => p.serial === serial),
    close: async () => {
      await Promise.all(printers.map((p) => p.stop()));
    },
  };
}
