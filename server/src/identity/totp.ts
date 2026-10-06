import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { required } from '../common/config';

/** TOTP según RFC 6238: HMAC-SHA1, 6 dígitos, paso de 30 s. Compatible con las aplicaciones autenticadoras habituales. */
const STEP_SECONDS = 30;
const DIGITS = 6;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32decode(s: string): Buffer {
  let bits = 0, value = 0; const out: number[] = [];
  for (const ch of s.replace(/=+$/, '').toUpperCase()) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('base32 no válido');
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

/** 160 bits, el tamaño recomendado para HMAC-SHA1. */
export const newTotpSecret = (): string => base32(randomBytes(20));

export function totpAt(secretB32: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', base32decode(secretB32)).update(counter).digest();
  const o = h[h.length - 1] & 0x0f;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 10 ** DIGITS).padStart(DIGITS, '0');
}

export const currentStep = (now = Date.now()): number => Math.floor(now / 1000 / STEP_SECONDS);

/**
 * Comprueba un código admitiendo ±1 paso (relojes desajustados) y devuelve el paso aceptado, o null.
 * Anti-repetición: solo se acepta un paso POSTERIOR al último usado (`lastStep`).
 */
export function verifyTotp(secretB32: string, code: string, lastStep: number | null, now = Date.now()): number | null {
  const c = code.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const cur = currentStep(now);
  let accepted: number | null = null;
  for (const step of [cur - 1, cur, cur + 1]) {            // se recorren los tres: tiempo constante
    const ok = timingSafeEqual(Buffer.from(totpAt(secretB32, step)), Buffer.from(c));
    if (ok && (lastStep === null || step > lastStep) && (accepted === null || step > accepted)) accepted = step;
  }
  return accepted;
}

export const otpauthUri = (username: string, secretB32: string): string =>
  `otpauth://totp/DECARGO:${encodeURIComponent(username)}?secret=${secretB32}&issuer=DECARGO&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;

// ---- cifrado del secreto en reposo (clave derivada de APP_KEY con separación de dominio) ----
let key: Buffer | null = null;
const totpKey = (): Buffer => (key ??= Buffer.from(hkdfSync('sha256', Buffer.from(required('APP_KEY'), 'hex'), Buffer.alloc(0), 'decargo-totp-secret-v1', 32)));

export function encryptTotpSecret(secretB32: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', totpKey(), iv);
  const ct = Buffer.concat([c.update(secretB32, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

export function decryptTotpSecret(enc: string): string {
  const raw = Buffer.from(enc, 'base64');
  const d = createDecipheriv('aes-256-gcm', totpKey(), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
}
