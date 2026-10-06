/**
 * DEMO de DECARGO: servidor SIMULADO dentro del navegador. Imita la API real con datos totalmente ficticios que viven solo en la
 * memoria de esta pestaña: se puede crear, editar, anular o archivar todo lo que permite la aplicación, y al RECARGAR la página
 * todo vuelve al estado original. No se envía nada al servidor de verdad ni se guarda nada en el navegador.
 */
import QRCode from 'qrcode';
// El MISMO generador de DeCA y el MISMO montaje de datos que el servidor (se copian al construir la imagen; ver web/Dockerfile).
import { buildDecaData } from '../shared/pdf/data';
import { setFontProvider } from '../shared/pdf/fonts';
import { generateFichasPdf } from '../shared/pdf/fichas-pdf';
import { generateCartaPdf } from '../shared/pdf/carta-pdf';
import { generateDecaPdf, type DecaData } from '../shared/pdf/deca-pdf';

setFontProvider(async () => {
  const get = async (f: string): Promise<Uint8Array> => new Uint8Array(await (await fetch(`${import.meta.env.BASE_URL}fonts/${f}`)).arrayBuffer());
  return { regular: await get('DejaVuSans.ttf'), bold: await get('DejaVuSans-Bold.ttf') };
});
const demoActivationUrl = (u: string, c: string): string => `${location.origin}${import.meta.env.BASE_URL}activar#u=${encodeURIComponent(u)}&c=${encodeURIComponent(c)}`;
const demoQrSvg = (url: string): Promise<string> => QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'M', margin: 4 });
const DEMO_BANNER = 'DEMOSTRACIÓN · DATOS FICTICIOS · SIN VALOR';

type Row = Record<string, any>;
interface Stop { party: string | null; address: string; postal_code?: string | null; city?: string | null; province?: string | null; country?: string | null; party_id?: string | null; site_id?: string | null; pallets?: number | null; references?: string[]; seals?: string[]; time?: string | null; nif?: string | null }

// ----------------------------------------------------------------------------- utilidades
let seq = 0;
const uid = (): string => {
  seq++;
  const h = (n: number, l: number): string => n.toString(16).padStart(l, '0').slice(-l);
  return `${h(Date.now(), 8)}-${h(seq, 4)}-4${h(seq * 7, 3)}-8${h(seq * 13, 3)}-${h(Math.floor(Math.random() * 2 ** 48), 12)}`;
};
const iso = (offsetDays = 0): string => { const d = new Date(); d.setDate(d.getDate() + offsetDays); return d.toISOString().slice(0, 10); };
const ts = (offsetDays = 0, h = 9): string => { const d = new Date(); d.setDate(d.getDate() + offsetDays); d.setHours(h, 0, 0, 0); return d.toISOString(); };
const daysLeft = (date: string): number => Math.round((new Date(`${date}T00:00:00`).getTime() - new Date(`${iso(0)}T00:00:00`).getTime()) / 86400000);
const fake = (len: number): string => Array.from({ length: len }, () => 'abcdef0123456789'[Math.floor(Math.random() * 16)]).join('');
class DemoError extends Error { constructor(public status: number, public code: string, public extra: Row = {}) { super(code); } }
const bad = (field: string): DemoError => new DemoError(400, 'invalid_field', { field });
const notFound = (): DemoError => new DemoError(404, 'no_encontrado');
const req = (v: unknown, field: string, min = 1): string => { if (typeof v !== 'string' || v.trim().length < min) throw bad(field); return v.trim(); };
const opt = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const fullAddress = (s: { address?: string | null; postal_code?: string | null; city?: string | null; province?: string | null; country?: string | null }): string =>
  [s.address, [s.postal_code, s.city].filter(Boolean).join(' ') + (s.province && s.province !== s.city ? ` (${s.province})` : ''), s.country && !/^españa$/i.test(s.country) ? s.country : '']
    .filter((x) => x && String(x).trim()).join(', ');
const palLabel = (n: number): string => `${n} ${n === 1 ? 'palet' : 'palets'}`;

// ----------------------------------------------------------------------------- datos ficticios iniciales
const company: Row = { transport_authorization: '12345678', name: 'Transportes Ejemplo del Sur S.L.', nif: 'B12345674', address: 'Calle Ficticia 1', postal_code: '18000', city: 'Granada', province: 'Granada', country: 'España' };
const PUBLIC = `${window.location.origin}/demo/`;
/** Logo de la empresa de la demo (en memoria; vuelve a «sin logo» al recargar). Cada DeCA guarda el que tenía al emitirse. */
let demoLogo: { bytes: Uint8Array; png: boolean; width: number; height: number; at: string } | null = null;
const settings = { deca_show_driver: true, food_transport: true, expiry_warn_days: 30, test_mode: false, dev_endpoints: false };

