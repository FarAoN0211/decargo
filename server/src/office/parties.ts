import type { Pool, PoolClient } from 'pg';
import { appendAudit } from '../common/audit';
import { Actor, ApiError, actorStr } from '../identity/service';
import { checkTaxId, normTaxId } from './taxid';
import { addrParts, UUID_RE, bad, optMultiline, optText, text, type Stop, type StopLocation } from './validate';
import { fullAddress, sameStreet } from './address';

/** Texto en minúsculas, sin acentos ni signos, para buscar sin importar tildes ni mayúsculas. */
export const normName = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// ----------------------------------------------------------------------------- enlaces de mapa
const MAP_HOSTS = ['google.com', 'google.es', 'maps.google.com', 'maps.app.goo.gl', 'goo.gl', 'maps.apple.com', 'waze.com', 'ul.waze.com', 'openstreetmap.org', 'bing.com'];
const hostOk = (h: string): boolean => MAP_HOSTS.some((m) => h === m || h.endsWith(`.${m}`));

/** Valida un enlace de mapa (https y proveedor conocido: no se envía a un conductor un enlace cualquiera). */
export function mapUrl(v: unknown, field = 'map_url'): string | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || v.length > 600 || /[\u0000- \u007f-\u009f\\]/.test(v)) throw bad(field);
  let u: URL;
  try { u = new URL(v); } catch { throw bad(field); }
  if (u.protocol !== 'https:' || u.username || u.password || !hostOk(u.hostname)) throw bad(field);
  return u.toString();
}

/** Coordenadas contenidas en un enlace largo de mapa (si las hay). Los enlaces cortos no se resuelven (no se hacen peticiones a terceros). */
export function coordsFromUrl(url: string): { lat: number; lon: number } | null {
  const pats = [/@(-?\d{1,2}\.\d+),(-?\d{1,3}\.\d+)/, /!3d(-?\d{1,2}\.\d+)!4d(-?\d{1,3}\.\d+)/, /[?&](?:q|query|ll|destination|center|mlat)=(-?\d{1,2}\.\d+)(?:,|&mlon=)(-?\d{1,3}\.\d+)/];
  for (const p of pats) { const m = p.exec(decodeURIComponent(url)); if (m) { const lat = Number(m[1]), lon = Number(m[2]); if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) return { lat, lon }; } }
  return null;
}

/** Enlace para llegar al lugar: con coordenadas, la ruta en Google Maps; si no, el enlace guardado. */
export const mapsLink = (s: { lat: string | number | null; lon: string | number | null; map_url: string | null }): string | null =>
  s.lat !== null && s.lon !== null ? `https://www.google.com/maps/dir/?api=1&destination=${Number(s.lat)},${Number(s.lon)}` : s.map_url;

// ----------------------------------------------------------------------------- empresas
const PARTY_COLS = `p.id, p.name, p.nif, p.transport_authorization, p.address, p.postal_code, p.city, p.province, p.country, p.notes, p.active, p.use_count, p.last_used_at, (SELECT count(*)::int FROM party_site s WHERE s.party_id = p.id AND s.active) AS sites`;
const shapeParty = (r: Record<string, any>) => ({ ...r, nif_check: r.nif ? (({ kind, valid }) => ({ kind, valid }))(checkTaxId(r.nif)) : null });

async function companyId(pool: Pool): Promise<string> {
  const co = (await pool.query('SELECT id FROM company ORDER BY created_at LIMIT 1')).rows[0];
  if (!co) throw new ApiError(409, 'no_company');
  return co.id;
}

export async function searchParties(pool: Pool, q: string | undefined, all = false) {
  const term = normName(q ?? '');
  const taxTerm = normTaxId(q ?? '');
  const like = (s: string): string => s.replace(/[\\%_]/g, '\\$&');
  const rows = (await pool.query(
    `SELECT ${PARTY_COLS} FROM party p WHERE ($3::boolean OR p.active)
       AND ($1 = '' OR p.name_norm LIKE '%' || $1 || '%' ESCAPE '\\' OR ($2 <> '' AND p.nif LIKE $2 || '%' ESCAPE '\\'))
     ORDER BY ($1 <> '' AND p.name_norm LIKE $1 || '%' ESCAPE '\\') DESC, p.last_used_at DESC NULLS LAST, p.name_norm LIMIT 25`,
    [like(term), taxTerm.length >= 3 ? like(taxTerm) : '', all])).rows;
  return rows.map(shapeParty);
}

