<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import StatusBadge from '../../components/StatusBadge.vue';
import { api, auth } from '../../api';
import { messageFor } from '../../errors';
import { fmtDate } from '../../format';

const route = useRoute(), router = useRouter();
const rows = ref<any[]>([]), error = ref(''), loading = ref(true);
const estado = ref<string>((route.query.estado as string) ?? '');
const canWrite = computed(() => auth.user?.role === 'admin' || auth.user?.role === 'oficina');
async function load(): Promise<void> {
  loading.value = true; error.value = '';
  try { rows.value = await api(`/transports${estado.value ? `?status=${estado.value}` : ''}`); } catch (e) { error.value = messageFor(e); } finally { loading.value = false; }
}
watch(estado, (v) => { void router.replace({ query: v ? { estado: v } : {} }); void load(); });
onMounted(load);
</script>
<template>
  <div class="page-title">
    <h1>Transportes</h1>
    <div class="row">
      <select v-model="estado" aria-label="Filtrar por estado">
        <option value="">Todos</option><option value="PENDIENTE">Pendientes (sin conductor)</option><option value="EN_CURSO">En curso (con conductor)</option><option value="FINALIZADO">Finalizados</option><option value="CANCELADO">Anulados</option>
      </select>
      <RouterLink v-if="canWrite" class="btn btn-accent" to="/oficina/transportes/nuevo">Nuevo transporte</RouterLink>
    </div>
  </div>
  <p v-if="error" class="alert alert-err">{{ error }}</p>
  <p v-if="loading" class="muted">Cargando…</p>
  <p v-else-if="!rows.length" class="muted">No hay transportes{{ estado ? ' en este estado' : '' }}.</p>
  <div v-else class="table-wrap">
    <table>
      <thead><tr><th>Fecha</th><th>Estado</th><th>Ruta</th><th>Cargador</th><th>Conductor</th><th>Vehículo</th><th>DeCA</th></tr></thead>
      <tbody>
        <tr v-for="t in rows" :key="t.id" class="link" tabindex="0" @click="router.push(`/oficina/transportes/${t.id}`)" @keydown.enter="router.push(`/oficina/transportes/${t.id}`)">
          <td class="nowrap">{{ fmtDate(t.transport_date) }}</td>
          <td><StatusBadge :status="t.status" /></td>
          <td>{{ t.origin }}<br /><span class="muted small">→ {{ t.destination }}</span></td>
          <td>{{ t.shipper_name }}</td>
          <td>{{ t.driver_name ?? '—' }}</td>
          <td class="nowrap">{{ t.tractor ?? '—' }}<template v-if="t.trailer"><br /><span class="muted small">{{ t.trailer }}</span></template></td>
          <td><span :class="['badge', t.deca_id ? 'b-fin' : 'b-pend']">{{ t.deca_id ? 'Emitido' : 'Sin DeCA' }}</span></td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
