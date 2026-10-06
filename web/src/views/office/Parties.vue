<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import Modal from '../../components/Modal.vue';
import { api, auth } from '../../api';
import { messageFor } from '../../errors';
import { fullAddress } from '../../format';

/** Agenda de empresas: razón social, NIF, domicilio y varios lugares por empresa, cada uno con su ubicación para compartir con los conductores. */
const canWrite = computed(() => auth.user?.role === 'admin' || auth.user?.role === 'oficina');
const q = ref(''), rows = ref<any[]>([]), error = ref(''), ok = ref(''), loading = ref(true), busy = ref(false), showInactive = ref(false);
const open = ref<any>(null);
let timer: ReturnType<typeof setTimeout> | undefined;

async function load(): Promise<void> {
  try { rows.value = await api<any[]>(`/parties?q=${encodeURIComponent(q.value)}${showInactive.value ? '&all=1' : ''}`); } catch (e) { error.value = messageFor(e); } finally { loading.value = false; }
}
const search = (): void => { clearTimeout(timer); timer = setTimeout(load, 250); };
async function expand(p: any): Promise<void> {
  if (open.value?.id === p.id) { open.value = null; return; }
  try { open.value = await api(`/parties/${p.id}?all=1`); } catch (e) { error.value = messageFor(e); }
}
async function reopen(): Promise<void> { if (open.value) open.value = await api(`/parties/${open.value.id}?all=1`); await load(); }

// ---- empresa
const pform = reactive({ id: '', name: '', nif: '', transport_authorization: '', address: '', postal_code: '', city: '', province: '', country: '', notes: '' }), pOpen = ref(false), nifHint = ref('');
function newParty(): void { Object.assign(pform, { id: '', name: '', nif: '', transport_authorization: '', address: '', postal_code: '', city: '', province: '', country: '', notes: '' }); nifHint.value = ''; error.value = ''; pOpen.value = true; }
function editParty(p: any): void { Object.assign(pform, { id: p.id, name: p.name, nif: p.nif ?? '', transport_authorization: p.transport_authorization ?? '', address: p.address ?? '', postal_code: p.postal_code ?? '', city: p.city ?? '', province: p.province ?? '', country: p.country ?? '', notes: p.notes ?? '' }); nifHint.value = ''; error.value = ''; pOpen.value = true; }
async function checkNif(): Promise<void> {
  nifHint.value = '';
  if (pform.nif.trim().length < 8) return;
  try { const r = await api<{ valid: boolean | null }>('/taxid/check', { method: 'POST', body: { nif: pform.nif } }); nifHint.value = r.valid === false ? 'No parece un NIF válido: revisa la letra o el dígito de control.' : r.valid === true ? '✔ NIF correcto' : 'Formato no español: no se puede comprobar.'; } catch { /* */ }
}
async function saveParty(): Promise<void> {
  busy.value = true; error.value = ''; ok.value = '';
  const body = { name: pform.name, nif: pform.nif || null, transport_authorization: pform.transport_authorization.trim() || null, address: pform.address || null, postal_code: pform.postal_code || null, city: pform.city || null, province: pform.province || null, country: pform.country || null, notes: pform.notes || null };
  try {
    if (pform.id) await api(`/parties/${pform.id}`, { method: 'PATCH', body }); else await api('/parties', { method: 'POST', body });
    pOpen.value = false; ok.value = 'Empresa guardada.'; await reopen(); await load();
  } catch (e) { error.value = (e as { code?: string }).code === 'party_exists' ? 'Ya hay una empresa con ese NIF en la agenda.' : messageFor(e); } finally { busy.value = false; }
}
async function setActive(p: any, active: boolean): Promise<void> { try { await api(`/parties/${p.id}`, { method: 'PATCH', body: { active } }); await reopen(); } catch (e) { error.value = messageFor(e); } }