const users: Row[] = [
  { id: uid(), username: 'ana.demo', full_name: 'Ana Gestora Demo', role: 'admin', active: true, pending_activation: false, totp_enabled: true, created_at: ts(-200) },
  { id: uid(), username: 'oscar.oficina', full_name: 'Óscar Oficina Ejemplo', role: 'oficina', active: true, pending_activation: false, totp_enabled: true, created_at: ts(-190) },
  { id: uid(), username: 'juan.perez', full_name: 'Juan Pérez Ejemplo', role: 'conductor', active: true, pending_activation: false, totp_enabled: false, created_at: ts(-150) },
  { id: uid(), username: 'maria.lopez', full_name: 'María López Ficticia', role: 'conductor', active: true, pending_activation: false, totp_enabled: false, created_at: ts(-120) },
  { id: uid(), username: 'luis.martin', full_name: 'Luis Martín Demo', role: 'conductor', active: true, pending_activation: false, totp_enabled: false, created_at: ts(-30) }
];
const [ADMIN, OFICINA, JUAN, MARIA, LUIS] = users;
const profiles: Record<string, Row> = {
  [JUAN.id]: { phone: '600 000 001', email: 'juan@ejemplo.invalid', city: 'Granada', province: 'Granada', country: 'España', contract_type: 'INDEFINIDO', job_category: 'Conductor mecánico', hire_date: iso(-1500), nif: '12345678Z', ss: '180000000001', iban: 'ES9121000418450200051332' },
  [MARIA.id]: { phone: '600 000 002', city: 'Valencia', country: 'España', contract_type: 'INDEFINIDO', hire_date: iso(-900) },
  [LUIS.id]: { phone: '600 000 003', city: 'Sevilla', country: 'España', contract_type: 'TEMPORAL', hire_date: iso(-30) }
};
const devices: Row[] = [
  { id: uid(), user_id: JUAN.id, status: 'AUTORIZADO', label: 'App Android', registered_at: ts(-140), last_seen: ts(0, 8), decided_at: ts(-140), push_subscribed: true },
  { id: uid(), user_id: MARIA.id, status: 'AUTORIZADO', label: 'Navegador web', registered_at: ts(-110), last_seen: ts(-1, 18), decided_at: ts(-110), push_subscribed: true },
  { id: uid(), user_id: LUIS.id, status: 'PENDIENTE_DE_CONFIRMACION', label: 'App Android', registered_at: ts(-1, 7), last_seen: ts(-1, 7), decided_at: null, push_subscribed: false }
];
const vehicles: Row[] = [
  { id: uid(), plate: '1234 DMO', kind: 'TRACTORA', active: true, created_at: ts(-300) },
  { id: uid(), plate: '5678 DMO', kind: 'TRACTORA', active: true, created_at: ts(-280) },
  { id: uid(), plate: 'R-1111-DMO', kind: 'SEMIRREMOLQUE', active: true, created_at: ts(-300) },
  { id: uid(), plate: 'R-2222-DMO', kind: 'SEMIRREMOLQUE', active: true, created_at: ts(-250) },
  { id: uid(), plate: '9012 DMO', kind: 'RIGIDO', active: true, created_at: ts(-200) }
];
const [T1, T2, S1, S2] = vehicles;
const party = (name: string, nif: string | null, address: string, postal_code: string, city: string, sites: Array<Partial<Row>>): Row => {
  const id = uid();
  return { id, name, nif, address, postal_code, city, province: city, country: 'España', notes: null, active: true, use_count: 2, last_used_at: ts(-2),
    sites: sites.map((s) => ({ id: uid(), label: null, kind: 'AMBOS', postal_code, city, province: city, country: 'España', lat: null, lon: null, map_url: null, notes: null, active: true, ...s })) };
};
const parties: Row[] = [
  party('Almacenes Ficticios del Norte S.A.', 'A12345674', 'Polígono Imaginario 4', '50014', 'Zaragoza', [{ label: 'Nave central', kind: 'CARGA', address: 'Polígono Imaginario 4', lat: 41.68, lon: -0.87, notes: 'Entrada por la puerta 2. Horario de 7 a 15 h.' }]),
  party('Frutas Inventadas S.L.', 'B12345674', 'Camino de la Huerta 12', '46013', 'Valencia', [{ label: 'Almacén', kind: 'CARGA', address: 'Camino de la Huerta 12' }]),
  party('Distribuciones Ejemplo S.A.', null, 'Avenida del Ejemplo 100', '28042', 'Madrid', [{ label: 'Muelles', kind: 'DESCARGA', address: 'Avenida del Ejemplo 100', notes: 'Pedir cita al llegar.' }]),
  party('Supermercados Imaginarios S.L.', null, 'Calle Falsa 123', '41007', 'Sevilla', [{ label: 'Plataforma Sur', kind: 'DESCARGA', address: 'Calle Falsa 123' }])
];
const documents: Row[] = [
  { id: uid(), subject_kind: 'VEHICLE', user_id: null, vehicle_id: T1.id, doc_type: 'ITV', label: null, number: null, detail: null, issued_on: iso(-340), expires_on: iso(12), notes: null, active: true },
  { id: uid(), subject_kind: 'VEHICLE', user_id: null, vehicle_id: S1.id, doc_type: 'ATP', label: null, number: 'ATP-0000-DEMO', detail: 'FRC', issued_on: iso(-1000), expires_on: iso(200), notes: null, active: true },
  { id: uid(), subject_kind: 'DRIVER', user_id: LUIS.id, vehicle_id: null, doc_type: 'CAP', label: null, number: null, detail: null, issued_on: iso(-1830), expires_on: iso(-5), notes: 'Pendiente de renovar', active: true },
  { id: uid(), subject_kind: 'DRIVER', user_id: JUAN.id, vehicle_id: null, doc_type: 'TARJETA_CONDUCTOR', label: null, number: 'ES000000DEMO', detail: null, issued_on: iso(-1500), expires_on: iso(325), notes: null, active: true },
  { id: uid(), subject_kind: 'COMPANY', user_id: null, vehicle_id: null, doc_type: 'SEGURO_RC', label: null, number: 'POL-000-DEMO', detail: null, issued_on: iso(-340), expires_on: iso(25), notes: null, active: true }
];
const assets: Row[] = [
  { id: uid(), vehicle_id: T1.id, kind: 'FUEL_CARD', provider: 'Gasóleos Ejemplo', identifier: '7000-0000-0000-1234', pin: '4321', expires_on: iso(400), notes: null, active: true },
  { id: uid(), vehicle_id: T1.id, kind: 'VIA_T', provider: 'Autopistas Ficticias', identifier: 'VT-000123', pin: null, expires_on: null, notes: null, active: true }
];
const stop = (p: Row, extra: Partial<Stop> = {}): Stop => ({ party: p.name, address: p.sites[0].address, postal_code: p.postal_code, city: p.city, province: p.province, country: 'España', party_id: p.id, site_id: p.sites[0].id, references: [], seals: [], pallets: null, ...extra });
const transports: Row[] = [];
let refSeq = 0;
const nextRef = (): string => `DEC-${new Date().getFullYear()}-${String(++refSeq).padStart(6, '0')}`;
function seedTransport(o: Row): Row {
  const t: Row = { id: uid(), created_at: ts(o.dayOffset - 2), category: 'PUBLICO', shipper: { name: company.name, nif: company.nif, address: fullAddress(company) }, carrier: { name: company.name, nif: company.nif },
    carrier_address: fullAddress(company), weight_kg: null, alt_magnitude: null, aec_ref: null, remarks: null, price_eur: null, packages: null, load_reference: null, temperature: null,
    driver_id: null, relay_id: null, history: [], tractor_id: null, trailer_id: null, deca: null, vehicle_changes: [], reference: nextRef(), carrier_authorization: null,
    units: null, packaging: null, adr: false, adr_detail: null, ...o };
  t.transport_date = iso(o.dayOffset);
  if (t.driver_id) t.history = [{ driver_id: t.driver_id, valid_from: ts(o.dayOffset - 1), valid_to: null }];
  transports.push(t);
  return t;
}
function issue(t: Row): void {
  const now = new Date().toISOString();
  // Como en la aplicación real: siempre el Modelo DECARGO; el DeCA guarda el logo y los vehículos con los que se emitió (los cambios van en la 8.1).
  t.deca = { id: uid(), version: 1, status: 'ACTIVE', created_at: now, modified_at: now, public_url: `${PUBLIC}d/${fake(24)}`, template: 'DECARGO', logo: demoLogo, tractor_id: t.tractor_id, trailer_id: t.trailer_id, versions: [{ version_no: 1, method: 'ORIGINAL', created_at: now, sha256: fake(64), size_bytes: 30000 + Math.floor(Math.random() * 5000) }] };
}
function newVersion(t: Row, reason: string): void {
  if (!t.deca) return;
  const now = new Date().toISOString();
  t.deca.version++; t.deca.modified_at = now;
  t.deca.versions.push({ version_no: t.deca.version, method: 'MODIFIED_SAME_PDF', created_at: now, sha256: fake(64), size_bytes: 30000 + Math.floor(Math.random() * 5000), reason });
}
{
  const [norte, frutas, distrib, super_] = parties;
  issue(seedTransport({ dayOffset: 0, status: 'EN_CURSO', driver_id: JUAN.id, tractor_id: T1.id, trailer_id: S1.id, origins: [stop(norte, { pallets: 26, references: ['PED-0001'], time: '08:00' })], destinations: [stop(distrib, { pallets: 26, time: '15:30' })], cargo: 'Conservas vegetales (datos ficticios)', weight_kg: '18500', packages: '26 Europalet', units: 26, packaging: 'Europalet' }));
  const t2 = seedTransport({ dayOffset: 0, status: 'EN_CURSO', driver_id: MARIA.id, tractor_id: T2.id, trailer_id: S2.id, origins: [stop(frutas, { pallets: 20 })], destinations: [stop(super_, { pallets: 20, seals: ['PR-778899'] })], cargo: 'Fruta fresca', weight_kg: '16000', packages: '20 palets', temperature: '+2 a +6' });
  issue(t2); t2.vehicle_changes.push({ at: ts(0, 7), tractor: '5678 DMO', trailer: 'R-2222-DMO' }); newVersion(t2, 'Cambio de vehículo');
  issue(seedTransport({ dayOffset: 1, status: 'PENDIENTE', origins: [stop(norte)], destinations: [stop(super_)], cargo: 'Material de oficina', weight_kg: '4200', tractor_id: T1.id, trailer_id: S1.id }));
  seedTransport({ dayOffset: 2, status: 'EN_CURSO', driver_id: JUAN.id, relay_id: MARIA.id, tractor_id: T1.id, trailer_id: S1.id, origins: [stop(distrib)], destinations: [stop(frutas)], cargo: 'Envases vacíos', weight_kg: '3000' });
  const fin = seedTransport({ dayOffset: -3, status: 'FINALIZADO', driver_id: JUAN.id, tractor_id: T1.id, trailer_id: S1.id, origins: [stop(frutas)], destinations: [stop(distrib)], cargo: 'Cítricos', weight_kg: '17000', finished_at: ts(-3, 17) });
  issue(fin); fin.history[0].valid_to = ts(-3, 17);
  const can = seedTransport({ dayOffset: -1, status: 'CANCELADO', origins: [stop(norte)], destinations: [stop(distrib)], cargo: 'Pedido anulado por el cliente', weight_kg: '9000', tractor_id: T2.id });
  issue(can);
}

