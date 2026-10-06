<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { api, apiBlob } from '../../api';
import { messageFor } from '../../errors';
import { isNetworkError, offlineFile } from '../../offline';

/** El QR lo genera el servidor a partir de la URL con la que se emitió el PDF: es el mismo código que lleva el documento. */
const route = useRoute();
const saved = ref(0);   // > 0: se enseña la copia guardada (sin cobertura)
const url = ref(''), error = ref(''), loading = ref(true);
onMounted(async () => {
  try {
    const t = await api<any>(`/driver/transports/${route.query.t}`);
    if (!t.deca) throw new Error('sin DeCA');
    url.value = URL.createObjectURL(await apiBlob(`/driver/decas/${t.deca.id}/qr.svg`));
  } catch (e) {
    const copy = isNetworkError(e) ? await offlineFile(String(route.query.t ?? ''), 'qr') : null;
    if (copy) { url.value = URL.createObjectURL(copy.blob); saved.value = copy.savedAt; }
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
      <p v-if="loading" class="muted">Preparando el QR…</p>
      <p v-else-if="error" class="alert alert-err">{{ error }}</p>
      <section v-else class="d-qrcard">
        <div class="d-label">QR del DeCA</div>
        <img :src="url" alt="Código QR del DeCA" />
        <p class="d-note">Sube el brillo de la pantalla y muéstralo al agente. Al escanearlo se descarga el DeCA.</p>
      </section>
    </div>
  </div>
</template>
