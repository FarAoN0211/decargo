import { timingSafeEqual } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { appendAudit } from '../common/audit';
import { checkPassword, dummyHash, hashSecret, verifySecret } from '../common/password';
import { DeviceStatus, POLICY, Role, ROLES, sessionPolicy } from './policy';
import QRCode from 'qrcode';
import { decryptTotpSecret, encryptTotpSecret, newTotpSecret, otpauthUri, verifyTotp } from './totp';
import { newActivationCode, normalizeCode, randomToken, sha256hex, signAccess } from './tokens';

export class ApiError extends Error {
  constructor(public status: number, public code: string, public extra: Record<string, unknown> = {}) { super(code); }
}

export interface AuthContext {
  userId: string; username: string; fullName: string; role: Role; companyId: string;
  sessionId: string; deviceId: string; deviceStatus: DeviceStatus; deviceRegisteredAt: Date;
  scope: Scope;
}
export type Scope = 'FULL' | 'LIMITED' | 'MFA_PENDING';
/** Los roles de oficina (admin, oficina, solo_lectura) exigen segundo factor TOTP; el conductor no (D-05). */
export const needsMfa = (role: Role): boolean => role !== 'conductor';
/** Alcance de una sesión, calculado siempre desde el estado actual en la base de datos. */
export function scopeOf(role: Role, status: DeviceStatus, mfaAt: Date | string | null): Scope {
  if (needsMfa(role)) return mfaAt ? 'FULL' : 'MFA_PENDING';
  return status === 'AUTORIZADO' ? 'FULL' : 'LIMITED';
}
export interface Actor { kind: 'cli' | 'user'; userId?: string; role?: Role }
export const actorStr = (a: Actor): string => (a.kind === 'cli' ? 'cli' : `user:${a.userId}`);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const USERNAME_RE = /^[a-z0-9._-]{3,40}$/;
export const normUser = (u: string): string => u.trim().toLowerCase().slice(0, 64);

// ---------------------------------------------------------------- fuerza bruta
type Rule = [number, number][];   // [fallos, segundos de bloqueo]
const RULES: Record<'pair' | 'user' | 'ip', Rule> = {
  pair: [[5, 60], [8, 300], [10, 900]],        // mismo usuario desde la misma IP
  user: [[20, 60], [40, 300], [60, 900]],      // mismo usuario desde cualquier IP (umbral alto: no permite bloquear a un conductor con facilidad)
  ip:   [[30, 60], [60, 300], [100, 900]]
};
const keysFor = (user: string, ip: string): { key: string; rule: Rule }[] => [
  { key: `p:${user}|${ip}`, rule: RULES.pair }, { key: `u:${user}`, rule: RULES.user }, { key: `ip:${ip}`, rule: RULES.ip }
];

async function lockedSeconds(pool: Pool, keys: string[]): Promise<number> {
  const r = await pool.query(
    `SELECT COALESCE(max(EXTRACT(EPOCH FROM locked_until - now())), 0) AS s FROM login_throttle WHERE key = ANY($1) AND locked_until > now()`, [keys]);
  return Number(r.rows[0].s);
}
async function registerFailure(pool: Pool, entries: { key: string; rule: Rule }[]): Promise<void> {
  for (const { key, rule } of entries) {
    const r = await pool.query(
      `INSERT INTO login_throttle (key, fails, updated_at) VALUES ($1, 1, now())
       ON CONFLICT (key) DO UPDATE SET
         fails = CASE WHEN login_throttle.updated_at < now() - interval '15 minutes' THEN 1 ELSE login_throttle.fails + 1 END,
         updated_at = now()
       RETURNING fails`, [key]);
    const fails: number = r.rows[0].fails;
    const lock = [...rule].reverse().find(([n]) => fails >= n);
    if (lock) await pool.query(`UPDATE login_throttle SET locked_until = now() + make_interval(secs => $2) WHERE key = $1`, [key, lock[1]]);
  }
}
async function resetThrottle(pool: Pool, keys: string[]): Promise<void> {
  await pool.query(`UPDATE login_throttle SET fails = 0, locked_until = NULL, updated_at = now() WHERE key = ANY($1)`, [keys]);
}
async function ensureNotLocked(pool: Pool, keys: string[]): Promise<void> {
  const s = await lockedSeconds(pool, keys);
  if (s > 0) throw new ApiError(429, 'too_many_attempts', { retry_after_seconds: Math.ceil(s) });
}

// ---------------------------------------------------------------- sesiones
export interface Tokens {
  access_token: string; access_expires_in: number;
  refresh_token: string; refresh_expires_at: string; session_expires_at: string;
}

async function newRefresh(client: PoolClient, sessionId: string, expires: Date): Promise<string> {
  const token = randomToken(32);
  await client.query('INSERT INTO refresh_token (session_id, token_hash, expires_at) VALUES ($1,$2,$3)', [sessionId, sha256hex(token), expires]);
  return token;
}

