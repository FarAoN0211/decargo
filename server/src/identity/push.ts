import type { Pool } from 'pg';
import webpush from 'web-push';
import { optional, required } from '../common/config';
import type { AuthContext } from './service';
import { ApiError } from './service';
import { fcmClient, sendFcm } from './fcm';
import { placeFrom } from '../office/address';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface BrowserPushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

function keys() {
  const publicKey = required('VAPID_PUBLIC_KEY');
  const privateKey = required('VAPID_PRIVATE_KEY');
  const subject = optional('VAPID_SUBJECT', required('PUBLIC_DOCS_BASE_URL'));
  webpush.setVapidDetails(subject, publicKey, privateKey);
  return { publicKey };
}

export function pushConfig(): { public_key: string } {
  return { public_key: keys().publicKey };
}

const B64URL = /^[A-Za-z0-9_-]+$/;
const PUSH_HOST = (host: string): boolean => host === 'fcm.googleapis.com' || host === 'updates.push.services.mozilla.com'
  || host === 'push.services.mozilla.com' || host.endsWith('.push.apple.com') || host.endsWith('.notify.windows.com');
export async function savePushSubscription(pool: Pool, auth: AuthContext, sub: BrowserPushSubscription): Promise<void> {
  let url: URL;
  try { url = new URL(sub.endpoint); } catch { throw new ApiError(400, 'invalid_push_subscription'); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !PUSH_HOST(url.hostname)
      || sub.endpoint.length > 2048 || !B64URL.test(sub.keys.p256dh) || !B64URL.test(sub.keys.auth)
      || sub.keys.p256dh.length > 256 || sub.keys.auth.length > 128) {
    throw new ApiError(400, 'invalid_push_subscription');
  }
  keys();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM push_subscription WHERE device_id = $1 OR endpoint = $2', [auth.deviceId, sub.endpoint]);
    await client.query(
      `INSERT INTO push_subscription (device_id, endpoint, p256dh, auth) VALUES ($1,$2,$3,$4)`,
      [auth.deviceId, sub.endpoint, sub.keys.p256dh, sub.keys.auth]);
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* */ }
    throw e;
  } finally { client.release(); }
}

const FCM_TOKEN = /^[A-Za-z0-9_:\-]{100,4096}$/;
/** La app Android registra el token FCM del teléfono (sustituye a cualquier suscripción anterior de ese dispositivo). */
export async function saveFcmToken(pool: Pool, auth: AuthContext, token: unknown): Promise<void> {
  if (typeof token !== 'string' || !FCM_TOKEN.test(token)) throw new ApiError(400, 'invalid_push_subscription');
  if (!(await fcmClient(pool))) throw new ApiError(409, 'fcm_no_configurado');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM push_subscription WHERE device_id = $1 OR endpoint = $2', [auth.deviceId, token]);
    await client.query(`INSERT INTO push_subscription (device_id, endpoint, kind) VALUES ($1,$2,'FCM')`, [auth.deviceId, token]);
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* */ }
    throw e;
  } finally { client.release(); }
}

/** Texto del aviso de un transporte asignado: «Granada → Madrid · 05/10/2026» (sin datos personales). */
async function transportSummary(pool: Pool, transportId: string): Promise<string> {
  const t = (await pool.query(`SELECT origin, destination, to_char(transport_date, 'DD/MM/YYYY') AS d FROM transport WHERE id = $1`, [transportId])).rows[0];
  if (!t) return 'Tienes un nuevo transporte asignado.';
  const places = (j: any): string => Array.from(new Set(((j?.stops ?? []) as any[]).map((x) => placeFrom(x)).filter(Boolean))).join(' / ');
  const o = places(t.origin), d = places(t.destination);
  return `${o && d ? `${o} → ${d} · ` : ''}${t.d}`;
}

/** Envío a una suscripción, sea del navegador (Web Push) o de la app Android (FCM). */
async function deliver(pool: Pool, s: { kind: string; endpoint: string; p256dh: string | null; auth: string | null }, payload: Record<string, string>, ttl: number, topic: string): Promise<void> {
  if (s.kind === 'FCM') return sendFcm(pool, s.endpoint, payload, ttl);
  keys();
  await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh ?? '', auth: s.auth ?? '' } }, JSON.stringify(payload), { TTL: ttl, urgency: 'high', topic, timeout: 5000 });
}

/**
 * Avisos al conductor sobre SU transporte, todos con la misma prioridad que la asignación (despiertan el teléfono):
 *  ASSIGNED nuevo transporte · UPDATED cambio en un transporte ya asignado (vehículo, DeCA…) · CANCELLED anulado · UNASSIGNED se lo han quitado.
 */
