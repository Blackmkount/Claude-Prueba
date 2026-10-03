// Textos de Bambuddy que muestran la marca en pantallas muy visibles (inicio de
// sesión y configuración inicial). Se sobrescriben en tiempo de ejecución, sin
// tocar frontend/src/i18n/locales/ (así no hay conflictos al traer actualizaciones).
// El resto de menciones a «Bambuddy» se dejan: describen el motor y dan crédito.
export const translationOverrides = {
  es: {
    login: {
      title: 'Inicia sesión en BlackForge Print',
      subtitle: 'Entra con tu usuario del taller',
    },
    setup: {
      title: 'Configuración de BlackForge Print',
      subtitle: 'Configura el acceso al sistema del taller',
    },
    // Claves que Bambuddy usa con texto de respaldo en inglés y no tiene en es.ts.
    printers: {
      noActiveJob: 'Sin trabajo activo',
      status: { title: 'Estado' },
    },
  },
  en: {
    login: {
      title: 'Sign in to BlackForge Print',
      subtitle: 'Sign in with your workshop account',
    },
    setup: {
      title: 'BlackForge Print setup',
      subtitle: 'Configure access to the workshop system',
    },
  },
} as const;
