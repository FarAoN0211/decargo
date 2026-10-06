import { fullAddress } from '../office/address';
import type { Pool } from 'pg';
import QRCode from 'qrcode';
import { required } from '../common/config';
import { getPublicBase } from '../common/settings';
import { resolveStops } from '../office/parties';
import { LocalStorage } from '../common/storage';
import { decryptToken } from '../common/token';
import { appendAudit } from '../common/audit';
import { ApiError, type AuthContext } from './service';
import { driverExternalList } from '../external/service';

/**
 * Acceso de SOLO LECTURA del conductor a sus transportes y DeCA.
 * Un dispositivo pendiente (alcance LIMITADO) solo ve los transportes asignados ANTES de registrarse;
 * un dispositivo autorizado ve todas sus asignaciones vigentes. Cualquier recurso ajeno responde 404 (no se revela su existencia).
 */
const VISIBLE = `
  a.driver_user_id = $1 AND a.valid_to IS NULL
  AND t.status IN ('PENDIENTE','EN_CURSO')
  AND ($2::timestamptz IS NULL OR a.valid_from <= $2)`;
const cutoff = (a: AuthContext): Date | null => (a.scope === 'LIMITED' ? a.deviceRegisteredAt : null);

async function docsUrl(pool: Pool, tokenEnc: string): Promise<string> {
  return `${await getPublicBase(pool)}/d/${decryptToken(tokenEnc, required('APP_KEY'))}`;
}

const SELECT = `
  SELECT t.id, t.reference, t.status, t.transport_date::text AS transport_date, t.shipper_name, t.origin, t.destination, t.cargo_description, t.weight_kg, t.alt_magnitude,
         d.id AS deca_id, d.current_version, d.token_enc, d.public_url, d.created_at AS deca_created, v.sha256,
         vt.plate_display AS tractor, vt.kind AS tractor_kind, vr.plate_display AS trailer, vr.kind AS trailer_kind,
         (SELECT u.full_name FROM transport_relay r JOIN app_user u ON u.id = r.driver_user_id WHERE r.transport_id = t.id) AS relay_name
  FROM transport_driver_assignment a
  JOIN transport t ON t.id = a.transport_id
  LEFT JOIN deca_transport dt ON dt.transport_id = t.id AND EXISTS (SELECT 1 FROM deca x WHERE x.id = dt.deca_id AND x.status = 'ACTIVE')
  LEFT JOIN deca d ON d.id = dt.deca_id
  LEFT JOIN deca_version v ON v.deca_id = d.id AND v.version_no = d.current_version
  LEFT JOIN transport_vehicle_assignment va ON va.transport_id = t.id AND va.valid_to IS NULL
  LEFT JOIN vehicle vt ON vt.id = va.tractor_id LEFT JOIN vehicle vr ON vr.id = va.trailer_id`;

function shape(r: Record<string, any>) {
  return {
    id: r.id, reference: r.reference ?? null, status: r.status, transport_date: r.transport_date, shipper: r.shipper_name,
    origin: r.origin?.text ?? null, destination: r.destination?.text ?? null, cargo: r.cargo_description, weight_kg: r.weight_kg,
    alt_magnitude: r.alt_magnitude?.text ?? null,
    vehicles: r.tractor ? { tractor: r.tractor, trailer: r.trailer ?? null } : null,
    relay: r.relay_name ?? null,   // conductor que continúa cuando este termine su parte (relevo)
    // Al navegador del conductor no se le envía el hash ni la URL/token: el PDF y el QR se piden por sus endpoints autenticados.
    deca: r.deca_id ? { id: r.deca_id, version: r.current_version, created_at: r.deca_created } : null
  };
}

/** Puntos de carga/descarga con «Cómo llegar» e indicaciones tomados de la agenda (datos actuales). Solo lo que necesita el conductor. */
async function driverStops(pool: Pool, j: { text?: string; stops?: any[] } | null) {
  const stops = j?.stops ?? (j?.text ? [{ party: null, address: j.text }] : []);
  return (await resolveStops(pool, stops)).map((s) => ({ party: s.party, address: fullAddress(s), label: s.label, maps_url: s.maps_url, notes: s.site_notes, time: s.time ?? null, pallets: s.pallets ?? null, references: s.references ?? [], seals: s.seals ?? [] }));
}
const withStops = async (pool: Pool, r: Record<string, any>) => ({ ...shape(r), origins: await driverStops(pool, r.origin), destinations: await driverStops(pool, r.destination) });

export async function listDriverTransports(pool: Pool, a: AuthContext) {
  const r = await pool.query(`${SELECT} WHERE ${VISIBLE} ORDER BY t.transport_date, a.valid_from`, [a.userId, cutoff(a)]);
  return Promise.all(r.rows.map((x) => withStops(pool, x)));
}

