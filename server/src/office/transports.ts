import type { Pool, PoolClient } from 'pg';
import QRCode from 'qrcode';
import { addDecaVersion, issueDeca } from '../api/deca-core';
import { appendAudit } from '../common/audit';
import { required } from '../common/config';
import { LocalStorage } from '../common/storage';
import { decryptToken } from '../common/token';
import { fullAddress, placeFrom } from './address';
import { getPublicBase, showDriverInDeca, testMode } from '../common/settings';
import { expiryCounts } from './documents';
import { registerForTransport, resolveStops } from './parties';
import type { DecaData } from '../pdf/deca-pdf';
import { buildDecaData } from '../pdf/data';
import { Actor, ApiError, actorStr } from '../identity/service';
import { UUID_RE, addrParts, bad, isoDate, nif, optMultiline, optText, optUuid, palletsLabel, palletsTotal, stops, stopsText, text, weightKg, type Stop } from './validate';

const MAIN_KINDS = ['TRACTORA', 'RIGIDO'];                 // vehículo principal: lleva la matrícula del DeCA (g)
const TRAILER_FOR: Record<string, string[]> = { TRACTORA: ['SEMIRREMOLQUE'], RIGIDO: ['REMOLQUE'] };

interface VehicleSel { tractor: { id: string; plate: string; kind: string } | null; trailer: { id: string; plate: string; kind: string } | null }

/** Comprueba que los vehículos existen, están activos y son compatibles (tractora + semirremolque, rígido + remolque). */
async function checkVehicles(c: PoolClient, tractorId: string | null, trailerId: string | null): Promise<VehicleSel> {
  const get = async (id: string, field: string) => {
    const v = (await c.query('SELECT id, plate_display AS plate, kind, active FROM vehicle WHERE id = $1', [id])).rows[0];
    if (!v || !v.active) throw bad(field);
    return v as { id: string; plate: string; kind: string };
  };
  const tractor = tractorId ? await get(tractorId, 'tractor_id') : null;
  if (tractor && !MAIN_KINDS.includes(tractor.kind)) throw bad('tractor_id');
  const trailer = trailerId ? await get(trailerId, 'trailer_id') : null;
  if (trailer && (!tractor || !(TRAILER_FOR[tractor.kind] ?? []).includes(trailer.kind))) throw bad('trailer_id');
  return { tractor, trailer };
}

interface TransportRow {
  shipper_name: string; shipper_nif: string; shipper_address: string; carrier_name: string; carrier_nif: string;
  origin: { text: string; stops?: Stop[] }; destination: { text: string; stops?: Stop[] }; cargo_description: string; weight_kg: string | null; alt_magnitude: { text: string } | null;
  aec_ref: string | null; transport_date: string | Date; remarks: string | null;
  price_eur?: string | null; carrier_address?: string | null; packages?: string | null; load_reference?: string | null; temperature?: string | null;
  reference?: string | null; carrier_authorization?: string | null; units?: number | null; packaging?: string | null; adr?: boolean | null; adr_detail?: string | null;
}
interface Extra { companyAddress?: string | null; companyAuthorization?: string | null; driver?: DecaData['driver'] }
const isoDay = (d: string | Date): string => (typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10));

/** Datos del art. 6 de la Orden FOM/2861/2012 tal como los imprime el generador de PDF real (el mismo montaje que usa la demo: pdf/data.ts). */
function decaData(t: TransportRow, v: VehicleSel, x: Extra = {}): DecaData {
  if (!v.tractor) throw new ApiError(409, 'vehicle_required');
  return buildDecaData(t, { tractor: v.tractor, trailer: v.trailer }, x);
}

/** Datos del conductor para la casilla 9, SOLO si la empresa lo ha activado (DNI y teléfono salen de su ficha, descifrado en el servidor). */
async function driverForDeca(c: PoolClient, driverId: string | null): Promise<DecaData['driver']> {
  if (!driverId || !(await showDriverInDeca(c))) return null;
  const r = (await c.query('SELECT u.full_name, p.nif_enc, p.phone FROM app_user u LEFT JOIN driver_profile p ON p.user_id = u.id WHERE u.id = $1', [driverId])).rows[0];
  if (!r) return null;
  return { name: r.full_name, nif: r.nif_enc ? decryptToken(r.nif_enc, required('APP_KEY')) : null, phone: r.phone ?? null };
}

