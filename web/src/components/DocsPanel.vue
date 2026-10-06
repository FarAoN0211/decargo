<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import Modal from './Modal.vue';
import { api } from '../api';
import { messageFor } from '../errors';
import { fmtDate } from '../format';

/** Documentos con caducidad (conductor, vehículo o empresa) y, en vehículos, tarjetas de combustible y VIA-T. Control interno: la oficina anota la fecha impresa. */
const props = defineProps<{ subject: 'DRIVER' | 'VEHICLE' | 'COMPANY'; subjectId?: string; vehicleKind?: string; canWrite: boolean }>();
const emit = defineEmits<{ (e: 'changed'): void }>();

interface TypeDef { code: string; label: string; hint: string; kinds?: string[]; detailLabel?: string }
interface Cat { warn_days: number; driver: TypeDef[]; vehicle: TypeDef[]; company: TypeDef[]; assets: { code: string; label: string; hasPin: boolean; identifierLabel: string; providerLabel: string }[] }
const cat = ref<Cat | null>(null), docs = ref<any[]>([]), assets = ref<any[]>([]), error = ref(''), ok = ref(''), busy = ref(false), showArchived = ref(false);

const types = computed<TypeDef[]>(() => {
  if (!cat.value) return [];
  const all = props.subject === 'DRIVER' ? cat.value.driver : props.subject === 'VEHICLE' ? cat.value.vehicle : cat.value.company;
  return all.filter((t) => !t.kinds || !props.vehicleKind || t.kinds.includes(props.vehicleKind));
});
const typeLabel = (d: any): string => (d.doc_type === 'OTRO' ? d.label : [...(cat.value?.driver ?? []), ...(cat.value?.vehicle ?? []), ...(cat.value?.company ?? [])].find((t) => t.code === d.doc_type)?.label ?? d.doc_type);

function status(days: number | null | undefined): { t: string; c: string } {
  if (days === null || days === undefined) return { t: 'Sin caducidad', c: 'b-off' };
  if (days < 0) return { t: `Caducado hace ${-days} d`, c: 'b-bad' };
  if (days === 0) return { t: 'Caduca hoy', c: 'b-bad' };
  if (days <= (cat.value?.warn_days ?? 30)) return { t: `Caduca en ${days} d`, c: 'b-pend' };
  return { t: 'Vigente', c: 'b-fin' };
}

const query = (): string => (props.subject === 'DRIVER' ? `user_id=${props.subjectId}` : props.subject === 'VEHICLE' ? `vehicle_id=${props.subjectId}` : 'company=1');
async function load(): Promise<void> {
  try {
    if (!cat.value) cat.value = await api<Cat>('/documents/catalog');
    docs.value = await api<any[]>(`/documents?${query()}${showArchived.value ? '&all=1' : ''}`);
    if (props.subject === 'VEHICLE') assets.value = await api<any[]>(`/vehicles/${props.subjectId}/assets${showArchived.value ? '?all=1' : ''}`);
  } catch (e) { error.value = messageFor(e); }
}
onMounted(load);
watch(() => [props.subjectId, showArchived.value], load);

// ---- documentos
const dform = reactive({ id: '', doc_type: '', label: '', number: '', detail: '', issued_on: '', expires_on: '', notes: '' });
const dopen = ref(false);
const dtype = computed(() => types.value.find((t) => t.code === dform.doc_type));
function newDoc(): void { Object.assign(dform, { id: '', doc_type: types.value[0]?.code ?? '', label: '', number: '', detail: '', issued_on: '', expires_on: '', notes: '' }); error.value = ''; dopen.value = true; }
function editDoc(d: any): void { Object.assign(dform, { id: d.id, doc_type: d.doc_type, label: d.label ?? '', number: d.number ?? '', detail: d.detail ?? '', issued_on: d.issued_on ?? '', expires_on: d.expires_on ?? '', notes: d.notes ?? '' }); error.value = ''; dopen.value = true; }
async function saveDoc(): Promise<void> {
  busy.value = true; error.value = ''; ok.value = '';
  const body: Record<string, unknown> = { label: dform.label, number: dform.number, detail: dform.detail, issued_on: dform.issued_on || null, expires_on: dform.expires_on || null, notes: dform.notes };
  try {
    if (dform.id) await api(`/documents/${dform.id}`, { method: 'PATCH', body });
    else await api('/documents', { method: 'POST', body: { ...body, subject_kind: props.subject, doc_type: dform.doc_type, ...(props.subject === 'DRIVER' ? { user_id: props.subjectId } : props.subject === 'VEHICLE' ? { vehicle_id: props.subjectId } : {}) } });
    dopen.value = false; ok.value = 'Documento guardado.'; await load(); emit('changed');
  } catch (e) { error.value = messageFor(e); } finally { busy.value = false; }
}
async function archiveDoc(d: any, active: boolean): Promise<void> {
  error.value = ''; ok.value = '';
  try { await api(`/documents/${d.id}`, { method: 'PATCH', body: { active } }); await load(); emit('changed'); } catch (e) { error.value = messageFor(e); }
}