async function openSession(client: PoolClient, userId: string, role: Role, deviceId: string, status: DeviceStatus, mfaOk = false): Promise<Tokens> {
  const pol = sessionPolicy(role, status);
  const now = Date.now();
  const sessionExpires = new Date(now + pol.absoluteMs);
  const refreshExpires = new Date(Math.min(now + pol.refreshMs, sessionExpires.getTime()));
  const s = await client.query('INSERT INTO session (user_id, device_id, expires_at, mfa_at) VALUES ($1,$2,$3,$4) RETURNING id', [userId, deviceId, sessionExpires, mfaOk ? new Date() : null]);
  const refresh = await newRefresh(client, s.rows[0].id, refreshExpires);
  return {
    access_token: signAccess(s.rows[0].id, POLICY.accessTtlSeconds), access_expires_in: POLICY.accessTtlSeconds,
    refresh_token: refresh, refresh_expires_at: refreshExpires.toISOString(), session_expires_at: sessionExpires.toISOString()
  };
}

async function revokeUserSessions(client: PoolClient, userId: string, reason: string): Promise<void> {
  await client.query(`UPDATE session SET revoked_at = now(), revoked_reason = $2 WHERE user_id = $1 AND revoked_at IS NULL`, [userId, reason]);
}

// ---------------------------------------------------------------- dispositivo + login
interface UserRow { id: string; company_id: string; username: string; full_name: string; role: Role }

async function resolveDevice(client: PoolClient, user: UserRow, cred: { id: string; secret: string } | undefined) {
  if (!cred || !UUID_RE.test(cred.id)) return null;
  const r = await client.query('SELECT id, status, registered_at, secret_hash FROM device WHERE id = $1 AND user_id = $2', [cred.id, user.id]);
  const d = r.rows[0];
  if (!d) return null;
  const a = Buffer.from(sha256hex(cred.secret)); const b = Buffer.from(d.secret_hash.trim());
  return a.length === b.length && timingSafeEqual(a, b) ? d : null;
}

async function establishSession(pool: Pool, user: UserRow, cred: { id: string; secret: string } | undefined, label: string | undefined, mfaOk = false) {
  const client = await pool.connect();
  let limitReached = false;
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM app_user WHERE id = $1 FOR UPDATE', [user.id]);   // serializa las altas de dispositivo del usuario
    let device = await resolveDevice(client, user, cred);
    if (device?.status === 'REVOCADO') { await client.query('ROLLBACK'); throw new ApiError(403, 'device_revoked'); }
    let secret: string | undefined;
    if (!device) {
      // Conductor con dispositivo desconocido → PENDIENTE (D-05). Resto de roles: autorizado (TOTP pendiente de implementar).
      const status: DeviceStatus = user.role === 'conductor' ? 'PENDIENTE_DE_CONFIRMACION' : 'AUTORIZADO';
      if (status === 'PENDIENTE_DE_CONFIRMACION') {
        const n = await client.query(`SELECT count(*)::int AS n FROM device WHERE user_id = $1 AND status = 'PENDIENTE_DE_CONFIRMACION'`, [user.id]);
        if (n.rows[0].n >= POLICY.maxPendingDevices) {
          await appendAudit(client, { company_id: user.company_id, at: new Date(), actor: `user:${user.id}`, action: 'DEVICE_LIMIT_REACHED',
            entity: 'user', entity_id: user.id, before: null, after: { pending: String(n.rows[0].n) }, reason: null });
          limitReached = true;
        }
      }
      if (!limitReached) {
        secret = randomToken(32);
        const ins = await client.query(
          `INSERT INTO device (company_id, user_id, secret_hash, label, status, last_seen) VALUES ($1,$2,$3,$4,$5, now())
           RETURNING id, status, registered_at`, [user.company_id, user.id, sha256hex(secret), label?.slice(0, 60) ?? null, status]);
        device = ins.rows[0];
        await appendAudit(client, { company_id: user.company_id, at: new Date(), actor: `user:${user.id}`,
          action: status === 'AUTORIZADO' ? 'DEVICE_REGISTERED_AUTHORIZED' : 'DEVICE_REGISTERED_PENDING',
          entity: 'device', entity_id: device.id, before: null, after: { status }, reason: null });
      }
    }
    if (limitReached) { await client.query('COMMIT'); throw new ApiError(409, 'pending_device_limit', { max: POLICY.maxPendingDevices }); }
    const tokens = await openSession(client, user.id, user.role, device.id, device.status, mfaOk);
    await client.query('UPDATE device SET last_seen = now() WHERE id = $1', [device.id]);
    await client.query('COMMIT');
    return {
      ...tokens,
      scope: scopeOf(user.role, device.status, mfaOk ? new Date() : null),
      mfa_required: needsMfa(user.role) && !mfaOk,
      device: { id: device.id, status: device.status as DeviceStatus, ...(secret ? { secret } : {}) },
      user: { id: user.id, username: user.username, full_name: user.full_name, role: user.role }
    };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* ya cerrada */ }
    throw e;
  } finally { client.release(); }
}

