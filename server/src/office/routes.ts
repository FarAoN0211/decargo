import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { LocalStorage } from '../common/storage';
import { guard } from '../identity/routes';
import type { Actor, AuthContext } from '../identity/service';
import { cancelTransport, changeVehicle, createTransport, dashboard, decaQrSvg, generateDecaForTransport, getTransportDetail, listTransports, setVehicles } from './transports';
import { createVehicle, getVehicle, listVehicles, updateVehicle, VEHICLE_KINDS } from './vehicles';
import { notifyTransport, vehiclesText, type TransportEvent } from '../identity/push';
import { checkPublicBase, getConfig, setCompany, setDocSettings, setFcm, setFlags, setPublicBase, setTemplate, templatePreview } from './config';
import { catalog, createAsset, createDocument, listAssets, listDocuments, listExpiries, revealPin, updateAsset, updateDocument } from './documents';
import { checkTaxId } from './taxid';
import { createParty, createSite, getParty, searchParties, updateParty, updateSite } from './parties';
import { getProfile, ibanPreview, revealField, saveProfile } from './profile';
import { reissueDeca, reissueOutdated } from './reissue';
import { UUID_RE, bad, optUuid } from './validate';

const actorOf = (a: AuthContext): Actor => ({ kind: 'user', userId: a.userId, role: a.role });
const obj = { type: 'object' } as const;   // la forma se valida en el servicio, campo a campo

