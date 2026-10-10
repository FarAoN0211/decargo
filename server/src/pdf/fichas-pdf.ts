import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, PDFFont, PDFPage, rgb } from 'pdf-lib';
import QRCode from 'qrcode';
import { fontBytes } from './fonts';
import { DecaPdfInput, esDate, temperatureLine, wrap } from './deca-pdf';

/**
 * «Modelo DECARGO»: DeCA en fichas (cabecera con QR, intervinientes, carga y entrega, vehículo y conductor, mercancía y observaciones).
 * Contiene los apartados a-h del art. 6 de la Orden FOM/2861/2012 y los datos de la Resolución de 5/6/2026 (QR, URL, fechas de creación y
 * modificación). Todo en UNA página: si el contenido no cabe, se reduce el tamaño de letra (y solo en casos extremos se pasa a otra página).
 * Los datos opcionales vacíos no se imprimen.
 */
const INK = rgb(0.07, 0.24, 0.31), ACCENT = rgb(0.17, 0.48, 0.42), MUTED = rgb(0.33, 0.38, 0.41), BLACK = rgb(0.08, 0.08, 0.08), RED = rgb(0.7, 0.1, 0.1);
const PW = 595.28, PH = 841.89, M = 26, W = PW - 2 * M, PAD = 7, R = 6;
let GAP = 7;   // separación entre fichas (se reduce con letra pequeña)
const KIND: Record<string, string> = { TRACTORA: 'Tractora', SEMIRREMOLQUE: 'Semirremolque', REMOLQUE: 'Remolque', RIGIDO: 'Camión rígido' };
const when = (iso: string): string => new Date(iso).toLocaleString('es-ES', { timeZone: 'Europe/Madrid', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const money = (v: string | null | undefined): string => (v ? `${Number(v).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €` : '');
const kg = (v: string): string => `${Number(v).toLocaleString('es-ES', { maximumFractionDigits: 2 })} kg`;
const pal = (n: number): string => `${n} ${n === 1 ? 'palet' : 'palets'}`;

/** st por línea lógica (las separadas por «\n»): 'b' = vigente, en negrita; 'old' = dato anterior, en rojo, sin negrita y un punto más pequeño. */
type Style = 'b' | 'old' | undefined;
type Field = [label: string, value: string, styles?: Style[]];
interface Fonts { regular: PDFFont; bold: PDFFont }

export async function generateFichasPdf(i: DecaPdfInput): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.registerFontkit(fontkit);
  const fb = await fontBytes();
  const regular = await doc.embedFont(fb.regular, { subset: true });
  const bold = await doc.embedFont(fb.bold, { subset: true });
  const F: Fonts = { regular, bold };
  doc.setTitle(i.blank ? 'DeCA (formulario en blanco)' : `DeCA ${i.data.reference ?? i.decaId} v${i.versionNo}`);
  doc.setSubject('Documento de Control Administrativo (Orden FOM/2861/2012)');
  doc.setCreator('DECARGO'); doc.setProducer('DECARGO');
  doc.setCreationDate(i.createdAt); doc.setModificationDate(i.modifiedAt);

  // Logo de la empresa (opcional). Si la imagen no se puede incrustar, el DeCA se emite igual, sin logo.
  const logo = i.logo ? await (i.logo.png ? doc.embedPng(i.logo.bytes) : doc.embedJpg(i.logo.bytes)).catch(() => null) : null;

  const d = i.data;
  const banner = i.banner ?? (i.isTest ? 'DOCUMENTO DE PRUEBA · SIN VALOR · DECARGO' : null);

  // ---------------------------------------------------------------- contenido (independiente del tamaño de letra)
  const stopsO = d.originStops ?? [{ party: null, address: d.origin, time: null, pallets: null, refs: [], seals: [] }];
  const stopsD = d.destinationStops ?? (d.consignees?.length ? d.consignees.map((c) => ({ party: c.name, address: c.address, time: null, pallets: null, refs: [], seals: [] })) : [{ party: null, address: d.destination, time: null, pallets: null, refs: [], seals: [] }]);
  const date = d.transportDate ? esDate(d.transportDate) : '';
  /** Un campo por lugar: «Lugar de carga 2 · hora 09:30» → empresa, dirección y, cada uno en su línea, palets, referencias y precintos.
   *  Con un solo lugar los palets no se repiten aquí: ya constan en «Mercancía» (en la entrega solo si no coinciden con lo cargado). */
  const stopFields = (s: (typeof stopsO)[number], n: number, total: number, kind: 'carga' | 'descarga'): Field[] => {
    const loaded = d.palletsTotal ?? d.units ?? null;
    const showPallets = s.pallets != null && (total > 1 || (kind === 'descarga' && loaded !== null && s.pallets !== loaded));
    const lines = [
      s.party ?? '', s.address,
      ...(showPallets ? [`Palets: ${s.pallets}`] : []),
      ...(s.refs?.length ? [`${s.refs.length > 1 ? 'Referencias' : 'Referencia'}: ${s.refs.join(', ')}`] : []),
      ...(s.seals?.length ? [`${s.seals.length > 1 ? 'Precintos' : 'Precinto'}: ${s.seals.join(', ')}`] : [])
    ].filter(Boolean);
    const label = `${kind === 'carga' ? 'Lugar de carga' : 'Lugar de entrega'}${total > 1 ? ` ${n}` : ''}${s.time ? ` · hora ${s.time}` : ''}`;
    return [[label, lines.join('\n')]];
  };
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
  // ---- Trazabilidad de los cambios de vehículo y de conductor: lo vigente en negrita, lo anterior en rojo (nunca se borra nada).
  type Person = NonNullable<typeof d.driver>;
  const plates = (tr: string | null | undefined, tl: string | null | undefined): string => [tr, tl].filter(Boolean).join(' / ');
  const personLine = (p: Person): string => [p.name, p.nif ? `DNI/NIE: ${p.nif}` : '', p.phone ? `Tel.: ${p.phone}` : ''].filter(Boolean).join(' · ');
  const vChanges = d.vehicleChanges ?? [];
  const dChanges: Array<{ at: string | null; driver: Person }> = d.driverChanges ?? (d.driver2 ? [{ at: null, driver: d.driver2 }] : []);   // DeCA antiguos: solo constaba el conductor sucesivo
  const curTractor = vChanges.at(-1)?.tractorPlate ?? d.tractorPlate, curTrailer = vChanges.length ? vChanges.at(-1)!.trailerPlate : (d.trailerPlate ?? null);
  const curDriver: Person | null = dChanges.at(-1)?.driver ?? d.driver ?? null;
  /** Matrículas o conductores que ya no son los vigentes, sin repetir. */
  const uniq = <T,>(l: T[], key: (x: T) => string): T[] => l.filter((x, k) => key(x) && l.findIndex((y) => key(y) === key(x)) === k);
  const prevTractors = uniq([d.tractorPlate, ...vChanges.map((v) => v.tractorPlate)], (x) => x).filter((x) => x !== curTractor);
  const prevTrailers = uniq([d.trailerPlate ?? '', ...vChanges.map((v) => v.trailerPlate ?? '')], (x) => x).filter((x) => x !== (curTrailer ?? ''));
  const prevDrivers = uniq([...(d.driver ? [d.driver] : []), ...dChanges.map((k) => k.driver)], (p) => p.name).filter((p) => p.name !== curDriver?.name);
  /** Campo con el dato vigente en negrita y debajo, en rojo, los anteriores. */
  const withPrev = (cur: string, prev: string[], label = 'Anterior'): { v: string; st: Style[] } => ({
    v: [cur, ...prev.map((x) => `${label}: ${x}`)].filter(Boolean).join('\n'), st: [...(cur ? ['b' as Style] : []), ...prev.map((): Style => 'old')] });
  /** Observaciones: solo qué vehículo (o conductor) sustituye a cuál y el motivo; los datos completos ya constan en «Vehículo y conductor». */
  const trace = ((): { v: string; st: Style[] } | null => {
    type Ev = { at: string | null; text: string };
    const evs: Ev[] = [];
    let tr = d.tractorPlate, tl = d.trailerPlate ?? null;
    for (const v of vChanges) {
      const reason = v.reason && v.reason !== 'Cambio de vehículo' ? ` Motivo: ${v.reason}` : '';
      evs.push({ at: v.at, text: `Cambio de matrícula (${when(v.at)}): ${plates(tr, tl)} sustituido por ${plates(v.tractorPlate, v.trailerPlate)}.${reason}` });
      tr = v.tractorPlate; tl = v.trailerPlate;
    }
    let dr: Person | null = d.driver ?? null;
    for (const k of dChanges) {
      if (dr) evs.push({ at: k.at, text: `Cambio de conductor${k.at ? ` (${when(k.at)})` : ''}: ${dr.name} sustituido por ${k.driver.name}.` });
      dr = k.driver;
    }
    if (!evs.length) return null;
    evs.sort((x, y) => (x.at ?? '9').localeCompare(y.at ?? '9'));
    return { v: evs.map((e) => e.text).join('\n'), st: evs.map((): Style => undefined) };
  })();
  const remarks = [d.remarks ?? '', d.aecRef ? `Autorización especial de circulación: ${d.aecRef}` : ''].filter(Boolean).join('\n');

  // ---------------------------------------------------------------- maquetación (dos pasadas: medir y dibujar)
  // Cada bloque se mide con un tamaño de letra; se elige el mayor que cabe en una página.
  interface Ctx { page: PDFPage | null; s: number; y: number }
  const lh = (s: number): number => s * 1.28;
  const labelH = (s: number): number => (s - 1.3) * 1.25;
  /** Altura de un campo (etiqueta + valor) en una columna de ancho w. */
  const OLD = 1.2;   // los datos anteriores van un punto y pico más pequeños
  const sizeOf = (st: Style, s: number): number => (st === 'old' ? s - OLD : s);
  const fontOf = (st: Style): PDFFont => (st === 'b' ? F.bold : F.regular);
  /** Líneas de un campo ya ajustadas al ancho, con su estilo. */
  const fieldLines = (f: Field, w: number, s: number): Array<{ t: string; st: Style }> =>
    f[1].split('\n').flatMap((para, k) => wrap(para, fontOf(f[2]?.[k]), sizeOf(f[2]?.[k], s), w).map((t) => ({ t, st: f[2]?.[k] })));
  const fieldH = (f: Field, w: number, s: number): number => (f[1].trim() ? labelH(s) + fieldLines(f, w, s).reduce((a, l) => a + lh(sizeOf(l.st, s)), 0) + 3 : 0);
  const colH = (fields: Field[], w: number, s: number): number => fields.reduce((a, f) => a + fieldH(f, w, s), 0);
  const drawFields = (c: Ctx, fields: Field[], x: number, y: number, w: number): void => {
    for (const f of fields) {
      const [label, value] = f;
      if (!value.trim() || !c.page) continue;
      c.page.drawText(label, { x, y: y - (c.s - 1.3), size: c.s - 1.3, font: F.bold, color: ACCENT });
      y -= labelH(c.s);
      for (const l of fieldLines(f, w, c.s)) {
        const sz = sizeOf(l.st, c.s);
        c.page.drawText(l.t, { x, y: y - sz, size: sz, font: fontOf(l.st), color: l.st === 'old' ? RED : BLACK });
        y -= lh(sz);
      }
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
  /** El recuadro del QR se ajusta al tamaño de letra (con 6 pt, 84 pt: el QR sigue midiendo más de 2 cm). */
  const qrCellFor = (s: number): number => Math.max(84, Math.min(110, 84 + (s - 6) * 10));
  const blocks: Array<(c: Ctx) => number> = [
    // Cabecera: datos del documento + QR
    (c) => {
      // [logo] [datos del documento] [QR]. La casilla del logo es como la del QR (más ancha si el logo es apaisado).
      const qrCell = qrCellFor(c.s), logoW = logo ? Math.round(qrCell * (logo.width / logo.height > 1.6 ? 1.45 : 1)) : 0;
      const hx = M + (logo ? logoW + GAP : 0), leftW = W - qrCell - GAP - (logo ? logoW + GAP : 0);
      const ref: Field = ['Referencia', d.reference ?? ''], made: Field = ['Creado', i.blank ? '' : when(i.createdAt.toISOString())];
      const fecha: Field = ['f) Fecha de realización', date], ver: Field = ['Versión', i.blank ? '' : String(i.versionNo)];
      const mod: Field = ['Última modificación', i.blank ? '' : when(i.modifiedAt.toISOString())];
      // Con logo queda menos ancho: dos columnas en vez de tres.
      const head: Field[][] = logo ? [[ref, made, mod], [fecha, ver]] : [[ref, made], [fecha, ver], [mod]];
      const urlF: Field[] = i.blank ? [] : [['Documento en línea (también en el QR)', i.url]];
      const page = c.page; c.page = null;
      const tH = c.s + 9, cw = (leftW - 2 * PAD - 8 * (head.length - 1)) / head.length;
      const headH = Math.max(...head.map((col) => colH(col, cw, c.s)));
      const inner = headH + colH(urlF, leftW - 2 * PAD, c.s);
      const h = Math.max(tH + PAD + inner + PAD, qrCell);
      c.page = page;
      if (c.page) {
        if (logo) {
          roundRect(c.page, M, c.y, logoW, h);
          const k = Math.min((logoW - 12) / logo.width, (h - 12) / logo.height), lw = logo.width * k, lh = logo.height * k;
          c.page.drawImage(logo, { x: M + (logoW - lw) / 2, y: c.y - h + (h - lh) / 2, width: lw, height: lh });
        }
        roundRect(c.page, hx, c.y, leftW, h);
        const title = 'Documento de Control Administrativo (DeCA)', ts = Math.min(c.s + 3, (leftW - 2 * PAD) / F.bold.widthOfTextAtSize(title, 1));
        c.page.drawText(title, { x: hx + PAD, y: c.y - PAD - c.s - 2, size: ts, font: F.bold, color: INK });
        head.forEach((col, k) => drawFields(c, col, hx + PAD + k * (cw + 8), c.y - PAD - tH, cw));
        drawFields(c, urlF, hx + PAD, c.y - PAD - tH - headH, leftW - 2 * PAD);
        const qx = hx + leftW + GAP;
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
    (c) => sectionTitle(c, 'c) Origen y destino'),
    (c) => {
      const w = (W - GAP) / 2;
      return row(c, [
        { w, title: 'Carga', cols: [[...stopsO.flatMap((s, n) => stopFields(s, n + 1, stopsO.length, 'carga')), ...totalLine(stopsO, 'Total cargado')]] },
        { w, title: 'Entrega', cols: [[...stopsD.flatMap((s, n) => stopFields(s, n + 1, stopsD.length, 'descarga')), ...totalLine(stopsD, 'Total entregado')]] }
      ]);
    },
    (c) => sectionTitle(c, 'd) Mercancía'),
    (c) => {
      const cols: Field[][] = [[], [], []];
      goods.forEach((f, k) => cols[k % 3].push(f));
      return row(c, [{ w: W, title: '', cols }]);
    },
    (c) => sectionTitle(c, 'g) Vehículo y conductor'),
    (c) => {
      const t1 = withPrev(curTractor, prevTractors), t2 = withPrev(curTrailer ?? '', prevTrailers);
      // Conductor vigente: una línea por dato, en negrita. Los anteriores, igual, en rojo.
      const cur = curDriver ? person(curDriver).split('\n') : [];
      const prev = prevDrivers.flatMap((p) => person(p).split('\n').map((l, k) => (k === 0 ? `Anterior: ${l}` : l)));
      const dv = { v: [...cur, ...prev].join('\n'), st: [...cur.map((): Style => 'b'), ...prev.map((): Style => 'old')] };
      return row(c, [{ w: W, title: '', cols: [
        [['Tipo de conjunto', d.tractorPlate ? conjunto : ''], ['Conductor', dv.v, dv.st]],
        [[`Matrícula ${d.tractorKind ? (KIND[d.tractorKind] ?? d.tractorKind).toLowerCase() : 'vehículo'}`, t1.v, t1.st]],
        [[`Matrícula ${d.trailerKind ? (KIND[d.trailerKind] ?? d.trailerKind).toLowerCase() : 'remolque o semirremolque'}`, t2.v, t2.st]]
      ] }]);
    },
    (c) => sectionTitle(c, d.aecRef ? 'e) Autorización especial · h) Observaciones' : 'h) Observaciones'),
    (c) => {
      // Primero lo escrito por la oficina; después, la trazabilidad de los cambios.
      const base = remarks || (trace || i.blank ? '' : 'Sin observaciones.');
      const v = [base, trace?.v ?? ''].filter(Boolean).join('\n'), st: Style[] = [...(base ? base.split('\n').map((): Style => undefined) : []), ...(trace?.st ?? [])];
      return row(c, [{ w: W, title: '', cols: [[['Observaciones, reservas y otras indicaciones', v, st]]] }]);
    }
  ];

  const TITLES = new Set([1, 3, 5, 7, 9]);   // índices de los bloques que son títulos de sección
  // ---------------------------------------------------------------- elegir el tamaño: el mayor con el que todo cabe en una página
  const top0 = PH - M - (banner ? 20 : 0), bottom = M + 16;
  const measure = (s: number): number => { GAP = s < 7 ? 5 : 7; const c: Ctx = { page: null, s, y: 0 }; return blocks.reduce((a, b) => a + b(c) + GAP, 0); };
  let s = 8.6;
  // Por debajo de 6 pt ya no se lee bien: en ese caso extremo, mejor una segunda página.
  while (s > 6 && measure(s) > top0 - bottom) s = Math.round((s - 0.2) * 10) / 10;
  GAP = s < 7 ? 5 : 7;

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
  return doc.save({ useObjectStreams: false });
}