// ---- lugares
const sform = reactive({ id: '', label: '', kind: 'AMBOS', address: '', postal_code: '', city: '', province: '', country: '', lat: '', lon: '', map_url: '', notes: '' }), sOpen = ref(false);
const KIND: Record<string, string> = { CARGA: 'Carga', DESCARGA: 'Descarga', AMBOS: 'Carga y descarga', SEDE: 'Sede' };
function newSite(p: any): void { Object.assign(sform, { id: '', label: '', kind: 'AMBOS', address: p.address ?? '', postal_code: p.postal_code ?? '', city: p.city ?? '', province: p.province ?? '', country: p.country ?? '', lat: '', lon: '', map_url: '', notes: '' }); error.value = ''; sOpen.value = true; }
function editSite(s: any): void { Object.assign(sform, { id: s.id, label: s.label ?? '', kind: s.kind, address: s.address, postal_code: s.postal_code ?? '', city: s.city ?? '', province: s.province ?? '', country: s.country ?? '', lat: s.lat ?? '', lon: s.lon ?? '', map_url: s.map_url ?? '', notes: s.notes ?? '' }); error.value = ''; sOpen.value = true; }
async function saveSite(): Promise<void> {
  busy.value = true; error.value = ''; ok.value = '';
  const body = { label: sform.label || null, kind: sform.kind, address: sform.address, postal_code: sform.postal_code || null, city: sform.city || null, province: sform.province || null, country: sform.country || null, lat: sform.lat === '' ? null : sform.lat, lon: sform.lon === '' ? null : sform.lon, map_url: sform.map_url || null, notes: sform.notes || null };
  try {
    if (sform.id) await api(`/sites/${sform.id}`, { method: 'PATCH', body }); else await api(`/parties/${open.value.id}/sites`, { method: 'POST', body });
    sOpen.value = false; ok.value = 'Lugar guardado.'; await reopen();
  } catch (e) { error.value = messageFor(e); } finally { busy.value = false; }
}
async function archiveSite(s: any, active: boolean): Promise<void> { try { await api(`/sites/${s.id}`, { method: 'PATCH', body: { active } }); await reopen(); } catch (e) { error.value = messageFor(e); } }
/** Pega un enlace de Google Maps (largo): si trae coordenadas se rellenan solas al guardar; el servidor lo comprueba. */
function here(): void {
  if (!navigator.geolocation) { error.value = 'Este navegador no puede dar la ubicación.'; return; }
  navigator.geolocation.getCurrentPosition((pos) => { sform.lat = pos.coords.latitude.toFixed(6); sform.lon = pos.coords.longitude.toFixed(6); }, () => { error.value = 'No se pudo obtener la ubicación (revisa el permiso del navegador).'; }, { enableHighAccuracy: true, timeout: 15000 });
}
const copied = ref('');
async function share(s: any): Promise<void> {
  const text = `${open.value?.name ?? ''}${s.label ? ' · ' + s.label : ''}\n${fullAddress(s)}${s.maps_url ? '\n' + s.maps_url : ''}${s.notes ? '\n' + s.notes : ''}`;
  try {
    if (navigator.share) await navigator.share({ text });
    else { await navigator.clipboard.writeText(text); copied.value = s.id; setTimeout(() => { copied.value = ''; }, 1600); }
  } catch { /* cancelado */ }
}
onMounted(load);
</script>
<template>
  <div class="page-title"><h1>Empresas</h1><button v-if="canWrite" class="btn btn-accent" @click="newParty">Nueva empresa</button></div>
  <p class="muted">Tu agenda de cargadores, destinatarios y transportistas. Las empresas que escribas al crear un transporte se guardan aquí solas. Cada empresa puede tener varios lugares de carga o descarga con su ubicación, que verá el conductor.</p>
  <p v-if="error && !pOpen && !sOpen" class="alert alert-err">{{ error }}</p>
  <p v-if="ok" class="alert alert-ok">{{ ok }}</p>
  <div class="row"><input v-model="q" type="search" placeholder="Buscar por nombre o NIF…" @input="search" autocomplete="off" /><label class="check small"><input v-model="showInactive" type="checkbox" @change="load" /> Ver archivadas</label></div>
  <p v-if="loading" class="muted">Cargando…</p>
  <p v-else-if="!rows.length" class="muted">{{ q ? 'No hay empresas con ese nombre.' : 'Todavía no hay empresas. Se irán guardando al crear transportes.' }}</p>
  <div v-else class="table-wrap"><table>
    <thead><tr><th>Empresa</th><th>NIF</th><th>Domicilio</th><th>Lugares</th><th></th></tr></thead>
    <tbody><template v-for="p in rows" :key="p.id">
      <tr :class="{ archived: !p.active }">
        <td><b>{{ p.name }}</b></td>
        <td class="mono">{{ p.nif ?? '—' }}<span v-if="p.nif_check?.valid === false" class="badge b-pend exp-badge" title="La letra o el dígito de control no cuadran">revisar</span></td>
        <td class="small">{{ fullAddress(p) || '—' }}</td><td>{{ p.sites || '—' }}</td>
        <td class="right nowrap"><button class="btn btn-sm" @click="expand(p)">{{ open?.id === p.id ? 'Cerrar' : 'Lugares' }}</button><button v-if="canWrite" class="btn btn-sm" @click="editParty(p)">Modificar</button></td>
      </tr>
      <tr v-if="open?.id === p.id"><td colspan="5">
        <div class="stack">
          <p v-if="open.notes" class="muted small">{{ open.notes }}</p>
          <div class="row spread"><h3 class="sub">Lugares de carga y descarga</h3><span class="row"><button v-if="canWrite" class="btn btn-sm" @click="setActive(open, !open.active)">{{ open.active ? 'Archivar empresa' : 'Recuperar empresa' }}</button><button v-if="canWrite" class="btn btn-sm btn-accent" @click="newSite(open)">Añadir lugar</button></span></div>
          <p v-if="!open.sites.length" class="muted small">Sin lugares guardados todavía.</p>
          <div v-for="s in open.sites" :key="s.id" :class="['site', { archived: !s.active }]">
            <div class="row spread"><b>{{ s.label || fullAddress(s) }}</b><span class="badge b-off">{{ KIND[s.kind] }}</span></div>
            <div v-if="s.label" class="small">{{ fullAddress(s) }}</div>
            <div v-if="s.notes" class="muted small">{{ s.notes }}</div>
            <div class="row">
              <a v-if="s.maps_url" class="btn btn-sm way" :href="s.maps_url" target="_blank" rel="noopener noreferrer">Ver en el mapa</a><span v-else class="muted small">Sin ubicación</span>
              <button class="btn btn-sm" @click="share(s)">{{ copied === s.id ? 'Copiado' : 'Compartir' }}</button>
              <template v-if="canWrite"><button class="btn btn-sm" @click="editSite(s)">Modificar</button><button class="btn btn-sm" @click="archiveSite(s, !s.active)">{{ s.active ? 'Archivar' : 'Recuperar' }}</button></template>
            </div>
          </div>
        </div>
      </td></tr></template></tbody></table></div>

  <Modal v-if="pOpen" :title="pform.id ? 'Modificar empresa' : 'Nueva empresa'" @close="pOpen = false">
    <form class="stack" @submit.prevent="saveParty">
      <p v-if="error" class="alert alert-err">{{ error }}</p>
      <label>Nombre o razón social<input v-model="pform.name" required maxlength="120" /></label>
      <label>NIF / CIF<input v-model="pform.nif" maxlength="16" autocomplete="off" @input="checkNif" /><span v-if="nifHint" class="hint small"> {{ nifHint }}</span></label>
      <label>Domicilio (calle y número)<input v-model="pform.address" maxlength="200" /></label>
      <label>Nº de autorización de transporte<span class="hint small"> (solo si es una empresa transportista; opcional)</span><input v-model="pform.transport_authorization" maxlength="30" /></label>
      <div class="grid4"><label>Código postal<input v-model="pform.postal_code" maxlength="10" inputmode="numeric" /></label><label>Localidad<input v-model="pform.city" maxlength="80" /></label><label>Provincia<input v-model="pform.province" maxlength="80" /></label><label>País<input v-model="pform.country" maxlength="60" placeholder="España" /></label></div>
      <label>Notas (opcional)<input v-model="pform.notes" maxlength="500" /></label>
      <button class="btn btn-primary" :disabled="busy">Guardar</button>
    </form>
  </Modal>
  <Modal v-if="sOpen" :title="sform.id ? 'Modificar lugar' : 'Añadir lugar'" @close="sOpen = false">
    <form class="stack" @submit.prevent="saveSite">
      <p v-if="error" class="alert alert-err">{{ error }}</p>
      <div class="grid2"><label>Nombre del lugar (opcional)<input v-model="sform.label" maxlength="80" placeholder="Almacén central, Muelle 4…" /></label>
        <label>Se usa para<select v-model="sform.kind"><option value="AMBOS">Carga y descarga</option><option value="CARGA">Solo carga</option><option value="DESCARGA">Solo descarga</option><option value="SEDE">Sede</option></select></label></div>
      <label>Dirección (calle y número)<input v-model="sform.address" required maxlength="200" /></label>
      <div class="grid4"><label>Código postal<input v-model="sform.postal_code" maxlength="10" inputmode="numeric" /></label><label>Localidad<span class="hint small"> (sale en el DeCA)</span><input v-model="sform.city" maxlength="80" /></label><label>Provincia<input v-model="sform.province" maxlength="80" /></label><label>País<input v-model="sform.country" maxlength="60" placeholder="España" /></label></div>
      <fieldset class="ficha"><legend>Ubicación para el conductor</legend>
        <label>Enlace del mapa<span class="hint small"> (Google Maps, Apple Maps, Waze u OpenStreetMap; mejor el enlace largo, que trae las coordenadas)</span><input v-model="sform.map_url" maxlength="600" placeholder="https://www.google.com/maps/@37.1,-3.6,17z" /></label>
        <div class="grid2"><label>Latitud<input v-model="sform.lat" inputmode="decimal" placeholder="37.177336" /></label><label>Longitud<input v-model="sform.lon" inputmode="decimal" placeholder="-3.598557" /></label></div>
        <button class="btn btn-sm" type="button" @click="here">Usar mi ubicación actual</button>
        <p class="muted small">Con coordenadas, el conductor ve «Cómo llegar» y su teléfono abre la ruta. Si solo hay un enlace, se abre ese enlace.</p>
      </fieldset>
      <label>Indicaciones para el conductor (opcional)<span class="hint small"> horario, muelle, persona de contacto, acceso…</span><input v-model="sform.notes" maxlength="500" /></label>
      <button class="btn btn-primary" :disabled="busy">Guardar</button>
    </form>
  </Modal>
</template>
