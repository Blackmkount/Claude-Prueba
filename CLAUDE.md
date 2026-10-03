# CLAUDE.md — BlackForge Print (sobre Bambuddy)

BlackForge Print es la versión del taller BlackForge de
[Bambuddy](https://github.com/maziggy/bambuddy) (AGPL-3.0): gestor autoalojado
de impresoras Bambu Lab por la red local. Sobre su base añadimos el **modo
taller** para que las operarias envíen archivos ya laminados a las A1 desde el
celular en menos de 30 segundos.

- Plan y fases: [`blackforge/PLAN.md`](blackforge/PLAN.md)
- Protocolo de la A1 y lo observado en la impresora real: [`blackforge/protocolo-a1.md`](blackforge/protocolo-a1.md)
- Pasar el Mac del taller a BlackForge Print y actualizarlo: [`blackforge/actualizar-en-mac.md`](blackforge/actualizar-en-mac.md)
  (imagen propia con [`blackforge/docker-compose.mac.yml`](blackforge/docker-compose.mac.yml); la Fase 1 con la imagen oficial está en `blackforge/instalar-en-mac.md`)
- Simulador de A1 para desarrollar: [`blackforge/simulador/`](blackforge/simulador/README.md)
- Identidad visual aprobada: [`blackforge/identidad/propuesta.html`](blackforge/identidad/propuesta.html)
- Documentación de Bambuddy: `README.md`, `CONTRIBUTING.md` y <https://wiki.bambuddy.cool>

**Estado actual:** Fase 2 (base BlackForge) entregada. Parada: el dueño la
instala en su Mac con `blackforge/actualizar-en-mac.md` y la revisa. Siguiente:
Fase 3 (catálogo de productos). Fase 1 validada el 2026-10-03 (Bambuddy oficial
en Docker en el Mac, con la A1 conectada).

Verificado en el entorno de desarrollo (2026-10-03, base `ecddbf2b`):
backend con Python 3.11 — 13 584 pruebas en verde (unitarias, integración,
auditoría de autenticación de rutas y las nuestras); frontend con tsc, eslint,
`check:i18n`, `vite build` y vitest (4 173 en verde; las 2 de
`SpreadsheetPreviewModal` fallan solo por el sustituto de `xlsx`). El frontend no se puede instalar en la nube mientras
`cdn.sheetjs.com` (dependencia `xlsx`) esté bloqueado por la política de red
del entorno: hay que agregarlo a los dominios permitidos. Mientras tanto se
usa un sustituto local de `xlsx` enlazado en `frontend/node_modules` (nunca
subir cambios a `package.json` ni `package-lock.json` por eso).

## Cómo trabajamos

- Hablar siempre en **español** con el dueño y explicar el porqué de las decisiones.
- Trabajo por fases (ver plan). **Commit al final de cada fase** con un resumen
  breve de qué se hizo y cómo probarlo. No dar una fase por terminada si fallan pruebas.
- En fases de interfaz: capturas con Playwright a 390×844 y 1440×900, revisarlas
  y corregir antes de cerrar. Chromium está en `/opt/pw-browsers/chromium`.
- Mantener este archivo actualizado.

## Regla de oro: cambios aditivos, para poder seguir recibiendo a Bambuddy

Bambuddy es enorme (~180 000 líneas de Python, ~350 000 de TypeScript) y muy
activo. Queremos traer sus actualizaciones (arreglos de firmware, seguridad) con
un `git merge` sin pelear conflictos. Por eso:

- Todo lo nuestro vive en carpetas propias:
  - Backend: `backend/app/blackforge/` (modelos, rutas, servicios) y pruebas en `backend/tests/blackforge/`.
  - Frontend: `frontend/src/blackforge/` (páginas del modo taller, componentes, textos, tema).
  - Documentación y herramientas: `blackforge/`.
- Los **puntos de enganche** con el código de Bambuddy (registrar un router,
  una ruta del frontend, una hoja de estilos) se reducen al mínimo, se marcan
  con el comentario `# BLACKFORGE:` / `// BLACKFORGE:` y se listan en
  `blackforge/PLAN.md` (sección «Puntos de enganche»; `git grep BLACKFORGE`).
  Hoy: `backend/app/main.py`, `frontend/src/main.tsx`, `ThemeContext.tsx`,
  `Layout.tsx`, `frontend/index.html`, los 3 `frontend/public/img/bambuddy_logo_*.png`
  (reemplazados), `Dockerfile` y `.dockerignore`.
- Las banderas de `frontend/src/blackforge/theme/config.ts` (solo oscuro, sin
  botón de reportes) se apagan bajo vitest para que las pruebas de Bambuddy no
  cambien; nuestras pruebas (`frontend/src/blackforge/__tests__/`) las encienden
  con `vi.mock`.
- **Ajustes del taller**: `TALLER_DEFAULT_SETTINGS` (`backend/app/blackforge/constants.py`)
  se aplica una sola vez por clave al arrancar (registro en la tabla
  `blackforge_state`), porque la página de Ajustes de Bambuddy guarda todos sus
  valores por defecto al visitarla. Si el administrador lo cambia después, se respeta.
- **Tablas nuevas, no columnas nuevas** en tablas de Bambuddy: nuestros modelos
  SQLAlchemy se registran en su `Base` y `create_all` los crea al arrancar, sin
  tocar `backend/app/core/database.py`.
- **Textos**: Bambuddy exige que cada clave de `frontend/src/i18n/locales/`
  exista en sus 15 idiomas (`npm run check:i18n`). Los textos del modo taller van
  en un espacio de nombres propio (`frontend/src/blackforge/i18n/`) cargado con
  `addResourceBundle`, en español de Colombia (trato de «tú»), con inglés de respaldo.
- Reutilizar la API y los servicios de Bambuddy (cola de impresión, «cama
  despejada», permisos, websocket) en vez de duplicarlos.

### Traer actualizaciones de Bambuddy

```bash
git fetch upstream main
git merge upstream/main          # nunca rebase: conserva la historia
```

- Remoto `upstream` = https://github.com/maziggy/bambuddy.git (rama `main`).
- Conflictos esperables: `.github/workflows/*` y `.github/CODEOWNERS` los
  borramos a propósito (sus flujos de Actions usan credenciales de Bambuddy y
  gastarían minutos en este repo privado): resolver con `git rm`.
- Tras cada merge: correr las pruebas de Bambuddy y las nuestras.
- `CLAUDE.md` está en el `.gitignore` de Bambuddy: se versiona con `git add -f`
  (una vez versionado, git lo sigue; no hay que tocar su `.gitignore`).

## Comandos (de Bambuddy)

```bash
# Backend (Python 3.11+)
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt -r requirements-dev.txt
DEBUG=true uvicorn backend.app.main:app --reload --host 0.0.0.0 --port 8000 --loop asyncio
pytest backend/tests/            # pruebas del backend
./test_backend.sh                # ruff + pytest en paralelo

# Frontend (Node 20+)
cd frontend && npm install
npm run dev                      # http://localhost:5173 (usa el backend en :8000)
npm run test:run                 # vitest + verificación de idiomas
npm run build
./test_frontend.sh               # tsc + eslint + vitest

# Docker
docker compose up -d --build
```

Cuidados propios de este repositorio:

- **Nunca subir `static/`**: Bambuddy versiona ahí el frontend compilado y
  `npm run build` lo sobrescribe. La imagen Docker compila el frontend por su
  cuenta. Para compilar a mano: `npx vite build --outDir <carpeta temporal>`;
  si se tocó, `git checkout -- static/ && git clean -fdq static/`.
- Si cambian logos o iconos, subir `BLACKFORGE_ASSET_VERSION` en
  `frontend/src/blackforge/preboot.ts` (borra la caché del service worker).
- Simulador conectado a Bambuddy: `sudo npm run sim -- --ip-base 127.0.0.2 --impresoras 3 --sin-puback`
  en `blackforge/simulador/` (ver su README).
- Imagen para el Mac: `docker compose -f blackforge/docker-compose.mac.yml up -d --build`
  (proyecto `bambuddy`, mismos volúmenes que la instalación oficial).

## Licencia (AGPL-3.0)

- Se conserva `LICENSE` y el crédito a Bambuddy y sus autores.
- Quienes usan la app por la red (las operarias) deben poder obtener el código
  fuente de nuestra versión: enlace «Código fuente» en la barra lateral, que
  descarga el paquete que la etapa `blackforge-source` del `Dockerfile` mete en
  la imagen (`GET /api/v1/blackforge/codigo-fuente`).
- Si algún día se distribuye el software, también debe ser AGPL-3.0.

## Seguridad (no negociable)

- La app es solo para la red local del taller; no se expone a internet.
- Los códigos de acceso de las impresoras nunca llegan al navegador.
- PIN de operarias con hash y límite de intentos; permisos con el sistema de
  grupos de Bambuddy (`RequirePermissionIfAuthEnabled`, `backend/app/core/permissions.py`).
- Nunca subir `.env` ni datos del taller al repositorio.

## Lo aprendido de la A1 real (detalle en blackforge/protocolo-a1.md §8)

- Firmware 01.08.01.00. TLS verificable (emisor `BBL CA`, CN = número de serie);
  login MQTT con el código de acceso funciona.
- El broker de la A1 no envía de forma confiable el acuse MQTT (PUBACK): nunca
  esperar el PUBACK sin límite. Bambuddy ya lo maneja (paho con límite de
  mensajes en vuelo alto).
- Bambuddy usa puertos fijos 8883/990 y no verifica el certificado
  (`CERT_NONE`); todas las impresiones pasan por la cola (`POST /queue/`) y el
  programador, donde están las guardas de impresora ocupada y de «cama despejada»
  (`require_plate_clear`, `awaiting_plate_clear` persistido en la base).