// ----------------------------------------------------------------------------- vistas (misma forma que la API real)
const userById = (id: string | null | undefined): Row | undefined => users.find((u) => u.id === id);
const vehById = (id: string | null | undefined): Row | undefined => vehicles.find((v) => v.id === id);
const stopsText = (l: Stop[]): string => l.map((s, i) => `${l.length > 1 ? `${i + 1}) ` : ''}${s.party ? `${s.party} — ` : ''}${fullAddress(s)}${s.pallets != null ? ` · ${palLabel(s.pallets)}` : ''}`).join('\n');
const siteOf = (s: Stop): Row | undefined => parties.flatMap((p) => p.sites).find((x: Row) => x.id === s.site_id);
const resolve = (l: Stop[]): Row[] => l.map((s) => { const x = siteOf(s); return { ...s, label: x?.label ?? null, maps_url: x?.lat != null ? `https://www.google.com/maps/search/?api=1&query=${x.lat},${x.lon}` : (x?.map_url ?? null), site_notes: x?.notes ?? null, notes: x?.notes ?? null }; });

function listRow(t: Row): Row {
  const d = userById(t.driver_id);
  return { id: t.id, reference: t.reference, status: t.status, transport_date: t.transport_date, shipper_name: t.shipper.name, origin: stopsText(t.origins).replace(/\n/g, ' · '), destination: stopsText(t.destinations).replace(/\n/g, ' · '),
    cargo: t.cargo, deca_id: t.deca?.id ?? null, driver_user_id: t.driver_id, driver_name: d?.full_name ?? null, tractor: vehById(t.tractor_id)?.plate ?? null, trailer: vehById(t.trailer_id)?.plate ?? null };
}
function detail(t: Row): Row {
  const d = userById(t.driver_id), tr = vehById(t.tractor_id), tl = vehById(t.trailer_id), r = userById(t.relay_id);
  return {
    id: t.id, status: t.status, transport_date: t.transport_date, created_at: t.created_at, category: t.category, shipper: t.shipper, carrier: t.carrier,
    origin: stopsText(t.origins), destination: stopsText(t.destinations), origins: resolve(t.origins), destinations: resolve(t.destinations),
    cargo: t.cargo, weight_kg: t.weight_kg, alt_magnitude: t.alt_magnitude, aec_ref: t.aec_ref, remarks: t.remarks, price_eur: t.price_eur, packages: t.packages,
    load_reference: t.load_reference, temperature: t.temperature, carrier_address: t.carrier_address,
    reference: t.reference, carrier_authorization: t.carrier_authorization, units: t.units, packaging: t.packaging, adr: t.adr === true, adr_detail: t.adr_detail,
    driver: d ? { id: d.id, username: d.username, full_name: d.full_name } : null,
    vehicles: tr ? { tractor: { id: tr.id, plate: tr.plate, kind: tr.kind }, trailer: tl ? { id: tl.id, plate: tl.plate, kind: tl.kind } : null } : null,
    deca: t.deca ? { id: t.deca.id, version: t.deca.version, status: 'ACTIVE', created_at: t.deca.created_at, modified_at: t.deca.modified_at, public_active: true, public_until: null, retain_not_before: null,
      technical: { sha256: t.deca.versions[t.deca.versions.length - 1].sha256, size_bytes: t.deca.versions[t.deca.versions.length - 1].size_bytes, public_url: t.deca.public_url, other_base: false } } : null,
    external_decas: [], relay: r ? { id: r.id, full_name: r.full_name } : null,
    drivers_history: t.history.map((h: Row) => ({ full_name: userById(h.driver_id)?.full_name ?? '—', valid_from: h.valid_from, valid_to: h.valid_to }))
  };
}
const OPEN = ['PENDIENTE', 'EN_CURSO'];
const transportBy = (id: string): Row => { const t = transports.find((x) => x.id === id); if (!t) throw notFound(); return t; };
const openOr409 = (t: Row): void => { if (!OPEN.includes(t.status)) throw new DemoError(409, 'transporte_cerrado'); };
function driverShape(t: Row): Row {
  return { id: t.id, reference: t.reference, status: t.status, transport_date: t.transport_date, shipper: t.shipper.name, origin: stopsText(t.origins), destination: stopsText(t.destinations), cargo: t.cargo, weight_kg: t.weight_kg,
    alt_magnitude: t.alt_magnitude, vehicles: t.tractor_id ? { tractor: vehById(t.tractor_id)?.plate, trailer: vehById(t.trailer_id)?.plate ?? null } : null,
    relay: userById(t.relay_id)?.full_name ?? null, deca: t.deca ? { id: t.deca.id, version: t.deca.version, created_at: t.deca.created_at } : null,
    origins: resolve(t.origins).map((s) => ({ party: s.party, address: fullAddress(s), label: s.label, maps_url: s.maps_url, notes: s.site_notes, time: s.time ?? null, pallets: s.pallets ?? null, references: s.references ?? [], seals: s.seals ?? [] })),
    destinations: resolve(t.destinations).map((s) => ({ party: s.party, address: fullAddress(s), label: s.label, maps_url: s.maps_url, notes: s.site_notes, time: s.time ?? null, pallets: s.pallets ?? null, references: s.references ?? [], seals: s.seals ?? [] })) };
}
/** El DeCA de la demo: mismos datos y mismo generador que la aplicación real, con el rótulo de demostración. */
async function pdfOf(t: Row, opts: { template?: string; banner?: string; logo?: typeof demoLogo } = {}): Promise<Blob> {
  const tpl = opts.template ?? t.deca?.template ?? 'DECARGO';
  const logo = opts.logo !== undefined ? opts.logo : t.deca ? t.deca.logo ?? null : demoLogo;
  const tr = vehById(t.deca?.tractor_id ?? t.tractor_id), tl = vehById(t.deca?.trailer_id ?? t.trailer_id);
  if (!tr) throw new DemoError(409, 'vehicle_required');
  const ids: string[] = Array.from(new Set(t.history.map((h: Row) => h.driver_id as string)));
  const person = (id: string | undefined): DecaData['driver'] => { const u = userById(id); const p = (id && profiles[id]) || {}; return u ? { name: u.full_name, nif: p.nif ?? null, phone: p.phone ?? null } : null; };
  const withDriver = settings.deca_show_driver && tpl !== 'ESTANDAR';
  const data: DecaData = {
    ...buildDecaData({
      shipper_name: t.shipper.name, shipper_nif: t.shipper.nif, shipper_address: t.shipper.address, carrier_name: t.carrier.name, carrier_nif: t.carrier.nif,
      origin: { text: stopsText(t.origins), stops: t.origins }, destination: { text: stopsText(t.destinations), stops: t.destinations },
      cargo_description: t.cargo, weight_kg: t.weight_kg, alt_magnitude: t.alt_magnitude ? { text: t.alt_magnitude } : null, aec_ref: t.aec_ref, transport_date: t.transport_date, remarks: t.remarks,
      price_eur: t.price_eur, carrier_address: t.carrier_address, packages: t.packages, load_reference: t.load_reference, temperature: t.temperature,
      reference: t.reference, carrier_authorization: t.carrier_authorization, units: t.units, packaging: t.packaging, adr: t.adr, adr_detail: t.adr_detail
    }, { tractor: { plate: tr.plate, kind: tr.kind }, trailer: tl ? { plate: tl.plate, kind: tl.kind } : null },
    { companyAddress: fullAddress(company), companyAuthorization: company.transport_authorization ?? null, driver: withDriver ? person(ids[0]) : null }),
    driver2: withDriver && ids.length > 1 ? person(ids[ids.length - 1]) : null,
    vehicleChanges: t.vehicle_changes.map((c: Row) => ({ at: c.at, tractorPlate: c.tractor, trailerPlate: c.trailer ?? null })),
    template: tpl as DecaData['template'], isTest: false
  };
  const gen = tpl === 'CARTA_DE_PORTE' ? generateCartaPdf : tpl === 'DECARGO' ? generateFichasPdf : generateDecaPdf;
  const d = t.deca ?? { id: '00000000-0000-4000-8000-000000000000', version: 1, created_at: new Date().toISOString(), modified_at: new Date().toISOString(), public_url: PUBLIC };
  const bytes = await gen({ decaId: d.id, versionNo: d.version, data, url: d.public_url, createdAt: new Date(d.created_at), modifiedAt: new Date(d.modified_at), isTest: false, banner: opts.banner ?? DEMO_BANNER, logo });
  return new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/pdf' });
}

