<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue';
import { api } from '../api';
import { fullAddress } from '../format';

/** Buscador de empresas de la agenda: al escribir el nombre (o el NIF) propone empresas guardadas; al elegir una, devuelve sus datos. */
const props = defineProps<{ label?: string; placeholder?: string }>();
const emit = defineEmits<{ (e: 'pick', p: any): void }>();
const q = ref(''), results = ref<any[]>([]), open = ref(false), loading = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined;

function onInput(): void {
  clearTimeout(timer);
  if (q.value.trim().length < 2) { results.value = []; open.value = false; return; }
  timer = setTimeout(async () => {
    loading.value = true;
    try { results.value = await api<any[]>(`/parties?q=${encodeURIComponent(q.value.trim())}`); open.value = true; } catch { results.value = []; } finally { loading.value = false; }
  }, 250);
}
async function pick(p: any): Promise<void> {
  open.value = false; q.value = '';
  try { emit('pick', await api(`/parties/${p.id}`)); } catch { emit('pick', p); }
}
onBeforeUnmount(() => clearTimeout(timer));
</script>
<template>
  <div class="picker">
    <label>{{ props.label ?? 'Buscar en la agenda de empresas' }}
      <input v-model="q" type="search" autocomplete="off" :placeholder="props.placeholder ?? 'Escribe el nombre o el NIF…'" @input="onInput" @focus="onInput" @keydown.esc="open = false" /></label>
    <ul v-if="open" class="picker-list" role="listbox">
      <li v-if="loading" class="muted small">Buscando…</li>
      <li v-else-if="!results.length" class="muted small">No hay empresas con ese nombre: se guardará como nueva al crear el transporte.</li>
      <li v-for="p in results" :key="p.id" role="option" tabindex="0" @click="pick(p)" @keydown.enter="pick(p)">
        <b>{{ p.name }}</b><span v-if="p.nif" class="mono small"> · {{ p.nif }}</span>
        <div class="muted small">{{ fullAddress(p) || 'Sin domicilio' }}<span v-if="p.sites"> · {{ p.sites }} lugar{{ p.sites > 1 ? 'es' : '' }}</span></div>
      </li>
    </ul>
  </div>
</template>