/** Segundo factor: exige y consume un código TOTP. Un código solo vale una vez (anti-repetición). Fallos → misma protección anti fuerza bruta. */
async function consumeTotp(pool: Pool, row: { id: string; totp_secret_enc: string | null; totp_last_step: string | number | null }, code: string | undefined,
  entries: { key: string; rule: Rule }[]): Promise<true> {
  if (!code) throw new ApiError(401, 'totp_required');
  const secret = decryptTotpSecret(row.totp_secret_enc ?? '');
  const step = verifyTotp(secret, code, row.totp_last_step === null || row.totp_last_step === undefined ? null : Number(row.totp_last_step));
  const claimed = step === null ? null : await pool.query(
    'UPDATE app_user SET totp_last_step = $2 WHERE id = $1 AND (totp_last_step IS NULL OR totp_last_step < $2) RETURNING id', [row.id, step]);
  if (!claimed?.rowCount) { await registerFailure(pool, entries); throw new ApiError(401, 'invalid_totp'); }
  return true;
}

export async function login(pool: Pool, input: { username: string; password: string; totpCode?: string; device?: { id: string; secret: string }; deviceLabel?: string }, ip: string) {
  const user = normUser(input.username);
  const entries = keysFor(user, ip);
  await ensureNotLocked(pool, entries.map((e) => e.key));
  const row = (await pool.query(
    'SELECT id, company_id, username, full_name, role, active, password_hash, totp_secret_enc, totp_enabled_at, totp_last_step FROM app_user WHERE lower(username) = $1', [user])).rows[0];
  // Siempre se verifica un hash (el ficticio si no hay usuario): mismo coste y misma respuesta.
  const ok = await verifySecret(row?.password_hash ?? (await dummyHash()), input.password);
  if (!row || !row.password_hash || !row.active || !ok) {
    await registerFailure(pool, entries);
    throw new ApiError(401, 'invalid_credentials');
  }
  // Segundo factor. Si el rol lo exige y ya está configurado, es obligatorio ANTES de crear sesión o dispositivo.
  // Si aún no lo ha configurado, la sesión nace con alcance MFA_PENDING (solo permite configurarlo).
  const mfaOk = needsMfa(row.role) && row.totp_enabled_at ? await consumeTotp(pool, row, input.totpCode, entries) : false;
  await resetThrottle(pool, [entries[0].key, entries[1].key]);
  return establishSession(pool, row, input.device, input.deviceLabel, mfaOk);
}

export async function activate(pool: Pool, input: { username: string; code: string; password: string; totpCode?: string; deviceLabel?: string }, ip: string) {
  const user = normUser(input.username);
  const entries = keysFor(user, ip);
  await ensureNotLocked(pool, entries.map((e) => e.key));
  const u = (await pool.query('SELECT id, company_id, username, full_name, role, active, password_hash, totp_secret_enc, totp_enabled_at, totp_last_step FROM app_user WHERE lower(username) = $1', [user])).rows[0];
  const tok = u ? (await pool.query(
    `SELECT id, secret_hash FROM activation_token
     WHERE user_id = $1 AND used_at IS NULL AND superseded_at IS NULL AND expires_at > now() AND attempts < $2
     ORDER BY created_at DESC LIMIT 1`, [u.id, POLICY.activationMaxAttempts])).rows[0] : null;
  const ok = await verifySecret(tok?.secret_hash ?? (await dummyHash()), normalizeCode(input.code));
  if (!u || !u.active || !tok || !ok) {
    if (tok) await pool.query('UPDATE activation_token SET attempts = attempts + 1 WHERE id = $1', [tok.id]);
    await registerFailure(pool, entries);
    throw new ApiError(401, 'invalid_activation');
  }
  const problem = checkPassword(input.password, u.username);
  if (problem) throw new ApiError(400, 'weak_password', { reason: problem });      // no consume la credencial
  // Si la cuenta ya tiene TOTP (p. ej. restablecimiento de contraseña), el código vigente también es obligatorio:
  // una credencial de activación filtrada no debe saltarse el segundo factor.
  const mfaOk = needsMfa(u.role) && u.totp_enabled_at ? await consumeTotp(pool, u, input.totpCode, entries) : false;
  const passwordHash = await hashSecret(input.password);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM app_user WHERE id = $1 FOR UPDATE', [u.id]);
    const used = await client.query('UPDATE activation_token SET used_at = now() WHERE id = $1 AND used_at IS NULL RETURNING id', [tok.id]);
    if (!used.rowCount) throw new ApiError(401, 'invalid_activation');                // otra petición la consumió
    if (u.password_hash) await revokeUserSessions(client, u.id, 'password_reset');
    await client.query('UPDATE app_user SET password_hash = $2, activated_at = COALESCE(activated_at, now()) WHERE id = $1', [u.id, passwordHash]);
    const secret = randomToken(32);
    const d = await client.query(
      `INSERT INTO device (company_id, user_id, secret_hash, label, status, last_seen, decided_at) VALUES ($1,$2,$3,$4,'AUTORIZADO', now(), now())
       RETURNING id, status`, [u.company_id, u.id, sha256hex(secret), input.deviceLabel?.slice(0, 60) ?? null]);
    const tokens = await openSession(client, u.id, u.role, d.rows[0].id, 'AUTORIZADO', mfaOk);
    const now = new Date();
    await appendAudit(client, { company_id: u.company_id, at: now, actor: `user:${u.id}`, action: 'USER_ACTIVATED', entity: 'user', entity_id: u.id, before: null, after: { first_device: d.rows[0].id }, reason: null });
    await appendAudit(client, { company_id: u.company_id, at: now, actor: `user:${u.id}`, action: 'DEVICE_REGISTERED_AUTHORIZED', entity: 'device', entity_id: d.rows[0].id, before: null, after: { status: 'AUTORIZADO' }, reason: 'activación inicial' });
    await client.query('COMMIT');
    await resetThrottle(pool, [entries[0].key, entries[1].key]);
    return { ...tokens, scope: scopeOf(u.role, 'AUTORIZADO', mfaOk ? new Date() : null), mfa_required: needsMfa(u.role) && !mfaOk, device: { id: d.rows[0].id, status: 'AUTORIZADO' as DeviceStatus, secret }, user: { id: u.id, username: u.username, full_name: u.full_name, role: u.role } };
  } catch (e) { try { await client.query('ROLLBACK'); } catch { /* */ } throw e; } finally { client.release(); }
}

