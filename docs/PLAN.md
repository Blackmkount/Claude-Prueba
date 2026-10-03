# BlackForge Print — Plan de trabajo

> Estado: **Fase 0, pendiente de tu aprobación.** No se escribe código de la
> aplicación hasta que apruebes este plan y respondas las preguntas de la
> sección 12.

## 1. Qué vamos a construir, en una frase

Un servidor pequeño en el taller que guarda tus archivos ya laminados, habla con
las A1 por la red local y sirve una app web para que una operaria, desde el
celular, elija **producto → cantidad → impresora libre → confirmar** y la
impresión arranque, sin poder enviarla a una impresora ocupada o con una pieza
en la cama.

Criterios de "terminado" (los de tu documento, sin cambios):

1. Una operaria completa el envío en el celular en menos de 30 s, sin ayuda.
2. Es imposible —desde la interfaz o llamando a la API— enviar a una impresora
   ocupada o pendiente de retiro.
3. Tú agregas un producto con sus archivos por cantidad en menos de 2 minutos.
4. El estado se actualiza en vivo y se recupera solo tras un corte de red o un reinicio.
5. Todas las pruebas pasan, arranca con un solo comando y el README permite
   instalarla desde cero.

## 2. Lo que encontré al verificar el protocolo

El detalle, con fuentes, está en [`docs/protocolo-a1.md`](./protocolo-a1.md).
Lo que cambia o afina tu punto de partida:

| # | Hallazgo | Consecuencia en el diseño |
|---|---|---|
| 1 | Si se envía `project_file` a una impresora ocupada, el firmware lo rechaza y **en la A1 mini ese rechazo cancela la impresión en curso**. | El servidor vuelve a comprobar el estado en vivo **justo antes de publicar** el comando, no solo al inicio del envío (la subida puede tardar minutos). |
| 2 | **Impresiones fantasma:** la A1 puede arrancar sola, al encenderse, un archivo que quedó en la raíz de la microSD. | Borramos el archivo de la microSD **en cuanto termina** el trabajo (o si falla la subida o el arranque) y barremos nuestros archivos al reconectar. Descarto la idea de dejar archivos en caché en la tarjeta para reimprimir más rápido: el riesgo no lo vale. |
| 3 | Desde el firmware 01.08.03/05, sin Modo desarrollador la impresora **acepta la subida pero ignora en silencio** la orden de imprimir. | Detectamos el error específico y mostramos "Activa el Modo desarrollador en esta impresora". |
| 4 | El certificado TLS de la impresora **sí se puede verificar**: lo firma la CA de Bambu y su nombre es el número de serie. | Verificamos cadena + serie. Si el router cruza dos IPs, la app se niega a conectar en vez de mandar a la impresora equivocada. |
| 5 | Las fuentes **no coinciden** en el formato de `url` para la A1 (`ftp://archivo` vs `file:///sdcard/archivo`) ni en el nombre `bed_leveling`/`bed_levelling`. | Estrategia configurable; la Fase 1 prueba las variantes en tu A1 y fija la que funcione. |
| 6 | El FTPS de la A1 tiene dos mañas: puede colgarse con TLS en el canal de datos, y a veces no confirma la subida (`226`). Puede ser lenta por Wi-Fi. | Tiempo límite proporcional al tamaño, verificación por `SIZE`, plan B de canal de datos sin cifrar, y el envío corre como **trabajo del servidor** con progreso (la operaria puede bloquear el celular). |
| 7 | `task_id = "0"` (lo que sugiere la documentación para LAN) hace que algunos firmwares confundan un envío nuevo con el anterior. | ID único por envío. Además nos permite reconocer *nuestro* trabajo tras un reinicio. |
| 8 | El G-code no siempre es `plate_1`: si exportas solo la placa 3, es `plate_3.gcode`. | El parser detecta la placa real y la usa. |
| 9 | Publicar siempre con QoS 1; con QoS 0 la impresora tarda 20–30 s en hacer caso. A veces la conexión queda "zombi" (TCP vivo, sin mensajes). | QoS 1 y vigilante de silencio: 60 s sin mensajes → reconexión. |
| 10 | El descubrimiento automático usa SSDP en UDP **2021**, y en Docker solo funciona con red `host` en Linux. | Descubrimiento como ayuda opcional; la entrada manual siempre está. |

