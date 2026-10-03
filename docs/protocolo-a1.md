# Protocolo LAN de la Bambu Lab A1 — notas verificadas

Este documento recoge lo que verifiqué en la Fase 0 contra tres implementaciones
reales. Cada dato indica su fuente. Lo marcado **[VERIFICAR EN A1 REAL]** se
confirma en la Fase 1 con una impresora tuya, y este documento se actualiza con
lo que observemos.

Fuentes (revisadas el 2026-10-03, rama principal de cada repositorio):

| Fuente | Qué es | Licencia | Uso que le damos |
|---|---|---|---|
| [OpenBambuAPI](https://github.com/Doridian/OpenBambuAPI) | Documentación comunitaria del protocolo | GFDL 1.3 (documentación) | Referencia de mensajes |
| [ha-bambulab](https://github.com/greghesp/ha-bambulab) | Integración de Home Assistant (`pybambu`) | MIT | Referencia; datos de ejemplo reales de una A1 |
| [Bambuddy](https://github.com/maziggy/bambuddy) | Gestor de granjas Bambu muy activo, con muchos usuarios de A1 | **AGPL-3.0** | Solo lectura para confirmar comportamiento. **No se copia código.** |

> Nada del código de este proyecto se copia de Bambuddy. Leímos sus comentarios
> y su lógica para confirmar hechos del protocolo (los hechos no tienen derechos
> de autor); la implementación es propia.

---

## 1. Requisitos en la impresora

- **Modo solo LAN** activado y **Modo desarrollador** activado.
- Desde el firmware 01.08.03 / 01.08.05 existe una protección de autorización:
  sin modo desarrollador, la impresora **responde consultas** (estado,
  `pushall`, `get_version`) pero **descarta en silencio** los comandos de
  control (`project_file`, `gcode_line`…). Se manifiesta como: la subida
  funciona, la impresora se queda en IDLE para siempre. Se detecta por el error
  HMS de 64 bits `0500050000010007` ("MQTT command verification failed").
  *Fuente: Bambuddy `services/bambu_mqtt.py`, constante `HMS_MQTT_VERIFY_FAILED`.*
  → La app lo detecta y le dice al administrador "Activa el Modo desarrollador".
- **microSD** insertada y formateada (FAT32/exFAT). Sin ella el FTP responde
  `553` al subir. El estado de la tarjeta llega en `home_flag` (bits
  `SD_CARD_PRESENT` y `SD_CARD_ABNORMAL`) y en el campo `sdcard`.
  *Fuente: ha-bambulab `pybambu/models.py` (`sdcard_status`).*

## 2. MQTT

| Parámetro | Valor | Fuente |
|---|---|---|
| Host / puerto | IP de la impresora, `8883`, TLS | OpenBambuAPI `mqtt.md` |
| Usuario / clave | `bblp` / código de acceso LAN | OpenBambuAPI `mqtt.md` |
| Versión | MQTT 3.1.1 | Bambuddy (`protocol=MQTTv311`) |
| TLS | TLS 1.2 (los brokers medidos rechazan 1.0/1.1/1.3) | Bambuddy, ha-bambulab (`maximum_version = TLSv1_2`) |
| Keepalive | 30 s | Bambuddy |
| QoS de publicación | **1 siempre**. Con QoS 0 la impresora ignora comandos mientras está ocupada emitiendo estado (respuestas de 20–30 s) | Bambuddy (comentario de cabecera de `bambu_mqtt.py`) |
| `client_id` | Único por conexión (incluir serie + contador) | Bambuddy |
| Mensajes en vuelo | Subir el límite de mensajes QoS 1 en vuelo; el broker de Bambu empareja PUBACK de forma irregular y con el límite por defecto la sesión se atasca tras ~20 comandos | Bambuddy (`max_inflight_messages_set(1000)`) |

### 2.1 Certificado TLS: se puede verificar, no hay que aceptarlo a ciegas

El certificado de la impresora está firmado por la CA de Bambu y su `CN` es
**el número de serie de la impresora**. El conjunto de CA públicas de Bambu
tiene 5 certificados: `BBL CA` (raíz antigua, vence en 2032) y `BBL CA2` RSA y
ECC (vencen en 2050), estas últimas también firmadas por `BBL CA`. Las incluimos
todas en `packages/printer/src/bambu-ca.ts`. Con MQTT.js basta con pasar
`ca: <CA de Bambu>` y `servername: <serie>`: Node valida la cadena **y** que el
certificado pertenece a esa impresora. *Fuente: OpenBambuAPI `tls.md` y
`examples/mqtt.js`; ha-bambulab `pybambu/certs/bambu.cert` (mismo certificado,
comprobado con `openssl`).*

Ventaja práctica para el taller: si el router reasigna IPs y dos impresoras
"se cruzan", la conexión falla con un mensaje claro en vez de enviar a la
impresora equivocada. Dejamos un interruptor por impresora para desactivar la
verificación si algún firmware no la soporta (con aviso en el registro).

### 2.2 Topics

- Estado: la impresora publica en `device/{SERIE}/report`.
- Comandos: se publican en `device/{SERIE}/request`.

### 2.3 Estado parcial (A1 y P1)

La A1, como la P1, **solo envía los campos que cambiaron**. Hay que mantener un
estado acumulado por impresora y fusionar cada mensaje (fusión profunda de
objetos; los arreglos como `ams.ams[].tray[]` se reemplazan o fusionan por `id`).
*Fuente: OpenBambuAPI `mqtt.md` (`pushing.pushall`, `print.push_status`).*

Estado completo bajo pedido:

```json
{ "pushing": { "sequence_id": "0", "command": "pushall", "version": 1, "push_target": 1 } }
```

Pedirlo al conectar y **no más de una vez cada 5 minutos** (el hardware de la
P1P se resiente; aplicamos la misma regla a la A1). Única excepción, tras una
reconexión: se permite si pasó al menos 1 minuto desde el anterior, porque sin
él no podemos saber si algo cambió mientras estábamos desconectados.

**Cuándo el estado es confiable** (`stateValid` en el módulo): hay conexión y
llegó un **reporte completo** después de la última (re)conexión. Mientras la
conexión siga viva, TCP garantiza que no se pierden reportes parciales; tras un
corte, un parcial no basta. Reconocemos el reporte completo por `msg: 0` o por
traer `gcode_state` junto con al menos 20 campos. **[VERIFICAR EN A1 REAL]**
si la respuesta a `pushall` trae `msg: 0`.

**Conexión "zombi":** en P1/A1 se ha visto que el broker deja de publicar
pero la conexión TCP sigue viva. Bambuddy fuerza reconexión si pasan 60 s sin
mensajes. Nosotros, en vez de reconectar a ciegas (una impresora quieta puede
estar callada legítimamente), tras 60 s de silencio preguntamos `get_version`;
si no responde en 10 s, reconectamos.

### 2.4 Campos que usamos

| Campo | Significado |
|---|---|
| `gcode_state` | `IDLE`, `PREPARE`, `SLICING`, `RUNNING`, `PAUSE`, `FINISH`, `FAILED` |
| `mc_percent` | Porcentaje de avance |
| `mc_remaining_time` | Minutos restantes |
| `layer_num` / `total_layer_num` | Capa actual / total |
| `nozzle_temper`, `nozzle_target_temper`, `bed_temper`, `bed_target_temper` | Temperaturas |
| `print_error` | Error de impresión de 32 bits. `0x0300400C` = "la tarea fue cancelada" (no es una falla) |
| `hms[]` | Lista de `{attr, code}`; código completo = `attr` (8 hex) + `code` (8 hex). `0500_400E` = "impresión cancelada" (no es falla) |
| `subtask_name`, `task_id`, `subtask_id` | Identidad del trabajo en curso (los usamos para reconciliar tras un reinicio) |
| `nozzle_diameter` | Diámetro de boquilla instalada (p. ej. `"0.4"`) |
| `sdcard`, `home_flag` | Estado de la microSD |
| `ams.ams[].tray[]` | Bandejas del AMS lite: `tray_type` (PLA, PETG…), `tray_color` (`RRGGBBAA`), `id` |
| `ams.tray_now` | Bandeja activa: `(ams_id*4)+tray_id`; `254` = bobina externa; `255` = ninguna |
| `vt_tray` | Bobina externa (id `254`) con su tipo y color |
| `upload` | Progreso de subida (solo para trabajos por nube; no lo usamos) |

*Fuentes: OpenBambuAPI `mqtt.md`; ha-bambulab `pybambu/mock_data/MOCK-A1.json`
(captura real de una A1 con AMS lite, firmware 01.05.00.00);
Bambuddy (`_HMS_USER_ACTION_CODES`, `_ACTIVE_PRINT_STATES`).*

### 2.5 Saber si el Modo desarrollador está activo, ANTES de imprimir

El campo `print.fun` (cadena hexadecimal) trae el bit `0x20000000`
(`MQTT_SIGNATURE_REQUIRED`): si está activo, la impresora exige comandos
firmados, es decir, el Modo desarrollador está **apagado**. Valores capturados:
`3EC1AFFF9CFF` = apagado, `3EC18FFF9CFF` = activo.
*Fuente: ha-bambulab `pybambu/const.py` (`Print_Fun_Values`) y `models.py`.*
Así la app avisa antes de subir nada, además de detectar el HMS
`0500050000010007` si llega a ocurrir. **[VERIFICAR EN A1 REAL]** que tu
firmware envía `fun`.

### 2.6 Identificar el modelo

- Por MQTT: `{"info":{"sequence_id":"0","command":"get_version"}}` → módulo
  `ota`/`esp32` con `project_name`: **`N2S` = A1**, `N1` = A1 mini.
  *Fuente: ha-bambulab `pybambu/utils.py` (`get_printer_type`).*
- En el archivo laminado: `Metadata/slice_info.config` →
  `<metadata key="printer_model_id" value="N2S"/>`.
  *Fuente: Bambuddy `services/archive.py`; `utils/printer_models.py` (`"N2S": "A1"`).*

## 3. Iniciar una impresión: `print.project_file`

Forma que usaremos (combinación de lo que envía Bambu Studio según las
capturas citadas por Bambuddy y ha-bambulab):

```json
{
  "print": {
    "sequence_id": "<n>",
    "command": "project_file",
    "param": "Metadata/plate_<N>.gcode",
    "url": "<ver 3.1>",
    "file": "<nombre en la microSD>",
    "md5": "",
    "bed_type": "auto",
    "timelapse": false,
    "bed_leveling": true,
    "auto_bed_leveling": 2,
    "flow_cali": false,
    "extrude_cali_flag": 2,
    "vibration_cali": true,
    "layer_inspect": false,
    "use_ams": true,
    "ams_mapping": [0],
    "subtask_name": "Oso x2",
    "profile_id": "0",
    "project_id": "<id único>",
    "subtask_id": "<id único>",
    "task_id": "<id único>"
  }
}
```

Diferencias encontradas entre fuentes y decisión tomada:

| Tema | Lo que dice cada fuente | Decisión |
|---|---|---|
| Nombre del campo de nivelación | OpenBambuAPI: `bed_levelling`. ha-bambulab, Bambuddy y Bambu Studio: `bed_leveling` | `bed_leveling` (lo que envía Bambu Studio). **[VERIFICAR EN A1 REAL]** |
| Nivelación "automática" | Bambu Studio manda `bed_leveling` (bool) + `auto_bed_leveling` (0 = nunca, 1 = siempre, 2 = auto) | Igual; en ajustes ofrecemos Siempre / Automática / Nunca |
| Calibración de flujo | `flow_cali` (bool) + `extrude_cali_flag` (0/1/2) | Igual |
| `param` | Siempre `plate_1` en los ejemplos | **Usar el número de placa real del archivo**: si se exporta "solo la placa 3", el G-code es `Metadata/plate_3.gcode` |
| `task_id` / `subtask_id` / `project_id` | OpenBambuAPI: siempre `"0"` en LAN | **ID único por envío**, menor que 2³¹−1. Con `"0"` el firmware P1S trata un envío nuevo como continuación del anterior fallido y no arranca. Además nos sirve para reconocer *nuestro* trabajo tras un reinicio |
| `md5` | Bambu Studio lo llena | Vacío: el firmware lo acepta como "no validar" (Bambuddy) |

### 3.1 Formato de `url` — punto abierto principal

| Fuente | Formato para A1 | Dónde se sube el archivo |
|---|---|---|
| ha-bambulab | `file:///sdcard/<ruta>` (lista `LEGACY_SDCARD_PRINTERS` incluye A1 y A1 mini) | Donde indique el usuario |
| Bambuddy | `ftp://<archivo>` + campo `file` (para todos los modelos) | Raíz de la microSD (`/<archivo>`) |
| OpenBambuAPI | `ftp:///<archivo>` o `file:///mnt/sdcard` | Raíz o `/cache/` |

**Plan:** el módulo de impresora tiene la estrategia de URL configurable. En la
Fase 1 probamos en tu A1, en este orden: `ftp://<archivo>` (Bambuddy, el más
usado en A1 hoy), `file:///sdcard/<archivo>` y `ftp:///<archivo>`, y dejamos
fijo el que funcione. **[VERIFICAR EN A1 REAL]**

### 3.2 Mapeo de filamento (`use_ams`, `ams_mapping`)

- `ams_mapping` es un arreglo indexado por **filamento del archivo** (posición
  0 = filamento 1 del proyecto) cuyo valor es la **bandeja global**
  (`ams_id*4 + slot`); `-1` = filamento no usado.
- **Bobina externa:** en el arreglo plano va `-1` (el firmware no acepta
  254/255) y `use_ams: false`. Bambu Studio además manda `ams_mapping2`
  (`[{ams_id, slot_id}]`) con `ams_id: 255` para la bobina externa en
  impresoras de una boquilla como la A1.
- Si el mapeo está mal, la impresora se pausa y no arranca.
- OpenBambuAPI describe un arreglo fijo de 5 posiciones "de derecha a
  izquierda"; Bambuddy y ha-bambulab usan un arreglo por filamento. Seguimos el
  segundo (coincide con capturas de Bambu Studio). **[VERIFICAR EN A1 REAL]**

*Fuentes: OpenBambuAPI `mqtt.md` (sección AMS Mapping); Bambuddy
`start_print()`; ha-bambulab `coordinator.py` (`_service_call_print_project_file`).*

### 3.3 Reglas de seguridad aprendidas

1. **Nunca enviar `project_file` a una impresora que no esté en IDLE, FINISH o
   FAILED.** El firmware lo rechaza con `0500_4004` ("dispositivo ocupado") y
   **en la A1 mini ese rechazo cancela la impresión en curso**. Por eso el
   servidor vuelve a comprobar el estado en vivo justo antes de publicar,
   después de la subida (que puede tardar minutos).
   *Fuente: Bambuddy, comentario en `start_print()` (#2598).*
2. **Impresiones fantasma:** P1S y A1 pueden arrancar solas, al encenderse,
   un archivo que quedó en la raíz de la microSD. Hay que **borrar el archivo
   en cuanto el trabajo termina** (completado, fallido o cancelado), si la
   subida o el arranque fallan, y hacer un barrido de archivos nuestros al
   reconectar. *Fuente: Bambuddy `main.py` (limpieza post-impresión, #374,
   #1542) y `utils/filename.py`.*
3. **Nombres de archivo** sin espacios (el firmware interpreta
   `ftp://<archivo>` como URL) y con una sola extensión `.3mf`. Usaremos
   `bf_<idTrabajo>.3mf`, ASCII puro, y pondremos el nombre legible
   ("Oso x2") en `subtask_name`, que es lo que muestra la pantalla de la impresora.

### 3.4 Pausar, reanudar, cancelar

```json
{ "print": { "sequence_id": "<n>", "command": "pause",  "param": "" } }
{ "print": { "sequence_id": "<n>", "command": "resume", "param": "" } }
{ "print": { "sequence_id": "<n>", "command": "stop",   "param": "" } }
```

QoS 1. La respuesta llega en `report` con el mismo `command` y `result`.
Tras `stop`, `gcode_state` pasa a `FAILED` con `print_error = 0x0300400C`;
así distinguimos "cancelada" de "fallida".

## 4. FTPS (subida a la microSD)

| Parámetro | Valor |
|---|---|
| Puerto | `990`, **TLS implícito** |
| Usuario / clave | `bblp` / código de acceso LAN |
| Modo | Pasivo |

Peculiaridades de la A1 (Bambuddy `services/bambu_ftp.py`):

1. **Canal de datos:** X1C/P1S exigen TLS en el canal de datos *con
   reutilización de sesión* (vsFTPd). En la A1 se han visto cuelgues con TLS en
   el canal de datos; Bambuddy intenta primero `PROT P` con reutilización y, si
   falla, cae a `PROT C` (datos sin cifrar, control cifrado) y recuerda qué
   modo funcionó para esa IP.
2. **Respuesta `226` que no llega:** tras enviar el archivo, la A1 a veces no
   confirma la transferencia (o tarda mucho). La solución es cerrar el canal de
   datos, esperar la respuesta con un tiempo límite y, si no llega o llega con
   error, **comprobar con `SIZE` que el tamaño en la microSD coincide** antes
   de darla por buena.
3. **Velocidad:** por Wi-Fi la A1 puede subir lento (Bambuddy reporta casos de
   ~75 KB/s; lo normal es bastante más). El tiempo límite de subida debe
   depender del tamaño, y el envío debe ser un trabajo del servidor (no de la
   petición del celular) con progreso visible.
4. **Códigos útiles:** `553` = no se pudo crear el archivo (sin microSD,
   tarjeta llena o mal formateada); `552` = sin espacio; `550` = no existe /
   sin permiso.

Cliente en Node: `basic-ftp` 6.x soporta TLS implícito y reutiliza la sesión
TLS en el canal de datos (`transfer.js`, `session: ... getSession()`), pero
**no permite `PROT C`**. Si en la Fase 1 la A1 real solo funciona con
`PROT C`, escribimos un cliente FTPS mínimo propio (PASV, STOR, SIZE, DELE,
LIST) dentro del módulo de impresora. **[VERIFICAR EN A1 REAL]**

## 5. Archivo `.gcode.3mf`

Es un ZIP. Contenido relevante:

| Ruta | Contenido |
|---|---|
| `Metadata/plate_N.gcode` | G-code de la placa N (si no existe ninguno, el archivo **no está laminado**) |
| `Metadata/plate_N.png` | Miniatura de la placa |
| `Metadata/slice_info.config` | XML con `<plate>` → `<metadata key="index">`, `prediction` (segundos), `weight` (gramos), `printer_model_id`, `nozzle_diameters`, `curr_bed_type`; y `<filament id type color used_g used_m tray_info_idx/>` |

Solo cuentan los filamentos con `used_g > 0`.
*Fuente: Bambuddy `services/archive.py` (`_parse_slice_info`).*

## 6. Descubrimiento en la red

Las impresoras Bambu emiten anuncios SSDP `NOTIFY` por **UDP 2021** (no el
1900 estándar), con cabeceras `USN: <serie>`, `DevModel.bambu.com: <modelo>`,
`DevName.bambu.com: <nombre>` y la IP de origen. También responden a
`M-SEARCH`. *Fuente: Bambuddy `services/discovery.py`.*

En Docker esto solo funciona con red `host` (Linux). Por eso el descubrimiento
es una ayuda opcional y la entrada manual (IP + serie + código) siempre está.

## 7. Pendiente de verificar en la Fase 1 con tu A1

- [ ] Formato de `url` que acepta tu firmware (sección 3.1).
- [ ] `bed_leveling` vs `bed_levelling` (sección 3).
- [ ] Forma de `ams_mapping` con AMS lite y con bobina externa (sección 3.2).
- [ ] Modo FTPS del canal de datos (`PROT P` con reutilización o `PROT C`) y si llega el `226`.
- [ ] Velocidad real de subida en tu red.
- [ ] Verificación del certificado con la CA de Bambu y `servername = serie`.
- [ ] Qué reporta la impresora al terminar, al cancelar y al reiniciarse con una pieza en la cama.
- [ ] Si una subcarpeta en la microSD (p. ej. `/blackforge/`) funciona y evita las impresiones fantasma.
- [ ] Si la A1 repite nuestro `task_id`/`subtask_id` en su estado al arrancar (si no, confirmamos por cambio de estado).
- [ ] Si llega el campo `fun` y con qué valor.
- [ ] Si la respuesta a `pushall` trae `msg: 0`.
- [ ] Cuánto silencio hay en reposo (para el vigilante de 60 s).

Estas preguntas se responden con el CLI (`npm run cli -- diagnostico` e
`imprimir`); ver [`docs/fase-1-prueba-real.md`](./fase-1-prueba-real.md).
