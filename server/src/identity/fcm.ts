import { createSign } from 'node:crypto';
import { decryptToken, encryptToken } from '../common/token';
import { ApiError } from './service';

/**
 * Avisos a la app Android de DECARGO mediante Firebase Cloud Messaging (API HTTP v1).
 * Las credenciales las sube el administrador desde Configuración y se guardan en la base de datos (viajan con las copias):
 *   - `fcm_client`: datos públicos de la app (google-services.json) que el teléfono necesita para registrarse.
 *   - `fcm_service`: cuenta de servicio de Firebase (clave privada) CIFRADA con APP_KEY; solo el servidor la usa para enviar.
 * El aviso es un mensaje de DATOS de prioridad alta: despierta el teléfono y lo pinta la propia app (pantalla completa).
 */
export const FCM_PACKAGE = 'es.decargo.app';
export const FCM_CLIENT_KEY = 'fcm_client';
export const FCM_SERVICE_KEY = 'fcm_service';

interface Queryable { query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, any>> }> }
export interface FcmClient { project_id: string; project_number: string; app_id: string; api_key: string; package: string }
interface ServiceAccount { project_id: string; client_email: string; private_key: string; token_uri: string }

const appKey = (): string => process.env.APP_KEY ?? '';
const str = (v: unknown, max: number): string => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : '');

/** Del google-services.json solo se toma el cliente de la app DECARGO (paquete es.decargo.app). */
export function parseGoogleServices(text: unknown): FcmClient {
  let j: any;
  try { j = JSON.parse(String(text ?? '')); } catch { throw new ApiError(400, 'fcm_google_services'); }
  const info = j?.project_info ?? {};
  const client = (Array.isArray(j?.client) ? j.client : []).find((c: any) => c?.client_info?.android_client_info?.package_name === FCM_PACKAGE);
  const out: FcmClient = {
    project_id: str(info.project_id, 100), project_number: str(info.project_number, 30), package: FCM_PACKAGE,
    app_id: str(client?.client_info?.mobilesdk_app_id, 200), api_key: str(client?.api_key?.[0]?.current_key, 200)
  };
  if (!client) throw new ApiError(400, 'fcm_paquete', { package: FCM_PACKAGE });
  if (!out.project_id || !/^\d+$/.test(out.project_number) || !out.app_id || !out.api_key) throw new ApiError(400, 'fcm_google_services');
  return out;
}

export function parseServiceAccount(text: unknown): ServiceAccount {
  let j: any;
  try { j = JSON.parse(String(text ?? '')); } catch { throw new ApiError(400, 'fcm_cuenta_servicio'); }
  const sa = { project_id: str(j?.project_id, 100), client_email: str(j?.client_email, 300), private_key: str(j?.private_key, 8000), token_uri: str(j?.token_uri, 200) || 'https://oauth2.googleapis.com/token' };
  if (j?.type !== 'service_account' || !sa.project_id || !/@/.test(sa.client_email) || !/BEGIN PRIVATE KEY/.test(sa.private_key)) throw new ApiError(400, 'fcm_cuenta_servicio');
  if (new URL(sa.token_uri).hostname !== 'oauth2.googleapis.com') throw new ApiError(400, 'fcm_cuenta_servicio');
  return sa;
}

export async function fcmClient(q: Queryable): Promise<FcmClient | null> {
  const v = (await q.query('SELECT value FROM app_setting WHERE key = $1', [FCM_CLIENT_KEY])).rows[0]?.value as string | undefined;
  if (!v) return null;
  try { return JSON.parse(v) as FcmClient; } catch { return null; }
}

async function serviceAccount(q: Queryable): Promise<ServiceAccount | null> {
  const v = (await q.query('SELECT value FROM app_setting WHERE key = $1', [FCM_SERVICE_KEY])).rows[0]?.value as string | undefined;
  if (!v) return null;
  try { return JSON.parse(decryptToken(v, appKey())) as ServiceAccount; } catch { return null; }
}

export const encryptServiceAccount = (sa: ServiceAccount): string => encryptToken(JSON.stringify(sa), appKey());

// Token de acceso OAuth2 (1 hora); se reutiliza mientras le queden más de 5 minutos.
let cached: { email: string; token: string; exp: number } | null = null;
export async function accessToken(sa: ServiceAccount): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.email === sa.client_email && cached.exp - 300 > now) return cached.token;
  const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = b64({ alg: 'RS256', typ: 'JWT' });
  const body = b64({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: sa.token_uri, iat: now, exp: now + 3600 });
  let sig: string;
  try { sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(sa.private_key).toString('base64url'); } catch { throw new ApiError(400, 'fcm_cuenta_servicio'); }
  const r = await fetch(sa.token_uri, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(8000),
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${body}.${sig}` }) });
  const j = await r.json().catch(() => ({})) as { access_token?: string; expires_in?: number };
  if (!r.ok || !j.access_token) throw Object.assign(new Error('fcm_oauth'), { statusCode: 0, oauth: r.status });
  cached = { email: sa.client_email, token: j.access_token, exp: now + (j.expires_in ?? 3600) };
  return j.access_token;
}

/** ¿Está configurado el envío? (las dos piezas presentes y legibles con la APP_KEY actual) */
export async function fcmReady(q: Queryable): Promise<boolean> {
  return !!(await fcmClient(q)) && !!(await serviceAccount(q));
}

/**
 * Envía un aviso de DATOS (prioridad alta) a un teléfono. Lanza un error con `statusCode` como web-push:
 * 404 = el token ya no existe (app desinstalada o datos borrados) → la suscripción se elimina.
 */
export async function sendFcm(q: Queryable, token: string, data: Record<string, string>, ttlSeconds: number): Promise<void> {
  const sa = await serviceAccount(q);
  if (!sa) throw Object.assign(new Error('fcm_no_configurado'), { statusCode: 0 });
  const at = await accessToken(sa);
  const r = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(sa.project_id)}/messages:send`, {
    method: 'POST', headers: { authorization: `Bearer ${at}`, 'content-type': 'application/json' }, signal: AbortSignal.timeout(8000),
    body: JSON.stringify({ message: { token, data, android: { priority: 'HIGH', ttl: `${ttlSeconds}s` } } })
  });
  if (r.ok) return;
  const j = await r.json().catch(() => ({})) as { error?: { status?: string; details?: Array<{ errorCode?: string }> } };
  const code = j.error?.details?.find((d) => d.errorCode)?.errorCode ?? j.error?.status ?? '';
  // Token caducado o que no es de esta app: se trata como 404 (suscripción muerta).
  const gone = r.status === 404 || code === 'UNREGISTERED' || (r.status === 400 && code === 'INVALID_ARGUMENT') || code === 'SENDER_ID_MISMATCH';
  if (r.status === 401) cached = null;
  throw Object.assign(new Error(`fcm_${code || r.status}`), { statusCode: gone ? 404 : r.status });
}