Licencias: Bambuddy es AGPL-3.0, así que lo usé solo para confirmar
comportamientos, sin copiar código. ha-bambulab es MIT. El certificado de la CA
de Bambu es público.

## 3. Decisiones de arquitectura (y por qué)

Mantengo tu propuesta. Estas son las elecciones concretas y los **tres puntos
donde me aparto** (marcados con ⚠️), para que los apruebes.

### 3.1 Estructura

Un solo repositorio con espacios de trabajo de npm:

```
apps/server      Servidor Fastify: API, módulo de impresoras, trabajos, SSE
apps/web         App React (operaria + administrador)
packages/shared  Tipos y validaciones (zod) que comparten servidor y web
tools/simulator  Simulador de A1 (MQTT + FTPS falsos)
tools/cli        Script de prueba del protocolo (Fase 1)
e2e/             Pruebas de extremo a extremo con Playwright
docs/            Plan, protocolo, decisiones
```

**Por qué:** un solo lugar, un solo `npm install`, y los tipos de la API se
comparten entre servidor y web para que un cambio en uno rompa la compilación
del otro en vez de fallar en el taller.

### 3.2 Tecnologías

| Pieza | Elección | Por qué |
|---|---|---|
| Lenguaje | TypeScript estricto en todo | Lo pediste; atrapa errores antes de llegar a la impresora. |
| Runtime | ⚠️ **Node.js 24 LTS ("Krypton")** | Hoy (octubre de 2026) la LTS activa es la 24; la 22 está en mantenimiento hasta abril de 2027. El código funcionará también en 22. |
| Servidor | Fastify 5 | Ligero, rápido, validación de esquemas integrada, buen registro (pino). |
| Base de datos | SQLite con `better-sqlite3` + Drizzle ORM (migraciones versionadas) | `better-sqlite3` es **síncrono**: una transacción "comprobar que la impresora está libre + crear el trabajo" no puede intercalarse con otra petición. Es la base más simple y fiable para la regla de bloqueo. Drizzle da tipos y migraciones sin un ORM pesado. |
| MQTT | `mqtt` (MQTT.js 5) | El cliente MQTT más usado en Node; soporta TLS con CA propia y `servername`, que es justo lo que necesitamos para verificar el certificado. |
| FTPS | `basic-ftp` 6, con plan B | Soporta TLS implícito y reutiliza la sesión TLS en el canal de datos. No soporta `PROT C`: si tu A1 lo necesita, escribo un cliente FTPS mínimo propio (unas 250 líneas, solo PASV/STOR/SIZE/DELE/LIST) dentro del módulo de impresora. Lo sabremos en la Fase 1. |
| Lectura de `.gcode.3mf` | `yauzl` (ZIP por streaming) + `fast-xml-parser` | No carga archivos de 50 MB en memoria; tolera ZIPs grandes. |
| Imágenes | `sharp` | Genera versiones WebP de varios tamaños y un marcador de posición diminuto, para que la galería cargue rápido y sin saltos. Tiene binarios para x86 y ARM (Raspberry Pi). |
| Estado en vivo | Server-Sent Events (SSE) | Solo necesitamos servidor → celular; las órdenes van por peticiones normales. SSE funciona sobre HTTP simple, se reconecta solo y es más simple de depurar que WebSocket. |
| Frontend | React 19 + Vite + Tailwind 4 + React Router + TanStack Query | TanStack Query maneja caché, reintentos y estados de carga/error de forma uniforme; SSE invalida la caché cuando cambia algo. |
| Fuentes tipográficas | Incluidas en la app (no Google Fonts en vivo) | El celular no siempre tendrá internet; todo se sirve desde el servidor del taller. |
| Pruebas | Vitest (unitarias/integración) + Playwright (extremo a extremo) | Estándar, rápidas, Playwright ya está disponible. |
| Despliegue | Un contenedor Docker + Docker Compose, volumen `/data` | Lo pediste. Red `host` en Linux para el descubrimiento; en otros sistemas, puertos publicados y entrada manual. |

