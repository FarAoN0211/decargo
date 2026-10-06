import { Pool } from 'pg';
import { appendAudit } from './common/audit';
import { DOCUMENTS_DIR, optional, required } from './common/config';
import { testMode } from './common/settings';
import { LocalStorage } from './common/storage';

/**
 * Mantenimiento con el superusuario de la base de datos (servicio `maint`, perfil tools). La API NO puede borrar nada; esto sí,
 * y solo cuando el administrador del servidor lo ejecuta a mano:  ./deca purge-examples
 *
 * purge-examples: elimina TODOS los transportes, DeCA (y sus PDF), vehículos, DeCA externos, avisos push y usuarios que no son
 * administradores. Se conservan: administradores (con sus dispositivos y TOTP), datos de la empresa, ajustes y el registro de auditoría
 * (que es inmutable y recibe una anotación con lo borrado).
 */
async function purgeExamples(force: boolean): Promise<void> {
  const pool = new Pool({ host: optional('DB_HOST', 'db'), database: optional('DB_NAME', 'decargo'), user: 'postgres', password: required('POSTGRES_PASSWORD'), max: 1 });
  const storage = new LocalStorage(DOCUMENTS_DIR);
  const c = await pool.connect();
  try {
    // Seguro: con el modo de pruebas desactivado los DeCA pueden ser reales (conservación legal ≥ 1 año). Hace falta pedirlo expresamente.
    if (!(await testMode(c)) && !force) {
      console.error('RECHAZADO: el modo de pruebas está desactivado, así que puede haber DeCA reales (hay que conservarlos al menos un año). Si de verdad quieres borrarlo todo: ./deca purge-examples --yes --also-real');
      process.exit(3);
    }
    await c.query('BEGIN');
    await c.query("SET LOCAL session_replication_role = replica");   // la versión de DeCA es inmutable por trigger; esta purga es la única excepción
    const co = (await c.query('SELECT id FROM company ORDER BY created_at LIMIT 1')).rows[0];
    const keys = (await c.query(`SELECT file_key AS k FROM deca_version UNION SELECT file_key FROM external_deca`)).rows.map((r) => r.k as string);
    const n: Record<string, number> = {};
    const del = async (label: string, sql: string): Promise<void> => { n[label] = (await c.query(sql)).rowCount ?? 0; };
    await del('push_event', 'DELETE FROM push_event');
    await del('push_subscription', 'DELETE FROM push_subscription');
    await del('external_fetch_log', 'DELETE FROM external_fetch_log');
    await del('external_deca', 'DELETE FROM external_deca');
    await del('deca_transport', 'DELETE FROM deca_transport');
    await del('deca_version', 'DELETE FROM deca_version');
    await del('deca', 'DELETE FROM deca');
    await del('transport_driver_assignment', 'DELETE FROM transport_driver_assignment');
    await del('transport_vehicle_assignment', 'DELETE FROM transport_vehicle_assignment');
    await del('transport', 'DELETE FROM transport');
    await del('party_site', 'DELETE FROM party_site');
    await del('party', 'DELETE FROM party');
    await del('driver_profile', `DELETE FROM driver_profile WHERE user_id IN (SELECT id FROM app_user WHERE role <> 'admin')`);
    await del('vehicle_asset', 'DELETE FROM vehicle_asset');
    await del('control_document', `DELETE FROM control_document WHERE subject_kind = 'VEHICLE' OR user_id IN (SELECT id FROM app_user WHERE role <> 'admin')`);
    await del('vehicle', 'DELETE FROM vehicle');
    await del('login_throttle', 'DELETE FROM login_throttle');
    const gone = `SELECT id FROM app_user WHERE role <> 'admin'`;
    await del('refresh_token', `DELETE FROM refresh_token WHERE session_id IN (SELECT id FROM session WHERE user_id IN (${gone}))`);
    await del('session', `DELETE FROM session WHERE user_id IN (${gone})`);
    await del('device', `DELETE FROM device WHERE user_id IN (${gone})`);
    await del('activation_token', `DELETE FROM activation_token WHERE user_id IN (${gone})`);
    await del('app_user', `DELETE FROM app_user WHERE role <> 'admin'`);
    await appendAudit(c, { company_id: co?.id ?? null, at: new Date(), actor: 'cli', action: 'EXAMPLE_DATA_PURGED', entity: 'system', entity_id: 'purge-examples', before: null, after: n, reason: 'Eliminación de datos de ejemplo' });
    await c.query('COMMIT');
    let files = 0;
    for (const k of keys) if (await storage.remove(k)) files++;
    console.log(JSON.stringify({ purged: n, files_removed: files }, null, 2));
  } catch (e) { try { await c.query('ROLLBACK'); } catch { /* */ } console.error('ERROR purge-examples:', (e as Error).message); process.exit(2); }
  finally { c.release(); await pool.end(); }
}

const cmd = process.argv[2];
if (cmd === 'purge-examples') purgeExamples(process.argv.includes('--also-real')).catch((e) => { console.error(e); process.exit(2); });
else { console.error('uso: node dist/maint.js purge-examples [--also-real]'); process.exit(2); }
