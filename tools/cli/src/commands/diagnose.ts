// `diagnostico`: prueba paso a paso todo lo necesario para imprimir, SIN imprimir.
// Genera un reporte Markdown (sin el código de acceso) para compartir.
import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  deleteRemoteFile,
  developerModeMissing,
  FTPS_MODES,
  listRemoteFiles,
  planFilament,
  PrinterConnection,
  printErrorShort,
  probeCertificate,
  uploadFile,
  type CertificateProbe,
  type FtpsMode,
  type PrinterEndpoint,
  type UploadResult,
} from "@blackforge/printer";
import { printerModelName, readSlicedFile } from "@blackforge/threemf";
import { resolveEndpoint } from "../env.js";
import { bytes, c, fail, info, ok, speed, timestamp, title, warn } from "../format.js";
import { explainError, printSnapshot, STATE_NAMES, trayLabel } from "../printer-helpers.js";
import { Recorder } from "../recorder.js";

interface Options {
  file?: string;
  output?: string;
  idleSeconds: number;
  skipUpload: boolean;
}

interface ModeResult {
  mode: FtpsMode;
  ok: boolean;
  upload?: UploadResult;
  listed?: number;
  deleted?: boolean;
  error?: string;
  ms: number;
}

function tcpCheck(
  host: string,
  port: number,
  timeoutMs = 5000,
): Promise<{ ok: boolean; ms: number; error?: string }> {
  const started = Date.now();
  return new Promise((resolvePromise) => {
    const s = net.connect({ host, port });
    const done = (result: { ok: boolean; error?: string }) => {
      s.destroy();
      resolvePromise({ ...result, ms: Date.now() - started });
    };
    s.setTimeout(timeoutMs, () => done({ ok: false, error: "sin respuesta" }));
    s.once("connect", () => done({ ok: true }));
    s.once("error", (err: NodeJS.ErrnoException) =>
      done({ ok: false, error: err.code ?? err.message }),
    );
  });
}