export interface NewTransportInput {
  shipper_name?: unknown; shipper_nif?: unknown; shipper_address?: unknown; origin?: unknown; destination?: unknown; transport_date?: unknown;
  origins?: unknown; destinations?: unknown; carrier_name?: unknown; carrier_nif?: unknown; carrier_address?: unknown; shipper_postal_code?: unknown; shipper_city?: unknown; shipper_province?: unknown; shipper_country?: unknown; carrier_postal_code?: unknown; carrier_city?: unknown; carrier_province?: unknown; carrier_country?: unknown; price_eur?: unknown; packages?: unknown; load_reference?: unknown; temperature?: unknown; cargo?: unknown; weight_kg?: unknown; alt_magnitude?: unknown; aec_ref?: unknown; remarks?: unknown;
  units?: unknown; packaging?: unknown; adr?: unknown; adr_detail?: unknown; carrier_authorization?: unknown;
  driver_id?: unknown; tractor_id?: unknown; trailer_id?: unknown; generate_deca?: unknown;
}

export async function createTransport(pool: Pool, storage: LocalStorage, actor: Actor, i: NewTransportInput) {
  // a) cargador contractual, c) origen y destino, d) mercancía y peso, e) AEC, f) fecha, h) observaciones
  const shipperAddr = addrParts({ postal_code: i.shipper_postal_code, city: i.shipper_city, province: i.shipper_province, country: i.shipper_country }, 'shipper_city');
  const shipperStreet = text(i.shipper_address, 'shipper_address', 5, 200);
  const shipper = { name: text(i.shipper_name, 'shipper_name', 2, 120), nif: nif(i.shipper_nif, 'shipper_nif'), address: fullAddress({ address: shipperStreet, ...shipperAddr }), street: shipperStreet, ...shipperAddr };
  // c) Uno o varios lugares de carga y de descarga, cada uno con su empresa (quien carga no tiene por qué ser quien descarga).
  const originStops = stops(i.origins, 'origins', i.origin), destStops = stops(i.destinations, 'destinations', i.destination);
  const originJ = { text: stopsText(originStops), stops: originStops }, destJ = { text: stopsText(destStops), stops: destStops };
  const date = isoDate(i.transport_date, 'transport_date');
  const cargo = text(i.cargo, 'cargo', 3, 200);
  const alt = optText(i.alt_magnitude, 'alt_magnitude', 200);
  const weight = i.weight_kg === undefined || i.weight_kg === null || i.weight_kg === '' ? null : weightKg(i.weight_kg, 'weight_kg');
  if (weight === null && alt === null) throw bad('weight_kg');            // d): peso, o «otra magnitud» si el peso exacto es de difícil determinación
  const aec = optText(i.aec_ref, 'aec_ref', 120), remarks = optMultiline(i.remarks, 'remarks', 1000);
  // Datos de la carta de porte (opcionales)
  let packages = optText(i.packages, 'packages', 60);
  if (packages && /^\d{1,6}$/.test(packages)) packages = palletsLabel(Number(packages));   // «10» se imprime como «10 palets»
  const loadRef = optText(i.load_reference, 'load_reference', 60), temperature = optText(i.temperature, 'temperature', 60), carrierAddrIn = optText(i.carrier_address, 'carrier_address', 200);
  // Modelo DECARGO: unidades y embalaje, ADR y autorización del transportista (todo opcional)
  let units: number | null = null;
  if (i.units !== undefined && i.units !== null && i.units !== '') { const n = typeof i.units === 'number' ? i.units : Number(String(i.units).trim()); if (!Number.isInteger(n) || n < 0 || n > 999999) throw bad('units'); units = n; }
  const packaging = optText(i.packaging, 'packaging', 40);
  if (i.adr !== undefined && i.adr !== null && typeof i.adr !== 'boolean') throw bad('adr');
  const adr = i.adr === true, adrDetail = adr ? optText(i.adr_detail, 'adr_detail', 120) : null;
  const carrierAuthIn = optText(i.carrier_authorization, 'carrier_authorization', 30);
  if (carrierAuthIn !== null && !/^[A-Za-z0-9 ./-]{3,30}$/.test(carrierAuthIn)) throw bad('carrier_authorization');
  if (!packages && units !== null) packages = `${units} ${packaging ?? (units === 1 ? 'bulto' : 'bultos')}`;   // «Nº y clase de bultos» de la carta de porte
  const loadedPallets = palletsTotal(originStops);
  if (!packages && loadedPallets) packages = palletsLabel(loadedPallets);     // casilla 12: si no se indican los bultos, se usa el total de palets cargados
  let price: string | null = null;
  if (i.price_eur !== undefined && i.price_eur !== null && i.price_eur !== '') {
    const n = typeof i.price_eur === 'number' ? i.price_eur : Number(String(i.price_eur).replace(',', '.'));
    if (!Number.isFinite(n) || n < 0 || n > 10_000_000) throw bad('price_eur');
    price = n.toFixed(2);
  }
  const driverId = optUuid(i.driver_id, 'driver_id'), tractorId = optUuid(i.tractor_id, 'tractor_id'), trailerId = optUuid(i.trailer_id, 'trailer_id');
  if (i.generate_deca !== undefined && typeof i.generate_deca !== 'boolean') throw bad('generate_deca');
  const generate = i.generate_deca !== false;
  if (generate && !tractorId) throw bad('tractor_id');                    // g): sin matrícula no se puede emitir el DeCA

  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const co = (await c.query('SELECT id, name, nif, address, postal_code, city, province, country, transport_authorization FROM company ORDER BY created_at LIMIT 1')).rows[0];
    if (!co) throw new ApiError(409, 'no_company');
    // b) Transportista efectivo: por defecto la empresa, pero puede ser otro (DECARGO es una plataforma: la responsabilidad del dato es de quien lo introduce).
    const hasCarrier = (i.carrier_name !== undefined && i.carrier_name !== null && i.carrier_name !== '') || (i.carrier_nif !== undefined && i.carrier_nif !== null && i.carrier_nif !== '');
    const carrier = hasCarrier ? { name: text(i.carrier_name, 'carrier_name', 2, 120), nif: nif(i.carrier_nif, 'carrier_nif') } : { name: co.name as string, nif: co.nif as string };
    const carrierParts = hasCarrier ? addrParts({ postal_code: i.carrier_postal_code, city: i.carrier_city, province: i.carrier_province, country: i.carrier_country }, 'carrier_city') : { postal_code: null, city: null, province: null, country: null };
    const carrierAddress = hasCarrier ? (carrierAddrIn || carrierParts.city ? fullAddress({ address: carrierAddrIn, ...carrierParts }) : null) : fullAddress(co);
    if (driverId) {
      const d = (await c.query(`SELECT 1 FROM app_user WHERE id = $1 AND role = 'conductor' AND active`, [driverId])).rowCount;
      if (!d) throw bad('driver_id');
    }
    const veh = await checkVehicles(c, tractorId, trailerId);
    // Agenda: las empresas y lugares que no estén guardados se registran para la próxima vez y el transporte queda enlazado a ellos.
    const registered = await registerForTransport(c, actor, co.id, { shipper: { name: shipper.name, nif: shipper.nif, address: shipper.street, postal_code: shipper.postal_code, city: shipper.city, province: shipper.province, country: shipper.country }, carrier: hasCarrier ? { ...carrier, address: carrierAddrIn, ...carrierParts, transport_authorization: carrierAuthIn } : null, origins: originStops, destinations: destStops });
    originJ.text = stopsText(originStops); destJ.text = stopsText(destStops);   // con lo completado desde la agenda
    // casillas 3 y 4: cada lugar necesita su localidad (escrita o deducible de la dirección); nunca se imprime la calle
    for (const [l, f] of [[originStops, 'origins'], [destStops, 'destinations']] as const) if (l.some((x) => !placeFrom(x))) throw new ApiError(400, 'localidad_requerida', { field: f });
    const t = (await c.query(
      `INSERT INTO transport (company_id, shipper_name, shipper_nif, shipper_address, carrier_name, carrier_nif, origin, destination,
         cargo_description, weight_kg, alt_magnitude, aec_ref, transport_date, remarks, price_eur, carrier_address, packages, load_reference, temperature,
         reference, carrier_authorization, units, packaging, adr, adr_detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
         'DEC-' || to_char(now() AT TIME ZONE 'Europe/Madrid', 'YYYY') || '-' || lpad(nextval('transport_reference_seq')::text, 6, '0'), $20, $21, $22, $23, $24)
       RETURNING id, reference`,
      [co.id, shipper.name, shipper.nif, shipper.address, carrier.name, carrier.nif, JSON.stringify(originJ), JSON.stringify(destJ),
       cargo, weight, alt ? JSON.stringify({ text: alt }) : null, aec, date, remarks, price, carrierAddress, packages, loadRef, temperature,
       hasCarrier ? carrierAuthIn : null, units, packaging, adr || null, adrDetail])).rows[0];
    if (veh.tractor) await c.query('INSERT INTO transport_vehicle_assignment (transport_id, tractor_id, trailer_id, reason) VALUES ($1,$2,$3,$4)', [t.id, veh.tractor.id, veh.trailer?.id ?? null, 'Asignación inicial']);
    if (driverId) {
      await c.query('INSERT INTO transport_driver_assignment (transport_id, driver_user_id, created_by) VALUES ($1,$2,$3)', [t.id, driverId, actorStr(actor)]);
      await c.query(`UPDATE transport SET status = 'EN_CURSO' WHERE id = $1`, [t.id]);   // con conductor: en curso
    }
    await appendAudit(c, { company_id: co.id, at: new Date(), actor: actorStr(actor), action: 'TRANSPORT_CREATED', entity: 'transport', entity_id: t.id,
      before: null, after: { date, carrier: `${carrier.name} (${carrier.nif})`, driver: driverId ?? 'sin asignar', tractor: veh.tractor?.plate ?? 'sin asignar' }, reason: null });
    let deca = null;
    if (generate) {
      const row: TransportRow = { shipper_name: shipper.name, shipper_nif: shipper.nif, shipper_address: shipper.address, carrier_name: carrier.name, carrier_nif: carrier.nif,
        origin: originJ, destination: destJ, cargo_description: cargo, weight_kg: weight, alt_magnitude: alt ? { text: alt } : null, aec_ref: aec, transport_date: date, remarks,
        price_eur: price, carrier_address: carrierAddress, packages, load_reference: loadRef, temperature,
        reference: t.reference, carrier_authorization: hasCarrier ? carrierAuthIn : null, units, packaging, adr, adr_detail: adrDetail };
      deca = await issueDeca(c, storage, { companyId: co.id, transportId: t.id, data: decaData(row, veh, { companyAddress: fullAddress(co), companyAuthorization: co.transport_authorization ?? null, driver: await driverForDeca(c, driverId) }), actor: actorStr(actor), reason: 'alta de transporte', isTest: await testMode(c) });
    }
    await c.query('COMMIT');
    return { id: t.id, reference: t.reference, deca_id: deca?.deca_id ?? null, registered };
  } catch (e) { try { await c.query('ROLLBACK'); } catch { /* */ } throw e; } finally { c.release(); }
}