### 3.3 ⚠️ El administrador entra con contraseña, no con PIN

Las operarias entran con nombre + PIN de 4 dígitos, como pediste. Para el
administrador propongo **contraseña** (mínimo 10 caracteres), creada en un
asistente la primera vez que arranca el servidor.

**Por qué:** un PIN de 4 dígitos tiene 10.000 combinaciones; está bien para
saber quién envió una impresión, pero la cuenta de administrador puede borrar
el catálogo y cambiar impresoras. Con el límite de intentos ya es difícil de
adivinar, pero la diferencia de esfuerzo para ti es mínima (la sesión dura
meses en tu celular).

### 3.4 ⚠️ El envío es un trabajo del servidor, no una petición del celular

Cuando la operaria desliza "Enviar", el servidor crea un **trabajo** y lo lleva
de principio a fin (subir → iniciar → confirmar que arrancó). El celular solo
muestra el progreso por SSE.

**Por qué:** la subida a la A1 por Wi-Fi puede tardar más de un minuto. Si
dependiera de la petición del celular, bloquear la pantalla o perder el Wi-Fi a
mitad dejaría la impresora en un estado incierto. Así, la operaria puede
guardar el celular y la pantalla de Impresoras le muestra el resultado.

### 3.5 Datos en disco

```
/data/blackforge.db          Base de datos SQLite (modo WAL)
/data/files/<sha256>.3mf     Archivos laminados (nombre = huella, sin duplicados)
/data/images/<id>/...        Fotos de productos en varios tamaños
/data/logs/                  Registro técnico (rotativo)
```

## 4. Modelo de dominio

### 4.1 Entidades

- **Usuario:** nombre, rol (operaria / admin), PIN o contraseña (con hash), activo.
- **Producto:** nombre, categoría, notas, foto, activo/oculto, orden.
- **Archivo laminado:** producto, cantidad, archivo, placa, tiempo estimado,
  gramos, filamentos (tipo + color + gramos), modelo de impresora, diámetro de
  boquilla, miniatura. Única combinación (producto, cantidad).
- **Impresora:** nombre, IP, serie, código de acceso (solo en el servidor, nunca
  llega al navegador), puertos (por defecto 8883/990; configurables para el
  simulador), verificación TLS, activa.
- **Trabajo (envío):** quién, qué archivo, qué impresora, opciones usadas,
  clave de idempotencia, ID de tarea enviado a la impresora, nombre en la
  microSD, estado y marcas de tiempo de cada paso, resultado, error técnico.
- **Retiro pendiente:** por impresora, qué trabajo lo causó y quién confirmó el retiro y cuándo.
- **Ajustes:** opciones de impresión por defecto, zona horaria (America/Bogota).

### 4.2 Estados de un trabajo

```
creado → subiendo → iniciando → imprimiendo ⇄ pausado → completado
                                                     ↘ fallido
                                                     ↘ cancelado
   (antes de arrancar) → error_subida | error_inicio | no_confirmado
```

### 4.3 Estado visible de una impresora (lo que ve la operaria)

Se calcula en el servidor, en este orden de prioridad:

| Estado | Condición | Color | Icono | ¿Se puede elegir? |
|---|---|---|---|---|
| **Sin conexión** | Sin MQTT o sin mensajes en 60 s | Gris | Enchufe tachado | No |
| **Con error** | Error HMS activo, sin microSD, firmware sin modo desarrollador, boquilla incompatible | Rojo | Triángulo de alerta | No |
| **Enviando** | Hay un trabajo nuestro subiendo o iniciando | Azul | Flecha de subida | No |
| **Imprimiendo / Preparando / En pausa** | `gcode_state` = RUNNING, PREPARE, SLICING o PAUSE (nuestro o externo) | Azul / violeta en pausa | Boquilla / pausa | No |
| **Esperando retiro de pieza** | Terminó un trabajo (completado, fallido o cancelado, nuestro o externo) y nadie ha confirmado el retiro | Amarillo | Mano con caja | No |
| **Libre** | Conectada, en IDLE/FINISH/FAILED, sin retiro pendiente, sin errores | Verde | Check | **Sí** |

