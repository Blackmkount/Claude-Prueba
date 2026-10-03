// Utilidades para levantar impresoras simuladas en puertos libres.
import type { Fleet } from "@blackforge/simulator";
import type { PrinterEndpoint } from "../../src/index.js";

export { FAST_TIMING, freePort, startTestFleet } from "@blackforge/simulator/testing";

export function endpointFor(fleet: Fleet, index = 0, verify = true): PrinterEndpoint {
  const p = fleet.describe()[index]!;
  return {
    host: p.host,
    serial: p.serial,
    accessCode: p.accessCode,
    mqttPort: p.mqttPort,
    ftpsPort: p.ftpsPort,
    tls: { verify, caPem: fleet.ca.certPem },
  };
}
