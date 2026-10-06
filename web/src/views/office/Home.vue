<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import StatusBadge from '../../components/StatusBadge.vue';
import { api, auth } from '../../api';
import { messageFor } from '../../errors';
import { fmtDate, fmtDateTime } from '../../format';
import { useFit } from '../../fit';

const d = ref<any>(null), devices = ref<any[]>([]), recent = ref<any[]>([]), error = ref(''), busy = ref('');
const canWrite = computed(() => auth.user?.role === 'admin' || auth.user?.role === 'oficina');
async function load(): Promise<void> {
  try {
    [d.value, devices.value] = await Promise.all([api('/dashboard'), api('/devices?status=PENDIENTE_DE_CONFIRMACION')]);
    recent.value = (await api<any[]>('/transports')).slice(0, 6);
  } catch (e) { error.value = messageFor(e); }
}
async function decide(id: string, action: 'authorize' | 'revoke'): Promise<void> {
  busy.value = id; error.value = '';
  try { await api(`/devices/${id}/${action}`, { method: 'POST' }); await load(); } catch (e) { error.value = messageFor(e); } finally { busy.value = ''; }
}
const https = computed(() => !!d.value?.public_base_url?.startsWith('https://'));
useFit();
onMounted(load);
</script>
<template>
  <div class="page-title">
    <div><h1>Inicio</h1><p class="pg-sub">Resumen de la actividad{{ d?.company?.name ? ` de ${d.company.name}` : '' }}.</p></div>
    <div class="pg-actions"><RouterLink v-if="canWrite" class="btn btn-accent" to="/oficina/transportes/nuevo">Nuevo transporte</RouterLink></div>
  </div>
  <div class="fit">
    <p v-if="error" class="alert alert-err">{{ error }}</p>
    <template v-if="d">
      <div class="counts">
        <RouterLink class="count c-curso" :to="{ path: '/oficina/transportes', query: { estado: 'EN_CURSO' } }"><b>{{ d.transports.EN_CURSO }}</b><span>Transportes activos (en curso)</span></RouterLink>
        <RouterLink class="count c-pend" :to="{ path: '/oficina/transportes', query: { estado: 'PENDIENTE' } }"><b>{{ d.transports.PENDIENTE }}</b><span>Transportes pendientes (sin conductor)</span></RouterLink>
        <RouterLink class="count c-fin" :to="{ path: '/oficina/transportes', query: { estado: 'FINALIZADO' } }"><b>{{ d.transports.FINALIZADO }}</b><span>Transportes finalizados</span></RouterLink>
      </div>

      <div class="cols2">
        <section class="ui-sec flush">
          <header class="ui-head"><div><h2>Transportes recientes</h2><p>Los últimos transportes creados.</p></div><RouterLink class="btn btn-sm" to="/oficina/transportes">Ver todos</RouterLink></header>
          <div v-if="!recent.length" class="empty"><b>Todavía no hay transportes</b>Crea el primero con «Nuevo transporte».</div>
          <table v-else>
            <thead><tr><th>Fecha</th><th>Estado</th><th>Ruta</th><th>Conductor</th></tr></thead>
            <tbody>
              <tr v-for="t in recent" :key="t.id" class="link" tabindex="0" @click="$router.push(`/oficina/transportes/${t.id}`)" @keydown.enter="$router.push(`/oficina/transportes/${t.id}`)">
                <td class="nowrap"><span class="two">{{ fmtDate(t.transport_date) }}</span><span v-if="t.reference" class="two mono">{{ t.reference }}</span></td>
                <td><StatusBadge :status="t.status" /></td>
                <td><span class="two ell ell-s" :title="t.origin">{{ t.origin }}</span><span class="two ell ell-s" :title="t.destination">→ {{ t.destination }}</span></td>
                <td class="nowrap">{{ t.driver_name ?? '—' }}</td>
              </tr>
            </tbody>
          </table>
        </section>

        <div class="stack-panels">
          <section class="ui-sec">
            <header class="ui-head"><div><h2>Avisos</h2><p>Lo que conviene revisar.</p></div></header>
            <ul class="ui-flags">
              <li>
                <span :class="['ui-dot', d.expiries && (d.expiries.expired || d.expiries.soon) ? 'ko' : 'ok']">{{ d.expiries && (d.expiries.expired || d.expiries.soon) ? '!' : '✔' }}</span>
                <div class="ui-row-t"><b>Caducidades</b>
                  <p v-if="d.expiries && (d.expiries.expired || d.expiries.soon)"><template v-if="d.expiries.expired">{{ d.expiries.expired }} documento{{ d.expiries.expired > 1 ? 's' : '' }} caducado{{ d.expiries.expired > 1 ? 's' : '' }}</template><template v-if="d.expiries.expired && d.expiries.soon"> · </template><template v-if="d.expiries.soon">{{ d.expiries.soon }} por caducar</template></p>
                  <p v-else>Documentación al día.</p></div>
                <RouterLink v-if="d.expiries && (d.expiries.expired || d.expiries.soon)" class="btn btn-sm" to="/oficina/caducidades">Ver</RouterLink>
              </li>
              <li v-if="d.external_pending_review">
                <span class="ui-dot ko">!</span>
                <div class="ui-row-t"><b>DeCA externos</b><p>{{ d.external_pending_review }} pendiente{{ d.external_pending_review > 1 ? 's' : '' }} de revisión (se revisan desde el transporte).</p></div>
              </li>
              <li>
                <span :class="['ui-dot', https ? 'ok' : 'ko']">{{ https ? '✔' : '!' }}</span>
                <div class="ui-row-t"><b>Dirección pública de los DeCA</b><p><span class="mono">{{ d.public_base_url ?? 'sin configurar' }}</span><template v-if="d.decas_other_base"> · {{ d.decas_other_base }} DeCA emitido{{ d.decas_other_base > 1 ? 's' : '' }} con otra dirección (siguen funcionando mientras apunte a este servidor).</template></p></div>
              </li>
            </ul>
          </section>

          <section class="ui-sec">
            <header class="ui-head"><div><h2>Dispositivos pendientes de autorización</h2><p>Un conductor con un teléfono nuevo trabaja en solo lectura hasta que la oficina lo autorice.</p></div><span v-if="devices.length" class="badge b-pend">{{ devices.length }}</span></header>
            <div v-if="!devices.length" class="empty"><b>Nada pendiente</b>No hay dispositivos por autorizar.</div>
            <ul v-else class="ui-flags">
              <li v-for="x in devices" :key="x.id">
                <div class="ui-row-t"><b>{{ x.username }}</b><p>{{ x.label ?? 'Sin nombre' }} · {{ fmtDateTime(x.registered_at) }}</p></div>
                <span v-if="canWrite" class="row">
                  <button class="btn btn-sm btn-primary" :disabled="busy === x.id" @click="decide(x.id, 'authorize')">Autorizar</button>
                  <button class="btn btn-sm btn-danger" :disabled="busy === x.id" @click="decide(x.id, 'revoke')">Revocar</button>
                </span>
              </li>
            </ul>
          </section>
        </div>
      </div>
    </template>
  </div>
</template>