/** Emite el DeCA (versión 1) de un transporte que aún no lo tiene. Mismo núcleo que el alta. */
export async function generateDecaForTransport(pool: Pool, storage: LocalStorage, actor: Actor, transportId: string) {
  if (!UUID_RE.test(transportId)) throw new ApiError(404, 'no_encontrado');
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    // `deca_api` no tiene UPDATE sobre `transport` (es inmutable), así que no puede usar FOR UPDATE: se serializa por transporte con un bloqueo consultivo.
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`transport:${transportId}`]);
    const t = (await c.query('SELECT *, transport_date::text AS d_txt FROM transport WHERE id = $1', [transportId])).rows[0];
    if (!t) throw new ApiError(404, 'no_encontrado');
    if ((await c.query('SELECT 1 FROM deca_transport dt JOIN deca d ON d.id = dt.deca_id WHERE dt.transport_id = $1 AND d.status = \'ACTIVE\'', [transportId])).rowCount) throw new ApiError(409, 'deca_exists');   // 1 transporte = 1 DeCA
    const a = (await c.query(
      `SELECT vt.id AS tid, vt.plate_display AS tplate, vt.kind AS tkind, vr.id AS rid, vr.plate_display AS rplate, vr.kind AS rkind
       FROM transport_vehicle_assignment a JOIN vehicle vt ON vt.id = a.tractor_id LEFT JOIN vehicle vr ON vr.id = a.trailer_id
       WHERE a.transport_id = $1 AND a.valid_to IS NULL`, [transportId])).rows[0];
    if (!a) throw new ApiError(409, 'vehicle_required');
    const veh: VehicleSel = { tractor: { id: a.tid, plate: a.tplate, kind: a.tkind }, trailer: a.rid ? { id: a.rid, plate: a.rplate, kind: a.rkind } : null };
    const co2 = (await c.query('SELECT address, postal_code, city, province, country, transport_authorization FROM company WHERE id = $1', [t.company_id])).rows[0];
    const dr = (await c.query('SELECT driver_user_id FROM transport_driver_assignment WHERE transport_id = $1 AND valid_to IS NULL', [transportId])).rows[0];
    const deca = await issueDeca(c, storage, { companyId: t.company_id, transportId, data: decaData({ ...t, transport_date: t.d_txt }, veh, { companyAddress: co2 ? fullAddress(co2) : null, companyAuthorization: co2?.transport_authorization ?? null, driver: await driverForDeca(c, dr?.driver_user_id ?? null) }), actor: actorStr(actor), reason: 'emisión posterior al alta', isTest: await testMode(c) });
    await c.query('COMMIT');
    return deca;
  } catch (e) { try { await c.query('ROLLBACK'); } catch { /* */ } throw e; } finally { c.release(); }
}

