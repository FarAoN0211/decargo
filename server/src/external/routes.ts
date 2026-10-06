import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { LocalStorage } from '../common/storage';
import { guard } from '../identity/routes';
import type { Actor, AuthContext } from '../identity/service';
import type { SafeFetcher } from './fetcher';
import { addExternalDeca, driverExternalList, driverExternalPdf, externalPdf, listExternal, reviewExternal } from './service';

const actorOf = (a: AuthContext): Actor => ({ kind: 'user', userId: a.userId, role: a.role });

export function registerExternalRoutes(app: FastifyInstance, pool: Pool, storage: LocalStorage, fetcher: SafeFetcher): void {
  // Conductor: también con dispositivo PENDIENTE (decisión del propietario), con cuotas, descargador anti-SSRF y revisión posterior.
  app.post('/api/v1/driver/external-deca', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    preHandler: guard(pool, { roles: ['conductor'] }),
    schema: { body: { type: 'object', required: ['transport_id', 'url'], additionalProperties: false,
      properties: { transport_id: { type: 'string', maxLength: 36 }, url: { type: 'string', maxLength: 2048 } } } }
  }, async (req, reply) => {
    const b = req.body as { transport_id: string; url: string };
    return reply.code(201).send(await addExternalDeca(pool, storage, fetcher, req.auth!, { transportId: b.transport_id, url: b.url }));
  });

  app.get<{ Params: { id: string } }>('/api/v1/driver/transports/:id/external-decas', { preHandler: guard(pool, { roles: ['conductor'] }) },
    async (req) => driverExternalList(pool, req.auth!, req.params.id));
  app.get<{ Params: { id: string } }>('/api/v1/driver/external-decas/:id/pdf', { preHandler: guard(pool, { roles: ['conductor'] }) }, async (req, reply) => {
    const pdf = await driverExternalPdf(pool, storage, req.auth!, req.params.id);
    return pdf ? reply.type('application/pdf').header('Cache-Control', 'private, no-store').send(pdf) : reply.code(404).send({ error: 'no_encontrado' });
  });

  // Oficina
  const readers = guard(pool, { roles: ['admin', 'oficina', 'solo_lectura'], full: true });
  const office = guard(pool, { roles: ['admin', 'oficina'], full: true });
  app.get<{ Querystring: { status?: string } }>('/api/v1/external-decas', { preHandler: readers }, async (req) => listExternal(pool, req.query.status));
  app.get<{ Params: { id: string } }>('/api/v1/external-decas/:id/pdf', { preHandler: readers }, async (req, reply) => {
    const pdf = await externalPdf(pool, storage, req.params.id);
    return pdf ? reply.type('application/pdf').header('Cache-Control', 'private, no-store').send(pdf) : reply.code(404).send({ error: 'no_encontrado' });
  });
  app.post<{ Params: { id: string } }>('/api/v1/external-decas/:id/review', { preHandler: office, schema: { body: { type: 'object', additionalProperties: false, properties: { notes: { type: 'string', maxLength: 1000 } } } } },
    async (req, reply) => { await reviewExternal(pool, actorOf(req.auth!), req.params.id, (req.body as { notes?: string } | undefined)?.notes); return reply.code(204).send(); });
}