export async function getDriverTransport(pool: Pool, a: AuthContext, transportId: string) {
  if (!/^[0-9a-f-]{36}$/.test(transportId)) return null;
  const r = await pool.query(`${SELECT} WHERE t.id = $3 AND ${VISIBLE}`, [a.userId, cutoff(a), transportId]);
  return r.rows[0] ? { ...(await withStops(pool, r.rows[0])), external_decas: await driverExternalList(pool, a, transportId) } : null;
}

/** Fichero y URL del DeCA vigente, solo si el DeCA pertenece a un transporte visible para este conductor. */
async function ownDeca(pool: Pool, a: AuthContext, decaId: string) {
  if (!/^[0-9a-f-]{36}$/.test(decaId)) return null;
  const r = await pool.query(`${SELECT.replace('SELECT t.id', 'SELECT v.file_key, t.id')} WHERE d.id = $3 AND ${VISIBLE}`, [a.userId, cutoff(a), decaId]);
  return r.rows[0] ?? null;
}

export async function driverDecaPdf(pool: Pool, storage: LocalStorage, a: AuthContext, decaId: string): Promise<Buffer | null> {
  const r = await ownDeca(pool, a, decaId);
  return r ? storage.getVerified(r.file_key, r.sha256) : null;
}

export async function driverDecaQrSvg(pool: Pool, a: AuthContext, decaId: string): Promise<string | null> {
  const r = await ownDeca(pool, a, decaId);
  return r ? QRCode.toString(r.public_url ?? await docsUrl(pool, r.token_enc), { type: 'svg', errorCorrectionLevel: 'M', margin: 4 }) : null;
}

/**
 * El conductor finaliza SU transporte desde un dispositivo AUTORIZADO (un dispositivo pendiente es de solo lectura, D-05).
 * Pasa a FINALIZADO, se anota la hora y, si hay DeCA, se fija el plazo mínimo de conservación (31 de diciembre del año siguiente).
 */
export async function finishDriverTransport(pool: Pool, a: AuthContext, transportId: string): Promise<{ finished_at: string }> {
  if (!/^[0-9a-f-]{36}$/.test(transportId)) throw new ApiError(404, 'no_encontrado');
  if (a.scope !== 'FULL') throw new ApiError(403, 'dispositivo_pendiente');
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`transport:${transportId}`]);
    const t = (await c.query(
      `SELECT t.id, t.company_id, t.status FROM transport t JOIN transport_driver_assignment x ON x.transport_id = t.id AND x.valid_to IS NULL AND x.driver_user_id = $2 WHERE t.id = $1`, [transportId, a.userId])).rows[0];
    if (!t) throw new ApiError(404, 'no_encontrado');                                   // ajeno o inexistente: no se revela
    if (t.status !== 'PENDIENTE' && t.status !== 'EN_CURSO') throw new ApiError(409, 'transporte_cerrado');
    const r = (await c.query(`UPDATE transport SET status = 'FINALIZADO', started_at = COALESCE(started_at, now()), finished_at = now() WHERE id = $1 RETURNING finished_at`, [transportId])).rows[0];
    await c.query('DELETE FROM transport_relay WHERE transport_id = $1', [transportId]);
    await c.query(
      `UPDATE deca SET retain_not_before = make_date(extract(year FROM now() AT TIME ZONE 'Europe/Madrid')::int + 1, 12, 31)
       WHERE id IN (SELECT dt.deca_id FROM deca_transport dt WHERE dt.transport_id = $1) AND retain_not_before IS NULL`, [transportId]);
    await appendAudit(c, { company_id: t.company_id, at: new Date(), actor: `user:${a.userId}`, action: 'TRANSPORT_FINISHED', entity: 'transport', entity_id: transportId, before: { status: t.status }, after: { status: 'FINALIZADO', by: 'conductor' }, reason: null });
    await c.query('COMMIT');
    return { finished_at: new Date(r.finished_at).toISOString() };
  } catch (e) { try { await c.query('ROLLBACK'); } catch { /* */ } throw e; } finally { c.release(); }
}

/**
 * «He terminado mi parte»: el conductor deja el transporte (le desaparece de la app) sin finalizarlo. Si la oficina programó un RELEVO,
 * el transporte pasa a ese conductor (sigue EN CURSO); si no, queda PENDIENTE (sin conductor) para que la oficina asigne otro.
 * Devuelve el conductor que continúa (o null).
 */
