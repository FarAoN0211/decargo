<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import FileViewer from '../../components/FileViewer.vue';
import Modal from '../../components/Modal.vue';
import StatusBadge from '../../components/StatusBadge.vue';
import { useRoute } from 'vue-router';
import { api, auth } from '../../api';
import { messageFor } from '../../errors';
import { KIND, fmtDate, fmtDateTime, fullAddress, kg } from '../../format';
import { useFit } from '../../fit';

const props = defineProps<{ id: string }>();
const route = useRoute();
const agendaNew = String(route.query.agenda ?? '').split(',').map(Number);
const copiedStop = ref('');
async function shareStop(s: any, kind: string): Promise<void> {
  const text = `${kind}: ${[s.party, s.address].filter(Boolean).join(' · ')}${s.maps_url ? '\n' + s.maps_url : ''}${s.site_notes ? '\n' + s.site_notes : ''}`;
  try { if (navigator.share) await navigator.share({ text }); else { await navigator.clipboard.writeText(text); copiedStop.value = kind + s.address; setTimeout(() => { copiedStop.value = ''; }, 1600); } } catch { /* cancelado */ }
}
const t = ref<any>(null), drivers = ref<any[]>([]), vehicles = ref<any[]>([]);
const error = ref(''), ok = ref(''), busy = ref('');
const sel = ref({ driver: '', tractor: '', trailer: '' });
const view = ref<null | { title: string; path: string; kind: 'pdf' | 'qr'; filename?: string }>(null);
const canWrite = computed(() => auth.user?.role === 'admin' || auth.user?.role === 'oficina');
const mains = computed(() => vehicles.value.filter((v) => v.kind === 'TRACTORA' || v.kind === 'RIGIDO'));
const trailers = computed(() => {
  const main = vehicles.value.find((v) => v.id === sel.value.tractor);
  return main ? vehicles.value.filter((v) => v.kind === (main.kind === 'RIGIDO' ? 'REMOLQUE' : 'SEMIRREMOLQUE')) : [];
});

