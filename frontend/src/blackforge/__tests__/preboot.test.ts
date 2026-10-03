import { describe, it, expect, vi } from 'vitest';
import {
  applyWorkshopPreferences,
  purgeStaleAssetCaches,
  ASSET_VERSION_KEY,
  BLACKFORGE_ASSET_VERSION,
  LANGUAGE_KEY,
  THEME_MODE_KEY,
} from '../preboot';

function memoryStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  };
}

function fakeCaches(names: string[]) {
  const remaining = new Set(names);
  return {
    remaining,
    keys: vi.fn(async () => [...remaining]),
    delete: vi.fn(async (name: string) => remaining.delete(name)),
  };
}

describe('preferencias del taller', () => {
  it('pone español si nadie eligió idioma', () => {
    const storage = memoryStorage();
    applyWorkshopPreferences(storage);
    expect(storage.store.get(LANGUAGE_KEY)).toBe('es');
  });

  it('respeta el idioma que alguien ya eligió', () => {
    const storage = memoryStorage({ [LANGUAGE_KEY]: 'en' });
    applyWorkshopPreferences(storage);
    expect(storage.store.get(LANGUAGE_KEY)).toBe('en');
  });

  it('deja siempre el tema oscuro', () => {
    const storage = memoryStorage({ [THEME_MODE_KEY]: 'light' });
    applyWorkshopPreferences(storage);
    expect(storage.store.get(THEME_MODE_KEY)).toBe('dark');
  });
});

describe('caché de imágenes del service worker', () => {
  it('borra la caché de Bambuddy y recarga cuando cambia la versión de recursos', async () => {
    const storage = memoryStorage();
    const caches = fakeCaches(['bambuddy-static-v29', 'otra-cache']);
    const reload = vi.fn();

    expect(await purgeStaleAssetCaches(storage, caches, reload)).toBe(true);
    expect([...caches.remaining]).toEqual(['otra-cache']);
    expect(storage.store.get(ASSET_VERSION_KEY)).toBe(BLACKFORGE_ASSET_VERSION);
    expect(reload).toHaveBeenCalledOnce();
  });

  it('no hace nada si esta versión ya se limpió', async () => {
    const storage = memoryStorage({ [ASSET_VERSION_KEY]: BLACKFORGE_ASSET_VERSION });
    const caches = fakeCaches(['bambuddy-static-v29']);
    const reload = vi.fn();

    expect(await purgeStaleAssetCaches(storage, caches, reload)).toBe(false);
    expect(caches.keys).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it('no recarga si no había nada que borrar (evita recargas en bucle)', async () => {
    const storage = memoryStorage();
    const reload = vi.fn();

    expect(await purgeStaleAssetCaches(storage, fakeCaches([]), reload)).toBe(false);
    expect(storage.store.get(ASSET_VERSION_KEY)).toBe(BLACKFORGE_ASSET_VERSION);
    expect(reload).not.toHaveBeenCalled();
  });
});
