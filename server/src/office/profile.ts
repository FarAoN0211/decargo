import type { Pool } from 'pg';
import { appendAudit } from '../common/audit';
import { required } from '../common/config';
import { decryptToken, encryptToken } from '../common/token';
import { Actor, ApiError, actorStr } from '../identity/service';
import { checkIban, groupIban, maskIban, normIban } from './banks';
import { UUID_RE, bad, isoDate, isoDateBetween, optText, text } from './validate';

/**
 * Ficha del conductor: solo los datos necesarios para la relación laboral (RGPD, art. 5.1.c). DNI/NIE, nº de la Seguridad Social e IBAN se guardan
 * CIFRADOS, se devuelven ENMASCARADOS y solo se muestran con una acción expresa que queda auditada (sin guardar el valor en la auditoría).
 */
const CONTRACTS = ['INDEFINIDO', 'TEMPORAL', 'FIJO_DISCONTINUO', 'AUTONOMO'] as const;
const PLAIN = ['iban_holder', 'nationality', 'phone', 'email', 'emergency_name', 'emergency_phone', 'street', 'postal_code', 'city', 'province', 'country', 'job_category', 'birth_date', 'hire_date', 'contract_type', 'notes'] as const;
const SECRET = ['nif', 'ss', 'iban'] as const;
type Secret = (typeof SECRET)[number];

/** DNI (8 cifras + letra) o NIE (X/Y/Z + 7 cifras + letra), con la letra de control. */
export function normNif(v: string): string | null {
  const s = v.replace(/[\s.-]/g, '').toUpperCase();
  const m = /^([XYZ]|\d)(\d{7})([A-Z])$/.exec(s);
  if (!m) return null;
  const n = Number(({ X: '0', Y: '1', Z: '2' } as Record<string, string>)[m[1]] ?? m[1]) * 1e7 + Number(m[2]);
  return 'TRWAGMYFPDXBNJZSQVHLCKE'[n % 23] === m[3] ? s : null;
}
const mask = (v: string, keep = 4): string => '•'.repeat(Math.max(v.length - keep, 3)) + v.slice(-keep);

async function conductor(pool: Pool, actor: Actor, id: string) {
  if (!UUID_RE.test(id)) throw new ApiError(404, 'no_encontrado');
  const u = (await pool.query(`SELECT id, company_id, username, full_name, active FROM app_user WHERE id = $1 AND role = 'conductor'`, [id])).rows[0];
  if (!u) throw new ApiError(404, 'no_encontrado');
  void actor;
  return u as { id: string; company_id: string; username: string; full_name: string; active: boolean };
}

const dec = (enc: string | null): string | null => (enc ? decryptToken(enc, required('APP_KEY')) : null);

function shape(u: { id: string; username: string; full_name: string; active: boolean }, p: Record<string, any> | undefined) {
  const iban = dec(p?.iban_enc ?? null), nif = dec(p?.nif_enc ?? null), ss = dec(p?.ss_enc ?? null);
  const info = iban ? checkIban(iban) : null;
  const out: Record<string, unknown> = {};
  for (const k of PLAIN) out[k] = k === 'birth_date' || k === 'hire_date' ? (p?.[`${k}_t`] ?? null) : (p?.[k] ?? null);
  return {
    user: { id: u.id, username: u.username, full_name: u.full_name, active: u.active },
    profile: {
      ...out,
      nif: { set: !!nif, masked: nif ? mask(nif) : null },
      ss: { set: !!ss, masked: ss ? mask(ss) : null },
      iban: { set: !!iban, masked: iban ? maskIban(iban) : null, country: info?.country_name ?? null, bank: info?.bank ?? null, bank_code: info?.bank_code ?? null, valid: info?.valid ?? null },
      updated_at: p?.updated_at ?? null
    }
  };
}

export async function getProfile(pool: Pool, actor: Actor, userId: string) {
  const u = await conductor(pool, actor, userId);
  const p = (await pool.query(`SELECT *, birth_date::text AS birth_date_t, hire_date::text AS hire_date_t FROM driver_profile WHERE user_id = $1`, [u.id])).rows[0];
  return shape(u, p);
}

function optSimple(v: unknown, field: string, re: RegExp, max: number): string | null {
  const s = optText(v, field, max);
  if (s !== null && !re.test(s)) throw bad(field);
  return s;
}

