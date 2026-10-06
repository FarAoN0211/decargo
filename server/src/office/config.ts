import { randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import type { Pool } from 'pg';
import { appendAudit } from '../common/audit';
import { optional } from '../common/config';
import { generateCartaPdf } from '../pdf/carta-pdf';
import { generateDecaPdf, type DecaData } from '../pdf/deca-pdf';
import { DOC_TEMPLATES, docTemplate, showDriverInDeca, FLAG_KEYS, PUBLIC_BASE_KEY, devEndpoints, flagSource, foodTransport, getPublicBase, normalizePublicBase, publicBaseSource, testMode, warnDays } from '../common/settings';
import { isPublicAddress } from '../external/netpolicy';
import { Actor, ApiError, actorStr } from '../identity/service';
import { addrParts, bad, nif, text } from './validate';
import { FCM_CLIENT_KEY, FCM_PACKAGE, FCM_SERVICE_KEY, accessToken, encryptServiceAccount, fcmClient, fcmReady, parseGoogleServices, parseServiceAccount } from '../identity/fcm';

/** Configuración de la instalación visible para el administrador (nunca devuelve secretos). */
export async function getConfig(pool: Pool) {
  let base: string | null = null, error: string | null = null;
  try { base = await getPublicBase(pool); } catch { error = 'La dirección pública configurada no es válida.'; }
  const other = base ? Number((await pool.query(`SELECT count(*)::int AS n FROM deca WHERE status = 'ACTIVE' AND public_url IS NOT NULL AND left(public_url, $2) <> $1`, [`${base}/d/`, base.length + 3])).rows[0].n) : 0;
  const total = Number((await pool.query("SELECT count(*)::int AS n FROM deca WHERE status = 'ACTIVE'")).rows[0].n);
  return {
    public_base_url: base, source: await publicBaseSource(pool), env_public_base_url: optional('PUBLIC_DOCS_BASE_URL', '') || null, error,
    https: !!base && base.startsWith('https://'), insecure_allowed: optional('ALLOW_INSECURE_PUBLIC_URL', '0') === '1',
    test_mode: await testMode(pool), test_mode_source: await flagSource(pool, FLAG_KEYS.test_mode),
    dev_endpoints: await devEndpoints(pool), dev_endpoints_available: !!process.env.DEV_API_KEY,
    doc_template: await docTemplate(pool), doc_templates: DOC_TEMPLATES, deca_show_driver: await showDriverInDeca(pool),
    food_transport: await foodTransport(pool), expiry_warn_days: await warnDays(pool),
    company: (await pool.query('SELECT name, nif, address, postal_code, city, province, country FROM company ORDER BY created_at LIMIT 1')).rows[0] ?? null,
    push_configured: !!process.env.VAPID_PUBLIC_KEY && !!process.env.VAPID_PRIVATE_KEY,
    fcm: await fcmInfo(pool),
    decas_total: total, decas_other_base: other
  };
}

export async function setPublicBase(pool: Pool, actor: Actor, raw: unknown) {
  let url: string;
  try { url = normalizePublicBase(raw); } catch (e) { throw new ApiError(400, 'invalid_public_url', { reason: (e as Error).message }); }
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const before = (await c.query('SELECT value FROM app_setting WHERE key = $1', [PUBLIC_BASE_KEY])).rows[0]?.value ?? null;
    await c.query(
      `INSERT INTO app_setting (key, value, updated_by) VALUES ($1,$2,$3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`, [PUBLIC_BASE_KEY, url, actorStr(actor)]);
    const co = (await c.query('SELECT id FROM company ORDER BY created_at LIMIT 1')).rows[0];
    await appendAudit(c, { company_id: co?.id ?? null, at: new Date(), actor: actorStr(actor), action: 'CONFIG_PUBLIC_URL_CHANGED', entity: 'config', entity_id: PUBLIC_BASE_KEY,
      before: before ? { url: before } : null, after: { url }, reason: null });
    await c.query('COMMIT');
  } catch (e) { try { await c.query('ROLLBACK'); } catch { /* */ } throw e; } finally { c.release(); }
  return getConfig(pool);
}

interface Probe { ok: boolean; status: number | null; detail: string }

