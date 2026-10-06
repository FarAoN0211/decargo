<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import Modal from '../../components/Modal.vue';
import { api, auth } from '../../api';
import { messageFor } from '../../errors';
import DocsPanel from '../../components/DocsPanel.vue';
import { useRoute } from 'vue-router';
import { KIND, KIND_HEAD, KIND_ORDER } from '../../format';
import { useFit } from '../../fit';

const rows = ref<any[]>([]), error = ref(''), ok = ref(''), busy = ref(false), loading = ref(true);
const canWrite = computed(() => auth.user?.role === 'admin' || auth.user?.role === 'oficina');
const creating = ref(false), editing = ref<any>(null);
const route = useRoute();
const docsOpen = ref<string>(String(route.query.abrir ?? ''));
const exp = ref<Record<string, { expired: number; soon: number }>>({});
async function loadExpiries(): Promise<void> {
  try { const m: Record<string, { expired: number; soon: number }> = {}; for (const e of await api<any[]>('/expiries')) { if (!e.vehicle_id) continue; const x = (m[e.vehicle_id] ??= { expired: 0, soon: 0 }); if (e.status === 'CADUCADO') x.expired++; else x.soon++; } exp.value = m; } catch { /* sin alertas */ }
}
const form = reactive({ plate: '', kind: 'TRACTORA' });
const edit = reactive({ plate: '', kind: 'TRACTORA', active: true });