function expiries(days: number, scope?: { driverId?: string | null; vehicleIds?: string[] }): Row[] {
  const DOCL: Record<string, string> = { ITV: 'ITV', ATP: 'Certificado ATP (isotermo / frigorífico)', CAP: 'CAP (certificado de aptitud profesional)', TARJETA_CONDUCTOR: 'Tarjeta del conductor (tacógrafo digital)', SEGURO_RC: 'Seguro de responsabilidad civil / mercancías (CMR)' };
  const out: Row[] = [];
  for (const d of documents) {
    if (!d.active || !d.expires_on) continue;
    if (scope && !((scope.driverId && d.user_id === scope.driverId) || (d.vehicle_id && scope.vehicleIds?.includes(d.vehicle_id)))) continue;
    const left = daysLeft(d.expires_on); if (left > days) continue;
    out.push({ source: 'document', id: d.id, subject_kind: d.subject_kind, subject: userById(d.user_id)?.full_name ?? vehById(d.vehicle_id)?.plate ?? 'Empresa', user_id: d.user_id, vehicle_id: d.vehicle_id,
      what: d.doc_type === 'OTRO' ? d.label : (DOCL[d.doc_type] ?? d.doc_type), expires_on: d.expires_on, days_left: left, status: left < 0 ? 'CADUCADO' : 'PROXIMO' });
  }
  for (const a of assets) {
    if (!a.active || !a.expires_on) continue;
    if (scope && !scope.vehicleIds?.includes(a.vehicle_id)) continue;
    const left = daysLeft(a.expires_on); if (left > days) continue;
    out.push({ source: 'asset', id: a.id, subject_kind: 'VEHICLE', subject: vehById(a.vehicle_id)?.plate ?? '', user_id: null, vehicle_id: a.vehicle_id, what: `Tarjeta …${String(a.identifier).slice(-4)}`, expires_on: a.expires_on, days_left: left, status: left < 0 ? 'CADUCADO' : 'PROXIMO' });
  }
  return out.sort((x, y) => x.days_left - y.days_left);
}
const docRow = (d: Row): Row => ({ ...d, days_left: d.expires_on ? daysLeft(d.expires_on) : null, updated_at: ts(-1) });
const assetRow = (a: Row): Row => { const { pin, ...rest } = a; return { ...rest, has_pin: !!pin, days_left: a.expires_on ? daysLeft(a.expires_on) : null }; };
const partyRow = (p: Row): Row => { const { sites, ...rest } = p; return { ...rest, sites: sites.filter((s: Row) => s.active).length, nif_check: p.nif ? { kind: 'CIF', valid: true } : null }; };
const siteRow = (s: Row): Row => ({ ...s, maps_url: s.lat != null ? `https://www.google.com/maps/search/?api=1&query=${s.lat},${s.lon}` : s.map_url });
const userRow = (u: Row): Row => ({ ...u, pending_devices: devices.filter((d) => d.user_id === u.id && d.status === 'PENDIENTE_DE_CONFIRMACION').length });
const maskV = (v: string): string => '•'.repeat(Math.max(v.length - 4, 3)) + v.slice(-4);

function config(): Row {
  return { public_base_url: window.location.origin, source: 'web', env_public_base_url: null, error: null, https: true, insecure_allowed: false,
    test_mode: settings.test_mode, test_mode_source: 'web', dev_endpoints: false, dev_endpoints_available: false,
    logo: demoLogo ? { sha256: 'demo', mime: demoLogo.png ? 'image/png' : 'image/jpeg', width: demoLogo.width, height: demoLogo.height, updated_at: demoLogo.at, updated_by: 'demo' } : null,
    deca_show_driver: settings.deca_show_driver, food_transport: settings.food_transport, expiry_warn_days: settings.expiry_warn_days, company: { ...company },
    push_configured: true, fcm: { configured: false, project_id: null, package: 'es.decargo.app', updated_at: null, updated_by: null }, decas_total: transports.filter((t) => t.deca).length, decas_other_base: 0 };
}

// ----------------------------------------------------------------------------- sesión de la demo (sin contraseñas)
export const DEMO_PROFILES = [
  { key: 'admin', label: 'Administración', who: ADMIN.full_name, desc: 'Todo: transportes, conductores, vehículos, empresas, caducidades y configuración.' },
  { key: 'oficina', label: 'Oficina', who: OFICINA.full_name, desc: 'El día a día: preparar transportes, asignar conductores y vehículos.' },
  { key: 'conductor', label: 'Conductor', who: JUAN.full_name, desc: 'La pantalla del teléfono: su transporte, el DeCA, el QR y finalizar.' }
] as const;
let me: Row | null = null;
export function demoLogin(key: string): Row {
  me = key === 'admin' ? ADMIN : key === 'oficina' ? OFICINA : JUAN;
  return { id: me.id, username: me.username, full_name: me.full_name, role: me.role };
}
export function demoLogout(): void { me = null; }

// ----------------------------------------------------------------------------- rutas
type Res = { status: number; body?: unknown; blob?: Blob; text?: string; type?: string };
const ok = (body: unknown, status = 200): Res => ({ status, body });
const none = (): Res => ({ status: 204 });
const NOT_IN_DEMO = (): never => { throw new DemoError(409, 'demo_no_disponible'); };

