# CLAUDE.md — BlackForge Print (sobre Bambuddy)

BlackForge Print es la versión del taller BlackForge de
[Bambuddy](https://github.com/maziggy/bambuddy) (AGPL-3.0): gestor autoalojado
de impresoras Bambu Lab por la red local. Sobre su base añadimos el **modo
taller** para que las operarias envíen archivos ya laminados a las A1 desde el
celular en menos de 30 segundos.

- Plan y fases: [`blackforge/PLAN.md`](blackforge/PLAN.md)
- Protocolo de la A1 y lo observado en la impresora real: [`blackforge/protocolo-a1.md`](blackforge/protocolo-a1.md)
- Instalar Bambuddy en el Mac del taller (Fase 1): [`blackforge/instalar-en-mac.md`](blackforge/instalar-en-mac.md)
- Identidad visual aprobada: [`blackforge/identidad/propuesta.html`](blackforge/identidad/propuesta.html)
- Documentación de Bambuddy: `README.md`, `CONTRIBUTING.md` y <https://wiki.bambuddy.cool>

**Estado actual:** Fase 1 (revisada). Parada: el dueño instala Bambuddy sin
cambios en su Mac, conecta su A1 e imprime una prueba. Mientras tanto: preparar
el entorno de desarrollo y correr las pruebas de Bambuddy.

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
  `blackforge/PLAN.md` (sección «Puntos de enganche»).
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

## Licencia (AGPL-3.0)

- Se conserva `LICENSE` y el crédito a Bambuddy y sus autores.
- Quienes usan la app por la red (las operarias) deben poder obtener el código
  fuente de nuestra versión: la app tendrá un enlace «Código fuente» (Fase 2).
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