/**
 * Asigna los vehículos de un transporte SIN DeCA. Con el DeCA ya emitido, cambiar la matrícula es una MODIFICACIÓN legal
 * (ORD 6.g, RES quinto) que exige la política de versionado: no está implementada y no se permite aquí.
 */
export async function setVehicles(pool: Pool, actor: Actor, transportId: string, tractorId: string | null, trailerId: string | null) {
  if (!UUID_RE.test(transportId)) throw new ApiError(404, 'no_encontrado');
  if (!tractorId) throw bad('tractor_id');
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`transport:${transportId}`]);
    const t = (await c.query('SELECT id, company_id FROM transport WHERE id = $1', [transportId])).rows[0];
    if (!t) throw new ApiError(404, 'no_encontrado');
    if ((await c.query('SELECT 1 FROM deca_transport dt JOIN deca d ON d.id = dt.deca_id WHERE dt.transport_id = $1 AND d.status = \'ACTIVE\'', [transportId])).rowCount) throw new ApiError(409, 'deca_emitido');
    const veh = await checkVehicles(c, tractorId, trailerId);
    await c.query('UPDATE transport_vehicle_assignment SET valid_to = now() WHERE transport_id = $1 AND valid_to IS NULL', [transportId]);
    await c.query('INSERT INTO transport_vehicle_assignment (transport_id, tractor_id, trailer_id, reason) VALUES ($1,$2,$3,$4)', [transportId, tractorId, trailerId, 'Asignación desde oficina']);
    await appendAudit(c, { company_id: t.company_id, at: new Date(), actor: actorStr(actor), action: 'TRANSPORT_VEHICLES_SET', entity: 'transport', entity_id: transportId,
      before: null, after: { tractor: veh.tractor!.plate, trailer: veh.trailer?.plate ?? 'ninguno' }, reason: null });
    await c.query('COMMIT');
  } catch (e) { try { await c.query('ROLLBACK'); } catch { /* */ } throw e; } finally { c.release(); }
}

