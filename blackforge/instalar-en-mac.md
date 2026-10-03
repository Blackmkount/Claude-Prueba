# Fase 1 (revisada) — Bambuddy en el Mac del taller con tu A1

Objetivo: comprobar que Bambuddy, **sin modificaciones**, se conecta con tu A1
e imprime. Si esto funciona, toda la base técnica está validada y nos
dedicamos solo a lo que falta (modo taller y catálogo).

Tiempo estimado: 20–30 minutos más la impresión de prueba.

## 1. La impresora (ya lo tienes)

- microSD puesta, **Modo solo LAN** y **Modo desarrollador** activos.
- IP `192.168.18.10` y código de acceso a mano.

## 2. Instala Docker Desktop

1. Descarga **Docker Desktop para Mac con Apple Silicon** desde
   <https://www.docker.com/products/docker-desktop/> e instálalo.
2. Ábrelo una vez y acepta los permisos. En sus ajustes, activa
   **«Start Docker Desktop when you sign in»** (para que arranque solo).

## 3. Arranca Bambuddy

En la app **Terminal**:

```bash
mkdir -p ~/bambuddy && cd ~/bambuddy
cat > docker-compose.yml <<'EOF'
services:
  bambuddy:
    image: ghcr.io/maziggy/bambuddy:latest
    container_name: bambuddy
    # En Mac, Docker Desktop no permite la red "host": se publica el puerto.
    ports:
      - "8000:8000"
    volumes:
      - bambuddy_data:/app/data
      - bambuddy_logs:/app/logs
    environment:
      - TZ=America/Bogota
      - PORT=8000
    restart: unless-stopped
    stop_grace_period: 30s
volumes:
  bambuddy_data:
  bambuddy_logs:
EOF
docker compose up -d
```

La primera vez descarga la imagen (unos minutos). Luego abre
<http://localhost:8000> en el navegador.

## 4. Agrega tu A1

1. En Bambuddy, agrega una impresora **a mano** (el descubrimiento automático
   no funciona dentro de Docker en Mac): IP `192.168.18.10`, tu código de
   acceso y el número de serie (`03900D5A2406566`, el que leyó el diagnóstico).
2. Comprueba que aparece **conectada**, con temperaturas y estado.
3. Si macOS pregunta por el acceso a la **red local**, permítelo (Docker).

## 5. Imprime una prueba

1. Deja la cama limpia y vacía.
2. Sube a Bambuddy tu `prueba.gcode.3mf` (el cubo pequeño laminado en Bambu
   Studio con «Exportar archivo de placa laminada») desde su gestor de archivos.
3. Imprímelo en tu A1 desde Bambuddy.

## 6. Qué me cuentas

- ¿La A1 aparece conectada y con su estado?
- ¿La impresión arrancó? ¿Mostró la nivelación y el nombre del archivo en la pantalla?
- Cualquier error o mensaje que veas (una captura de pantalla sirve).

Con eso cierro la Fase 1 y empezamos a convertir Bambuddy en BlackForge Print.

## Comandos útiles

```bash
cd ~/bambuddy
docker compose logs -f      # ver el registro (Ctrl+C para salir)
docker compose restart      # reiniciar
docker compose down         # detener
docker compose pull && docker compose up -d   # actualizar a la última versión
```
