/**
 * IBAN: validación (ISO 13616, módulo 97) y, para IBAN españoles, identificación de la entidad por las posiciones 5-8 (código de entidad del Banco de España)
 * y comprobación de los dígitos de control de la cuenta. La tabla es ORIENTATIVA (lista pública de entidades): si un código no está, se muestra el código y no se inventa el nombre.
 */
export const ES_BANKS: Record<string, string> = {
  '2080': 'ABANCA', '0061': 'Banca March', '0078': 'Banca Pueyo', '0188': 'Banco Alcalá', '0182': 'BBVA', '0130': 'Banco Caixa Geral', '0234': 'Banco Caminos',
  '2105': 'Banco Castilla-La Mancha', '0198': 'Banco Cooperativo Español', '2108': 'Banco de Caja España de Inversiones', '0240': 'Banco de Crédito Social Cooperativo',
  '0003': 'Banco de Depósitos', '0081': 'Banco Sabadell', '0057': 'Banco Depositario BBVA', '0232': 'Banco Inversis', '0487': 'Banco Mare Nostrum', '0186': 'Banco Mediolanum',
  '0238': 'Banco Pastor (hoy Santander)', '0075': 'Banco Popular (hoy Santander)', '0049': 'Banco Santander', '2038': 'Bankia (hoy CaixaBank)', '0128': 'Bankinter', '0138': 'Bankoa',
  '0152': 'Barclays Bank', '0144': 'BNP Paribas Securities Services', '3025': 'Caixa d’Enginyers', '2100': 'CaixaBank', '2045': 'Caixa Ontinyent', '3183': 'Caja de Arquitectos',
  '3035': 'Caja Laboral (Laboral Kutxa)', '3081': 'Caja Rural Castilla-La Mancha', '3058': 'Cajamar Caja Rural', '2000': 'Cecabank', '1474': 'Citibank Europe', '0019': 'Deutsche Bank',
  '0231': 'Dexia Sabadell', '0211': 'EBN Banco de Negocios', '0239': 'EVO Banco', '1497': 'Haitong Bank', '2085': 'Ibercaja Banco', '1465': 'ING', '2095': 'Kutxabank',
  '2048': 'Liberbank (hoy Unicaja)', '0131': 'Novo Banco (sucursal en España)', '0073': 'Openbank', '0094': 'RBC Investor Services España', '0083': 'Renta 4 Banco',
  '0224': 'Santander Consumer Finance', '0038': 'Santander Securities Services', '1490': 'Self Trade Bank', '0108': 'Société Générale (sucursal en España)', '2103': 'Unicaja Banco'
};

const LENGTHS: Record<string, number> = { AD: 24, AT: 20, BE: 16, BG: 22, CH: 21, CY: 28, CZ: 24, DE: 22, DK: 18, EE: 20, ES: 24, FI: 18, FR: 27, GB: 22, GR: 27, HR: 21, HU: 28, IE: 22, IS: 26, IT: 27,
  LI: 21, LT: 20, LU: 20, LV: 21, MT: 31, NL: 18, NO: 15, PL: 28, PT: 25, RO: 24, SE: 24, SI: 19, SK: 24, SM: 27 };
const COUNTRY: Record<string, string> = { ES: 'España', PT: 'Portugal', FR: 'Francia', DE: 'Alemania', IT: 'Italia', RO: 'Rumanía', BG: 'Bulgaria', PL: 'Polonia', GB: 'Reino Unido', NL: 'Países Bajos',
  BE: 'Bélgica', LT: 'Lituania', AD: 'Andorra', IE: 'Irlanda', LU: 'Luxemburgo', AT: 'Austria', CH: 'Suiza', GR: 'Grecia', HU: 'Hungría', CZ: 'Chequia', SK: 'Eslovaquia', HR: 'Croacia' };

export const normIban = (v: string): string => v.replace(/[\s-]/g, '').toUpperCase();

/** Módulo 97 sobre el IBAN reordenado (ISO 13616) sin números gigantes. */
function mod97(iban: string): number {
  const s = (iban.slice(4) + iban.slice(0, 4)).replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let r = 0;
  for (const ch of s) r = (r * 10 + Number(ch)) % 97;
  return r;
}

/** Dígitos de control de la cuenta española (CCC): DC1 sobre «00»+entidad+oficina y DC2 sobre los 10 dígitos de la cuenta. */
function esDc(digits: string): number {
  const w = [1, 2, 4, 8, 5, 10, 9, 7, 3, 6];
  const sum = digits.split('').reduce((a, d, i) => a + Number(d) * w[i], 0);
  const dc = 11 - (sum % 11);
  return dc === 11 ? 0 : dc === 10 ? 1 : dc;
}

export interface IbanInfo { valid: boolean; reason?: 'formato' | 'longitud' | 'control' | 'cuenta'; iban?: string; country?: string; country_name?: string; bank_code?: string | null; bank?: string | null }

export function checkIban(raw: string): IbanInfo {
  const iban = normIban(raw);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return { valid: false, reason: 'formato' };
  const cc = iban.slice(0, 2);
  if (LENGTHS[cc] !== undefined ? iban.length !== LENGTHS[cc] : iban.length < 15 || iban.length > 34) return { valid: false, reason: 'longitud' };
  if (mod97(iban) !== 1) return { valid: false, reason: 'control' };
  let bank_code: string | null = null, bank: string | null = null;
  if (cc === 'ES') {
    const ccc = iban.slice(4);
    if (!/^\d{20}$/.test(ccc)) return { valid: false, reason: 'formato' };
    if (esDc('00' + ccc.slice(0, 8)) !== Number(ccc[8]) || esDc(ccc.slice(10)) !== Number(ccc[9])) return { valid: false, reason: 'cuenta' };
    bank_code = ccc.slice(0, 4); bank = ES_BANKS[bank_code] ?? null;
  }
  return { valid: true, iban, country: cc, country_name: COUNTRY[cc] ?? cc, bank_code, bank };
}

export const groupIban = (iban: string): string => iban.replace(/(.{4})/g, '$1 ').trim();
/** «ES91 •••• •••• •• ••••1332»: solo los 4 últimos caracteres. */
export const maskIban = (iban: string): string => groupIban(iban.slice(0, 4) + '•'.repeat(iban.length - 8) + iban.slice(-4)).replace(/•{4}/g, '••••');