const LIST_SQL = `
  SELECT t.id, t.reference, t.status, t.transport_date::text AS transport_date, t.shipper_name, replace(t.origin->>'text', E'\n', ' · ') AS origin, replace(t.destination->>'text', E'\n', ' · ') AS destination, t.cargo_description AS cargo,
         d.id AS deca_id, a.driver_user_id, u.full_name AS driver_name, vt.plate_display AS tractor, vr.plate_display AS trailer
  FROM transport t
  LEFT JOIN deca_transport dt ON dt.transport_id = t.id AND EXISTS (SELECT 1 FROM deca x WHERE x.id = dt.deca_id AND x.status = 'ACTIVE') LEFT JOIN deca d ON d.id = dt.deca_id
  LEFT JOIN transport_driver_assignment a ON a.transport_id = t.id AND a.valid_to IS NULL LEFT JOIN app_user u ON u.id = a.driver_user_id
  LEFT JOIN transport_vehicle_assignment va ON va.transport_id = t.id AND va.valid_to IS NULL
  LEFT JOIN vehicle vt ON vt.id = va.tractor_id LEFT JOIN vehicle vr ON vr.id = va.trailer_id`;

export async function listTransports(pool: Pool, status?: string) {
  if (status !== undefined && !['PENDIENTE', 'EN_CURSO', 'FINALIZADO', 'CANCELADO'].includes(status)) throw bad('status');
  return (await pool.query(`${LIST_SQL} WHERE ($1::text IS NULL OR t.status = $1) ORDER BY t.transport_date DESC, t.created_at DESC LIMIT 200`, [status ?? null])).rows;
}

