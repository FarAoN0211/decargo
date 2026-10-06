import { BlockList, isIP } from 'node:net';

/**
 * Política de red del descargador de DeCA externos (anti-SSRF).
 * Regla: solo se conecta a direcciones IP PÚBLICAS enrutables. Cualquier otra cosa se rechaza, aunque sea legítima.
 */
const BAD = new BlockList();
const v4: [string, number][] = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]            // 240/4 incluye 255.255.255.255
];
const v6: [string, number][] = [
  ['::', 96],                // incluye :: y ::1 y las IPv4 «compatibles» (::a.b.c.d, obsoletas)
  ['64:ff9b::', 96],         // NAT64
  ['64:ff9b:1::', 48],
  ['100::', 64],             // descarte
  ['2001::', 32],            // Teredo
  ['2001:db8::', 32],        // documentación
  ['2002::', 16],            // 6to4 (puede encapsular una IPv4 interna)
  ['fc00::', 7],             // ULA (privadas)
  ['fe80::', 10],            // enlace local
  ['fec0::', 10],            // site-local (obsoleta)
  ['ff00::', 8]              // multicast
];
// OJO: NO se añade ::ffff:0:0/96 a la lista: en Node esa regla casa con TODAS las IPv4 (las trata como mapeadas) y bloquearía
// cualquier descarga. Las direcciones IPv6 mapeadas se rechazan explícitamente en isPublicAddress.
v4.forEach(([a, p]) => BAD.addSubnet(a, p, 'ipv4'));
v6.forEach(([a, p]) => BAD.addSubnet(a, p, 'ipv6'));

/** Expande una IPv6 a sus 8 grupos de 16 bits (admite la forma con IPv4 al final). */
function groups6(addr: string): number[] | null {
  let a = addr.toLowerCase().split('%')[0];
  const m = a.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (m) {
    const p = m[2].split('.').map(Number);
    if (p.some((x) => x > 255)) return null;
    a = m[1] + ((p[0] << 8) | p[1]).toString(16) + ':' + ((p[2] << 8) | p[3]).toString(16);
  }
  const halves = a.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const all = [...head, ...Array(fill).fill('0'), ...tail].map((g) => parseInt(g || '0', 16));
  return all.length === 8 && all.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? all : null;
}

/** true solo si la dirección es una IP pública. Entradas inválidas → false. */
export function isPublicAddress(address: string): boolean {
  const fam = isIP(address);
  if (fam === 0) return false;
  if (fam === 6) {
    const g = groups6(address);
    if (!g) return false;
    if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return false;       // IPv4 mapeada (::ffff:a.b.c.d): siempre rechazada
    return !BAD.check(address, 'ipv6');
  }
  return !BAD.check(address, 'ipv4');
}

export class UrlError extends Error {}

const BAD_SUFFIXES = ['.localhost', '.local', '.internal', '.localdomain', '.home.arpa', '.lan', '.intranet', '.corp'];

/**
 * Valida y normaliza la URL ANTES de cualquier conexión.
 * Solo https, sin credenciales, puerto 443, host con nombre (no IP) de al menos dos etiquetas.
 */
export function parseSafeUrl(raw: string): URL {
  if (typeof raw !== 'string' || raw.length < 12 || raw.length > 2048) throw new UrlError('longitud');
  if (/[\u0000- \u007f-\u009f\\]/.test(raw)) throw new UrlError('caracteres no permitidos');
  let u: URL;
  try { u = new URL(raw); } catch { throw new UrlError('url mal formada'); }
  if (u.protocol !== 'https:') throw new UrlError('solo https');
  if (u.username || u.password) throw new UrlError('credenciales en la url');
  if (u.port !== '' && u.port !== '443') throw new UrlError('puerto no permitido');
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!host || host.length > 253) throw new UrlError('host');
  if (host.startsWith('[') || isIP(host) !== 0) throw new UrlError('ip literal');      // WHATWG ya normaliza 2130706433, 0x7f.1, 0177.0.0.1… a 127.0.0.1
  if (!host.includes('.')) throw new UrlError('host de una sola etiqueta');           // p. ej. `db`, que Docker resolvería a una IP interna
  if (host === 'localhost' || BAD_SUFFIXES.some((s) => host.endsWith(s))) throw new UrlError('host local');
  if (/^\d+(\.\d+)*$/.test(host)) throw new UrlError('host numérico');
  const labels = host.split('.');
  // Cada etiqueta: 1 a 63 caracteres alfanuméricos o guion (punycode incluido), sin empezar ni acabar en guion; TLD con letras.
  if (!labels.every((l) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(l))) throw new UrlError('nombre de host no válido');
  if (!/^([a-z]{2,}|xn--[a-z0-9-]+)$/.test(labels[labels.length - 1])) throw new UrlError('dominio de primer nivel no válido');
  u.hash = '';
  return u;
}
