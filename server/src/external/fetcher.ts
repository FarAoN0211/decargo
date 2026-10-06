import { createHash } from 'node:crypto';
import dns from 'node:dns';
import type { IncomingMessage } from 'node:http';
import https from 'node:https';
import type { SecureContextOptions } from 'node:tls';
import { isPublicAddress, parseSafeUrl, UrlError } from './netpolicy';

export type FetchOutcome = 'OK' | 'URL_INVALID' | 'BLOCKED_ADDRESS' | 'DNS_ERROR' | 'CONNECT_ERROR' | 'TLS_ERROR' | 'TIMEOUT' | 'HTTP_ERROR'
  | 'TOO_MANY_REDIRECTS' | 'REDIRECT_INVALID' | 'TOO_LARGE' | 'NOT_PDF' | 'ENCODED' | 'BUSY';

export class FetchError extends Error {
  constructor(public outcome: FetchOutcome, public detail = '') { super(outcome); }
}

export interface FetchResult {
  body: Buffer; sha256: string; finalUrl: string; httpStatus: number; contentType: string | null; redirects: number; remoteIp: string;
}

export interface FetcherOptions {
  maxBytes?: number; maxRedirects?: number; overallTimeoutMs?: number; idleTimeoutMs?: number; concurrency?: number;
  /** Solo para pruebas: permite sustituir la resolución DNS, la política de direcciones y la CA. En producción NO se pasan. */
  resolve?: (host: string) => Promise<string[]>;
  isAllowedAddress?: (ip: string) => boolean;
  port?: number;
  tls?: SecureContextOptions;
}

const DEFAULTS = { maxBytes: 5_000_000, maxRedirects: 3, overallTimeoutMs: 15_000, idleTimeoutMs: 5_000, concurrency: 2 };

async function defaultResolve(host: string): Promise<string[]> {
  const r = await dns.promises.lookup(host, { all: true, verbatim: true });
  return r.map((x) => x.address);
}

/** PDF "hasta donde se puede comprobar de forma fiable": cabecera %PDF-x.y al principio y marcador %%EOF al final (descarga completa). */
export function looksLikePdf(b: Buffer): boolean {
  if (b.length < 100) return false;
  const head = b.subarray(0, 1024).toString('latin1');
  const tail = b.subarray(Math.max(0, b.length - 2048)).toString('latin1');
  return /%PDF-\d\.\d/.test(head) && tail.includes('%%EOF');
}

/**
 * Descargador seguro (anti-SSRF) de DeCA externos. Defensas, en orden:
 *  1. URL: solo https, sin credenciales, puerto 443, host con nombre (no IP), sin hosts locales.
 *  2. DNS: TODAS las direcciones resueltas deben ser públicas; si alguna no lo es, se rechaza.
 *  3. Anti-rebinding: se conecta a la IP YA validada (no se vuelve a resolver) y se valida el certificado contra el nombre.
 *  4. Redirecciones: máximo 3; cada salto repite 1 a 3 desde cero; nunca a http.
 *  5. TLS ≥ 1.2 con verificación de certificado obligatoria.
 *  6. Sin compresión (evita bombas), sin cookies ni credenciales, solo GET, tiempo total y de inactividad acotados.
 *  7. Tamaño máximo 5 MB: se corta en cuanto se supera, también si no hay Content-Length.
 *  8. El contenido debe parecer un PDF (cabecera y %%EOF); no se confía en Content-Type.
 *  9. Concurrencia limitada: por encima del límite se rechaza (BUSY), sin cola.
 */
export class SafeFetcher {
  private readonly o: Required<Pick<FetcherOptions, 'maxBytes' | 'maxRedirects' | 'overallTimeoutMs' | 'idleTimeoutMs' | 'concurrency'>> & FetcherOptions;
  private inFlight = 0;
  constructor(opts: FetcherOptions = {}) { this.o = { ...DEFAULTS, ...opts }; }

  async fetchPdf(rawUrl: string): Promise<FetchResult> {
    if (this.inFlight >= this.o.concurrency) throw new FetchError('BUSY');
    this.inFlight++;
    const deadline = Date.now() + this.o.overallTimeoutMs;
    try { return await this.run(rawUrl, deadline); } finally { this.inFlight--; }
  }

