"""BlackForge Print: capa del taller BlackForge sobre Bambuddy.

Todo lo propio del taller vive en este paquete. Se engancha con Bambuddy en
dos puntos de ``backend/app/main.py`` (marcados ``BLACKFORGE:``): el router y
``on_startup`` dentro del ``lifespan``.
"""

from backend.app.blackforge import models  # noqa: F401  (registra las tablas en el Base)
from backend.app.blackforge.routes import router
from backend.app.blackforge.startup import on_startup

__all__ = ["on_startup", "router"]