async function load(): Promise<void> {
  try {
    t.value = await api(`/transports/${props.id}`);
    sel.value = { driver: t.value.driver?.id ?? '', tractor: t.value.vehicles?.tractor.id ?? '', trailer: t.value.vehicles?.trailer?.id ?? '' };
    if (canWrite.value && !drivers.value.length) {
      const [u, v] = await Promise.all([api<any[]>('/users'), api<any[]>('/vehicles?active=true')]);
      drivers.value = u.filter((x) => x.role === 'conductor' && x.active); vehicles.value = v;
    }
  } catch (e) { error.value = messageFor(e); }
}
async function run(name: string, fn: () => Promise<unknown>, done: string): Promise<void> {
  busy.value = name; error.value = ''; ok.value = '';
  try { await fn(); ok.value = done; await load(); } catch (e) { error.value = messageFor(e); } finally { busy.value = ''; }
}
const assignDriver = (): Promise<void> => run('driver', () => api(`/transports/${props.id}/assign-driver`, { method: 'POST', body: { driver_id: sel.value.driver } }), 'Conductor asignado.');
/** Relevo: el elegido continuará cuando el conductor actual pulse «He terminado mi parte» (el actual no lo pierde). */
const setRelay = (): Promise<void> => run('driver', () => api(`/transports/${props.id}/assign-driver`, { method: 'POST', body: { driver_id: sel.value.driver, relay: true } }), 'Relevo programado: continuará cuando el conductor actual termine su parte.');
const clearRelay = (): Promise<void> => run('driver', () => api(`/transports/${props.id}/relay`, { method: 'DELETE' }), 'Relevo quitado.');
const hhmm = (d: string): string => new Date(d).toLocaleString('es-ES', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const saveVehicles = (): Promise<void> => run('veh', () => api(`/transports/${props.id}/vehicles`, { method: 'PUT', body: { tractor_id: sel.value.tractor, trailer_id: sel.value.trailer || null } }), 'Vehículos asignados.');
const makeDeca = (): Promise<void> => run('deca', () => api(`/transports/${props.id}/deca`, { method: 'POST' }), 'DeCA generado.');
const isAdmin = computed(() => auth.user?.role === 'admin');
const reissueReason = ref('Dirección pública actualizada');
const isOpen = computed(() => ['PENDIENTE', 'EN_CURSO'].includes(t.value?.status));
// Anular el transporte (no se borra: se conserva el registro y el DeCA)
const cancelOpen = ref(false), cancelReason = ref('');
async function cancelTransport(): Promise<void> {
  await run('cancel', () => api(`/transports/${props.id}/cancel`, { method: 'POST', body: { reason: cancelReason.value } }), 'Transporte anulado. Se conserva el registro y el DeCA.');
  cancelOpen.value = false; cancelReason.value = '';
}
// Cambio de vehículo con el DeCA ya emitido: nueva versión del DeCA (mismo QR) que anota el cambio en la casilla 8.1
const chgOpen = ref(false), chg = ref({ tractor: '', trailer: '', reason: '' });
function openChange(): void { chg.value = { tractor: t.value.vehicles?.tractor.id ?? '', trailer: t.value.vehicles?.trailer?.id ?? '', reason: '' }; chgOpen.value = true; }
const chgTrailers = computed(() => { const main = vehicles.value.find((v) => v.id === chg.value.tractor); return main ? vehicles.value.filter((v) => v.kind === (main.kind === 'RIGIDO' ? 'REMOLQUE' : 'SEMIRREMOLQUE')) : []; });
async function changeVehicle(): Promise<void> {
  await run('chg', async () => { const r = await api<{ deca_version: number | null }>(`/transports/${props.id}/vehicle-change`, { method: 'POST', body: { tractor_id: chg.value.tractor, trailer_id: chg.value.trailer || null, reason: chg.value.reason || undefined } }); okVer.value = r.deca_version; }, 'Vehículo cambiado.');
  chgOpen.value = false;
}
const okVer = ref<number | null>(null);
const reissue = (): Promise<void> => run('reissue', () => api(`/admin/decas/${t.value.deca.id}/reissue`, { method: 'POST', body: { reason: reissueReason.value } }), 'DeCA reemitido con la dirección actual. El anterior se conserva como sustituido.');
const review = (id: string): Promise<void> => run(`ext-${id}`, () => api(`/external-decas/${id}/review`, { method: 'POST', body: {} }), 'Marcado como revisado (no implica que sea un DeCA válido).');
useFit();
onMounted(load);
</script>
<template>
  <div class="page-title">
    <div>
      <RouterLink class="pg-back" to="/oficina/transportes">← Transportes</RouterLink>
      <h1 v-if="t">{{ t.origins[0].city || t.origins[0].address }}<small v-if="t.origins.length > 1"> (+{{ t.origins.length - 1 }})</small> → {{ t.destinations[0].city || t.destinations[0].address }}<small v-if="t.destinations.length > 1"> (+{{ t.destinations.length - 1 }})</small></h1><h1 v-else>Transporte</h1>
      <div v-if="t" class="pg-meta"><StatusBadge :status="t.status" /><span v-if="t.reference" class="mono">{{ t.reference }}</span><span>·</span><span>{{ fmtDate(t.transport_date) }}</span><span>·</span><span>{{ t.shipper.name }}</span></div>
    </div>
    <div v-if="t && canWrite && isOpen" class="pg-actions"><button class="btn btn-danger" type="button" @click="cancelOpen = true">Anular transporte</button></div>
  </div>
  <div class="fit">
  <p v-if="agendaNew[0] || agendaNew[1] || agendaNew[2]" class="alert alert-ok">Guardado en tu agenda de empresas: {{ [agendaNew[0] ? `${agendaNew[0]} empresa${agendaNew[0] === 1 ? '' : 's'} nueva${agendaNew[0] === 1 ? '' : 's'}` : '', agendaNew[1] ? `${agendaNew[1]} lugar${agendaNew[1] === 1 ? '' : 'es'} nuevo${agendaNew[1] === 1 ? '' : 's'}` : '', agendaNew[2] ? `la ubicación de ${agendaNew[2]} lugar${agendaNew[2] === 1 ? '' : 'es'}` : ''].filter(Boolean).join(', ') }}. La próxima vez bastará con buscar la empresa por el nombre: saldrá con su ubicación.</p>
  <p v-if="error" class="alert alert-err">{{ error }}</p>
  <p v-if="ok" class="alert alert-ok">{{ ok }}</p>
  <p v-if="t && t.status === 'CANCELADO'" class="alert alert-warn">Este transporte está anulado. Se conserva el registro y su DeCA (hay que guardarlo al menos un año); el conductor ya no lo ve.</p>
  <p v-if="t && t.status === 'FINALIZADO'" class="alert alert-info">Este transporte está finalizado.</p>

  <div v-if="t" class="cols2">
    <div class="stack-panels">
      <section class="ui-sec">
        <header class="ui-head"><div><h2>Intervinientes</h2><p>Cargador contractual y transportista efectivo.</p></div></header>
        <div class="ui-body"><dl class="kv">
        <dt>Cargador contractual</dt><dd>{{ t.shipper.name }}<br /><span class="muted small">NIF {{ t.shipper.nif }} · {{ t.shipper.address }}</span></dd>
        <dt>Transportista efectivo</dt><dd>{{ t.carrier.name }}<br /><span class="muted small">NIF {{ t.carrier.nif }}<template v-if="t.carrier_address"> · {{ t.carrier_address }}</template><template v-if="t.carrier_authorization"> · Autorización {{ t.carrier_authorization }}</template></span></dd>
        </dl></div>
      </section>
      <section class="ui-sec">
        <header class="ui-head"><div><h2>Ruta</h2><p>Lugares de carga y descarga con su ubicación e indicaciones.</p></div></header>
        <div class="ui-body"><dl class="kv">
        <dt>Fecha de realización</dt><dd>{{ fmtDate(t.transport_date) }}</dd>
        <dt>{{ t.origins.length > 1 ? 'Lugares de carga' : 'Lugar de carga' }}</dt><dd><div v-for="(s, i) in t.origins" :key="'o' + i"><b v-if="s.party">{{ s.party }}</b><span v-if="s.party"> · </span>{{ fullAddress(s) }}<span v-if="s.time"> · <b>{{ s.time }}</b></span><b v-if="s.pallets !== null && s.pallets !== undefined"> · {{ s.pallets }} {{ s.pallets === 1 ? 'palet' : 'palets' }}</b><span v-if="s.references?.length" class="muted small"> · {{ s.references.length > 1 ? 'Referencias' : 'Referencia' }}: {{ s.references.join(', ') }}</span><span v-if="s.seals?.length" class="muted small"> · {{ s.seals.length > 1 ? 'Precintos' : 'Precinto' }}: {{ s.seals.join(', ') }}</span>
          <a v-if="s.maps_url" class="btn btn-sm way" :href="s.maps_url" target="_blank" rel="noopener noreferrer">Mapa</a> <button class="btn btn-sm way" type="button" @click="shareStop(s, 'Carga')">{{ copiedStop === 'Carga' + s.address ? 'Copiado' : 'Compartir' }}</button>
          <div v-if="s.site_notes" class="muted small">{{ s.site_notes }}</div></div></dd>
        <dt>{{ t.destinations.length > 1 ? 'Lugares de descarga' : 'Lugar de descarga' }}</dt><dd><div v-for="(s, i) in t.destinations" :key="'d' + i"><b v-if="s.party">{{ s.party }}</b><span v-if="s.party"> · </span>{{ fullAddress(s) }}<span v-if="s.time"> · <b>{{ s.time }}</b></span><b v-if="s.pallets !== null && s.pallets !== undefined"> · {{ s.pallets }} {{ s.pallets === 1 ? 'palet' : 'palets' }}</b><span v-if="s.references?.length" class="muted small"> · {{ s.references.length > 1 ? 'Referencias' : 'Referencia' }}: {{ s.references.join(', ') }}</span><span v-if="s.seals?.length" class="muted small"> · {{ s.seals.length > 1 ? 'Precintos' : 'Precinto' }}: {{ s.seals.join(', ') }}</span>
          <a v-if="s.maps_url" class="btn btn-sm way" :href="s.maps_url" target="_blank" rel="noopener noreferrer">Mapa</a> <button class="btn btn-sm way" type="button" @click="shareStop(s, 'Descarga')">{{ copiedStop === 'Descarga' + s.address ? 'Copiado' : 'Compartir' }}</button>
          <div v-if="s.site_notes" class="muted small">{{ s.site_notes }}</div></div></dd>
        </dl></div>
      </section>
      <section class="ui-sec">
        <header class="ui-head"><div><h2>Mercancía</h2></div></header>
        <div class="ui-body"><dl class="kv">
        <dt>Mercancía</dt><dd>{{ t.cargo }}<template v-if="t.units !== null && t.units !== undefined"> · {{ t.units }} {{ t.packaging ?? '' }}</template><template v-else-if="t.packages"> · {{ t.packages }}</template></dd>
        <template v-if="t.adr"><dt>Mercancía peligrosa (ADR)</dt><dd>Sí<template v-if="t.adr_detail"> · {{ t.adr_detail }}</template></dd></template>
        <template v-if="t.load_reference"><dt>Referencia de carga</dt><dd>{{ t.load_reference }}</dd></template>
        <template v-if="t.temperature"><dt>Temperatura</dt><dd>{{ t.temperature }}</dd></template>
        <template v-if="t.price_eur"><dt>Precio</dt><dd>{{ Number(t.price_eur).toLocaleString('es-ES', { minimumFractionDigits: 2 }) }} €</dd></template>
        <dt>Peso</dt><dd>{{ t.weight_kg ? kg(t.weight_kg) : `Otra magnitud: ${t.alt_magnitude}` }}</dd>
        <dt>Autorización especial</dt><dd>{{ t.aec_ref ?? 'No aplica' }}</dd>
        <dt>Observaciones</dt><dd>{{ t.remarks ?? '—' }}</dd>

        </dl></div>
      </section>
    </div>

    <div class="stack-panels">
      <section class="ui-sec">
        <header class="ui-head"><div><h2>Asignación</h2><p>Conductor y vehículos del transporte.</p></div></header>
        <div class="ui-body stack">
        <div>
          <h3>Conductor</h3>
          <p>{{ t.driver ? t.driver.full_name : 'Sin conductor (pendiente)' }}</p>
          <p v-if="t.relay" class="alert alert-info small">Relevo programado: <b>{{ t.relay.full_name }}</b> continuará cuando {{ t.driver?.full_name ?? 'el conductor actual' }} pulse «He terminado mi parte».
            <button v-if="canWrite && isOpen" class="btn btn-sm" type="button" :disabled="busy === 'driver'" @click="clearRelay">Quitar relevo</button></p>
          <div v-if="canWrite && isOpen" class="row">
            <select v-model="sel.driver" aria-label="Conductor"><option value="" disabled>Elige un conductor</option><option v-for="d in drivers" :key="d.id" :value="d.id">{{ d.full_name }} ({{ d.username }})</option></select>
            <button class="btn btn-primary btn-sm" :disabled="!sel.driver || sel.driver === t.driver?.id || busy === 'driver'" @click="assignDriver">{{ t.driver ? 'Sustituir ahora' : 'Asignar' }}</button>
            <button v-if="t.driver" class="btn btn-sm" :disabled="!sel.driver || sel.driver === t.driver?.id || sel.driver === t.relay?.id || busy === 'driver'" @click="setRelay">Programar relevo</button>
          </div>
          <p v-if="canWrite && isOpen && t.driver" class="muted small"><b>Sustituir ahora</b>: el conductor actual lo pierde al momento. <b>Programar relevo</b>: el actual sigue hasta que pulse «He terminado mi parte»; entonces pasa al relevo, que recibe el aviso.</p>
          <ul v-if="t.drivers_history?.length > 1 || (t.drivers_history?.length && !t.driver)" class="small muted">
            <li v-for="(h, i) in t.drivers_history" :key="i">{{ h.full_name }}: {{ hhmm(h.valid_from) }} → {{ h.valid_to ? hhmm(h.valid_to) : 'ahora' }}</li>
          </ul>
          <p class="muted small">Si el DeCA ya está emitido y la empresa imprime los datos del conductor, al asignarlo (o cambiarlo) el DeCA recibe una versión nueva con el mismo QR: el conductor y, si cambia, el conductor sucesivo (relevo).</p>
        </div>
        <div>
          <h3>Vehículos</h3>
          <template v-if="t.deca || !canWrite">
            <p>{{ t.vehicles ? `${t.vehicles.tractor.plate} (${KIND[t.vehicles.tractor.kind]})` : 'Sin asignar' }}<template v-if="t.vehicles?.trailer"> + {{ t.vehicles.trailer.plate }} ({{ KIND[t.vehicles.trailer.kind] }})</template></p>
            <p v-if="t.deca" class="muted small">El DeCA ya está emitido con estas matrículas. Si hay que cambiar de vehículo, el DeCA recibe una versión nueva (mismo QR y URL) que conserva la matrícula original en la casilla 8 y anota el cambio, con su fecha, en la 8.1.</p>
            <button v-if="t.deca && canWrite && isOpen" class="btn btn-sm btn-primary" type="button" @click="openChange">Cambiar vehículo</button>
          </template>
          <template v-else>
            <label>Vehículo (tractora o rígido)<select v-model="sel.tractor" @change="sel.trailer = ''"><option value="" disabled>Elige</option><option v-for="v in mains" :key="v.id" :value="v.id">{{ v.plate }} · {{ KIND[v.kind] }}</option></select></label>
            <label>Remolque / semirremolque<select v-model="sel.trailer" :disabled="!sel.tractor"><option value="">Ninguno</option><option v-for="v in trailers" :key="v.id" :value="v.id">{{ v.plate }} · {{ KIND[v.kind] }}</option></select></label>
            <button class="btn btn-primary btn-sm" :disabled="!sel.tractor || busy === 'veh'" @click="saveVehicles">Guardar vehículos</button>
          </template>
        </div>
              </div>
      </section>

      <section class="ui-sec">
        <header class="ui-head"><div><h2>DeCA</h2><p>Documento de control administrativo del transporte.</p></div><span v-if="t.deca" class="badge b-fin">Emitido</span><span v-else class="badge b-pend">Sin DeCA</span></header>
        <div class="ui-body stack">
        <template v-if="t.deca">
          <dl class="kv">
            <dt>Versión actual</dt><dd>{{ t.deca.version }}</dd>
            <dt>Creado</dt><dd>{{ fmtDateTime(t.deca.created_at) }}</dd>
            <dt>Última modificación</dt><dd>{{ fmtDateTime(t.deca.modified_at) }}</dd>
            <dt>Estado</dt><dd><span class="badge b-fin">Emitido</span> <span class="muted small">{{ t.deca.public_active ? 'Enlace público activo' : 'Enlace público desactivado' }}</span></dd>
          </dl>
          <div class="row">
            <button class="btn btn-primary" @click="view = { title: 'DeCA (PDF)', path: `/decas/${t.deca.id}/versions/${t.deca.version}/pdf`, kind: 'pdf', filename: `DeCA-${t.transport_date}.pdf` }">Ver PDF</button>
            <button class="btn btn-accent" @click="view = { title: 'QR del DeCA', path: `/decas/${t.deca.id}/qr.svg`, kind: 'qr' }">Mostrar QR</button>
          </div>
          <div v-if="t.deca.technical.other_base && isAdmin" class="alert alert-warn stack">
            <p>Este DeCA lleva impresa una dirección pública que ya no es la actual: quien escanee su QR desde fuera de esa red puede no llegar al documento.</p>
            <label>Motivo<input v-model="reissueReason" maxlength="500" /></label>
            <button class="btn btn-primary" :disabled="busy === 'reissue' || reissueReason.trim().length < 3" @click="reissue">{{ busy === 'reissue' ? 'Reemitiendo…' : 'Reemitir con la dirección actual' }}</button>
            <p class="muted small">Se genera un PDF y un QR nuevos con los mismos datos. El anterior se conserva (no se borra) y su enlace sigue sirviendo su PDF.</p>
          </div>
          <details class="tech">
            <summary>Datos técnicos</summary>
            <dl class="kv small">
              <dt>SHA-256</dt><dd class="mono">{{ t.deca.technical.sha256 }}</dd>
              <dt>Tamaño</dt><dd>{{ t.deca.technical.size_bytes.toLocaleString('es-ES') }} bytes</dd>
              <dt>Enlace público</dt><dd class="mono">{{ t.deca.technical.public_url }}<br v-if="t.deca.technical.other_base" /><span v-if="t.deca.technical.other_base" class="muted small">Emitido con una dirección distinta de la actual; es la que lleva impresa su QR.</span></dd>
              <dt>Identificador</dt><dd class="mono">{{ t.deca.id }}</dd>
            </dl>
          </details>
        </template>
        <template v-else>
          <p class="muted">Este transporte todavía no tiene DeCA.</p>
          <button v-if="canWrite" class="btn btn-primary" :disabled="!t.vehicles || busy === 'deca'" @click="makeDeca">Generar DeCA</button>
          <p v-if="canWrite && !t.vehicles" class="small muted">Asigna primero un vehículo: la matrícula es un dato obligatorio.</p>
        </template>
              </div>
      </section>
    </div>
  </div>
  <section v-if="t?.external_decas.length" class="ui-sec flush pad-top">
    <header class="ui-head"><div><h2>DeCA externos recibidos</h2><p>Documentos aportados por un tercero (p. ej. el cargador). No se ha comprobado que sean un DeCA válido ni sustituyen al documento propio.</p></div></header>
    <div>
      <table>
        <thead><tr><th>Recibido</th><th>Añadido por</th><th>Desde</th><th>Estado</th><th></th></tr></thead>
        <tbody>
          <tr v-for="e in t.external_decas" :key="e.id">
            <td>{{ fmtDateTime(e.fetched_at) }}</td><td>{{ e.added_by }}</td>
            <td>{{ e.device_status === 'AUTORIZADO' ? 'Dispositivo autorizado' : 'Dispositivo pendiente' }}</td>
            <td><span :class="['badge', e.review_status === 'REVISADO' ? 'b-fin' : 'b-pend']">{{ e.review_status === 'REVISADO' ? 'Revisado' : 'Pendiente de revisión' }}</span></td>
            <td class="actions">
              <button class="btn btn-sm" @click="view = { title: 'DeCA externo (PDF)', path: `/external-decas/${e.id}/pdf`, kind: 'pdf', filename: 'DeCA-externo.pdf' }">Ver PDF</button>
              <button v-if="canWrite && e.review_status !== 'REVISADO'" class="btn btn-sm btn-primary" :disabled="busy === `ext-${e.id}`" @click="review(e.id)">Marcar revisado</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
  </div>

  <FileViewer v-if="view" :title="view.title" :path="view.path" :kind="view.kind" :filename="view.filename" @close="view = null" />
  <Modal v-if="cancelOpen" title="Anular transporte" @close="cancelOpen = false">
    <form class="stack" @submit.prevent="cancelTransport">
      <p class="muted small">El transporte no se borra: queda anulado y desaparece de la app del conductor. Su DeCA se conserva, porque hay que guardarlo al menos un año.</p>
      <label>Motivo de la anulación<input v-model="cancelReason" required maxlength="300" /></label>
      <button class="btn btn-danger" :disabled="busy === 'cancel' || cancelReason.trim().length < 3">Anular transporte</button>
    </form>
  </Modal>
  <Modal v-if="chgOpen" title="Cambiar vehículo" @close="chgOpen = false">
    <form class="stack" @submit.prevent="changeVehicle">
      <p class="muted small">Se genera una versión nueva del DeCA con el mismo QR. La matrícula original queda en la casilla 8 y el cambio se anota en la 8.1.</p>
      <label>Vehículo nuevo (tractora o rígido)<select v-model="chg.tractor" @change="chg.trailer = ''"><option value="" disabled>Elige</option><option v-for="v in mains" :key="v.id" :value="v.id">{{ v.plate }} · {{ KIND[v.kind] }}</option></select></label>
      <label>Remolque / semirremolque<select v-model="chg.trailer" :disabled="!chg.tractor"><option value="">Ninguno</option><option v-for="v in chgTrailers" :key="v.id" :value="v.id">{{ v.plate }} · {{ KIND[v.kind] }}</option></select></label>
      <label>Motivo (opcional)<input v-model="chg.reason" maxlength="200" placeholder="Avería, cambio de unidad…" /></label>
      <button class="btn btn-primary" :disabled="busy === 'chg' || !chg.tractor">Cambiar vehículo</button>
    </form>
  </Modal>
</template>
