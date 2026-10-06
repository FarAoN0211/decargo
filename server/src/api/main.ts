import { timingSafeEqual } from 'node:crypto';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { DOCUMENTS_DIR, optional, required } from '../common/config';
import { createPool } from '../common/db';
import { devEndpoints } from '../common/settings';
import { LocalStorage } from '../common/storage';
import { SafeFetcher } from '../external/fetcher';
import { registerExternalRoutes } from '../external/routes';
import { registerIdentityRoutes } from '../identity/routes';
import { registerOfficeRoutes } from '../office/routes';
import { createTestDeca } from './deca-service';

/**
 * API privada. Autenticación por sesión (access token corto + refresh rotatorio); la autorización se comprueba SIEMPRE en el
 * servidor. Solo publica en 127.0.0.1. El endpoint /api/v1/dev/test-deca es de PRUEBA (clave DEV_API_KEY, DEV_ENDPOINTS=1).
 */
const pool = createPool(10);
const storage = new LocalStorage(DOCUMENTS_DIR);
// Solo se confía en X-Forwarded-For si la conexión llega desde una de estas redes (la red interna donde vive el servicio `web`).
// Vacío = no se confía en nadie (se usa la IP de la conexión). Quien llame directamente al puerto publicado no puede falsear su IP.
const trusted = optional('TRUSTED_PROXY_CIDRS', '').split(',').map((x) => x.trim()).filter(Boolean);
const app = Fastify({ logger: { level: 'info', redact: ['req.headers.authorization'] }, bodyLimit: 16 * 1024, trustProxy: trusted.length ? trusted : false });

async function start(): Promise<void> {
  await app.register(rateLimit, { global: false });   // antes de declarar rutas (si no, no se aplica)

  app.get('/healthz', async (_req, reply) => {
    try {
      await pool.query('SELECT 1');
      if (!(await storage.canWrite())) throw new Error('almacén no escribible');
      return { status: 'ok' };
    } catch (e) {
      reply.code(503);
      return { status: 'error', detail: (e as Error).message };
    }
  });

  registerIdentityRoutes(app, pool, storage);
  registerOfficeRoutes(app, pool, storage);
  registerExternalRoutes(app, pool, storage, new SafeFetcher());   // límites y defensas por defecto (estrictos)

  // Endpoint de PRUEBA: siempre registrado, pero responde 404 salvo que esté activado (Configuración en la web o DEV_ENDPOINTS) y exige la clave DEV_API_KEY.
  const devKey = Buffer.from(optional('DEV_API_KEY', ''));
  app.post('/api/v1/dev/test-deca', {
    preHandler: async (req, reply) => {
      if (!devKey.length || !(await devEndpoints(pool))) { await reply.code(404).send({ error: 'no_encontrado' }); return; }
      const got = Buffer.from((req.headers.authorization ?? '').replace(/^Bearer /, ''));
      if (got.length !== devKey.length || !timingSafeEqual(got, devKey)) await reply.code(401).send({ error: 'no_autorizado' });
    }
  }, async (_req, reply) => reply.code(201).send(await createTestDeca(pool, storage)));

  await app.listen({ host: '0.0.0.0', port: 8080 });
}

start().catch((e) => { console.error(e); process.exit(1); });
