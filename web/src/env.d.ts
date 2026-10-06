/// <reference types="vite/client" />
// La variante «legacy» de pdf.js (compatible con móviles antiguos) no trae tipos propios: reutiliza los del paquete principal.
declare module 'pdfjs-dist/legacy/build/pdf.min.mjs' {
  export * from 'pdfjs-dist';
}
