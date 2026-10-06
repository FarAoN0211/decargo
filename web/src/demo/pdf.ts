import { PDFDocument, StandardFonts, degrees, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import QRCode from 'qrcode';

/**
 * PDF del DeCA en la DEMO: se genera en el navegador con los datos ficticios del transporte (apartados a-h de la Orden FOM/2861/2012)
 * y lleva una marca de agua grande. No es el generador real del servidor ni tiene valor alguno.
 */
export interface DemoDeca {
  version: number; createdAt: string; modifiedAt: string; url: string; date: string;
  shipper: { name: string; nif: string; address: string }; carrier: { name: string; nif: string; address: string };
  origins: string[]; destinations: string[]; consignees: string[]; cargo: string; weight: string; packages: string;
  tractor: string; trailer: string; driver: string; remarks: string; changes: string[];
}

const INK = rgb(0.07, 0.24, 0.31), GREY = rgb(0.35, 0.4, 0.43);

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(' ')) {
      const t = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(t, size) > width && line) { out.push(line); line = word; } else line = t;
    }
    out.push(line);
  }
  return out;
}

export async function demoDecaPdf(d: DemoDeca): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle('DeCA de demostración'); doc.setProducer('DECARGO (demostración)'); doc.setCreator('DECARGO demo');
  const page: PDFPage = doc.addPage([595.28, 841.89]);
  const font = await doc.embedFont(StandardFonts.Helvetica), bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const W = 595.28, M = 42;
  let y = 800;
  page.drawText('DOCUMENTO DE CONTROL ADMINISTRATIVO (DeCA)', { x: M, y, size: 14, font: bold, color: INK });
  y -= 16;
  page.drawText('Orden FOM/2861/2012 · versión de DEMOSTRACIÓN con datos ficticios', { x: M, y, size: 9, font, color: GREY });
  y -= 22;
  const section = (title: string, rows: Array<[string, string]>): void => {
    page.drawRectangle({ x: M, y: y - 4, width: W - 2 * M, height: 16, color: rgb(0.91, 0.94, 0.95) });
    page.drawText(title, { x: M + 6, y, size: 9.5, font: bold, color: INK });
    y -= 18;
    for (const [k, v] of rows) {
      const lines = wrap(v || '—', font, 9, W - 2 * M - 150);
      page.drawText(k, { x: M + 6, y, size: 9, font: bold, color: GREY });
      for (const l of lines) { page.drawText(l, { x: M + 150, y, size: 9, font }); y -= 12; }
      y -= 3;
    }
    y -= 6;
  };
  section('a) CARGADOR CONTRACTUAL', [['Nombre', d.shipper.name], ['NIF', d.shipper.nif], ['Domicilio', d.shipper.address]]);
  section('b) TRANSPORTISTA EFECTIVO', [['Nombre', d.carrier.name], ['NIF', d.carrier.nif], ['Domicilio', d.carrier.address]]);
  section('c) ORIGEN Y DESTINO', [['Origen', d.origins.join('\n')], ['Destino', d.destinations.join('\n')], ['Consignatario', d.consignees.join('\n')]]);
  section('d) MERCANCÍA', [['Naturaleza', d.cargo], ['Peso / magnitud', d.weight], ['Bultos', d.packages]]);
  section('e) FECHA DEL TRANSPORTE', [['Fecha', d.date]]);
  section('g) VEHÍCULO Y CONDUCTOR', [['Matrículas', `${d.tractor}${d.trailer ? ` / ${d.trailer}` : ''}`], ['Conductor', d.driver], ...(d.changes.length ? [['Cambios', d.changes.join('\n')] as [string, string]] : [])]);
  section('h) OBSERVACIONES', [['Observaciones', d.remarks]]);

  // QR (el mismo enlace de siempre: en la demo apunta a la propia demo)
  const qr = QRCode.create(d.url, { errorCorrectionLevel: 'M' });
  const n = qr.modules.size, cell = 2.4, qx = W - M - n * cell, qy = 60;
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.modules.get(r, c)) page.drawRectangle({ x: qx + c * cell, y: qy + (n - 1 - r) * cell, width: cell, height: cell, color: rgb(0, 0, 0) });
  page.drawText(`Versión ${d.version} · creado ${d.createdAt} · modificado ${d.modifiedAt}`, { x: M, y: 74, size: 8, font, color: GREY });
  page.drawText(d.url, { x: M, y: 62, size: 8, font, color: GREY });

  // Marca de agua
  page.drawText('DEMOSTRACIÓN · SIN VALOR', { x: 110, y: 300, size: 46, font: bold, color: rgb(0.85, 0.2, 0.15), opacity: 0.18, rotate: degrees(35) });
  return doc.save();
}

export function demoQrSvg(url: string): Promise<string> {
  return QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'M', margin: 4 });
}
