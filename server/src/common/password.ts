import { hash, verify } from '@node-rs/argon2';

/** Argon2id con los parámetros mínimos recomendados por OWASP (19 MiB, 2 pasadas, 1 hilo). */
const OPTS = { memoryCost: 19456, timeCost: 2, parallelism: 1 };

export const hashSecret = (secret: string): Promise<string> => hash(secret, OPTS);

export async function verifySecret(hashed: string, secret: string): Promise<boolean> {
  try { return await verify(hashed, secret); } catch { return false; }
}

let dummy: Promise<string> | null = null;
/** Hash ficticio para igualar el tiempo de respuesta cuando el usuario no existe (evita enumerar usuarios por tiempo). */
export function dummyHash(): Promise<string> {
  dummy ??= hashSecret('contraseña-ficticia-para-igualar-tiempos');
  return dummy;
}

// Contraseñas evidentemente débiles. No se imponen reglas de composición: longitud + rechazo de las más comunes.
const COMMON = new Set(`
password contrasena contraseña clave secreto admin administrador usuario conductor camionero transporte transportes decargo
camion camiones carretera trailer tractora qwerty qwertyuiop qwertyuiopasdfghjkl asdfghjkl zxcvbnm abcdefghij abcdefghijk
abcdefgh abcdefg iloveyou letmein welcome monkey dragon master sunshine princess football baseball superman batman
bienvenido bienvenida hola holaquetal holamundo holahola buenosdias futbol barcelona madrid realmadrid sevilla betis
atletico almeria granada malaga valencia espana espana1 españa spain miguel carlos antonio manuel javier jose david
password123 password1 password12 contrasena123 contrasena1 changeme cambiame cambiar temporal provisional prueba pruebas
test testtest testing tester demo demodemo default
`.split(/\s+/).filter(Boolean));

const SEQUENCES = ['0123456789', '1234567890', '9876543210', '0987654321', 'abcdefghijklmnopqrstuvwxyz', 'qwertyuiopasdfghjklzxcvbnm'];

export type PasswordProblem = 'too_short' | 'too_long' | 'too_common' | 'contains_username' | 'repetitive' | 'sequence';

/** Longitud mínima 10, máxima 128 (Argon2 es costoso). Sin exigencias absurdas de mayúsculas/símbolos. */
export function checkPassword(pw: string, username: string): PasswordProblem | null {
  if (pw.length < 10) return 'too_short';
  if (pw.length > 128) return 'too_long';
  const low = pw.toLowerCase();
  const letters = low.replace(/[^a-záéíóúñü]/g, '');
  const stripped = low.replace(/[0-9\s._\-!?¡¿#@$%&*+]/g, '');
  if (COMMON.has(low) || COMMON.has(letters) || COMMON.has(stripped)) return 'too_common';
  if (username.length >= 3 && low.includes(username.toLowerCase())) return 'contains_username';
  if (new Set(low).size <= 3) return 'repetitive';
  if (SEQUENCES.some((s) => s.includes(low))) return 'sequence';
  return null;
}
