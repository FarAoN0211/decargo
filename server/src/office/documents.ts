import type { Pool } from 'pg';
import { appendAudit } from '../common/audit';
import { required } from '../common/config';
import { foodTransport, warnDays } from '../common/settings';
import { decryptToken, encryptToken } from '../common/token';
import { Actor, ApiError, actorStr } from '../identity/service';
import { ASSET_KINDS, DOC_TYPES, type DocType, type Subject } from './catalog';
import { UUID_RE, bad, isoDate, optMultiline, optText, text } from './validate';

/** Hoy en España (las caducidades son fechas de calendario). */
const TODAY = `(now() AT TIME ZONE 'Europe/Madrid')::date`;
const SUBJECTS: Subject[] = ['DRIVER', 'VEHICLE', 'COMPANY'];
const PIN_RE = /^[A-Za-z0-9]{3,12}$/;

const DOC_COLS = `d.id, d.subject_kind, d.user_id, d.vehicle_id, d.doc_type, d.label, d.number, d.detail, d.issued_on::text AS issued_on, d.expires_on::text AS expires_on,
  d.notes, d.active, (d.expires_on - ${TODAY})::int AS days_left, d.updated_at`;

export async function catalog(pool: Pool) {
  const food = await foodTransport(pool);
  const by = (s: Subject): DocType[] => DOC_TYPES.filter((t) => t.subject === s && (food || !t.food));
  return { food_transport: food, warn_days: await warnDays(pool), driver: by('DRIVER'), vehicle: by('VEHICLE'), company: by('COMPANY'), assets: ASSET_KINDS };
}

async function companyOf(pool: Pool): Promise<string> {
  const co = (await pool.query('SELECT id FROM company ORDER BY created_at LIMIT 1')).rows[0];
  if (!co) throw new ApiError(409, 'no_company');
  return co.id;
}

function optDate(v: unknown, field: string): string | null {
  return v === undefined || v === null || v === '' ? null : isoDate(v, field);
}
function checkRange(issued: string | null, expires: string | null): void {
  if (issued && expires && expires < issued) throw bad('expires_on');
}

export async function listDocuments(pool: Pool, q: { user_id?: string; vehicle_id?: string; company?: string; all?: string }) {
  const all = q.all === '1';
  let where: string, arg: string | null = null;
  if (q.user_id) { if (!UUID_RE.test(q.user_id)) throw bad('user_id'); where = 'd.user_id = $1'; arg = q.user_id; }
  else if (q.vehicle_id) { if (!UUID_RE.test(q.vehicle_id)) throw bad('vehicle_id'); where = 'd.vehicle_id = $1'; arg = q.vehicle_id; }
  else if (q.company === '1') where = `d.subject_kind = 'COMPANY'`;
  else throw bad('user_id');
  return (await pool.query(
    `SELECT ${DOC_COLS} FROM control_document d WHERE ${where} ${all ? '' : 'AND d.active'} ORDER BY d.active DESC, d.expires_on NULLS LAST, d.created_at`, arg ? [arg] : [])).rows;
}

