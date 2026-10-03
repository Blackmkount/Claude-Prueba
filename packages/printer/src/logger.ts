// Interfaz mínima de registro, compatible con pino (el servidor le pasa su logger).
export interface Logger {
  debug(obj: object | string, msg?: string): void;
  info(obj: object | string, msg?: string): void;
  warn(obj: object | string, msg?: string): void;
  error(obj: object | string, msg?: string): void;
}

const noop = () => {};
export const silentLogger: Logger = { debug: noop, info: noop, warn: noop, error: noop };
