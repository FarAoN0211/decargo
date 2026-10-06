import type { Pool } from 'pg';
import { appendAudit } from '../common/audit';
import { Actor, ApiError, actorStr } from '../identity/service';
import { UUID_RE, bad, plate } from './validate';

export const VEHICLE_KINDS = ['TRACTORA', 'SEMIRREMOLQUE', 'REMOLQUE', 'RIGIDO'] as const;
const isKind = (k: unknown): k is (typeof VEHICLE_KINDS)[number] => typeof k === 'string' && (VEHICLE_KINDS as readonly string[]).includes(k);

export async function listVehicles(pool: Pool, f: { active?: boolean; kinds?: string[] }) {
  return (await pool.query(
    `SELECT v.id, v.plate_display AS plate, v.kind, v.active, v.created_at,
            EXISTS (SELECT 1 FROM transport_vehicle_assignment a WHERE a.tractor_id = v.id OR a.trailer_id = v.id) AS in_use
     FROM vehicle v WHERE ($1::boolean IS NULL OR v.active = $1) AND ($2::text[] IS NULL OR v.kind = ANY($2))
     ORDER BY CASE v.kind WHEN 'TRACTORA' THEN 1 WHEN 'SEMIRREMOLQUE' THEN 2 WHEN 'RIGIDO' THEN 3 ELSE 4 END, v.plate_display`, [f.active ?? null, f.kinds ?? null])).rows;   // tractoras, semirremolques, camión rígido, remolques
}

export async function getVehicle(pool: Pool, id: string) {
  if (!UUID_RE.test(id)) throw new ApiError(404, 'no_encontrado');
  const v = (await pool.query(
    `SELECT v.id, v.plate_display AS plate, v.kind, v.active, v.created_at,
            EXISTS (SELECT 1 FROM transport_vehicle_assignment a WHERE a.tractor_id = v.id OR a.trailer_id = v.id) AS in_use
     FROM vehicle v WHERE v.id = $1`, [id])).rows[0];
  if (!v) throw new ApiError(404, 'no_encontrado');
  return v;
}

export async function createVehicle(pool: Pool, actor: Actor, input: { plate: unknown; kind: unknown }) {
  const p = plate(input.plate);
  if (!isKind(input.kind)) throw bad('kind');
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const co = (await c.query('SELECT id FROM company ORDER BY created_at LIMIT 1')).rows[0];
    if (!co) throw new ApiError(409, 'no_company');
    let v;
    try {
      v = (await c.query('INSERT INTO vehicle (company_id, plate_norm, plate_display, kind) VALUES ($1,$2,$3,$4) RETURNING id', [co.id, p.norm, p.display, input.kind])).rows[0];
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new ApiError(409, 'plate_taken');
      throw e;
    }
    await appendAudit(c, { company_id: co.id, at: new Date(), actor: actorStr(actor), action: 'VEHICLE_CREATED', entity: 'vehicle', entity_id: v.id, before: null, after: { plate: p.display, kind: input.kind }, reason: null });
    await c.query('COMMIT');
    return { id: v.id, plate: p.display, kind: input.kind };
  } catch (e) { try { await c.query('ROLLBACK'); } catch { /* */ } throw e; } finally { c.release(); }
}

/**
 * Datos administrativos modificables: matrícula y tipo SOLO mientras el vehículo no se haya asignado nunca a un transporte
 * (corrección de un error de alta); el estado activo/inactivo siempre. Una matrícula usada en un DeCA no se reescribe.
 */
export async function updateVehicle(pool: Pool, actor: Actor, id: string, patch: { plate?: unknown; kind?: unknown; active?: unknown }) {
  if (!UUID_RE.test(id)) throw new ApiError(404, 'no_encontrado');
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const v = (await c.query('SELECT id, company_id, plate_display, plate_norm, kind, active FROM vehicle WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!v) throw new ApiError(404, 'no_encontrado');
    const next = { plate_display: v.plate_display, plate_norm: v.plate_norm, kind: v.kind, active: v.active };
    if (patch.plate !== undefined) { const p = plate(patch.plate); next.plate_display = p.display; next.plate_norm = p.norm; }
    if (patch.kind !== undefined) { if (!isKind(patch.kind)) throw bad('kind'); next.kind = patch.kind; }
    if (patch.active !== undefined) { if (typeof patch.active !== 'boolean') throw bad('active'); next.active = patch.active; }
    const identityChanged = next.plate_norm !== v.plate_norm || next.kind !== v.kind;
    if (identityChanged) {
      const used = (await c.query('SELECT 1 FROM transport_vehicle_assignment WHERE tractor_id = $1 OR trailer_id = $1 LIMIT 1', [id])).rowCount;
      if (used) throw new ApiError(409, 'vehicle_in_use');
    }
    try {
      await c.query('UPDATE vehicle SET plate_display = $2, plate_norm = $3, kind = $4, active = $5 WHERE id = $1', [id, next.plate_display, next.plate_norm, next.kind, next.active]);
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new ApiError(409, 'plate_taken');
      throw e;
    }
    await appendAudit(c, { company_id: v.company_id, at: new Date(), actor: actorStr(actor), action: 'VEHICLE_UPDATED', entity: 'vehicle', entity_id: id,
      before: { plate: v.plate_display, kind: v.kind, active: v.active }, after: { plate: next.plate_display, kind: next.kind, active: next.active }, reason: null });
    await c.query('COMMIT');
  } catch (e) { try { await c.query('ROLLBACK'); } catch { /* */ } throw e; } finally { c.release(); }
}
