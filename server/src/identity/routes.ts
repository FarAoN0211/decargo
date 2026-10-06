import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { LocalStorage } from '../common/storage';
import { optional } from '../common/config';
import { driverFuelCards, finishDriverPart, finishDriverTransport, getDriverTransport, driverDecaPdf, driverDecaQrSvg, listDriverTransports } from './driver';
import { Role } from './policy';
import {
  Actor, ApiError, AuthContext, activate, assignDriver, authenticate, clearRelay, createUser, deactivateUser, decideDevice, listDevices,
  listUsers, login, logout, reactivateUser, refresh, reissueActivation, resetTotp, totpEnable, totpSetup
} from './service';
import { verifyAccess } from './tokens';
import { syncDriverIntoDeca } from '../office/transports';
import { currentDriverOf, pushConfig, pushTestAck, pushTestStatus, saveFcmToken, savePushSubscription, sendPushTest, sendTransportAssignedPush, sendTransportPush } from './push';
import { fcmClient } from './fcm';

declare module 'fastify' { interface FastifyRequest { auth?: AuthContext } }

const AUTH_RATE = { max: Number(optional('AUTH_RATE_MAX', '120')), timeWindow: '1 minute' };
const OFFICE: Role[] = ['admin', 'oficina'];
const READERS: Role[] = ['admin', 'oficina', 'solo_lectura'];
const MFA_ROLES: Role[] = ['admin', 'oficina', 'solo_lectura'];   // roles que exigen TOTP

/** La autorización se decide SIEMPRE aquí, en el servidor, con el estado actual de la sesión, el usuario y el dispositivo. */
export function guard(pool: Pool, opts: { roles?: Role[]; full?: boolean }) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const h = req.headers.authorization ?? '';
    const p = h.startsWith('Bearer ') ? verifyAccess(h.slice(7)) : null;
    const ctx = p ? await authenticate(pool, p.sid) : null;
    if (!ctx) { reply.code(401).send({ error: 'no_autenticado' }); return; }
    req.auth = ctx;
    if (opts.roles && !opts.roles.includes(ctx.role)) { reply.code(403).send({ error: 'prohibido' }); return; }
    if (opts.full && ctx.scope !== 'FULL') { reply.code(403).send({ error: ctx.scope === 'MFA_PENDING' ? 'mfa_required' : 'dispositivo_pendiente' }); return; }
  };
}
const actorOf = (a: AuthContext): Actor => ({ kind: 'user', userId: a.userId, role: a.role });