Nota: también pido retiro tras una impresión **fallida o cancelada**, porque
puede quedar material en la cama. Y si alguien imprime desde Bambu Studio o la
pantalla de la impresora, la app lo muestra como "Imprimiendo (externo)" y al
terminar también exige el retiro.

## 5. Reglas que garantiza el servidor

| Regla | Cómo se garantiza |
|---|---|
| Nunca enviar a una impresora que no esté Libre | (1) Candado en memoria por impresora; (2) dentro de una transacción síncrona se comprueba el estado visible y se crea el trabajo; (3) índice único parcial en la base: **una sola fila activa por impresora**. El segundo envío recibe *"Otra persona acaba de enviar una impresión a Ender. Elige otra impresora."* |
| Re-comprobar antes de publicar | Tras la subida, y justo antes de publicar `project_file`, se verifica de nuevo el estado en vivo. Si cambió (alguien imprimió desde la pantalla), se aborta y se borra el archivo de la microSD. |
| Doble toque o reintento de red → una sola impresión | El celular genera una **clave de idempotencia** al abrir la pantalla de confirmación. Índice único en la base: la misma clave devuelve el mismo trabajo; la misma clave con datos distintos se rechaza. |
| Confirmar que arrancó | Tras publicar, se espera que la impresora reporte PREPARE/RUNNING con **nuestro** ID de tarea (hasta ~90 s). Si no, el trabajo queda "no confirmado", se avisa y la impresora no se marca como Libre hasta revisar. |
| Reinicio del servidor | La base es la fuente de verdad de trabajos y retiros pendientes. Al reconectar, `pushall` + comparación del ID de tarea: si terminó mientras el servidor estaba apagado, se cierra el trabajo con su resultado y queda "Esperando retiro". |
| Reconexión MQTT | Espera creciente con variación aleatoria (1 s → 60 s máx.). Cada impresora tiene su propia conexión y su propio manejo de errores: una apagada no afecta a las demás. |
| Limpieza de la microSD | Se borra `bf_<id>.3mf` al terminar/fallar/cancelar el trabajo, si falla la subida o el arranque, y en un barrido al reconectar (solo archivos con nuestro prefijo y que no pertenezcan a un trabajo activo). |
| Comandos de pausa/reanudar/cancelar | Solo si la impresora está en el estado compatible; registran quién y cuándo. |
| Seguridad | Códigos de acceso solo en el servidor: ninguna respuesta de la API los incluye (hay una prueba que lo verifica). La copia de seguridad sí los contiene, así que se guarda como un archivo sensible. PIN y contraseñas con hash (scrypt). Límite de intentos: 5 fallos → bloqueo de 5 minutos, creciente. Rutas de administración exigen sesión de admin. Cookies `HttpOnly`, `SameSite=Lax`. La documentación dice claramente que **no se expone a internet**. |

## 6. API (resumen)

```
POST /api/auth/login              { userId, pin } | { userId, password }
POST /api/auth/logout
GET  /api/auth/me
GET  /api/users/public            Lista de nombres para la pantalla de entrada

GET  /api/catalog                 Productos activos con al menos un archivo
GET  /api/catalog/:productId      Detalle + cantidades disponibles + metadatos
GET  /api/printers                Estado visible de cada impresora (sin códigos)
GET  /api/events                  SSE: printer.updated, job.updated
POST /api/jobs                    { fileId, printerId, idempotencyKey, confirmations }
GET  /api/jobs/:id
POST /api/printers/:id/pickup     "Ya retiré la pieza"
POST /api/printers/:id/pause | resume | cancel

/api/admin/products  …/files  …/printers (+ /test, /discover)  …/users
/api/admin/history (+ CSV)  …/settings  …/backup  …/logs
```

