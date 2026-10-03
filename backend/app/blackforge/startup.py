"""Arranque de BlackForge Print (se llama desde el ``lifespan`` de Bambuddy)."""

import json
import logging

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.routes.settings import set_setting
from backend.app.blackforge.constants import TALLER_DEFAULT_SETTINGS
from backend.app.blackforge.models import BlackForgeState
from backend.app.core.database import async_session

logger = logging.getLogger(__name__)

APPLIED_DEFAULTS_KEY = "applied_setting_defaults"


async def _get_state(db: AsyncSession, key: str) -> str | None:
    row = await db.get(BlackForgeState, key)
    return row.value if row else None


async def _set_state(db: AsyncSession, key: str, value: str) -> None:
    row = await db.get(BlackForgeState, key)
    if row:
        row.value = value
    else:
        db.add(BlackForgeState(key=key, value=value))


async def apply_taller_defaults(db: AsyncSession) -> list[str]:
    """Aplica UNA SOLA VEZ cada ajuste del taller. Devuelve las claves aplicadas.

    Se aplica aunque el ajuste ya exista: la página de Ajustes de Bambuddy guarda
    todos sus valores por defecto al visitarla, así que «solo si no existe» no
    serviría. Lo que se recuerda es si BlackForge ya lo aplicó: si después el
    administrador lo cambia, se respeta su decisión.
    """
    applied: list[str] = json.loads(await _get_state(db, APPLIED_DEFAULTS_KEY) or "[]")
    newly: list[str] = []
    for key, value in TALLER_DEFAULT_SETTINGS.items():
        if key in applied:
            continue
        await set_setting(db, key, value)
        applied.append(key)
        newly.append(key)
    if newly:
        await _set_state(db, APPLIED_DEFAULTS_KEY, json.dumps(applied))
        await db.commit()
    return newly


async def on_startup() -> None:
    """Nunca debe impedir que Bambuddy arranque: los errores solo se registran."""
    try:
        async with async_session() as db:
            newly = await apply_taller_defaults(db)
        if newly:
            logger.info("BlackForge: ajustes del taller aplicados: %s", ", ".join(newly))
    except Exception:
        logger.exception("BlackForge: no se pudieron aplicar los ajustes del taller")
