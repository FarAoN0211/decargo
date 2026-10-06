import { createHash } from 'node:crypto';
import { crc32, inflateSync } from 'node:zlib';
import type { Pool } from 'pg';
import { PDFDocument } from 'pdf-lib';
import { appendAudit } from './audit';
import { Actor, ApiError, actorStr } from '../identity/service';
import type { PdfLogo } from '../pdf/deca-pdf';

interface Queryable { query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, any>> }> }

/** Logo de la empresa para la cabecera del Modelo DECARGO. El vigente es app_setting 'company_logo' (SHA-256; vacío = sin logo). */
export const LOGO_KEY = 'company_logo';
export const LOGO_MAX_BYTES = 256 * 1024;

export interface StoredLogo extends PdfLogo { sha256: string; width: number; height: number }

const MAX_PIXELS = 4_000_000;

/**
 * Comprueba la estructura COMPLETA de un PNG antes de dárselo al decodificador del PDF (un PNG cortado o manipulado puede dejarlo
 * colgado): bloques dentro del fichero, sumas CRC, IHDR primero e IEND al final, y que los datos descomprimidos midan exactamente lo
 * que corresponde (con tope de memoria). Solo PNG de 8 bits RGB/RGBA sin entrelazar, que es lo que produce el navegador al redibujarlo.
 */
function pngOk(b: Buffer, w: number, h: number): boolean {
  if (b[24] !== 8 || (b[25] !== 2 && b[25] !== 6) || b[28] !== 0 || w * h > MAX_PIXELS) return false;
  const idat: Buffer[] = [];
  let p = 8, first = true, end = false;
  while (p + 12 <= b.length) {
    const len = b.readUInt32BE(p), type = b.toString('latin1', p + 4, p + 8);
    if (p + 12 + len > b.length) return false;
    if (crc32(b.subarray(p + 4, p + 8 + len)) !== b.readUInt32BE(p + 8 + len)) return false;
    if (first && type !== 'IHDR') return false;
    first = false;
    if (type === 'IDAT') idat.push(b.subarray(p + 8, p + 8 + len));
    p += 12 + len;
    if (type === 'IEND') { end = true; break; }
  }
  if (!end || p !== b.length || !idat.length) return false;
  const expected = h * (1 + w * (b[25] === 6 ? 4 : 3));
  try { return inflateSync(Buffer.concat(idat), { maxOutputLength: expected + 1 }).length === expected; } catch { return false; }
}

/** Tipo y tamaño leídos de la propia imagen (no de lo que diga el navegador). Solo PNG y JPEG. */
function sniff(b: Buffer): { mime: 'image/png' | 'image/jpeg'; width: number; height: number } | null {
  if (b.length > 24 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) && b.toString('latin1', 12, 16) === 'IHDR') {
    return { mime: 'image/png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    let p = 2;
    while (p + 9 < b.length) {
      if (b[p] !== 0xff) return null;
      const m = b[p + 1], len = b.readUInt16BE(p + 2);
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { mime: 'image/jpeg', height: b.readUInt16BE(p + 5), width: b.readUInt16BE(p + 7) };
      p += 2 + len;
    }
  }
  return null;
}

const rowToLogo = (r: Record<string, any> | undefined): StoredLogo | null =>
  r ? { sha256: r.sha256, png: r.mime === 'image/png', bytes: new Uint8Array(r.data), width: r.width, height: r.height } : null;

export async function logoBySha(q: Queryable, sha: unknown): Promise<StoredLogo | null> {
  if (typeof sha !== 'string' || !/^[0-9a-f]{64}$/.test(sha)) return null;
  return rowToLogo((await q.query('SELECT sha256, mime, data, width, height FROM company_logo WHERE sha256 = $1', [sha])).rows[0]);
}

export async function currentLogo(q: Queryable): Promise<StoredLogo | null> {
  const sha = (await q.query('SELECT value FROM app_setting WHERE key = $1', [LOGO_KEY])).rows[0]?.value;
  return logoBySha(q, sha);
}

/** Lo que ve el administrador en Configuración (sin la imagen). */
export async function logoInfo(q: Queryable) {
  const r = (await q.query(`SELECT l.sha256, l.mime, l.width, l.height, s.updated_at, s.updated_by FROM app_setting s JOIN company_logo l ON l.sha256 = s.value WHERE s.key = $1`, [LOGO_KEY])).rows[0];
  return r ? { sha256: r.sha256, mime: r.mime, width: r.width, height: r.height, updated_at: r.updated_at, updated_by: r.updated_by } : null;
}

/** Sube (data = imagen en base64) o quita (data = null) el logo. Solo afecta a los DeCA que se emitan a partir de ahora. */
export async function setLogo(pool: Pool, actor: Actor, raw: unknown): Promise<void> {
  let sha: string | null = null, meta: ReturnType<typeof sniff> = null, buf: Buffer | null = null;
  if (raw !== null) {
    if (typeof raw !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) throw new ApiError(400, 'logo_invalido');
    buf = Buffer.from(raw, 'base64');
    if (!buf.length || buf.length > LOGO_MAX_BYTES) throw new ApiError(400, 'logo_demasiado_grande', { max_bytes: LOGO_MAX_BYTES });
    meta = sniff(buf);
    if (!meta || meta.width < 1 || meta.height < 1 || meta.width > 4000 || meta.height > 4000) throw new ApiError(400, 'logo_invalido');
    if (meta.mime === 'image/png' ? !pngOk(buf, meta.width, meta.height) : !(buf[buf.length - 2] === 0xff && buf[buf.length - 1] === 0xd9)) throw new ApiError(400, 'logo_invalido');
    try { const d = await PDFDocument.create(); await (meta.mime === 'image/png' ? d.embedPng(buf) : d.embedJpg(buf)); } catch { throw new ApiError(400, 'logo_invalido'); }   // se puede incrustar en el PDF
    sha = createHash('sha256').update(buf).digest('hex');
  }
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    if (buf && meta && sha) {
      await c.query('INSERT INTO company_logo (sha256, mime, data, width, height, created_by) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (sha256) DO NOTHING',
        [sha, meta.mime, buf, meta.width, meta.height, actorStr(actor)]);
    }
    const before = (await c.query('SELECT value FROM app_setting WHERE key = $1', [LOGO_KEY])).rows[0]?.value || null;
    await c.query(`INSERT INTO app_setting (key, value, updated_by) VALUES ($1,$2,$3) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`, [LOGO_KEY, sha ?? '', actorStr(actor)]);
    const co = (await c.query('SELECT id FROM company ORDER BY created_at LIMIT 1')).rows[0];
    await appendAudit(c, { company_id: co?.id ?? null, at: new Date(), actor: actorStr(actor), action: 'CONFIG_FLAG_CHANGED', entity: 'config', entity_id: LOGO_KEY,
      before: before ? { sha256: before } : null, after: sha ? { sha256: sha, mime: meta!.mime, width: meta!.width, height: meta!.height } : { sha256: null }, reason: null });
    await c.query('COMMIT');
  } catch (e) { try { await c.query('ROLLBACK'); } catch { /* */ } throw e; } finally { c.release(); }
}
