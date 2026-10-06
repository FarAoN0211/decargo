<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { apiBlob } from '../api';
import { messageFor } from '../errors';
import Modal from './Modal.vue';
import PdfCanvas from './PdfCanvas.vue';

/** Muestra un PDF o un QR protegidos: se piden con la sesión y se enseñan desde un blob: local (nunca desde otro origen). */
const props = defineProps<{ title: string; path: string; kind: 'pdf' | 'qr'; filename?: string }>();
const emit = defineEmits<{ close: [] }>();
const url = ref(''), blob = ref<Blob | null>(null), error = ref(''), loading = ref(true);
onMounted(async () => {
  try { blob.value = await apiBlob(props.path); url.value = URL.createObjectURL(blob.value); } catch (e) { error.value = messageFor(e); } finally { loading.value = false; }
});
onUnmounted(() => { if (url.value) URL.revokeObjectURL(url.value); });
</script>
<template>
  <Modal :title="title" :wide="kind === 'pdf'" @close="emit('close')">
    <p v-if="loading" class="muted">Cargando…</p>
    <p v-else-if="error" class="alert alert-err">{{ error }}</p>
    <template v-else>
      <PdfCanvas v-if="kind === 'pdf' && blob" :blob="blob" />
      <div v-else class="stack">
        <img class="qr-big" :src="url" alt="Código QR del DeCA" />
        <p class="small muted">Es el mismo código que contiene el PDF del DeCA: al escanearlo se descarga el documento directamente.</p>
      </div>
      <div v-if="kind === 'pdf'" class="row pad-top">
        <a class="btn btn-sm" :href="url" :download="filename ?? 'documento.pdf'">Descargar PDF</a>
        <a class="btn btn-sm" :href="url" target="_blank" rel="noopener">Abrir en otra pestaña</a>
      </div>
    </template>
  </Modal>
</template>
