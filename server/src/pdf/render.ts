import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { generateCartaPdf } from './carta-pdf';
import { DecaPdfInput, generateDecaPdf } from './deca-pdf';
import { generateFichasPdf } from './fichas-pdf';
import { setFontProvider } from './fonts';

/** En el servidor, las fuentes se leen del disco de la imagen (assets/fonts). */
const ASSETS = path.join(__dirname, '..', '..', 'assets', 'fonts');
setFontProvider(async () => ({
  regular: await fs.readFile(path.join(ASSETS, 'DejaVuSans.ttf')),
  bold: await fs.readFile(path.join(ASSETS, 'DejaVuSans-Bold.ttf'))
}));

export type Template = 'DECARGO' | 'ESTANDAR' | 'CARTA_DE_PORTE';
/** Modelo con el que se generó un DeCA (los antiguos, sin modelo guardado, eran el de apartados). */
export const templateOf = (v: unknown): Template => (v === 'CARTA_DE_PORTE' || v === 'DECARGO' ? v : 'ESTANDAR');
/** Genera el PDF con el modelo indicado. Un DeCA conserva SIEMPRE el modelo con el que se emitió (también en sus versiones). */
export async function renderDecaPdf(tpl: Template, i: DecaPdfInput): Promise<Buffer> {
  const gen = tpl === 'CARTA_DE_PORTE' ? generateCartaPdf : tpl === 'DECARGO' ? generateFichasPdf : generateDecaPdf;
  return Buffer.from(await gen(i));
}
