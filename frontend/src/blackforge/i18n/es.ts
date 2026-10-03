// Textos de BlackForge Print en español de Colombia (trato de «tú»).
// Espacio de nombres propio («blackforge»), fuera de la verificación de los
// 15 idiomas de Bambuddy. Usar con: useTranslation('blackforge').
const es = {
  brand: {
    name: 'BlackForge Print',
    basedOn: 'Basado en {{project}}',
  },
  source: {
    link: 'Código fuente',
    title: 'Descargar el código fuente de BlackForge Print (licencia AGPL-3.0)',
    downloading: 'Descargando…',
    unavailable: 'El código fuente se incluye al construir la imagen Docker de BlackForge Print.',
    error: 'No se pudo descargar el código fuente. Inténtalo de nuevo.',
  },
};

export default es;
export type BlackForgeStrings = typeof es;
