import type { i18n as I18n } from 'i18next';
import en from './en';
import es from './es';
import { translationOverrides } from './overrides';

export const BLACKFORGE_NS = 'blackforge';

/** Registra los textos de BlackForge en la instancia de i18n de Bambuddy. */
export function registerBlackForgeI18n(i18n: I18n): void {
  i18n.addResourceBundle('es', BLACKFORGE_NS, es, true, true);
  i18n.addResourceBundle('en', BLACKFORGE_NS, en, true, true);
  // Sobrescribe solo las claves de marca indicadas (deep = true, overwrite = true).
  i18n.addResourceBundle('es', 'translation', translationOverrides.es, true, true);
  i18n.addResourceBundle('en', 'translation', translationOverrides.en, true, true);
}
