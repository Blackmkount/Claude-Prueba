# BlackForge Print — Plan sobre Bambuddy

> Estado: **Fase 1 (revisada)** — validar Bambuddy con la A1 real.
> Base: Bambuddy `main` en el commit `ecddbf2b` (2 de octubre de 2026).
> El trabajo anterior en TypeScript (plan original, módulo de impresora,
> simulador y CLI) quedó archivado en la rama `archivo/typescript`.

## 1. La decisión y por qué

El dueño decidió partir de Bambuddy en vez de construir todo desde cero.
Razones:

- Bambuddy ya resuelve la parte más riesgosa (el protocolo con las
  impresoras) y la prueban miles de usuarios con A1. El primer intento con
  nuestro código se detuvo en tu A1 por un detalle del protocolo (los acuses
  MQTT) que Bambuddy ya maneja.
- Trae un panel de administración muy completo: lo usaremos como el panel del
  administrador en vez de construir uno.
- Lo que falta es concreto y acotado: el modo taller para las operarias y el
  catálogo de productos con variantes de cantidad.

Lo que implica:

- **Licencia AGPL-3.0** (ver `CLAUDE.md`): enlace «Código fuente» en la app.
- **Servidor en Python** (FastAPI + SQLAlchemy); interfaz en React + TypeScript.
- **Cambios aditivos** para poder seguir trayendo las actualizaciones de
  Bambuddy (ver «Regla de oro» en `CLAUDE.md`).

## 2. Requisitos frente a Bambuddy

| Requisito del documento original | Bambuddy | Qué hacemos |
|---|---|---|
| Conexión LAN (MQTT/FTPS), varias A1, estado en vivo, reconexión | ✅ | Usar tal cual |
| AMS lite y bobina externa, mapeo de filamento | ✅ | Usar; mostrar el aviso de filamento en el modo taller |
| Nunca enviar a una impresora ocupada | ✅ (guarda en el programador) | Repetir la comprobación en nuestro endpoint |
| «Esperando retiro de pieza» que sobrevive a reinicios | ✅ («cama despejada», `require_plate_clear`) | Activarlo por defecto; botón «Ya retiré la pieza» en el modo taller |
| Borrar archivos de la microSD (impresiones fantasma) | ✅ | Usar tal cual |
| Pausar, reanudar, cancelar | ✅ | Botones con confirmación en el modo taller |
| Usuarios, grupos y permisos | ✅ (grupos y +100 permisos) | Grupo «Operarias» con permisos mínimos |
| Historial, estadísticas, exportar | ✅ (archivo de impresiones, estadísticas) | Agregar totales por producto (Fase 3) |
| Copia de seguridad | ✅ | Usar tal cual |
| Español | ✅ (incluye `es`) | Revisar y ajustar a español de Colombia |
| Tema con acento | ✅ (estilo, fondo, acento) | Identidad BlackForge: oscuro, cereza, Montserrat |
| Docker | ✅ (imagen para ARM64) | En Mac: puertos publicados (Docker Desktop no tiene red `host`) |
| **Galería de productos con variantes de cantidad** | ❌ (hay biblioteca, proyectos y lotes) | **Construir** (Fase 3) |
| **Flujo de la operaria en < 30 s desde el celular** | ❌ | **Construir el modo taller** (Fase 4) |
| **Entrada con nombre + PIN de 4 dígitos** | ❌ (usuario + contraseña, 2FA, SSO) | **Construir** (Fase 4) |
| **Doble toque o reintento no imprime dos veces** | ❌ (la cola no tiene clave de idempotencia) | **Construir** en nuestro endpoint (Fase 4) |
| Instalable en el celular | ~ (tiene manifiesto e iconos) | Manifiesto propio del modo taller, icono configurable |
| Simulador para probar sin impresoras | ❌ | Adaptar nuestro simulador archivado (Fase 1b) |

## 3. Arquitectura de lo que añadimos

```
backend/app/blackforge/
  models.py        Producto, VarianteDeCantidad (→ archivo de la biblioteca de Bambuddy + placa),
                   PinDeOperaria (→ usuario de Bambuddy), Envio (clave de idempotencia → ítem de cola)
  routes.py        /blackforge/catalogo, /blackforge/envios, /blackforge/auth/pin …
  services.py      reglas: impresora libre, idempotencia, creación del ítem de cola
frontend/src/blackforge/
  pages/           modo taller: entrada, galería, producto, impresora, confirmación, envío, impresoras
  admin/           pantallas de catálogo dentro del panel de Bambuddy
  i18n/            textos es-CO (+ en de respaldo)
  theme/           identidad BlackForge
backend/tests/blackforge/ y frontend/src/blackforge/__tests__/
blackforge/        documentación y herramientas (simulador)
```

