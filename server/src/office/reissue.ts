import type { Pool, PoolClient } from 'pg';
import { appendAudit } from '../common/audit';
import { getPublicBase, testMode } from '../common/settings';
import type { LocalStorage } from '../common/storage';
import { issueDeca } from '../api/deca-core';
import type { DecaData } from '../pdf/deca-pdf';
import { Actor, ApiError, actorStr } from '../identity/service';
import { UUID_RE, text } from './validate';

/**
 * Reemisión (método 2 del diseño, acción avanzada de administrador): PDF, token, URL y QR NUEVOS con los mismos datos del art. 6.
 * El DeCA anterior pasa a SUPERSEDED pero se conserva íntegro y su URL sigue sirviendo su PDF (el conductor puede llevar aún el QR antiguo).
 * Uso típico: el DeCA se emitió con una dirección que ya no vale (otro dominio, IP local de pruebas).
 */
async function reissueOne(c: PoolClient, storage: LocalStorage, actor: Actor, decaId: string, reason: string) {
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`deca:${decaId}`]);
  const d = (await c.query(
    `SELECT d.id, d.company_id, d.status, d.kind, d.current_version, d.public_url, dt.transport_id, v.snapshot
     FROM deca d JOIN deca_transport dt ON dt.deca_id = d.id JOIN deca_version v ON v.deca_id = d.id AND v.version_no = d.current_version
     WHERE d.id = $1`, [decaId])).rows[0];
  if (!d) throw new ApiError(404, 'no_encontrado');
  if (d.status !== 'ACTIVE' || d.kind !== 'OWN') throw new ApiError(409, 'deca_no_vigente');
  const issued = await issueDeca(c, storage, { companyId: d.company_id, transportId: d.transport_id, data: d.snapshot as DecaData, actor: actorStr(actor), reason, isTest: await testMode(c) });
  await c.query(`UPDATE deca SET status = 'SUPERSEDED' WHERE id = $1`, [d.id]);
  await appendAudit(c, { company_id: d.company_id, at: new Date(), actor: actorStr(actor), action: 'DECA_REISSUED', entity: 'deca', entity_id: d.id,
    before: { status: 'ACTIVE', url_host: new URL(d.public_url ?? 'http://desconocido').host }, after: { status: 'SUPERSEDED', replaced_by: issued.deca_id, new_url_host: new URL(issued.url).host }, reason });
  return { old_deca_id: d.id, deca_id: issued.deca_id, transport_id: d.transport_id, url: issued.url };
}

export async function reissueDeca(pool: Pool, storage: LocalStorage, actor: Actor, decaId: string, rawReason: unknown) {
  if (!UUID_RE.test(decaId)) throw new ApiError(404, 'no_encontrado');
  const reason = text(rawReason, 'reason', 3, 500);
  const c = await pool.connect();
  try { await c.query('BEGIN'); const r = await reissueOne(c, storage, actor, decaId, reason); await c.query('COMMIT'); return r; }
  catch (e) { try { await c.query('ROLLBACK'); } catch { /* */ } throw e; } finally { c.release(); }
}

/** Reemite TODOS los DeCA vigentes cuya URL no empieza por la dirección pública actual. Cada uno en su propia transacción. */
export async function reissueOutdated(pool: Pool, storage: LocalStorage, actor: Actor, rawReason: unknown) {
  const reason = text(rawReason, 'reason', 3, 500);
  const base = await getPublicBase(pool);
  const ids = (await pool.query(`SELECT id FROM deca WHERE status = 'ACTIVE' AND kind = 'OWN' AND public_url IS NOT NULL AND left(public_url, $2) <> $1 ORDER BY created_at`, [`${base}/d/`, base.length + 3])).rows.map((r) => r.id as string);
  let done = 0; const failed: string[] = [], ok: string[] = [];
  for (const id of ids) {
    const c = await pool.connect();
    try { await c.query('BEGIN'); await reissueOne(c, storage, actor, id, reason); await c.query('COMMIT'); done++; ok.push(id); }
    catch { try { await c.query('ROLLBACK'); } catch { /* */ } failed.push(id); } finally { c.release(); }
  }
  return { reissued: done, failed: failed.length, total: ids.length, reissued_ids: ok };   // reissued_ids: para avisar a los conductores
}
