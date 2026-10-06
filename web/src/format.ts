/** Fecha «YYYY-MM-DD» → «dd/mm/aaaa» sin pasar por Date (evita desfases de zona horaria). */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}
export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' });
}
export const STATUS: Record<string, string> = { PENDIENTE: 'Pendiente', EN_CURSO: 'En curso', FINALIZADO: 'Finalizado', CANCELADO: 'Anulado' };
/** Orden en que se muestran los vehículos y el título de cada grupo. */
export const KIND_ORDER = ['TRACTORA', 'SEMIRREMOLQUE', 'RIGIDO', 'REMOLQUE'] as const;
export const KIND_HEAD: Record<string, string> = { TRACTORA: 'Tractoras', SEMIRREMOLQUE: 'Semirremolques', RIGIDO: 'Camión rígido', REMOLQUE: 'Remolques' };
export const kindRank = (k: string): number => { const i = (KIND_ORDER as readonly string[]).indexOf(k); return i < 0 ? 99 : i; };
export const KIND: Record<string, string> = { TRACTORA: 'Tractora', SEMIRREMOLQUE: 'Semirremolque', REMOLQUE: 'Remolque', RIGIDO: 'Camión rígido' };
export const ROLE: Record<string, string> = { admin: 'Administrador', oficina: 'Oficina', conductor: 'Conductor', solo_lectura: 'Solo lectura' };
export const DEVICE: Record<string, string> = { PENDIENTE_DE_CONFIRMACION: 'Pendiente de confirmación', AUTORIZADO: 'Autorizado', REVOCADO: 'Revocado' };
export const kg = (v: string | number | null): string => (v === null || v === undefined ? '—' : `${Number(v).toLocaleString('es-ES', { maximumFractionDigits: 2 })} kg`);

/** Domicilio completo en una línea: «calle, CP localidad (provincia), país» (el país solo si no es España). */
export function fullAddress(a: { address?: string | null; postal_code?: string | null; city?: string | null; province?: string | null; country?: string | null }): string {
  const cpCity = [a.postal_code, a.city].filter(Boolean).join(' ');
  const prov = a.province && a.province.trim().toLowerCase() !== (a.city ?? '').trim().toLowerCase() ? ` (${a.province})` : '';
  const country = a.country && !/^(es|esp|españa|espana|spain)$/i.test(a.country.trim()) ? a.country : '';
  return [a.address, `${cpCity}${prov}`.trim(), country].filter((x) => x && String(x).trim()).join(', ');
}

const PROVINCES: Record<string, string> = { '01': 'Álava', '02': 'Albacete', '03': 'Alicante', '04': 'Almería', '05': 'Ávila', '06': 'Badajoz', '07': 'Illes Balears', '08': 'Barcelona', '09': 'Burgos', '10': 'Cáceres', '11': 'Cádiz', '12': 'Castellón', '13': 'Ciudad Real', '14': 'Córdoba', '15': 'A Coruña', '16': 'Cuenca', '17': 'Girona', '18': 'Granada', '19': 'Guadalajara', '20': 'Gipuzkoa', '21': 'Huelva', '22': 'Huesca', '23': 'Jaén', '24': 'León', '25': 'Lleida', '26': 'La Rioja', '27': 'Lugo', '28': 'Madrid', '29': 'Málaga', '30': 'Murcia', '31': 'Navarra', '32': 'Ourense', '33': 'Asturias', '34': 'Palencia', '35': 'Las Palmas', '36': 'Pontevedra', '37': 'Salamanca', '38': 'Santa Cruz de Tenerife', '39': 'Cantabria', '40': 'Segovia', '41': 'Sevilla', '42': 'Soria', '43': 'Tarragona', '44': 'Teruel', '45': 'Toledo', '46': 'Valencia', '47': 'Valladolid', '48': 'Bizkaia', '49': 'Zamora', '50': 'Zaragoza', '51': 'Ceuta', '52': 'Melilla' };
/** Provincia que corresponde a un código postal español (por sus dos primeras cifras); '' si no es válido. */
export const provinceFromPostal = (cp: string): string => (/^\d{5}$/.test(cp.trim()) ? PROVINCES[cp.trim().slice(0, 2)] ?? '' : '');

type Addr = { address: string; postal_code: string; city: string; province: string; country: string };
/** Completa lo que falte de un domicilio guardado «en una sola línea» (p. ej. «CAMINO DE PURCHIL, 68 (GRANADA)» o
 *  «C/QUEBEC, 8, 28042 MADRID»): saca el código postal y la localidad de la dirección y deduce la provincia del código postal.
 *  Nunca pisa lo que ya esté rellenado. */
export function completeAddress(a: Addr): Addr {
  let { address, postal_code, city, province, country } = a;
  address = address.trim(); postal_code = postal_code.trim(); city = city.trim(); province = province.trim(); country = country.trim();
  if (!city || !postal_code) {
    const m = /^(.*?)[,\s]+(\d{5})\s+([^,()]+?)(?:\s*\(([^)]+)\))?$/.exec(address);
    const p = /^(.*?)\s*\(([^)]+)\)$/.exec(address);
    if (m) { address = m[1].trim(); if (!postal_code) postal_code = m[2]; if (!city) city = m[3].trim(); if (!province && m[4]) province = m[4].trim(); }
    else if (p && !city) { address = p[1].trim().replace(/,$/, ''); city = p[2].trim(); }
  }
  if (!province) province = provinceFromPostal(postal_code);
  if (!province && city) { const k = (x: string): string => x.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim(); province = Object.values(PROVINCES).find((n) => k(n) === k(city)) ?? ''; }   // capitales: «Granada» → Granada
  return { address, postal_code, city, province, country };
}