async function route(method: string, path: string, q: URLSearchParams, b: Row): Promise<Res> {
  const m = (re: RegExp): RegExpMatchArray | null => path.match(re);
  let x: RegExpMatchArray | null;
  if (!me) throw new DemoError(401, 'unauthorized');
  const office = me.role === 'admin' || me.role === 'oficina';
  const officeOnly = (): void => { if (!office) throw new DemoError(403, 'forbidden'); };
  const adminOnly = (): void => { if (me!.role !== 'admin') throw new DemoError(403, 'forbidden'); };

  if (method === 'GET' && path === '/me') return ok({ id: me.id, username: me.username, full_name: me.full_name, role: me.role, scope: 'FULL', mfa_required: false, device: { id: 'demo', status: 'AUTORIZADO' } });
  if (path.startsWith('/auth/')) return none();

  // ---- conductor
  if (path.startsWith('/driver/')) {
    if (me.role !== 'conductor') throw new DemoError(403, 'forbidden');
    const mine = (): Row[] => transports.filter((t) => t.driver_id === me!.id && OPEN.includes(t.status)).sort((a, c) => a.transport_date.localeCompare(c.transport_date));
    if (method === 'GET' && path === '/driver/transports') return ok(mine().map(driverShape));
    if ((x = m(/^\/driver\/transports\/([^/]+)$/)) && method === 'GET') { const t = mine().find((y) => y.id === x![1]); if (!t) throw notFound(); return ok({ ...driverShape(t), external_decas: [] }); }
    if ((x = m(/^\/driver\/transports\/([^/]+)\/(finish|finish-part)$/)) && method === 'POST') {
      const t = mine().find((y) => y.id === x![1]); if (!t) throw notFound();
      const h = t.history.find((y: Row) => !y.valid_to); if (h) h.valid_to = new Date().toISOString();
      if (x[2] === 'finish') { t.status = 'FINALIZADO'; t.finished_at = new Date().toISOString(); t.relay_id = null; return ok({ finished_at: t.finished_at }); }
      const next = t.relay_id; t.relay_id = null; t.driver_id = next;
      if (next) { t.history.push({ driver_id: next, valid_from: new Date().toISOString(), valid_to: null }); t.status = 'EN_CURSO'; } else t.status = 'PENDIENTE';
      return ok({ next_driver: !!next });
    }
    if ((x = m(/^\/driver\/transports\/([^/]+)\/cards$/))) {
      const t = mine().find((y) => y.id === x![1]); if (!t) throw notFound();
      return ok(assets.filter((a) => a.active && [t.tractor_id, t.trailer_id].includes(a.vehicle_id) && a.kind !== 'OTRO').map((a) => ({ id: a.id, kind: a.kind, provider: a.provider, identifier: a.identifier, plate: vehById(a.vehicle_id)?.plate, expires_on: a.expires_on, pin: a.pin })));
    }
    if ((x = m(/^\/driver\/decas\/([^/]+)\/(current\.pdf|qr\.svg)$/))) {
      const t = mine().find((y) => y.deca?.id === x![1]); if (!t) throw notFound();
      return x[2] === 'qr.svg' ? { status: 200, text: await demoQrSvg(t.deca.public_url), type: 'image/svg+xml' } : { status: 200, blob: await pdfOf(t) };
    }
    if (path.startsWith('/driver/push')) throw new DemoError(404, 'demo_no_disponible');
    throw notFound();
  }

  // ---- inicio, transportes y DeCA
  if (method === 'GET' && path === '/dashboard') {
    const counts: Row = { PENDIENTE: 0, EN_CURSO: 0, FINALIZADO: 0, CANCELADO: 0 }; for (const t of transports) counts[t.status]++;
    const e = expiries(settings.expiry_warn_days);
    return ok({ transports: counts, pending_devices: devices.filter((d) => d.status === 'PENDIENTE_DE_CONFIRMACION').length, external_pending_review: 0, company: { name: company.name, nif: company.nif },
      public_base_url: window.location.origin, decas_other_base: 0, expiries: { expired: e.filter((y) => y.status === 'CADUCADO').length, soon: e.filter((y) => y.status === 'PROXIMO').length } });
  }
  if (method === 'GET' && path === '/transports') {
    const st = q.get('status');
    return ok(transports.filter((t) => !st || t.status === st).sort((a, c) => c.transport_date.localeCompare(a.transport_date) || c.created_at.localeCompare(a.created_at)).map(listRow));
  }
  if (method === 'POST' && path === '/transports') {
    officeOnly();
    const stopsIn = (v: unknown, field: string): Stop[] => {
      if (!Array.isArray(v) || !v.length) throw bad(field);
      return v.map((s: Row) => {
        const st: Stop = { party: opt(s.party), address: req(s.address, field, 3), postal_code: opt(s.postal_code), city: opt(s.city), province: opt(s.province), country: opt(s.country),
          party_id: opt(s.party_id), site_id: opt(s.site_id), pallets: s.pallets === undefined || s.pallets === '' ? null : Number(s.pallets),
          references: typeof s.references === 'string' ? s.references.split(',').map((y: string) => y.trim()).filter(Boolean) : [], seals: typeof s.seals === 'string' ? s.seals.split(',').map((y: string) => y.trim()).filter(Boolean) : [],
          time: opt(s.time) };
        if (st.time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(st.time)) throw bad('time');
        if (!st.city && !/,\s*[^\d,]{2,}$/.test(st.address)) throw new DemoError(400, 'localidad_requerida', { field });
        return st;
      });
    };
    const origins = stopsIn(b.origins, 'origins'), destinations = stopsIn(b.destinations, 'destinations');
    const date = req(b.transport_date, 'transport_date', 10), cargo = req(b.cargo, 'cargo', 3);
    if (!opt(b.weight_kg) && !opt(b.alt_magnitude)) throw bad('weight_kg');
    const generate = b.generate_deca !== false;
    if (generate && !b.tractor_id) throw bad('tractor_id');
    const loaded = origins.reduce((a, s) => a + (s.pallets ?? 0), 0);
    const units = b.units === undefined || b.units === null || b.units === '' ? null : Number(b.units);
    if (units !== null && (!Number.isInteger(units) || units < 0 || units > 999999)) throw bad('units');
    const packaging = opt(b.packaging), adr = b.adr === true, carrierAuth = opt(b.carrier_authorization);
    let packages = opt(b.packages); if (packages && /^\d+$/.test(packages)) packages = palLabel(Number(packages));
    if (!packages && units !== null) packages = `${units} ${packaging ?? (units === 1 ? 'bulto' : 'bultos')}`;
    if (!packages && loaded) packages = palLabel(loaded);
    const other = !!opt(b.carrier_name);
    const t: Row = { id: uid(), created_at: new Date().toISOString(), transport_date: date, category: 'PUBLICO', status: b.driver_id ? 'EN_CURSO' : 'PENDIENTE',
      shipper: { name: req(b.shipper_name, 'shipper_name', 2), nif: req(b.shipper_nif, 'shipper_nif', 5), address: fullAddress({ address: opt(b.shipper_address), postal_code: opt(b.shipper_postal_code), city: opt(b.shipper_city), province: opt(b.shipper_province), country: opt(b.shipper_country) }) },
      carrier: other ? { name: b.carrier_name, nif: req(b.carrier_nif, 'carrier_nif', 5) } : { name: company.name, nif: company.nif },
      carrier_address: other ? fullAddress({ address: opt(b.carrier_address), postal_code: opt(b.carrier_postal_code), city: opt(b.carrier_city), province: opt(b.carrier_province), country: opt(b.carrier_country) }) : fullAddress(company),
      origins, destinations, cargo, weight_kg: opt(b.weight_kg), alt_magnitude: opt(b.alt_magnitude), aec_ref: opt(b.aec_ref), remarks: opt(b.remarks), price_eur: opt(b.price_eur), packages,
      load_reference: opt(b.load_reference), temperature: opt(b.temperature), driver_id: opt(b.driver_id), relay_id: null, history: b.driver_id ? [{ driver_id: b.driver_id, valid_from: new Date().toISOString(), valid_to: null }] : [],
      tractor_id: opt(b.tractor_id), trailer_id: opt(b.trailer_id), deca: null, vehicle_changes: [],
      reference: nextRef(), carrier_authorization: other ? carrierAuth : null, units, packaging, adr, adr_detail: adr ? opt(b.adr_detail) : null };
    if (generate) issue(t);
    transports.push(t);
    // La agenda aprende las empresas nuevas (como en la aplicación real)
    for (const s of [...origins, ...destinations]) if (s.party && !s.party_id && !parties.some((p) => p.name.toLowerCase() === s.party!.toLowerCase())) parties.push(party(s.party, null, s.address, s.postal_code ?? '', s.city ?? '', [{ address: s.address, kind: 'AMBOS' }]));
    return ok({ id: t.id, reference: t.reference, deca_id: t.deca?.id ?? null, registered: { parties: 0, sites: 0 } }, 201);
  }
  if ((x = m(/^\/transports\/([^/]+)$/)) && method === 'GET') return ok(detail(transportBy(x[1])));
  if ((x = m(/^\/transports\/([^/]+)\/deca$/)) && method === 'POST') {
    officeOnly(); const t = transportBy(x[1]); openOr409(t);
    if (t.deca) throw new DemoError(409, 'deca_exists'); if (!t.tractor_id) throw new DemoError(409, 'vehicle_required');
    issue(t); return ok({ deca_id: t.deca.id }, 201);
  }
  if ((x = m(/^\/transports\/([^/]+)\/vehicles$/)) && method === 'PUT') {
    officeOnly(); const t = transportBy(x[1]); if (t.deca) throw new DemoError(409, 'deca_emitido');
    t.tractor_id = req(b.tractor_id, 'tractor_id'); t.trailer_id = opt(b.trailer_id); return none();
  }
  if ((x = m(/^\/transports\/([^/]+)\/vehicle-change$/)) && method === 'POST') {
    officeOnly(); const t = transportBy(x[1]); openOr409(t);
    const tr = req(b.tractor_id, 'tractor_id'), tl = opt(b.trailer_id);
    if (tr === t.tractor_id && tl === t.trailer_id) throw new DemoError(409, 'sin_cambios');
    t.tractor_id = tr; t.trailer_id = tl;
    if (t.deca) { t.vehicle_changes.push({ at: new Date().toISOString(), tractor: vehById(tr)?.plate, trailer: vehById(tl)?.plate ?? null }); newVersion(t, 'Cambio de vehículo'); }
    return ok({ deca_version: t.deca?.version ?? null });
  }
  if ((x = m(/^\/transports\/([^/]+)\/cancel$/)) && method === 'POST') {
    officeOnly(); const t = transportBy(x[1]); if (t.status === 'CANCELADO') throw new DemoError(409, 'ya_anulado'); openOr409(t);
    req(b.reason, 'reason', 3); t.status = 'CANCELADO'; t.relay_id = null; return none();
  }
  if ((x = m(/^\/transports\/([^/]+)\/assign-driver$/)) && method === 'POST') {
    officeOnly(); const t = transportBy(x[1]); openOr409(t);
    const d = userById(b.driver_id); if (!d || d.role !== 'conductor' || !d.active) throw notFound();
    if (b.relay === true && t.driver_id) { if (t.driver_id === d.id) throw new DemoError(409, 'relevo_mismo_conductor'); t.relay_id = d.id; return none(); }
    const h = t.history.find((y: Row) => !y.valid_to); if (h) h.valid_to = new Date().toISOString();
    const changed = t.driver_id !== d.id;
    t.driver_id = d.id; t.history.push({ driver_id: d.id, valid_from: new Date().toISOString(), valid_to: null }); if (t.relay_id === d.id) t.relay_id = null;
    if (t.status === 'PENDIENTE') t.status = 'EN_CURSO';
    if (changed && t.deca && (t.deca.template === 'CARTA_DE_PORTE' || t.deca.template === 'DECARGO') && settings.deca_show_driver) newVersion(t, 'Se asigna el conductor');
    return none();
  }
  if ((x = m(/^\/transports\/([^/]+)\/relay$/)) && method === 'DELETE') { officeOnly(); transportBy(x[1]).relay_id = null; return none(); }
  const withDeca = (id: string): Row => { const t = transports.find((y) => y.deca?.id === id); if (!t) throw notFound(); return t; };
  if ((x = m(/^\/decas\/([^/]+)$/)) && method === 'GET') { const t = withDeca(x[1]); return ok({ id: t.deca.id, status: 'ACTIVE', current_version: t.deca.version, public_active: true, public_until: null, retain_not_before: null, created_at: t.deca.created_at, versions: t.deca.versions.map((v: Row) => ({ ...v, pdf_created: t.deca.created_at, pdf_modified: v.created_at })) }); }
  if ((x = m(/^\/decas\/([^/]+)\/versions\/\d+\/pdf$/))) return { status: 200, blob: await pdfOf(withDeca(x[1])) };
  if ((x = m(/^\/decas\/([^/]+)\/qr\.svg$/))) return { status: 200, text: await demoQrSvg(withDeca(x[1]).deca.public_url), type: 'image/svg+xml' };
  if ((x = m(/^\/admin\/decas\/([^/]+)\/reissue$/)) && method === 'POST') { adminOnly(); const t = withDeca(x[1]); req(b.reason, 'reason', 3); issue(t); return ok({ deca_id: t.deca.id }, 201); }
  if (path === '/admin/decas/reissue-outdated') return ok({ reissued: 0, failed: 0, total: 0 });

  // ---- vehículos, tarjetas
  if (method === 'GET' && path === '/vehicles') {
    const act = q.get('active'), kinds = q.get('kind')?.split(',');
    const inUse = (v: Row): boolean => transports.some((t) => t.tractor_id === v.id || t.trailer_id === v.id);
    return ok(vehicles.filter((v) => (act === null || String(v.active) === act) && (!kinds || kinds.includes(v.kind))).map((v) => ({ ...v, in_use: inUse(v) })));
  }
  if (method === 'POST' && path === '/vehicles') {
    officeOnly(); const plate = req(b.plate, 'plate', 4).toUpperCase(); if (!['TRACTORA', 'SEMIRREMOLQUE', 'REMOLQUE', 'RIGIDO'].includes(b.kind)) throw bad('kind');
    if (vehicles.some((v) => v.plate.replace(/[\s-]/g, '') === plate.replace(/[\s-]/g, ''))) throw new DemoError(409, 'plate_taken');
    const v = { id: uid(), plate, kind: b.kind, active: true, created_at: new Date().toISOString() }; vehicles.push(v); return ok(v, 201);
  }
  if ((x = m(/^\/vehicles\/([^/]+)$/))) {
    const v = vehById(x[1]); if (!v) throw notFound();
    if (method === 'GET') return ok({ ...v, in_use: false });
    if (method === 'PATCH') { officeOnly(); if (b.plate !== undefined) v.plate = req(b.plate, 'plate', 4).toUpperCase(); if (b.kind !== undefined) v.kind = b.kind; if (typeof b.active === 'boolean') v.active = b.active; return ok(v); }
  }
  if ((x = m(/^\/vehicles\/([^/]+)\/assets$/))) {
    if (method === 'GET') return ok(assets.filter((a) => a.vehicle_id === x![1] && (q.get('all') === '1' || a.active)).map(assetRow));
    officeOnly(); const a = { id: uid(), vehicle_id: x[1], kind: b.kind, provider: opt(b.provider), identifier: req(b.identifier, 'identifier', 3), pin: opt(b.pin), expires_on: opt(b.expires_on), notes: opt(b.notes), active: true };
    assets.push(a); return ok(assetRow(a), 201);
  }
  if ((x = m(/^\/assets\/([^/]+)(\/reveal-pin)?$/))) {
    officeOnly(); const a = assets.find((y) => y.id === x![1]); if (!a) throw notFound();
    if (x[2]) { if (!a.pin) throw new DemoError(404, 'sin_pin'); return ok({ pin: a.pin }); }
    for (const k of ['provider', 'identifier', 'expires_on', 'notes', 'pin']) if (k in b) a[k] = opt(b[k]);
    if (typeof b.active === 'boolean') a.active = b.active; return ok(assetRow(a));
  }

  // ---- conductores y dispositivos
  if (method === 'GET' && path === '/users') { officeOnly(); return ok(users.filter((u) => me!.role === 'admin' || u.role === 'conductor').map(userRow)); }
  if (method === 'POST' && path === '/users') {
    officeOnly(); const username = req(b.username, 'username', 3).toLowerCase(); if (users.some((u) => u.username === username)) throw new DemoError(409, 'username_taken');
    const u = { id: uid(), username, full_name: req(b.full_name, 'full_name', 2), role: b.role ?? 'conductor', active: true, pending_activation: true, totp_enabled: false, created_at: new Date().toISOString() };
    users.push(u); { const c = `DEMO-${fake(4).toUpperCase()}-${fake(4).toUpperCase()}`; return ok({ id: u.id, username, role: u.role, activation_code: c, activation_expires_at: ts(7), activation_url: demoActivationUrl(username, c) }, 201); }
  }
  if ((x = m(/^\/users\/([^/]+)\/(activation|deactivate|reactivate)$/)) && method === 'POST') {
    officeOnly(); const u = userById(x[1]); if (!u) throw notFound();
    if (x[2] === 'activation') { const c = `DEMO-${fake(4).toUpperCase()}-${fake(4).toUpperCase()}`; return ok({ activation_code: c, activation_expires_at: ts(7), activation_url: demoActivationUrl(u.username, c) }); }
    u.active = x[2] === 'reactivate'; return none();
  }
  if ((x = m(/^\/users\/([^/]+)\/profile(\/reveal)?$/))) {
    officeOnly(); const u = userById(x[1]); if (!u || u.role !== 'conductor') throw notFound(); const p = (profiles[u.id] ??= {});
    if (x[2]) { const v = p[b.field]; if (!v) throw notFound(); return ok({ value: v }); }
    if (method === 'PUT') { if (b.full_name) u.full_name = b.full_name; for (const [k, v] of Object.entries(b)) if (k !== 'full_name') p[k] = v; }
    const plain: Row = {}; for (const k of ['birth_date', 'nationality', 'phone', 'email', 'street', 'postal_code', 'city', 'province', 'country', 'hire_date', 'contract_type', 'job_category', 'emergency_name', 'emergency_phone', 'iban_holder', 'notes']) plain[k] = p[k] ?? null;
    const sec = (v: string | undefined): Row => ({ set: !!v, masked: v ? maskV(v) : null });
    return ok({ user: { id: u.id, username: u.username, full_name: u.full_name, active: u.active }, profile: { ...plain, nif: sec(p.nif), ss: sec(p.ss), iban: { ...sec(p.iban), country: p.iban ? 'España' : null, bank: p.iban ? 'Banco de ejemplo' : null, bank_code: null, valid: p.iban ? true : null }, updated_at: ts(-1) } });
  }
  if (method === 'POST' && path === '/iban/check') { const v = String(b.iban ?? '').replace(/\s/g, '').toUpperCase(); return ok(/^ES\d{22}$/.test(v) ? { valid: true, country: 'España', bank: 'Banco de ejemplo (demostración)', bank_code: v.slice(4, 8), formatted: v.replace(/(.{4})/g, '$1 ').trim() } : { valid: false, reason: 'formato' }); }
  if (method === 'POST' && path === '/taxid/check') { const v = String(b.nif ?? '').replace(/[\s.-]/g, '').toUpperCase(); return ok({ kind: /^\d{8}[A-Z]$/.test(v) ? 'DNI' : /^[XYZ]/.test(v) ? 'NIE' : /^[A-Z]\d{7}/.test(v) ? 'CIF' : 'OTRO', valid: v.length >= 9 ? true : null, normalized: v }); }
  if (method === 'GET' && path === '/devices') {
    officeOnly(); const st = q.get('status'), u = q.get('user_id');
    return ok(devices.filter((d) => (!st || d.status === st) && (!u || d.user_id === u)).map((d) => { const us = userById(d.user_id)!; return { ...d, username: us.username, role: us.role }; }));
  }
  if ((x = m(/^\/devices\/([^/]+)\/(authorize|revoke|push-test)$/)) && method === 'POST') {
    officeOnly(); const d = devices.find((y) => y.id === x![1]); if (!d) throw notFound();
    if (x[2] === 'push-test') NOT_IN_DEMO();
    d.status = x[2] === 'authorize' ? 'AUTORIZADO' : 'REVOCADO'; d.decided_at = new Date().toISOString(); return none();
  }

  // ---- documentos y caducidades
  if (method === 'GET' && path === '/documents/catalog') {
    const { DOCS } = await import('./catalog');
    const by = (s: string): Row[] => DOCS.filter((t) => t.subject === s && (settings.food_transport || !t.food));
    return ok({ food_transport: settings.food_transport, warn_days: settings.expiry_warn_days, driver: by('DRIVER'), vehicle: by('VEHICLE'), company: by('COMPANY'), assets: (await import('./catalog')).ASSETS });
  }
  if (method === 'GET' && path === '/documents') {
    const all = q.get('all') === '1', u = q.get('user_id'), v = q.get('vehicle_id'), c = q.get('company') === '1';
    return ok(documents.filter((d) => (all || d.active) && ((u && d.user_id === u) || (v && d.vehicle_id === v) || (c && d.subject_kind === 'COMPANY'))).map(docRow));
  }
  if (method === 'POST' && path === '/documents') {
    officeOnly(); const d = { id: uid(), subject_kind: b.subject_kind, user_id: opt(b.user_id), vehicle_id: opt(b.vehicle_id), doc_type: req(b.doc_type, 'doc_type'), label: opt(b.label), number: opt(b.number), detail: opt(b.detail), issued_on: opt(b.issued_on), expires_on: opt(b.expires_on), notes: opt(b.notes), active: true };
    if (d.issued_on && d.expires_on && d.expires_on < d.issued_on) throw bad('expires_on');
    documents.push(d); return ok(docRow(d), 201);
  }
  if ((x = m(/^\/documents\/([^/]+)$/)) && method === 'PATCH') {
    officeOnly(); const d = documents.find((y) => y.id === x![1]); if (!d) throw notFound();
    for (const k of ['label', 'number', 'detail', 'issued_on', 'expires_on', 'notes']) if (k in b) d[k] = opt(b[k]);
    if (typeof b.active === 'boolean') d.active = b.active; return ok(docRow(d));
  }
  if (method === 'GET' && path === '/expiries') return ok(expiries(q.get('days') ? Number(q.get('days')) : settings.expiry_warn_days));
  if (method === 'GET' && path === '/expiries/check') return ok(expiries(settings.expiry_warn_days, { driverId: q.get('driver_id'), vehicleIds: [q.get('tractor_id'), q.get('trailer_id')].filter((y): y is string => !!y) }));

  // ---- agenda
  if (method === 'GET' && path === '/parties') {
    const term = (q.get('q') ?? '').toLowerCase(), all = q.get('all') === '1';
    return ok(parties.filter((p) => (all || p.active) && (!term || p.name.toLowerCase().includes(term) || (p.nif ?? '').toLowerCase().startsWith(term))).slice(0, 25).map(partyRow));
  }
  if (method === 'POST' && path === '/parties') {
    officeOnly(); const name = req(b.name, 'name', 2);
    const p = party(name, opt(b.nif)?.toUpperCase() ?? null, opt(b.address) ?? '', opt(b.postal_code) ?? '', opt(b.city) ?? '', []);
    p.province = opt(b.province); p.country = opt(b.country) ?? 'España'; p.notes = opt(b.notes); p.transport_authorization = opt(b.transport_authorization); p.use_count = 0; parties.push(p); return ok(partyRow(p), 201);
  }
  if ((x = m(/^\/parties\/([^/]+)$/))) {
    const p = parties.find((y) => y.id === x![1]); if (!p) throw notFound();
    if (method === 'PATCH') { officeOnly(); for (const k of ['name', 'nif', 'transport_authorization', 'address', 'postal_code', 'city', 'province', 'country', 'notes']) if (k in b) p[k] = opt(b[k]); if (typeof b.active === 'boolean') p.active = b.active; return ok(partyRow(p)); }
    return ok({ ...partyRow(p), sites: p.sites.filter((s: Row) => q.get('all') === '1' || s.active).map(siteRow) });
  }
  if ((x = m(/^\/parties\/([^/]+)\/sites$/)) && method === 'POST') {
    officeOnly(); const p = parties.find((y) => y.id === x![1]); if (!p) throw notFound();
    const s = { id: uid(), label: opt(b.label), kind: b.kind ?? 'AMBOS', address: req(b.address, 'address', 3), postal_code: opt(b.postal_code), city: opt(b.city), province: opt(b.province), country: opt(b.country),
      lat: b.lat ? Number(b.lat) : null, lon: b.lon ? Number(b.lon) : null, map_url: opt(b.map_url), notes: opt(b.notes), active: true };
    p.sites.push(s); return ok(siteRow(s), 201);
  }
  if ((x = m(/^\/sites\/([^/]+)$/)) && method === 'PATCH') {
    officeOnly(); const s = parties.flatMap((p) => p.sites).find((y: Row) => y.id === x![1]); if (!s) throw notFound();
    for (const k of ['label', 'kind', 'address', 'postal_code', 'city', 'province', 'country', 'map_url', 'notes']) if (k in b) s[k] = opt(b[k]);
    if ('lat' in b) s.lat = b.lat ? Number(b.lat) : null; if ('lon' in b) s.lon = b.lon ? Number(b.lon) : null; if (typeof b.active === 'boolean') s.active = b.active; return ok(siteRow(s));
  }

  // ---- configuración (administración)
  if (path.startsWith('/admin/config')) {
    adminOnly();
    if (method === 'GET' && path === '/admin/config') return ok(config());
    if (path === '/admin/config/company') { Object.assign(company, { transport_authorization: opt(b.transport_authorization), name: req(b.name, 'name', 2), nif: req(b.nif, 'nif', 5), address: req(b.address, 'address', 3), postal_code: opt(b.postal_code), city: opt(b.city), province: opt(b.province), country: opt(b.country) }); return ok(config()); }
    if (path === '/admin/config/template') { if (b.template !== undefined && b.template !== 'DECARGO') throw bad('template'); if (typeof b.show_driver === 'boolean') settings.deca_show_driver = b.show_driver; return ok(config()); }
    if (path === '/admin/config/documents') { if (typeof b.food_transport === 'boolean') settings.food_transport = b.food_transport; if (b.warn_days) settings.expiry_warn_days = Number(b.warn_days); return ok(config()); }
    if (path === '/admin/config/flags') { if (typeof b.test_mode === 'boolean') settings.test_mode = b.test_mode; return ok(config()); }
    if (path.startsWith('/admin/config/template-preview')) {
      const t = transports.find((y) => y.deca) ?? transports[0];
      return { status: 200, blob: await pdfOf(t, { template: 'DECARGO', logo: demoLogo, banner: 'MODELO DE EJEMPLO · DATOS FICTICIOS · SIN VALOR' }) };
    }
    if (path === '/admin/config/logo' && method === 'GET') {
      if (!demoLogo) throw new DemoError(404, 'sin_logo');
      return { status: 200, blob: new Blob([demoLogo.bytes as Uint8Array<ArrayBuffer>], { type: demoLogo.png ? 'image/png' : 'image/jpeg' }) };
    }
    if (path === '/admin/config/logo' && method === 'PUT') {
      if (b.data === null) { demoLogo = null; return ok(config()); }
      const bytes = Uint8Array.from(atob(String(b.data ?? '')), (ch) => ch.charCodeAt(0));
      const png = bytes[0] === 0x89 && bytes[1] === 0x50, jpg = bytes[0] === 0xff && bytes[1] === 0xd8;
      if (!png && !jpg) throw new DemoError(400, 'logo_invalido');
      const bmp = await createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>]));
      demoLogo = { bytes, png, width: bmp.width, height: bmp.height, at: new Date().toISOString() }; bmp.close();
      return ok(config());
    }
    NOT_IN_DEMO();
  }
  if (path.startsWith('/external-decas') || path.startsWith('/push-test')) NOT_IN_DEMO();
  NOT_IN_DEMO();
  throw notFound();
}

/** Punto de entrada: lo llama api.ts en lugar de fetch cuando la aplicación está en modo demostración. */
export async function demoFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const u = new URL(path, 'http://demo');
  let body: Row = {};
  try { if (typeof init.body === 'string') body = JSON.parse(init.body); } catch { /* sin cuerpo */ }
  await new Promise((r) => setTimeout(r, 120));   // como si hubiera red
  try {
    const r = await route((init.method ?? 'GET').toUpperCase(), u.pathname, u.searchParams, body);
    if (r.status === 204) return new Response(null, { status: 204 });
    if (r.blob) return new Response(r.blob, { status: r.status, headers: { 'content-type': 'application/pdf' } });
    if (r.text !== undefined) return new Response(new Blob([r.text], { type: r.type ?? 'text/plain' }), { status: r.status, headers: { 'content-type': r.type ?? 'text/plain' } });
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status, headers: { 'content-type': 'application/json' } });
  } catch (e) {
    const d = e instanceof DemoError ? e : new DemoError(500, 'error');
    if (!(e instanceof DemoError)) console.error('[demo]', e);
    return new Response(JSON.stringify({ error: d.code, ...d.extra }), { status: d.status, headers: { 'content-type': 'application/json' } });
  }
}
