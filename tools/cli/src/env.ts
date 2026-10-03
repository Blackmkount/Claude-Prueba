// Lee los datos de la impresora del archivo .env y arma el "endpoint".
// Si falta el número de serie, lo detecta leyendo el certificado de la impresora.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { probeCertificate, type CertificateProbe, type PrinterEndpoint } from "@blackforge/printer";
import { c, info, warn } from "./format.js";

export class CliError extends Error {}

export function loadEnv(path: string | undefined): void {
  const file = resolve(path ?? ".env");
  if (existsSync(file)) {
    process.loadEnvFile(file);
  } else if (path) {
    throw new CliError(`No encontré el archivo ${file}.`);
  }
}

export interface ResolvedEndpoint {
  endpoint: PrinterEndpoint;
  probe?: CertificateProbe;
}

export async function resolveEndpoint(
  options: { quiet?: boolean } = {},
): Promise<ResolvedEndpoint> {
  const host = process.env.PRINTER_IP?.trim();
  const accessCode = process.env.PRINTER_ACCESS_CODE?.trim();
  if (!host || !accessCode) {
    throw new CliError(
      "Faltan datos de la impresora. Copia .env.example como .env y llena PRINTER_IP y PRINTER_ACCESS_CODE.",
    );
  }
  const mqttPort = Number(process.env.PRINTER_MQTT_PORT || 8883);
  const ftpsPort = Number(process.env.PRINTER_FTPS_PORT || 990);
  const verify = (process.env.PRINTER_TLS_VERIFY ?? "true").trim().toLowerCase() !== "false";
  const caFile = process.env.PRINTER_CA_FILE?.trim();
  const caPem = caFile ? readFileSync(resolve(caFile), "utf8") : undefined;
  const tls = { verify, caPem };
  let serial = process.env.PRINTER_SERIAL?.trim();
  let probe: CertificateProbe | undefined;
  if (!serial) {
    probe = await probeCertificate(host, mqttPort, { settings: tls });
    serial = probe.serial;
    if (!serial)
      throw new CliError(
        "No pude leer el número de serie del certificado. Escríbelo en PRINTER_SERIAL.",
      );
    if (!options.quiet) info(`Número de serie detectado en el certificado: ${c.bold(serial)}`);
  }
  if (!verify && !options.quiet)
    warn("La verificación del certificado está desactivada (PRINTER_TLS_VERIFY=false).");
  return { endpoint: { host, serial, accessCode, mqttPort, ftpsPort, tls }, probe };
}