Claves del diseño:

- **Los archivos laminados viven en la biblioteca de Bambuddy**: se suben con
  su gestor de archivos (que ya extrae miniaturas y metadatos). Nuestro
  catálogo solo guarda «producto → variantes (cantidad, archivo, placa)».
- **La operaria entra con nombre + PIN**: nuestro endpoint valida el PIN (con
  hash y límite de intentos) y emite el mismo tipo de sesión que Bambuddy para
  un usuario del grupo «Operarias». A partir de ahí, los permisos los controla
  Bambuddy.
- **Enviar = crear un ítem de cola de Bambuddy** para esa impresora, para
  ahora, con «cama despejada» exigida. Nuestro endpoint añade la clave de
  idempotencia y comprueba antes que la impresora esté libre. El programador de
  Bambuddy sube el archivo, arranca la impresión y limpia la microSD.
- **Estado en vivo** con el websocket de Bambuddy.

## 4. Puntos de enganche con el código de Bambuddy

Se mantendrán al mínimo y marcados con `BLACKFORGE:`. Previstos:

| Archivo de Bambuddy | Cambio |
|---|---|
| `backend/app/main.py` | Importar y registrar el router de `backend/app/blackforge` |
| `frontend/src/App.tsx` (o el enrutador) | Montar las rutas del modo taller |
| `frontend/src/main.tsx` | Cargar los textos y el tema de BlackForge |
| `.github/workflows/*`, `.github/CODEOWNERS` | Eliminados (ya hecho) |

## 5. Fases

| Fase | Entregable | Cómo la pruebas tú |
|---|---|---|
| **1. Validación (revisada)** | a) Tú: Bambuddy oficial en el Mac con Docker, tu A1 agregada y una impresión de prueba desde Bambuddy. b) Yo: entorno de desarrollo, pruebas de Bambuddy corriendo y el simulador adaptado para conectarlo. | Seguir [`instalar-en-mac.md`](./instalar-en-mac.md) y contarme cómo fue. **Parada** hasta que confirmes que tu A1 imprime desde Bambuddy. |
| **2. Base BlackForge** | Identidad (oscuro, cereza, Montserrat), español de Colombia, enlace «Código fuente», ajustes del taller por defecto (cama despejada, opciones de impresión), integración continua propia mínima. | Abrir la app y revisarla. |
| **3. Catálogo de productos** | Productos con foto, categoría y notas; variantes por cantidad enlazadas a archivos de la biblioteca (sugerencia de cantidad por nombre, aviso de otro modelo, rechazo de archivos sin laminar); totales por producto. | Crear un producto con 3 cantidades en menos de 2 minutos. |
| **4. Modo taller** | Entrada con nombre + PIN, galería, cantidad, impresora libre con aviso de filamento, confirmación (2 casillas + mantener presionado), progreso, «Ya retiré la pieza», pausar/reanudar/cancelar; idempotencia; pruebas de extremo a extremo con Playwright. | Enviar una impresión desde el celular en menos de 30 s. |
| **5. Entrega** | Imagen Docker propia para el Mac, README en español, procedimiento para traer actualizaciones de Bambuddy, copias de seguridad. | Instalar desde cero siguiendo el README. |

## 6. Riesgos

| Riesgo | Mitigación |
|---|---|
| Conflictos al traer actualizaciones de Bambuddy | Cambios aditivos, enganches mínimos y listados, merges frecuentes |
| Complejidad de Bambuddy | Usar sus APIs públicas internas; pruebas propias sobre nuestros endpoints |
| Su panel es muy completo y puede abrumar | Las operarias solo ven el modo taller; el panel completo queda para el administrador |
| Docker Desktop en Mac sin red `host` | Puertos publicados; impresoras agregadas por IP (que ya será fija) |
| Cambios de licencia o de rumbo de Bambuddy | Tenemos la historia completa; podemos quedarnos en una versión |

## 7. Decisiones vigentes del plan original

- Identidad: solo tema oscuro, acento cereza `#D62839`, Montserrat, botón de
  mantener presionado; icono configurable.
- Servidor: el MacBook Pro M5 del taller (que no se suspenda; IP fija).
- Retiro de pieza también tras fallo o cancelación; boquilla de otro diámetro bloquea;
  filamento distinto avisa y pide confirmación.
- Trato de «tú»; textos en español de Colombia.