async function probe(url: string, expect: (status: number, body: string) => boolean, okText: string, failText: string): Promise<Probe> {
  try {
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(7000), headers: { 'user-agent': 'DECARGO-config-check' } });
    const body = (await res.text()).slice(0, 4096);
    return expect(res.status, body) ? { ok: true, status: res.status, detail: okText } : { ok: false, status: res.status, detail: failText };
  } catch (e) {
    const code = (e as { cause?: { code?: string } }).cause?.code ?? (e as Error).name;
    return { ok: false, status: null, detail: `No se pudo conectar (${code}). ¿El dominio apunta a este servidor y el proxy tiene el certificado?` };
  }
}

/**
 * Comprueba DESDE EL SERVIDOR que una dirección pública llega a DECARGO: la web en «/» y el servicio documental en «/d/».
 * El resultado solo dice sí/no (nunca se devuelve contenido remoto). Solo dominios públicos; con ALLOW_INSECURE_PUBLIC_URL=1 (pruebas) no se aplica ese filtro.
 */
export async function checkPublicBase(pool: Pool, raw: unknown) {
  let base: string;
  try { base = raw === undefined || raw === null || raw === '' ? await getPublicBase(pool) : normalizePublicBase(raw); } catch { throw bad('url'); }
  const insecure = optional('ALLOW_INSECURE_PUBLIC_URL', '0') === '1';
  if (!insecure) {
    const host = new URL(base).hostname;
    let addrs: string[] = [];
    try { addrs = (await lookup(host, { all: true })).map((a) => a.address); } catch { /* sin DNS */ }
    if (!addrs.length) return { url: base, checked: false, reason: 'dns', web: null, docs: null };
    if (!addrs.every(isPublicAddress)) return { url: base, checked: false, reason: 'privada', web: null, docs: null };
  }
  const web = await probe(`${base}/`, (s, b) => s === 200 && b.includes('DECARGO'), 'La web de DECARGO responde en esta dirección.', 'Responde otra cosa distinta de DECARGO en «/».');
  const docs = await probe(`${base}/d/${randomBytes(32).toString('base64url')}`, (s, b) => s === 404 && /not found/i.test(b) && !/<html/i.test(b), 'El servicio documental responde en «/d/».', 'La ruta «/d/» no llega al servicio documental: en el proxy, «/d/» debe ir a docs.');
  return { url: base, checked: true, reason: null, web, docs };
}

/** Interruptores de la instalación (solo administrador): modo de pruebas de los PDF y endpoints de prueba. Quedan auditados. */
export async function setFlags(pool: Pool, actor: Actor, body: Record<string, unknown>) {
  const changes: Array<[string, boolean]> = [];
  for (const k of ['test_mode', 'dev_endpoints'] as const) {
    if (body[k] === undefined) continue;
    if (typeof body[k] !== 'boolean') throw bad(k);
    changes.push([k, body[k] as boolean]);
  }
  if (!changes.length) throw bad('test_mode');
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const co = (await c.query('SELECT id FROM company ORDER BY created_at LIMIT 1')).rows[0];
    for (const [k, v] of changes) {
      const before = k === 'test_mode' ? await testMode(c) : await devEndpoints(c);
      await c.query(`INSERT INTO app_setting (key, value, updated_by) VALUES ($1,$2,$3)
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`, [k, v ? '1' : '0', actorStr(actor)]);
      await appendAudit(c, { company_id: co?.id ?? null, at: new Date(), actor: actorStr(actor), action: 'CONFIG_FLAG_CHANGED', entity: 'config', entity_id: k, before: { enabled: before }, after: { enabled: v }, reason: null });
    }
    await c.query('COMMIT');
  } catch (e) { try { await c.query('ROLLBACK'); } catch { /* */ } throw e; } finally { c.release(); }
  return getConfig(pool);
}

/** Datos de la empresa = transportista efectivo por defecto de todos los transportes y DeCA NUEVOS. Los ya emitidos conservan los suyos. */
export async function setCompany(pool: Pool, actor: Actor, body: Record<string, unknown>) {
  const name = text(body.name, 'name', 2, 120), nifV = nif(body.nif, 'nif'), address = text(body.address, 'address', 5, 200), ap = addrParts(body, 'city');
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const before = (await c.query('SELECT id, name, nif, address, postal_code, city, province, country FROM company ORDER BY created_at LIMIT 1')).rows[0];
    if (!before) throw new ApiError(409, 'no_company');
    await c.query('UPDATE company SET name = $2, nif = $3, address = $4, postal_code = $5, city = $6, province = $7, country = $8 WHERE id = $1', [before.id, name, nifV, address, ap.postal_code, ap.city, ap.province, ap.country]);
    await appendAudit(c, { company_id: before.id, at: new Date(), actor: actorStr(actor), action: 'COMPANY_UPDATED', entity: 'company', entity_id: before.id,
      before: { name: before.name, nif: before.nif, address: before.address, city: before.city ?? '' }, after: { name, nif: nifV, address, city: ap.city ?? '' }, reason: null });
    await c.query('COMMIT');
  } catch (e) { try { await c.query('ROLLBACK'); } catch { /* */ } throw e; } finally { c.release(); }
  return getConfig(pool);
}

