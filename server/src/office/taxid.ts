/**
 * Comprobación SIN CONEXIÓN de un identificador fiscal español: CIF (sociedades), DNI o NIE (personas físicas). Es un aviso, no un bloqueo:
 * algunas empresas extranjeras tienen otros formatos y los datos reales a veces traen erratas que conviene señalar.
 */
export type TaxIdKind = 'CIF' | 'DNI' | 'NIE' | 'OTRO';
export interface TaxIdCheck { normalized: string; kind: TaxIdKind; valid: boolean | null }   // valid null = formato no español, no se puede comprobar

export const normTaxId = (v: string): string => v.replace(/[\s.\-/]/g, '').toUpperCase();

function cifControl(body: string): { digit: string; letter: string } {
  let sum = 0;
  for (let i = 0; i < 7; i++) {
    const d = Number(body[i]);
    if (i % 2 === 0) { const x = d * 2; sum += Math.floor(x / 10) + (x % 10); } else sum += d;
  }
  const c = (10 - (sum % 10)) % 10;
  return { digit: String(c), letter: 'JABCDEFGHI'[c] };
}

export function checkTaxId(raw: string): TaxIdCheck {
  const s = normTaxId(raw);
  let m = /^([ABCDEFGHJNPQRSUVW])(\d{7})([0-9A-J])$/.exec(s);
  if (m) {
    const { digit, letter } = cifControl(m[2]);
    const needLetter = 'KPQRSNW'.includes(m[1]), needDigit = 'ABEH'.includes(m[1]);
    const ok = needLetter ? m[3] === letter : needDigit ? m[3] === digit : m[3] === digit || m[3] === letter;
    return { normalized: s, kind: 'CIF', valid: ok };
  }
  m = /^([XYZ]|\d)(\d{7})([A-Z])$/.exec(s);
  if (m) {
    const n = Number(({ X: '0', Y: '1', Z: '2' } as Record<string, string>)[m[1]] ?? m[1]) * 1e7 + Number(m[2]);
    return { normalized: s, kind: /^[XYZ]/.test(s) ? 'NIE' : 'DNI', valid: 'TRWAGMYFPDXBNJZSQVHLCKE'[n % 23] === m[3] };
  }
  return { normalized: s, kind: 'OTRO', valid: null };
}
