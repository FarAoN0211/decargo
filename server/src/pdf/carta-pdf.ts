import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, PDFFont, PDFPage, rgb } from 'pdf-lib';
import QRCode from 'qrcode';
import { fontBytes } from './fonts';
import { DecaPdfInput, GREY, esDate, temperatureLine, wrap } from './deca-pdf';

/**
 * Modelo «Carta de porte» (documento de control con casillas numeradas, Orden FOM/2861/2012). Se genera NATIVO: texto real con fuente embebida y QR vectorial,
 * sin imágenes ni escaneos (RES segundo.2). Mantiene lo que exige la Resolución: identificador, versión, fechas de creación y modificación y QR con la URL única.
 */
const BLACK = rgb(0.1, 0.1, 0.1);
const LINE = rgb(0.25, 0.25, 0.25);
const HEAD = rgb(0.955, 0.955, 0.955);
const SIZES = [9, 8.5, 8, 7.5, 7, 6.5, 6];

/** Localidad de una dirección: último tramo tras la coma, sin código postal («Camino X, 68, 18004 Granada» → «Granada»). */
export function placeOf(address: string): string {
  const parts = address.split(',').map((s) => s.trim()).filter(Boolean);
  const last = (parts[parts.length - 1] ?? address).replace(/^\d{4,5}\s*/, '').trim();
  return last || address;
}

