import type { Pool } from 'pg';
import { LocalStorage } from '../common/storage';
import type { DecaData } from '../pdf/deca-pdf';
import { issueDeca } from './deca-core';

/**
 * Datos de PRUEBA (ficticios y marcados como tales). En el primer bloque no hay interfaz ni usuarios:
 * este servicio solo existe para demostrar el flujo vertical y se desactiva con DEV_ENDPOINTS=0.
 */
export async function createTestDeca(pool: Pool, storage: LocalStorage) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let company = (await client.query('SELECT id, name, nif, address FROM company ORDER BY created_at LIMIT 1')).rows[0];
    if (!company) {
      company = (await client.query(
        `INSERT INTO company (name, nif, address) VALUES ($1,$2,$3) RETURNING id, name, nif, address`,
        ['TRANSPORTES DE PRUEBA DECARGO S.L.', 'B00000000', 'Calle de Prueba 1, 04000 Almería']
      )).rows[0];
    }

    const vehicle = async (plateNorm: string, display: string, kind: string): Promise<string> => {
      await client.query(
        `INSERT INTO vehicle (company_id, plate_norm, plate_display, kind) VALUES ($1,$2,$3,$4)
         ON CONFLICT (company_id, plate_norm) DO NOTHING`, [company.id, plateNorm, display, kind]);
      return (await client.query('SELECT id FROM vehicle WHERE company_id=$1 AND plate_norm=$2', [company.id, plateNorm])).rows[0].id;
    };
    const tractorId = await vehicle('0000BBB', '0000 BBB', 'TRACTORA');
    const trailerId = await vehicle('R0000BBB', 'R-0000-BBB', 'SEMIRREMOLQUE');

    const today = new Date().toISOString().slice(0, 10);
    const transport = (await client.query(
      `INSERT INTO transport (company_id, shipper_name, shipper_nif, shipper_address, carrier_name, carrier_nif,
         origin, destination, cargo_description, weight_kg, transport_date, remarks)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [company.id, 'CARGADOR DE PRUEBA S.A.', 'A00000000', 'Polígono de Prueba, nave 2, 04700 El Ejido',
       company.name, company.nif,
       JSON.stringify({ text: 'Almacén de prueba, El Ejido (Almería)' }),
       JSON.stringify({ text: 'Centro logístico de prueba, Roquetas de Mar (Almería)' }),
       'Hortalizas frescas en palets (datos de prueba)', '12450.00', today,
       'Documento generado para la prueba vertical de DECARGO.']
    )).rows[0];
    await client.query(
      `INSERT INTO transport_vehicle_assignment (transport_id, tractor_id, trailer_id, reason) VALUES ($1,$2,$3,$4)`,
      [transport.id, tractorId, trailerId, 'Asignación inicial (prueba)']);

    const data: DecaData = {
      shipper: { name: 'CARGADOR DE PRUEBA S.A.', nif: 'A00000000', address: 'Polígono de Prueba, nave 2, 04700 El Ejido' },
      carrier: { name: company.name, nif: company.nif },
      origin: 'Almacén de prueba, El Ejido (Almería)',
      destination: 'Centro logístico de prueba, Roquetas de Mar (Almería)',
      cargoDescription: 'Hortalizas frescas en palets (datos de prueba)',
      weightKg: '12450.00', altMagnitude: null, aecRef: null,
      transportDate: today, tractorPlate: '0000 BBB', trailerPlate: 'R-0000-BBB',
      remarks: 'Documento generado para la prueba vertical de DECARGO.'
    };
    const issued = await issueDeca(client, storage, { companyId: company.id, transportId: transport.id, data, actor: 'dev-endpoint', reason: 'prueba vertical', isTest: true });
    await client.query('COMMIT');
    return issued;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