/** Los vehículos separados por tipo, en este orden: tractoras, semirremolques, camión rígido y remolques. */
const q = ref(''), tipo = ref('');
const norm = (v: string): string => v.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const groups = computed(() => KIND_ORDER.map((k) => ({ kind: k as string, head: KIND_HEAD[k], items: rows.value.filter((v) => v.kind === k && (!q.value.trim() || norm(v.plate).includes(norm(q.value.trim())))) })).filter((g) => g.items.length && (!tipo.value || g.kind === tipo.value)));
const countKind = (k: string): number => rows.value.filter((v) => !k || v.kind === k).length;
async function load(): Promise<void> { try { rows.value = await api('/vehicles'); } catch (e) { error.value = messageFor(e); } finally { loading.value = false; } }
async function create(): Promise<void> {
  busy.value = true; error.value = ''; ok.value = '';
  try { await api('/vehicles', { method: 'POST', body: { plate: form.plate, kind: form.kind } }); creating.value = false; form.plate = ''; ok.value = 'Vehículo creado.'; await load(); }
  catch (e) { error.value = messageFor(e); } finally { busy.value = false; }
}
function startEdit(v: any): void { editing.value = v; edit.plate = v.plate; edit.kind = v.kind; edit.active = v.active; error.value = ''; }
async function save(): Promise<void> {
  busy.value = true; error.value = ''; ok.value = '';
  const body: Record<string, unknown> = { active: edit.active };
  if (!editing.value.in_use) { body.plate = edit.plate; body.kind = edit.kind; }
  try { await api(`/vehicles/${editing.value.id}`, { method: 'PATCH', body }); editing.value = null; ok.value = 'Vehículo actualizado.'; await load(); }
  catch (e) { error.value = messageFor(e); } finally { busy.value = false; }
}
useFit();
onMounted(() => { void load(); void loadExpiries(); });
</script>
<template>
  <div class="page-title">
    <div><h1>Vehículos</h1><p class="pg-sub">Tractoras, semirremolques, remolques y camiones rígidos. No se gestiona mantenimiento, combustible ni kilometraje.</p></div>
    <div class="pg-actions"><button v-if="canWrite" class="btn btn-accent" @click="creating = true">Nuevo vehículo</button></div>
  </div>
  <div class="toolbar">
    <label class="search"><input v-model="q" type="search" placeholder="Buscar por matrícula…" aria-label="Buscar vehículos" autocomplete="off" /></label>
    <div class="chips" role="group" aria-label="Filtrar por tipo">
      <button type="button" :class="['chip', { on: tipo === '' }]" @click="tipo = ''">Todos<span class="n">{{ countKind('') }}</span></button>
      <button v-for="k in KIND_ORDER.filter((x) => countKind(x))" :key="k" type="button" :class="['chip', { on: tipo === k }]" @click="tipo = k">{{ KIND_HEAD[k] }}<span class="n">{{ countKind(k) }}</span></button>
    </div>
  </div>
  <div class="fit">
    <p v-if="error && !editing && !creating" class="alert alert-err">{{ error }}</p>
    <p v-if="ok" class="alert alert-ok">{{ ok }}</p>
    <p v-if="loading" class="muted">Cargando…</p>
    <div v-else-if="!rows.length" class="ui-sec"><div class="empty"><b>Todavía no hay vehículos</b>{{ canWrite ? 'Crea el primero con «Nuevo vehículo».' : '' }}</div></div>
    <div v-else-if="!groups.length" class="ui-sec"><div class="empty"><b>Ningún vehículo coincide</b>Prueba con otra matrícula o cambia el filtro.</div></div>
    <template v-else>
      <section v-for="g in groups" :key="g.kind" class="ui-sec flush">
        <header class="ui-head"><div><h2>{{ g.head }}<span class="badge-n">{{ g.items.length }}</span></h2></div></header>
        <table class="t-veh">
          <thead><tr><th>Matrícula</th><th>Tipo</th><th>Estado</th><th>Uso</th><th></th></tr></thead>
          <tbody>
            <template v-for="v in g.items" :key="v.id"><tr>
              <td class="mono"><b>{{ v.plate }}</b><span v-if="exp[v.id]?.expired" class="badge b-bad exp-badge">{{ exp[v.id].expired }} caducado{{ exp[v.id].expired > 1 ? 's' : '' }}</span><span v-if="exp[v.id]?.soon" class="badge b-pend exp-badge">{{ exp[v.id].soon }} por caducar</span></td><td>{{ KIND[v.kind] }}</td>
              <td><span :class="['badge', v.active ? 'b-fin' : 'b-off']">{{ v.active ? 'Activo' : 'Inactivo' }}</span></td>
              <td class="muted">{{ v.in_use ? 'Usado en transportes' : 'Sin usar' }}</td>
              <td class="actions"><button class="btn btn-sm" @click="docsOpen = docsOpen === v.id ? '' : v.id">Documentos</button> <button v-if="canWrite" class="btn btn-sm" @click="startEdit(v)">Modificar</button></td>
            </tr>
            <tr v-if="docsOpen === v.id" class="sub-row"><td colspan="5"><DocsPanel subject="VEHICLE" :subject-id="v.id" :vehicle-kind="v.kind" :can-write="canWrite" @changed="loadExpiries" /></td></tr></template>
          </tbody>
        </table>
      </section>
    </template>
  </div>

  <Modal v-if="creating" title="Nuevo vehículo" @close="creating = false">
    <form @submit.prevent="create">
      <p v-if="error" class="alert alert-err">{{ error }}</p>
      <label>Matrícula<input v-model="form.plate" required maxlength="12" autocapitalize="characters" spellcheck="false" /></label>
      <label>Tipo<select v-model="form.kind"><option v-for="(n, k) in KIND" :key="k" :value="k">{{ n }}</option></select></label>
      <button class="btn btn-primary" :disabled="busy">Crear vehículo</button>
    </form>
  </Modal>
  <Modal v-if="editing" :title="`Modificar ${editing.plate}`" @close="editing = null">
    <form @submit.prevent="save">
      <p v-if="error" class="alert alert-err">{{ error }}</p>
      <p v-if="editing.in_use" class="alert alert-info">Este vehículo ya se ha usado en transportes: su matrícula y su tipo no se pueden cambiar. Solo su estado.</p>
      <label>Matrícula<input v-model="edit.plate" :disabled="editing.in_use" required maxlength="12" /></label>
      <label>Tipo<select v-model="edit.kind" :disabled="editing.in_use"><option v-for="(n, k) in KIND" :key="k" :value="k">{{ n }}</option></select></label>
      <label class="row"><input v-model="edit.active" type="checkbox" class="check" /> Activo (disponible para nuevos transportes)</label>
      <button class="btn btn-primary" :disabled="busy">Guardar</button>
    </form>
  </Modal>
</template>
