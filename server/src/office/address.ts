/** Domicilio estructurado: la dirección es la calle y número; el resto son opcionales. */
export interface Addr { address?: string | null; postal_code?: string | null; city?: string | null; province?: string | null; country?: string | null }

const SPAIN = /^(es|esp|españa|espana|spain)$/i;
const fold = (x: string): string => x.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

/** «Calle Mayor 5, 18004 Granada (Granada), Portugal»: solo se añade el país si no es España. */
export function fullAddress(a: Addr): string {
  // «Camino X, 68 (GRANADA)» con localidad Granada: no se repite la localidad entre paréntesis.
  const paren = a.address && a.city ? /^(.*?)\s*\(([^)]+)\)\s*$/.exec(a.address.trim()) : null;
  const street = paren && fold(paren[2]) === fold(a.city ?? '') && paren[1].trim() ? paren[1].trim() : a.address;
  a = { ...a, address: street };
  const cpCity = [a.postal_code, a.city].filter(Boolean).join(' ');
  const prov = a.province && a.province.trim().toLowerCase() !== (a.city ?? '').trim().toLowerCase() ? ` (${a.province})` : '';
  const country = a.country && !SPAIN.test(a.country.trim()) ? a.country : '';
  return [a.address, `${cpCity}${prov}`.trim(), country].filter((x) => x && String(x).trim()).join(', ');
}


/** Localidad deducida con prudencia de una dirección en una línea: «Camino X, 68 (GRANADA)» → GRANADA, «Calle Y, 28042 Madrid» → Madrid. '' si no hay. */
export function cityFromAddress(address: string | null | undefined): string {
  const raw = (address ?? '').trim();
  const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const last = parts[parts.length - 1] ?? raw;
  const paren = /^(.*?)\s*\(([^)]+)\)\s*$/.exec(last);
  const main = (paren ? paren[1] : last).replace(/^\d{4,5}\s*/, '').trim();
  const hasLetters = (s: string): boolean => /[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]{2,}/.test(s);
  if (paren && !hasLetters(main) && hasLetters(paren[2])) return paren[2].trim();          // «68 (Granada)» → Granada
  if (parts.length > 1 && hasLetters(main) && !/\d/.test(main)) return main;              // «…, 18004 Granada» → Granada
  return '';
}

/**
 * Lugar para las casillas 3 y 4 del DeCA: la LOCALIDAD, con la provincia si es distinta («Las Gabias (Granada)») y el país si no es
 * España («Lyon, Francia»). Nunca la calle ni el número. Sin localidad conocida devuelve '' (el alta del transporte lo impide).
 */
export function placeFrom(a: Addr): string {
  const city = (a.city ?? '').trim() || cityFromAddress(a.address);
  if (!city) return '';
  const prov = a.province && a.province.trim() && fold(a.province) !== fold(city) ? ` (${a.province.trim()})` : '';
  const country = a.country && a.country.trim() && !SPAIN.test(a.country.trim()) ? `, ${a.country.trim()}` : '';
  return `${city}${prov}${country}`;
}

/** ¿Es la misma calle y número? («CAMINO DE PURCHIL, 68 (GRANADA)» = «Camino de Purchil, 68»). */
export function sameStreet(a: string | null | undefined, b: string | null | undefined): boolean {
  const k = (x: string | null | undefined): string => fold((x ?? '').replace(/\s*\([^)]*\)\s*$/, '').replace(/,?\s*\d{5}\s+[^,]*$/, '')).replace(/[^a-z0-9]/g, '');
  return k(a) !== '' && k(a) === k(b);
}
