"""Tablas propias de BlackForge Print.

Regla del proyecto: tablas nuevas, nunca columnas nuevas en tablas de Bambuddy.
Se registran en el ``Base`` de Bambuddy y su ``init_db`` (``create_all``) las
crea al arrancar.
"""

from datetime import datetime

from sqlalchemy import DateTime, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from backend.app.core.database import Base


class BlackForgeState(Base):
    """Estado interno de BlackForge (clave → valor), p. ej. qué ajustes ya aplicó."""

    __tablename__ = "blackforge_state"

    key: Mapped[str] = mapped_column(String(100), primary_key=True)
    value: Mapped[str] = mapped_column(Text)
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())
