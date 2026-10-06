<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import StatusBadge from '../../components/StatusBadge.vue';
import { api, auth } from '../../api';
import { messageFor } from '../../errors';
import { fmtDate } from '../../format';
import { useFit } from '../../fit';

const route = useRoute(), router = useRouter();
const rows = ref<any[]>([]), error = ref(''), loading = ref(true), counts = ref<Record<string, number>>({});
const estado = ref<string>((route.query.estado as string) ?? '');
const q = ref('');
const canWrite = computed(() => auth.user?.role === 'admin' || auth.user?.role === 'oficina');
const STATES = [{ v: '', t: 'Todos' }, { v: 'PENDIENTE', t: 'Pendientes' }, { v: 'EN_CURSO', t: 'En curso' }, { v: 'FINALIZADO', t: 'Finalizados' }, { v: 'CANCELADO', t: 'Anulados' }];
const total = computed(() => Object.values(counts.value).reduce((a, n) => a + n, 0));
const norm = (v: string): string => v.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
/** Búsqueda en pantalla: referencia, ruta, cargador, conductor y matrículas. */
const shown = computed(() => {
  const s = norm(q.value.trim());
  return s ? rows.value.filter((t) => norm([t.reference, t.origin, t.destination, t.shipper_name, t.driver_name, t.tractor, t.trailer].filter(Boolean).join(' ')).includes(s)) : rows.value;
});
async function load(): Promise<void> {
  loading.value = true; error.value = '';
  try { rows.value = await api(`/transports${estado.value ? `?status=${estado.value}` : ''}`); } catch (e) { error.value = messageFor(e); } finally { loading.value = false; }
}
async function loadCounts(): Promise<void> { try { counts.value = (await api<any>('/dashboard')).transports; } catch { /* sin cifras */ } }
watch(estado, (v) => { void router.replace({ query: v ? { estado: v } : {} }); void load(); });
useFit();
onMounted(() => { void load(); void loadCounts(); });
</script>
<template>
  <div class="page-title">
    <div><h1>Transportes</h1><p class="pg-sub">Todos los transportes de la empresa, con su conductor, vehículo y DeCA.</p></div>
    <div class="pg-actions"><RouterLink v-if="canWrite" class="btn btn-accent" to="/oficina/transportes/nuevo">Nuevo transporte</RouterLink></div>
  </div>
  <div class="toolbar">
    <label class="search"><input v-model="q" type="search" placeholder="Buscar por referencia, ruta, cargador, conductor o matrícula…" aria-label="Buscar transportes" autocomplete="off" /></label>
    <div class="chips" role="group" aria-label="Filtrar por estado">
      <button v-for="s in STATES" :key="s.v" type="button" :class="['chip', { on: estado === s.v }]" @click="estado = s.v">{{ s.t }}<span v-if="s.v ? counts[s.v] !== undefined : total" class="n">{{ s.v ? counts[s.v] : total }}</span></button>
    </div>
  </div>
  <div class="fit">
    <p v-if="error" class="alert alert-err">{{ error }}</p>
    <p v-if="loading" class="muted">Cargando…</p>
    <div v-else-if="!shown.length" class="ui-sec"><div class="empty"><b>{{ q ? 'Ningún transporte coincide con la búsqueda' : `No hay transportes${estado ? ' en este estado' : ''}` }}</b>{{ q ? 'Prueba con otra referencia, ruta o matrícula.' : canWrite ? 'Crea el primero con «Nuevo transporte».' : '' }}</div></div>
    <div v-else class="ui-sec flush">
      <table>
        <thead><tr><th>Fecha</th><th>Estado</th><th>Ruta</th><th>Cargador</th><th>Conductor</th><th>Vehículo</th><th>DeCA</th></tr></thead>
        <tbody>
          <tr v-for="t in shown" :key="t.id" class="link" tabindex="0" @click="router.push(`/oficina/transportes/${t.id}`)" @keydown.enter="router.push(`/oficina/transportes/${t.id}`)">
            <td class="nowrap"><span class="two">{{ fmtDate(t.transport_date) }}</span><span v-if="t.reference" class="two mono">{{ t.reference }}</span></td>
            <td><StatusBadge :status="t.status" /></td>
            <td><span class="two ell" :title="t.origin">{{ t.origin }}</span><span class="two ell" :title="t.destination">→ {{ t.destination }}</span></td>
            <td><span class="ell ell-s" :title="t.shipper_name">{{ t.shipper_name }}</span></td>
            <td>{{ t.driver_name ?? '—' }}</td>
            <td class="nowrap"><span class="two">{{ t.tractor ?? '—' }}</span><span v-if="t.trailer" class="two">{{ t.trailer }}</span></td>
            <td><span :class="['badge', t.deca_id ? 'b-fin' : 'b-pend']">{{ t.deca_id ? 'Emitido' : 'Sin DeCA' }}</span></td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-if="!loading && shown.length" class="muted small pad-top">{{ shown.length }} transporte{{ shown.length === 1 ? '' : 's' }}{{ q ? ` de ${rows.length}` : '' }}.</p>
  </div>
</template>