/** « · Ref.: A-1, A-2 · Precinto: 123». */
const extras = (s: { refs?: string[]; seals?: string[] }): string => {
  const r = s.refs ?? [], p = s.seals ?? [];
  return `${r.length ? ` · ${r.length > 1 ? 'Referencias' : 'Ref.'}: ${r.join(', ')}` : ''}${p.length ? ` · ${p.length > 1 ? 'Precintos' : 'Precinto'}: ${p.join(', ')}` : ''}`;
};
const when = (iso: string): string => new Date(iso).toLocaleString('es-ES', { timeZone: 'Europe/Madrid', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const uniq = (l: string[]): string[] => Array.from(new Set(l.filter(Boolean)));
const pal = (n: number): string => `${n} ${n === 1 ? 'palet' : 'palets'}`;
const money = (v: string | null | undefined): string => (v ? `${Number(v).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €` : '');

export async function generateCartaPdf(i: DecaPdfInput): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.registerFontkit(fontkit);
  const fb = await fontBytes();
  const regular = await doc.embedFont(fb.regular, { subset: true });
  const bold = await doc.embedFont(fb.bold, { subset: true });
  doc.setTitle(i.blank ? 'Carta de porte (formulario en blanco)' : `DeCA ${i.decaId} v${i.versionNo}`);
  doc.setSubject('Documento de control de transporte de mercancías por carretera (Orden FOM/2861/2012)');
  doc.setCreator('DECARGO'); doc.setProducer('DECARGO');
  doc.setCreationDate(i.createdAt); doc.setModificationDate(i.modifiedAt);

  const page: PDFPage = doc.addPage([595.28, 841.89]);
  const M = 28, W = 595.28 - 2 * M, HALF = W / 2;
  const d = i.data;

  // ---- título (y rótulo de prueba / ejemplo)
  let top = 841.89 - 24;
  page.drawText('DOCUMENTO DE CONTROL DE TRANSPORTE DE MERCANCÍAS POR CARRETERA', { x: M, y: top - 11, size: 11, font: bold, color: BLACK });
  top -= 22;
  const banner = i.banner ?? (i.isTest ? 'DOCUMENTO DE PRUEBA · SIN VALOR · DECARGO' : null);
  if (banner) {
    page.drawRectangle({ x: M, y: top - 14, width: W, height: 14, color: rgb(0.99, 0.9, 0.9) });
    page.drawText(banner, { x: M + 6, y: top - 10.5, size: 8.5, font: bold, color: rgb(0.7, 0.1, 0.1) });
    top -= 18;
  }

  /** Dibuja un recuadro con su etiqueta y devuelve el área de contenido. */
  const box = (x: number, yTop: number, w: number, h: number, label: string, headH = 12): { x: number; y: number; w: number; h: number } => {
    page.drawRectangle({ x, y: yTop - h, width: w, height: h, borderColor: LINE, borderWidth: 0.7 });
    page.drawRectangle({ x: x + 0.35, y: yTop - headH, width: w - 0.7, height: headH - 0.35, color: HEAD });
    const lines = wrap(label, bold, 6.6, w - 8);
    lines.slice(0, 3).forEach((l, k) => page.drawText(l, { x: x + 4, y: yTop - 8.6 - k * 8.2, size: 6.6, font: bold, color: BLACK }));
    return { x: x + 4, y: yTop - headH - 2, w: w - 8, h: h - headH - 4 };
  };
  /** Escribe texto ajustando el tamaño para que quepa en el área (nunca se recorta en silencio: baja hasta 6 pt). */
  const write = (area: { x: number; y: number; w: number; h: number }, text: string, font: PDFFont = regular, startAt = 0): void => {
    if (!text.trim()) return;
    for (const size of SIZES.slice(startAt)) {
      const lines = wrap(text, font, size, area.w);
      const lh = size * 1.28;
      if (lines.length * lh <= area.h + 1 || size === 6) {
        const fit = Math.max(1, Math.floor((area.h + 1) / lh));
        const shown = lines.slice(0, fit);
        if (lines.length > fit) shown[fit - 1] = `${shown[fit - 1].slice(0, Math.max(0, shown[fit - 1].length - 2))} …`;   // jamás en silencio: se ve que continúa
        shown.forEach((l, k) => page.drawText(l, { x: area.x, y: area.y - size - k * lh + 1, size, font, color: BLACK }));
        return;
      }
    }
  };

  // ---- columnas izquierda y derecha (alturas alineadas: 1=7, 2=8, 3=8.1, 4+5+6=9, 11=9.1)
  const LX = M, RX = M + HALF;
  const h = { b1: 98, b2: 70, b3: 38, b4: 38, b5: 36, b6: 32, b11: 80 };
  // Casillas 3 y 4: SOLO el lugar (localidad) de origen y de destino. El desglose por lugar va en la casilla 12.
  const txtOrigin = (d.originPlaces?.length ? d.originPlaces : [d.origin]).join(' / ');
  const txtDest = (d.destinationPlaces?.length ? d.destinationPlaces : [d.destination]).join(' / ');
  const need = (t: string, head = 12): number => Math.ceil(wrap(t, regular, 7.5, HALF - 8).length * 7.5 * 1.28) + head + 6;
  // Casilla 2: cada consignatario con un dato por línea (razón social / domicilio / NIF); si hay varios, numerados.
  const consignees = d.consignees?.length ? d.consignees : [{ name: null, address: d.destination, nif: null }];
  const txtCons = consignees.map((c, i) => [c.name ? `${consignees.length > 1 ? `${i + 1}) ` : ''}${c.name}` : '', c.address, c.nif ? `NIF: ${c.nif}` : ''].filter(Boolean).join('\n')).join('\n');
  h.b2 = Math.max(h.b2, need(txtCons, 26));
  const txtChanges = (d.vehicleChanges ?? []).map((c) => `${when(c.at)} · ${c.tractorPlate}${c.trailerPlate ? ` / ${c.trailerPlate}` : ''}`).join('\n');
  h.b3 = Math.max(h.b3, need(txtOrigin), txtChanges ? need(txtChanges, 24) : 0); h.b4 = Math.max(h.b4, need(txtDest));
  // Casilla 12: con un solo lugar de carga y de descarga, el resumen clásico (referencias y precintos); con varios, el desglose por lugar con sus palets y el total.
  const oL = d.originLoads ?? [], dL = d.destinationLoads ?? [];
  const sumP = (l: typeof oL): number | null => (l.some((x) => x.pallets !== null) ? l.reduce((a, x) => a + (x.pallets ?? 0), 0) : null);
  const hasData = (l: typeof oL): boolean => l.some((x) => x.pallets !== null || (x.refs?.length ?? 0) > 0 || (x.seals?.length ?? 0) > 0);
  const multi = oL.length > 1 || dL.length > 1;
  const detailBlock = (title: string, totalLabel: string, l: typeof oL): string[] => {
    if (!hasData(l)) return [];
    const out = [title, ...l.map((x, k) => `${l.length > 1 ? `${k + 1}) ` : ''}${x.place}${x.pallets !== null ? ` — ${pal(x.pallets)}` : ''}${extras(x)}`)];
    const t = sumP(l);
    return l.length > 1 && t !== null ? [...out, `${totalLabel}: ${pal(t)}`] : out;
  };
  const refsL = uniq([d.loadReference ?? '', ...oL.flatMap((l) => l.refs ?? [])]), refsD = uniq(dL.flatMap((l) => l.refs ?? []));
  const seals = uniq([...oL.flatMap((l) => l.seals ?? []), ...dL.flatMap((l) => l.seals ?? [])]);
  // Con varios lugares: CARGA a la izquierda y DESCARGA a la derecha (dos columnas); con uno solo de cada, el resumen clásico a todo el ancho.
  const left12: string[] = multi
    ? [...(d.loadReference ? [`REFERENCIA DE CARGA: ${d.loadReference}`] : []), ...detailBlock('CARGA', 'Total cargado', oL)]
    : [refsL.length ? `${refsL.length > 1 ? 'REFERENCIAS' : 'REFERENCIA'} DE CARGA: ${refsL.join(', ')}` : '', refsD.length ? `${refsD.length > 1 ? 'REFERENCIAS' : 'REFERENCIA'} DE DESCARGA: ${refsD.join(', ')}` : '',
       seals.length ? `${seals.length > 1 ? 'PRECINTOS' : 'PRECINTO'}: ${seals.join(', ')}` : ''].filter(Boolean);
  const right12: string[] = multi ? detailBlock('DESCARGA', 'Total descargado', dL) : [];
  const two = right12.length > 0, w12 = two ? W / 2 - 14 : W - 8;
  const rows12 = Math.max(wrap(left12.join('\n'), regular, 7.5, w12).length, two ? wrap(right12.join('\n'), regular, 7.5, w12).length : 0);
  const need12 = left12.length || right12.length ? Math.ceil(rows12 * 7.5 * 1.28) + 12 + 26 + 8 : 0;
  const fx = { h12: Math.max(90, need12), h121: 38, hb: 92 };
  // Si el conjunto no cabe en la página (con el QR), se comprimen las casillas con más holgura, de la menos importante a la más.
  const qrN = i.blank ? 0 : QRCode.create(i.url, { errorCorrectionLevel: 'M' }).modules.size;
  const reserve = 20 + 26 + (i.blank ? 0 : (qrN + 8) * 2.0 + 6);
  const total = (): number => h.b1 + h.b2 + h.b3 + h.b4 + h.b5 + h.b6 + h.b11 + fx.h12 + fx.h121 + fx.hb;
  const squeeze: Array<[() => number, (v: number) => void, number]> = [
    [() => h.b11, (v) => { h.b11 = v; }, 44], [() => fx.h12, (v) => { fx.h12 = v; }, Math.max(56, need12)], [() => fx.hb, (v) => { fx.hb = v; }, 74], [() => h.b2, (v) => { h.b2 = v; }, 54],
    [() => h.b1, (v) => { h.b1 = v; }, 70], [() => h.b6, (v) => { h.b6 = v; }, 26], [() => h.b5, (v) => { h.b5 = v; }, 30], [() => fx.h121, (v) => { fx.h121 = v; }, 30]
  ];
  for (const [get, set, min] of squeeze) { const over = total() - (top - reserve); if (over <= 0) break; set(Math.max(min, get() - over)); }
  let y = top;
  const a1 = box(LX, y, HALF, h.b1, '1. Cargador o remitente (razón social y domicilio)');
  write(a1, [d.shipper.name, d.shipper.address, d.shipper.nif ? `NIF: ${d.shipper.nif}` : ''].filter(Boolean).join('\n'));
  const a7 = box(RX, y, HALF, h.b1, '7. Empresa transportista (razón social y domicilio)');
  write(a7, [d.carrier.name, d.carrierAddress ?? '', d.carrier.nif ? `NIF: ${d.carrier.nif}` : ''].filter(Boolean).join('\n'));
  y -= h.b1;
  const a2 = box(LX, y, HALF, h.b2, '2. Consignatario o destinatario (razón social y domicilio)');
  write(a2, txtCons);
  const a8 = box(RX, y, HALF, h.b2, '8. Matrícula del vehículo (en caso de vehículos articulados deberá reflejarse la de la tractora y el remolque o semirremolque)', 26);
  write({ ...a8, w: a8.w / 2 - 4 }, d.tractorPlate, bold, 1);
  write({ ...a8, x: a8.x + a8.w / 2, w: a8.w / 2 }, d.trailerPlate ?? '', bold, 1);
  y -= h.b2;
  const a3 = box(LX, y, HALF, h.b3, '3. Lugar de origen de la expedición');
  write(a3, txtOrigin);
  const a81 = box(RX, y, HALF, h.b3, '8.1. Si iniciada la operación se produce un cambio de vehículo, indíquese esta circunstancia por el transportista.', 24);
  write(a81, txtChanges, bold, 1);
  y -= h.b3;
  const a4 = box(LX, y, HALF, h.b4, '4. Lugar de destino de la expedición');
  write(a4, txtDest);
  const hDriver = h.b4 + h.b5 + h.b6;
  const a9 = box(RX, y, HALF, hDriver, '9. Datos conductor efectivo.');
  if (d.driver) write(a9, [d.driver.name, [d.driver.nif ? `DNI: ${d.driver.nif}` : '', d.driver.phone ? `TLF: ${d.driver.phone}` : ''].filter(Boolean).join('   ')].filter(Boolean).join('\n'));
  y -= h.b4;
  const a5 = box(LX, y, HALF, h.b5, '5. Fecha de realización del transporte');
  if (!i.blank) write(a5, esDate(d.transportDate));
  y -= h.b5;
  const a6 = box(LX, y, HALF, h.b6, '6. Precio del transporte (dato no obligatorio)');
  write(a6, money(d.priceEur));
  y -= h.b6;
  const a11 = box(LX, y, HALF, h.b11, '11. Observaciones');
  write(a11, [temperatureLine(d.temperature), d.remarks ?? '', d.aecRef ? `Autorización especial de circulación: ${d.aecRef}` : ''].filter(Boolean).join('\n'));
  const a91 = box(RX, y, HALF, h.b11, '9.1 Datos conductor efectivo sucesivo.');
  if (d.driver2) write(a91, [d.driver2.name, [d.driver2.nif ? `DNI: ${d.driver2.nif}` : '', d.driver2.phone ? `TLF: ${d.driver2.phone}` : ''].filter(Boolean).join('   ')].filter(Boolean).join('\n'));
  y -= h.b11;

  // ---- 12 y 12.1 (ancho completo)
  const h12 = fx.h12, h121 = fx.h121;
  const a12 = box(M, y, W, h12, '12. Naturaleza de la mercancía, peso bruto (kg.) y número de bultos.');
  const col = a12.w;
  write({ ...a12, w: col * 0.5 }, d.cargoDescription);
  write({ ...a12, x: a12.x + col * 0.52, w: col * 0.22 }, d.packages ?? '');
  write({ ...a12, x: a12.x + col * 0.76, w: col * 0.24 }, d.weightKg ? `${Number(d.weightKg).toLocaleString('es-ES', { maximumFractionDigits: 2 })} kg` : '');
  const body12 = { ...a12, y: a12.y - 26, h: a12.h - 26 };
  write({ ...body12, w: w12 }, left12.join('\n'));
  if (two) write({ ...body12, x: a12.x + W / 2, w: w12 }, right12.join('\n'));
  y -= h12;
  const a121 = box(M, y, W, h121, '12.1. Volumen u otra magnitud que permita determinar su cantidad y peso en caso de que resulte difícil determinación el peso exacto de la mercancía.', 22);
  write(a121, d.altMagnitude ?? '', regular, 1);
  y -= h121;

  // ---- 13, 14 y 15: firmas y sellos
  const hb = fx.hb, w13 = W * 0.26, w14 = W * 0.34, w15 = W - w13 - w14;
  const sign = (x: number, w: number, head: string, caption: string): void => {
    box(x, y, w, hb, head);
    page.drawLine({ start: { x, y: y - hb + 12 }, end: { x: x + w, y: y - hb + 12 }, thickness: 0.5, color: LINE });
    page.drawText(caption, { x: x + 4, y: y - hb + 4, size: 6.6, font: bold, color: BLACK });
  };
  sign(M, w13, '13.', 'Firma y sello del cargador');
  sign(M + w13, w14, '14.', 'Firma y sello de la empresa transportista');
  sign(M + w13 + w14, w15, '15. Recibo de la mercancía', 'Firma y sello del consignatario');
  page.drawText('Lugar:', { x: M + w13 + w14 + 5, y: y - 24, size: 7.5, font: regular, color: BLACK });
  page.drawText('a:', { x: M + W - 70, y: y - 24, size: 7.5, font: regular, color: BLACK });
  y -= hb;

  // ---- pie legal
  const legal = wrap('El presente documento de control está elaborado de conformidad con lo establecido a la orden FOM/2861/2012 de 13 de diciembre - B.O.E. 13/12/2012', regular, 7, W);
  legal.forEach((l, k) => page.drawText(l, { x: M, y: y - 10 - k * 9, size: 7, font: regular, color: BLACK }));
  y -= 10 + legal.length * 9 + 6;

  // ---- identificación del documento y QR (obligatorio en el DeCA; vectorial)
  if (!i.blank) {
    const qr = QRCode.create(i.url, { errorCorrectionLevel: 'M' });
    const n = qr.modules.size, quiet = 4;
    const avail = y - 18;                                    // espacio hasta el margen inferior
    const mod = Math.max(1.8, Math.min(3.0, avail / (n + 2 * quiet)));
    const qrSize = (n + 2 * quiet) * mod, qrX = M + W - qrSize, qrY = y - qrSize;
    page.drawRectangle({ x: qrX, y: qrY, width: qrSize, height: qrSize, color: rgb(1, 1, 1) });
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.modules.get(r, c)) page.drawRectangle({ x: qrX + (quiet + c) * mod, y: qrY + (quiet + n - 1 - r) * mod, width: mod, height: mod, color: rgb(0, 0, 0) });
    const info: [string, string][] = [['Identificador del DeCA', i.decaId], ['Versión', String(i.versionNo)], ['Creación (UTC)', i.createdAt.toISOString()], ['Última modificación (UTC)', i.modifiedAt.toISOString()]];
    let iy = y - 8;
    for (const [k, v] of info) { page.drawText(k, { x: M, y: iy, size: 7, font: regular, color: GREY }); page.drawText(v, { x: M, y: iy - 9, size: 8, font: regular }); iy -= 22; }
    page.drawText('Documento en línea (escanee el QR):', { x: M, y: iy, size: 7, font: regular, color: GREY });
    wrap(i.url, regular, 7, W - qrSize - 20).forEach((l, k) => page.drawText(l, { x: M, y: iy - 9 - k * 8.5, size: 7, font: regular }));
  }
  return doc.save({ useObjectStreams: false });
}
