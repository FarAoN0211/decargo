<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import DocsPanel from '../../components/DocsPanel.vue';
import { api, auth } from '../../api';
import { messageFor } from '../../errors';
import { fmtDate } from '../../format';
import { useFit } from '../../fit';

const rows = ref<any[]>([]), error = ref(''), loading = ref(true), days = ref(30);
const canWrite = computed(() => auth.user?.role === 'admin' || auth.user?.role === 'oficina');
async function load(): Promise<void> {
  try { const [r, c] = await Promise.all([api<any[]>('/expiries'), api<any>('/documents/catalog')]); rows.value = r; days.value = c.warn_days; } catch (e) { error.value = messageFor(e); } finally { loading.value = false; }
}
const expired = computed(() => rows.value.filter((r) => r.status === 'CADUCADO'));
const soon = computed(() => rows.value.filter((r) => r.status === 'PROXIMO'));
const link = (r: any): { path: string; query: Record<string, string> } | null =>
  r.user_id ? { path: '/oficina/conductores', query: { abrir: r.user_id } } : r.vehicle_id ? { path: '/oficina/vehiculos', query: { abrir: r.vehicle_id } } : null;
const when = (d: number): string => (d < 0 ? `hace ${-d} d` : d === 0 ? 'hoy' : `en ${d} d`);
useFit();
onMounted(load);
</script>
<template>
  <div class="page-title">
    <div><h1>Caducidades</h1><p class="pg-sub">Control interno de documentos de conductores, vehículos y empresa. Se avisa {{ days }} días antes; ese plazo se cambia en Configuración.</p></div>
  </div>
  <div class="fit">
    <p v-if="error" class="alert alert-err">{{ error }}</p>
    <p v-if="loading" class="muted">Cargando…</p>
    <template v-else>
      <div class="counts counts2">
        <div :class="['count', expired.length ? 'c-bad' : 'c-ok']"><b>{{ expired.length }}</b><span>Documentos caducados</span></div>
        <div :class="['count', soon.length ? 'c-pend' : 'c-ok']"><b>{{ soon.length }}</b><span>Próximos a caducar (en {{ days }} días)</span></div>
      </div>
      <p v-if="!rows.length" class="alert alert-ok">No hay documentos caducados ni próximos a caducar.</p>
      <template v-for="g in [{ t: 'Caducados', list: expired, c: 'b-bad' }, { t: 'Próximos a caducar', list: soon, c: 'b-pend' }]" :key="g.t">
        <section v-if="g.list.length" class="ui-sec flush">
          <header class="ui-head"><div><h2>{{ g.t }}<span class="badge-n">{{ g.list.length }}</span></h2></div></header>
          <table>
            <thead><tr><th>De quién</th><th>Documento</th><th>Caduca</th><th></th></tr></thead>
            <tbody><tr v-for="r in g.list" :key="r.source + r.id">
              <td><b>{{ r.subject }}</b> <span class="muted small">{{ r.subject_kind === 'DRIVER' ? 'conductor' : r.subject_kind === 'VEHICLE' ? 'vehículo' : '' }}</span></td>
              <td>{{ r.what }}</td><td><span :class="['badge', g.c]">{{ fmtDate(r.expires_on) }} · {{ when(r.days_left) }}</span></td>
              <td class="actions"><RouterLink v-if="link(r)" class="btn btn-sm" :to="link(r)!">Abrir</RouterLink></td>
            </tr></tbody>
          </table>
        </section>
      </template>
      <section class="ui-sec">
        <header class="ui-head"><div><h2>Documentos de la empresa</h2><p>Seguros, autorizaciones y otros documentos propios de la empresa.</p></div></header>
        <div class="ui-body"><DocsPanel subject="COMPANY" :can-write="canWrite" hide-title @changed="load" /></div>
      </section>
    </template>
  </div>
</template>