export async function getParty(pool: Pool, id: string, all = false) {
  if (!UUID_RE.test(id)) throw new ApiError(404, 'no_encontrado');
  const p = (await pool.query(`SELECT ${PARTY_COLS} FROM party p WHERE p.id = $1`, [id])).rows[0];
  if (!p) throw new ApiError(404, 'no_encontrado');
  const sites = (await pool.query(
    `SELECT id, label, kind, address, postal_code, city, province, country, lat::float8 AS lat, lon::float8 AS lon, map_url, notes, active FROM party_site WHERE party_id = $1 ${all ? '' : 'AND active'} ORDER BY active DESC, label NULLS LAST, address`, [id])).rows;
  return { ...shapeParty(p), sites: sites.map((s) => ({ ...inheritFromParty(s, p), maps_url: mapsLink(s) })) };
}

/** Un lugar sin código postal/localidad/provincia/país toma los de su empresa si están en la misma calle (no se guarda: se calcula al leer). */
function inheritFromParty<T extends { address?: string | null; postal_code?: string | null; city?: string | null; province?: string | null; country?: string | null }>(s: T, p: { address?: string | null; postal_code?: string | null; city?: string | null; province?: string | null; country?: string | null }): T {
  if (!sameStreet(s.address, p.address)) return s;
  return { ...s, postal_code: s.postal_code || p.postal_code || null, city: s.city || p.city || null, province: s.province || p.province || null, country: s.country || p.country || null };
}

function partyFields(b: Record<string, unknown>, partial: boolean) {
  const o: Record<string, unknown> = {};
  if (!partial || 'name' in b) { o.name = text(b.name, 'name', 2, 120); o.name_norm = normName(o.name as string); }
  if (!partial || 'nif' in b) {
    if (b.nif === undefined || b.nif === null || b.nif === '') o.nif = null;
    else { if (typeof b.nif !== 'string') throw bad('nif'); const n = normTaxId(b.nif); if (!/^[A-Z0-9]{5,16}$/.test(n)) throw bad('nif'); o.nif = n; }
  }
  if (!partial || 'address' in b) o.address = optText(b.address, 'address', 200);
  if (!partial || 'transport_authorization' in b) { const a = optText(b.transport_authorization, 'transport_authorization', 30); if (a !== null && !/^[A-Za-z0-9 ./-]{3,30}$/.test(a)) throw bad('transport_authorization'); o.transport_authorization = a; }
  for (const k of ['postal_code', 'city', 'province', 'country'] as const) if (!partial || k in b) o[k] = addrParts({ [k]: b[k] }, k)[k];
  if (!partial || 'notes' in b) o.notes = optMultiline(b.notes, 'notes', 500);
  if ('active' in b) { if (typeof b.active !== 'boolean') throw bad('active'); o.active = b.active; }
  return o;
}

export async function createParty(pool: Pool, actor: Actor, b: Record<string, unknown>) {
  const f = partyFields(b, false);
  const co = await companyId(pool);
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    if (f.nif) {
      const ex = (await c.query('SELECT id FROM party WHERE company_id = $1 AND nif = $2', [co, f.nif])).rows[0];
      if (ex) throw new ApiError(409, 'party_exists', { id: ex.id });
    }
    const id = (await c.query(`INSERT INTO party (company_id, name, name_norm, nif, address, postal_code, city, province, country, notes, transport_authorization, created_by, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$12,$11,$11) RETURNING id`,
      [co, f.name, f.name_norm, f.nif, f.address, f.postal_code, f.city, f.province, f.country, f.notes, actorStr(actor), f.transport_authorization ?? null])).rows[0].id;
    await appendAudit(c, { company_id: co, at: new Date(), actor: actorStr(actor), action: 'PARTY_CREATED', entity: 'party', entity_id: id, before: null, after: { name: f.name as string, nif: (f.nif as string) ?? '' }, reason: null });
    await c.query('COMMIT');
    return getParty(pool, id);
  } catch (e) { try { await c.query('ROLLBACK'); } catch { /* */ } throw e; } finally { c.release(); }
}

