"""Ajustes del taller que BlackForge aplica al arrancar."""

import pytest

from backend.app.api.routes.settings import get_setting, set_setting
from backend.app.blackforge.constants import TALLER_DEFAULT_SETTINGS
from backend.app.blackforge.startup import apply_taller_defaults


@pytest.mark.asyncio
async def test_aplica_los_ajustes_del_taller(db_session):
    newly = await apply_taller_defaults(db_session)
    assert set(newly) == set(TALLER_DEFAULT_SETTINGS)
    assert await get_setting(db_session, "require_plate_clear") == "true"
    assert await get_setting(db_session, "announcements_enabled") == "false"
    assert await get_setting(db_session, "check_updates") == "false"


@pytest.mark.asyncio
async def test_se_aplica_aunque_bambuddy_ya_guardo_sus_valores(db_session):
    # La página de Ajustes de Bambuddy guarda todos sus valores por defecto al
    # visitarla: una instalación existente ya tiene require_plate_clear=false.
    await set_setting(db_session, "require_plate_clear", "false")
    await set_setting(db_session, "announcements_enabled", "true")
    await db_session.commit()
    await apply_taller_defaults(db_session)
    assert await get_setting(db_session, "require_plate_clear") == "true"
    assert await get_setting(db_session, "announcements_enabled") == "false"


@pytest.mark.asyncio
async def test_se_aplica_una_sola_vez(db_session):
    await apply_taller_defaults(db_session)
    assert await apply_taller_defaults(db_session) == []


@pytest.mark.asyncio
async def test_respeta_la_decision_posterior_del_administrador(db_session):
    await apply_taller_defaults(db_session)
    # El administrador lo desactiva después: BlackForge no lo vuelve a activar.
    await set_setting(db_session, "require_plate_clear", "false")
    await db_session.commit()
    assert await apply_taller_defaults(db_session) == []
    assert await get_setting(db_session, "require_plate_clear") == "false"


def test_los_valores_por_defecto_son_textos():
    # Bambuddy guarda los ajustes como texto y compara "true"/"false".
    assert all(isinstance(v, str) for v in TALLER_DEFAULT_SETTINGS.values())
