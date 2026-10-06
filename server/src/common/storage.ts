import { createHash, randomUUID } from 'node:crypto';
import { promises as fs, constants } from 'node:fs';
import * as path from 'node:path';

const KEY_RE = /^[0-9a-f]{64}$/;
/** Límite de la Resolución: PDF no superior a 5 MB. Se toma el valor conservador (10^6). */
export const MAX_PDF_BYTES = 5_000_000;

export function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Almacén de ficheros direccionado por contenido: <raíz>/ab/cd/<sha256>.pdf
 * La clave la calcula el propio almacén; nunca se construye una ruta a partir de datos recibidos.
 */
export class LocalStorage {
  constructor(private readonly root: string) {}

  private fileFor(key: string): string {
    if (!KEY_RE.test(key)) throw new Error('clave de documento no válida');
    return path.join(this.root, key.slice(0, 2), key.slice(2, 4), `${key}.pdf`);
  }

  async put(buf: Buffer): Promise<{ key: string; sha256: string; size: number }> {
    if (buf.length > MAX_PDF_BYTES) throw new Error(`El PDF supera el límite de ${MAX_PDF_BYTES} bytes`);
    const key = sha256(buf);
    const file = this.fileFor(key);
    const dir = path.dirname(file);
    await fs.mkdir(dir, { recursive: true });
    try {
      await fs.access(file, constants.R_OK);
      return { key, sha256: key, size: buf.length }; // ya existe (mismo contenido)
    } catch { /* no existe: se escribe */ }
    const tmp = path.join(dir, `.tmp-${randomUUID()}`);
    const fh = await fs.open(tmp, 'wx', 0o640);
    try {
      await fh.writeFile(buf);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fs.rename(tmp, file);
    const dh = await fs.open(dir, 'r');
    try { await dh.sync(); } finally { await dh.close(); }
    return { key, sha256: key, size: buf.length };
  }

  /** Lee el fichero y comprueba que su SHA-256 coincide con el esperado. */
  async getVerified(key: string, expectedSha: string): Promise<Buffer> {
    const buf = await fs.readFile(this.fileFor(key));
    if (sha256(buf) !== expectedSha) throw new Error('El hash del documento no coincide');
    return buf;
  }

  /** Borra un documento del almacén (solo la purga de datos de ejemplo lo usa). Si no existe, no hace nada. */
  async remove(key: string): Promise<boolean> {
    try { await fs.unlink(this.fileFor(key)); return true; } catch (e) { if ((e as { code?: string }).code === 'ENOENT') return false; throw e; }
  }

  async canRead(): Promise<boolean> {
    try { await fs.access(this.root, constants.R_OK); return true; } catch { return false; }
  }

  async canWrite(): Promise<boolean> {
    try { await fs.access(this.root, constants.W_OK); return true; } catch { return false; }
  }
}
