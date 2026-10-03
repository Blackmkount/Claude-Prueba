"""Constantes de BlackForge Print."""

import os
from pathlib import Path

APP_NAME = "BlackForge Print"
LICENSE = "AGPL-3.0"
BASE_PROJECT = "Bambuddy"
BASE_PROJECT_URL = "https://github.com/maziggy/bambuddy"

# Paquete con el código fuente de esta versión (AGPL-3.0 §13). Se genera al
# construir la imagen Docker (ver la etapa ``blackforge-source`` del Dockerfile).
SOURCE_ARCHIVE_PATH = Path(os.environ.get("BLACKFORGE_SOURCE_ARCHIVE", "/app/blackforge-codigo-fuente.tar.gz"))
SOURCE_ARCHIVE_FILENAME = "blackforge-print-codigo-fuente.tar.gz"

# Ajustes de Bambuddy que el taller necesita. BlackForge aplica cada uno una sola
# vez (ver startup.py); si el administrador lo cambia después, se respeta.
TALLER_DEFAULT_SETTINGS: dict[str, str] = {
    # «Esperando retiro de pieza»: tras terminar (o fallar) una impresión, la
    # impresora no recibe otra hasta que alguien confirme que la cama está despejada.
    "require_plate_clear": "true",
    # Los anuncios son mensajes de los desarrolladores de Bambuddy sobre otros
    # modelos y versiones: no aplican al taller y confunden a las operarias.
    "announcements_enabled": "false",
    # Bambuddy busca sus propias versiones nuevas y propone actualizarse con sus
    # instrucciones. En BlackForge las actualizaciones de Bambuddy llegan con un
    # merge en nuestro repositorio, así que ese aviso no aplica. (La búsqueda de
    # firmware de las impresoras, ``check_printer_firmware``, sigue activa.)
    "check_updates": "false",
}
