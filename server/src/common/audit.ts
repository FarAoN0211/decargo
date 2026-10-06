import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';

export interface AuditEntry {
  company_id: string | null;
  at: Date;
  actor: string;
  action: string;
  entity: string;
  entity_id: string;
  before: unknown;
  after: unknown;
  reason: string | null;
}

export const GENESIS = '0'.repeat(64);

/** JSON canónico: claves ordenadas, para que el hash sea reproducible. Solo cadenas, booleanos y enteros en `before`/`after`. */
export function stable(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(',')}}`;
}

export function auditHash(prev: string, e: AuditEntry): string {
  const body = stable({ ...e, at: e.at.toISOString() });
  return createHash('sha256').update(prev + body).digest('hex');
}

/** Añade una fila encadenada al registro de auditoría. Debe ejecutarse dentro de una transacción. */
export async function appendAudit(client: PoolClient, e: AuditEntry): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(7001)');
  const last = await client.query('SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1');
  const prev: string = last.rows[0]?.hash ?? GENESIS;
  const hash = auditHash(prev, e);
  await client.query(
    `INSERT INTO audit_log (company_id, at, actor, action, entity, entity_id, before, after, reason, prev_hash, hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [e.company_id, e.at, e.actor, e.action, e.entity, e.entity_id,
     JSON.stringify(e.before ?? null), JSON.stringify(e.after ?? null), e.reason, prev, hash]
  );
}
