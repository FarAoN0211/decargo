<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { api, auth } from '../../api';
import { messageFor } from '../../errors';
import { fmtDateTime } from '../../format';

const d = ref<any>(null), devices = ref<any[]>([]), error = ref(''), busy = ref('');
const canWrite = computed(() => auth.user?.role === 'admin' || auth.user?.role === 'oficina');
async function load(): Promise<void> {
  try { [d.value, devices.value] = await Promise.all([api('/dashboard'), api('/devices?status=PENDIENTE_DE_CONFIRMACION')]); } catch (e) { error.value = messageFor(e); }
}
async function decide(id: string, action: 'authorize' | 'revoke'): Promise<void> {
  busy.value = id; error.value = '';
  try { await api(`/devices/${id}/${action}`, { method: 'POST' }); await load(); } catch (e) { error.value = messageFor(e); } finally { busy.value = ''; }
}
onMounted(load);
</script>
<template>
  <div class="page-title"><h1>Inicio</h1><RouterLink v-if="canWrite" class="btn btn-accent" to="/oficina/transportes/nuevo">Nuevo transporte</RouterLink></div>
  <p v-if="error" class="alert alert-err">{{ error }}</p>
  <template v-if="d">
    <div class="counts">
      <RouterLink class="count c-curso" :to="{ path: '/oficina/transportes', query: { estado: 'EN_CURSO' } }"><b>{{ d.transports.EN_CURSO }}</b><span>Transportes activos (en curso)</span></RouterLink>
      <RouterLink class="count c-pend" :to="{ path: '/oficina/transportes', query: { estado: 'PENDIENTE' } }"><b>{{ d.transports.PENDIENTE }}</b><span>Transportes pendientes</span></RouterLink>
      <RouterLink class="count c-fin" :to="{ path: '/oficina/transportes', query: { estado: 'FINALIZADO' } }"><b>{{ d.transports.FINALIZADO }}</b><span>Transportes finalizados</span></RouterLink>
    </div>
    <RouterLink v-if="d.expiries && (d.expiries.expired || d.expiries.soon)" :class="['alert', d.expiries.expired ? 'alert-err' : 'alert-warn', 'block-link']" to="/oficina/caducidades">
      <b v-if="d.expiries.expired">{{ d.expiries.expired }} documento{{ d.expiries.expired > 1 ? 's' : '' }} caducado{{ d.expiries.expired > 1 ? 's' : '' }}</b><span v-if="d.expiries.expired && d.expiries.soon"> · </span>
      <b v-if="d.expiries.soon">{{ d.expiries.soon }} por caducar</b> — ver Caducidades
    </RouterLink>
    <div v-if="d.external_pending_review" class="alert alert-warn">Hay {{ d.external_pending_review }} DeCA externo(s) pendiente(s) de revisión. Se revisan desde el transporte correspondiente.</div>

    <p class="muted small">Dirección pública de los DeCA nuevos: <span class="mono">{{ d.public_base_url ?? 'sin configurar' }}</span>
      <template v-if="d.decas_other_base"> · {{ d.decas_other_base }} DeCA ya emitido(s) llevan otra dirección en su QR: siguen funcionando mientras esa dirección apunte a este servidor.</template></p>

    <h2 class="pad-top">Dispositivos pendientes de autorización</h2>
    <p v-if="!devices.length" class="muted">No hay dispositivos pendientes.</p>
    <div v-else class="table-wrap">
      <table>
        <thead><tr><th>Conductor</th><th>Dispositivo</th><th>Registrado</th><th v-if="canWrite"></th></tr></thead>
        <tbody>
          <tr v-for="x in devices" :key="x.id">
            <td>{{ x.username }}</td><td>{{ x.label ?? 'Sin nombre' }}</td><td>{{ fmtDateTime(x.registered_at) }}</td>
            <td v-if="canWrite" class="right nowrap">
              <button class="btn btn-sm btn-primary" :disabled="busy === x.id" @click="decide(x.id, 'authorize')">Autorizar</button>
              <button class="btn btn-sm btn-danger" :disabled="busy === x.id" @click="decide(x.id, 'revoke')">Revocar</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <p class="muted small">Un conductor con un teléfono nuevo puede trabajar en solo lectura hasta que la oficina lo autorice.</p>
  </template>
</template>