export function registerIdentityRoutes(app: FastifyInstance, pool: Pool, storage: LocalStorage): void {
  app.setErrorHandler((err: unknown, _req, reply) => {
    const e = err as { validation?: unknown; statusCode?: number; message?: string };
    if (err instanceof ApiError) {
      if (err.status === 429 && typeof err.extra.retry_after_seconds === 'number') reply.header('Retry-After', String(err.extra.retry_after_seconds));
      return reply.code(err.status).send({ error: err.code, ...err.extra });
    }
    if (e.validation) return reply.code(400).send({ error: 'bad_request' });
    if (e.statusCode && e.statusCode < 500) return reply.code(e.statusCode).send({ error: e.statusCode === 429 ? 'rate_limited' : 'bad_request' });
    app.log.error({ msg: e.message }, 'error interno');
    return reply.code(500).send({ error: 'internal' });
  });

  const devSchema = { type: 'object', required: ['id', 'secret'], additionalProperties: false,
    properties: { id: { type: 'string', maxLength: 36 }, secret: { type: 'string', maxLength: 100 } } };

  // ------------------------------------------------------------ autenticación (públicas)
  app.post('/api/v1/auth/login', { config: { rateLimit: AUTH_RATE }, schema: { body: { type: 'object', required: ['username', 'password'], additionalProperties: false,
    properties: { username: { type: 'string', minLength: 1, maxLength: 64 }, password: { type: 'string', minLength: 1, maxLength: 256 }, totp_code: { type: 'string', maxLength: 12 }, device: devSchema, device_label: { type: 'string', maxLength: 60 } } } } },
    async (req) => {
      const b = req.body as { username: string; password: string; totp_code?: string; device?: { id: string; secret: string }; device_label?: string };
      return login(pool, { username: b.username, password: b.password, totpCode: b.totp_code, device: b.device, deviceLabel: b.device_label }, req.ip);
    });

  app.post('/api/v1/auth/activate', { config: { rateLimit: AUTH_RATE }, schema: { body: { type: 'object', required: ['username', 'code', 'password'], additionalProperties: false,
    properties: { username: { type: 'string', minLength: 1, maxLength: 64 }, code: { type: 'string', minLength: 1, maxLength: 40 }, password: { type: 'string', minLength: 1, maxLength: 256 }, totp_code: { type: 'string', maxLength: 12 }, device_label: { type: 'string', maxLength: 60 } } } } },
    async (req) => {
      const b = req.body as { username: string; code: string; password: string; totp_code?: string; device_label?: string };
      return activate(pool, { username: b.username, code: b.code, password: b.password, totpCode: b.totp_code, deviceLabel: b.device_label }, req.ip);
    });

  app.post('/api/v1/auth/refresh', { config: { rateLimit: AUTH_RATE }, schema: { body: { type: 'object', required: ['refresh_token'], additionalProperties: false,
    properties: { refresh_token: { type: 'string', minLength: 10, maxLength: 200 } } } } },
    async (req) => refresh(pool, (req.body as { refresh_token: string }).refresh_token));

  // Segundo factor: alta (también con alcance MFA_PENDING, que existe precisamente para esto).
  app.post('/api/v1/auth/totp/setup', { config: { rateLimit: AUTH_RATE }, preHandler: guard(pool, { roles: MFA_ROLES }) }, async (req) => totpSetup(pool, req.auth!));
  app.post('/api/v1/auth/totp/enable', { config: { rateLimit: AUTH_RATE }, preHandler: guard(pool, { roles: MFA_ROLES }), schema: { body: { type: 'object', required: ['code'], additionalProperties: false,
    properties: { code: { type: 'string', minLength: 1, maxLength: 12 } } } } },
    async (req) => totpEnable(pool, req.auth!, (req.body as { code: string }).code));

  app.post('/api/v1/auth/logout', { preHandler: guard(pool, {}) }, async (req, reply) => { await logout(pool, req.auth!.sessionId); return reply.code(204).send(); });

  app.get('/api/v1/me', { preHandler: guard(pool, {}) }, async (req) => {
    const a = req.auth!;
    return { id: a.userId, username: a.username, full_name: a.fullName, role: a.role, scope: a.scope, mfa_required: a.scope === 'MFA_PENDING', device: { id: a.deviceId, status: a.deviceStatus } };
  });

  // ------------------------------------------------------------ usuarios (oficina: solo conductores)
  app.post('/api/v1/users', { preHandler: guard(pool, { roles: OFFICE, full: true }), schema: { body: { type: 'object', required: ['username', 'full_name', 'role'], additionalProperties: false,
    properties: { username: { type: 'string', maxLength: 64 }, full_name: { type: 'string', minLength: 1, maxLength: 100 }, role: { type: 'string', maxLength: 20 } } } } },
    async (req, reply) => {
      const b = req.body as { username: string; full_name: string; role: string };
      return reply.code(201).send(await createUser(pool, actorOf(req.auth!), { username: b.username, fullName: b.full_name, role: b.role }));
    });
  app.get('/api/v1/users', { preHandler: guard(pool, { roles: OFFICE, full: true }) }, async (req) => listUsers(pool, actorOf(req.auth!)));
  app.post<{ Params: { id: string } }>('/api/v1/users/:id/deactivate', { preHandler: guard(pool, { roles: OFFICE, full: true }) },
    async (req, reply) => { await deactivateUser(pool, actorOf(req.auth!), req.params.id); return reply.code(204).send(); });
  app.post<{ Params: { id: string } }>('/api/v1/users/:id/reactivate', { preHandler: guard(pool, { roles: OFFICE, full: true }) },
    async (req, reply) => { await reactivateUser(pool, actorOf(req.auth!), req.params.id); return reply.code(204).send(); });
  app.post<{ Params: { id: string } }>('/api/v1/users/:id/totp/reset', { preHandler: guard(pool, { roles: ['admin'], full: true }) },
    async (req, reply) => { await resetTotp(pool, actorOf(req.auth!), req.params.id); return reply.code(204).send(); });
  app.post<{ Params: { id: string } }>('/api/v1/users/:id/activation', { preHandler: guard(pool, { roles: OFFICE, full: true }) },
    async (req) => reissueActivation(pool, actorOf(req.auth!), req.params.id));

  // ------------------------------------------------------------ dispositivos
  app.get<{ Querystring: { status?: string; user_id?: string } }>('/api/v1/devices', { preHandler: guard(pool, { roles: READERS, full: true }) },
    async (req) => listDevices(pool, actorOf(req.auth!), req.query.status, req.query.user_id));
  for (const decision of ['authorize', 'revoke'] as const) {
    app.post<{ Params: { id: string } }>(`/api/v1/devices/:id/${decision}`, { preHandler: guard(pool, { roles: OFFICE, full: true }) },
      async (req, reply) => { await decideDevice(pool, actorOf(req.auth!), req.params.id, decision); return reply.code(204).send(); });
  }

  // Prueba de aviso lanzada por la oficina hacia un dispositivo autorizado de un conductor, con seguimiento (enviado → recibido → mostrado → pulsado).
  app.post<{ Params: { id: string } }>('/api/v1/devices/:id/push-test', { preHandler: guard(pool, { roles: OFFICE, full: true }), config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => reply.code(201).send(await sendPushTest(pool, actorOf(req.auth!), req.params.id)));
  app.get<{ Params: { id: string } }>('/api/v1/push-test/:id', { preHandler: guard(pool, { roles: OFFICE, full: true }) }, async (req) => pushTestStatus(pool, actorOf(req.auth!), req.params.id));
  // Acuse del service worker del teléfono: sin sesión (el identificador es un UUID aleatorio de un solo uso y 10 minutos); respuesta uniforme.
  app.post('/api/v1/push/ack', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } }, schema: { body: { type: 'object', additionalProperties: false, properties: { n: { type: 'string', maxLength: 40 }, event: { type: 'string', maxLength: 20 }, info: { type: 'object', maxProperties: 8 } } } } },
    async (req, reply) => { const b = (req.body ?? {}) as { n?: string; event?: string; info?: unknown }; await pushTestAck(pool, b.n, b.event, b.info); return reply.code(204).send(); });

  // ------------------------------------------------------------ auditoría (solo admin)
  app.get<{ Querystring: { limit?: string } }>('/api/v1/audit', { preHandler: guard(pool, { roles: ['admin'], full: true }) }, async (req) => {
    const n = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 500);
    return (await pool.query('SELECT id, at, actor, action, entity, entity_id, after, reason FROM audit_log ORDER BY id DESC LIMIT $1', [n])).rows;
  });

  // ------------------------------------------------------------ transportes y DeCA (oficina)

  app.post<{ Params: { id: string } }>('/api/v1/transports/:id/assign-driver', { preHandler: guard(pool, { roles: OFFICE, full: true }), schema: { body: { type: 'object', required: ['driver_id'], additionalProperties: false,
    properties: { driver_id: { type: 'string', maxLength: 36 }, relay: { type: 'boolean' } } } } },
    async (req, reply) => {
      const { driver_id: driverId, relay } = req.body as { driver_id: string; relay?: boolean };
      const before = await currentDriverOf(pool, req.params.id);
      // relay: el nuevo conductor CONTINÚA cuando el actual pulse «He terminado mi parte» (no se le quita al actual).
      const done = await assignDriver(pool, actorOf(req.auth!), req.params.id, driverId, relay === true);
      if (done === 'relay') return reply.code(204).send();
      // Al conductor anterior se le avisa de que ya no lo tiene (mismo aviso prioritario).
      if (before && before !== driverId) void sendTransportPush(pool, before, req.params.id, 'UNASSIGNED', 'Se ha asignado a otro conductor').catch(() => undefined);
      // Si el DeCA ya está emitido (carta de porte con datos del conductor), se añade el conductor con una versión nueva (mismo QR y URL). Un fallo aquí no deshace la asignación.
      try { await syncDriverIntoDeca(pool, storage, actorOf(req.auth!), req.params.id); } catch { /* el conductor ya está asignado; se puede reemitir */ }
      // La asignación ya está confirmada: un fallo del proveedor Push nunca la revierte ni la oculta a la oficina.
      try { await sendTransportAssignedPush(pool, driverId, req.params.id); } catch { /* queda visible al abrir la PWA */ }
      return reply.code(204).send();
    });
  app.delete<{ Params: { id: string } }>('/api/v1/transports/:id/relay', { preHandler: guard(pool, { roles: OFFICE, full: true }) }, async (req, reply) => {
    await clearRelay(pool, actorOf(req.auth!), req.params.id);
    return reply.code(204).send();
  });

  app.get<{ Params: { id: string } }>('/api/v1/decas/:id', { preHandler: guard(pool, { roles: READERS, full: true }) }, async (req, reply) => {
    if (!/^[0-9a-f-]{36}$/.test(req.params.id)) return reply.code(404).send({ error: 'no_encontrado' });
    const d = await pool.query(`SELECT id, status, current_version, public_active, public_until, retain_not_before, created_at FROM deca WHERE id = $1`, [req.params.id]);
    if (!d.rowCount) return reply.code(404).send({ error: 'no_encontrado' });
    const v = await pool.query(`SELECT version_no, method, created_at, sha256, size_bytes, pdf_created, pdf_modified FROM deca_version WHERE deca_id = $1 ORDER BY version_no`, [req.params.id]);
    return { ...d.rows[0], versions: v.rows };
  });
  app.get<{ Params: { id: string; n: string } }>('/api/v1/decas/:id/versions/:n/pdf', { preHandler: guard(pool, { roles: READERS, full: true }) }, async (req, reply) => {
    if (!/^[0-9a-f-]{36}$/.test(req.params.id) || !/^\d{1,4}$/.test(req.params.n)) return reply.code(404).send({ error: 'no_encontrado' });
    const v = await pool.query('SELECT file_key, sha256 FROM deca_version WHERE deca_id = $1 AND version_no = $2', [req.params.id, Number(req.params.n)]);
    if (!v.rowCount) return reply.code(404).send({ error: 'no_encontrado' });
    return reply.type('application/pdf').header('Cache-Control', 'private, no-store').send(await storage.getVerified(v.rows[0].file_key, v.rows[0].sha256));
  });

  // ------------------------------------------------------------ conductor (solo lectura; alcance LIMITED o FULL)
  const driver = guard(pool, { roles: ['conductor'] });
  app.get('/api/v1/driver/push/config', { preHandler: driver }, async () => pushConfig());
  // App Android: datos PÚBLICOS de Firebase para que el teléfono se registre (sin sesión: la app los pide al arrancar) y registro del token.
  // Web pública y app Android: dónde está la aplicación de esta instalación (botón «Acceder», arranque de la app) y la demo si existe.
  // No es un secreto (el botón «Acceder» la muestra); la seguridad sigue siendo el inicio de sesión.
  app.get('/api/v1/app/entry', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (_req, reply) => {
    const p = process.env.DECARGO_APP_PATH ?? '', demo = process.env.DECARGO_DEMO_URL ?? '';
    reply.header('cache-control', 'no-store');
    // Demo: por defecto la incluida en esta instalación (/demo/, datos ficticios en el navegador); «off» la oculta; o una dirección https propia.
    const site = process.env.DECARGO_PUBLIC_SITE === '1';   // sin web pública (instalación de empresa) no hay demo incluida
    const demoUrl = demo === 'off' ? null : /^https:\/\/[^\s"'<>]+$/.test(demo) ? demo : demo === '' && site ? '/demo/' : null;
    return { app_path: /^[A-Za-z0-9_-]{16,64}$/.test(p) ? `/${p}/` : '/', demo_url: demoUrl };
  });
  app.get('/api/v1/app/fcm-config', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (_req, reply) => {
    const c = await fcmClient(pool);
    if (!c) return reply.code(404).send({ error: 'fcm_no_configurado' });
    return { project_id: c.project_id, sender_id: c.project_number, app_id: c.app_id, api_key: c.api_key };
  });
  app.post('/api/v1/driver/push/fcm', { preHandler: driver, config: { rateLimit: { max: 20, timeWindow: '1 minute' } }, schema: { body: { type: 'object', required: ['token'], additionalProperties: false,
    properties: { token: { type: 'string', minLength: 1, maxLength: 4096 } } } } }, async (req, reply) => {
    await saveFcmToken(pool, req.auth!, (req.body as { token: string }).token);
    return reply.code(204).send();
  });
  app.post('/api/v1/driver/push/subscribe', { preHandler: driver, schema: { body: { type: 'object', required: ['endpoint', 'keys'], additionalProperties: false,
    properties: {
      endpoint: { type: 'string', minLength: 1, maxLength: 2048 },
      keys: { type: 'object', required: ['p256dh', 'auth'], additionalProperties: false,
        properties: { p256dh: { type: 'string', minLength: 1, maxLength: 256 }, auth: { type: 'string', minLength: 1, maxLength: 128 } } }
    } } } }, async (req, reply) => {
      await savePushSubscription(pool, req.auth!, req.body as { endpoint: string; keys: { p256dh: string; auth: string } });
      return reply.code(204).send();
    });
  // El conductor finaliza su transporte (solo desde un dispositivo autorizado).
  app.post<{ Params: { id: string } }>('/api/v1/driver/transports/:id/finish-part', { preHandler: driver, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req) => {
      const r = await finishDriverPart(pool, req.auth!, req.params.id);
      // El relevo pasa a ser el conductor: su nombre entra en el DeCA (9.1) si procede y recibe el aviso de asignación.
      if (r.next_driver) {
        try { await syncDriverIntoDeca(pool, storage, actorOf(req.auth!), req.params.id); } catch { /* se puede reemitir */ }
        void sendTransportAssignedPush(pool, r.next_driver, req.params.id).catch(() => undefined);
      }
      return { next_driver: !!r.next_driver };
    });
  app.get<{ Params: { id: string } }>('/api/v1/driver/transports/:id/cards', { preHandler: driver, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req) => driverFuelCards(pool, req.auth!, req.params.id));
  app.post<{ Params: { id: string } }>('/api/v1/driver/transports/:id/finish', { preHandler: driver, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req) => finishDriverTransport(pool, req.auth!, req.params.id));
  app.get('/api/v1/driver/transports', { preHandler: driver }, async (req) => listDriverTransports(pool, req.auth!));
  app.get<{ Params: { id: string } }>('/api/v1/driver/transports/:id', { preHandler: driver }, async (req, reply) => {
    const t = await getDriverTransport(pool, req.auth!, req.params.id);
    return t ?? reply.code(404).send({ error: 'no_encontrado' });
  });
  app.get<{ Params: { id: string } }>('/api/v1/driver/decas/:id/current.pdf', { preHandler: driver }, async (req, reply) => {
    const pdf = await driverDecaPdf(pool, storage, req.auth!, req.params.id);
    return pdf ? reply.type('application/pdf').header('Cache-Control', 'private, no-store').send(pdf) : reply.code(404).send({ error: 'no_encontrado' });
  });
  app.get<{ Params: { id: string } }>('/api/v1/driver/decas/:id/qr.svg', { preHandler: driver }, async (req, reply) => {
    const svg = await driverDecaQrSvg(pool, req.auth!, req.params.id);
    return svg ? reply.type('image/svg+xml').header('Cache-Control', 'private, no-store').send(svg) : reply.code(404).send({ error: 'no_encontrado' });
  });
}
