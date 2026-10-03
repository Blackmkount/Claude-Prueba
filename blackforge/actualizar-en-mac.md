# Pasar el Mac del taller a BlackForge Print (y actualizarlo después)

En la Fase 1 instalaste la imagen **oficial** de Bambuddy (`~/bambuddy`). Esa
imagen la publica Bambuddy y nunca va a traer lo nuestro: para ver BlackForge
Print hay que **construir la imagen desde nuestro repositorio**. Tus datos
(la A1 agregada, archivos, historial, usuarios) se conservan: viven en los
volúmenes de Docker, no en la imagen.

Tiempo: unos 15 minutos la primera vez (la construcción tarda de 5 a 10).

## 1. Descarga el repositorio con GitHub Desktop (una sola vez)

El repositorio es privado; GitHub Desktop se encarga de la contraseña.

1. Instala **GitHub Desktop** desde <https://desktop.github.com> y entra con tu
   cuenta de GitHub.
2. **File → Clone Repository…** → pestaña **GitHub.com** → elige
   `blackmkount/Claude-Prueba` → **Clone**. Queda en
   `~/Documents/GitHub/Claude-Prueba`.
3. Arriba, en **Current Branch**, debe decir `claude/sweet-mendel-7a2a2l`
   (es la rama principal del repositorio).

## 2. Cambia la versión oficial por BlackForge Print

En la app **Terminal**:

```bash
# Detén la versión oficial. Los datos quedan guardados en los volúmenes.
cd ~/bambuddy && docker compose down

# Construye y arranca BlackForge Print con los mismos datos.
cd ~/Documents/GitHub/Claude-Prueba
docker compose -f blackforge/docker-compose.mac.yml up -d --build
```

> ⚠️ Nunca agregues `-v` a `docker compose down`: borraría los volúmenes con
> todos los datos.

Cuando termine, abre <http://localhost:8000>. Si ves el logo viejo, recarga
con **Cmd + Shift + R** (una vez).

## 3. Qué debes ver

- Logo BlackForge Print, fondo oscuro, acento rojo cereza y letra Montserrat.
- Todo en español (si alguien ya había elegido otro idioma, se respeta; se
  cambia en **Ajustes → General → Idioma**).
- Tu A1 conectada, como antes.
- Abajo en la barra lateral: **«Basado en Bambuddy»** y **«Código fuente»**
  (descarga el código de esta versión; lo exige la licencia AGPL).
- **Ajustes → Flujo de trabajo → «Requerir confirmación de cama despejada»**
  activado: después de cada impresión, la A1 no recibe otra hasta que alguien
  pulse «Marcar cama como despejada» en su tarjeta.
- Sin el banner de anuncios de Bambuddy ni el botón rojo de reportar errores
  (esos reportes van a los autores de Bambuddy).

## Actualizar a una versión nueva de BlackForge Print

Cuando te avise de una versión nueva:

1. En GitHub Desktop: **Fetch origin** y luego **Pull origin**.
2. En Terminal:

   ```bash
   cd ~/Documents/GitHub/Claude-Prueba
   docker compose -f blackforge/docker-compose.mac.yml up -d --build
   ```

Las actualizaciones de Bambuddy (firmware, seguridad) también llegan así: yo
las incorporo al repositorio y tú solo haces estos dos pasos. Por eso
BlackForge apaga el aviso de «versión nueva de Bambuddy» de Ajustes: sus
instrucciones son para la imagen oficial, no para la nuestra.

## Volver a la versión oficial (si algo sale mal)

```bash
cd ~/Documents/GitHub/Claude-Prueba
docker compose -f blackforge/docker-compose.mac.yml down
cd ~/bambuddy && docker compose up -d
```

Usa los mismos datos. Cuéntame qué pasó para corregirlo.

## Comandos útiles

```bash
cd ~/Documents/GitHub/Claude-Prueba
docker compose -f blackforge/docker-compose.mac.yml logs -f     # registro (Ctrl+C para salir)
docker compose -f blackforge/docker-compose.mac.yml restart     # reiniciar
docker volume ls | grep bambuddy                                # ver los volúmenes con los datos
```

Si en la Fase 1 usaste otra carpeta en vez de `~/bambuddy`, tus volúmenes se
llaman distinto (`docker volume ls`): avísame y ajusto el archivo.