/** Ajustes del control de documentos: ¿transporta alimentos? (muestra ATP y similares) y días de aviso antes de una caducidad. */
export async function setDocSettings(pool: Pool, actor: Actor, body: Record<string, unknown>) {
  const changes: Array<[string, string, unknown]> = [];
  if (body.food_transport !== undefined) { if (typeof body.food_transport !== 'boolean') throw bad('food_transport'); changes.push([FLAG_KEYS.food_transport, body.food_transport ? '1' : '0', body.food_transport]); }
  if (body.warn_days !== undefined) { const n = body.warn_days; if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 365) throw bad('warn_days'); changes.push(['expiry_warn_days', String(n), n]); }
  if (!changes.length) throw bad('food_transport');
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const co = (await c.query('SELECT id FROM company ORDER BY created_at LIMIT 1')).rows[0];
    for (const [key, value, shown] of changes) {
      const before = (await c.query('SELECT value FROM app_setting WHERE key = $1', [key])).rows[0]?.value ?? null;
      await c.query(`INSERT INTO app_setting (key, value, updated_by) VALUES ($1,$2,$3) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`, [key, value, actorStr(actor)]);
      await appendAudit(c, { company_id: co?.id ?? null, at: new Date(), actor: actorStr(actor), action: 'CONFIG_FLAG_CHANGED', entity: 'config', entity_id: key, before: before === null ? null : { value: before }, after: { value: shown }, reason: null });
    }
    await c.query('COMMIT');
  } catch (e) { try { await c.query('ROLLBACK'); } catch { /* */ } throw e; } finally { c.release(); }
  return getConfig(pool);
}

/** Modelo de documento de la empresa y si se imprimen los datos del conductor (casilla 9). Cambia solo los DeCA que se emitan a partir de ahora. */
export async function setTemplate(pool: Pool, actor: Actor, body: Record<string, unknown>) {
  const changes: Array<[string, string, unknown]> = [];
  if (body.template !== undefined) { if (!DOC_TEMPLATES.some((t) => t.code === body.template)) throw bad('template'); changes.push(['doc_template', String(body.template), body.template]); }
  if (body.show_driver !== undefined) { if (typeof body.show_driver !== 'boolean') throw bad('show_driver'); changes.push(['deca_show_driver', body.show_driver ? '1' : '0', body.show_driver]); }
  if (!changes.length) throw bad('template');
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const co = (await c.query('SELECT id FROM company ORDER BY created_at LIMIT 1')).rows[0];
    for (const [key, value, shown] of changes) {
      const before = (await c.query('SELECT value FROM app_setting WHERE key = $1', [key])).rows[0]?.value ?? null;
      await c.query(`INSERT INTO app_setting (key, value, updated_by) VALUES ($1,$2,$3) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`, [key, value, actorStr(actor)]);
      await appendAudit(c, { company_id: co?.id ?? null, at: new Date(), actor: actorStr(actor), action: 'CONFIG_FLAG_CHANGED', entity: 'config', entity_id: key, before: before === null ? null : { value: before }, after: { value: shown }, reason: null });
    }
    await c.query('COMMIT');
  } catch (e) { try { await c.query('ROLLBACK'); } catch { /* */ } throw e; } finally { c.release(); }
  return getConfig(pool);
}

