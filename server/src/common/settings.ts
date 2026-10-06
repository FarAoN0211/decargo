import { optional, publicDocsBaseUrl } from './config';

interface Queryable { query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, any>> }> }

export const PUBLIC_BASE_KEY = 'public_base_url';

/**
 * Valida y normaliza una dirección pública: https (http solo con ALLOW_INSECURE_PUBLIC_URL=1, pruebas locales),
 * solo dominio y puerto opcional: sin usuario, ruta, consulta ni fragmento. Devuelve «https://dominio[:puerto]».
 */
export function normalizePublicBase(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error('url');
  const s = raw.trim();
  if (s.length < 8 || s.length > 255 || /[\u0000- \u007f-\u009f\\]/.test(s)) throw new Error('url');
  let u: URL;
  try { u = new URL(s); } catch { throw new Error('url'); }
  const insecure = optional('ALLOW_INSECURE_PUBLIC_URL', '0') === '1';
  if (u.protocol !== 'https:' && !(insecure && u.protocol === 'http:')) throw new Error('https');
  if (u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) throw new Error('solo_dominio');
  if (!insecure && (!u.hostname.includes('.') || /^[\d.]+$/.test(u.hostname) || u.hostname.startsWith('['))) throw new Error('dominio');
  return `${u.protocol}//${u.host}`;
}

/** Dirección pública vigente: la guardada desde la web (si existe) y, si no, PUBLIC_DOCS_BASE_URL del .env. */
export async function getPublicBase(q: Queryable): Promise<string> {
  const v = (await q.query('SELECT value FROM app_setting WHERE key = $1', [PUBLIC_BASE_KEY])).rows[0]?.value as string | undefined;
  return v ? normalizePublicBase(v) : publicDocsBaseUrl();
}

export async function publicBaseSource(q: Queryable): Promise<'web' | 'env'> {
  return (await q.query('SELECT 1 FROM app_setting WHERE key = $1', [PUBLIC_BASE_KEY])).rows.length ? 'web' : 'env';
}

/** Interruptor de la instalación: el valor guardado desde la web (Configuración) manda; si no hay, el del .env. */
async function flag(q: Queryable, key: string, envName: string, def: string): Promise<boolean> {
  const v = (await q.query('SELECT value FROM app_setting WHERE key = $1', [key])).rows[0]?.value as string | undefined;
  return (v ?? optional(envName, def)) === '1';
}
export const FLAG_KEYS = { test_mode: 'test_mode', dev_endpoints: 'dev_endpoints', food_transport: 'food_transport' } as const;
/** Mientras esté activo, todo PDF nuevo lleva el rótulo «DOCUMENTO DE PRUEBA · SIN VALOR». */
export const testMode = (q: Queryable): Promise<boolean> => flag(q, FLAG_KEYS.test_mode, 'DECA_TEST_MODE', '1');
export const devEndpoints = (q: Queryable): Promise<boolean> => flag(q, FLAG_KEYS.dev_endpoints, 'DEV_ENDPOINTS', '0');
export async function flagSource(q: Queryable, key: string): Promise<'web' | 'env'> {
  return (await q.query('SELECT 1 FROM app_setting WHERE key = $1', [key])).rows.length ? 'web' : 'env';
}

/** ¿La empresa transporta alimentos? Muestra los documentos de alimentación (ATP, equipo de frío, manipulador, RGSEAA). */
export const foodTransport = (q: Queryable): Promise<boolean> => flag(q, FLAG_KEYS.food_transport, 'FOOD_TRANSPORT', '0');

/** Días de antelación con los que una caducidad pasa a «próxima» (por defecto 30). */
export async function warnDays(q: Queryable): Promise<number> {
  const n = Number((await q.query("SELECT value FROM app_setting WHERE key = 'expiry_warn_days'")).rows[0]?.value);
  return Number.isInteger(n) && n >= 1 && n <= 365 ? n : 30;
}

/** ¿Imprimir en el DeCA el nombre, DNI y teléfono del conductor? Decisión de la empresa; por defecto NO (el DeCA se descarga con su enlace). */
export const showDriverInDeca = (q: Queryable): Promise<boolean> => flag(q, 'deca_show_driver', 'DECA_SHOW_DRIVER', '0');