export async function refresh(pool: Pool, refreshToken: string) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `SELECT rt.id AS rt_id, rt.used_at, rt.expires_at AS rt_exp, s.id AS sid, s.created_at AS s_created, s.revoked_at, s.expires_at AS s_exp, s.mfa_at,
              u.id AS uid, u.company_id, u.active, u.role, d.id AS did, d.status
       FROM refresh_token rt JOIN session s ON s.id = rt.session_id JOIN app_user u ON u.id = s.user_id JOIN device d ON d.id = s.device_id
       WHERE rt.token_hash = $1 FOR UPDATE OF rt`, [sha256hex(refreshToken)]);
    const x = r.rows[0];
    if (!x) { await client.query('ROLLBACK'); throw new ApiError(401, 'invalid_refresh'); }
    const withinGrace = x.used_at && x.role === 'conductor' && Date.now() - new Date(x.used_at).getTime() < POLICY.refreshReuseGraceSeconds * 1000;
    if (x.used_at && !withinGrace) {   // token ya rotado: posible robo de sesión → se revoca toda la familia
      await client.query(`UPDATE session SET revoked_at = now(), revoked_reason = 'refresh_reuse' WHERE id = $1 AND revoked_at IS NULL`, [x.sid]);
      await appendAudit(client, { company_id: x.company_id, at: new Date(), actor: `user:${x.uid}`, action: 'SESSION_REUSE_DETECTED', entity: 'session', entity_id: x.sid, before: null, after: { revoked: 'true' }, reason: 'refresh token reutilizado' });
      await client.query('COMMIT');
      throw new ApiError(401, 'invalid_refresh');
    }
    const now = Date.now();
    const pol = sessionPolicy(x.role, x.status);
    const absolute = new Date(new Date(x.s_created).getTime() + pol.absoluteMs);    // recalculado: autorizar un dispositivo amplía la sesión
    // La vigencia recalculada solo AMPLÍA una sesión viva (autorizar un dispositivo); una sesión ya expirada no se resucita.
    if (x.revoked_at || !x.active || x.status === 'REVOCADO' || now >= new Date(x.s_exp).getTime() || now >= new Date(x.rt_exp).getTime() || now >= absolute.getTime()) {
      await client.query('ROLLBACK'); throw new ApiError(401, 'invalid_refresh');
    }
    await client.query('UPDATE refresh_token SET used_at = COALESCE(used_at, now()) WHERE id = $1', [x.rt_id]);
    await client.query('UPDATE session SET expires_at = $2, last_refresh_at = now() WHERE id = $1', [x.sid, absolute]);
    const refreshExp = new Date(Math.min(now + pol.refreshMs, absolute.getTime()));
    const token = await newRefresh(client, x.sid, refreshExp);
    await client.query('UPDATE device SET last_seen = now() WHERE id = $1', [x.did]);
    await client.query('COMMIT');
    return {
      access_token: signAccess(x.sid, POLICY.accessTtlSeconds), access_expires_in: POLICY.accessTtlSeconds,
      refresh_token: token, refresh_expires_at: refreshExp.toISOString(), session_expires_at: absolute.toISOString(),
      scope: scopeOf(x.role, x.status, x.mfa_at), device: { id: x.did, status: x.status as DeviceStatus }
    };
  } catch (e) { try { await client.query('ROLLBACK'); } catch { /* */ } throw e; } finally { client.release(); }
}

export async function logout(pool: Pool, sessionId: string): Promise<void> {
  await pool.query(`UPDATE session SET revoked_at = now(), revoked_reason = 'logout' WHERE id = $1 AND revoked_at IS NULL`, [sessionId]);
}

/** Valida el access token y reconstruye el contexto desde la base de datos en CADA petición. */
export async function authenticate(pool: Pool, sid: string): Promise<AuthContext | null> {
  if (!UUID_RE.test(sid)) return null;
  const r = await pool.query(
    `SELECT s.id AS sid, s.expires_at, s.revoked_at, s.mfa_at, (s.expires_at > now()) AS alive, u.id AS uid, u.username, u.full_name, u.role, u.company_id, u.active,
            d.id AS did, d.status, d.registered_at
     FROM session s JOIN app_user u ON u.id = s.user_id JOIN device d ON d.id = s.device_id WHERE s.id = $1`, [sid]);
  const x = r.rows[0];
  if (!x || x.revoked_at || !x.alive || !x.active || x.status === 'REVOCADO') return null;
  return {
    userId: x.uid, username: x.username, fullName: x.full_name, role: x.role, companyId: x.company_id, sessionId: x.sid,
    deviceId: x.did, deviceStatus: x.status, deviceRegisteredAt: x.registered_at, scope: scopeOf(x.role, x.status, x.mfa_at)
  };
}