## 7. Interfaz

### 7.1 Pantallas de la operaria (celular primero)

1. **Entrada:** lista de nombres en tarjetas grandes → teclado numérico propio
   de 4 dígitos (botones de 64 px). Sesión de 180 días renovable.
2. **Galería:** cuadrícula de 2 columnas en celular (3–5 en tablet/computador),
   fotos cuadradas grandes, nombre debajo. Buscador y chips de categoría fijos
   arriba. Marcador de posición del color dominante de la foto + desenfoque,
   tamaños reservados (cero saltos de diseño).
3. **Producto:** foto grande, selector de cantidad como botones grandes
   ("1", "2", "4"…) solo con las disponibles; si hay una sola, ya viene
   seleccionada. Debajo: tiempo, gramos, filamento (tipo + muestra de color).
4. **Impresora:** tarjetas con estado en vivo (color + icono + texto). Las no
   libres se ven pero no se pueden tocar, con el motivo. Aviso claro si el
   filamento cargado no coincide (tipo o color) con el del archivo.
5. **Confirmación:** resumen + dos casillas obligatorias + botón **mantener
   presionado 1,2 s** con anillo de progreso (más accesible que deslizar con una
   mano ocupada; si prefieres deslizar, se cambia).
6. **Envío:** pasos animados *Subiendo archivo (porcentaje) → Iniciando →
   Imprimiendo*, pantalla de éxito, o error en español sencillo con qué hacer.
7. **Impresoras:** todas con estado en vivo; botón "Ya retiré la pieza";
   pausar / reanudar / cancelar con confirmación (cancelar exige mantener presionado).

Navegación inferior con 3 pestañas: **Imprimir · Impresoras · Yo**
(el administrador ve una cuarta: **Admin**).

Recorrido objetivo: galería → producto (1 toque) → cantidad (0–1) → impresora
(1) → 2 casillas → mantener 1,2 s ≈ **10–15 s**, holgado bajo los 30 s.

### 7.2 Panel del administrador

Productos (crear/editar/ocultar/borrar, foto desde celular o desde la
miniatura), archivos por cantidad (arrastrar varios; extracción automática;
sugerencia de cantidad por `_x2`, `x2`, `2u`, `2pcs`; rechazo de 3MF sin
laminar; aviso de otro modelo), impresoras (probar conexión con diagnóstico
paso a paso: red → TLS → serie → MQTT → FTPS → microSD; descubrimiento),
usuarios, historial con totales y CSV, ajustes, copia de seguridad,
**registro técnico** (aquí quedan los códigos y detalles que la operaria no ve)
y un **código QR** para abrir la app en un celular nuevo.

### 7.3 Identidad visual (propuesta preliminar, sujeta a tu respuesta)

Si no tienes logo ni colores, propongo "forja moderna":

- **Superficies:** carbón y hierro (`#0E0E10`, `#17171A`, `#222226`), bordes finos.
- **Un solo acento cálido:** "brasa", naranja incandescente (`#FF5A1F`;
  `#D9480F` en tema claro para mantener contraste AA). Reservado para la acción principal.
- **Tipografía:** *Barlow Condensed* (títulos, industrial, se lee bien grande)
  + *Barlow* (texto), números tabulares para tiempos y porcentajes.
- **Estados:** verde, azul, violeta, amarillo, rojo, gris, siempre con icono y
  texto (el amarillo de "retiro" es distinto del naranja de acción).
- **Tema claro** para el taller iluminado, con cambio automático o manual.

Antes de aplicarla a toda la app te muestro una página de muestra (paleta,
tipografía, tarjeta de producto, tarjeta de impresora en cada estado, botón de
envío) y ajustamos.

### 7.4 Instalable sin service worker

- `manifest.webmanifest` + iconos + `apple-touch-icon` + metaetiquetas de iOS.
- **iPhone (Safari):** "Agregar a inicio" funciona por HTTP y abre a pantalla
  completa, con icono y nombre propios.
