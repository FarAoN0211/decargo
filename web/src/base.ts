/**
 * Ruta en la que vive la aplicación: «/<DECARGO_APP_PATH>/» (la raíz del dominio es la web pública). nginx solo sirve la aplicación
 * bajo esa ruta, así que es el primer tramo de la dirección actual: no se escribe en el código y cambia sola si se cambia en .env.
 */
/** Demostración: la misma aplicación con un servidor simulado en el navegador y datos ficticios (se compila aparte, en /demo/). */
export const DEMO = import.meta.env.MODE === 'demo';
const first = window.location.pathname.split('/')[1] ?? '';
export const APP_BASE = DEMO ? import.meta.env.BASE_URL : /^[A-Za-z0-9_-]{16,64}$/.test(first) ? `/${first}/` : '/';