export async function diagnose(opts: Options): Promise<number> {
  const lines: string[] = [];
  const md = (s = "") => lines.push(s);
  const stamp = timestamp();
  const recorder = new Recorder(resolve("capturas", `diagnostico_${stamp}.jsonl`));
  let exitCode = 0;
  md(`# Diagnóstico BlackForge Print — ${new Date().toLocaleString("es-CO")}`);
  md();
  md(`Node ${process.version} · ${process.platform} ${process.arch}`);
  md();

  const host = process.env.PRINTER_IP ?? "?";
  const mqttPort = Number(process.env.PRINTER_MQTT_PORT || 8883);
  const ftpsPort = Number(process.env.PRINTER_FTPS_PORT || 990);

  // 1. Red
  title("1. Red");
  md("## 1. Red");
  for (const [name, port] of [
    ["MQTT", mqttPort],
    ["FTPS", ftpsPort],
  ] as const) {
    const r = await tcpCheck(host, port);
    if (r.ok) ok(`${name} ${host}:${port} responde (${r.ms} ms)`);
    else fail(`${name} ${host}:${port} no responde: ${r.error}`);
    md(
      `- ${name} ${host}:${port}: ${r.ok ? `responde (${r.ms} ms)` : `**no responde** (${r.error})`}`,
    );
    if (!r.ok) exitCode = 1;
  }
  if (exitCode) {
    info(
      "Sin red no se puede seguir. Revisa IP, que la impresora esté encendida y, en macOS, el permiso de «Red local» para la Terminal.",
    );
    md("\nNo hay conexión de red con la impresora; diagnóstico detenido.");
    return finish(lines, opts, stamp, recorder, exitCode);
  }

  // 2. Certificado
  title("2. Certificado TLS");
  md("\n## 2. Certificado TLS");
  let probe: CertificateProbe | undefined;
  let endpoint: PrinterEndpoint;
  try {
    const resolved = await resolveEndpoint({ quiet: true });
    endpoint = resolved.endpoint;
    probe =
      resolved.probe ??
      (await probeCertificate(endpoint.host, endpoint.mqttPort!, { settings: endpoint.tls }));
  } catch (err) {
    explainError(err);
    md(`- **Error**: ${(err as Error).message}`);
    return finish(lines, opts, stamp, recorder, 1);
  }
  ok(`Serie en el certificado: ${c.bold(probe.serial ?? "?")}`);
  info(`Emisor: ${probe.issuer}`);
  info(`Válido hasta: ${probe.validTo} · ${probe.protocol} · ${probe.cipher}`);
  const caName = process.env.PRINTER_CA_FILE ? "la CA de PRINTER_CA_FILE" : "la CA de Bambu";
  if (probe.trusted) ok(`Firmado por ${caName}: la verificación de certificado funcionará`);
  else warn(`No se pudo verificar con ${caName}: ${probe.trustError}`);
  if (process.env.PRINTER_SERIAL && process.env.PRINTER_SERIAL !== probe.serial) {
    warn(
      `PRINTER_SERIAL (${process.env.PRINTER_SERIAL}) no coincide con el certificado (${probe.serial}).`,
    );
  }
  md(`- Serie (CN): \`${probe.serial}\``);
  md(`- Emisor: ${probe.issuer}`);
  md(`- Validez: ${probe.validFrom} → ${probe.validTo}`);
  md(`- Protocolo: ${probe.protocol} · ${probe.cipher}`);
  md(`- Verificable con ${caName}: **${probe.trusted ? "sí" : `no (${probe.trustError})`}**`);

  // 3. MQTT
  title("3. MQTT");
  md("\n## 3. MQTT");
  let conn: PrinterConnection | undefined;
  const tryConnect = async (ep: PrinterEndpoint, label: string) => {
    const cn = new PrinterConnection(ep, { connectTimeoutMs: 10_000 });
    recorder.attach(cn);
    cn.start();
    try {
      await cn.waitForOnline(15_000);
      ok(`Conectado (${label})`);
      md(`- Conexión ${label}: **ok**`);
      return cn;
    } catch (err) {
      await cn.stop();
      fail(`No conectó (${label}): ${(err as Error).message}`);
      md(`- Conexión ${label}: **falló** — ${(err as Error).message}`);
      return undefined;
    }
  };
  conn = await tryConnect(
    endpoint,
    endpoint.tls?.verify === false ? "sin verificar certificado" : "verificando certificado",
  );
  if (!conn && endpoint.tls?.verify !== false) {
    conn = await tryConnect(
      { ...endpoint, tls: { ...endpoint.tls, verify: false } },
      "sin verificar certificado",
    );
    if (conn)
      warn(
        "Solo conecta sin verificar el certificado. Pon PRINTER_TLS_VERIFY=false en el .env por ahora.",
      );
  }
  if (!conn) {
    explainError(new Error("No se pudo conectar por MQTT."));
    return finish(lines, opts, stamp, recorder, 1);
  }

  try {
    const version = await conn.getVersion().catch((err: unknown) => {
      warn(`get_version no respondió: ${(err as Error).message}`);
      return undefined;
    });
    if (version) {
      ok(
        `Modelo: ${printerModelName(version.projectName) ?? "?"} (${version.projectName}) · firmware ${version.firmware}`,
      );
      md(
        `- Modelo: ${printerModelName(version.projectName)} (\`${version.projectName}\`) · firmware **${version.firmware}**`,
      );
      md(`- Módulos: ${version.modules.map((m) => `${m.name} ${m.swVer ?? ""}`).join(", ")}`);
    }

    await conn
      .waitForSnapshot(() => conn!.stateValid, 15_000)
      .catch(() => warn("No llegó el estado completo (pushall) en 15 s."));
    const s = conn.snapshot;
    title("4. Estado de la impresora");
    printSnapshot(s);
    md("\n## 4. Estado");
    md(
      `- Estado: ${STATE_NAMES[s.gcodeState]} · microSD: ${s.sdCard} · boquilla ${s.nozzleDiameter} mm`,
    );
    md(
      `- Modo desarrollador: ${s.signatureRequired === null ? "desconocido (no llegó el campo fun)" : developerModeMissing(s) ? "**APAGADO**" : "activo"} (fun=\`${String(conn.rawState.fun ?? "—")}\`)`,
    );
    md(
      `- AMS lite: ${s.hasAms ? s.amsTrays.map((t) => `B${t.slot + 1}=${t.loaded ? `${t.type} ${t.color}` : "vacía"}`).join(", ") : "no"}`,
    );
    md(
      `- Bobina externa: ${s.externalSpool?.loaded ? `${s.externalSpool.type} ${s.externalSpool.color}` : "sin datos"}`,
    );
    md(
      `- print_error: ${s.printError ? printErrorShort(s.printError) : "0"} · HMS: ${s.hms.map((h) => h.full).join(", ") || "ninguno"}`,
    );
    md(
      `- Campos del reporte completo: ${Object.keys(conn.rawState).length} (${Object.keys(conn.rawState).sort().join(", ")})`,
    );
    if (developerModeMissing(s)) exitCode = 1;

    // 5. Tráfico en reposo
    title(`5. Tráfico en reposo (${opts.idleSeconds} s)`);
    const seen: number[] = [];
    const keys = new Map<string, number>();
    const onTraffic = (t: { direction: string; payload: string; at: number }) => {
      if (t.direction !== "in") return;
      seen.push(t.at);
      try {
        const body = JSON.parse(t.payload) as { print?: Record<string, unknown> };
        for (const k of Object.keys(body.print ?? {})) keys.set(k, (keys.get(k) ?? 0) + 1);
      } catch {
        // ignorado
      }
    };
    conn.on("traffic", onTraffic);
    await new Promise((r) => setTimeout(r, opts.idleSeconds * 1000));
    conn.off("traffic", onTraffic);
    const gaps = seen.slice(1).map((t, i) => t - seen[i]!);
    const maxGap = gaps.length ? Math.max(...gaps) : opts.idleSeconds * 1000;
    info(
      `${seen.length} ${seen.length === 1 ? "mensaje" : "mensajes"}; mayor silencio: ${(maxGap / 1000).toFixed(1)} s`,
    );
    md(`\n## 5. Tráfico en reposo (${opts.idleSeconds} s)`);
    md(`- Mensajes: ${seen.length} · mayor silencio: ${(maxGap / 1000).toFixed(1)} s`);
    md(
      `- Campos que cambiaron: ${[...keys.entries()].map(([k, n]) => `${k}×${n}`).join(", ") || "ninguno"}`,
    );

    // 6. FTPS
    const results: ModeResult[] = [];
    md("\n## 6. FTPS");
    if (opts.skipUpload) {
      info("Subida de prueba omitida (--sin-subida).");
      md("- Omitido.");
    } else {
      title("6. FTPS (sube y borra un archivo de prueba de 256 KB en cada modo)");
      const tmp = join(tmpdir(), `bf-diag-${process.pid}`);
      await mkdir(tmp, { recursive: true });
      const testFile = join(tmp, "prueba.bin");
      await writeFile(testFile, randomBytes(256 * 1024));
      try {
        try {
          const before = await listRemoteFiles(endpoint, "/", {
            mode: "minimal-c",
            timeoutMs: 15_000,
          });
          info(
            `Archivos en la raíz de la microSD: ${before.length}${
              before.length
                ? ` (${before
                    .slice(0, 8)
                    .map((f) => f.name)
                    .join(", ")}${before.length > 8 ? "…" : ""})`
                : ""
            }`,
          );
          md(`- Archivos en la raíz: ${before.length}`);
        } catch (err) {
          warn(`No se pudo listar la microSD: ${(err as Error).message}`);
        }
        for (const mode of FTPS_MODES) {
          const started = Date.now();
          const r: ModeResult = { mode, ok: false, ms: 0 };
          const remote = `bf_diag_${mode.replace("-", "")}.bin`;
          try {
            r.upload = await uploadFile(endpoint, testFile, remote, {
              mode,
              timeoutMs: 20_000,
              confirmTimeoutMs: 15_000,
            });
            r.listed = (
              await listRemoteFiles(endpoint, "/", { mode, timeoutMs: 15_000 }).catch(() => [])
            ).length;
            r.deleted = await deleteRemoteFile(endpoint, remote, { mode, timeoutMs: 15_000 });
            r.ok = true;
          } catch (err) {
            r.error = (err as Error).message;
            await deleteRemoteFile(endpoint, remote, {
              mode: "minimal-c",
              timeoutMs: 10_000,
            }).catch(() => {});
          }
          r.ms = Date.now() - started;
          results.push(r);
          if (r.ok && r.upload) {
            ok(
              `${mode}: ${speed(r.upload.bytesPerSecond)} · 226 ${r.upload.transferConfirmed ? "sí" : c.yellow("NO llegó")}` +
                `${r.upload.sessionReused !== undefined ? ` · sesión TLS reutilizada: ${r.upload.sessionReused ? "sí" : "no"}` : ""}`,
            );
          } else {
            fail(`${mode}: ${r.error}`);
          }
          md(
            `- **${mode}**: ${r.ok ? "ok" : "falló"}${r.upload ? ` · ${speed(r.upload.bytesPerSecond)} · 226: ${r.upload.transferConfirmed ? "sí" : "no"} · sesión reutilizada: ${r.upload.sessionReused ?? "n/a"} · tamaño verificado ${bytes(r.upload.verifiedSize)}` : ""}${r.error ? ` · error: ${r.error}` : ""} · ${r.ms} ms`,
          );
        }
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
      if (!results.some((r) => r.ok)) exitCode = 1;
    }

    // 7. Archivo
    if (opts.file) {
      title("7. Archivo laminado");
      md("\n## 7. Archivo");
      try {
        const fileInfo = await readSlicedFile(resolve(opts.file));
        for (const plate of fileInfo.plates) {
          const model = printerModelName(plate.printerModelId);
          info(
            `Placa ${plate.index}: ${model ?? "modelo ?"} · ${plate.weightGrams ?? "?"} g · ${plate.totalLayers ?? "?"} capas · ${plate.filaments.map((f) => `${f.type} ${f.color}`).join(", ")}`,
          );
          md(
            `- Placa ${plate.index}: ${model} · ${plate.predictionSeconds ?? "?"} s · ${plate.weightGrams ?? "?"} g · filamentos ${plate.filaments.map((f) => `#${f.id} ${f.type} ${f.color}`).join(", ")}`,
          );
          const plan = planFilament(plate.filaments, s);
          for (const m of plan.matches) {
            const verdict =
              m.typeMatches && m.colorMatches ? c.green("coincide") : c.yellow("revisar");
            info(
              `  Filamento ${m.filament.id} (${m.filament.type} ${m.filament.color}) → ${trayLabel(m.tray?.globalId)} ${verdict}`,
            );
          }
          md(
            `  - Mapeo propuesto: \`${JSON.stringify(plan.mapping)}\` (${plan.allMatch ? "todo coincide" : "revisar filamento"})`,
          );
        }
      } catch (err) {
        fail((err as Error).message);
        md(`- Error leyendo el archivo: ${(err as Error).message}`);
      }
    }

    // Resumen
    title("Resumen");
    md("\n## Resumen");
    const working = results.filter((r) => r.ok).map((r) => r.mode);
    if (developerModeMissing(s)) {
      fail("Modo desarrollador apagado: actívalo antes de imprimir.");
      md("- Modo desarrollador: **apagado**");
    }
    if (results.length) {
      if (working.length) ok(`Modos FTPS que funcionan: ${working.join(", ")}`);
      else fail("Ningún modo FTPS funcionó.");
      md(`- Modos FTPS que funcionan: ${working.join(", ") || "ninguno"}`);
    }
    if (exitCode === 0) {
      ok("Todo listo para la prueba de impresión.");
      info(
        `Siguiente paso: npm run cli -- imprimir <archivo.gcode.3mf>${working[0] && working[0] !== "basic" ? ` --modo ${working[0]}` : ""}`,
      );
    }
    return finish(lines, opts, stamp, recorder, exitCode);
  } finally {
    await conn.stop();
  }
}

async function finish(
  lines: string[],
  opts: Options,
  stamp: string,
  recorder: Recorder,
  code: number,
): Promise<number> {
  const out = resolve(opts.output ?? join("reportes", `diagnostico_${stamp}.md`));
  await mkdir(resolve(out, ".."), { recursive: true });
  const text = lines.join("\n").replaceAll(process.env.PRINTER_ACCESS_CODE || "\u0000", "********");
  await writeFile(out, `${text}\n`);
  await recorder.close();
  console.log(`\n${c.bold("Reporte:")} ${out}`);
  console.log(`${c.bold("Captura:")} ${recorder.path}`);
  return code;
}