- **Android (Chrome):** por HTTP, Chrome crea un **acceso directo** con icono y
  nombre, pero lo abre como pestaña (con barra de dirección), porque la
  instalación completa exige HTTPS. Si te importa, más adelante podemos servir
  HTTPS en la red local con un certificado propio (requiere instalarlo en cada
  celular). Lo verificamos en la Fase 3 con un teléfono real.
- La app no depende de un service worker para nada.

### 7.5 Otros principios

Objetivos táctiles ≥ 48 px, texto base 17 px, contraste AA en ambos temas,
movimiento con propósito (y desactivado con "reducir movimiento"), estados de
carga/vacío/error diseñados en cada pantalla, textos en español de Colombia
centralizados en un archivo. Capturas con Playwright a 390×844 y 1440×900 en
cada fase de interfaz, revisadas antes de darla por terminada.

## 8. Simulador de A1

Un proceso que levanta N impresoras falsas, cada una con:

- **Broker MQTT con TLS** (`aedes`), usuario `bblp` + código, que publica
  estado parcial como la A1 real (solo campos cambiados), responde a
  `pushall`, `get_version`, `project_file`, `pause`, `resume`, `stop`.
- **Servidor FTPS implícito propio** (sobre `tls` de Node), para poder
  reproducir las mañas reales: exigir reutilización de sesión, no enviar `226`,
  subir lento, responder `553` (sin microSD).
- **CA propia generada al arrancar** y certificado con `CN = serie`, para
  probar la verificación TLS igual que con la real.
- **Máquina de estados:** IDLE → PREPARE → RUNNING (progreso acelerado, capas,
  temperaturas, tiempo restante) → FINISH; pausa, cancelación
  (`print_error 0x0300400C`), fallos (HMS), rechazo si está ocupada (`0500_4004`),
  error de "modo desarrollador desactivado", AMS lite con bandejas configurables.
- **API de control HTTP** para pruebas: provocar desconexión, fallo, conexión
  zombi, terminar ya, cambiar filamento, quitar la microSD.
- Cada impresora escucha en su propio puerto (`127.0.0.1:18883`, `:18990`, …),
  por eso los puertos de impresora son configurables.

Lo ajustaremos con lo que observemos en tu A1 en la Fase 1.

## 9. Pruebas

**Unitarias (Vitest):** parser de `.gcode.3mf` (válido, sin laminar, otro
modelo, varias placas, placa ≠ 1, ZIP corrupto), sugerencia de cantidad por
nombre, fusión de estado parcial, cálculo del estado visible, coincidencia de
filamento y mapeo AMS, reglas del servidor (bloqueo, idempotencia, transiciones
de estado, reconciliación tras reinicio), límite de intentos de PIN.

**Integración (Vitest + simulador):** módulo de impresora contra el simulador
(conexión, reconexión con espera creciente, subida con y sin `226`, arranque,
limpieza de microSD, conexión zombi).

**Extremo a extremo (Playwright, 390×844, contra el simulador):**

1. Flujo completo de la operaria: entrar → elegir → confirmar → imprime →
   termina → "Esperando retiro" → "Ya retiré la pieza" → Libre.
2. Dos sesiones envían a la misma impresora a la vez: una gana, la otra recibe
   el mensaje claro.
3. Doble toque / reintento: una sola impresión.
4. La impresora se desconecta a mitad del envío: mensaje útil, nada queda
   colgado, la microSD queda limpia al volver.
5. Reinicio del servidor durante una impresión: el estado se recupera y el
   retiro pendiente se conserva.
6. Panel: subir un 3MF sin laminar → rechazo claro; archivo de otro modelo → aviso.
7. API directa: `POST /api/jobs` a una impresora ocupada o pendiente de retiro → rechazo.

Todas se corren antes de cerrar cada fase.

## 10. Fases

Cada fase termina con un commit, un resumen y cómo probarla tú.

