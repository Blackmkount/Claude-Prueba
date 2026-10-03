# CLAUDE.md — BlackForge Print

App web para que las operarias del taller BlackForge envíen archivos ya
laminados (`.gcode.3mf`) a impresoras Bambu Lab A1 por la red local.

- Plan y fases: [`docs/PLAN.md`](docs/PLAN.md) (decisiones posteriores a la aprobación en su sección 13)
- Protocolo verificado de la A1: [`docs/protocolo-a1.md`](docs/protocolo-a1.md)
- Prueba con la impresora real: [`docs/fase-1-prueba-real.md`](docs/fase-1-prueba-real.md)
- Identidad visual aprobada: [`docs/identidad/propuesta.html`](docs/identidad/propuesta.html)

**Estado actual:** Fase 1 lista contra el simulador. **Parada obligatoria:**
esperando que el dueño pruebe el CLI con su A1 real (firmware 01.08.01.00) y
envíe reporte + capturas. Luego: ajustar módulo y simulador a lo observado y
pasar a la Fase 2 (servidor).

## Cómo trabajamos

- Hablar siempre en **español** con el dueño y explicar el porqué de las decisiones.
- Trabajo por fases (ver plan). **Commit al final de cada fase** con un resumen
  breve de qué se hizo y cómo probarlo.
- Paradas obligatorias: al final de la Fase 0 (aprobación del plan, hecha) y de
  la Fase 1 (confirmación en una A1 real, pendiente).
- No dar una fase por terminada si fallan pruebas. En fases de interfaz, tomar
  capturas con Playwright a 390×844 y 1440×900, revisarlas y corregir antes de cerrar.
  Chromium está en `/opt/pw-browsers/chromium` (usar `executablePath`).
- Mantener este archivo actualizado: comandos, convenciones y lo aprendido del protocolo.

## Comandos

```bash
npm install                 # dependencias (npm workspaces)
npm test                    # todas las pruebas (Vitest): unitarias + integración con simulador
npm run typecheck           # TypeScript estricto en todo el repo
npm run sim                 # simulador: 10 A1 falsas en 127.0.0.1:18800… (--ayuda para opciones)
npm run cli -- ayuda        # CLI de prueba del protocolo
npm run cli -- diagnostico  # prueba red, TLS, MQTT, estado y FTPS sin imprimir
npm run cli -- imprimir archivo.gcode.3mf
```

- El CLI lee `.env` (o `--env otro`): `PRINTER_IP`, `PRINTER_ACCESS_CODE`,
  opcionales `PRINTER_SERIAL` (si falta, se lee del certificado),
  `PRINTER_MQTT_PORT`, `PRINTER_FTPS_PORT`, `PRINTER_TLS_VERIFY`, `PRINTER_CA_FILE`.
- Para usar el CLI con el simulador: `npm run sim` imprime el contenido de un
  `.env.sim` (con `PRINTER_CA_FILE=.sim/ca.pem`); luego `npm run cli -- estado --env .env.sim`.
- API de control del simulador: `http://127.0.0.1:18799/impresoras`
  (POST `/impresoras/<serie>/desconectar|zombi|fallar|terminar|microsd|modo-desarrollador|filamento|mañas|impresion-externa|reiniciar-estado`).
- Salidas locales ignoradas por git: `.env*` (salvo `.env.example`), `.sim/`, `capturas/`, `reportes/`.

## Estructura

```
packages/threemf    Parser de .gcode.3mf (+ src/testing.ts: constructor de archivos de prueba)
packages/printer    Módulo de impresora: TLS, MQTT (connection.ts), estado (state.ts),
                    comandos, FTPS (ftps.ts: basic-ftp + cliente propio ftps-minimal.ts),
                    filamento (filament.ts), flujo de impresión con guardas (print-job.ts)
tools/simulator     Simulador de A1: aedes + FTPS propio + máquina de estados + API de control
                    (+ src/testing.ts: flota en puertos libres con tiempos acelerados)
tools/cli           CLI de la Fase 1 (diagnostico, estado, info, subir, imprimir, pausar…)
apps/server, apps/web, packages/shared, e2e/   → Fases 2 a 5
```

## Convenciones

- TypeScript estricto en todo el repositorio (TypeScript 7, `module: NodeNext`,
  imports relativos con `.js`). Node.js 24 LTS (compatible con 22.12+).
  Los paquetes del monorepo exportan su `src/*.ts` directamente; se ejecuta con `tsx`.
- Identificadores de código en inglés; **comentarios, documentación y textos de
  interfaz en español** (interfaz: español de Colombia, trato de "tú"). Los
  textos de la interfaz viven centralizados en un archivo de textos.
