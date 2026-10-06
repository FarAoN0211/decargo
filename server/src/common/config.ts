export function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Falta la variable de entorno ${name}`);
  return v;
}

export function optional(name: string, def: string): string {
  return process.env[name] ?? def;
}

export const DOCUMENTS_DIR = optional('DOCUMENTS_DIR', '/data/documents');

/** El generador exige https salvo que se autorice expresamente (solo pruebas locales). R23 de la Resolución. */
export function publicDocsBaseUrl(): string {
  const base = required('PUBLIC_DOCS_BASE_URL').replace(/\/+$/, '');
  if (!base.startsWith('https://') && process.env.ALLOW_INSECURE_PUBLIC_URL !== '1') {
    throw new Error('PUBLIC_DOCS_BASE_URL debe empezar por https:// (RES, apartado tercero.1). Solo para pruebas locales: ALLOW_INSECURE_PUBLIC_URL=1');
  }
  return base;
}