export async function getTransportDetail(pool: Pool, id: string) {
  if (!UUID_RE.test(id)) throw new ApiError(404, 'no_encontrado');
  const t = (await pool.query(
    `SELECT t.*, t.transport_date::text AS date_txt, d.id AS deca_id, d.status AS deca_status, d.current_version, d.public_active, d.public_until, d.retain_not_before, d.created_at AS deca_created, d.public_url,
            v.created_at AS version_created, v.pdf_modified, v.sha256, v.size_bytes,
            a.driver_user_id, u.username AS driver_username, u.full_name AS driver_name,
            vt.id AS tractor_id, vt.plate_display AS tractor, vt.kind AS tractor_kind, vr.id AS trailer_id, vr.plate_display AS trailer, vr.kind AS trailer_kind
     FROM transport t
     LEFT JOIN deca_transport dt ON dt.transport_id = t.id AND EXISTS (SELECT 1 FROM deca x WHERE x.id = dt.deca_id AND x.status = 'ACTIVE') LEFT JOIN deca d ON d.id = dt.deca_id
     LEFT JOIN deca_version v ON v.deca_id = d.id AND v.version_no = d.current_version
     LEFT JOIN transport_driver_assignment a ON a.transport_id = t.id AND a.valid_to IS NULL LEFT JOIN app_user u ON u.id = a.driver_user_id
     LEFT JOIN transport_vehicle_assignment va ON va.transport_id = t.id AND va.valid_to IS NULL
     LEFT JOIN vehicle vt ON vt.id = va.tractor_id LEFT JOIN vehicle vr ON vr.id = va.trailer_id
     WHERE t.id = $1`, [id])).rows[0];
  if (!t) throw new ApiError(404, 'no_encontrado');
  let base: string | null = null; try { base = await getPublicBase(pool); } catch { /* sin configurar */ }
  const ext = (await pool.query(
    `SELECT e.id, e.review_status, e.fetched_at, e.size_bytes, e.device_status, e.reviewed_at, e.notes, u.username AS added_by
     FROM external_deca e JOIN app_user u ON u.id = e.added_by_user WHERE e.transport_id = $1 ORDER BY e.created_at`, [id])).rows;
  return {
    id: t.id, status: t.status, transport_date: t.date_txt, created_at: t.created_at, category: t.category,
    shipper: { name: t.shipper_name, nif: t.shipper_nif, address: t.shipper_address }, carrier: { name: t.carrier_name, nif: t.carrier_nif },
    origin: t.origin.text, destination: t.destination.text,
    origins: await resolveStops(pool, t.origin.stops ?? [{ party: null, address: t.origin.text }]), destinations: await resolveStops(pool, t.destination.stops ?? [{ party: null, address: t.destination.text }]), cargo: t.cargo_description, weight_kg: t.weight_kg, alt_magnitude: t.alt_magnitude?.text ?? null,
    aec_ref: t.aec_ref, remarks: t.remarks, price_eur: t.price_eur, packages: t.packages, load_reference: t.load_reference, temperature: t.temperature, carrier_address: t.carrier_address,
    reference: t.reference, carrier_authorization: t.carrier_authorization, units: t.units, packaging: t.packaging, adr: t.adr === true, adr_detail: t.adr_detail,
    driver: t.driver_user_id ? { id: t.driver_user_id, username: t.driver_username, full_name: t.driver_name } : null,
    vehicles: t.tractor_id ? { tractor: { id: t.tractor_id, plate: t.tractor, kind: t.tractor_kind }, trailer: t.trailer_id ? { id: t.trailer_id, plate: t.trailer, kind: t.trailer_kind } : null } : null,
    deca: t.deca_id ? {
      id: t.deca_id, version: t.current_version, status: t.deca_status, created_at: t.deca_created, modified_at: t.pdf_modified,
      public_active: t.public_active, public_until: t.public_until, retain_not_before: t.retain_not_before,
      technical: { sha256: t.sha256, size_bytes: t.size_bytes, public_url: t.public_url, other_base: !!t.public_url && !!base && !t.public_url.startsWith(`${base}/d/`) }
    } : null,
    external_decas: ext,
    relay: (await pool.query('SELECT r.driver_user_id AS id, u.full_name FROM transport_relay r JOIN app_user u ON u.id = r.driver_user_id WHERE r.transport_id = $1', [id])).rows[0] ?? null,
    // Conductores que ha tenido (tramos): quién, desde y hasta cuándo.
    drivers_history: (await pool.query(`SELECT u.full_name, a.valid_from, a.valid_to FROM transport_driver_assignment a JOIN app_user u ON u.id = a.driver_user_id
      WHERE a.transport_id = $1 ORDER BY a.valid_from`, [id])).rows
  };
}

