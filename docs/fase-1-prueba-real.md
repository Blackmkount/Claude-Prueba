# Fase 1 — Prueba con tu A1 real (desde el MacBook)

Objetivo: confirmar en tu impresora lo que las referencias no aclaran del todo
(formato de la orden de imprimir, modo FTPS, si la A1 repite nuestro ID de
tarea) y grabar lo que hace la impresora para ajustar el simulador.

Tiempo estimado: 20–30 minutos, más lo que dure la impresión de prueba.

> Tu archivo `.env` contiene el código de acceso de la impresora: **no lo
> compartas**. Los reportes (`reportes/`) y las capturas (`capturas/`) que genera
> el CLI **no** lo incluyen, así que esos sí me los puedes enviar.

---

## 1. Prepara la impresora

1. Pon una **microSD** en la A1 (FAT32 o exFAT).
2. En la pantalla de la A1: **Ajustes (engranaje) → Red / WLAN**:
   - Activa **Modo solo LAN** (*LAN Only Mode*). Ahí mismo ves el **código de acceso**.
   - Activa **Modo desarrollador** (*Developer Mode*), que aparece al activar el modo LAN.
3. Anota la **IP** (en la misma pantalla de red). Tú ya me diste: `192.168.18.10`.

> Si desactivas y vuelves a activar el modo LAN, el código de acceso cambia.

## 2. Prepara el Mac (una sola vez)

1. **Instala Node.js 24 LTS**: entra a <https://nodejs.org>, descarga el
   instalador **LTS** para macOS (`.pkg`) y ejecútalo.
   Comprueba en la app **Terminal**:

   ```bash
   node --version
   ```

   Debe decir `v24.` algo (sirve también `v22.12` o superior).

2. **Descarga el código**. Elige una opción:

   **Opción A — con git** (si al escribir `git` el Mac ofrece instalar las
   herramientas de desarrollo, acepta):

   ```bash
   cd ~/Documents
   git clone https://github.com/Blackmkount/Claude-Prueba.git blackforge-print
   cd blackforge-print
   git checkout claude/sweet-mendel-7a2a2l
   ```

   **Opción B — ZIP**: con tu sesión de GitHub abierta en el navegador, abre
   <https://github.com/Blackmkount/Claude-Prueba/archive/refs/heads/claude/sweet-mendel-7a2a2l.zip>,
   descomprime y en Terminal entra a la carpeta (arrastra la carpeta a la
   Terminal después de escribir `cd ` para no escribir la ruta):

   ```bash
   cd ~/Downloads/Claude-Prueba-claude-sweet-mendel-7a2a2l
   ```

3. **Instala las dependencias** (dentro de la carpeta del proyecto):

   ```bash
   npm install
   ```

4. **Crea el archivo `.env`** con los datos de tu impresora (reemplaza el
   código por el tuyo):

   ```bash
   cat > .env <<'EOF'
   PRINTER_IP=192.168.18.10
   PRINTER_ACCESS_CODE=tu_codigo_de_acceso
   EOF
   ```

   No hace falta el número de serie: el CLI lo lee del certificado de la impresora.

5. El Mac debe estar en **la misma red** que la impresora (el Wi-Fi del taller).

## 3. (Opcional, 1 minuto) Míralo funcionar con el simulador

En una ventana de Terminal:

```bash
npm run sim -- --impresoras 2 --duracion-ms 20000
```

Copia las líneas que imprime en un archivo `.env.sim` (te las muestra listas)
y en **otra** ventana de Terminal, en la misma carpeta:

```bash
npm run cli -- estado --env .env.sim
```

Ctrl+C en la primera ventana para detener el simulador.

## 4. Diagnóstico (no imprime nada)

```bash
npm run cli -- diagnostico
```

- La primera vez, macOS pregunta si la Terminal puede **buscar dispositivos en
  la red local**: elige **Permitir**. Si lo rechazaste por error: Ajustes del
  Sistema → Privacidad y seguridad → **Red local** → activa Terminal, y vuelve a
  ejecutar.
- Prueba red, certificado, conexión MQTT, estado, el tráfico durante 20 s en
  reposo y los tres modos de subida FTPS (sube y borra un archivo de prueba de 256 KB).
- Al final dice qué modos FTPS funcionaron y deja un reporte en
  `reportes/diagnostico_<fecha>.md`.

**Envíame ese reporte** (puedes abrirlo con `open reportes/` y pegarme su contenido).

## 5. Prepara un archivo de prueba en Bambu Studio

