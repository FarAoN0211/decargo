import { ApiError } from '../identity/service';
import { fullAddress } from './address';

export const bad = (field: string): ApiError => new ApiError(400, 'invalid_field', { field });

const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;

/** Texto de una línea: se recorta, se colapsan espacios y se rechazan caracteres de control. */
export function text(v: unknown, field: string, min: number, max: number): string {
  if (typeof v !== 'string') throw bad(field);
  const s = v.trim().replace(/\s+/g, ' ');
  if (s.length < min || s.length > max || CONTROL.test(s)) throw bad(field);
  return s;
}

export function optText(v: unknown, field: string, max: number): string | null {
  if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) return null;
  return text(v, field, 1, max);
}

/** Texto multilínea (observaciones): conserva los saltos de línea. */
export function optMultiline(v: unknown, field: string, max: number): string | null {
  if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) return null;
  if (typeof v !== 'string') throw bad(field);
  const s = v.trim();
  if (s.length > max || CONTROL.test(s)) throw bad(field);
  return s;
}

export function nif(v: unknown, field: string): string {
  const s = text(v, field, 5, 16).toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9.\-]{3,14}[A-Z0-9]$/.test(s)) throw bad(field);
  return s;
}

/** Fecha ISO válida dentro de un rango de años (p. ej. nacimientos desde 1900). */
export function isoDateBetween(v: unknown, field: string, minYear: number, maxYear: number): string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw bad(field);
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v || d.getUTCFullYear() < minYear || d.getUTCFullYear() > maxYear) throw bad(field);
  return v;
}

export function isoDate(v: unknown, field: string): string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw bad(field);
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v || d.getUTCFullYear() < 2000 || d.getUTCFullYear() > 2100) throw bad(field);
  return v;
}

/** Peso en kg, positivo y razonable, con dos decimales. */
export function weightKg(v: unknown, field: string): string {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.replace(',', '.')) : NaN;
  if (!Number.isFinite(n) || n <= 0 || n > 100000) throw bad(field);
  return n.toFixed(2);
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function optUuid(v: unknown, field: string): string | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || !UUID_RE.test(v)) throw bad(field);
  return v;
}

export function plate(v: unknown, field = 'plate'): { display: string; norm: string } {
  const display = text(v, field, 3, 12).toUpperCase();
  const norm = display.replace(/[\s-]/g, '');
  if (!/^[A-Z0-9]{3,10}$/.test(norm)) throw bad(field);
  return { display, norm };
}

/** Un lugar de carga o de descarga: empresa que carga/descarga (opcional) y dirección. */
export interface Stop { party: string | null; address: string; party_id?: string | null; site_id?: string | null; pallets?: number | null; references?: string[]; seals?: string[]; postal_code?: string | null; city?: string | null; province?: string | null; country?: string | null; nif?: string | null }   // nif: lo pone el servidor desde la agenda (nunca viene del formulario)
const MAX_STOPS = 10;

/** Acepta una lista de lugares o, por compatibilidad, un único texto. Uno o varios (hasta 10). */
export function stops(v: unknown, field: string, fallback: unknown): Stop[] {
  if (v === undefined || v === null) return [{ party: null, address: text(fallback, field, 3, 200) }];
  if (!Array.isArray(v) || v.length < 1 || v.length > MAX_STOPS) throw bad(field);
  return v.map((x) => {
    if (typeof x !== 'object' || x === null || Array.isArray(x)) throw bad(field);
    const o = x as Record<string, unknown>;
    const id = (v: unknown): string | null => (v === undefined || v === null || v === '' ? null : typeof v === 'string' && UUID_RE.test(v) ? v : (() => { throw bad(field); })());
    let pallets: number | null = null;                       // palets cargados (o descargados) en ese lugar
    if (o.pallets !== undefined && o.pallets !== null && o.pallets !== '') {
      const n = typeof o.pallets === 'number' ? o.pallets : Number(String(o.pallets).trim());
      if (!Number.isInteger(n) || n < 0 || n > 9999) throw bad('pallets');
      pallets = n;
    }
    return { party: optText(o.party, field, 120), address: text(o.address, field, 3, 200), party_id: id(o.party_id), site_id: id(o.site_id), pallets,
      references: shortList(o.references, field, 10, 40), seals: shortList(o.seals, field, 10, 30), ...addrParts(o, field) };
  });
}

/** Texto que se imprime en el DeCA: un lugar por línea («1) Empresa — Dirección» si hay varios). */
/** Código postal, localidad, provincia y país (opcionales) de un domicilio. */
export function addrParts(o: Record<string, unknown>, field: string): { postal_code: string | null; city: string | null; province: string | null; country: string | null } {
  const cp = optText(o.postal_code, field, 10);
  if (cp !== null && !/^[0-9A-Za-z -]{3,10}$/.test(cp)) throw bad(field);
  return { postal_code: cp, city: optText(o.city, field, 80), province: optText(o.province, field, 80), country: optText(o.country, field, 60) };
}

/** Lista de textos cortos (referencias de carga/descarga, nº de precinto): acepta una lista o un texto separado por comas, puntos y comas o saltos de línea. Sin repetidos. */
export function shortList(v: unknown, field: string, maxItems: number, maxLen: number): string[] {
  if (v === undefined || v === null || v === '') return [];
  const raw = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,;\n]+/) : null;
  if (!raw) throw bad(field);
  const out: string[] = [];
  for (const x of raw) {
    if (typeof x !== 'string') throw bad(field);
    const t = x.trim().replace(/\s+/g, ' ');
    if (!t) continue;
    if (t.length > maxLen || CONTROL.test(t)) throw bad(field);
    if (!out.includes(t)) out.push(t);
  }
  if (out.length > maxItems) throw bad(field);
  return out;
}

export const palletsLabel = (n: number): string => `${n} ${n === 1 ? 'palet' : 'palets'}`;
export const palletsTotal = (list: Stop[]): number | null => (list.some((s) => s.pallets !== null && s.pallets !== undefined) ? list.reduce((a, s) => a + (s.pallets ?? 0), 0) : null);

/** « · Ref.: A-1, A-2 · Precinto: 123» para añadir a la línea de un lugar. */
export function extras(s: { references?: string[]; seals?: string[] }): string {
  const r = s.references ?? [], p = s.seals ?? [];
  return `${r.length ? ` · ${r.length > 1 ? 'Referencias' : 'Referencia'}: ${r.join(', ')}` : ''}${p.length ? ` · ${p.length > 1 ? 'Precintos' : 'Precinto'}: ${p.join(', ')}` : ''}`;
}

export function stopsText(list: Stop[]): string {
  const line = (s: Stop): string => `${s.party ? `${s.party} — ${fullAddress(s)}` : fullAddress(s)}${s.pallets !== null && s.pallets !== undefined ? ` · ${palletsLabel(s.pallets)}` : ''}${extras(s)}`;
  const total = palletsTotal(list);
  const body = list.length === 1 ? line(list[0]) : list.map((s, i) => `${i + 1}) ${line(s)}`).join('\n');
  return list.length > 1 && total !== null ? `${body}\nTotal: ${palletsLabel(total)}` : body;
}
