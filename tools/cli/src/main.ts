// CLI de prueba del protocolo (Fase 1).
//   npm run cli -- ayuda
import { parseArgs } from "node:util";
import {
  FTPS_MODES,
  URL_STYLES,
  type FtpsMode,
  type TriState,
  type UrlStyle,
} from "@blackforge/printer";
import { SlicedFileError } from "@blackforge/threemf";
import { diagnose } from "./commands/diagnose.js";
import {
  cleanCommand,
  controlCommand,
  filesCommand,
  infoCommand,
  statusCommand,
  uploadCommand,
} from "./commands/misc.js";
import { printCommand } from "./commands/print.js";
import { CliError, loadEnv } from "./env.js";
import { c, fail } from "./format.js";
import { explainError } from "./printer-helpers.js";

const HELP = `${c.bold("BlackForge Print — CLI de prueba del protocolo")}

Uso: npm run cli -- <comando> [opciones]

Comandos:
  diagnostico [--archivo X]   Prueba red, certificado, MQTT, estado y FTPS (no imprime).
                              Genera un reporte en reportes/ para compartir.
  estado [--seguir]           Muestra el estado de la impresora (en vivo con --seguir).
  info <archivo>              Lee un .gcode.3mf y muestra placas, tiempo, gramos y filamento.
  subir [archivo]             Sube un archivo (o 1 MB de prueba), verifica y lo borra.
  imprimir <archivo>          Sube el archivo e inicia la impresión; sigue el avance.
  pausar | reanudar           Pausa o reanuda la impresión en curso.
  cancelar                    Cancela la impresión en curso (pide confirmación).
  archivos                    Lista la raíz de la microSD.
  limpiar                     Borra de la microSD los archivos que subió esta app.

Opciones generales:
  --env ARCHIVO               Archivo con los datos de la impresora (por defecto .env)
  --modo MODO                 Cliente FTPS: ${FTPS_MODES.join(", ")} (por defecto basic)
  --si                        No pedir confirmación

Opciones de «imprimir»:
  --placa N                   Placa a imprimir si el archivo tiene varias
  --url ESTILO                Formato de URL: ${URL_STYLES.join(", ")} (por defecto ftp)
  --bandeja N                 Usar la bandeja N (1–4) del AMS lite
  --externa                   Usar la bobina externa
  --nivelar auto|si|no        Nivelación de cama (por defecto auto)
  --rapido                    Sin nivelación ni calibraciones (para pruebas cortas)
  --nombre TEXTO              Nombre que muestra la pantalla de la impresora
  --no-seguir                 No seguir el avance tras arrancar
  --forzar                    Enviar aunque el archivo sea para otro modelo o boquilla

Opciones de «diagnostico»:
  --archivo X                 Además analiza este .gcode.3mf contra la impresora
  --salida X                  Ruta del reporte (por defecto reportes/diagnostico_<fecha>.md)
  --reposo N                  Segundos observando el tráfico en reposo (por defecto 20)
  --sin-subida                No probar subidas FTPS

Para ver errores técnicos completos: BF_DEBUG=1 npm run cli -- …
`;

function parseMode(value: string | undefined): FtpsMode {
  const mode = (value ?? "basic") as FtpsMode;
  if (!FTPS_MODES.includes(mode))
    throw new CliError(`--modo debe ser uno de: ${FTPS_MODES.join(", ")}`);
  return mode;
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      env: { type: "string" },
      modo: { type: "string" },
      si: { type: "boolean", default: false },
      seguir: { type: "boolean", default: false },
      grabar: { type: "boolean", default: false },
      placa: { type: "string" },
      url: { type: "string" },
      bandeja: { type: "string" },
      externa: { type: "boolean", default: false },
      nivelar: { type: "string" },
      rapido: { type: "boolean", default: false },
      nombre: { type: "string" },
      "no-seguir": { type: "boolean", default: false },
      forzar: { type: "boolean", default: false },
      conservar: { type: "boolean", default: false },
      archivo: { type: "string" },
      salida: { type: "string" },
      reposo: { type: "string" },
      "sin-subida": { type: "boolean", default: false },
      ayuda: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [command, arg] = positionals;
  if (!command || command === "ayuda" || values.ayuda || values.help) {
    console.log(HELP);
    return 0;
  }
  loadEnv(values.env);

  switch (command) {
    case "diagnostico":
    case "diagnóstico":
      return diagnose({
        file: values.archivo,
        output: values.salida,
        idleSeconds: Number(values.reposo ?? 20),
        skipUpload: values["sin-subida"],
      });
    case "estado":
      return statusCommand({ follow: values.seguir, record: values.grabar });
    case "info":
      if (!arg) throw new CliError("Indica el archivo: npm run cli -- info archivo.gcode.3mf");
      return infoCommand(arg);
    case "subir":
      return uploadCommand({ file: arg, mode: parseMode(values.modo), keep: values.conservar });
    case "imprimir": {
      if (!arg) throw new CliError("Indica el archivo: npm run cli -- imprimir archivo.gcode.3mf");
      const url = (values.url ?? "ftp") as UrlStyle;
      if (!URL_STYLES.includes(url))
        throw new CliError(`--url debe ser uno de: ${URL_STYLES.join(", ")}`);
      const levelMap: Record<string, TriState> = { auto: "auto", si: "on", sí: "on", no: "off" };
      const leveling = levelMap[(values.nivelar ?? "auto").toLowerCase()];
      if (!leveling) throw new CliError("--nivelar debe ser auto, si o no");
      const tray = values.bandeja ? Number(values.bandeja) : undefined;
      if (tray !== undefined && !(tray >= 1 && tray <= 16))
        throw new CliError("--bandeja debe ser un número de 1 a 4 (o hasta 16 con varios AMS)");
      return printCommand({
        file: arg,
        plate: values.placa ? Number(values.placa) : undefined,
        url,
        mode: parseMode(values.modo),
        tray,
        external: values.externa,
        leveling,
        quick: values.rapido,
        yes: values.si,
        follow: !values["no-seguir"],
        name: values.nombre,
        force: values.forzar,
      });
    }
    case "pausar":
    case "reanudar":
    case "cancelar":
      return controlCommand(command, { yes: values.si });
    case "archivos":
      return filesCommand({ mode: parseMode(values.modo) });
    case "limpiar":
      return cleanCommand({ mode: parseMode(values.modo), yes: values.si });
    default:
      throw new CliError(`Comando desconocido: ${command}. Usa: npm run cli -- ayuda`);
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    if (err instanceof CliError || err instanceof SlicedFileError) fail(err.message);
    else explainError(err);
    process.exit(1);
  });
