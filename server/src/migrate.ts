import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { Client } from 'pg';
import { optional, required } from './common/config';

/**
 * Ejecutor de migraciones. Conecta como superusuario (solo este proceso puntual lo hace).
 *   node dist/migrate.js               → asegura roles, aplica migraciones pendientes, reaplica permisos
 *   node dist/migrate.js ensure-roles  → solo crea/actualiza roles (antes de restaurar un dump)
 * Las migraciones aplicadas son inmutables: si el checksum de una cambia, se aborta.
 */
const ROLES: { name: string; passwordVar: string }[] = [
  { name: 'deca_api', passwordVar: 'DB_API_PASSWORD' },
  { name: 'deca_docs', passwordVar: 'DB_DOCS_PASSWORD' },
  { name: 'deca_backup', passwordVar: 'DB_BACKUP_PASSWORD' }
];

async function connect(): Promise<Client> {
  const c = new Client({
    host: optional('DB_HOST', 'db'),
    port: Number(optional('DB_PORT', '5432')),
    database: optional('DB_NAME', 'decargo'),
    user: 'postgres',
    password: required('POSTGRES_PASSWORD')
  });
  await c.connect();
  return c;
}

async function ensureRoles(c: Client): Promise<void> {
  const db = optional('DB_NAME', 'decargo');
  for (const r of ROLES) {
    const pwd = c.escapeLiteral(required(r.passwordVar));
    const id = c.escapeIdentifier(r.name);
    const exists = await c.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [r.name]);
    await c.query(exists.rowCount ? `ALTER ROLE ${id} LOGIN PASSWORD ${pwd}` : `CREATE ROLE ${id} LOGIN PASSWORD ${pwd}`);
  }
  await c.query(`REVOKE ALL ON DATABASE ${c.escapeIdentifier(db)} FROM PUBLIC`);
  for (const r of ROLES) {
    await c.query(`GRANT CONNECT ON DATABASE ${c.escapeIdentifier(db)} TO ${c.escapeIdentifier(r.name)}`);
  }
  console.log('roles OK:', ROLES.map((r) => r.name).join(', '));
}

async function migrate(c: Client): Promise<void> {
  const dir = path.join(__dirname, '..', 'migrations');
  await c.query('SELECT pg_advisory_lock(7000)');
  await c.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
  const files = (await fs.readdir(dir)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
  for (const f of files) {
    const sql = await fs.readFile(path.join(dir, f), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const done = await c.query('SELECT checksum FROM schema_migrations WHERE version = $1', [f]);
    if (done.rowCount) {
      if (done.rows[0].checksum !== checksum) throw new Error(`La migración ${f} ya aplicada ha cambiado (checksum). Abortando.`);
      continue;
    }
    console.log('aplicando', f);
    await c.query('BEGIN');
    try {
      await c.query(sql);
      await c.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1,$2)', [f, checksum]);
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    }
  }
  await c.query(await fs.readFile(path.join(dir, 'grants.sql'), 'utf8'));
  console.log('migraciones y permisos OK');
}

async function main(): Promise<void> {
  const c = await connect();
  try {
    await ensureRoles(c);
    if (process.argv[2] !== 'ensure-roles') await migrate(c);
  } finally {
    await c.end();
  }
}

main().catch((e) => { console.error('ERROR migrate:', e.message); process.exit(1); });