export async function createDocument(pool: Pool, actor: Actor, b: Record<string, unknown>) {
  const kind = b.subject_kind as Subject;
  if (!SUBJECTS.includes(kind)) throw bad('subject_kind');
  const type = DOC_TYPES.find((t) => t.subject === kind && t.code === b.doc_type);
  if (!type) throw bad('doc_type');
  let userId: string | null = null, vehicleId: string | null = null, companyId: string;
  if (kind === 'DRIVER') {
    if (typeof b.user_id !== 'string' || !UUID_RE.test(b.user_id)) throw bad('user_id');
    const u = (await pool.query(`SELECT id, company_id FROM app_user WHERE id = $1 AND role = 'conductor'`, [b.user_id])).rows[0];
    if (!u) throw bad('user_id');
    userId = u.id; companyId = u.company_id;
  } else if (kind === 'VEHICLE') {
    if (typeof b.vehicle_id !== 'string' || !UUID_RE.test(b.vehicle_id)) throw bad('vehicle_id');
    const v = (await pool.query('SELECT id, company_id, kind FROM vehicle WHERE id = $1', [b.vehicle_id])).rows[0];
    if (!v) throw bad('vehicle_id');
    if (type.kinds && !type.kinds.includes(v.kind)) throw bad('doc_type');      // p. ej. el ATP no es de una tractora
    vehicleId = v.id; companyId = v.company_id;
  } else companyId = await companyOf(pool);
  const label = type.code === 'OTRO' ? text(b.label, 'label', 2, 80) : null;
  const number = optText(b.number, 'number', 60), detail = optText(b.detail, 'detail', 80), notes = optMultiline(b.notes, 'notes', 500);
  const issued = optDate(b.issued_on, 'issued_on'), expires = optDate(b.expires_on, 'expires_on');
  checkRange(issued, expires);
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const id = (await c.query(
      `INSERT INTO control_document (company_id, subject_kind, user_id, vehicle_id, doc_type, label, number, detail, issued_on, expires_on, notes, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12) RETURNING id`, [companyId, kind, userId, vehicleId, type.code, label, number, detail, issued, expires, notes, actorStr(actor)])).rows[0].id;
    await appendAudit(c, { company_id: companyId, at: new Date(), actor: actorStr(actor), action: 'DOCUMENT_CREATED', entity: 'control_document', entity_id: id, before: null,
      after: { subject: kind, subject_id: userId ?? vehicleId ?? 'empresa', type: type.code, expires_on: expires ?? 'sin caducidad' }, reason: null });
    await c.query('COMMIT');
    return (await pool.query(`SELECT ${DOC_COLS} FROM control_document d WHERE d.id = $1`, [id])).rows[0];
  } catch (e) { try { await c.query('ROLLBACK'); } catch { /* */ } throw e; } finally { c.release(); }
}

export async function updateDocument(pool: Pool, actor: Actor, id: string, b: Record<string, unknown>) {
  if (!UUID_RE.test(id)) throw new ApiError(404, 'no_encontrado');
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`doc:${id}`]);
    const d = (await c.query(`SELECT *, issued_on::text AS issued_t, expires_on::text AS expires_t FROM control_document WHERE id = $1`, [id])).rows[0];
    if (!d) throw new ApiError(404, 'no_encontrado');
    const next: Record<string, unknown> = {};
    if ('label' in b) next.label = d.doc_type === 'OTRO' ? text(b.label, 'label', 2, 80) : null;
    if ('number' in b) next.number = optText(b.number, 'number', 60);
    if ('detail' in b) next.detail = optText(b.detail, 'detail', 80);
    if ('notes' in b) next.notes = optMultiline(b.notes, 'notes', 500);
    if ('issued_on' in b) next.issued_on = optDate(b.issued_on, 'issued_on');
    if ('expires_on' in b) next.expires_on = optDate(b.expires_on, 'expires_on');
    if ('active' in b) { if (typeof b.active !== 'boolean') throw bad('active'); next.active = b.active; }
    checkRange((next.issued_on ?? d.issued_t) as string | null, (next.expires_on ?? d.expires_t) as string | null);
    const cols = Object.keys(next);
    if (!cols.length) throw bad('expires_on');
    await c.query(`UPDATE control_document SET ${cols.map((k, i) => `${k} = $${i + 3}`).join(', ')}, updated_at = now(), updated_by = $2 WHERE id = $1`, [id, actorStr(actor), ...cols.map((k) => next[k])]);
    const show = (o: Record<string, unknown>, issued: unknown, expires: unknown): Record<string, unknown> => ({ type: d.doc_type, number: o.number ?? null, detail: o.detail ?? null, issued_on: issued ?? null, expires_on: expires ?? null, active: o.active });
    await appendAudit(c, { company_id: d.company_id, at: new Date(), actor: actorStr(actor), action: next.active === false ? 'DOCUMENT_ARCHIVED' : 'DOCUMENT_UPDATED', entity: 'control_document', entity_id: id,
      before: show(d, d.issued_t, d.expires_t), after: show({ ...d, ...next }, 'issued_on' in next ? next.issued_on : d.issued_t, 'expires_on' in next ? next.expires_on : d.expires_t), reason: null });
    await c.query('COMMIT');
    return (await pool.query(`SELECT ${DOC_COLS} FROM control_document d WHERE d.id = $1`, [id])).rows[0];
  } catch (e) { try { await c.query('ROLLBACK'); } catch { /* */ } throw e; } finally { c.release(); }
}

