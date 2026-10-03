import { describe, it, expect, beforeAll } from 'vitest';
import i18n from '../../i18n';
import bambuddyEn from '../../i18n/locales/en';
import en from '../i18n/en';
import es from '../i18n/es';
import { translationOverrides } from '../i18n/overrides';
import { BLACKFORGE_NS, registerBlackForgeI18n } from '../i18n';

type Tree = { [key: string]: string | Tree };

function leafKeys(tree: Tree, prefix = ''): string[] {
  return Object.entries(tree).flatMap(([key, value]) =>
    typeof value === 'string' ? [`${prefix}${key}`] : leafKeys(value, `${prefix}${key}.`),
  );
}

describe('textos de BlackForge', () => {
  beforeAll(() => registerBlackForgeI18n(i18n));

  it('español e inglés tienen las mismas claves', () => {
    expect(leafKeys(en).sort()).toEqual(leafKeys(es).sort());
  });

  it('quedan disponibles en el espacio de nombres blackforge', () => {
    expect(i18n.t('source.link', { ns: BLACKFORGE_NS, lng: 'es' })).toBe('Código fuente');
    expect(i18n.t('brand.basedOn', { ns: BLACKFORGE_NS, lng: 'es', project: 'Bambuddy' })).toBe(
      'Basado en Bambuddy',
    );
  });

  it('la pantalla de inicio de sesión muestra la marca BlackForge', () => {
    expect(i18n.t('login.title', { lng: 'es' })).toBe('Inicia sesión en BlackForge Print');
    expect(i18n.t('login.title', { lng: 'en' })).toBe('Sign in to BlackForge Print');
  });

  it('solo sobrescribe claves que Bambuddy realmente usa', () => {
    // Si Bambuddy renombra una clave, la sobrescritura quedaría huérfana sin avisar.
    const bambuddyKeys = new Set(leafKeys(bambuddyEn as unknown as Tree));
    const fallbackOnly = ['printers.noActiveJob', 'printers.status.title']; // usadas con defaultValue
    for (const lng of ['es', 'en'] as const) {
      for (const key of leafKeys(translationOverrides[lng] as unknown as Tree)) {
        if (fallbackOnly.includes(key)) continue;
        expect(bambuddyKeys, `${lng}: ${key}`).toContain(key);
      }
    }
  });
});