export async function finishDriverPart(pool: Pool, a: AuthContext, transportId: string): Promise<{ next_driver: string | null }> {
  if (!/^[0-9a-f-]{36}$/.test(transportId)) throw new ApiError(404, 'no_encontrado');
  if (a.scope !== 'FULL') throw new ApiError(403, 'dispositivo_pendiente');
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`transport:${transportId}`]);
    const t = (await c.query(
      `SELECT t.id, t.company_id, t.status FROM transport t JOIN transport_driver_assignment x ON x.transport_id = t.id AND x.valid_to IS NULL AND x.driver_user_id = $2 WHERE t.id = $1`, [transportId, a.userId])).rows[0];
    if (!t) throw new ApiError(404, 'no_encontrado');
    if (t.status !== 'PENDIENTE' && t.status !== 'EN_CURSO') throw new ApiError(409, 'transporte_cerrado');
    await c.query('UPDATE transport_driver_assignment SET valid_to = now() WHERE transport_id = $1 AND valid_to IS NULL', [transportId]);
    const relay = (await c.query(`SELECT r.driver_user_id FROM transport_relay r JOIN app_user u ON u.id = r.driver_user_id AND u.active AND u.role = 'conductor' WHERE r.transport_id = $1`, [transportId])).rows[0];
    await c.query('DELETE FROM transport_relay WHERE transport_id = $1', [transportId]);
    const next: string | null = relay?.driver_user_id ?? null;
    if (next) await c.query('INSERT INTO transport_driver_assignment (transport_id, driver_user_id, created_by) VALUES ($1,$2,$3)', [transportId, next, `user:${a.userId}`]);
    await c.query(`UPDATE transport SET status = $2, started_at = COALESCE(started_at, now()) WHERE id = $1`, [transportId, next ? 'EN_CURSO' : 'PENDIENTE']);
    await appendAudit(c, { company_id: t.company_id, at: new Date(), actor: `user:${a.userId}`, action: 'TRANSPORT_LEG_FINISHED', entity: 'transport', entity_id: transportId,
      before: { driver: a.userId }, after: { next_driver: next ?? 'sin conductor', status: next ? 'EN_CURSO' : 'PENDIENTE' }, reason: null });
    await c.query('COMMIT');
    return { next_driver: next };
  } catch (e) { try { await c.query('ROLLBACK'); } catch { /* */ } throw e; } finally { c.release(); }
}

/**
 * Tarjetas de combustible (y VIA-T) de los vehículos de SU transporte, con el PIN: solo el conductor asignado, con dispositivo AUTORIZADO,
 * y cada consulta queda auditada (como cuando la oficina ve el PIN). Nunca va en la lista de transportes ni en la copia sin conexión.
 */
export async function driverFuelCards(pool: Pool, a: AuthContext, transportId: string) {
  if (!/^[0-9a-f-]{36}$/.test(transportId)) throw new ApiError(404, 'no_encontrado');
  if (a.scope !== 'FULL') throw new ApiError(403, 'dispositivo_pendiente');
  const t = (await pool.query(`SELECT t.id, t.company_id FROM transport_driver_assignment a JOIN transport t ON t.id = a.transport_id WHERE t.id = $3 AND ${VISIBLE}`, [a.userId, null, transportId])).rows[0];
  if (!t) throw new ApiError(404, 'no_encontrado');
  const rows = (await pool.query(
    `SELECT s.id, s.kind, s.provider, s.identifier, s.pin_enc, s.expires_on::text AS expires_on, v.plate_display AS plate
       FROM transport_vehicle_assignment va JOIN vehicle_asset s ON s.vehicle_id IN (va.tractor_id, va.trailer_id) AND s.active
       JOIN vehicle v ON v.id = s.vehicle_id
      WHERE va.transport_id = $1 AND va.valid_to IS NULL AND s.kind IN ('FUEL_CARD', 'VIA_T')
      ORDER BY s.kind, v.plate_display`, [transportId])).rows;
  const key = required('APP_KEY');
  const out = rows.map((r) => ({ id: r.id, kind: r.kind, provider: r.provider, identifier: r.identifier, plate: r.plate, expires_on: r.expires_on,
    pin: r.pin_enc ? decryptToken(r.pin_enc, key) : null }));
  const withPin = out.filter((x) => x.pin);
  if (withPin.length) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await appendAudit(c, { company_id: t.company_id, at: new Date(), actor: `user:${a.userId}`, action: 'VEHICLE_ASSET_PIN_REVEALED', entity: 'transport', entity_id: transportId,
        before: null, after: { by: 'conductor', cards: withPin.map((x) => x.id).join(',') }, reason: null });
      await c.query('COMMIT');
    } catch (e) { try { await c.query('ROLLBACK'); } catch { /* */ } throw e; } finally { c.release(); }
  }
  return out;
}