/** Interfaz de oficina: la autorización se decide aquí, en el servidor. admin y oficina escriben; solo_lectura únicamente consulta. */
export function registerOfficeRoutes(app: FastifyInstance, pool: Pool, storage: LocalStorage): void {
  const readers = guard(pool, { roles: ['admin', 'oficina', 'solo_lectura'], full: true });
  const office = guard(pool, { roles: ['admin', 'oficina'], full: true });

  app.get('/api/v1/dashboard', { preHandler: readers }, async () => dashboard(pool));

  app.get<{ Querystring: { status?: string } }>('/api/v1/transports', { preHandler: readers }, async (req) => listTransports(pool, req.query.status));
  app.get<{ Params: { id: string } }>('/api/v1/transports/:id', { preHandler: readers }, async (req) => getTransportDetail(pool, req.params.id));
  // Avisos al conductor: se envían en segundo plano (no retrasan la respuesta) y un fallo nunca deshace el cambio.
  const tell = (id: string, ev: TransportEvent, what = ''): void => { void notifyTransport(pool, id, ev, what); };
  app.post('/api/v1/transports', { preHandler: office, schema: { body: obj } }, async (req, reply) => {
    const t = await createTransport(pool, storage, actorOf(req.auth!), (req.body ?? {}) as Record<string, unknown>);
    tell(t.id, 'ASSIGNED');   // creado ya con conductor: mismo aviso que al asignarlo después
    return reply.code(201).send(t);
  });
  app.post<{ Params: { id: string } }>('/api/v1/transports/:id/deca', { preHandler: office }, async (req, reply) => {
    const r = await generateDecaForTransport(pool, storage, actorOf(req.auth!), req.params.id);
    tell(req.params.id, 'UPDATED', 'Ya tienes el DeCA del transporte');
    return reply.code(201).send(r);
  });
  app.put<{ Params: { id: string } }>('/api/v1/transports/:id/vehicles', { preHandler: office, schema: { body: obj } }, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    await setVehicles(pool, actorOf(req.auth!), req.params.id, optUuid(b.tractor_id, 'tractor_id'), optUuid(b.trailer_id, 'trailer_id'));
    tell(req.params.id, 'UPDATED', `Vehículo: ${await vehiclesText(pool, req.params.id)}`);
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>('/api/v1/transports/:id/vehicle-change', { preHandler: office, schema: { body: obj } }, async (req) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const r = await changeVehicle(pool, storage, actorOf(req.auth!), req.params.id, b.tractor_id, b.trailer_id, b.reason);
    tell(req.params.id, 'UPDATED', `Cambio de vehículo: ${await vehiclesText(pool, req.params.id)}`);
    return r;
  });
  app.post<{ Params: { id: string } }>('/api/v1/transports/:id/cancel', { preHandler: office, schema: { body: obj } }, async (req, reply) => {
    const reason = ((req.body ?? {}) as Record<string, unknown>).reason;
    await cancelTransport(pool, actorOf(req.auth!), req.params.id, reason);
    tell(req.params.id, 'CANCELLED', typeof reason === 'string' ? `Motivo: ${reason.trim().slice(0, 150)}` : '');
    return reply.code(204).send();
  });
  app.get<{ Querystring: { active?: string; kind?: string } }>('/api/v1/vehicles', { preHandler: readers }, async (req) => {
    const kinds = req.query.kind ? req.query.kind.split(',') : undefined;
    if (kinds && !kinds.every((k) => (VEHICLE_KINDS as readonly string[]).includes(k))) throw bad('kind');
    return listVehicles(pool, { active: req.query.active === undefined ? undefined : req.query.active === 'true', kinds });
  });
  app.get<{ Params: { id: string } }>('/api/v1/vehicles/:id', { preHandler: readers }, async (req) => getVehicle(pool, req.params.id));
  app.post('/api/v1/vehicles', { preHandler: office, schema: { body: obj } }, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    return reply.code(201).send(await createVehicle(pool, actorOf(req.auth!), { plate: b.plate, kind: b.kind }));
  });
  app.patch<{ Params: { id: string } }>('/api/v1/vehicles/:id', { preHandler: office, schema: { body: obj } }, async (req, reply) => {
    await updateVehicle(pool, actorOf(req.auth!), req.params.id, (req.body ?? {}) as Record<string, unknown>);
    return reply.code(204).send();
  });

  // Configuración de la instalación (solo administrador): dirección pública de los DeCA y su comprobación.
  const admin = guard(pool, { roles: ['admin'], full: true });
  app.get('/api/v1/admin/config', { preHandler: admin }, async () => getConfig(pool));
  app.put('/api/v1/admin/config/public-base-url', { preHandler: admin, schema: { body: obj } }, async (req) =>
    setPublicBase(pool, actorOf(req.auth!), ((req.body ?? {}) as Record<string, unknown>).url));
  app.put('/api/v1/admin/config/documents', { preHandler: admin, schema: { body: obj } }, async (req) => setDocSettings(pool, actorOf(req.auth!), (req.body ?? {}) as Record<string, unknown>));
  app.put('/api/v1/admin/config/template', { preHandler: admin, schema: { body: obj } }, async (req) => setTemplate(pool, actorOf(req.auth!), (req.body ?? {}) as Record<string, unknown>));
  app.get<{ Querystring: { template?: string; mode?: string } }>('/api/v1/admin/config/template-preview', { preHandler: admin }, async (req, reply) =>
    reply.type('application/pdf').header('Cache-Control', 'private, no-store').send(await templatePreview(pool, req.query.template, req.query.mode)));
  app.put('/api/v1/admin/config/company', { preHandler: admin, schema: { body: obj } }, async (req) => setCompany(pool, actorOf(req.auth!), (req.body ?? {}) as Record<string, unknown>));
  app.put('/api/v1/admin/config/fcm', { preHandler: admin, schema: { body: obj }, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => setFcm(pool, actorOf(req.auth!), (req.body ?? {}) as Record<string, unknown>));
  app.put('/api/v1/admin/config/flags', { preHandler: admin, schema: { body: obj } }, async (req) => setFlags(pool, actorOf(req.auth!), (req.body ?? {}) as Record<string, unknown>));
  app.post('/api/v1/admin/config/check', { preHandler: admin, schema: { body: obj }, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) =>
    checkPublicBase(pool, ((req.body ?? {}) as Record<string, unknown>).url));

  app.post('/api/v1/taxid/check', { preHandler: readers, schema: { body: obj } }, async (req) => {
    const v = ((req.body ?? {}) as Record<string, unknown>).nif;
    if (typeof v !== 'string' || v.length > 40) throw bad('nif');
    const r = checkTaxId(v); return { kind: r.kind, valid: r.valid, normalized: r.normalized };
  });
  // Agenda de empresas y de sus lugares de carga/descarga (con ubicación para compartir con los conductores).
  app.get<{ Querystring: { q?: string; all?: string } }>('/api/v1/parties', { preHandler: readers }, async (req) => searchParties(pool, req.query.q?.slice(0, 80), req.query.all === '1'));
  app.get<{ Params: { id: string }; Querystring: { all?: string } }>('/api/v1/parties/:id', { preHandler: readers }, async (req) => getParty(pool, req.params.id, req.query.all === '1'));
  app.post('/api/v1/parties', { preHandler: office, schema: { body: obj } }, async (req, reply) => reply.code(201).send(await createParty(pool, actorOf(req.auth!), (req.body ?? {}) as Record<string, unknown>)));
  app.patch<{ Params: { id: string } }>('/api/v1/parties/:id', { preHandler: office, schema: { body: obj } }, async (req) => updateParty(pool, actorOf(req.auth!), req.params.id, (req.body ?? {}) as Record<string, unknown>));
  app.post<{ Params: { id: string } }>('/api/v1/parties/:id/sites', { preHandler: office, schema: { body: obj } }, async (req, reply) => reply.code(201).send(await createSite(pool, actorOf(req.auth!), req.params.id, (req.body ?? {}) as Record<string, unknown>)));
  app.patch<{ Params: { id: string } }>('/api/v1/sites/:id', { preHandler: office, schema: { body: obj } }, async (req) => updateSite(pool, actorOf(req.auth!), req.params.id, (req.body ?? {}) as Record<string, unknown>));

  // Ficha del conductor (datos personales): solo administrador y oficina; DNI, Seguridad Social e IBAN cifrados, enmascarados y con consulta auditada.
  app.get<{ Params: { id: string } }>('/api/v1/users/:id/profile', { preHandler: office }, async (req, reply) => reply.header('Cache-Control', 'no-store').send(await getProfile(pool, actorOf(req.auth!), req.params.id)));
  app.put<{ Params: { id: string } }>('/api/v1/users/:id/profile', { preHandler: office, schema: { body: obj } }, async (req, reply) => reply.header('Cache-Control', 'no-store').send(await saveProfile(pool, actorOf(req.auth!), req.params.id, (req.body ?? {}) as Record<string, unknown>)));
  app.post<{ Params: { id: string } }>('/api/v1/users/:id/profile/reveal', { preHandler: office, schema: { body: obj }, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) =>
    reply.header('Cache-Control', 'no-store').send(await revealField(pool, actorOf(req.auth!), req.params.id, ((req.body ?? {}) as Record<string, unknown>).field)));
  app.post('/api/v1/iban/check', { preHandler: office, schema: { body: obj } }, async (req) => ibanPreview(((req.body ?? {}) as Record<string, unknown>).iban));

  // Control interno de documentos con caducidad (conductores, vehículos, empresa) y tarjetas/dispositivos de vehículo.
  app.get('/api/v1/documents/catalog', { preHandler: readers }, async () => catalog(pool));
  app.get<{ Querystring: { user_id?: string; vehicle_id?: string; company?: string; all?: string } }>('/api/v1/documents', { preHandler: readers }, async (req) => listDocuments(pool, req.query));
  app.post('/api/v1/documents', { preHandler: office, schema: { body: obj } }, async (req, reply) => reply.code(201).send(await createDocument(pool, actorOf(req.auth!), (req.body ?? {}) as Record<string, unknown>)));
  app.patch<{ Params: { id: string } }>('/api/v1/documents/:id', { preHandler: office, schema: { body: obj } }, async (req) => updateDocument(pool, actorOf(req.auth!), req.params.id, (req.body ?? {}) as Record<string, unknown>));
  app.get<{ Params: { id: string }; Querystring: { all?: string } }>('/api/v1/vehicles/:id/assets', { preHandler: readers }, async (req) => listAssets(pool, req.params.id, req.query.all === '1'));
  app.post<{ Params: { id: string } }>('/api/v1/vehicles/:id/assets', { preHandler: office, schema: { body: obj } }, async (req, reply) => reply.code(201).send(await createAsset(pool, actorOf(req.auth!), req.params.id, (req.body ?? {}) as Record<string, unknown>)));
  app.patch<{ Params: { id: string } }>('/api/v1/assets/:id', { preHandler: office, schema: { body: obj } }, async (req) => updateAsset(pool, actorOf(req.auth!), req.params.id, (req.body ?? {}) as Record<string, unknown>));
  app.post<{ Params: { id: string } }>('/api/v1/assets/:id/reveal-pin', { preHandler: office, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) =>
    reply.header('Cache-Control', 'no-store').send(await revealPin(pool, actorOf(req.auth!), req.params.id)));
  app.get<{ Querystring: { days?: string } }>('/api/v1/expiries', { preHandler: readers }, async (req) => {
    const d = req.query.days === undefined ? undefined : Number(req.query.days);
    if (d !== undefined && (!Number.isInteger(d) || d < 0 || d > 365)) throw bad('days');
    return listExpiries(pool, { days: d });
  });
  // Aviso (no bloquea) al preparar un transporte: documentos caducados o próximos a caducar del conductor y de los vehículos elegidos.
  app.get<{ Querystring: { driver_id?: string; tractor_id?: string; trailer_id?: string } }>('/api/v1/expiries/check', { preHandler: office }, async (req) => {
    const ids = [req.query.driver_id, req.query.tractor_id, req.query.trailer_id].filter((x): x is string => !!x);
    if (ids.some((x) => !UUID_RE.test(x))) throw bad('driver_id');
    return listExpiries(pool, { driverId: req.query.driver_id ?? null, vehicleIds: [req.query.tractor_id, req.query.trailer_id].filter((x): x is string => !!x) });
  });

  // Reemisión con la dirección actual (administrador): PDF/QR nuevos; el anterior se conserva como sustituido.
  const REISSUED = 'DeCA reemitido: el QR ha cambiado, usa el nuevo';
  const transportsOf = async (decaIds: string[]): Promise<string[]> => decaIds.length
    ? (await pool.query('SELECT DISTINCT transport_id FROM deca_transport WHERE deca_id = ANY($1::uuid[])', [decaIds])).rows.map((r) => r.transport_id as string) : [];
  app.post<{ Params: { id: string } }>('/api/v1/admin/decas/:id/reissue', { preHandler: admin, schema: { body: obj } }, async (req, reply) => {
    const r = await reissueDeca(pool, storage, actorOf(req.auth!), req.params.id, ((req.body ?? {}) as Record<string, unknown>).reason);
    for (const t of await transportsOf([req.params.id])) tell(t, 'UPDATED', REISSUED);
    return reply.code(201).send(r);
  });
  app.post('/api/v1/admin/decas/reissue-outdated', { preHandler: admin, schema: { body: obj } }, async (req) => {
    const r = await reissueOutdated(pool, storage, actorOf(req.auth!), ((req.body ?? {}) as Record<string, unknown>).reason);
    for (const t of await transportsOf(r.reissued_ids)) tell(t, 'UPDATED', REISSUED);
    return { reissued: r.reissued, failed: r.failed, total: r.total };
  });

  // QR de oficina: sale de la URL con la que se emitió el PDF (idéntica a la de su QR).
  app.get<{ Params: { id: string } }>('/api/v1/decas/:id/qr.svg', { preHandler: readers }, async (req, reply) => {
    const svg = UUID_RE.test(req.params.id) ? await decaQrSvg(pool, req.params.id) : null;
    return svg ? reply.type('image/svg+xml').header('Cache-Control', 'private, no-store').send(svg) : reply.code(404).send({ error: 'no_encontrado' });
  });
}
