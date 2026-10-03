// BlackForge Print — se importa en main.tsx ANTES de inicializar i18n y React.
// Deja las preferencias del taller en localStorage para que Bambuddy las lea al
// arrancar: español por defecto (si nadie eligió otro idioma) y modo oscuro.
// Sin imports a propósito: debe evaluarse antes que '../i18n'.

type KeyValueStorage = Pick<Storage, 'getItem' | 'setItem'>;
type AssetCaches = Pick<CacheStorage, 'keys' | 'delete'>;

export const LANGUAGE_KEY = 'bambutrack_language'; // clave del detector de idioma de Bambuddy
export const THEME_MODE_KEY = 'theme-mode'; // clave del ThemeContext de Bambuddy

export function applyWorkshopPreferences(storage: KeyValueStorage): void {
  if (!storage.getItem(LANGUAGE_KEY)) {
    storage.setItem(LANGUAGE_KEY, 'es');
  }
  // Identidad BlackForge: solo tema oscuro.
  storage.setItem(THEME_MODE_KEY, 'dark');
}

// El service worker de Bambuddy sirve imágenes y fuentes desde su caché antes
// que desde la red. Como BlackForge reemplaza logos con el mismo nombre de
// archivo, borramos esa caché una vez por cada versión de nuestros recursos y
// recargamos. Solo aplica donde hay service worker (localhost o HTTPS).
// Subir BLACKFORGE_ASSET_VERSION cada vez que cambien logos o iconos.
export const BLACKFORGE_ASSET_VERSION = '2026-10-03.1';
export const ASSET_VERSION_KEY = 'blackforge_asset_version';

/** Devuelve true si borró cachés viejas (y pidió recargar la página). */
export async function purgeStaleAssetCaches(
  storage: KeyValueStorage,
  caches: AssetCaches,
  reload: () => void,
): Promise<boolean> {
  if (storage.getItem(ASSET_VERSION_KEY) === BLACKFORGE_ASSET_VERSION) return false;
  const stale = (await caches.keys()).filter((name) => name.startsWith('bambuddy-static'));
  await Promise.all(stale.map((name) => caches.delete(name)));
  storage.setItem(ASSET_VERSION_KEY, BLACKFORGE_ASSET_VERSION);
  if (stale.length > 0) reload();
  return stale.length > 0;
}

try {
  applyWorkshopPreferences(window.localStorage);
} catch {
  // localStorage puede no estar disponible (modo privado): la app funciona igual.
}

try {
  if ('caches' in window) {
    void purgeStaleAssetCaches(window.localStorage, window.caches, () => window.location.reload()).catch(() => {});
  }
} catch {
  // Sin caché o sin localStorage: nada que limpiar.
}