export async function dashboard(pool: Pool) {
  const t = (await pool.query('SELECT status, count(*)::int AS n FROM transport GROUP BY status')).rows;
  const counts: Record<string, number> = { PENDIENTE: 0, EN_CURSO: 0, FINALIZADO: 0, CANCELADO: 0 };
  for (const r of t) counts[r.status] = r.n;
  const p = (await pool.query(`SELECT (SELECT count(*)::int FROM device WHERE status = 'PENDIENTE_DE_CONFIRMACION') AS devices,
                                      (SELECT count(*)::int FROM external_deca WHERE review_status = 'PENDIENTE_DE_REVISION') AS external`)).rows[0];
  const co = (await pool.query('SELECT name, nif FROM company ORDER BY created_at LIMIT 1')).rows[0] ?? null;
  // Dirección pública con la que se emitirán los DeCA nuevos y cuántos ya emitidos llevan OTRA (p. ej. tras cambiar de dominio o de servidor).
  let base: string | null = null; try { base = await getPublicBase(pool); } catch { /* configuración inválida: se muestra como no configurada */ }
  const other = base ? Number((await pool.query(`SELECT count(*)::int AS n FROM deca WHERE status = 'ACTIVE' AND public_url IS NOT NULL AND left(public_url, $2) <> $1`, [`${base}/d/`, base.length + 3])).rows[0].n) : 0;
  return { transports: counts, pending_devices: p.devices, external_pending_review: p.external, company: co, public_base_url: base, decas_other_base: other, expiries: await expiryCounts(pool) };
}

/** QR de oficina: se genera a partir de la URL con la que se emitió el PDF (la misma que lleva su QR). */
export async function decaQrSvg(pool: Pool, decaId: string): Promise<string | null> {
  if (!UUID_RE.test(decaId)) return null;
  const d = (await pool.query('SELECT public_url, token_enc FROM deca WHERE id = $1', [decaId])).rows[0];
  if (!d) return null;
  const url: string = d.public_url ?? `${await getPublicBase(pool)}/d/${decryptToken(d.token_enc, required('APP_KEY'))}`;
  return QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'M', margin: 4 });
}

// ----------------------------------------------------------------------------- ciclo de vida y modificaciones del DeCA
const OPEN = ['PENDIENTE', 'EN_CURSO'];

/** DeCA vigente de un transporte con su última instantánea (datos con los que se imprimió la versión actual). */
async function activeDeca(c: PoolClient, transportId: string) {
  return (await c.query(
    `SELECT d.id, d.company_id, d.current_version, v.snapshot FROM deca_transport dt JOIN deca d ON d.id = dt.deca_id AND d.status = 'ACTIVE'
     JOIN deca_version v ON v.deca_id = d.id AND v.version_no = d.current_version WHERE dt.transport_id = $1`, [transportId])).rows[0] as { id: string; company_id: string; current_version: number; snapshot: DecaData } | undefined;
}

/**
 * Al asignar (o cambiar) el conductor de un transporte cuyo DeCA ya está emitido con el modelo «Carta de porte» y la empresa imprime los datos del conductor:
 * nueva versión del DeCA (mismo QR y URL) con el conductor en la casilla 9, o en la 9.1 (conductor sucesivo) si ya había otro. No hace nada en los demás casos.
 */
export async function syncDriverIntoDeca(pool: Pool, storage: LocalStorage, actor: Actor, transportId: string): Promise<{ version: number } | null> {
  if (!UUID_RE.test(transportId)) return null;
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const t = (await c.query('SELECT status FROM transport WHERE id = $1', [transportId])).rows[0];
    const deca = t && OPEN.includes(t.status) ? await activeDeca(c, transportId) : undefined;
    if (!deca || (deca.snapshot.template !== 'CARTA_DE_PORTE' && deca.snapshot.template !== 'DECARGO')) { await c.query('ROLLBACK'); return null; }   // los modelos que imprimen el conductor
    const a = (await c.query('SELECT driver_user_id FROM transport_driver_assignment WHERE transport_id = $1 AND valid_to IS NULL', [transportId])).rows[0];
    const info = await driverForDeca(c, a?.driver_user_id ?? null);
    if (!info) { await c.query('ROLLBACK'); return null; }
    const snap = deca.snapshot;
    let next: DecaData, reason: string, changes: string[];
    if (!snap.driver) { next = { ...snap, driver: info }; reason = 'Se asigna el conductor'; changes = ['driver']; }
    else if (snap.driver.name === info.name || snap.driver2?.name === info.name) { await c.query('ROLLBACK'); return null; }
    else { next = { ...snap, driver2: info }; reason = 'Cambio de conductor'; changes = ['driver2']; }
    const r = await addDecaVersion(c, storage, { decaId: deca.id, data: next, actor: actorStr(actor), reason, changes });
    await c.query('COMMIT');
    return { version: r.version };
  } catch (e) { try { await c.query('ROLLBACK'); } catch { /* */ } throw e; } finally { c.release(); }
}

