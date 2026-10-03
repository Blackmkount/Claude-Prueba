// Errores del módulo de impresora. Cada uno trae un código estable (para que el
// servidor decida qué decirle a la operaria) y un mensaje técnico en español
// (para el registro y el CLI). El detalle crudo va en `detail`.

export type PrinterErrorCode =
  /** No hay ruta de red o el puerto está cerrado (impresora apagada, IP equivocada). */
  | "unreachable"
  /** La impresora rechazó el código de acceso. */
  | "auth_failed"
  /** El certificado no está firmado por Bambu Lab. */
  | "tls_untrusted"
  /** El certificado es de otra impresora (la IP apunta a otra serie). */
  | "tls_serial_mismatch"
  /** Se agotó el tiempo de espera. */
  | "timeout"
  /** No hay conexión MQTT activa. */
  | "not_connected"
  /** La impresora no está en un estado que permita la acción. */
  | "busy"
  /** No hay microSD o está dañada. */
  | "no_sdcard"
  /** La microSD está llena. */
  | "sdcard_full"
  /** Falló la transferencia FTPS. */
  | "upload_failed"
  /** El archivo no quedó completo en la microSD. */
  | "upload_incomplete"
  /** La impresora no confirmó que arrancó la impresión. */
  | "start_not_confirmed"
  /** La impresora respondió con error al comando. */
  | "command_rejected"
  /** La impresora exige firma en los comandos: falta activar el Modo desarrollador. */
  | "developer_mode_required"
  /** Otro error inesperado. */
  | "unknown";

export class PrinterError extends Error {
  constructor(
    readonly code: PrinterErrorCode,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "PrinterError";
  }
}

export function isPrinterError(err: unknown, code?: PrinterErrorCode): err is PrinterError {
  return err instanceof PrinterError && (code === undefined || err.code === code);
}

/** Traduce errores de red de Node a un PrinterError legible. */
export function fromNetworkError(err: unknown, what: string): PrinterError {
  if (err instanceof PrinterError) return err;
  const e = err as NodeJS.ErrnoException & { reason?: string };
  const code = e?.code ?? "";
  if (
    [
      "ECONNREFUSED",
      "EHOSTUNREACH",
      "ENETUNREACH",
      "EHOSTDOWN",
      "ENOTFOUND",
      "EADDRNOTAVAIL",
    ].includes(code)
  ) {
    return new PrinterError(
      "unreachable",
      `${what}: no se pudo llegar a la impresora (${code}). Revisa que esté encendida, en la misma red y con la IP correcta.`,
      err,
    );
  }
  if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT") {
    return new PrinterError("timeout", `${what}: la impresora no respondió a tiempo.`, err);
  }
  if (code === "ERR_TLS_CERT_ALTNAME_INVALID") {
    return new PrinterError(
      "tls_serial_mismatch",
      `${what}: el certificado pertenece a otra impresora. Revisa que la IP y el número de serie correspondan a la misma impresora.`,
      err,
    );
  }
  if (
    code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
    code === "SELF_SIGNED_CERT_IN_CHAIN" ||
    code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
    code === "UNABLE_TO_GET_ISSUER_CERT_LOCALLY" ||
    code === "CERT_SIGNATURE_FAILURE"
  ) {
    return new PrinterError(
      "tls_untrusted",
      `${what}: el certificado no está firmado por Bambu Lab (${code}).`,
      err,
    );
  }
  const message = e instanceof Error ? e.message : String(err);
  return new PrinterError("unknown", `${what}: ${message}`, err);
}
