<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue';
defineProps<{ title: string; wide?: boolean }>();
const emit = defineEmits<{ close: [] }>();
const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') emit('close'); };
onMounted(() => document.addEventListener('keydown', onKey));
onUnmounted(() => document.removeEventListener('keydown', onKey));
</script>
<template>
  <div class="modal-back" @click.self="emit('close')">
    <div :class="['modal', { wide }]" role="dialog" aria-modal="true" :aria-label="title">
      <div class="modal-head"><h2>{{ title }}</h2><button class="btn btn-sm" type="button" aria-label="Cerrar" @click="emit('close')">Cerrar</button></div>
      <slot />
    </div>
  </div>
</template>
