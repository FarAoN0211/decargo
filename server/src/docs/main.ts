import { createServer } from 'node:http';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { DOCUMENTS_DIR } from '../common/config';
import { createPool } from '../common/db';
import { LocalStorage } from '../common/storage';
import { TOKEN_RE, tokenHash } from '../common/token';

/**
 * Servicio documental PÚBLICO y de SOLO LECTURA (D-02).
 *  - Única ruta: GET /d/<token>. Cualquier otra ruta o método → el mismo 404.
 *  - Rol de BD `deca_docs`: solo puede leer la vista docs_resolve. No escribe nada.
 *  - Volumen de documentos montado en solo lectura.
 *  - Respuesta: PDF directo, sin redirecciones, sin cookies, sin páginas intermedias (RES tercero.3 y tercero.4).
 *  - Token desconocido, mal formado o desactivado → 404 idéntico. El token NUNCA se registra.
 * El estado de salud va por un puerto interno distinto que no se publica.
 */
const pool = createPool(5);
const storage = new LocalStorage(DOCUMENTS_DIR);

function log(result: string, ref?: string): void {
  console.log(JSON.stringify({ t: new Date().toISOString(), ev: 'doc_access', result, ref }));
}

const app = Fastify({ logger: false, disableRequestLogging: true, exposeHeadRoutes: false });
const NOT_FOUND = 'Not found';

app.setNotFoundHandler((_req, reply) => reply.code(404).type('text/plain; charset=utf-8').send(NOT_FOUND));
app.setErrorHandler((err: unknown, _req, reply) => {
  const e = err as { statusCode?: number; message?: string };
  if (e.statusCode === 429) return reply.code(429).type('text/plain; charset=utf-8').send('Too many requests');
  console.error(JSON.stringify({ t: new Date().toISOString(), ev: 'error', msg: e.message }));
  return reply.code(503).type('text/plain; charset=utf-8').send('Service unavailable');
});

async function start(): Promise<void> {
// El plugin debe estar cargado ANTES de declarar la ruta, o su configuración no se aplica.
await app.register(rateLimit, { global: false });

app.get<{ Params: { token: string } }>(
  '/d/:token',
  { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } },
  async (req, reply) => {
    const { token } = req.params;
    if (!TOKEN_RE.test(token)) { log('malformed'); return reply.code(404).type('text/plain; charset=utf-8').send(NOT_FOUND); }
    const h = tokenHash(token);
    const r = await pool.query('SELECT file_key, sha256, servable FROM docs_resolve WHERE token_hash = $1', [h]);
    const row = r.rows[0];
    if (!row || !row.servable) { log(row ? 'inactive' : 'unknown', h.slice(0, 8)); return reply.code(404).type('text/plain; charset=utf-8').send(NOT_FOUND); }
    const pdf = await storage.getVerified(row.file_key, row.sha256);   // verifica el hash en cada descarga
    log('ok', h.slice(0, 8));
    return reply
      .code(200)
      .type('application/pdf')
      .header('Content-Disposition', 'inline; filename="DeCA.pdf"')
      .header('Content-Length', pdf.length)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', 'private, no-store')
      .header('X-Robots-Tag', 'noindex, nofollow')
      .header('Referrer-Policy', 'no-referrer')
      .send(pdf);
  }
);

// Salud: solo localhost dentro del contenedor, puerto distinto del público.
createServer(async (req, res) => {
  if (req.url !== '/healthz') { res.writeHead(404).end(); return; }
  try {
    await pool.query('SELECT 1 FROM docs_resolve LIMIT 1');
    if (!(await storage.canRead())) throw new Error('almacén no legible');
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}');
  } catch {
    res.writeHead(503, { 'content-type': 'application/json' }).end('{"status":"error"}');
  }
}).listen(9001, '127.0.0.1');

await app.listen({ host: '0.0.0.0', port: 8081 });
}

start().catch((e) => { console.error(e); process.exit(1); });
