<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import Modal from '../../components/Modal.vue';
import { api, auth } from '../../api';
import { messageFor } from '../../errors';
import DocsPanel from '../../components/DocsPanel.vue';
import { useRoute } from 'vue-router';
import { KIND, KIND_HEAD, KIND_ORDER } from '../../format';

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
const groups = computed(() => KIND_ORDER.map((k) => ({ kind: k as string, head: KIND_HEAD[k], items: rows.value.filter((v) => v.kind === k) })).filter((g) => g.items.length));
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
onMounted(() => { void load(); void loadExpiries(); });
</script>
<template>
  <div class="page-title"><h1>Vehículos</h1><button v-if="canWrite" class="btn btn-accent" @click="creating = true">Nuevo vehículo</button></div>
  <p v-if="error && !editing && !creating" class="alert alert-err">{{ error }}</p>
  <p v-if="ok" class="alert alert-ok">{{ ok }}</p>
  <p v-if="loading" class="muted">Cargando…</p>
  <p v-else-if="!rows.length" class="muted">Todavía no hay vehículos.</p>
  <template v-else><section v-for="g in groups" :key="g.kind" class="vgroup">
    <h2 class="pad-top">{{ g.head }} <span class="muted small">({{ g.items.length }})</span></h2>
    <div class="table-wrap">
    <table>
      <thead><tr><th>Matrícula</th><th>Tipo</th><th>Estado</th><th>Uso</th><th></th></tr></thead>
      <tbody>
        <template v-for="v in g.items" :key="v.id"><tr>
          <td class="mono"><b>{{ v.plate }}</b><span v-if="exp[v.id]?.expired" class="badge b-bad exp-badge">{{ exp[v.id].expired }} caducado{{ exp[v.id].expired > 1 ? 's' : '' }}</span><span v-if="exp[v.id]?.soon" class="badge b-pend exp-badge">{{ exp[v.id].soon }} por caducar</span></td><td>{{ KIND[v.kind] }}</td>
          <td><span :class="['badge', v.active ? 'b-fin' : 'b-off']">{{ v.active ? 'Activo' : 'Inactivo' }}</span></td>
          <td class="muted">{{ v.in_use ? 'Usado en transportes' : 'Sin usar' }}</td>
          <td class="right nowrap"><button class="btn btn-sm" @click="docsOpen = docsOpen === v.id ? '' : v.id">Documentos</button> <button v-if="canWrite" class="btn btn-sm" @click="startEdit(v)">Modificar</button></td>
        </tr>
        <tr v-if="docsOpen === v.id"><td colspan="5"><DocsPanel subject="VEHICLE" :subject-id="v.id" :vehicle-kind="v.kind" :can-write="canWrite" @changed="loadExpiries" /></td></tr></template>
      </tbody>
    </table>
  </div>
  </section></template>
  <p class="muted small pad-top">Distingue tractoras, semirremolques, remolques y camiones rígidos. No se gestiona mantenimiento, combustible ni kilometraje.</p>

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