// ----------------------------------------------------------------------------- tarjetas y dispositivos de vehículo
const ASSET_COLS = `a.id, a.vehicle_id, a.kind, a.provider, a.identifier, (a.pin_enc IS NOT NULL) AS has_pin, a.expires_on::text AS expires_on, a.notes, a.active, (a.expires_on - ${TODAY})::int AS days_left`;

export async function listAssets(pool: Pool, vehicleId: string, all: boolean) {
  if (!UUID_RE.test(vehicleId)) throw new ApiError(404, 'no_encontrado');
  return (await pool.query(`SELECT ${ASSET_COLS} FROM vehicle_asset a WHERE a.vehicle_id = $1 ${all ? '' : 'AND a.active'} ORDER BY a.active DESC, a.kind, a.created_at`, [vehicleId])).rows;
}

const kindOf = (k: unknown): (typeof ASSET_KINDS)[number] => {
  const kind = ASSET_KINDS.find((x) => x.code === k);
  if (!kind) throw bad('kind');
  return kind;
};
const pinOf = (v: unknown): string => { if (typeof v !== 'string' || !PIN_RE.test(v)) throw bad('pin'); return v; };

export async function createAsset(pool: Pool, actor: Actor, vehicleId: string, b: Record<string, unknown>) {
  if (!UUID_RE.test(vehicleId)) throw new ApiError(404, 'no_encontrado');
  const v = (await pool.query('SELECT id, company_id FROM vehicle WHERE id = $1', [vehicleId])).rows[0];
  if (!v) throw new ApiError(404, 'no_encontrado');
  const kind = kindOf(b.kind);
  const provider = optText(b.provider, 'provider', 60), identifier = text(b.identifier, 'identifier', 3, 60), notes = optMultiline(b.notes, 'notes', 500), expires = optDate(b.expires_on, 'expires_on');
  const hasPin = b.pin !== undefined && b.pin !== null && b.pin !== '';
  if (hasPin && !kind.hasPin) throw bad('pin');
  const pinEnc = hasPin ? encryptToken(pinOf(b.pin), required('APP_KEY')) : null;
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const id = (await c.query(
      `INSERT INTO vehicle_asset (company_id, vehicle_id, kind, provider, identifier, pin_enc, expires_on, notes, created_by, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING id`,
      [v.company_id, v.id, kind.code, provider, identifier, pinEnc, expires, notes, actorStr(actor)])).rows[0].id;
    await appendAudit(c, { company_id: v.company_id, at: new Date(), actor: actorStr(actor), action: 'VEHICLE_ASSET_CREATED', entity: 'vehicle_asset', entity_id: id, before: null,
      after: { vehicle_id: v.id, kind: kind.code, provider: provider ?? '', pin: hasPin ? 'establecido' : 'sin PIN', expires_on: expires ?? 'sin caducidad' }, reason: null });
    await c.query('COMMIT');
    return (await pool.query(`SELECT ${ASSET_COLS} FROM vehicle_asset a WHERE a.id = $1`, [id])).rows[0];
  } catch (e) { try { await c.query('ROLLBACK'); } catch { /* */ } throw e; } finally { c.release(); }
}