// ---- tarjetas y dispositivos
const aform = reactive({ id: '', kind: 'FUEL_CARD', provider: '', identifier: '', pin: '', clearPin: false, hadPin: false, expires_on: '', notes: '' });
const aopen = ref(false);
const akind = computed(() => cat.value?.assets.find((k) => k.code === aform.kind));
function newAsset(): void { Object.assign(aform, { id: '', kind: 'FUEL_CARD', provider: '', identifier: '', pin: '', clearPin: false, hadPin: false, expires_on: '', notes: '' }); error.value = ''; aopen.value = true; }
function editAsset(a: any): void { Object.assign(aform, { id: a.id, kind: a.kind, provider: a.provider ?? '', identifier: a.identifier, pin: '', clearPin: false, hadPin: a.has_pin, expires_on: a.expires_on ?? '', notes: a.notes ?? '' }); error.value = ''; aopen.value = true; }
async function saveAsset(): Promise<void> {
  busy.value = true; error.value = ''; ok.value = '';
  const body: Record<string, unknown> = { provider: aform.provider, identifier: aform.identifier, expires_on: aform.expires_on || null, notes: aform.notes };
  if (aform.pin) body.pin = aform.pin; else if (aform.clearPin) body.pin = null;
  try {
    if (aform.id) await api(`/assets/${aform.id}`, { method: 'PATCH', body });
    else await api(`/vehicles/${props.subjectId}/assets`, { method: 'POST', body: { ...body, kind: aform.kind } });
    aopen.value = false; ok.value = 'Guardado.'; await load(); emit('changed');
  } catch (e) { error.value = messageFor(e); } finally { busy.value = false; }
}
async function archiveAsset(a: any, active: boolean): Promise<void> {
  error.value = ''; ok.value = '';
  try { await api(`/assets/${a.id}`, { method: 'PATCH', body: { active } }); await load(); emit('changed'); } catch (e) { error.value = messageFor(e); }
}
// PIN: solo se pide cuando se necesita, se muestra unos segundos y queda auditado
const shown = reactive<Record<string, string>>({});
const timers: Record<string, ReturnType<typeof setTimeout>> = {};
async function reveal(a: any): Promise<void> {
  error.value = '';
  try { const r = await api<{ pin: string }>(`/assets/${a.id}/reveal-pin`, { method: 'POST' }); shown[a.id] = r.pin; clearTimeout(timers[a.id]); timers[a.id] = setTimeout(() => { delete shown[a.id]; }, 15000); } catch (e) { error.value = messageFor(e); }
}
onBeforeUnmount(() => { Object.values(timers).forEach(clearTimeout); });
const kindLabel = (c: string): string => cat.value?.assets.find((k) => k.code === c)?.label ?? c;
</script>
<template>
  <div class="stack docs-panel">
    <p v-if="error && !dopen && !aopen" class="alert alert-err">{{ error }}</p>
    <p v-if="ok" class="alert alert-ok">{{ ok }}</p>
    <div class="row spread">
      <h3 class="sub">{{ subject === 'COMPANY' ? 'Documentos de la empresa' : 'Documentos' }}</h3>
      <span class="row"><label class="check small"><input v-model="showArchived" type="checkbox" /> Ver archivados</label>
        <button v-if="canWrite" class="btn btn-sm btn-accent" type="button" @click="newDoc">Añadir documento</button></span>
    </div>
    <p v-if="!docs.length" class="muted small">Todavía no hay documentos anotados.</p>
    <div v-else class="table-wrap"><table>
      <thead><tr><th>Documento</th><th>Número / detalle</th><th>Caduca</th><th>Estado</th><th></th></tr></thead>
      <tbody><tr v-for="d in docs" :key="d.id" :class="{ archived: !d.active }">
        <td><b>{{ typeLabel(d) }}</b><div v-if="d.notes" class="muted small">{{ d.notes }}</div></td>
        <td class="small">{{ [d.number, d.detail].filter(Boolean).join(' · ') || '—' }}</td>
        <td>{{ d.expires_on ? fmtDate(d.expires_on) : '—' }}</td>
        <td><span v-if="d.active" :class="['badge', status(d.days_left).c]">{{ status(d.days_left).t }}</span><span v-else class="badge b-off">Archivado</span></td>
        <td class="right nowrap" v-if="canWrite"><button class="btn btn-sm" @click="editDoc(d)">Modificar</button>
          <button class="btn btn-sm" @click="archiveDoc(d, !d.active)">{{ d.active ? 'Archivar' : 'Recuperar' }}</button></td>
      </tr></tbody></table></div>

    <template v-if="subject === 'VEHICLE'">
      <div class="row spread"><h3 class="sub">Tarjetas y dispositivos</h3>
        <button v-if="canWrite" class="btn btn-sm btn-accent" type="button" @click="newAsset">Añadir tarjeta o dispositivo</button></div>
      <p v-if="!assets.length" class="muted small">Sin tarjetas de combustible ni VIA-T anotados.</p>
      <div v-else class="table-wrap"><table>
        <thead><tr><th>Tipo</th><th>Emisor</th><th>Número</th><th>PIN</th><th>Caduca</th><th>Estado</th><th></th></tr></thead>
        <tbody><tr v-for="a in assets" :key="a.id" :class="{ archived: !a.active }">
          <td><b>{{ kindLabel(a.kind) }}</b><div v-if="a.notes" class="muted small">{{ a.notes }}</div></td><td>{{ a.provider || '—' }}</td><td class="mono">{{ a.identifier }}</td>
          <td><template v-if="a.has_pin"><b v-if="shown[a.id]" class="mono">{{ shown[a.id] }}</b><span v-else class="mono">••••</span>
            <button v-if="canWrite && !shown[a.id]" class="btn btn-sm" type="button" @click="reveal(a)">Ver PIN</button></template><span v-else class="muted">—</span></td>
          <td>{{ a.expires_on ? fmtDate(a.expires_on) : '—' }}</td>
          <td><span v-if="a.active" :class="['badge', status(a.days_left).c]">{{ status(a.days_left).t }}</span><span v-else class="badge b-off">Archivado</span></td>
          <td class="right nowrap" v-if="canWrite"><button class="btn btn-sm" @click="editAsset(a)">Modificar</button>
            <button class="btn btn-sm" @click="archiveAsset(a, !a.active)">{{ a.active ? 'Archivar' : 'Recuperar' }}</button></td>
        </tr></tbody></table></div>
      <p class="muted small">El PIN se guarda cifrado y solo se muestra cuando lo pide la oficina; cada consulta queda en la auditoría.</p>
    </template>
  </div>

  <Modal v-if="dopen" :title="dform.id ? 'Modificar documento' : 'Añadir documento'" @close="dopen = false">
    <form class="stack" @submit.prevent="saveDoc">
      <p v-if="error" class="alert alert-err">{{ error }}</p>
      <label>Documento<select v-model="dform.doc_type" :disabled="!!dform.id"><option v-for="t in types" :key="t.code" :value="t.code">{{ t.label }}</option></select></label>
      <p v-if="dtype" class="muted small">{{ dtype.hint }}</p>
      <label v-if="dform.doc_type === 'OTRO'">Nombre del documento<input v-model="dform.label" required maxlength="80" /></label>
      <div class="grid2"><label>Número (opcional)<input v-model="dform.number" maxlength="60" autocomplete="off" /></label>
        <label>{{ dtype?.detailLabel ?? 'Detalle (opcional)' }}<input v-model="dform.detail" maxlength="80" /></label></div>
      <div class="grid2"><label>Fecha de expedición (opcional)<input v-model="dform.issued_on" type="date" /></label>
        <label>Fecha de caducidad<input v-model="dform.expires_on" type="date" /><span class="hint small"> Déjala vacía si no caduca.</span></label></div>
      <label>Notas (opcional)<input v-model="dform.notes" maxlength="500" /></label>
      <button class="btn btn-primary" :disabled="busy">Guardar</button>
    </form>
  </Modal>
  <Modal v-if="aopen" :title="aform.id ? 'Modificar tarjeta o dispositivo' : 'Añadir tarjeta o dispositivo'" @close="aopen = false">
    <form class="stack" @submit.prevent="saveAsset">
      <p v-if="error" class="alert alert-err">{{ error }}</p>
      <label>Tipo<select v-model="aform.kind" :disabled="!!aform.id"><option v-for="k in cat?.assets" :key="k.code" :value="k.code">{{ k.label }}</option></select></label>
      <div class="grid2"><label>{{ akind?.providerLabel }}<input v-model="aform.provider" maxlength="60" /></label>
        <label>{{ akind?.identifierLabel }}<input v-model="aform.identifier" required maxlength="60" autocomplete="off" /></label></div>
      <label v-if="akind?.hasPin">PIN<span class="hint small"> {{ aform.hadPin ? '(deja en blanco para no cambiarlo)' : '(opcional)' }}</span>
        <input v-model="aform.pin" type="password" maxlength="12" autocomplete="new-password" inputmode="text" /></label>
      <label v-if="akind?.hasPin && aform.hadPin" class="check small"><input v-model="aform.clearPin" type="checkbox" /> Borrar el PIN guardado</label>
      <label>Fecha de caducidad<input v-model="aform.expires_on" type="date" /><span class="hint small"> Déjala vacía si no caduca.</span></label>
      <label>Notas (opcional)<input v-model="aform.notes" maxlength="500" /></label>
      <button class="btn btn-primary" :disabled="busy">Guardar</button>
    </form>
  </Modal>
</template>