// ---------------------------------------------------------------- usuarios
async function issueActivation(client: PoolClient, userId: string, actor: string) {
  await client.query(`UPDATE activation_token SET superseded_at = now() WHERE user_id = $1 AND used_at IS NULL AND superseded_at IS NULL`, [userId]);
  const code = newActivationCode();
  const expires = new Date(Date.now() + POLICY.activationTtlHours * 3600_000);
  await client.query('INSERT INTO activation_token (user_id, secret_hash, expires_at, created_by) VALUES ($1,$2,$3,$4)', [userId, await hashSecret(normalizeCode(code)), expires, actor]);
  return { activation_code: code, activation_expires_at: expires.toISOString() };
}

function canManage(actor: Actor, targetRole: Role): boolean {
  if (actor.kind === 'cli') return true;
  if (actor.role === 'admin') return true;
  return actor.role === 'oficina' && targetRole === 'conductor';
}

export async function createUser(pool: Pool, actor: Actor, input: { username: string; fullName: string; role: string },
  company?: { name: string; nif: string; address: string }) {
  const username = normUser(input.username);
  if (!USERNAME_RE.test(username)) throw new ApiError(400, 'invalid_username');
  if (!ROLES.includes(input.role as Role)) throw new ApiError(400, 'invalid_role');
  const role = input.role as Role;
  if (!canManage(actor, role)) throw new ApiError(403, 'prohibido');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let co = (await client.query('SELECT id FROM company ORDER BY created_at LIMIT 1')).rows[0];
    if (!co) {
      if (!company) throw new ApiError(409, 'no_company');
      co = (await client.query('INSERT INTO company (name, nif, address) VALUES ($1,$2,$3) RETURNING id', [company.name, company.nif, company.address])).rows[0];
    }
    let u;
    try {
      u = (await client.query('INSERT INTO app_user (company_id, username, full_name, role, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id', [co.id, username, input.fullName.trim().slice(0, 100), role, actorStr(actor)])).rows[0];
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new ApiError(409, 'username_taken');
      throw e;
    }
    const act = await issueActivation(client, u.id, actorStr(actor));
    const now = new Date();
    await appendAudit(client, { company_id: co.id, at: now, actor: actorStr(actor), action: 'USER_CREATED', entity: 'user', entity_id: u.id, before: null, after: { username, role }, reason: null });
    await appendAudit(client, { company_id: co.id, at: now, actor: actorStr(actor), action: 'ACTIVATION_ISSUED', entity: 'user', entity_id: u.id, before: null, after: { expires: act.activation_expires_at }, reason: null });
    await client.query('COMMIT');
    return { id: u.id, username, role, ...act };
  } catch (e) { try { await client.query('ROLLBACK'); } catch { /* */ } throw e; } finally { client.release(); }
}

async function targetUser(client: PoolClient | Pool, actor: Actor, id: string) {
  if (!UUID_RE.test(id)) throw new ApiError(404, 'no_encontrado');
  const u = (await client.query('SELECT id, company_id, username, role, active FROM app_user WHERE id = $1', [id])).rows[0];
  if (!u || !canManage(actor, u.role)) throw new ApiError(404, 'no_encontrado');   // no se revela si existe
  return u;
}

/**
 * SOLO para el seed de DESARROLLO: fija una contraseña inicial a un usuario sin crear dispositivo ni sesión (la cuenta queda activada).
 * La contraseña pasa por la misma política y se guarda solo como hash Argon2id. Anula sus credenciales de activación y revoca sus sesiones.
 */
export async function setInitialPassword(pool: Pool, actor: Actor, userId: string, password: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const u = (await client.query('SELECT id, company_id, username FROM app_user WHERE id = $1 FOR UPDATE', [userId])).rows[0];
    if (!u) throw new ApiError(404, 'no_encontrado');
    const problem = checkPassword(password, u.username);
    if (problem) throw new ApiError(400, 'weak_password', { reason: problem });
    await client.query('UPDATE app_user SET password_hash = $2, activated_at = COALESCE(activated_at, now()) WHERE id = $1', [u.id, await hashSecret(password)]);
    await client.query('UPDATE activation_token SET superseded_at = now() WHERE user_id = $1 AND used_at IS NULL AND superseded_at IS NULL', [u.id]);
    await revokeUserSessions(client, u.id, 'password_reset');
    await appendAudit(client, { company_id: u.company_id, at: new Date(), actor: actorStr(actor), action: 'PASSWORD_SET', entity: 'user', entity_id: u.id, before: null, after: { by: 'seed-dev' }, reason: 'datos de desarrollo' });
    await client.query('COMMIT');
  } catch (e) { try { await client.query('ROLLBACK'); } catch { /* */ } throw e; } finally { client.release(); }
}

