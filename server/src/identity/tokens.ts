import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { required } from '../common/config';

export const sha256hex = (s: string): string => createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');

let key: Buffer | null = null;
function accessKey(): Buffer {
  key ??= Buffer.from(hkdfSync('sha256', Buffer.from(required('APP_KEY'), 'hex'), Buffer.alloc(0), 'decargo-access-token-v1', 32));
  return key;
}

const b64 = (b: Buffer | string): string => Buffer.from(b).toString('base64url');

/** Access token de vida corta: firmado con HMAC. El servidor además consulta la sesión en cada petición,
 *  así que revocar la sesión, el dispositivo o el usuario surte efecto de inmediato. */
export function signAccess(sid: string, ttlSeconds: number): string {
  const payload = b64(JSON.stringify({ sid, exp: Math.floor(Date.now() / 1000) + ttlSeconds }));
  const sig = b64(createHmac('sha256', accessKey()).update(payload).digest());
  return `a1.${payload}.${sig}`;
}

export function verifyAccess(token: string): { sid: string } | null {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'a1') return null;
  const expect = createHmac('sha256', accessKey()).update(parts[1]).digest();
  const got = Buffer.from(parts[2], 'base64url');
  if (got.length !== expect.length || !timingSafeEqual(got, expect)) return null;
  try {
    const p = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (typeof p.sid !== 'string' || typeof p.exp !== 'number' || p.exp < Date.now() / 1000) return null;
    return { sid: p.sid };
  } catch { return null; }
}

/** Código de activación legible: 16 caracteres Crockford en grupos de 4 (80 bits). */
export function newActivationCode(): string {
  const A = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const b = randomBytes(16);
  let s = '';
  for (let i = 0; i < 16; i++) s += A[b[i] % 32];
  return s.match(/.{4}/g)!.join('-');
}

export const normalizeCode = (c: string): string => c.toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