export async function updateAsset(pool: Pool, actor: Actor, id: string, b: Record<string, unknown>) {
  if (!UUID_RE.test(id)) throw new ApiError(404, 'no_encontrado');
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`asset:${id}`]);
    const a = (await c.query(`SELECT *, expires_on::text AS expires_t FROM vehicle_asset WHERE id = $1`, [id])).rows[0];
    if (!a) throw new ApiError(404, 'no_encontrado');
    const next: Record<string, unknown> = {};
    let pinChange: 'set' | 'clear' | null = null;
    if ('provider' in b) next.provider = optText(b.provider, 'provider', 60);
    if ('identifier' in b) next.identifier = text(b.identifier, 'identifier', 3, 60);
    if ('expires_on' in b) next.expires_on = optDate(b.expires_on, 'expires_on');
    if ('notes' in b) next.notes = optMultiline(b.notes, 'notes', 500);
    if ('active' in b) { if (typeof b.active !== 'boolean') throw bad('active'); next.active = b.active; }
    if ('pin' in b) {
      if (b.pin === null || b.pin === '') { next.pin_enc = null; pinChange = 'clear'; }
      else { if (!ASSET_KINDS.find((k) => k.code === a.kind)?.hasPin) throw bad('pin'); next.pin_enc = encryptToken(pinOf(b.pin), required('APP_KEY')); pinChange = 'set'; }
    }
    const cols = Object.keys(next);
    if (!cols.length) throw bad('identifier');
    await c.query(`UPDATE vehicle_asset SET ${cols.map((k, i) => `${k} = $${i + 3}`).join(', ')}, updated_at = now(), updated_by = $2 WHERE id = $1`, [id, actorStr(actor), ...cols.map((k) => next[k])]);
    const show = (o: Record<string, unknown>, expires: unknown): Record<string, unknown> => ({ kind: a.kind, provider: o.provider ?? '', identifier: o.identifier, expires_on: expires ?? 'sin caducidad', active: o.active });
    await appendAudit(c, { company_id: a.company_id, at: new Date(), actor: actorStr(actor), action: next.active === false ? 'VEHICLE_ASSET_ARCHIVED' : 'VEHICLE_ASSET_UPDATED', entity: 'vehicle_asset', entity_id: id,
      before: show(a, a.expires_t), after: { ...show({ ...a, ...next }, 'expires_on' in next ? next.expires_on : a.expires_t), pin: pinChange === 'set' ? 'cambiado' : pinChange === 'clear' ? 'borrado' : 'sin cambios' }, reason: null });
    await c.query('COMMIT');
    return (await pool.query(`SELECT ${ASSET_COLS} FROM vehicle_asset a WHERE a.id = $1`, [id])).rows[0];
  } catch (e) { try { await c.query('ROLLBACK'); } catch { /* */ } throw e; } finally { c.release(); }
}

/** Muestra el PIN descifrado SOLO a quien lo pide expresamente (oficina/administrador). Cada consulta queda auditada. Nunca va en listados ni en logs. */
export async function revealPin(pool: Pool, actor: Actor, id: string): Promise<{ pin: string }> {
  if (!UUID_RE.test(id)) throw new ApiError(404, 'no_encontrado');
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const a = (await c.query('SELECT id, company_id, vehicle_id, kind, pin_enc FROM vehicle_asset WHERE id = $1', [id])).rows[0];
    if (!a || !a.pin_enc) throw new ApiError(404, 'sin_pin');
    await appendAudit(c, { company_id: a.company_id, at: new Date(), actor: actorStr(actor), action: 'VEHICLE_ASSET_PIN_REVEALED', entity: 'vehicle_asset', entity_id: id, before: null, after: { vehicle_id: a.vehicle_id, kind: a.kind }, reason: null });
    await c.query('COMMIT');
    return { pin: decryptToken(a.pin_enc, required('APP_KEY')) };
  } catch (e) { try { await c.query('ROLLBACK'); } catch { /* */ } throw e; } finally { c.release(); }
}