export async function updateParty(pool: Pool, actor: Actor, id: string, b: Record<string, unknown>) {
  if (!UUID_RE.test(id)) throw new ApiError(404, 'no_encontrado');
  const f = partyFields(b, true);
  const cols = Object.keys(f);
  if (!cols.length) throw bad('name');
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const p = (await c.query('SELECT id, company_id, name, nif FROM party WHERE id = $1', [id])).rows[0];
    if (!p) throw new ApiError(404, 'no_encontrado');
    if (f.nif) { const ex = (await c.query('SELECT id FROM party WHERE company_id = $1 AND nif = $2 AND id <> $3', [p.company_id, f.nif, id])).rows[0]; if (ex) throw new ApiError(409, 'party_exists', { id: ex.id }); }
    await c.query(`UPDATE party SET ${cols.map((k, i) => `${k} = $${i + 3}`).join(', ')}, updated_at = now(), updated_by = $2 WHERE id = $1`, [id, actorStr(actor), ...cols.map((k) => f[k])]);
    await appendAudit(c, { company_id: p.company_id, at: new Date(), actor: actorStr(actor), action: f.active === false ? 'PARTY_ARCHIVED' : 'PARTY_UPDATED', entity: 'party', entity_id: id, before: { name: p.name, nif: p.nif ?? '' }, after: { fields: cols.join(',') }, reason: null });
    await c.query('COMMIT');
    return getParty(pool, id, true);
  } catch (e) { try { await c.query('ROLLBACK'); } catch { /* */ } throw e; } finally { c.release(); }
}

// ----------------------------------------------------------------------------- lugares
const KINDS = ['CARGA', 'DESCARGA', 'AMBOS', 'SEDE'];
function coord(v: unknown, field: string, lim: number): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.'));
  if (!Number.isFinite(n) || Math.abs(n) > lim) throw bad(field);
  return Math.round(n * 1e6) / 1e6;
}

function siteFields(b: Record<string, unknown>, partial: boolean) {
  const o: Record<string, unknown> = {};
  if (!partial || 'address' in b) o.address = text(b.address, 'address', 3, 200);
  if ('label' in b || !partial) o.label = optText(b.label, 'label', 80);
  if ('kind' in b || !partial) { const k = b.kind ?? 'AMBOS'; if (!KINDS.includes(k as string)) throw bad('kind'); o.kind = k; }
  if ('notes' in b || !partial) o.notes = optMultiline(b.notes, 'notes', 500);
  for (const k of ['postal_code', 'city', 'province', 'country'] as const) if (!partial || k in b) o[k] = addrParts({ [k]: b[k] }, k)[k];
  if ('active' in b) { if (typeof b.active !== 'boolean') throw bad('active'); o.active = b.active; }
  if ('map_url' in b || !partial) o.map_url = mapUrl(b.map_url);
  if ('lat' in b || 'lon' in b || !partial) {
    let lat = coord(b.lat, 'lat', 90), lon = coord(b.lon, 'lon', 180);
    if ((lat === null) !== (lon === null)) throw bad(lat === null ? 'lat' : 'lon');
    if (lat === null && typeof o.map_url === 'string') { const c = coordsFromUrl(o.map_url); if (c) { lat = c.lat; lon = c.lon; } }   // si el enlace trae coordenadas, se usan
    o.lat = lat; o.lon = lon;
  }
  return o;
}

/** Clave para reconocer un lugar ya guardado: la dirección y la localidad sin tildes ni signos. */
export const siteNorm = (address: string, city?: string | null): string => normName(`${address} ${city ?? ''}`);

export async function createSite(pool: Pool, actor: Actor, partyId: string, b: Record<string, unknown>) {
  if (!UUID_RE.test(partyId)) throw new ApiError(404, 'no_encontrado');
  const f = siteFields(b, false);
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const p = (await c.query('SELECT id, company_id FROM party WHERE id = $1', [partyId])).rows[0];
    if (!p) throw new ApiError(404, 'no_encontrado');
    const id = (await c.query(`INSERT INTO party_site (party_id, label, kind, address, address_norm, postal_code, city, province, country, lat, lon, map_url, notes, created_by, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14) RETURNING id`,
      [partyId, f.label, f.kind, f.address, siteNorm(f.address as string, f.city as string | null), f.postal_code, f.city, f.province, f.country, f.lat, f.lon, f.map_url, f.notes, actorStr(actor)])).rows[0].id;
    await appendAudit(c, { company_id: p.company_id, at: new Date(), actor: actorStr(actor), action: 'PARTY_SITE_CREATED', entity: 'party_site', entity_id: id, before: null, after: { party_id: partyId, address: f.address as string, located: f.lat !== null }, reason: null });
    await c.query('COMMIT');
    return (await getParty(pool, partyId, true)).sites.find((s: any) => s.id === id);
  } catch (e) { try { await c.query('ROLLBACK'); } catch { /* */ } throw e; } finally { c.release(); }
}

