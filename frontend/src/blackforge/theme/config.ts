// Banderas de BlackForge que cambian el comportamiento de componentes de
// Bambuddy (enganches marcados BLACKFORGE).
//
// En las pruebas (vitest, MODE = 'test') quedan apagadas para que las pruebas
// de Bambuddy sigan verificando su comportamiento original sin tocarlas; las
// pruebas de BlackForge las encienden con vi.mock (ver blackforge/__tests__).
const ACTIVE = import.meta.env.MODE !== 'test';

// Identidad BlackForge: la app siempre se ve en tema oscuro. Lo usa el
// ThemeContext de Bambuddy.
export const BLACKFORGE_DARK_ONLY = ACTIVE;

// El botón de Bambuddy para reportar errores envía un paquete de diagnóstico a
// sus desarrolladores: en el taller no aplica. Lo usa Layout.tsx.
export const BLACKFORGE_HIDE_BUG_REPORT = ACTIVE;