- Mensajes de error para la operaria: qué pasó y qué hacer, sin códigos
  técnicos. El detalle técnico va al registro (pino) y al "Registro técnico" del admin.
  En el módulo de impresora, cada error es un `PrinterError` con `code` estable.
- El protocolo de la impresora vive **solo** en `packages/printer`, detrás de
  su interfaz (`PrinterConnection`, `uploadFile`, `startPrint`…). Nada fuera de
  ese paquete conoce MQTT ni FTPS. El CLI y el servidor usan el mismo paquete.
- Las reglas de negocio críticas (bloqueo por impresora, idempotencia, retiro
  pendiente) se implementan en el servidor y tienen pruebas; la interfaz solo
  las refleja.
- Pruebas de integración: usar `startTestFleet()` de `@blackforge/simulator/testing`
  (puertos libres, tiempos acelerados). Los archivos "grandes" de prueba deben
  usar `extraRandomBytes` (el G-code repetido se comprime a casi nada).
- Identidad: solo tema oscuro; acento cereza `#D62839` (texto blanco encima);
  Montserrat; estados con color + icono + texto. Icono de la app configurable (Fase 4).

## Seguridad (no negociable)

- Los códigos de acceso de las impresoras nunca salen del servidor (ninguna
  respuesta de la API los incluye). Reportes y capturas del CLI no los incluyen.
- PIN de operarias y contraseña de admin con hash (scrypt) y límite de intentos.
- Rutas `/api/admin/*` exigen sesión de administrador.
- La app es solo para la red local; no se expone a internet.
- No copiar código de Bambuddy (AGPL-3.0). ha-bambulab es MIT; OpenBambuAPI es documentación GFDL.

## Lo aprendido del protocolo (resumen; detalle en docs/protocolo-a1.md)

- MQTT TLS 8883, usuario `bblp`, clave = código LAN, MQTT 3.1.1, TLS 1.2,
  keepalive 30 s, **publicar siempre con QoS 1**, `client_id` único.
- Verificar TLS con las 5 CA públicas de Bambu (`bambu-ca.ts`) y
  `servername = número de serie` (el CN del certificado es la serie). Si la IP
  apunta a otra impresora, falla con `tls_serial_mismatch`.
- La A1 envía estado **parcial**: estado acumulado + `mergeReport` (arreglos con
  `id` se fusionan por id; el resto se reemplaza). `pushall` al conectar y como
  máximo cada 5 min (tras reconexión: si pasó ≥ 1 min). El estado solo es
  confiable (`stateValid`) tras un reporte **completo** posterior a la conexión.
- Vigilante: 60 s sin mensajes → `get_version`; sin respuesta en 10 s → reconectar.
- Modo desarrollador apagado: bit `0x20000000` de `print.fun` (se detecta antes de
  imprimir) o HMS `0500050000010007`.
- **Nunca** publicar `project_file` si `gcode_state` está en PREPARE, SLICING,
  RUNNING o PAUSE (`0500_4004`; en la A1 mini cancela lo que imprime).
  `startPrint` re-comprueba el estado y hace prueba de vida justo antes de publicar.
- `param` = `Metadata/plate_<N>.gcode` con la placa real del archivo.
  `task_id`/`subtask_id`/`project_id` únicos por envío (< 2³¹−1), no `"0"`.
  Si al arrancar aparece OTRO task_id (≠ "0"), es un trabajo ajeno.
- Borrar de la microSD el archivo subido al terminar/fallar/cancelar o si falla
  la subida/arranque (impresiones fantasma al encender). Si solo no se confirmó
  el arranque, NO borrar (podría estar arrancando).
- Nombres en la microSD: `bf_<idTrabajo>.3mf`. Nombre legible en `subtask_name`.
- Cancelación: `print_error = 0x0300400C` o HMS `0500_400E` (no son fallas).
- Bobina externa: `-1` en `ams_mapping`, `{ams_id:255, slot_id:0}` en `ams_mapping2`, `use_ams:false`.
- FTPS implícito 990, pasivo. Tres modos: `basic` (basic-ftp), `minimal-p`
  (propio, TLS en datos con reutilización de sesión), `minimal-c` (propio, datos
  sin cifrar). Si no llega el `226`, verificar con `SIZE`.
- Modelo: `get_version` → `project_name` `N2S` = A1, `N1` = A1 mini;
  `slice_info.config` → `printer_model_id`.
- Descubrimiento: SSDP en UDP 2021 (requiere red `host`; no funciona en Docker Desktop de Mac).
- Pendiente de confirmar en la A1 real: formato de `url`, `bed_leveling`,
  forma de `ams_mapping`, modo FTPS, si repite `task_id`, campo `fun`, `msg: 0`
  en pushall. Ver sección 7 de docs/protocolo-a1.md.