/** PDF de muestra de un modelo (datos ficticios, con rótulo de ejemplo) o formulario en blanco para imprimir. No crea ningún DeCA. */
export async function templatePreview(pool: Pool, templateRaw: unknown, modeRaw: unknown): Promise<Buffer> {
  if (!DOC_TEMPLATES.some((t) => t.code === templateRaw)) throw bad('template');
  const blank = modeRaw === 'blanco';
  const co = (await pool.query('SELECT name, nif, address FROM company ORDER BY created_at LIMIT 1')).rows[0] ?? { name: 'EMPRESA DE EJEMPLO S.L.', nif: 'B00000000', address: 'Calle Ejemplo 1, 04000 Almería' };
  const now = new Date();
  const sample: DecaData = {
    shipper: { name: 'CARGADOR DE EJEMPLO S.A.', nif: 'A00000000', address: 'Polígono Ejemplo, nave 2, 04700 El Ejido' }, carrier: { name: co.name, nif: co.nif }, carrierAddress: co.address,
    origin: 'Almacén de ejemplo, El Ejido', destination: 'Centro logístico de ejemplo, 28042 Madrid', originPlaces: ['El Ejido'], destinationPlaces: ['Madrid'],
    consignees: [{ name: 'DESTINATARIO DE EJEMPLO S.L.', address: 'Calle Quebec 8, Centro de Carga Aérea, 28042 Madrid' }],
    cargoDescription: 'Mercancía general', weightKg: '10575.50', altMagnitude: null, aecRef: null, packages: '21 palets', loadReference: '616918', temperature: 'Sin temperatura', priceEur: null,
    transportDate: now.toISOString().slice(0, 10), tractorPlate: '0000 BBB', trailerPlate: 'R-0000-BBB', remarks: 'Datos de ejemplo.', driver: { name: 'CONDUCTOR DE EJEMPLO', nif: '00000000T', phone: '600000000' }
  };
  const empty: DecaData = { shipper: { name: '', nif: '', address: '' }, carrier: { name: '', nif: '' }, origin: '', destination: '', cargoDescription: '', weightKg: null, altMagnitude: null, aecRef: null, transportDate: now.toISOString().slice(0, 10), tractorPlate: '', trailerPlate: null, remarks: null };
  const input = { decaId: '00000000-0000-4000-8000-000000000000', versionNo: 1, data: blank ? { ...empty, consignees: [] } : sample, url: 'https://ejemplo.invalid/d/EJEMPLO', createdAt: now, modifiedAt: now, isTest: false, blank,
    banner: blank ? undefined : 'MODELO DE EJEMPLO · SIN VALOR · DECARGO' };
  return templateRaw === 'CARTA_DE_PORTE' ? generateCartaPdf(input) : generateDecaPdf(input);
}

/** Estado de los avisos de la app Android (Firebase): nunca devuelve la clave privada. */
async function fcmInfo(pool: Pool) {
  const c = await fcmClient(pool);
  const at = (await pool.query('SELECT updated_at, updated_by FROM app_setting WHERE key = $1', [FCM_SERVICE_KEY])).rows[0];
  return { configured: await fcmReady(pool), project_id: c?.project_id ?? null, package: FCM_PACKAGE, updated_at: at?.updated_at ?? null, updated_by: at?.updated_by ?? null };
}

/**
 * Credenciales de Firebase para la app Android: el google-services.json (datos públicos de la app) y la cuenta de servicio (clave privada,
 * se guarda cifrada con APP_KEY). Antes de guardar se comprueba con Google que la cuenta de servicio funciona. `clear: true` las quita.
 */
export async function setFcm(pool: Pool, actor: Actor, body: Record<string, unknown>) {
  const clear = body.clear === true;
  let client: string | null = null, service: string | null = null, project: string | null = null;
  if (!clear) {
    const cl = parseGoogleServices(body.google_services);
    const sa = parseServiceAccount(body.service_account);
    if (cl.project_id !== sa.project_id) throw new ApiError(400, 'fcm_proyecto_distinto');
    try { await accessToken(sa); } catch (e) { if (e instanceof ApiError) throw e; throw new ApiError(400, 'fcm_credenciales'); }
    client = JSON.stringify(cl); service = encryptServiceAccount(sa); project = cl.project_id;
  }
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const before = (await fcmClient(c))?.project_id ?? null;
    for (const [k, v] of [[FCM_CLIENT_KEY, client ?? ''], [FCM_SERVICE_KEY, service ?? '']] as const) {
      await c.query(`INSERT INTO app_setting (key, value, updated_by) VALUES ($1,$2,$3)
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`, [k, v, actorStr(actor)]);
    }
    const co = (await c.query('SELECT id FROM company ORDER BY created_at LIMIT 1')).rows[0];
    await appendAudit(c, { company_id: co?.id ?? null, at: new Date(), actor: actorStr(actor), action: 'CONFIG_FLAG_CHANGED', entity: 'config', entity_id: 'fcm',
      before: before ? { project_id: before } : null, after: project ? { project_id: project } : null, reason: null });
    await c.query('COMMIT');
  } catch (e) { try { await c.query('ROLLBACK'); } catch { /* */ } throw e; } finally { c.release(); }
  return getConfig(pool);
}