export async function reissueActivation(pool: Pool, actor: Actor, userId: string) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const u = await targetUser(client, actor, userId);
    if (!u.active) throw new ApiError(409, 'user_inactive');
    const act = await issueActivation(client, u.id, actorStr(actor));
    await appendAudit(client, { company_id: u.company_id, at: new Date(), actor: actorStr(actor), action: 'ACTIVATION_ISSUED', entity: 'user', entity_id: u.id, before: null, after: { expires: act.activation_expires_at }, reason: 'reemisión' });
    await client.query('COMMIT');
    return act;
  } catch (e) { try { await client.query('ROLLBACK'); } catch { /* */ } throw e; } finally { client.release(); }
}

export async function reactivateUser(pool: Pool, actor: Actor, userId: string) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const u = await targetUser(client, actor, userId);
    if (u.active) throw new ApiError(409, 'invalid_state');
    await client.query('UPDATE app_user SET active = true, deactivated_at = NULL WHERE id = $1', [u.id]);   // las sesiones revocadas siguen revocadas
    await appendAudit(client, { company_id: u.company_id, at: new Date(), actor: actorStr(actor), action: 'USER_REACTIVATED', entity: 'user', entity_id: u.id, before: { active: 'false' }, after: { active: 'true' }, reason: null });
    await client.query('COMMIT');
  } catch (e) { try { await client.query('ROLLBACK'); } catch { /* */ } throw e; } finally { client.release(); }
}

export async function deactivateUser(pool: Pool, actor: Actor, userId: string) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const u = await targetUser(client, actor, userId);
    if (actor.kind === 'user' && actor.userId === u.id) throw new ApiError(409, 'cannot_deactivate_self');
    await client.query('UPDATE app_user SET active = false, deactivated_at = COALESCE(deactivated_at, now()) WHERE id = $1', [u.id]);
    await revokeUserSessions(client, u.id, 'user_deactivated');
    await client.query('DELETE FROM push_subscription WHERE device_id IN (SELECT id FROM device WHERE user_id = $1)', [u.id]);
    await appendAudit(client, { company_id: u.company_id, at: new Date(), actor: actorStr(actor), action: 'USER_DEACTIVATED', entity: 'user', entity_id: u.id, before: { active: 'true' }, after: { active: 'false' }, reason: null });
    await client.query('COMMIT');
  } catch (e) { try { await client.query('ROLLBACK'); } catch { /* */ } throw e; } finally { client.release(); }
}

export async function listUsers(pool: Pool, actor: Actor) {
  const r = await pool.query(
    `SELECT u.id, u.username, u.full_name, u.role, u.active, u.activated_at, u.deactivated_at, u.created_at, (u.totp_enabled_at IS NOT NULL) AS totp_enabled,
            (u.password_hash IS NULL) AS pending_activation,
            (SELECT count(*)::int FROM device d WHERE d.user_id = u.id AND d.status = 'PENDIENTE_DE_CONFIRMACION') AS pending_devices
     FROM app_user u WHERE ($1::text IS NULL OR u.role = $1) ORDER BY u.created_at`, [actor.role === 'oficina' ? 'conductor' : null]);
  return r.rows;
}

// ---------------------------------------------------------------- dispositivos
export async function listDevices(pool: Pool, actor: Actor, status?: string, userId?: string) {
  const r = await pool.query(
    `SELECT d.id, d.status, d.label, d.registered_at, d.last_seen, d.decided_at, u.id AS user_id, u.username, u.role,
            EXISTS (SELECT 1 FROM push_subscription ps WHERE ps.device_id = d.id) AS push_subscribed
     FROM device d JOIN app_user u ON u.id = d.user_id
     WHERE ($1::text IS NULL OR d.status = $1) AND ($2::text IS NULL OR u.role = $2) AND ($3::uuid IS NULL OR d.user_id = $3) ORDER BY d.registered_at DESC`,
    [status ?? null, actor.role === 'oficina' ? 'conductor' : null, userId && UUID_RE.test(userId) ? userId : null]);
  return r.rows;
}

