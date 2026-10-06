import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, PDFFont, PDFPage, rgb } from 'pdf-lib';
import QRCode from 'qrcode';
import { ASSETS, DecaPdfInput, esDate, temperatureLine, wrap } from './deca-pdf';

/**
 * «Modelo DECARGO»: DeCA en fichas (cabecera con QR, intervinientes, carga y entrega, vehículo y conductor, mercancía y observaciones).
 * Contiene los apartados a-h del art. 6 de la Orden FOM/2861/2012 y los datos de la Resolución de 5/6/2026 (QR, URL, fechas de creación y
 * modificación). Todo en UNA página: si el contenido no cabe, se reduce el tamaño de letra (y solo en casos extremos se pasa a otra página).
 * Los datos opcionales vacíos no se imprimen.
 */
const INK = rgb(0.07, 0.24, 0.31), ACCENT = rgb(0.17, 0.48, 0.42), MUTED = rgb(0.33, 0.38, 0.41), BLACK = rgb(0.08, 0.08, 0.08), RED = rgb(0.7, 0.1, 0.1);
const PW = 595.28, PH = 841.89, M = 26, W = PW - 2 * M, GAP = 7, PAD = 7, R = 6;
const KIND: Record<string, string> = { TRACTORA: 'Tractora', SEMIRREMOLQUE: 'Semirremolque', REMOLQUE: 'Remolque', RIGIDO: 'Camión rígido' };
const when = (iso: string): string => new Date(iso).toLocaleString('es-ES', { timeZone: 'Europe/Madrid', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const money = (v: string | null | undefined): string => (v ? `${Number(v).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €` : '');
const kg = (v: string): string => `${Number(v).toLocaleString('es-ES', { maximumFractionDigits: 2 })} kg`;
const pal = (n: number): string => `${n} ${n === 1 ? 'palet' : 'palets'}`;

type Field = [label: string, value: string];
interface Fonts { regular: PDFFont; bold: PDFFont }

export async function generateFichasPdf(i: DecaPdfInput): Promise<Buffer> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.registerFontkit(fontkit);
  const regular = await doc.embedFont(await fs.readFile(path.join(ASSETS, 'DejaVuSans.ttf')), { subset: true });
  const bold = await doc.embedFont(await fs.readFile(path.join(ASSETS, 'DejaVuSans-Bold.ttf')), { subset: true });
  const F: Fonts = { regular, bold };
  doc.setTitle(i.blank ? 'DeCA (formulario en blanco)' : `DeCA ${i.data.reference ?? i.decaId} v${i.versionNo}`);
  doc.setSubject('Documento de Control Administrativo (Orden FOM/2861/2012)');
  doc.setCreator('DECARGO'); doc.setProducer('DECARGO');
  doc.setCreationDate(i.createdAt); doc.setModificationDate(i.modifiedAt);

  const d = i.data;
  const banner = i.banner ?? (i.isTest ? 'DOCUMENTO DE PRUEBA · SIN VALOR · DECARGO' : null);

  // ---------------------------------------------------------------- contenido (independiente del tamaño de letra)
  const stopsO = d.originStops ?? [{ party: null, address: d.origin, time: null, pallets: null, refs: [], seals: [] }];
  const stopsD = d.destinationStops ?? (d.consignees?.length ? d.consignees.map((c) => ({ party: c.name, address: c.address, time: null, pallets: null, refs: [], seals: [] })) : [{ party: null, address: d.destination, time: null, pallets: null, refs: [], seals: [] }]);
  const date = d.transportDate ? esDate(d.transportDate) : '';
  /** Un campo por lugar: «Lugar de carga 2 · 09:30» → empresa, dirección y (palets · referencias · precintos). */
  const stopFields = (s: (typeof stopsO)[number], n: number, total: number, kind: 'carga' | 'descarga'): Field[] => {
    const extra = [s.pallets != null ? pal(s.pallets) : '', s.refs?.length ? `${s.refs.length > 1 ? 'Referencias' : 'Ref.'}: ${s.refs.join(', ')}` : '', s.seals?.length ? `${s.seals.length > 1 ? 'Precintos' : 'Precinto'}: ${s.seals.join(', ')}` : ''].filter(Boolean).join(' · ');
    const label = `${kind === 'carga' ? 'Lugar de carga' : 'Lugar de entrega'}${total > 1 ? ` ${n}` : ''}${s.time ? ` · hora ${s.time}` : ''}`;
    return [[label, [s.party ?? '', s.address, extra].filter(Boolean).join('\n')]];
  };
  const dateField: Field = ['Fecha de realización del transporte', date];
  const totalLine = (l: typeof stopsO, label: string): Field[] => {
    const withP = l.filter((s) => s.pallets != null);
    return l.length > 1 && withP.length ? [[label, pal(withP.reduce((a, s) => a + (s.pallets ?? 0), 0))]] : [];
  };
  const consignees = (d.consignees?.length ? d.consignees : [{ name: '', address: d.destination, nif: null }]);
  const conjunto = [d.tractorKind ? KIND[d.tractorKind] ?? d.tractorKind : 'Vehículo', d.trailerPlate ? (d.trailerKind ? KIND[d.trailerKind] ?? d.trailerKind : 'remolque') : ''].filter(Boolean).join(' + ');
  const person = (p: { name: string; nif: string | null; phone: string | null } | null | undefined): string => (p ? [p.name, [p.nif ? `DNI/NIE: ${p.nif}` : '', p.phone ? `Tel.: ${p.phone}` : ''].filter(Boolean).join(' · ')].filter(Boolean).join('\n') : '');
  const goods: Field[] = [
    ['Naturaleza de la mercancía', d.cargoDescription],
    d.weightKg ? ['Peso bruto', kg(d.weightKg)] : ['Otra magnitud (peso de difícil determinación)', d.altMagnitude ?? ''],
    ...(d.units != null ? [['Número de unidades', String(d.units)] as Field] : []),
    ...(d.packaging ? [['Tipo de embalaje', d.packaging] as Field] : []),
    ...(d.packages && d.units == null ? [['Número y clase de bultos', d.packages] as Field] : []),
    ...(d.palletsTotal != null && !d.units ? [['Palets cargados', pal(d.palletsTotal)] as Field] : []),
    ...(d.loadReference ? [['Referencia de carga', d.loadReference] as Field] : []),
    ...(d.priceEur ? [['Precio del transporte', money(d.priceEur)] as Field] : []),
    ...(d.temperature ? [['Temperatura', temperatureLine(d.temperature).replace('Temperatura de transporte: ', '')] as Field] : []),
    ...(d.adr ? [['Mercancía peligrosa (ADR)', d.adr.detail ? `Sí · ${d.adr.detail}` : 'Sí'] as Field] : [])
  ];
  const remarks = [d.remarks ?? '', d.aecRef ? `Autorización especial de circulación: ${d.aecRef}` : ''].filter(Boolean).join('\n');

  // ---------------------------------------------------------------- maquetación (dos pasadas: medir y dibujar)
  // Cada bloque se mide con un tamaño de letra; se elige el mayor que cabe en una página.
  interface Ctx { page: PDFPage | null; s: number; y: number }
  const lh = (s: number): number => s * 1.28;
  const labelH = (s: number): number => (s - 1.3) * 1.25;
  /** Altura de un campo (etiqueta + valor) en una columna de ancho w. */
  const fieldH = (f: Field, w: number, s: number): number => (f[1].trim() ? labelH(s) + wrap(f[1], F.regular, s, w).length * lh(s) + 3 : 0);
  const colH = (fields: Field[], w: number, s: number): number => fields.reduce((a, f) => a + fieldH(f, w, s), 0);
  const drawFields = (c: Ctx, fields: Field[], x: number, y: number, w: number): void => {
    for (const [label, value] of fields) {
      if (!value.trim() || !c.page) continue;
      c.page.drawText(label, { x, y: y - (c.s - 1.3), size: c.s - 1.3, font: F.bold, color: ACCENT });
      y -= labelH(c.s);
      for (const l of wrap(value, F.regular, c.s, w)) { c.page.drawText(l, { x, y: y - c.s, size: c.s, font: F.regular, color: BLACK }); y -= lh(c.s); }
      y -= 3;
    }
  };
  const roundRect = (p: PDFPage, x: number, yTop: number, w: number, h: number, fill = false): void => {
    const r = Math.min(R, h / 2, w / 2);
    p.drawSvgPath(`M ${r} 0 H ${w - r} Q ${w} 0 ${w} ${r} V ${h - r} Q ${w} ${h} ${w - r} ${h} H ${r} Q 0 ${h} 0 ${h - r} V ${r} Q 0 0 ${r} 0 Z`,
      { x, y: yTop, borderColor: INK, borderWidth: 0.8, ...(fill ? { color: rgb(0.95, 0.97, 0.97) } : {}) });
  };
  /** Ficha con título y columnas de campos; devuelve su altura. */
  const card = (c: Ctx, x: number, w: number, title: string, cols: Field[][], forceH?: number): number => {
    const tH = title ? c.s + 5 : 0, cw = (w - 2 * PAD - (cols.length - 1) * 8) / cols.length;
    const h = forceH ?? tH + PAD + Math.max(...cols.map((col) => colH(col, cw, c.s)), lh(c.s)) + PAD - 2;
    if (c.page) {
      roundRect(c.page, x, c.y, w, h);
      if (title) c.page.drawText(title, { x: x + PAD, y: c.y - PAD - c.s, size: c.s + 0.5, font: F.bold, color: INK });
      cols.forEach((col, k) => drawFields(c, col, x + PAD + k * (cw + 8), c.y - PAD - tH, cw));
    }
    return h;
  };
  /** Fila de fichas de igual altura (la de la más alta). */
  const row = (c: Ctx, cards: Array<{ w: number; title: string; cols: Field[][] }>): number => {
    const page = c.page; c.page = null;
    const h = Math.max(...cards.map((k) => card(c, 0, k.w, k.title, k.cols)));
    c.page = page;
    let x = M;
    for (const k of cards) { card(c, x, k.w, k.title, k.cols, h); x += k.w + GAP; }
    return h;
  };
  const sectionTitle = (c: Ctx, t: string): number => {
    const h = c.s + 8;
    if (c.page) {
      c.page.drawText(t, { x: M, y: c.y - c.s - 1, size: c.s + 1, font: F.bold, color: INK });
      c.page.drawLine({ start: { x: M, y: c.y - c.s - 4 }, end: { x: M + W, y: c.y - c.s - 4 }, thickness: 0.7, color: INK });
    }
    return h;
  };

  // Bloques en orden. Cada uno dibuja en c.y y devuelve su altura.
  const qrCell = 110;
  const blocks: Array<(c: Ctx) => number> = [
    // Cabecera: datos del documento + QR
    (c) => {
      const leftW = W - qrCell - GAP;
      const head: Field[][] = [
        [['Referencia', d.reference ?? ''], ['Creado', i.blank ? '' : when(i.createdAt.toISOString())]],
        [['Versión', i.blank ? '' : String(i.versionNo)], ['Última modificación', i.blank ? '' : when(i.modifiedAt.toISOString())]]
      ];
      const urlF: Field[] = i.blank ? [] : [['Documento en línea (también en el QR)', i.url]];
      const page = c.page; c.page = null;
      const tH = c.s + 9, cw = (leftW - 2 * PAD - 8) / 2;
      const inner = Math.max(colH(head[0], cw, c.s), colH(head[1], cw, c.s)) + colH(urlF, leftW - 2 * PAD, c.s);
      const h = Math.max(tH + PAD + inner + PAD, qrCell);
      c.page = page;
      if (c.page) {
        roundRect(c.page, M, c.y, leftW, h);
        c.page.drawText('Documento de Control Administrativo (DeCA)', { x: M + PAD, y: c.y - PAD - c.s - 2, size: c.s + 3, font: F.bold, color: INK });
        drawFields(c, head[0], M + PAD, c.y - PAD - tH, cw);
        drawFields(c, head[1], M + PAD + cw + 8, c.y - PAD - tH, cw);
        drawFields(c, urlF, M + PAD, c.y - PAD - tH - Math.max(colH(head[0], cw, c.s), colH(head[1], cw, c.s)), leftW - 2 * PAD);
        const qx = M + leftW + GAP;
        roundRect(c.page, qx, c.y, qrCell, h);
        if (!i.blank) {
          const qr = QRCode.create(i.url, { errorCorrectionLevel: 'M' });
          const n = qr.modules.size, quiet = 2, mod = Math.min((qrCell - 16) / (n + 2 * quiet), (h - 26) / (n + 2 * quiet));
          const size = (n + 2 * quiet) * mod, x0 = qx + (qrCell - size) / 2, y0 = c.y - 8 - size;
          for (let r = 0; r < n; r++) for (let k = 0; k < n; k++) if (qr.modules.get(r, k)) c.page.drawRectangle({ x: x0 + (quiet + k) * mod, y: y0 + (quiet + n - 1 - r) * mod, width: mod, height: mod, color: BLACK });
          const cap = 'Escanee para descargar';
          c.page.drawText(cap, { x: qx + (qrCell - F.regular.widthOfTextAtSize(cap, 6.5)) / 2, y: c.y - h + 7, size: 6.5, font: F.regular, color: MUTED });
        }
      }
      return h;
    },
    (c) => sectionTitle(c, 'Intervinientes'),
    (c) => {
      const w = (W - 2 * GAP) / 3;
      // Con varios destinatarios, cada uno en una línea (su dirección ya figura en «Entrega»).
      const cons: Field[] = consignees.length > 1
        ? [['Razón social y NIF/CIF (domicilio: ver «Entrega»)', consignees.map((k, n) => `${n + 1}) ${k.name ?? '—'}${k.nif ? ` · ${k.nif}` : ''}`).join('\n')]]
        : consignees.flatMap((k) => [['Razón social', k.name ?? ''], ['NIF/CIF', k.nif ?? ''], ['Domicilio', k.address]] as Field[]);
      return row(c, [
        { w, title: 'a) Cargador contractual', cols: [[['Razón social', d.shipper.name], ['NIF/CIF', d.shipper.nif], ['Domicilio', d.shipper.address]]] },
        { w, title: 'b) Transportista efectivo', cols: [[['Razón social', d.carrier.name], ['NIF/CIF', d.carrier.nif], ['Domicilio', d.carrierAddress ?? ''], ['Nº de autorización de transporte', d.carrierAuthorization ?? '']]] },
        { w, title: consignees.length > 1 ? 'Destinatarios' : 'Destinatario', cols: [cons] }
      ]);
    },
    (c) => sectionTitle(c, 'c) Origen y destino · e) fecha de realización'),
    (c) => {
      const w = (W - GAP) / 2;
      return row(c, [
        { w, title: 'Carga', cols: [[dateField, ...stopsO.flatMap((s, n) => stopFields(s, n + 1, stopsO.length, 'carga')), ...totalLine(stopsO, 'Total cargado')]] },
        { w, title: 'Entrega', cols: [[dateField, ...stopsD.flatMap((s, n) => stopFields(s, n + 1, stopsD.length, 'descarga')), ...totalLine(stopsD, 'Total entregado')]] }
      ]);
    },
    (c) => sectionTitle(c, 'g) Vehículo y conductor'),
    (c) => row(c, [{ w: W, title: '', cols: [
      [['Tipo de conjunto', d.tractorPlate ? conjunto : ''], ['Conductor', person(d.driver)]],
      [[`Matrícula ${d.tractorKind ? (KIND[d.tractorKind] ?? d.tractorKind).toLowerCase() : 'vehículo'}`, d.tractorPlate], ['Conductor sucesivo (relevo)', person(d.driver2)]],
      [[`Matrícula ${d.trailerKind ? (KIND[d.trailerKind] ?? d.trailerKind).toLowerCase() : 'remolque o semirremolque'}`, d.trailerPlate ?? ''],
        ['Cambios de vehículo durante el transporte', (d.vehicleChanges ?? []).map((v) => `${when(v.at)} · ${v.tractorPlate}${v.trailerPlate ? ` / ${v.trailerPlate}` : ''}`).join('\n')]]
    ] }]),
    (c) => sectionTitle(c, 'd) Mercancía'),
    (c) => {
      const cols: Field[][] = [[], [], []];
      goods.forEach((f, k) => cols[k % 3].push(f));
      return row(c, [{ w: W, title: '', cols }]);
    },
    (c) => sectionTitle(c, 'h) Observaciones'),
    (c) => row(c, [{ w: W, title: '', cols: [[['Observaciones, reservas y otras indicaciones', remarks || (i.blank ? '' : 'Sin observaciones.')]]] }])
  ];

  const TITLES = new Set([1, 3, 5, 7, 9]);   // índices de los bloques que son títulos de sección
  // ---------------------------------------------------------------- elegir el tamaño: el mayor con el que todo cabe en una página
  const top0 = PH - M - (banner ? 20 : 0), bottom = M + 16;
  const measure = (s: number): number => { const c: Ctx = { page: null, s, y: 0 }; return blocks.reduce((a, b) => a + b(c) + GAP, 0); };
  let s = 8.6;
  // Por debajo de 6 pt ya no se lee bien: en ese caso extremo, mejor una segunda página.
  while (s > 6 && measure(s) > top0 - bottom) s = Math.round((s - 0.2) * 10) / 10;

  // ---------------------------------------------------------------- dibujar
  const pages: PDFPage[] = [];
  const newPage = (): PDFPage => { const p = doc.addPage([PW, PH]); pages.push(p); return p; };
  const c: Ctx = { page: newPage(), s, y: PH - M };
  if (banner) {
    c.page!.drawRectangle({ x: M, y: c.y - 15, width: W, height: 15, color: rgb(0.99, 0.9, 0.9) });
    c.page!.drawText(banner, { x: M + 6, y: c.y - 11, size: 8.5, font: F.bold, color: RED });
    c.y -= 20;
  }
  const heights = blocks.map((b) => b({ page: null, s, y: 0 }));
  blocks.forEach((b, k) => {
    // Un título de sección nunca se queda solo al pie: se mide junto con la ficha que le sigue.
    const need = TITLES.has(k) && k + 1 < blocks.length ? heights[k] + GAP + heights[k + 1] : heights[k];
    if (c.y - need < bottom && c.y < PH - M - 40) { c.page = newPage(); c.y = PH - M; }   // solo si de verdad no cabe (caso extremo)
    b(c);
    c.y -= heights[k] + GAP;
  });
  const ref = d.reference ? ` · Ref. ${d.reference}` : '';
  pages.forEach((p, k) => {
    const t = `Documento emitido con DECARGO${ref} · Versión ${i.blank ? '—' : i.versionNo} · Página ${k + 1} de ${pages.length}`;
    p.drawText(t, { x: (PW - F.regular.widthOfTextAtSize(t, 6.5)) / 2, y: M - 8, size: 6.5, font: F.regular, color: MUTED });
  });
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}
