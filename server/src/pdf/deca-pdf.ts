import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, PDFFont, PDFPage, rgb } from 'pdf-lib';
import QRCode from 'qrcode';
import { fontBytes } from './fonts';

/** Datos del art. 6 de la Orden FOM/2861/2012 (letras a–h) en el momento de generar el PDF. */
export interface DecaData {
  shipper: { name: string; nif: string; address: string };      // a)
  carrier: { name: string; nif: string };                        // b)
  origin: string;                                                // c)
  destination: string;                                           // c)
  cargoDescription: string;                                      // d)
  weightKg: string | null;                                       // d)
  altMagnitude: string | null;                                   // d)
  aecRef: string | null;                                         // e)
  transportDate: string;                                         // f) YYYY-MM-DD
  tractorPlate: string;                                          // g)
  trailerPlate: string | null;                                   // g)
  remarks: string | null;                                        // h)
  // Datos adicionales para la carta de porte (todos opcionales; los DeCA antiguos no los llevan)
  consignees?: Array<{ name: string | null; address: string; nif?: string | null }>;  // casilla 2: consignatario(s) o destinatario(s)
  originPlaces?: string[];                                       // casilla 3: lugar(es) de origen (localidad)
  destinationPlaces?: string[];                                  // casilla 4: lugar(es) de destino (localidad)
  originLoads?: Array<{ place: string; pallets: number | null; refs?: string[]; seals?: string[] }>;        // casilla 3: palets, referencias de carga y precintos de cada lugar
  destinationLoads?: Array<{ place: string; pallets: number | null; refs?: string[]; seals?: string[] }>;   // casilla 4: palets, referencias de descarga y precintos de cada lugar
  palletsTotal?: number | null;                                  // total de palets cargados
  carrierAddress?: string | null;                                // casilla 7
  priceEur?: string | null;                                      // casilla 6
  packages?: string | null; loadReference?: string | null; temperature?: string | null;   // casilla 12
  driver?: { name: string; nif: string | null; phone: string | null } | null;   // casilla 9 (solo si la empresa lo activa)
  template?: 'DECARGO' | 'ESTANDAR' | 'CARTA_DE_PORTE';
  // ---- Modelo DECARGO (fichas): datos opcionales; los vacíos no se imprimen
  reference?: string | null;                                     // referencia corta del transporte (DEC-AAAA-NNNNNN)
  carrierAuthorization?: string | null;                          // nº de autorización de transporte del transportista efectivo
  tractorKind?: string | null; trailerKind?: string | null;      // tipo de conjunto (tractora + semirremolque…)
  units?: number | null; packaging?: string | null;              // número de unidades y tipo de embalaje
  adr?: { detail: string | null } | null;                        // mercancía peligrosa (ADR)
  originStops?: Array<{ party: string | null; address: string; time: string | null; pallets: number | null; refs: string[]; seals: string[] }>;
  destinationStops?: Array<{ party: string | null; address: string; time: string | null; pallets: number | null; refs: string[]; seals: string[] }>;
  isTest?: boolean;                                              // el DeCA se emitió en modo de pruebas (las versiones posteriores lo conservan)
  driver2?: { name: string; nif: string | null; phone: string | null } | null;   // casilla 9.1: conductor efectivo sucesivo
  vehicleChanges?: Array<{ at: string; tractorPlate: string; trailerPlate: string | null }>;   // casilla 8.1: cambios de vehículo (el original queda en la casilla 8)
}

export interface DecaPdfInput {
  decaId: string;
  versionNo: number;
  data: DecaData;
  url: string;          // URL única del DeCA; el QR contiene solo esto
  banner?: string;      // rótulo rojo superior (por defecto, el de documento de prueba si isTest)
  blank?: boolean;      // formulario en blanco para imprimir (sin QR ni identificadores)
  createdAt: Date;      // metadato CreationDate
  modifiedAt: Date;     // metadato ModDate
  isTest: boolean;
}

export const INK = rgb(0.07, 0.24, 0.31);
export const GREY = rgb(0.35, 0.35, 0.35);

/** «+2 a +5» → «Temperatura de transporte: +2 a +5 ºC» (casilla 11, Observaciones). */
export function temperatureLine(t: string | null | undefined): string {
  const v = (t ?? '').trim();
  if (!v) return '';
  return `Temperatura de transporte: ${/(º|°|ºC|°C|\bC\b|grados)/i.test(v) ? v : `${v} ºC`}`;
}

export function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/)) {
      const t = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(t, size) <= maxWidth) line = t;
      else { if (line) out.push(line); line = word; }
    }
    out.push(line);
  }
  return out;
}

export function esDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

/**
 * Genera el PDF de forma programática y nativa: texto real con fuente embebida (subconjunto)
 * y QR dibujado como vectores. Sin imágenes, sin capturas, sin escaneos (RES segundo.2).
 */