export async function decideDevice(pool: Pool, actor: Actor, deviceId: string, decision: 'authorize' | 'revoke') {
  if (!UUID_RE.test(deviceId)) throw new ApiError(404, 'no_encontrado');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const d = (await client.query(
      `SELECT d.id, d.status, d.user_id, u.company_id, u.role FROM device d JOIN app_user u ON u.id = d.user_id WHERE d.id = $1 FOR UPDATE OF d`, [deviceId])).rows[0];
    if (!d || !canManage(actor, d.role)) throw new ApiError(404, 'no_encontrado');
    if (decision === 'authorize') {
      if (actor.userId === d.user_id) throw new ApiError(403, 'prohibido');          // nadie autoriza su propio dispositivo
      if (d.status !== 'PENDIENTE_DE_CONFIRMACION') throw new ApiError(409, 'invalid_state', { status: d.status });
      await client.query(`UPDATE device SET status = 'AUTORIZADO', decided_by = $2, decided_at = now() WHERE id = $1`, [d.id, actor.userId]);
    } else {
      if (d.status === 'REVOCADO') throw new ApiError(409, 'invalid_state', { status: d.status });
      await client.query(`UPDATE device SET status = 'REVOCADO', decided_by = $2, decided_at = now() WHERE id = $1`, [d.id, actor.userId]);
      // Invalida las sesiones del dispositivo; sus refresh tokens dejan de servir porque la sesión queda revocada.
      await client.query(`UPDATE session SET revoked_at = now(), revoked_reason = 'device_revoked' WHERE device_id = $1 AND revoked_at IS NULL`, [d.id]);
      await client.query('DELETE FROM push_subscription WHERE device_id = $1', [d.id]);
    }
    await appendAudit(client, { company_id: d.company_id, at: new Date(), actor: actorStr(actor),
      action: decision === 'authorize' ? 'DEVICE_AUTHORIZED' : 'DEVICE_REVOKED', entity: 'device', entity_id: d.id,
      before: { status: d.status }, after: { status: decision === 'authorize' ? 'AUTORIZADO' : 'REVOCADO' }, reason: null });
    await client.query('COMMIT');
  } catch (e) { try { await client.query('ROLLBACK'); } catch { /* */ } throw e; } finally { client.release(); }
}

export async function revokeAllSessions(pool: Pool, reason: string): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(`UPDATE session SET revoked_at = now(), revoked_reason = $1 WHERE revoked_at IS NULL`, [reason]);
    await appendAudit(client, { company_id: null, at: new Date(), actor: 'cli', action: 'SESSIONS_REVOKED', entity: 'system', entity_id: 'all', before: null, after: { count: String(r.rowCount), reason }, reason });
    await client.query('COMMIT');
    return r.rowCount ?? 0;
  } catch (e) { try { await client.query('ROLLBACK'); } catch { /* */ } throw e; } finally { client.release(); }
}

// ---------------------------------------------------------------- asignación
/**
 * Asigna el conductor. `relay`: si ya hay conductor, el nuevo queda como RELEVO (continúa cuando el actual pulse «He terminado mi parte»);
 * sin conductor, el relevo se asigna directamente. Devuelve lo que ha pasado. Con conductor el transporte pasa a EN_CURSO.
 */
export async function assignDriver(pool: Pool, actor: Actor, transportId: string, driverId: string, relay = false): Promise<'assigned' | 'relay'> {
  if (!UUID_RE.test(transportId) || !UUID_RE.test(driverId)) throw new ApiError(404, 'no_encontrado');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`transport:${transportId}`]);
    const t = (await client.query('SELECT id, company_id, status FROM transport WHERE id = $1', [transportId])).rows[0];
    const d = (await client.query(`SELECT id FROM app_user WHERE id = $1 AND role = 'conductor' AND active`, [driverId])).rows[0];
    if (!t || !d) throw new ApiError(404, 'no_encontrado');
    if (t.status !== 'PENDIENTE' && t.status !== 'EN_CURSO') throw new ApiError(409, 'transporte_cerrado');
    const cur = (await client.query('SELECT driver_user_id FROM transport_driver_assignment WHERE transport_id = $1 AND valid_to IS NULL', [t.id])).rows[0];
    if (relay && cur) {
      if (cur.driver_user_id === d.id) throw new ApiError(409, 'relevo_mismo_conductor');
      await client.query('DELETE FROM transport_relay WHERE transport_id = $1', [t.id]);
      await client.query('INSERT INTO transport_relay (transport_id, driver_user_id, created_by) VALUES ($1,$2,$3)', [t.id, d.id, actorStr(actor)]);
      await appendAudit(client, { company_id: t.company_id, at: new Date(), actor: actorStr(actor), action: 'TRANSPORT_RELAY_SET', entity: 'transport', entity_id: t.id, before: null, after: { next_driver: d.id }, reason: null });
      await client.query('COMMIT');
      return 'relay';
    }
    await client.query('UPDATE transport_driver_assignment SET valid_to = now() WHERE transport_id = $1 AND valid_to IS NULL', [t.id]);
    await client.query('INSERT INTO transport_driver_assignment (transport_id, driver_user_id, created_by) VALUES ($1,$2,$3)', [t.id, d.id, actorStr(actor)]);
    await client.query('DELETE FROM transport_relay WHERE transport_id = $1 AND driver_user_id = $2', [t.id, d.id]);   // si era el relevo, ya es el actual
    if (t.status === 'PENDIENTE') await client.query(`UPDATE transport SET status = 'EN_CURSO' WHERE id = $1`, [t.id]);
    await appendAudit(client, { company_id: t.company_id, at: new Date(), actor: actorStr(actor), action: 'TRANSPORT_DRIVER_ASSIGNED', entity: 'transport', entity_id: t.id, before: null, after: { driver: d.id }, reason: null });
    await client.query('COMMIT');
    return 'assigned';
  } catch (e) { try { await client.query('ROLLBACK'); } catch { /* */ } throw e; } finally { client.release(); }
}