1. Impresora: **Bambu Lab A1, boquilla 0.4** (o la que tengas puesta).
2. Agrega un objeto pequeño, por ejemplo un cubo de 20 mm (clic derecho en la
   placa → *Agregar primitiva* → *Cubo*), para que la prueba dure poco.
3. Elige el filamento que tienes cargado (si usas AMS lite, el de la bandeja que
   quieras usar).
4. **Laminar placa**.
5. **Archivo → Exportar → Exportar archivo de placa laminada** (*Export plate
   sliced file*). Guárdalo en la carpeta del proyecto como `prueba.gcode.3mf`.

Compruébalo:

```bash
npm run cli -- info prueba.gcode.3mf
npm run cli -- diagnostico --archivo prueba.gcode.3mf --sin-subida
```

El segundo comando muestra qué bandeja del AMS lite (o la bobina externa) se usaría.

## 6. La impresión de prueba

1. **Deja la cama limpia y vacía.**
2. Ejecuta:

   ```bash
   npm run cli -- imprimir prueba.gcode.3mf --nombre "Prueba BlackForge"
   ```

   Si el diagnóstico dijo que el modo `basic` **no** funcionó, agrega el modo
   que sí funcionó, por ejemplo `--modo minimal-c`.

3. Te muestra la impresora, el archivo y el filamento, y pregunta si la cama está
   limpia: escribe `si`.
4. Verás: *Subiendo… → Verificando… → Enviando la orden… → Esperando a que
   arranque… → ¡La impresora arrancó!* y luego el avance.
5. Mira la pantalla de la A1: debería mostrar **Prueba BlackForge**.
6. Puedes dejarlo hasta que termine (al final borra el archivo de la microSD) o
   salir con **Ctrl+C**: la impresora sigue imprimiendo. En ese caso, cuando
   termine, ejecuta `npm run cli -- limpiar`.

### Si no arranca en 90 segundos

1. Mira la pantalla de la impresora y anota cualquier mensaje.
2. Ejecuta `npm run cli -- estado`.
3. Si sigue **Libre (IDLE)** o dice **FAILED**, prueba el siguiente formato de
   orden (el CLI te lo sugiere):

   ```bash
   npm run cli -- imprimir prueba.gcode.3mf --nombre "Prueba BlackForge" --url sdcard
   ```

   y si tampoco: `--url ftp3`.

## 7. Pruebas extra (opcionales, muy útiles para el simulador)

Con otra impresión corta en curso:

```bash
npm run cli -- pausar
npm run cli -- reanudar
npm run cli -- cancelar
```

Y un minuto de tráfico con la impresora quieta:

```bash
npm run cli -- estado --seguir --grabar
```

(Ctrl+C para salir.)

## 8. Qué me envías

1. El contenido de `reportes/diagnostico_<fecha>.md`.
2. Los archivos de `capturas/` (sobre todo el de `imprimir_<fecha>.jsonl`). Son
   texto; no contienen el código de acceso.
3. Lo que viste en la pantalla de la A1:
   - ¿Mostró el nombre «Prueba BlackForge»?
   - ¿Hizo la nivelación de cama antes de imprimir?
   - ¿Apareció algún mensaje o error?
4. Si tuviste que usar `--modo` o `--url` distintos a los de por defecto.

Con eso ajusto el módulo de impresora y el simulador a tu firmware (01.08.01.00)
y cerramos la Fase 1.

## Problemas comunes

| Mensaje | Qué hacer |
|---|---|
| `no se pudo llegar a la impresora (EHOSTUNREACH)` | Permite «Red local» a la Terminal (paso 4). Revisa que el Mac y la A1 estén en la misma red y la IP. |
| `no se pudo llegar a la impresora (ECONNREFUSED)` | El modo solo LAN no está activo o la IP es de otro equipo. |
| `La impresora rechazó el código de acceso` | Revisa el código en la pantalla de la A1; cambia si reactivas el modo LAN. |
| `el certificado no está firmado por Bambu Lab` | Agrega `PRINTER_TLS_VERIFY=false` al `.env` y avísame (es un dato importante). |
| `Modo desarrollador … APAGADO` | Actívalo en la pantalla de la A1 (paso 1). |
| `La impresora no tiene microSD` / error 553 | Pon o cambia la microSD (FAT32/exFAT). |
| `npm: command not found` | Node.js no quedó instalado: repite el paso 2.1 y abre una Terminal nueva. |

Para ver el detalle técnico completo de un error: `BF_DEBUG=1 npm run cli -- …`