export async function generateDecaPdf(i: DecaPdfInput): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.registerFontkit(fontkit);
  const fb = await fontBytes();
  const regular = await doc.embedFont(fb.regular, { subset: true });
  const bold = await doc.embedFont(fb.bold, { subset: true });

  doc.setTitle(`DeCA ${i.decaId} v${i.versionNo}`);
  doc.setSubject('Documento de Control Administrativo (Orden FOM/2861/2012)');
  doc.setCreator('DECARGO');
  doc.setProducer('DECARGO');
  doc.setCreationDate(i.createdAt);
  doc.setModificationDate(i.modifiedAt);

  const page: PDFPage = doc.addPage([595.28, 841.89]);
  const M = 40;
  const W = 595.28 - 2 * M;
  let y = 841.89 - M;

  page.drawText('DOCUMENTO DE CONTROL ADMINISTRATIVO (DeCA)', { x: M, y: y - 14, size: 15, font: bold, color: INK });
  y -= 30;
  page.drawText('Transporte público de mercancías por carretera · Orden FOM/2861/2012', { x: M, y: y - 8, size: 8.5, font: regular, color: GREY });
  y -= 22;
  if (i.isTest || i.banner) {
    page.drawRectangle({ x: M, y: y - 20, width: W, height: 22, color: rgb(0.99, 0.9, 0.9) });
    page.drawText(i.banner ?? 'DOCUMENTO DE PRUEBA · SIN VALOR · DECARGO', { x: M + 8, y: y - 14, size: 10, font: bold, color: rgb(0.7, 0.1, 0.1) });
    y -= 34;
  }

  const section = (title: string, rows: [string, string][]): void => {
    page.drawRectangle({ x: M, y: y - 16, width: W, height: 16, color: rgb(0.9, 0.94, 0.95) });
    page.drawText(title, { x: M + 6, y: y - 12, size: 8.5, font: bold, color: INK });
    y -= 22;
    for (const [label, value] of rows) {
      const lines = wrap(value || '—', regular, 10, W - 150);
      page.drawText(label, { x: M + 6, y: y - 9, size: 8.5, font: regular, color: GREY });
      lines.forEach((l, k) => page.drawText(l, { x: M + 150, y: y - 9 - k * 13, size: 10, font: regular }));
      y -= Math.max(1, lines.length) * 13 + 4;
    }
    y -= 6;
  };

  const d = i.data;
  section('a) CARGADOR CONTRACTUAL', [['Nombre o denominación', d.shipper.name], ['NIF', d.shipper.nif], ['Domicilio', d.shipper.address]]);
  section('b) TRANSPORTISTA EFECTIVO', [['Nombre o denominación', d.carrier.name], ['NIF', d.carrier.nif]]);
  section('c) ORIGEN Y DESTINO DEL ENVÍO', [[d.origin.includes('\n') ? 'Lugares de origen (carga)' : 'Lugar de origen', d.origin], [d.destination.includes('\n') ? 'Lugares de destino (descarga)' : 'Lugar de destino', d.destination]]);
  section('d) MERCANCÍA', [
    ['Naturaleza', d.cargoDescription],
    d.weightKg ? ['Peso', `${d.weightKg} kg`] : ['Otra magnitud (peso de difícil determinación)', d.altMagnitude ?? '']
  ]);
  section('e) AUTORIZACIÓN ESPECIAL DE CIRCULACIÓN', [['Identificación', d.aecRef ?? 'No aplica']]);
  section('f) FECHA DE REALIZACIÓN DEL TRANSPORTE', [['Fecha', esDate(d.transportDate)]]);
  section('g) MATRÍCULA DEL VEHÍCULO', [['Vehículo tractor', d.tractorPlate], ['Semirremolque o remolque', d.trailerPlate ?? '—'],
    ...(d.vehicleChanges ?? []).map((c): [string, string] => [`Cambio de vehículo (${new Date(c.at).toLocaleString('es-ES', { timeZone: 'Europe/Madrid', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })})`, `${c.tractorPlate}${c.trailerPlate ? ` / ${c.trailerPlate}` : ''}`])]);
  section('h) OBSERVACIONES, RESERVAS Y OTRAS INDICACIONES', [['Observaciones', [temperatureLine(d.temperature), d.remarks ?? ''].filter(Boolean).join('\n') || '—']]);

  // Bloque inferior: identificación del documento y QR (vectorial).
  const qr = QRCode.create(i.url, { errorCorrectionLevel: 'M' });
  const n = qr.modules.size;
  const quiet = 4;
  const mod = 3.0;                              // pt por módulo (≈1,06 mm): QR de ≈ 40 mm con zona silenciosa
  const qrSize = (n + 2 * quiet) * mod;
  const qrX = M + W - qrSize;
  const qrY = M;
  page.drawRectangle({ x: qrX, y: qrY, width: qrSize, height: qrSize, color: rgb(1, 1, 1) });
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.modules.get(r, c)) {
        page.drawRectangle({ x: qrX + (quiet + c) * mod, y: qrY + (quiet + n - 1 - r) * mod, width: mod, height: mod, color: rgb(0, 0, 0) });
      }
    }
  }

  const info: [string, string][] = [
    ['Identificador del DeCA', i.decaId],
    ['Versión', String(i.versionNo)],
    ['Creación (UTC)', i.createdAt.toISOString()],
    ['Última modificación (UTC)', i.modifiedAt.toISOString()]
  ];
  let iy = M + qrSize - 12;
  for (const [k, v] of info) {
    page.drawText(k, { x: M, y: iy, size: 7.5, font: regular, color: GREY });
    page.drawText(v, { x: M, y: iy - 10, size: 8.5, font: regular });
    iy -= 25;
  }
  const urlLines = wrap(i.url, regular, 7, W - qrSize - 20);
  page.drawText('Documento en línea (escanee el QR):', { x: M, y: iy, size: 7.5, font: regular, color: GREY });
  urlLines.forEach((l, k) => page.drawText(l, { x: M, y: iy - 10 - k * 9, size: 7, font: regular }));

  return doc.save({ useObjectStreams: false });
}
