// Simulador de impresoras A1 para desarrollo.
//   npm run sim                       10 impresoras en 127.0.0.1:18800…
//   npm run sim -- --impresoras 4     otra cantidad
//   npm run sim -- --ayuda            todas las opciones
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { startControlServer } from "./control-api.js";
import { startFleet } from "./fleet.js";
import type { SimQuirks } from "./printer.js";

const HELP = `Simulador de impresoras Bambu Lab A1 (BlackForge Print)

Uso: npm run sim -- [opciones]

  --impresoras N        Cantidad de impresoras (por defecto 10)
  --puerto-base P       Puerto MQTT de la primera (por defecto 18800; FTPS = P+1, siguiente = P+2…)
  --host IP             Dirección donde escuchar (por defecto 127.0.0.1)
  --datos DIR           Carpeta para la CA y las microSD (por defecto .sim)
  --control P           Puerto de la API de control (por defecto 18799)
  --velocidad N         Aceleración: 60 = una hora de impresión dura un minuto (por defecto 60)
  --duracion-ms N       Duración fija de cada impresión simulada
  --detalle             Muestra cada comando recibido

Mañas de la A1 (para probar):
  --sin-226             No confirma la subida (226)
  --protp-cuelga        El canal de datos con TLS se cuelga (obliga a PROT C)
  --exigir-reuso        Exige reutilizar la sesión TLS en el canal de datos
  --lento KBps          Limita la velocidad de subida
  --sin-microsd         Sin microSD
  --sin-modo-desarrollador  Ignora en silencio las órdenes de imprimir
  --url ftp,sdcard,ftp3 Formatos de URL aceptados por project_file
`;

const { values } = parseArgs({
  options: {
    impresoras: { type: "string", default: "10" },
    "puerto-base": { type: "string", default: "18800" },
    host: { type: "string", default: "127.0.0.1" },
    datos: { type: "string", default: ".sim" },
    control: { type: "string", default: "18799" },
    velocidad: { type: "string", default: "60" },
    "duracion-ms": { type: "string" },
    detalle: { type: "boolean", default: false },
    "sin-226": { type: "boolean", default: false },
    "protp-cuelga": { type: "boolean", default: false },
    "exigir-reuso": { type: "boolean", default: false },
    lento: { type: "string" },
    "sin-microsd": { type: "boolean", default: false },
    "sin-modo-desarrollador": { type: "boolean", default: false },
    url: { type: "string" },
    ayuda: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});

if (values.ayuda || values.help) {
  console.log(HELP);
  process.exit(0);
}

const quirks: SimQuirks = {
  noTransferComplete: values["sin-226"],
  protPHangs: values["protp-cuelga"],
  requireSessionReuse: values["exigir-reuso"],
  slowKBps: values.lento ? Number(values.lento) : undefined,
  noSdCard: values["sin-microsd"],
  devModeOff: values["sin-modo-desarrollador"],
  acceptedUrlStyles: values.url
    ? (values.url.split(",") as SimQuirks["acceptedUrlStyles"])
    : undefined,
};

const dataDir = resolve(values.datos);
const fleet = await startFleet({
  count: Number(values.impresoras),
  basePort: Number(values["puerto-base"]),
  host: values.host,
  dataDir,
  timing: {
    speedFactor: Number(values.velocidad),
    printMs: values["duracion-ms"] ? Number(values["duracion-ms"]) : undefined,
  },
  quirks,
  log: values.detalle
    ? (msg) => console.log(`  ${new Date().toLocaleTimeString("es-CO")} ${msg}`)
    : undefined,
});
const controlPort = Number(values.control);
await startControlServer(fleet, controlPort, values.host);

const printers = fleet.describe();
await writeFile(join(dataDir, "impresoras.json"), JSON.stringify(printers, null, 2));

console.log(`\nSimulador listo: ${printers.length} impresoras A1 falsas\n`);
console.table(
  printers.map((p) => ({
    Nombre: p.name,
    Serie: p.serial,
    Código: p.accessCode,
    MQTT: `${p.host}:${p.mqttPort}`,
    FTPS: `${p.host}:${p.ftpsPort}`,
    Filamento: p.hasAms ? "AMS lite" : "Bobina externa",
  })),
);
const first = printers[0]!;
console.log(`CA del simulador: ${join(dataDir, "ca.pem")}`);
console.log(`API de control:   http://${values.host}:${controlPort}/impresoras\n`);
console.log(
  "Para usar el CLI contra la primera impresora simulada, crea un archivo .env.sim con:\n",
);
console.log(`PRINTER_IP=${first.host}
PRINTER_ACCESS_CODE=${first.accessCode}
PRINTER_SERIAL=${first.serial}
PRINTER_MQTT_PORT=${first.mqttPort}
PRINTER_FTPS_PORT=${first.ftpsPort}
PRINTER_CA_FILE=${join(dataDir, "ca.pem")}
`);
console.log("y ejecuta: npm run cli -- estado --env .env.sim\n");
console.log("Ctrl+C para detener.");

const shutdown = async () => {
  await fleet.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