export async function updateSite(pool: Pool, actor: Actor, id: string, b: Record<string, unknown>) {
  if (!UUID_RE.test(id)) throw new ApiError(404, 'no_encontrado');
  const f = siteFields(b, true);
  const cols = Object.keys(f);
  if (!cols.length) throw bad('address');
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const s = (await c.query('SELECT s.id, s.party_id, s.address, s.city, p.company_id FROM party_site s JOIN party p ON p.id = s.party_id WHERE s.id = $1', [id])).rows[0];
    if (!s) throw new ApiError(404, 'no_encontrado');
    if ('address' in f || 'city' in f) { f.address_norm = siteNorm((f.address as string | undefined) ?? s.address, 'city' in f ? (f.city as string | null) : s.city); cols.push('address_norm'); }
    await c.query(`UPDATE party_site SET ${cols.map((k, i) => `${k} = $${i + 3}`).join(', ')}, updated_at = now(), updated_by = $2 WHERE id = $1`, [id, actorStr(actor), ...cols.map((k) => f[k])]);
    await appendAudit(c, { company_id: s.company_id, at: new Date(), actor: actorStr(actor), action: f.active === false ? 'PARTY_SITE_ARCHIVED' : 'PARTY_SITE_UPDATED', entity: 'party_site', entity_id: id, before: null, after: { party_id: s.party_id, fields: cols.join(',') }, reason: null });
    await c.query('COMMIT');
    return (await getParty(pool, s.party_id, true)).sites.find((x: any) => x.id === id);
  } catch (e) { try { await c.query('ROLLBACK'); } catch { /* */ } throw e; } finally { c.release(); }
}

// ----------------------------------------------------------------------------- registro automático desde los transportes
interface Reg { parties: number; sites: number; located: number }

type PartyIn = { name: string; nif?: string | null; transport_authorization?: string | null; address?: string | null; postal_code?: string | null; city?: string | null; province?: string | null; country?: string | null };
async function upsertParty(c: PoolClient, actor: Actor, co: string, p: PartyIn, reg: Reg): Promise<string> {
  const nif = p.nif ? normTaxId(p.nif) : null;
  const norm = normName(p.name);
  let row = nif ? (await c.query('SELECT id, address FROM party WHERE company_id = $1 AND nif = $2', [co, nif])).rows[0]
                : (await c.query('SELECT id, address FROM party WHERE company_id = $1 AND name_norm = $2 AND active ORDER BY (nif IS NOT NULL) DESC, created_at LIMIT 1', [co, norm])).rows[0];
  if (row) {
    await c.query('UPDATE party SET use_count = use_count + 1, last_used_at = now(), address = COALESCE(address, $2), postal_code = COALESCE(postal_code, $3), city = COALESCE(city, $4), province = COALESCE(province, $5), country = COALESCE(country, $6), transport_authorization = COALESCE(transport_authorization, $7) WHERE id = $1', [row.id, p.address ?? null, p.postal_code ?? null, p.city ?? null, p.province ?? null, p.country ?? null, p.transport_authorization ?? null]);   // nunca pisa datos ya guardados
    return row.id;
  }
  row = (await c.query(`INSERT INTO party (company_id, name, name_norm, nif, address, postal_code, city, province, country, transport_authorization, use_count, last_used_at, created_by, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$11,1,now(),$10,$10) RETURNING id`,
    [co, p.name, norm, nif, p.address ?? null, p.postal_code ?? null, p.city ?? null, p.province ?? null, p.country ?? null, actorStr(actor), p.transport_authorization ?? null])).rows[0];
  reg.parties++;
  await appendAudit(c, { company_id: co, at: new Date(), actor: actorStr(actor), action: 'PARTY_CREATED', entity: 'party', entity_id: row.id, before: null, after: { name: p.name, nif: nif ?? '', origin: 'transporte' }, reason: null });
  return row.id;
}

