"""Rutas de BlackForge Print, bajo ``/api/v1/blackforge``."""

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

from backend.app.blackforge.constants import (
    APP_NAME,
    BASE_PROJECT,
    BASE_PROJECT_URL,
    LICENSE,
    SOURCE_ARCHIVE_FILENAME,
    SOURCE_ARCHIVE_PATH,
)
from backend.app.core.auth import require_auth_if_enabled
from backend.app.core.config import APP_VERSION
from backend.app.models.user import User

router = APIRouter(prefix="/blackforge", tags=["blackforge"])


class BlackForgeInfo(BaseModel):
    name: str
    base_project: str
    base_project_url: str
    base_version: str
    license: str
    source_available: bool
    source_url: str


@router.get("/info", response_model=BlackForgeInfo)
async def get_info(_: User | None = Depends(require_auth_if_enabled)) -> BlackForgeInfo:
    """Nombre, base y licencia de esta versión, y si el código fuente se puede descargar."""
    return BlackForgeInfo(
        name=APP_NAME,
        base_project=BASE_PROJECT,
        base_project_url=BASE_PROJECT_URL,
        base_version=APP_VERSION,
        license=LICENSE,
        source_available=SOURCE_ARCHIVE_PATH.is_file(),
        source_url="/api/v1/blackforge/codigo-fuente",
    )


@router.get("/codigo-fuente")
async def download_source(_: User | None = Depends(require_auth_if_enabled)) -> FileResponse:
    """Descarga el código fuente de esta versión (AGPL-3.0 §13).

    Disponible para cualquier usuario que haya iniciado sesión, que son quienes
    usan la app por la red.
    """
    if not SOURCE_ARCHIVE_PATH.is_file():
        raise HTTPException(
            status_code=404,
            detail="El paquete de código fuente se genera al construir la imagen Docker de BlackForge Print.",
        )
    return FileResponse(
        SOURCE_ARCHIVE_PATH,
        media_type="application/gzip",
        filename=SOURCE_ARCHIVE_FILENAME,
    )
