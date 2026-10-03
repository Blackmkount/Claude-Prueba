// Llamadas a la API de BlackForge (/api/v1/blackforge), con la sesión de Bambuddy.
import { getAuthToken } from '../api/client';

const BASE = '/api/v1/blackforge';

function authHeaders(): Record<string, string> {
  const token = getAuthToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export class SourceUnavailableError extends Error {}

/**
 * Descarga el paquete con el código fuente (AGPL-3.0 §13). Usa fetch con la
 * sesión porque un enlace normal no envía el token de Bambuddy.
 */
export async function downloadSourceArchive(): Promise<void> {
  const response = await fetch(`${BASE}/codigo-fuente`, { headers: authHeaders() });
  if (response.status === 404) throw new SourceUnavailableError();
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'blackforge-print-codigo-fuente.tar.gz';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
