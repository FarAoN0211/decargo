import type { Pool } from 'pg';
import { appendAudit } from '../common/audit';
import { optional } from '../common/config';
import { LocalStorage } from '../common/storage';
import { ApiError, Actor, AuthContext } from '../identity/service';
import { FetchError, SafeFetcher } from './fetcher';
import { parseSafeUrl } from './netpolicy';

/** Cuotas por usuario (cuentan TODOS los intentos, también los fallidos: un sondeo SSRF falla). Valores iniciales, configurables. */
export const QUOTA = {
  perHour: Number(optional('EXTERNAL_QUOTA_HOUR', '5')),
  perDay: Number(optional('EXTERNAL_QUOTA_DAY', '15')),
  perTransport: Number(optional('EXTERNAL_MAX_PER_TRANSPORT', '5'))
};

/** Al conductor solo se le dan categorías gruesas: el detalle (p. ej. «dirección privada») sería un oráculo para sondear la red. */
const PUBLIC_REASON: Record<string, string> = {
  URL_INVALID: 'url_no_valida', NOT_PDF: 'no_es_pdf', TOO_LARGE: 'demasiado_grande'
};
const reasonOf = (o: string): string => PUBLIC_REASON[o] ?? 'no_se_pudo_descargar';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function addExternalDeca(pool: Pool, storage: LocalStorage, fetcher: SafeFetcher, auth: AuthContext, input: { transportId: string; url: string }) {
  if (!UUID_RE.test(input.transportId)) throw new ApiError(404, 'no_encontrado');
  // Solo sobre transportes PROPIOS, en curso o pendientes, y visibles para este dispositivo (un dispositivo pendiente solo ve los anteriores a su registro).
  const t = (await pool.query(
    `SELECT t.id, t.company_id FROM transport_driver_assignment a JOIN transport t ON t.id = a.transport_id
     WHERE t.id = $3 AND a.driver_user_id = $1 AND a.valid_to IS NULL AND t.status IN ('PENDIENTE','EN_CURSO')
       AND ($2::timestamptz IS NULL OR a.valid_from <= $2)`,
    [auth.userId, auth.scope === 'LIMITED' ? auth.deviceRegisteredAt : null, input.transportId])).rows[0];
  if (!t) throw new ApiError(404, 'no_encontrado');

  let host: string;
  try { host = parseSafeUrl(input.url).hostname; } catch { throw new ApiError(400, 'url_no_valida'); }    // sin red ni cuota

  const n = (await pool.query('SELECT count(*)::int AS n FROM external_deca WHERE transport_id = $1', [t.id])).rows[0].n;
  if (n >= QUOTA.perTransport) throw new ApiError(409, 'limit_per_transport', { max: QUOTA.perTransport });

  // Cuota: comprobación e inserción del intento bajo un bloqueo por usuario (sin carreras entre peticiones simultáneas).
  const client = await pool.connect();
  let logId: number;
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('extquota:' || $1))`, [auth.userId]);
    const q = (await client.query(
      `SELECT count(*) FILTER (WHERE requested_at > now() - interval '1 hour')::int AS h,
              count(*)::int AS d,
              COALESCE(EXTRACT(EPOCH FROM (min(requested_at) FILTER (WHERE requested_at > now() - interval '1 hour') + interval '1 hour' - now())), 0) AS retry_h,
              COALESCE(EXTRACT(EPOCH FROM (min(requested_at) + interval '1 day' - now())), 0) AS retry_d
       FROM external_fetch_log WHERE user_id = $1 AND requested_at > now() - interval '1 day' AND outcome NOT IN ('BUSY')`, [auth.userId])).rows[0];
    if (q.h >= QUOTA.perHour || q.d >= QUOTA.perDay) {
      await client.query('ROLLBACK');
      const retry = Math.max(1, Math.ceil(q.h >= QUOTA.perHour ? Number(q.retry_h) : Number(q.retry_d)));
      throw new ApiError(429, 'quota_exceeded', { retry_after_seconds: retry });
    }
    logId = (await client.query(
      'INSERT INTO external_fetch_log (user_id, device_id, transport_id, url_host) VALUES ($1,$2,$3,$4) RETURNING id', [auth.userId, auth.deviceId, t.id, host.slice(0, 253)])).rows[0].id;
    await client.query('COMMIT');
  } catch (e) { try { await client.query('ROLLBACK'); } catch { /* ya cerrada */ } throw e; } finally { client.release(); }

  const finish = (outcome: string, extra: { http?: number; bytes?: number } = {}): Promise<unknown> =>
    pool.query('UPDATE external_fetch_log SET outcome = $2, finished_at = now(), http_status = $3, bytes = $4 WHERE id = $1', [logId, outcome, extra.http ?? null, extra.bytes ?? null]);

  let res;
  try {
    res = await fetcher.fetchPdf(input.url);
  } catch (e) {
    const outcome = e instanceof FetchError ? e.outcome : 'ERROR';
    await finish(outcome);
    if (outcome === 'BUSY') throw new ApiError(503, 'busy');
    if (outcome !== 'ERROR') {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await appendAudit(c, { company_id: t.company_id, at: new Date(), actor: `user:${auth.userId}`, action: 'EXTERNAL_FETCH_REJECTED', entity: 'transport', entity_id: t.id,
          before: null, after: { outcome, host, device_status: auth.deviceStatus }, reason: null });
        await c.query('COMMIT');
      } catch { try { await c.query('ROLLBACK'); } catch { /* */ } } finally { c.release(); }
    }
    throw new ApiError(422, 'external_fetch_failed', { reason: reasonOf(outcome) });
  }

  try {
    const stored = await storage.put(res.body);
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const ins = await c.query(
        `INSERT INTO external_deca (company_id, transport_id, source_url, final_url, file_key, sha256, size_bytes, http_status, content_type, redirects, remote_ip,
           pdf_header_ok, added_by_user, added_by_device, device_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true,$12,$13,$14)
         ON CONFLICT (transport_id, sha256) DO NOTHING RETURNING id, review_status`,
        [t.company_id, t.id, input.url, res.finalUrl, stored.key, stored.sha256, stored.size, res.httpStatus, res.contentType?.slice(0, 120) ?? null, res.redirects, res.remoteIp, auth.userId, auth.deviceId, auth.deviceStatus]);
      let row = ins.rows[0]; let duplicate = false;
      if (!row) {
        duplicate = true;
        row = (await c.query('SELECT id, review_status FROM external_deca WHERE transport_id = $1 AND sha256 = $2', [t.id, stored.sha256])).rows[0];
      } else {
        await appendAudit(c, { company_id: t.company_id, at: new Date(), actor: `user:${auth.userId}`, action: 'EXTERNAL_DECA_ADDED', entity: 'external_deca', entity_id: row.id,
          before: null, after: { transport: t.id, sha256: stored.sha256, size: String(stored.size), host, device_status: auth.deviceStatus }, reason: null });
      }
      await c.query('COMMIT');
      await finish('OK', { http: res.httpStatus, bytes: stored.size });
      return {
        id: row.id, review_status: row.review_status, sha256: stored.sha256, size_bytes: stored.size, duplicate,
        validated: false,          // NUNCA se afirma que sea un DeCA válido: solo que se recibió un PDF
        notice: 'PDF recibido. No se ha comprobado que sea un DeCA válido ni que sustituya al documento propio: queda pendiente de revisión de la oficina.'
      };
    } catch (e) { try { await c.query('ROLLBACK'); } catch { /* */ } throw e; } finally { c.release(); }
  } catch (e) {
    await finish('ERROR');
    throw e;
  }
}

// ------------------------------------------------------------------ oficina
export async function listExternal(pool: Pool, status?: string) {
  return (await pool.query(
    `SELECT e.id, e.transport_id, e.review_status, e.fetched_at, e.sha256, e.size_bytes, e.device_status, e.reviewed_at, e.notes,
            u.username AS added_by, t.transport_date, t.shipper_name
     FROM external_deca e JOIN app_user u ON u.id = e.added_by_user JOIN transport t ON t.id = e.transport_id
     WHERE ($1::text IS NULL OR e.review_status = $1) ORDER BY e.created_at DESC LIMIT 200`, [status ?? null])).rows;
}

export async function externalPdf(pool: Pool, storage: LocalStorage, id: string): Promise<Buffer | null> {
  if (!UUID_RE.test(id)) return null;
  const r = (await pool.query('SELECT file_key, sha256 FROM external_deca WHERE id = $1', [id])).rows[0];
  return r ? storage.getVerified(r.file_key, r.sha256) : null;
}

export async function reviewExternal(pool: Pool, actor: Actor, id: string, notes: string | undefined) {
  if (!UUID_RE.test(id)) throw new ApiError(404, 'no_encontrado');
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const e = (await c.query('SELECT id, company_id, review_status FROM external_deca WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!e) throw new ApiError(404, 'no_encontrado');
    if (e.review_status === 'REVISADO') throw new ApiError(409, 'invalid_state');
    await c.query(`UPDATE external_deca SET review_status = 'REVISADO', reviewed_by = $2, reviewed_at = now(), notes = $3 WHERE id = $1`, [id, actor.userId, notes?.slice(0, 1000) ?? null]);
    // «Revisado» solo significa que la oficina lo ha mirado. NO es una validación jurídica del documento.
    await appendAudit(c, { company_id: e.company_id, at: new Date(), actor: `user:${actor.userId}`, action: 'EXTERNAL_DECA_REVIEWED', entity: 'external_deca', entity_id: id,
      before: { review_status: 'PENDIENTE_DE_REVISION' }, after: { review_status: 'REVISADO' }, reason: null });
    await c.query('COMMIT');
  } catch (e) { try { await c.query('ROLLBACK'); } catch { /* */ } throw e; } finally { c.release(); }
}

// ------------------------------------------------------------------ conductor
const VISIBLE_SQL = `a.driver_user_id = $1 AND a.valid_to IS NULL AND t.status IN ('PENDIENTE','EN_CURSO') AND ($2::timestamptz IS NULL OR a.valid_from <= $2)`;

export async function driverExternalList(pool: Pool, auth: AuthContext, transportId: string) {
  return (await pool.query(
    `SELECT e.id, e.review_status, e.fetched_at, e.sha256, e.size_bytes, e.device_status
     FROM external_deca e JOIN transport t ON t.id = e.transport_id JOIN transport_driver_assignment a ON a.transport_id = t.id
     WHERE t.id = $3 AND ${VISIBLE_SQL} ORDER BY e.created_at`, [auth.userId, auth.scope === 'LIMITED' ? auth.deviceRegisteredAt : null, transportId])).rows
    .map((r) => ({ ...r, validated: false }));
}

export async function driverExternalPdf(pool: Pool, storage: LocalStorage, auth: AuthContext, id: string): Promise<Buffer | null> {
  if (!UUID_RE.test(id)) return null;
  const r = (await pool.query(
    `SELECT e.file_key, e.sha256 FROM external_deca e JOIN transport t ON t.id = e.transport_id JOIN transport_driver_assignment a ON a.transport_id = t.id
     WHERE e.id = $3 AND ${VISIBLE_SQL}`, [auth.userId, auth.scope === 'LIMITED' ? auth.deviceRegisteredAt : null, id])).rows[0];
  return r ? storage.getVerified(r.file_key, r.sha256) : null;
}