/** Quita el relevo programado (oficina). */
export async function clearRelay(pool: Pool, actor: Actor, transportId: string): Promise<void> {
  if (!UUID_RE.test(transportId)) throw new ApiError(404, 'no_encontrado');
  const t = (await pool.query('SELECT company_id FROM transport WHERE id = $1', [transportId])).rows[0];
  if (!t) throw new ApiError(404, 'no_encontrado');
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await c.query('DELETE FROM transport_relay WHERE transport_id = $1', [transportId]);
    if (r.rowCount) await appendAudit(c, { company_id: t.company_id, at: new Date(), actor: actorStr(actor), action: 'TRANSPORT_RELAY_CLEARED', entity: 'transport', entity_id: transportId, before: null, after: null, reason: null });
    await c.query('COMMIT');
  } catch (e) { try { await c.query('ROLLBACK'); } catch { /* */ } throw e; } finally { c.release(); }
}

// ---------------------------------------------------------------- TOTP: alta y reinicio
/** Inicia el alta del TOTP: genera un secreto (cifrado en reposo) que no vale hasta confirmarlo con un código. */
export async function totpSetup(pool: Pool, auth: AuthContext) {
  if (!needsMfa(auth.role)) throw new ApiError(403, 'prohibido');
  const u = (await pool.query('SELECT username, totp_enabled_at FROM app_user WHERE id = $1', [auth.userId])).rows[0];
  if (u.totp_enabled_at) throw new ApiError(409, 'totp_already_enabled');     // un atacante con sesión no puede sustituir el autenticador
  const secret = newTotpSecret();
  await pool.query('UPDATE app_user SET totp_secret_enc = $2, totp_last_step = NULL WHERE id = $1 AND totp_enabled_at IS NULL', [auth.userId, encryptTotpSecret(secret)]);
  const uri = otpauthUri(u.username, secret);
  return { otpauth_uri: uri, secret, qr_svg: await QRCode.toString(uri, { type: 'svg', errorCorrectionLevel: 'M', margin: 2 }) };
}

/** Confirma el alta con un código válido, activa el TOTP y eleva la sesión actual a FULL. */
export async function totpEnable(pool: Pool, auth: AuthContext, code: string) {
  if (!needsMfa(auth.role)) throw new ApiError(403, 'prohibido');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const u = (await client.query('SELECT id, company_id, totp_secret_enc, totp_enabled_at FROM app_user WHERE id = $1 FOR UPDATE', [auth.userId])).rows[0];
    if (u.totp_enabled_at) throw new ApiError(409, 'totp_already_enabled');
    if (!u.totp_secret_enc) throw new ApiError(409, 'no_pending_setup');
    const step = verifyTotp(decryptTotpSecret(u.totp_secret_enc), code, null);
    if (step === null) throw new ApiError(401, 'invalid_totp');
    await client.query('UPDATE app_user SET totp_enabled_at = now(), totp_last_step = $2 WHERE id = $1', [u.id, step]);
    await client.query('UPDATE session SET mfa_at = now() WHERE id = $1', [auth.sessionId]);
    await appendAudit(client, { company_id: u.company_id, at: new Date(), actor: `user:${u.id}`, action: 'TOTP_ENABLED', entity: 'user', entity_id: u.id, before: null, after: { totp: 'enabled' }, reason: null });
    await client.query('COMMIT');
    return { scope: 'FULL' as const };
  } catch (e) { try { await client.query('ROLLBACK'); } catch { /* */ } throw e; } finally { client.release(); }
}

/** Reinicia el TOTP de un usuario (autenticador perdido): borra el secreto y revoca sus sesiones. Solo admin o CLI; nunca el propio. */
export async function resetTotp(pool: Pool, actor: Actor, userId: string) {
  if (actor.kind === 'user' && actor.role !== 'admin') throw new ApiError(403, 'prohibido');
  if (!UUID_RE.test(userId)) throw new ApiError(404, 'no_encontrado');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const u = (await client.query('SELECT id, company_id, role, totp_enabled_at FROM app_user WHERE id = $1 FOR UPDATE', [userId])).rows[0];
    if (!u) throw new ApiError(404, 'no_encontrado');
    if (actor.kind === 'user' && actor.userId === u.id) throw new ApiError(403, 'prohibido');   // nadie reinicia su propio segundo factor
    await client.query('UPDATE app_user SET totp_secret_enc = NULL, totp_enabled_at = NULL, totp_last_step = NULL WHERE id = $1', [u.id]);
    await revokeUserSessions(client, u.id, 'totp_reset');
    await appendAudit(client, { company_id: u.company_id, at: new Date(), actor: actorStr(actor), action: 'TOTP_RESET', entity: 'user', entity_id: u.id, before: { totp: u.totp_enabled_at ? 'enabled' : 'none' }, after: { totp: 'none' }, reason: null });
    await client.query('COMMIT');
  } catch (e) { try { await client.query('ROLLBACK'); } catch { /* */ } throw e; } finally { client.release(); }
}

export async function resetTotpByUsername(pool: Pool, username: string): Promise<void> {
  const r = await pool.query('SELECT id FROM app_user WHERE lower(username) = $1', [normUser(username)]);
  if (!r.rowCount) throw new ApiError(404, 'no_encontrado');
  await resetTotp(pool, { kind: 'cli' }, r.rows[0].id);
}
