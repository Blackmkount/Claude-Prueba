# CLAUDE.md — BlackForge Print

App web para que las operarias del taller BlackForge envíen archivos ya
laminados (`.gcode.3mf`) a impresoras Bambu Lab A1 por la red local.

- Plan y fases: [`docs/PLAN.md`](docs/PLAN.md)
- Protocolo verificado de la A1: [`docs/protocolo-a1.md`](docs/protocolo-a1.md)

**Estado actual:** Fase 0 (plan) — esperando aprobación del dueño. No hay
código de aplicación todavía.

## Cómo trabajamos

- Hablar siempre en **español** con el dueño y explicar el porqué de las decisiones.
- Trabajo por fases (ver plan). **Commit al final de cada fase** con un resumen
  breve de qué se hizo y cómo probarlo.
- Paradas obligatorias: al final de la Fase 0 (aprobación del plan) y de la
  Fase 1 (confirmación en una A1 real).
- No dar una fase por terminada si fallan pruebas. En fases de interfaz, tomar
  capturas con Playwright a 390×844 y 1440×900, revisarlas y corregir antes de cerrar.
- Mantener este archivo actualizado: comandos, convenciones y lo aprendido del protocolo.

## Convenciones

- TypeScript estricto en todo el repositorio. Node.js 24 LTS (compatible con 22).
- Identificadores de código en inglés; **comentarios, documentación y textos de
  interfaz en español** (interfaz: español de Colombia, trato de "tú" salvo que
  el dueño decida otra cosa). Los textos de la interfaz viven centralizados en
  un archivo de textos, no dispersos en componentes.
- Mensajes de error para la operaria: qué pasó y qué hacer, sin códigos
  técnicos. El detalle técnico va al registro (pino) y al "Registro técnico" del admin.
- Estructura de monorepo (espacios de trabajo de npm):
  `apps/server`, `apps/web`, `packages/shared`, `tools/simulator`, `tools/cli`, `e2e/`.
- El protocolo de la impresora vive **solo** en el módulo de impresora del
  servidor (`apps/server/src/printer/`), detrás de una interfaz limpia. Nada
  fuera de ese módulo conoce MQTT ni FTPS.
- Las reglas de negocio críticas (bloqueo por impresora, idempotencia, retiro
  pendiente) se implementan en el servidor y tienen pruebas; la interfaz solo
  las refleja.

## Comandos

_Se completan en la Fase 1 al crear el proyecto._

## Seguridad (no negociable)

- Los códigos de acceso de las impresoras nunca salen del servidor (ninguna
  respuesta de la API los incluye).
- PIN y contraseñas con hash (scrypt) y límite de intentos.
- Rutas `/api/admin/*` exigen sesión de administrador.
- La app es solo para la red local; no se expone a internet.
- No copiar código de Bambuddy (AGPL-3.0). ha-bambulab es MIT; OpenBambuAPI es documentación GFDL.

## Lo aprendido del protocolo (resumen; detalle en docs/protocolo-a1.md)

- MQTT TLS 8883, usuario `bblp`, clave = código LAN, MQTT 3.1.1, TLS 1.2,
  keepalive 30 s, **publicar siempre con QoS 1**, `client_id` único.
- Verificar TLS con la CA de Bambu y `servername = número de serie`
  (el CN del certificado es la serie).
- La A1 envía estado **parcial**: mantener estado acumulado y fusionar.
  `pushall` al conectar y como máximo cada 5 min. Vigilante: 60 s sin mensajes → reconectar.
- **Nunca** publicar `project_file` si `gcode_state` está en PREPARE, SLICING,
  RUNNING o PAUSE: el firmware lo rechaza (`0500_4004`) y en la A1 mini eso cancela la impresión en curso.
  Re-comprobar el estado justo antes de publicar.
- `param` = `Metadata/plate_<N>.gcode` con la placa real del archivo.
  `task_id`/`subtask_id`/`project_id` únicos por envío (< 2³¹−1), no `"0"`.
- Borrar de la microSD el archivo subido al terminar/fallar/cancelar o si falla
  la subida/arranque: la A1 puede arrancar sola archivos de la raíz al encenderse.
- Nombres en la microSD: `bf_<idTrabajo>.3mf`, ASCII, sin espacios.
  Nombre legible en `subtask_name`.
- Cancelación: `print_error = 0x0300400C` o HMS `0500_400E` (no son fallas).
- Sin modo desarrollador (firmware ≥ 01.08.03/05): HMS `0500050000010007`,
  los comandos de control se ignoran en silencio.
- FTPS implícito 990, pasivo. A1: puede requerir `PROT C` en el canal de datos
  y a veces no envía `226` tras `STOR` → verificar con `SIZE`.
- Modelo: `get_version` → `project_name` `N2S` = A1, `N1` = A1 mini;
  `slice_info.config` → `printer_model_id`.
- Descubrimiento: SSDP en UDP 2021 (requiere red `host` en Docker).
- Pendiente de confirmar en A1 real: formato de `url`, `bed_leveling` vs
  `bed_levelling`, forma de `ams_mapping`, modo FTPS. Ver sección 7 de docs/protocolo-a1.md.
