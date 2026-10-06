<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { api, apiBlob } from '../../api';
import PdfCanvas from '../../components/PdfCanvas.vue';
import { messageFor } from '../../errors';
import { isNetworkError, offlineFile } from '../../offline';

/** Abre el PDF REAL emitido por el servidor. No se reconstruye el documento con HTML. */
const route = useRoute();
const saved = ref(0);   // > 0: se enseña la copia guardada (sin cobertura)
const url = ref(''), blob = ref<Blob | null>(null), error = ref(''), loading = ref(true);
onMounted(async () => {
  try {
    const t = await api<any>(`/driver/transports/${route.query.t}`);
    if (!t.deca) throw new Error('sin DeCA');
    blob.value = await apiBlob(`/driver/decas/${t.deca.id}/current.pdf`);
    url.value = URL.createObjectURL(blob.value);
  } catch (e) {
    // Sin cobertura: la copia guardada en el teléfono (el PDF original tal cual lo emitió el servidor).
    const copy = isNetworkError(e) ? await offlineFile(String(route.query.t ?? ''), 'pdf') : null;
    if (copy) { blob.value = copy.blob; url.value = URL.createObjectURL(copy.blob); saved.value = copy.savedAt; }
    else error.value = e instanceof Error && e.message === 'sin DeCA' ? 'Este transporte no tiene DeCA.' : messageFor(e);
  } finally { loading.value = false; }
});
onUnmounted(() => { if (url.value) URL.revokeObjectURL(url.value); });
</script>
<template>
  <div class="d-page">
    <div class="d-wrap">
      <RouterLink class="d-back" to="/conductor">← Volver</RouterLink>
      <p v-if="saved" class="alert alert-warn small">Sin cobertura: copia guardada en el teléfono el {{ new Date(saved).toLocaleString('es-ES', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) }}.</p>
      <p v-if="loading" class="muted">Abriendo el DeCA…</p>
      <p v-else-if="error" class="alert alert-err">{{ error }}</p>
      <template v-else>
        <div class="d-pdfbox"><PdfCanvas v-if="blob" :blob="blob" /></div>
        <a class="d-btn d-btn-main" :href="url" target="_blank" rel="noopener">ABRIR EL PDF ORIGINAL</a>
        <a class="d-btn d-btn-qr" :href="url" download="DeCA.pdf">DESCARGAR PDF</a>
      </template>
    </div>
  </div>
</template>