export type TransportEvent = 'ASSIGNED' | 'UPDATED' | 'CANCELLED' | 'UNASSIGNED';
const TITLES: Record<TransportEvent, string> = {
  ASSIGNED: 'Nuevo transporte asignado', UPDATED: 'Transporte modificado', CANCELLED: 'Transporte anulado', UNASSIGNED: 'Transporte retirado'
};

/** Conductor asignado ahora mismo a un transporte (o null). */
export async function currentDriverOf(pool: Pool, transportId: string): Promise<string | null> {
  if (!UUID_RE.test(transportId)) return null;
  return (await pool.query('SELECT driver_user_id FROM transport_driver_assignment WHERE transport_id = $1 AND valid_to IS NULL', [transportId])).rows[0]?.driver_user_id ?? null;
}

/** Matrículas vigentes del transporte («1234ABC / R5678BBB»). */
export async function vehiclesText(pool: Pool, transportId: string): Promise<string> {
  const r = (await pool.query(`SELECT tr.plate_display AS t, tl.plate_display AS l FROM transport_vehicle_assignment a JOIN vehicle tr ON tr.id = a.tractor_id LEFT JOIN vehicle tl ON tl.id = a.trailer_id
     WHERE a.transport_id = $1 AND a.valid_to IS NULL`, [transportId])).rows[0];
  return r ? `${r.t}${r.l ? ` / ${r.l}` : ''}` : '';
}

/** Avisa al conductor ACTUAL del transporte (si lo hay). Nunca lanza: un fallo del aviso no deshace el cambio. */
export async function notifyTransport(pool: Pool, transportId: string, ev: TransportEvent, what = ''): Promise<void> {
  try {
    const driver = await currentDriverOf(pool, transportId);
    if (driver) await sendTransportPush(pool, driver, transportId, ev, what);
  } catch { /* el conductor lo verá al abrir la aplicación */ }
}

export async function sendTransportAssignedPush(pool: Pool, userId: string, transportId: string): Promise<void> {
  return sendTransportPush(pool, userId, transportId, 'ASSIGNED');
}

export async function sendTransportPush(pool: Pool, userId: string, transportId: string, ev: TransportEvent, what = ''): Promise<void> {
  let vapidReady = true;
  try { keys(); } catch { vapidReady = false; }
  // Los dispositivos pendientes no reciben avisos de transportes (D-05).
  const rows = (await pool.query(
    `SELECT ps.id, ps.device_id, ps.endpoint, ps.p256dh, ps.auth, ps.kind
       FROM push_subscription ps
       JOIN device d ON d.id = ps.device_id
      WHERE d.user_id = $1 AND d.status = 'AUTORIZADO'`, [userId])).rows;
  const targets = rows.filter((s) => s.kind === 'FCM' || vapidReady);
  if (!targets.length) return;
  // Motivo del aviso: qué ha pasado y el trayecto («Granada → Madrid · 05/10/2026»), sin datos personales.
  const summary = await transportSummary(pool, transportId);
  const body = (what ? `${what}\n${summary}` : summary).slice(0, 300);
  const open = ev === 'ASSIGNED' || ev === 'UPDATED';
  const type = `TRANSPORT_${ev}`;
  const payload: Record<string, string> = { type, transport_id: transportId, title: TITLES[ev], body, url: open ? `/conductor?t=${transportId}` : '/conductor' };
  await Promise.all(targets.map(async (s) => {
    try {
      await deliver(pool, s, payload, 86400, `t-${transportId.replace(/-/g, '').slice(0, 28)}`);
      await pool.query('UPDATE push_subscription SET last_success = now(), last_error = NULL WHERE id = $1', [s.id]);
      await pool.query(`INSERT INTO push_event (user_id, device_id, transport_id, type, status) VALUES ($1,$2,$3,$4,'SENT')`,
        [userId, s.device_id, transportId, type]);
    } catch (e) {
      const status = Number((e as { statusCode?: number }).statusCode ?? 0);
      const expired = status === 404 || status === 410;
      const error = status ? `push_http_${status}` : 'push_delivery_failed';
      if (expired) await pool.query('DELETE FROM push_subscription WHERE id = $1', [s.id]);
      else await pool.query('UPDATE push_subscription SET last_error = $2 WHERE id = $1', [s.id, error]);
      await pool.query(`INSERT INTO push_event (user_id, device_id, transport_id, type, status, error) VALUES ($1,$2,$3,$4,$5,$6)`,
        [userId, s.device_id, transportId, type, expired ? 'EXPIRED' : 'FAILED', error]);
    }
  }));
}

/**
 * «Probar aviso» (lo lanza la OFICINA hacia un dispositivo del conductor). Crea un seguimiento (`push_test`) cuyo identificador viaja en el aviso:
 * el service worker del teléfono lo devuelve al recibirlo, al mostrarlo y al pulsarlo, y así la oficina ve hasta dónde llega.
 */
