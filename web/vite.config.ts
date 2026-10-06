import vue from '@vitejs/plugin-vue';
import { defineConfig, type Plugin } from 'vite';

// Sin proxy de desarrollo: el servicio nginx de producción sirve la web y reenvía /api al backend (mismo origen, sin CORS).
// `--mode demo`: la misma aplicación en /demo/ con un servidor simulado en el navegador (src/demo) y datos ficticios.
const demoHtml = (): Plugin => ({
  name: 'decargo-demo-html',
  transformIndexHtml: (html) => html
    .replace(/\s*<link rel="manifest"[^>]*>/, '')                    // la demo no se instala como aplicación
    .replace('<title>DECARGO</title>', '<meta name="robots" content="noindex" />\n    <title>DECARGO · Demostración</title>')
});
export default defineConfig(({ mode }) => mode === 'demo'
  ? { plugins: [vue({ template: { transformAssetUrls: { includeAbsolute: false } } }), demoHtml()], base: '/demo/', publicDir: false, build: { outDir: 'dist/demo', emptyOutDir: true, sourcemap: false } }
  : { plugins: [vue()], build: { outDir: 'dist', sourcemap: false } });
