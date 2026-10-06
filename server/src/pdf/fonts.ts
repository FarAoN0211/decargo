/**
 * Fuentes de los PDF del DeCA (DejaVu). Los generadores no leen ficheros: piden los bytes a quien los use, así funcionan igual en el
 * servidor (los lee del disco, ver render.ts) y en la demostración del navegador (los descarga). Mismo código, mismo resultado.
 */
export interface FontBytes { regular: Uint8Array; bold: Uint8Array }
let provider: (() => Promise<FontBytes>) | null = null;
let cache: Promise<FontBytes> | null = null;
export function setFontProvider(p: () => Promise<FontBytes>): void { provider = p; cache = null; }
export function fontBytes(): Promise<FontBytes> {
  if (!provider) throw new Error('No hay fuentes configuradas para los PDF');
  return (cache ??= provider());
}
