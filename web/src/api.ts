import { reactive } from 'vue';
import { clearOffline, offlineUser } from './offline';
import { DEMO } from './base';

export type Role = 'admin' | 'oficina' | 'conductor' | 'solo_lectura';
export interface Me { id: string; username: string; full_name: string; role: Role }

/** Estado de sesión. El access token vive SOLO en memoria. El refresh token se guarda según el rol:
 *  - CONDUCTOR: en localStorage, para que no se cierre la sesión al salir de la aplicación o cerrar el teléfono (caduca en el servidor: 30 días sin uso);
 *  - oficina / admin / solo lectura: en sessionStorage (se pierde al cerrar la pestaña; ordenadores compartidos).
 *  La credencial del dispositivo (id + secreto) en localStorage, porque identifica a este navegador (D-05). */
// cached: sin cobertura al abrir, el conductor entra con su copia sin conexión (solo lectura) hasta que vuelva la red.
export const auth = reactive({ ready: false, offline: false, cached: false, user: null as Me | null, scope: '', mfaRequired: false, deviceStatus: '' });

export class NetworkError extends Error { constructor() { super('network'); } }

export class ApiError extends Error {
  constructor(public status: number, public code: string, public data: Record<string, any> = {}) { super(code); }
}

const RK = 'decargo.refresh';
let access: string | null = null;
let refreshing: Promise<boolean> | null = null;
let onLost: () => void = () => {};
export const setOnSessionLost = (f: () => void): void => { onLost = f; };

const devKey = (u: string): string => `decargo.device.${u.trim().toLowerCase()}`;
function readDevice(u: string): { id: string; secret: string } | null {
  try { const v = localStorage.getItem(devKey(u)); return v ? JSON.parse(v) : null; } catch { return null; }
}
function saveDevice(u: string, d: { id: string; secret: string }): void {
  try { localStorage.setItem(devKey(u), JSON.stringify(d)); } catch { /* sin almacenamiento: el dispositivo se verá como nuevo */ }
}

/** Dónde está guardado el refresh token ahora (si lo hay): el de conductor en localStorage, el de oficina en sessionStorage. */
function readRefresh(): { rt: string; store: Storage } | null {
  for (const get of [(): Storage => localStorage, (): Storage => sessionStorage]) {
    try { const st = get(); const rt = st.getItem(RK); if (rt) return { rt, store: st }; } catch { /* almacenamiento no disponible */ }
  }
  return null;
}
const storeFor = (role: Role | undefined): Storage | null => { try { return role === 'conductor' ? localStorage : sessionStorage; } catch { return null; } };

function clearSession(): void {
  if (DEMO) { auth.user = null; auth.scope = ''; return; }   // la demo no toca el almacenamiento del navegador (es el mismo dominio que la aplicación real)
  access = null;
  try { sessionStorage.removeItem(RK); } catch { /* */ }
  try { localStorage.removeItem(RK); } catch { /* */ }
  auth.user = null; auth.scope = ''; auth.mfaRequired = false; auth.deviceStatus = ''; auth.cached = false;
  void clearOffline();   // la copia sin conexión del conductor nunca sobrevive a su sesión
}

function applyTokens(r: { access_token: string; refresh_token: string }, store: Storage | null): void {
  access = r.access_token;
  try { store?.setItem(RK, r.refresh_token); } catch { /* */ }
  // Nunca queda el token en los dos sitios: si cambia el almacén (p. ej. otro usuario en este navegador), se borra el otro.
  try { if (store === localStorage) sessionStorage.removeItem(RK); else if (store === sessionStorage) localStorage.removeItem(RK); } catch { /* */ }
}

export const homeFor = (role: Role | undefined): string => (role === 'conductor' ? '/conductor' : '/oficina');