// ----------------------------------------------------------------------------- alertas de caducidad
export interface Expiry { source: 'document' | 'asset'; id: string; subject_kind: Subject; subject: string; user_id: string | null; vehicle_id: string | null; what: string; expires_on: string; days_left: number; status: 'CADUCADO' | 'PROXIMO' }

/** Caducados y próximos a caducar (dentro de `days`, por defecto los días de aviso). Los usuarios y vehículos inactivos no generan alertas. */
export async function listExpiries(pool: Pool, opts: { days?: number; driverId?: string | null; vehicleIds?: string[] } = {}): Promise<Expiry[]> {
  const days = opts.days ?? (await warnDays(pool));
  const scoped = opts.driverId !== undefined || opts.vehicleIds !== undefined;
  const params: unknown[] = scoped ? [days, opts.driverId ?? null, opts.vehicleIds ?? []] : [days];   // PostgreSQL exige exactamente los parámetros que usa la consulta
  const scope = (u: string, v: string): string => (scoped ? `AND (${u} = $2::uuid OR ${v} = ANY($3::uuid[]))` : '');
  const docs = (await pool.query(
    `SELECT d.id, d.subject_kind, COALESCE(u.full_name, v.plate_display, 'Empresa') AS subject, d.user_id, d.vehicle_id, d.doc_type, d.label, d.expires_on::text AS expires_on, (d.expires_on - ${TODAY})::int AS days_left
     FROM control_document d LEFT JOIN app_user u ON u.id = d.user_id LEFT JOIN vehicle v ON v.id = d.vehicle_id
     WHERE d.active AND d.expires_on IS NOT NULL AND d.expires_on <= ${TODAY} + $1::int AND (u.id IS NULL OR u.active) AND (v.id IS NULL OR v.active) ${scope('d.user_id', 'd.vehicle_id')}`, params)).rows;
  const assets = (await pool.query(
    `SELECT a.id, v.plate_display AS subject, a.vehicle_id, a.kind, a.provider, a.identifier, a.expires_on::text AS expires_on, (a.expires_on - ${TODAY})::int AS days_left
     FROM vehicle_asset a JOIN vehicle v ON v.id = a.vehicle_id
     WHERE a.active AND a.expires_on IS NOT NULL AND a.expires_on <= ${TODAY} + $1::int AND v.active ${scope('NULL::uuid', 'a.vehicle_id')}`, params)).rows;
  const out: Expiry[] = [];
  for (const d of docs) {
    const t = DOC_TYPES.find((x) => x.subject === d.subject_kind && x.code === d.doc_type);
    out.push({ source: 'document', id: d.id, subject_kind: d.subject_kind, subject: d.subject, user_id: d.user_id, vehicle_id: d.vehicle_id, what: d.doc_type === 'OTRO' ? d.label : (t?.label ?? d.doc_type), expires_on: d.expires_on, days_left: d.days_left, status: d.days_left < 0 ? 'CADUCADO' : 'PROXIMO' });
  }
  for (const a of assets) {
    const k = ASSET_KINDS.find((x) => x.code === a.kind);
    out.push({ source: 'asset', id: a.id, subject_kind: 'VEHICLE', subject: a.subject, user_id: null, vehicle_id: a.vehicle_id, what: `${k?.label ?? a.kind} ${a.provider ? `(${a.provider}) ` : ''}…${String(a.identifier).slice(-4)}`, expires_on: a.expires_on, days_left: a.days_left, status: a.days_left < 0 ? 'CADUCADO' : 'PROXIMO' });
  }
  return out.sort((x, y) => x.days_left - y.days_left || x.subject.localeCompare(y.subject));
}

export async function expiryCounts(pool: Pool): Promise<{ expired: number; soon: number }> {
  const l = await listExpiries(pool);
  return { expired: l.filter((x) => x.status === 'CADUCADO').length, soon: l.filter((x) => x.status === 'PROXIMO').length };
}