/**
 * Cambio de vehículo con el DeCA ya emitido (ORD art. 6.g): el transporte pasa al vehículo nuevo y el DeCA recibe una versión nueva (mismo QR y URL)
 * que conserva la matrícula original en la casilla 8 y anota el cambio, con su fecha, en la 8.1. Sin DeCA, simplemente se cambia la asignación.
 */
export async function changeVehicle(pool: Pool, storage: LocalStorage, actor: Actor, transportId: string, rawTractor: unknown, rawTrailer: unknown, rawReason: unknown) {
  if (!UUID_RE.test(transportId)) throw new ApiError(404, 'no_encontrado');
  const tractorId = optUuid(rawTractor, 'tractor_id'), trailerId = optUuid(rawTrailer, 'trailer_id');
  if (!tractorId) throw bad('tractor_id');
  const reason = optText(rawReason, 'reason', 200) ?? 'Cambio de vehículo';
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`transport:${transportId}`]);
    const t = (await c.query('SELECT id, company_id, status FROM transport WHERE id = $1', [transportId])).rows[0];
    if (!t) throw new ApiError(404, 'no_encontrado');
    if (!OPEN.includes(t.status)) throw new ApiError(409, 'transporte_cerrado');
    const cur = (await c.query('SELECT tractor_id, trailer_id FROM transport_vehicle_assignment WHERE transport_id = $1 AND valid_to IS NULL', [transportId])).rows[0];
    if (!cur) throw new ApiError(409, 'vehicle_required');
    if (cur.tractor_id === tractorId && (cur.trailer_id ?? null) === (trailerId ?? null)) throw new ApiError(409, 'sin_cambios');
    const veh = await checkVehicles(c, tractorId, trailerId);
    await c.query('UPDATE transport_vehicle_assignment SET valid_to = now() WHERE transport_id = $1 AND valid_to IS NULL', [transportId]);
    await c.query('INSERT INTO transport_vehicle_assignment (transport_id, tractor_id, trailer_id, reason) VALUES ($1,$2,$3,$4)', [transportId, tractorId, trailerId, reason]);
    let version: number | null = null;
    const deca = await activeDeca(c, transportId);
    if (deca) {
      const change = { at: new Date().toISOString(), tractorPlate: veh.tractor!.plate, trailerPlate: veh.trailer?.plate ?? null };
      const r = await addDecaVersion(c, storage, { decaId: deca.id, data: { ...deca.snapshot, vehicleChanges: [...(deca.snapshot.vehicleChanges ?? []), change] }, actor: actorStr(actor), reason, changes: ['vehicleChanges'] });
      version = r.version;
    }
    await appendAudit(c, { company_id: t.company_id, at: new Date(), actor: actorStr(actor), action: 'TRANSPORT_VEHICLE_CHANGED', entity: 'transport', entity_id: transportId,
      before: null, after: { tractor: veh.tractor!.plate, trailer: veh.trailer?.plate ?? 'ninguno', deca_version: version ?? 'sin DeCA' }, reason });
    await c.query('COMMIT');
    return { deca_version: version };
  } catch (e) { try { await c.query('ROLLBACK'); } catch { /* */ } throw e; } finally { c.release(); }
}

/**
 * Anular un transporte (no se borra: el DeCA emitido debe conservarse y todo queda en la auditoría). El conductor deja de verlo.
 * Solo si no ha finalizado; exige un motivo.
 */
export async function cancelTransport(pool: Pool, actor: Actor, transportId: string, rawReason: unknown) {
  if (!UUID_RE.test(transportId)) throw new ApiError(404, 'no_encontrado');
  const reason = text(rawReason, 'reason', 3, 300);
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`transport:${transportId}`]);
    const t = (await c.query('SELECT id, company_id, status FROM transport WHERE id = $1', [transportId])).rows[0];
    if (!t) throw new ApiError(404, 'no_encontrado');
    if (!OPEN.includes(t.status)) throw new ApiError(409, t.status === 'CANCELADO' ? 'ya_anulado' : 'transporte_cerrado');
    await c.query(`UPDATE transport SET status = 'CANCELADO' WHERE id = $1`, [transportId]);
    await c.query('DELETE FROM transport_relay WHERE transport_id = $1', [transportId]);
    await appendAudit(c, { company_id: t.company_id, at: new Date(), actor: actorStr(actor), action: 'TRANSPORT_CANCELLED', entity: 'transport', entity_id: transportId, before: { status: t.status }, after: { status: 'CANCELADO' }, reason });
    await c.query('COMMIT');
  } catch (e) { try { await c.query('ROLLBACK'); } catch { /* */ } throw e; } finally { c.release(); }
}
