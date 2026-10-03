// BlackForge Print — se importa en main.tsx DESPUÉS de inicializar i18n.
// Carga la identidad visual y registra los textos propios del taller.
import './theme/blackforge.css';
import i18n from '../i18n';
import { registerBlackForgeI18n } from './i18n';

registerBlackForgeI18n(i18n);
