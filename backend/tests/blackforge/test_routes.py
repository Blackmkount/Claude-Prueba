"""Rutas /api/v1/blackforge."""

import pytest
from httpx import AsyncClient

import backend.app.blackforge.routes as bf_routes


@pytest.mark.asyncio
async def test_info(async_client: AsyncClient):
    response = await async_client.get("/api/v1/blackforge/info")
    assert response.status_code == 200
    data = response.json()
    assert data["name"] == "BlackForge Print"
    assert data["base_project"] == "Bambuddy"
    assert data["license"] == "AGPL-3.0"
    assert data["source_url"] == "/api/v1/blackforge/codigo-fuente"


@pytest.mark.asyncio
async def test_codigo_fuente_no_disponible_fuera_de_docker(async_client: AsyncClient, monkeypatch, tmp_path):
    monkeypatch.setattr(bf_routes, "SOURCE_ARCHIVE_PATH", tmp_path / "no-existe.tar.gz")
    info = (await async_client.get("/api/v1/blackforge/info")).json()
    assert info["source_available"] is False
    response = await async_client.get("/api/v1/blackforge/codigo-fuente")
    assert response.status_code == 404
    assert "Docker" in response.json()["detail"]


@pytest.mark.asyncio
async def test_descarga_del_codigo_fuente(async_client: AsyncClient, monkeypatch, tmp_path):
    archive = tmp_path / "fuente.tar.gz"
    archive.write_bytes(b"contenido de prueba")
    monkeypatch.setattr(bf_routes, "SOURCE_ARCHIVE_PATH", archive)
    info = (await async_client.get("/api/v1/blackforge/info")).json()
    assert info["source_available"] is True
    response = await async_client.get("/api/v1/blackforge/codigo-fuente")
    assert response.status_code == 200
    assert response.content == b"contenido de prueba"
    assert "blackforge-print-codigo-fuente.tar.gz" in response.headers["content-disposition"]


@pytest.mark.asyncio
async def test_exigen_sesion_si_la_autenticacion_esta_activa(async_client: AsyncClient, monkeypatch, tmp_path):
    archive = tmp_path / "fuente.tar.gz"
    archive.write_bytes(b"x")
    monkeypatch.setattr(bf_routes, "SOURCE_ARCHIVE_PATH", archive)
    setup = await async_client.post(
        "/api/v1/auth/setup",
        json={"auth_enabled": True, "admin_username": "taller", "admin_password": "TallerPass1!"},
    )
    assert setup.status_code == 200
    assert (await async_client.get("/api/v1/blackforge/info")).status_code == 401
    assert (await async_client.get("/api/v1/blackforge/codigo-fuente")).status_code == 401

    login = await async_client.post("/api/v1/auth/login", json={"username": "taller", "password": "TallerPass1!"})
    token = login.json()["access_token"]
    headers = {"Authorization": f"Bearer {token}"}
    assert (await async_client.get("/api/v1/blackforge/info", headers=headers)).status_code == 200
    assert (await async_client.get("/api/v1/blackforge/codigo-fuente", headers=headers)).status_code == 200