  private async run(rawUrl: string, deadline: number): Promise<FetchResult> {
    let url: URL;
    try { url = parseSafeUrl(rawUrl); } catch (e) { throw new FetchError('URL_INVALID', (e as Error).message); }
    for (let hop = 0; ; hop++) {
      const { ip, family } = await this.resolvePublic(url.hostname.toLowerCase().replace(/\.$/, ''));
      const res = await this.request(url, ip, family, deadline);
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        res.drain();
        if (hop >= this.o.maxRedirects) throw new FetchError('TOO_MANY_REDIRECTS');
        const loc = res.headers.location;
        if (!loc) throw new FetchError('REDIRECT_INVALID', 'sin Location');
        try { url = parseSafeUrl(new URL(loc, url).toString()); } catch (e) { throw new FetchError('REDIRECT_INVALID', (e as Error).message); }
        continue;
      }
      if (res.status !== 200) { res.drain(); throw new FetchError('HTTP_ERROR', String(res.status)); }
      const enc = String(res.headers['content-encoding'] ?? 'identity').toLowerCase();
      if (enc !== 'identity') { res.drain(); throw new FetchError('ENCODED', enc); }
      const len = Number(res.headers['content-length'] ?? NaN);
      if (Number.isFinite(len) && len > this.o.maxBytes) { res.drain(); throw new FetchError('TOO_LARGE', 'content-length'); }
      const body = await res.read(this.o.maxBytes);
      if (!looksLikePdf(body)) throw new FetchError('NOT_PDF');
      return {
        body, sha256: createHash('sha256').update(body).digest('hex'), finalUrl: url.toString(), httpStatus: 200,
        contentType: (res.headers['content-type'] as string | undefined) ?? null, redirects: hop, remoteIp: ip
      };
    }
  }

  /** Resuelve el nombre UNA vez y exige que todas las direcciones sean públicas. Devuelve la que se usará para conectar. */
  private async resolvePublic(host: string): Promise<{ ip: string; family: 4 | 6 }> {
    let addrs: string[];
    try { addrs = await (this.o.resolve ?? defaultResolve)(host); } catch { throw new FetchError('DNS_ERROR'); }
    if (!addrs.length) throw new FetchError('DNS_ERROR');
    const allowed = this.o.isAllowedAddress ?? isPublicAddress;
    if (!addrs.every((a) => allowed(a))) throw new FetchError('BLOCKED_ADDRESS', host);
    const ip = addrs.find((a) => !a.includes(':')) ?? addrs[0];
    return { ip, family: ip.includes(':') ? 6 : 4 };
  }

  private request(url: URL, ip: string, family: 4 | 6, deadline: number): Promise<{
    status: number; headers: IncomingMessage['headers']; drain: () => void; read: (max: number) => Promise<Buffer>;
  }> {
    return new Promise((resolve, reject) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return reject(new FetchError('TIMEOUT'));
      let settled = false;
      let timedOut = false;
      const fail = (e: FetchError): void => { if (!settled) { settled = true; clearTimeout(timer); req.destroy(); reject(e); } };
      // El plazo total sigue vigente mientras se lee el cuerpo: al vencer se corta la conexión aunque ya haya respuesta.
      const timer = setTimeout(() => { timedOut = true; if (!settled) fail(new FetchError('TIMEOUT')); else req.destroy(); }, remaining);
      const req = https.request({
        host: url.hostname, port: this.o.port ?? 443, path: `${url.pathname}${url.search}`, method: 'GET', agent: false,
        // Anti-rebinding: la conexión va a la IP ya validada; el nombre solo sirve para SNI y para validar el certificado.
        lookup: ((_h: string, opts: { all?: boolean }, cb: (...a: unknown[]) => void) => (opts?.all ? cb(null, [{ address: ip, family }]) : cb(null, ip, family))) as never,
        servername: url.hostname, minVersion: 'TLSv1.2', rejectUnauthorized: true, timeout: this.o.idleTimeoutMs,
        headers: { 'user-agent': 'DECARGO/1 (descarga de DeCA externo)', accept: 'application/pdf, */*;q=0.1', 'accept-encoding': 'identity', connection: 'close' },
        ...(this.o.tls ?? {})
      }, (res) => {
        if (settled) return;
        settled = true;
        const drain = (): void => { clearTimeout(timer); res.destroy(); };
        const read = (max: number): Promise<Buffer> => new Promise((rs, rj) => {
          const chunks: Buffer[] = []; let n = 0;
          res.on('data', (c: Buffer) => {
            n += c.length;
            if (n > max) { clearTimeout(timer); res.destroy(); req.destroy(); rj(new FetchError('TOO_LARGE')); return; }
            chunks.push(c);
          });
          res.on('end', () => { clearTimeout(timer); rs(Buffer.concat(chunks)); });
          res.on('error', () => { clearTimeout(timer); rj(new FetchError(timedOut ? 'TIMEOUT' : 'CONNECT_ERROR')); });
          res.on('close', () => { if (!res.complete) { clearTimeout(timer); rj(new FetchError(timedOut ? 'TIMEOUT' : 'CONNECT_ERROR')); } });
          res.setTimeout(this.o.idleTimeoutMs, () => { clearTimeout(timer); res.destroy(); rj(new FetchError('TIMEOUT')); });
        });
        resolve({ status: res.statusCode ?? 0, headers: res.headers, drain, read });
      });
      req.on('timeout', () => fail(new FetchError('TIMEOUT')));
      req.on('error', (e: NodeJS.ErrnoException) => fail(new FetchError(/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS|HOSTNAME_MISMATCH|altnames/i.test(`${e.code} ${e.message}`) ? 'TLS_ERROR' : 'CONNECT_ERROR')));
      req.end();
    });
  }
}

export { UrlError };