export async function sendPushTest(pool: Pool, actor: { userId?: string; role?: string }, deviceId: string): Promise<{ test_id: string }> {
  const d = (await pool.query(
    `SELECT d.id, d.status, u.role FROM device d JOIN app_user u ON u.id = d.user_id WHERE d.id = $1 AND ($2::text IS NULL OR u.role = $2)`,
    [UUID_RE.test(deviceId) ? deviceId : null, actor.role === 'oficina' ? 'conductor' : null])).rows[0];
  if (!d) throw new ApiError(404, 'no_encontrado');
  if (d.status !== 'AUTORIZADO') throw new ApiError(409, 'dispositivo_no_autorizado');
  const s = (await pool.query('SELECT id, endpoint, p256dh, auth, kind FROM push_subscription WHERE device_id = $1', [deviceId])).rows[0];
  if (!s) throw new ApiError(409, 'sin_suscripcion');
  if (s.kind !== 'FCM') keys();
  const t = (await pool.query('INSERT INTO push_test (device_id, requested_by) VALUES ($1,$2) RETURNING id', [deviceId, actor.userId])).rows[0];
  try {
    await deliver(pool, s, s.kind === 'FCM'
      ? { type: 'TEST', n: t.id, title: 'Aviso de prueba', body: 'La oficina ha enviado un aviso de prueba. Si lo ves con la pantalla apagada, los avisos funcionan en este teléfono.', url: '/conductor' }
      : { type: 'TEST', n: t.id }, 60, 'decargo-test');
    await pool.query('UPDATE push_test SET sent_at = now() WHERE id = $1', [t.id]);
    await pool.query('UPDATE push_subscription SET last_success = now(), last_error = NULL WHERE id = $1', [s.id]);
  } catch (e) {
    const status = Number((e as { statusCode?: number }).statusCode ?? 0);
    const err = status ? `push_http_${status}` : 'push_delivery_failed';
    await pool.query('UPDATE push_test SET send_error = $2 WHERE id = $1', [t.id, err]);
    if (status === 404 || status === 410) { await pool.query('DELETE FROM push_subscription WHERE id = $1', [s.id]); throw new ApiError(410, 'suscripcion_caducada'); }
    await pool.query('UPDATE push_subscription SET last_error = $2 WHERE id = $1', [s.id, err]);
    throw new ApiError(502, 'push_fallido', { http: status || null });
  }
  return { test_id: t.id };
}

export async function pushTestStatus(pool: Pool, actor: { role?: string }, testId: string) {
  if (!UUID_RE.test(testId)) throw new ApiError(404, 'no_encontrado');
  const r = (await pool.query(
    `SELECT t.created_at, t.sent_at, t.send_error, t.received_at, t.shown_at, t.clicked_at, t.device_info FROM push_test t JOIN device d ON d.id = t.device_id JOIN app_user u ON u.id = d.user_id
     WHERE t.id = $1 AND ($2::text IS NULL OR u.role = $2)`, [testId, actor.role === 'oficina' ? 'conductor' : null])).rows[0];
  if (!r) throw new ApiError(404, 'no_encontrado');
  return r;
}

/** Acuse del teléfono (sin sesión: lo envía el service worker). El identificador es un UUID aleatorio; la respuesta es siempre la misma. */
export async function pushTestAck(pool: Pool, testId: unknown, event: unknown, info?: unknown): Promise<void> {
  if (typeof testId !== 'string' || !UUID_RE.test(testId)) return;
  const col = event === 'received' ? 'received_at' : event === 'shown' ? 'shown_at' : event === 'clicked' ? 'clicked_at' : null;
  if (!col) return;
  await pool.query(`UPDATE push_test SET ${col} = now() WHERE id = $1 AND ${col} IS NULL AND created_at > now() - interval '10 minutes'`, [testId]);
  // Datos del teléfono (solo texto corto, acotado y sin ejecutar nada): se guardan la primera vez que llegan.
  if (info && typeof info === 'object' && !Array.isArray(info)) {
    const clean: Record<string, string | number> = {};
    for (const [k, v] of Object.entries(info as Record<string, unknown>).slice(0, 8)) {
      if (!/^[a-z_]{1,20}$/.test(k)) continue;
      if (typeof v === 'number' && Number.isFinite(v)) clean[k] = v;
      else if (typeof v === 'string') clean[k] = v.slice(0, 300);
    }
    if (Object.keys(clean).length) await pool.query(`UPDATE push_test SET device_info = COALESCE(device_info, $2::jsonb) WHERE id = $1 AND created_at > now() - interval '10 minutes'`, [testId, JSON.stringify(clean)]);
  }
}
