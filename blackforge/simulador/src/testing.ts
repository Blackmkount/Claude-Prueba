// Ayudas para pruebas: levantar impresoras simuladas en puertos libres y con
// tiempos acelerados.
import net from "node:net";
import { startFleet, type Fleet, type FleetOptions } from "./fleet.js";

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

/** Tiempos acelerados para pruebas. */
export const FAST_TIMING = { tickMs: 50, prepareMs: 300, printMs: 1_200, idleReportMs: 0 };

export async function startTestFleet(options: FleetOptions = {}): Promise<Fleet> {
  const count = options.count ?? 1;
  const overrides = [];
  for (let i = 0; i < count; i++) {
    overrides.push({
      mqttPort: await freePort(),
      ftpsPort: await freePort(),
      ...options.overrides?.[i],
    });
  }
  return startFleet({ timing: FAST_TIMING, ...options, count, overrides });
}
