import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/** 32 bytes de CSPRNG en base64url = 43 caracteres (256 bits de entropía). */
export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Cifra el token con APP_KEY (AES-256-GCM) para poder volver a mostrar el QR a la oficina. */
export function encryptToken(token: string, appKeyHex: string): string {
  const key = Buffer.from(appKeyHex, 'hex');
  if (key.length !== 32) throw new Error('APP_KEY debe tener 64 caracteres hexadecimales');
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(token, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

export function decryptToken(enc: string, appKeyHex: string): string {
  const key = Buffer.from(appKeyHex, 'hex');
  const raw = Buffer.from(enc, 'base64');
  const d = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
}
