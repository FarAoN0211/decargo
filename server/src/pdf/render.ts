import { generateCartaPdf } from './carta-pdf';
import { DecaPdfInput, generateDecaPdf } from './deca-pdf';
import { generateFichasPdf } from './fichas-pdf';

export type Template = 'DECARGO' | 'ESTANDAR' | 'CARTA_DE_PORTE';
/** Modelo con el que se generó un DeCA (los antiguos, sin modelo guardado, eran el de apartados). */
export const templateOf = (v: unknown): Template => (v === 'CARTA_DE_PORTE' || v === 'DECARGO' ? v : 'ESTANDAR');
/** Genera el PDF con el modelo indicado. Un DeCA conserva SIEMPRE el modelo con el que se emitió (también en sus versiones). */
export function renderDecaPdf(tpl: Template, i: DecaPdfInput): Promise<Buffer> {
  return tpl === 'CARTA_DE_PORTE' ? generateCartaPdf(i) : tpl === 'DECARGO' ? generateFichasPdf(i) : generateDecaPdf(i);
}
