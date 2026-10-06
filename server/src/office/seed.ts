import type { Pool } from 'pg';
import { LocalStorage } from '../common/storage';
import { randomInt } from 'node:crypto';
import { Actor, createUser, setInitialPassword } from '../identity/service';
import { createTransport } from './transports';
import { createVehicle } from './vehicles';

/**
 * Seed de DESARROLLO, explícito (`./deca seed-dev`) y re-ejecutable. El repositorio NO contiene contraseñas: cada una se genera al azar
 * al ejecutar el seed, se guarda solo como hash Argon2id y se devuelve UNA vez (el script la escribe en un fichero local con permisos 600).
 * Los usuarios reales de DECARGO se activan con código de un solo uso; esto es un atajo solo para datos de desarrollo.
 */
const ACTOR: Actor = { kind: 'cli' };
const MARK = '[DESARROLLO]';
const USERS = [
  { username: 'admin.dev', full_name: 'Administrador (desarrollo)', role: 'admin' },
  { username: 'oficina.dev', full_name: 'Oficina (desarrollo)', role: 'oficina' },
  { username: 'conductor1.dev', full_name: 'Conductor Uno (desarrollo)', role: 'conductor' },
  { username: 'conductor2.dev', full_name: 'Conductor Dos (desarrollo)', role: 'conductor' }
];
const VEHICLES = [
  { plate: '1111 AAA', kind: 'TRACTORA' }, { plate: '2222 BBB', kind: 'TRACTORA' }, { plate: '3333 CCC', kind: 'RIGIDO' },
  { plate: 'R1111AAA', kind: 'SEMIRREMOLQUE' }, { plate: 'R2222BBB', kind: 'SEMIRREMOLQUE' }
];
const day = (plus: number): string => new Date(Date.now() + plus * 86400_000).toISOString().slice(0, 10);

const ALPHA = 'abcdefghjkmnpqrstuvwxyz23456789';      // sin caracteres ambiguos (i, l, o, 0, 1)
function randomPassword(): string {
  const g = (): string => Array.from({ length: 4 }, () => ALPHA[randomInt(ALPHA.length)]).join('');
  return `${g()}-${g()}-${g()}-${g()}`;                // 16 caracteres al azar (~80 bits)
}

export async function seedDev(pool: Pool, storage: LocalStorage, opts: { resetPasswords?: boolean } = {}) {
  const credentials: Record<string, string | null> = {};
  const created: string[] = [];

  for (const u of USERS) {
    const ex = (await pool.query('SELECT id, password_hash IS NULL AS pending FROM app_user WHERE lower(username) = $1', [u.username])).rows[0];
    if (!ex) {
      const r = await createUser(pool, ACTOR, { username: u.username, fullName: u.full_name, role: u.role },
        { name: 'DECARGO · empresa de desarrollo S.L.', nif: 'B00000000', address: 'Calle de desarrollo 1, 04000 Almería' });
      credentials[u.username] = randomPassword(); await setInitialPassword(pool, ACTOR, r.id, credentials[u.username]!); created.push(`usuario ${u.username}`);
    } else if (ex.pending || opts.resetPasswords) {
      credentials[u.username] = randomPassword(); await setInitialPassword(pool, ACTOR, ex.id, credentials[u.username]!);   // sin contraseña o reinicio pedido
    } else credentials[u.username] = null;                                                                                    // ya tiene: no se puede recuperar
  }

  for (const v of VEHICLES) {
    try { await createVehicle(pool, ACTOR, v); created.push(`vehículo ${v.plate}`); } catch (e) { if ((e as { code?: string }).code !== 'plate_taken') throw e; }
  }

  const exists = (await pool.query(`SELECT count(*)::int AS n FROM transport WHERE remarks LIKE $1`, [`${MARK}%`])).rows[0].n;
  if (exists === 0) {
    const id = async (sql: string, p: string): Promise<string> => (await pool.query(sql, [p])).rows[0].id;
    const drv = (n: string): Promise<string> => id(`SELECT id FROM app_user WHERE lower(username) = $1`, n);
    const veh = (p: string): Promise<string> => id(`SELECT id FROM vehicle WHERE plate_norm = $1`, p);
    const [c1, c2] = [await drv('conductor1.dev'), await drv('conductor2.dev')];
    const base = { shipper_name: 'Cargador de desarrollo S.A.', shipper_nif: 'A00000000', shipper_address: 'Polígono de desarrollo, nave 2, 04700 El Ejido (Almería)' };
    const jobs = [
      { ...base, origin: 'Almacén de desarrollo, El Ejido (Almería)', destination: 'Centro logístico de desarrollo, Roquetas de Mar (Almería)', cargo: 'Hortalizas frescas en palets', weight_kg: 12450,
        transport_date: day(0), driver_id: c1, tractor_id: await veh('1111AAA'), trailer_id: await veh('R1111AAA'), remarks: `${MARK} Transporte actual del conductor 1.` },
      { ...base, origin: 'Centro logístico de desarrollo, Roquetas de Mar (Almería)', destination: 'Plataforma de desarrollo, Almería capital', cargo: 'Cajas de fruta paletizadas', weight_kg: 8300,
        transport_date: day(1), driver_id: c1, tractor_id: await veh('1111AAA'), trailer_id: await veh('R1111AAA'), remarks: `${MARK} Siguiente transporte del conductor 1.` },
      { ...base, origin: 'Almacén de desarrollo, Níjar (Almería)', destination: 'Mercado de desarrollo, Murcia', cargo: 'Tomates en cajas', weight_kg: 15200,
        transport_date: day(0), driver_id: c2, tractor_id: await veh('2222BBB'), trailer_id: await veh('R2222BBB'), remarks: `${MARK} Transporte del conductor 2 (para probar el aislamiento).` },
      { ...base, origin: 'Almacén de desarrollo, Vícar (Almería)', destination: 'Cooperativa de desarrollo, Adra (Almería)', cargo: 'Material de embalaje', weight_kg: 4100,
        transport_date: day(2), tractor_id: await veh('3333CCC'), remarks: `${MARK} Sin conductor asignado todavía.` }
    ];
    for (const j of jobs) { const r = await createTransport(pool, storage, ACTOR, j); created.push(`transporte ${r.id.slice(0, 8)} con DeCA`); }
  }
  return { created, credentials };
}