| Fase | Entregable | Cómo la pruebas tú |
|---|---|---|
| **0. Investigación y plan** (esta) | `docs/PLAN.md`, `docs/protocolo-a1.md`, `CLAUDE.md` | Leer y aprobar; responder preguntas. |
| **1. Prueba del protocolo** | Simulador básico + CLI `npm run cli -- status/upload/print/pause/stop` que habla con una impresora (real o simulada) usando `.env`. Módulo de impresora inicial con pruebas. | Primero ves el CLI contra el simulador; luego te doy pasos exactos para tu A1 con tu `.env`. **Me detengo hasta que confirmes que imprimió**, y ajusto simulador y documentación a lo observado. |
| **2. Servidor** | Base de datos y migraciones, API, módulo de impresoras completo, trabajos, reglas, SSE, reconciliación, limpieza de microSD, simulador completo. | Pruebas automáticas + recorrido por la API con ejemplos `curl`. |
| **3. Interfaz de la operaria** | Primero la muestra de identidad visual para tu visto bueno; luego entrada, galería, producto, impresora, confirmación, envío, impresoras. Capturas revisadas. | Abrir en tu celular contra el simulador (o tu A1). |
| **4. Panel del administrador** | Productos, archivos, impresoras, usuarios, historial/CSV, ajustes, copia de seguridad, registro técnico. | Crear un producto con 3 cantidades en < 2 min. |
| **5. Pulido y entrega** | Suite e2e completa, Docker + Compose, README en español, revisión de accesibilidad y rendimiento. | Instalar desde cero siguiendo el README. |

## 11. Riesgos y cómo los mitigamos

| Riesgo | Mitigación |
|---|---|
| El firmware de tu A1 no acepta el formato de `url` que esperamos | Estrategia configurable; Fase 1 prueba las 3 variantes conocidas. |
| FTPS de la A1 incompatible con `basic-ftp` | Plan B: cliente FTPS mínimo propio, aislado en el módulo de impresora. |
| Una actualización de firmware cambia el protocolo | Todo el protocolo vive en un módulo con interfaz limpia y pruebas contra el simulador; el registro técnico guarda los mensajes crudos recientes para diagnosticar. |
| Subidas lentas por Wi-Fi | Trabajo del servidor con progreso; recomendación en el README de buena señal Wi-Fi para las impresoras (o IP fija + 2,4 GHz estable). |
| Celulares Android sin modo "app" por HTTP | Acceso directo con icono; HTTPS local como opción posterior. |
| Docker en Mac/Windows sin red `host` | Entrada manual de impresoras (el descubrimiento es opcional). |

## 12. Preguntas

### Bloqueantes (te las hago aparte con opciones)

1. **¿Cuántas A1 tienes y cuáles usan AMS lite?** Cambia el mapeo de filamento
   y cómo se avisa la diferencia de filamento.
2. **¿En qué equipo correrá el servidor?** (Raspberry Pi, mini PC con Linux,
   Mac, PC con Windows). Cambia la arquitectura de la imagen Docker, si hay
   descubrimiento automático y las instrucciones del README.
3. **¿Tienes logo y colores de marca?** Si no, aplico la propuesta de la
   sección 7.3 tras mostrártela.

### No bloqueantes (decido esto si no me dices otra cosa)

| Tema | Mi decisión por defecto |
|---|---|
| Trato en la interfaz | **Tú** ("Elige una impresora"), como Nequi o Rappi. Si prefieres **usted**, se cambia en un solo archivo. |
| Botón final | Mantener presionado 1,2 s (en vez de deslizar). |
| Filamento distinto al del archivo | Aviso claro + confirmación extra, no bloqueo (como pediste). Boquilla de otro diámetro sí **bloquea**: la operaria no puede arreglarlo y la pieza saldría mal. |
| Archivos con varias placas laminadas | Al subir, eliges cuál placa usar (una placa = una cantidad). |
| Retiro tras fallo o cancelación | También exige "Ya retiré la pieza" (puede quedar material en la cama). |
| Opciones de impresión por defecto | Nivelación automática, calibración de vibración sí, flujo automático, timelapse no. |
| Versión de firmware | Anótala para la Fase 1 (Ajustes → Firmware en la pantalla de la A1); no la necesito ahora. |