async function postJson(path: string, body: unknown): Promise<{ res: Response; data: any }> {
  const res = await fetch(`/api/v1${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

function finishLogin(username: string, j: any): void {
  applyTokens(j, storeFor(j.user?.role));
  if (j.device?.secret) saveDevice(username, { id: j.device.id, secret: j.device.secret });
  auth.user = j.user; auth.scope = j.scope; auth.mfaRequired = j.mfa_required === true; auth.deviceStatus = j.device?.status ?? '';
}

export async function login(username: string, password: string, totp?: string): Promise<void> {
  const dev = readDevice(username);
  const { res, data } = await postJson('/auth/login', { username, password, device_label: 'Navegador web', ...(totp ? { totp_code: totp } : {}), ...(dev ? { device: dev } : {}) });
  if (!res.ok) throw new ApiError(res.status, data.error ?? 'error', data);
  finishLogin(username, data);
}

export async function activate(username: string, code: string, password: string, totp?: string): Promise<void> {
  const device_label = 'DecargoAndroid' in window ? 'App Android' : 'Navegador web';
  const { res, data } = await postJson('/auth/activate', { username, code, password, device_label, ...(totp ? { totp_code: totp } : {}) });
  if (!res.ok) throw new ApiError(res.status, data.error ?? 'error', data);
  finishLogin(username, data);
}

/** Renueva la sesión. Si hay varias pestañas o ventanas (p. ej. al pulsar un aviso), solo una renueva a la vez y todas leen el token MÁS RECIENTE
 *  (cada renovación rota el token: dos renovaciones simultáneas con el mismo token serían tomadas por un robo). */
async function doRefresh(): Promise<boolean> {
  const run = async (): Promise<boolean> => {
    const cur = readRefresh();
    if (!cur) return false;
    let r: { res: Response; data: any };
    try { r = await postJson('/auth/refresh', { refresh_token: cur.rt }); }
    catch { throw new NetworkError(); }                    // sin red: la sesión NO se cierra, el token se conserva
    if (r.res.status >= 500 || r.res.status === 429) throw new NetworkError();
    if (!r.res.ok) { clearSession(); return false; }       // el servidor la rechaza de verdad (caducada, revocada…)
    applyTokens(r.data, cur.store); auth.scope = r.data.scope; auth.offline = false; auth.cached = false;
    return true;
  };
  const locks = (navigator as Navigator & { locks?: { request: <T>(n: string, f: () => Promise<T>) => Promise<T> } }).locks;
  return locks ? locks.request('decargo-refresh', run) : run();
}
const refreshSession = (): Promise<boolean> => (refreshing ??= doRefresh().finally(() => { refreshing = null; }));

async function authed(path: string, init: RequestInit = {}, retry = true): Promise<Response> {
  if (DEMO) {   // demostración: servidor simulado en memoria; nada sale del navegador
    const res = await (await import('./demo/server')).demoFetch(path, init);
    if (res.status === 401) { clearSession(); onLost(); }
    return res;
  }
  const headers = new Headers(init.headers);
  if (access) headers.set('authorization', `Bearer ${access}`);
  const res = await fetch(`/api/v1${path}`, { ...init, headers });
  if (res.status === 401 && retry && (await refreshSession())) return authed(path, init, false);
  if (res.status === 401) { clearSession(); onLost(); }
  return res;
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await authed(path, {
    method: opts.method ?? 'GET',
    headers: opts.body !== undefined ? { 'content-type': 'application/json' } : {},
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? 'error', data);
  return data as T;
}

/** Descarga un fichero protegido (PDF, SVG) con la sesión y lo devuelve como Blob. */
export async function apiBlob(path: string): Promise<Blob> {
  const res = await authed(path);
  if (!res.ok) { const d = await res.json().catch(() => ({})); throw new ApiError(res.status, d.error ?? 'error', d); }
  return res.blob();
}

export async function loadMe(): Promise<void> {
  const m = await api<any>('/me');
  auth.user = { id: m.id, username: m.username, full_name: m.full_name, role: m.role };
  auth.scope = m.scope; auth.mfaRequired = m.mfa_required === true; auth.deviceStatus = m.device?.status ?? '';
}

/** Recupera la sesión al abrir la aplicación (si queda un refresh token guardado: el del conductor persiste, el de oficina solo en esa pestaña). */
export async function restoreSession(): Promise<void> {
  if (DEMO) { auth.ready = true; return; }
  if (!auth.ready) {
    try { if (!auth.user && (await refreshSession())) await loadMe(); }
    catch (e) {
      if (e instanceof NetworkError || e instanceof TypeError) {
        auth.offline = !!readRefresh();   // sin red: se conserva la sesión y se reintenta
        // El conductor con copia sin conexión entra a verla (DeCA y QR); el resto ve «Sin conexión».
        const u = auth.offline ? await offlineUser() : null;
        if (u) { auth.user = u; auth.cached = true; }
      }
      else clearSession();
    }
    auth.ready = true;
  }
}

export async function logout(): Promise<void> {
  if (DEMO) { (await import('./demo/server')).demoLogout(); clearSession(); return; }
  try { if (access) await authed('/auth/logout', { method: 'POST' }, false); } catch { /* sin red: se cierra igualmente en local */ }
  clearSession();
}

/** Reintenta recuperar la sesión tras una pérdida de red. Devuelve true si ya hay sesión. */
export async function retryRestore(): Promise<boolean> {
  auth.ready = false; auth.offline = false;
  await restoreSession();
  return !!auth.user;
}

/** Olvida la sesión guardada en este dispositivo (para entrar con otra cuenta). */
export function forgetSession(): void { clearSession(); auth.offline = false; }