/**
 * Ubicación (enlace de mapa o coordenadas) e indicaciones tecleadas en un lugar del transporte → se guardan en el lugar de la agenda.
 * Lo que ya estaba en la agenda y no se ha tocado no cambia; si el formulario trae otro valor, es que la oficina lo ha corregido a propósito.
 * Nunca se borra nada: un campo vacío del formulario deja el de la agenda como está.
 */
async function applyLocation(c: PoolClient, actor: Actor, co: string, siteId: string, loc: StopLocation, reg: Reg): Promise<void> {
  const f = siteFields({ map_url: loc.map_url, lat: loc.lat, lon: loc.lon, notes: loc.notes }, true);   // valida: https de mapas conocidos, coordenadas, longitud
  const cur = (await c.query('SELECT lat::float8 AS lat, lon::float8 AS lon, map_url, notes FROM party_site WHERE id = $1', [siteId])).rows[0];
  if (!cur) return;
  const set: Record<string, unknown> = {};
  if (f.lat !== null && (f.lat !== cur.lat || f.lon !== cur.lon)) { set.lat = f.lat; set.lon = f.lon; }
  if (f.map_url !== null && f.map_url !== cur.map_url) set.map_url = f.map_url;
  if (f.notes !== null && f.notes !== cur.notes) set.notes = f.notes;
  const cols = Object.keys(set);
  if (!cols.length) return;
  await c.query(`UPDATE party_site SET ${cols.map((k, i) => `${k} = $${i + 3}`).join(', ')}, updated_at = now(), updated_by = $2 WHERE id = $1`, [siteId, actorStr(actor), ...cols.map((k) => set[k])]);
  reg.located++;
  await appendAudit(c, { company_id: co, at: new Date(), actor: actorStr(actor), action: 'PARTY_SITE_UPDATED', entity: 'party_site', entity_id: siteId, before: null, after: { fields: cols.join(','), origin: 'transporte' }, reason: null });
}

async function ensureSite(c: PoolClient, actor: Actor, co: string, partyId: string, st: Stop, kind: 'CARGA' | 'DESCARGA', reg: Reg): Promise<string> {
  const address = st.address, norm = siteNorm(address, st.city);
  const s = (await c.query('SELECT id, kind FROM party_site WHERE party_id = $1 AND address_norm = $2 ORDER BY active DESC LIMIT 1', [partyId, norm])).rows[0];
  if (s) {
    if (s.kind !== kind && s.kind !== 'AMBOS' && s.kind !== 'SEDE') await c.query(`UPDATE party_site SET kind = 'AMBOS', updated_at = now(), updated_by = $2 WHERE id = $1`, [s.id, actorStr(actor)]);
    await c.query('UPDATE party_site SET postal_code = COALESCE(postal_code, $2), city = COALESCE(city, $3), province = COALESCE(province, $4), country = COALESCE(country, $5) WHERE id = $1 AND (postal_code IS NULL OR city IS NULL OR province IS NULL OR country IS NULL)', [s.id, st.postal_code ?? null, st.city ?? null, st.province ?? null, st.country ?? null]);
    return s.id;
  }
  const id = (await c.query(`INSERT INTO party_site (party_id, kind, address, address_norm, postal_code, city, province, country, created_by, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING id`, [partyId, kind, address, norm, st.postal_code ?? null, st.city ?? null, st.province ?? null, st.country ?? null, actorStr(actor)])).rows[0].id;
  reg.sites++;
  await appendAudit(c, { company_id: co, at: new Date(), actor: actorStr(actor), action: 'PARTY_SITE_CREATED', entity: 'party_site', entity_id: id, before: null, after: { party_id: partyId, address, origin: 'transporte' }, reason: null });
  return id;
}

/**
 * Al crear un transporte, las empresas y lugares que se hayan tecleado y no estén en la agenda se guardan para la próxima vez (sin pisar nunca lo ya guardado).
 * Modifica los lugares (`party_id`, `site_id`) para que el transporte quede enlazado a la agenda.
 */
