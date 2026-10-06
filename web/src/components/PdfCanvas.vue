<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref } from 'vue';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.min.mjs';
import workerSrc from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';

/**
 * Muestra el PDF REAL emitido por el servidor (sus mismos bytes) dibujando cada página en un canvas: se ve igual en cualquier
 * navegador, también en móviles que solo enseñan la primera página de un iframe. No se reconstruye el documento con HTML.
 */
const props = defineProps<{ blob: Blob }>();
const emit = defineEmits<{ pages: [n: number]; failed: [] }>();
pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

const host = ref<HTMLElement | null>(null);
const state = ref<'loading' | 'ok' | 'error'>('loading');
let doc: pdfjs.PDFDocumentProxy | null = null;
let resizeTimer = 0, lastWidth = 0;

async function render(): Promise<void> {
  if (!doc || !host.value) return;
  const width = host.value.clientWidth; lastWidth = width;
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  host.value.replaceChildren();
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: (width / base.width) * dpr });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(vp.width); canvas.height = Math.floor(vp.height);
    canvas.className = 'pdf-page'; canvas.setAttribute('aria-label', `Página ${n} de ${doc.numPages} del DeCA`);
    host.value.appendChild(canvas);
    await page.render({ canvasContext: canvas.getContext('2d')!, viewport: vp }).promise;
  }
}
const onResize = (): void => {
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => { if (host.value && Math.abs(host.value.clientWidth - lastWidth) > 4) void render(); }, 250);
};

onMounted(async () => {
  try {
    doc = await pdfjs.getDocument({ data: new Uint8Array(await props.blob.arrayBuffer()), isEvalSupported: false, enableXfa: false }).promise;
    state.value = 'ok'; emit('pages', doc.numPages);
    await nextTick(); await render();
    window.addEventListener('resize', onResize);
  } catch { state.value = 'error'; emit('failed'); }
});
onUnmounted(() => { window.removeEventListener('resize', onResize); void doc?.destroy(); });
</script>
<template>
  <p v-if="state === 'loading'" class="muted">Preparando el documento…</p>
  <p v-else-if="state === 'error'" class="alert alert-warn">No se ha podido mostrar el PDF aquí. Usa «Abrir» o «Descargar».</p>
  <div v-show="state === 'ok'" ref="host" class="pdf-pages"></div>
</template>