export async function saveProfile(pool: Pool, actor: Actor, userId: string, b: Record<string, unknown>) {
  const u = await conductor(pool, actor, userId);
  const set: Record<string, unknown> = {};
  const changed: string[] = [];
  let fullName: string | null = null;
  if ('full_name' in b) { fullName = text(b.full_name, 'full_name', 2, 100); if (fullName !== u.full_name) changed.push('full_name'); }
  for (const k of PLAIN) {
    if (!(k in b)) continue;
    let v: unknown;
    switch (k) {
      case 'birth_date': { v = b[k] === null || b[k] === '' ? null : isoDateBetween(b[k], k, 1900, 2100); if (v && (v as string) > new Date(Date.now() - 16 * 365.25 * 864e5).toISOString().slice(0, 10)) throw bad(k); break; }
      case 'hire_date': v = b[k] === null || b[k] === '' ? null : isoDate(b[k], k); break;
      case 'contract_type': v = b[k] === null || b[k] === '' ? null : ((CONTRACTS as readonly string[]).includes(b[k] as string) ? b[k] : (() => { throw bad(k); })()); break;
      case 'email': v = optSimple(b[k], k, /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/, 120); break;
      case 'phone': case 'emergency_phone': v = optSimple(b[k], k, /^\+?[0-9 ]{6,20}$/, 20); break;
      case 'postal_code': v = optSimple(b[k], k, /^[0-9A-Za-z -]{3,10}$/, 10); break;
      case 'notes': v = optText(b[k], k, 500); break;
      default: v = optText(b[k], k, 120);
    }
    set[k] = v; changed.push(k);
  }
  if (typeof set.postal_code === 'string' && (set.country === undefined || /^espa/i.test(String(set.country))) && !/^\d{5}$/.test(set.postal_code as string)) throw bad('postal_code');
  for (const k of SECRET) {
    if (!(k in b)) continue;
    if (b[k] === null || b[k] === '') { set[`${k}_enc`] = null; changed.push(k); continue; }
    if (typeof b[k] !== 'string') throw bad(k);
    let norm: string;
    if (k === 'nif') { const n = normNif(b[k] as string); if (!n) throw bad(k); norm = n; }
    else if (k === 'ss') { norm = (b[k] as string).replace(/[\s/-]/g, ''); if (!/^\d{12}$/.test(norm)) throw bad(k); }
    else { const r = checkIban(b[k] as string); if (!r.valid) throw new ApiError(400, 'invalid_iban', { reason: r.reason }); norm = normIban(b[k] as string); }
    set[`${k}_enc`] = encryptToken(norm, required('APP_KEY')); changed.push(k);
  }
  if (!changed.length) throw bad('full_name');
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`profile:${u.id}`]);
    const cols = Object.keys(set);
    await c.query(`INSERT INTO driver_profile (user_id, company_id, updated_by) VALUES ($1,$2,$3) ON CONFLICT (user_id) DO NOTHING`, [u.id, u.company_id, actorStr(actor)]);
    if (cols.length) await c.query(`UPDATE driver_profile SET ${cols.map((k, i) => `${k} = $${i + 3}`).join(', ')}, updated_at = now(), updated_by = $2 WHERE user_id = $1`, [u.id, actorStr(actor), ...cols.map((k) => set[k])]);
    if (fullName !== null && fullName !== u.full_name) await c.query('UPDATE app_user SET full_name = $2 WHERE id = $1', [u.id, fullName]);
    // En la auditoría solo van los NOMBRES de los campos tocados, nunca los valores (hay datos personales).
    await appendAudit(c, { company_id: u.company_id, at: new Date(), actor: actorStr(actor), action: 'DRIVER_PROFILE_UPDATED', entity: 'driver_profile', entity_id: u.id, before: null, after: { fields: changed.join(',') }, reason: null });
    await c.query('COMMIT');
  } catch (e) { try { await c.query('ROLLBACK'); } catch { /* */ } throw e; } finally { c.release(); }
  return getProfile(pool, actor, userId);
}

/** Muestra un dato protegido en claro (a petición expresa). Queda auditado quién, cuándo y qué campo, no el valor. */
export async function revealField(pool: Pool, actor: Actor, userId: string, field: unknown): Promise<{ value: string; formatted?: string }> {
  if (!SECRET.includes(field as Secret)) throw bad('field');
  const u = await conductor(pool, actor, userId);
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const col = `${field as string}_enc`;
    const p = (await c.query(`SELECT ${col} AS v FROM driver_profile WHERE user_id = $1`, [u.id])).rows[0];
    if (!p?.v) throw new ApiError(404, 'sin_dato');
    await appendAudit(c, { company_id: u.company_id, at: new Date(), actor: actorStr(actor), action: 'DRIVER_PROFILE_FIELD_REVEALED', entity: 'driver_profile', entity_id: u.id, before: null, after: { field: field as string }, reason: null });
    await c.query('COMMIT');
    const value = decryptToken(p.v, required('APP_KEY'));
    return field === 'iban' ? { value, formatted: groupIban(value) } : { value };
  } catch (e) { try { await c.query('ROLLBACK'); } catch { /* */ } throw e; } finally { c.release(); }
}

/** Comprobación de un IBAN tecleado (sin guardarlo): validez, país y banco, para mostrarlo mientras se escribe. */
export function ibanPreview(raw: unknown) {
  if (typeof raw !== 'string' || raw.length > 60) throw bad('iban');
  const r = checkIban(raw);
  return r.valid ? { valid: true, country: r.country_name, bank: r.bank, bank_code: r.bank_code, formatted: groupIban(r.iban!) } : { valid: false, reason: r.reason };
}