export async function registerForTransport(c: PoolClient, actor: Actor, co: string, d: {
  shipper: PartyIn & { nif: string }; carrier?: PartyIn | null; origins: Stop[]; destinations: Stop[];
}): Promise<Reg> {
  const reg: Reg = { parties: 0, sites: 0, located: 0 };
  await upsertParty(c, actor, co, d.shipper, reg);
  if (d.carrier) await upsertParty(c, actor, co, d.carrier, reg);
  for (const [list, kind] of [[d.origins, 'CARGA'], [d.destinations, 'DESCARGA']] as const) {
    for (const st of list) {
      const loc = st.location; delete st.location;                 // la ubicación va al lugar de la agenda, no al transporte
      if (st.site_id) {                                             // elegido de la agenda: se comprueba que existe
        const row = (await c.query('SELECT s.id, s.party_id, s.address, s.postal_code, s.city, s.province, s.country, p.nif AS p_nif, p.address AS p_address, p.postal_code AS p_postal_code, p.city AS p_city, p.province AS p_province, p.country AS p_country FROM party_site s JOIN party p ON p.id = s.party_id WHERE s.id = $1 AND p.company_id = $2', [st.site_id, co])).rows[0];
        if (!row) throw bad('site_id');
        const s = inheritFromParty(row, { address: row.p_address, postal_code: row.p_postal_code, city: row.p_city, province: row.p_province, country: row.p_country });
        st.party_id = s.party_id; st.nif = row.p_nif ?? null;   // NIF del consignatario para la casilla 2
        st.postal_code = st.postal_code ?? s.postal_code; st.city = st.city ?? s.city; st.province = st.province ?? s.province; st.country = st.country ?? s.country;   // hereda la localidad del lugar guardado si no se indicó
        // lo que se complete a mano en el transporte se guarda en el lugar de la agenda (solo si allí faltaba: nunca pisa)
        if ((!s.postal_code && st.postal_code) || (!s.city && st.city) || (!s.province && st.province) || (!s.country && st.country)) await c.query('UPDATE party_site SET postal_code = COALESCE(postal_code, $2), city = COALESCE(city, $3), province = COALESCE(province, $4), country = COALESCE(country, $5), updated_at = now(), updated_by = $6 WHERE id = $1', [s.id, st.postal_code ?? null, st.city ?? null, st.province ?? null, st.country ?? null, actorStr(actor)]);
        await c.query('UPDATE party SET use_count = use_count + 1, last_used_at = now() WHERE id = $1', [s.party_id]);
        if (loc) await applyLocation(c, actor, co, st.site_id, loc, reg);
        continue;
      }
      if (st.party_id) {
        const p = (await c.query('SELECT id, nif, address, postal_code, city, province, country FROM party WHERE id = $1 AND company_id = $2', [st.party_id, co])).rows[0];
        if (!p) throw bad('party_id');
        st.nif = p.nif ?? null;
        if (sameStreet(st.address, p.address)) { st.postal_code = st.postal_code ?? p.postal_code; st.city = st.city ?? p.city; st.province = st.province ?? p.province; st.country = st.country ?? p.country; }
        await c.query('UPDATE party SET use_count = use_count + 1, last_used_at = now() WHERE id = $1', [p.id]);
      } else if (st.party) { st.party_id = await upsertParty(c, actor, co, { name: st.party, address: null }, reg); st.nif = (await c.query('SELECT nif FROM party WHERE id = $1', [st.party_id])).rows[0]?.nif ?? null; }
      else if (loc) throw new ApiError(400, 'ubicacion_requiere_empresa', { field: kind === 'CARGA' ? 'origins' : 'destinations' });   // sin empresa no hay dónde guardarla
      else continue;                                               // solo dirección, sin empresa: no se registra
      st.site_id = await ensureSite(c, actor, co, st.party_id as string, st, kind, reg);
      if (loc) await applyLocation(c, actor, co, st.site_id, loc, reg);
    }
  }
  return reg;
}

/** Completa los lugares de un transporte con los datos ACTUALES de la agenda (enlace de mapa, indicaciones), para oficina y conductor. */
export async function resolveStops(pool: Pool, stops: Stop[]): Promise<Array<Stop & { label: string | null; maps_url: string | null; site_notes: string | null }>> {
  const ids = stops.map((s) => s.site_id).filter((x): x is string => !!x && UUID_RE.test(x));
  const by = new Map<string, any>();
  if (ids.length) for (const r of (await pool.query('SELECT id, label, lat::float8 AS lat, lon::float8 AS lon, map_url, notes, active FROM party_site WHERE id = ANY($1::uuid[])', [ids])).rows) by.set(r.id, r);
  return stops.map((s) => { const r = s.site_id ? by.get(s.site_id) : undefined; return { ...s, label: r?.label ?? null, maps_url: r ? mapsLink(r) : null, site_notes: r?.notes ?? null }; });
}
