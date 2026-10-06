<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import PartyPicker from '../../components/PartyPicker.vue';
import StopLocation from '../../components/StopLocation.vue';
import { api, auth } from '../../api';
import { messageFor } from '../../errors';
import { KIND, completeAddress, provinceFromPostal } from '../../format';

const router = useRouter();
const canWrite = computed(() => auth.user?.role === 'admin' || auth.user?.role === 'oficina');
const today = new Date().toISOString().slice(0, 10);
const f = reactive({
  shipper_name: '', shipper_nif: '', shipper_address: '', transport_date: today, cargo: '',
  weightMode: 'kg' as 'kg' | 'alt', weight_kg: '', alt_magnitude: '', aec_ref: '', remarks: '',
  driver_id: '', tractor_id: '', trailer_id: '', generate_deca: true,
  otherCarrier: false, carrier_name: '', carrier_nif: '', carrier_address: '', carrier_postal_code: '', carrier_city: '', carrier_province: '', carrier_country: '', shipper_postal_code: '', shipper_city: '', shipper_province: '', shipper_country: '', packages: '', units: '', packaging: '', adr: false, adr_detail: '', carrier_authorization: '', load_reference: '', temperature: '', price_eur: ''
});
interface StopForm { party: string; address: string; postal_code: string; city: string; province: string; country: string; party_id: string; site_id: string; sites: any[]; pallets: string; refs: string; seals: string; time: string; map_url: string; lat: string; lon: string; notes: string }
const blankStop = (): StopForm => ({ party: '', address: '', postal_code: '', city: '', province: '', country: '', party_id: '', site_id: '', sites: [], pallets: '', refs: '', seals: '', time: '', map_url: '', lat: '', lon: '', notes: '' });
const stopsO = reactive<StopForm[]>([blankStop()]);
const stopsD = reactive<StopForm[]>([blankStop()]);
const addStop = (l: StopForm[]): void => { if (l.length < 10) l.push(blankStop()); };
const dropStop = (l: StopForm[], i: number): void => { if (l.length > 1) l.splice(i, 1); };
const clean = (l: StopForm[]): Record<string, unknown>[] => l.map((x) => ({ party: x.party.trim(), address: x.address.trim(), ...(x.postal_code.trim() ? { postal_code: x.postal_code.trim() } : {}), ...(x.city.trim() ? { city: x.city.trim() } : {}), ...(x.province.trim() ? { province: x.province.trim() } : {}), ...(x.country.trim() ? { country: x.country.trim() } : {}), ...(x.party_id ? { party_id: x.party_id } : {}), ...(x.site_id ? { site_id: x.site_id } : {}), ...(x.pallets !== '' ? { pallets: x.pallets } : {}), ...(x.refs.trim() ? { references: x.refs } : {}), ...(x.seals.trim() ? { seals: x.seals } : {}), ...(x.time ? { time: x.time } : {}), ...(x.map_url.trim() || x.lat.trim() || x.lon.trim() || x.notes.trim() ? { location: { map_url: x.map_url.trim(), lat: x.lat.trim(), lon: x.lon.trim(), notes: x.notes.trim() } } : {}) }));
const sumPallets = (l: StopForm[]): number | null => (l.some((x) => x.pallets !== '') ? l.reduce((a, x) => a + (Number(x.pallets) || 0), 0) : null);
const palLabel = (n: number): string => `${n} ${n === 1 ? 'palet' : 'palets'}`;
const totO = computed(() => sumPallets(stopsO)), totD = computed(() => sumPallets(stopsD));
/** «Nº y clase de bultos» se rellena solo con el total de palets de la carga mientras no se escriba a mano. */
/** «Número de unidades» se rellena solo con el total de palets cargados mientras no se escriba a mano (y el embalaje, «Palets» si está vacío). */
let unitsManual = false;
watch(totO, (n) => { if (!unitsManual) { f.units = n === null ? '' : String(n); if (n !== null && !f.packaging) f.packaging = 'Palets'; } });
const onUnits = (): void => { unitsManual = String(f.units).trim() !== ''; if (!unitsManual && totO.value !== null) f.units = String(totO.value); };
const PACKAGING = ['Palets', 'Europalet', 'Europalet no retornable', 'Palet americano', 'Medio palet', 'Cajas', 'Bultos', 'Big bag', 'Contenedor IBC', 'Granel'];
/** Se elige una empresa de la agenda: se rellena su nombre y, si solo tiene un lugar, también su dirección. */
function pickStop(s: StopForm, p: any): void {
  s.party = p.name; s.party_id = p.id; s.sites = (p.sites ?? []).filter((x: any) => x.active !== false); s.site_id = ''; s.address = ''; s.postal_code = ''; s.city = ''; s.province = ''; s.country = ''; s.map_url = ''; s.lat = ''; s.lon = ''; s.notes = '';
  if (s.sites.length === 1) pickSite(s, s.sites[0].id);
}
function pickSite(s: StopForm, id: string): void {
  const x = s.sites.find((y) => y.id === id);
  if (!x) return;
  s.site_id = x.id;
  Object.assign(s, completeAddress({ address: x.address ?? '', postal_code: x.postal_code ?? '', city: x.city ?? '', province: x.province ?? '', country: x.country ?? '' }));
  // la ubicación guardada del lugar sale ya rellena (enlace, coordenadas e indicaciones)
  s.map_url = x.map_url ?? ''; s.lat = x.lat != null ? String(x.lat) : ''; s.lon = x.lon != null ? String(x.lon) : ''; s.notes = x.notes ?? '';
}
const postalStop = (s: StopForm): void => { if (!s.province) s.province = provinceFromPostal(s.postal_code); };
const postalShipper = (): void => { if (!f.shipper_province) f.shipper_province = provinceFromPostal(f.shipper_postal_code); };
const postalCarrier = (): void => { if (!f.carrier_province) f.carrier_province = provinceFromPostal(f.carrier_postal_code); };
/** Si se cambia la dirección a mano, deja de estar enlazada al lugar guardado: su ubicación ya no corresponde y se vacía. */
const editAddress = (s: StopForm): void => { if (s.site_id) { s.site_id = ''; s.map_url = ''; s.lat = ''; s.lon = ''; s.notes = ''; } };
function pickShipper(p: any): void { f.shipper_name = p.name; f.shipper_nif = p.nif ?? ''; const a = completeAddress({ address: p.address ?? '', postal_code: p.postal_code ?? '', city: p.city ?? '', province: p.province ?? '', country: p.country ?? '' }); f.shipper_address = a.address; f.shipper_postal_code = a.postal_code; f.shipper_city = a.city; f.shipper_province = a.province; f.shipper_country = a.country; }
function pickCarrier(p: any): void { f.otherCarrier = true; f.carrier_name = p.name; f.carrier_nif = p.nif ?? ''; f.carrier_authorization = p.transport_authorization ?? ''; const a = completeAddress({ address: p.address ?? '', postal_code: p.postal_code ?? '', city: p.city ?? '', province: p.province ?? '', country: p.country ?? '' }); f.carrier_address = a.address; f.carrier_postal_code = a.postal_code; f.carrier_city = a.city; f.carrier_province = a.province; f.carrier_country = a.country; }
// Aviso no bloqueante sobre el NIF tecleado (comprobación sin conexión de la letra o el dígito de control).
const nifHint = reactive<Record<string, string>>({});
async function checkNif(key: string, v: string): Promise<void> {
  nifHint[key] = '';
  if (v.trim().length < 8) return;
  try { const r = await api<{ kind: string; valid: boolean | null }>('/taxid/check', { method: 'POST', body: { nif: v } }); nifHint[key] = r.valid === false ? 'No parece un NIF válido: revisa la letra o el dígito de control.' : r.valid === true ? '✔ NIF correcto' : 'Formato no español: no se puede comprobar.'; } catch { /* sin aviso */ }
}
// Aviso (no bloquea): documentos caducados o por caducar del conductor y de los vehículos elegidos.
const docWarn = ref<any[]>([]);
watch(() => [f.driver_id, f.tractor_id, f.trailer_id], async () => {
  if (!f.driver_id && !f.tractor_id && !f.trailer_id) { docWarn.value = []; return; }
  const q = new URLSearchParams(); if (f.driver_id) q.set('driver_id', f.driver_id); if (f.tractor_id) q.set('tractor_id', f.tractor_id); if (f.trailer_id) q.set('trailer_id', f.trailer_id);
  try { docWarn.value = await api<any[]>(`/expiries/check?${q.toString()}`); } catch { docWarn.value = []; }
});
const company = ref<{ name: string; nif: string } | null>(null);
const drivers = ref<any[]>([]), vehicles = ref<any[]>([]);
const busy = ref(false), error = ref('');

const mains = computed(() => vehicles.value.filter((v) => v.kind === 'TRACTORA' || v.kind === 'RIGIDO'));
const trailers = computed(() => {
  const main = vehicles.value.find((v) => v.id === f.tractor_id);
  const want = main?.kind === 'RIGIDO' ? 'REMOLQUE' : 'SEMIRREMOLQUE';
  return main ? vehicles.value.filter((v) => v.kind === want) : [];
});

onMounted(async () => {
  try {
    const [d, u, v] = await Promise.all([api('/dashboard'), api<any[]>('/users'), api<any[]>('/vehicles?active=true')]);
    company.value = d.company; drivers.value = u.filter((x) => x.role === 'conductor' && x.active); vehicles.value = v;
  } catch (e) { error.value = messageFor(e); }
});

async function submit(): Promise<void> {
  busy.value = true; error.value = '';
  try {
    const body: Record<string, unknown> = {
      shipper_name: f.shipper_name, shipper_nif: f.shipper_nif, shipper_address: f.shipper_address, ...(f.shipper_postal_code ? { shipper_postal_code: f.shipper_postal_code } : {}), ...(f.shipper_city ? { shipper_city: f.shipper_city } : {}), ...(f.shipper_province ? { shipper_province: f.shipper_province } : {}), ...(f.shipper_country ? { shipper_country: f.shipper_country } : {}), origins: clean(stopsO), destinations: clean(stopsD),
      transport_date: f.transport_date, cargo: f.cargo, generate_deca: f.generate_deca,
      ...(f.otherCarrier ? { carrier_name: f.carrier_name, carrier_nif: f.carrier_nif, ...(f.carrier_authorization ? { carrier_authorization: f.carrier_authorization } : {}), ...(f.carrier_address ? { carrier_address: f.carrier_address } : {}), ...(f.carrier_postal_code ? { carrier_postal_code: f.carrier_postal_code } : {}), ...(f.carrier_city ? { carrier_city: f.carrier_city } : {}), ...(f.carrier_province ? { carrier_province: f.carrier_province } : {}), ...(f.carrier_country ? { carrier_country: f.carrier_country } : {}) } : {}),
      ...(f.units !== '' ? { units: Number(f.units) } : {}), ...(f.packaging ? { packaging: f.packaging } : {}), ...(f.adr ? { adr: true, ...(f.adr_detail ? { adr_detail: f.adr_detail } : {}) } : {}), ...(f.load_reference ? { load_reference: f.load_reference } : {}), ...(f.temperature ? { temperature: f.temperature } : {}), ...(f.price_eur ? { price_eur: f.price_eur } : {}),
      ...(f.weightMode === 'kg' ? { weight_kg: f.weight_kg } : { alt_magnitude: f.alt_magnitude }),
      ...(f.aec_ref ? { aec_ref: f.aec_ref } : {}), ...(f.remarks ? { remarks: f.remarks } : {}),
      ...(f.driver_id ? { driver_id: f.driver_id } : {}), ...(f.tractor_id ? { tractor_id: f.tractor_id } : {}), ...(f.trailer_id ? { trailer_id: f.trailer_id } : {})
    };
    const r = await api<{ id: string; registered?: { parties: number; sites: number; located?: number } }>('/transports', { method: 'POST', body });
    const g = r.registered;
    await router.push({ path: `/oficina/transportes/${r.id}`, query: g && (g.parties || g.sites || g.located) ? { agenda: `${g.parties},${g.sites},${g.located ?? 0}` } : {} });
  } catch (e) { error.value = messageFor(e); window.scrollTo({ top: 0, behavior: 'smooth' }); } finally { busy.value = false; }
}
</script>
<template>
  <div class="page-title"><h1>Nuevo transporte</h1><RouterLink class="btn" to="/oficina/transportes">Cancelar</RouterLink></div>
  <p v-if="!canWrite" class="alert alert-warn">Tu usuario no puede crear transportes.</p>
  <form v-else @submit.prevent="submit">
    <p v-if="error" class="alert alert-err">{{ error }}</p>

    <fieldset>
      <legend>Cargador contractual</legend>
      <PartyPicker label="Buscar el cargador en la agenda" @pick="pickShipper" />
      <div class="grid2"><label>Nombre o denominación social<input v-model="f.shipper_name" required maxlength="120" /></label><label>NIF<input v-model="f.shipper_nif" required maxlength="16" @input="checkNif('shipper', f.shipper_nif)" /><span v-if="nifHint.shipper" class="hint small"> {{ nifHint.shipper }}</span></label></div>
      <label>Domicilio (calle y número)<input v-model="f.shipper_address" required maxlength="200" /></label>
      <div class="grid4"><label>Código postal<input v-model="f.shipper_postal_code" maxlength="10" inputmode="numeric" @input="postalShipper()" /></label><label>Localidad<input v-model="f.shipper_city" maxlength="80" /></label><label>Provincia<input v-model="f.shipper_province" maxlength="80" /></label><label>País<input v-model="f.shipper_country" maxlength="60" placeholder="España" /></label></div>
    </fieldset>

    <fieldset>
      <legend>Transportista efectivo</legend>
      <p v-if="company && !f.otherCarrier" class="muted">{{ company.name }} · {{ company.nif }} <span class="small">(tu empresa)</span></p>
      <label class="check"><input v-model="f.otherCarrier" type="checkbox" /> El transportista efectivo es otra empresa</label>
      <PartyPicker v-if="f.otherCarrier" label="Buscar el transportista en la agenda" @pick="pickCarrier" />
      <div v-if="f.otherCarrier" class="grid2"><label>Nombre o denominación social<input v-model="f.carrier_name" required maxlength="120" /></label><label>NIF<input v-model="f.carrier_nif" required maxlength="16" @input="checkNif('carrier', f.carrier_nif)" /><span v-if="nifHint.carrier" class="hint small"> {{ nifHint.carrier }}</span></label></div>
      <div v-if="f.otherCarrier" class="grid2"><label>Domicilio del transportista (calle y número; opcional)<input v-model="f.carrier_address" maxlength="200" /></label><label>Nº de autorización de transporte<span class="hint small"> (opcional)</span><input v-model="f.carrier_authorization" maxlength="30" /></label></div>
      <div v-if="f.otherCarrier" class="grid4"><label>Código postal<input v-model="f.carrier_postal_code" maxlength="10" inputmode="numeric" @input="postalCarrier()" /></label><label>Localidad<input v-model="f.carrier_city" maxlength="80" /></label><label>Provincia<input v-model="f.carrier_province" maxlength="80" /></label><label>País<input v-model="f.carrier_country" maxlength="60" placeholder="España" /></label></div>
    </fieldset>

    <fieldset>
      <legend>Ruta y fecha</legend>
      <h3 class="sub">Carga (origen)</h3>
      <p class="muted small">Uno o varios lugares de recogida. Quien carga no tiene por qué ser quien descarga: indica la empresa de cada lugar si la conoces.</p>
      <div v-for="(s, i) in stopsO" :key="'o' + i" class="stop">
        <PartyPicker label="Buscar la empresa en la agenda" @pick="(p: any) => pickStop(s, p)" />
        <div class="grid2"><label>Empresa que carga (opcional)<input v-model="s.party" maxlength="120" @input="s.party_id = ''; s.site_id = ''" /></label><label>Dirección del lugar de carga (calle y número)<input v-model="s.address" required maxlength="200" @input="editAddress(s)" /></label></div>
        <div class="grid4"><label>Código postal<input v-model="s.postal_code" maxlength="10" inputmode="numeric" @input="postalStop(s)" /></label><label>Localidad *<span class="hint small"> (sale en la casilla del DeCA)</span><input v-model="s.city" maxlength="80" required /></label><label>Provincia<input v-model="s.province" maxlength="80" /></label><label>País<input v-model="s.country" maxlength="60" placeholder="España" /></label></div>
        <label v-if="s.sites.length > 1">Lugares guardados de esta empresa<select :value="s.site_id" @change="pickSite(s, ($event.target as HTMLSelectElement).value)"><option value="">Elige uno…</option><option v-for="x in s.sites" :key="x.id" :value="x.id">{{ x.label ? x.label + ' · ' : '' }}{{ x.address }}</option></select></label>
        <div class="grid4">
          <label>Hora de carga<span class="hint small"> (opcional)</span><input v-model="s.time" type="time" /></label>
          <label>Palets cargados en este lugar<span class="hint small"> (opcional)</span><input v-model="s.pallets" type="number" min="0" max="9999" step="1" inputmode="numeric" /></label>
          <label>Referencia(s) de carga<span class="hint small"> (separadas por comas)</span><input v-model="s.refs" maxlength="300" /></label>
          <label>Nº de precinto(s)<span class="hint small"> (separados por comas)</span><input v-model="s.seals" maxlength="300" /></label>
        </div>
        <StopLocation :stop="s" what="carga" />
        <button v-if="stopsO.length > 1" class="btn btn-sm" type="button" @click="dropStop(stopsO, i)">Quitar este lugar</button>
      </div>
      <button v-if="stopsO.length < 10" class="btn btn-sm" type="button" @click="addStop(stopsO)">+ Añadir otro lugar de carga</button>
      <p v-if="totO !== null" class="small"><b>Total cargado: {{ palLabel(totO) }}</b><template v-if="totD !== null && totD !== totO"> · <span class="err-text">no coincide con lo descargado ({{ palLabel(totD) }})</span></template></p>
      <h3 class="sub">Descarga (destino)</h3>
      <p class="muted small">Uno o varios lugares de entrega, cada uno con su empresa si es distinta.</p>
      <div v-for="(s, i) in stopsD" :key="'d' + i" class="stop">
        <PartyPicker label="Buscar la empresa en la agenda" @pick="(p: any) => pickStop(s, p)" />
        <div class="grid2"><label>Empresa que descarga (opcional)<input v-model="s.party" maxlength="120" @input="s.party_id = ''; s.site_id = ''" /></label><label>Dirección del lugar de descarga (calle y número)<input v-model="s.address" required maxlength="200" @input="editAddress(s)" /></label></div>
        <div class="grid4"><label>Código postal<input v-model="s.postal_code" maxlength="10" inputmode="numeric" @input="postalStop(s)" /></label><label>Localidad *<span class="hint small"> (sale en la casilla del DeCA)</span><input v-model="s.city" maxlength="80" required /></label><label>Provincia<input v-model="s.province" maxlength="80" /></label><label>País<input v-model="s.country" maxlength="60" placeholder="España" /></label></div>
        <label v-if="s.sites.length > 1">Lugares guardados de esta empresa<select :value="s.site_id" @change="pickSite(s, ($event.target as HTMLSelectElement).value)"><option value="">Elige uno…</option><option v-for="x in s.sites" :key="x.id" :value="x.id">{{ x.label ? x.label + ' · ' : '' }}{{ x.address }}</option></select></label>
        <div class="grid4">
          <label>Hora de entrega<span class="hint small"> (opcional)</span><input v-model="s.time" type="time" /></label>
          <label>Palets descargados en este lugar<span class="hint small"> (opcional)</span><input v-model="s.pallets" type="number" min="0" max="9999" step="1" inputmode="numeric" /></label>
          <label>Referencia(s) de descarga<span class="hint small"> (separadas por comas)</span><input v-model="s.refs" maxlength="300" /></label>
          <label>Nº de precinto(s)<span class="hint small"> (separados por comas)</span><input v-model="s.seals" maxlength="300" /></label>
        </div>
        <StopLocation :stop="s" what="descarga" />
        <button v-if="stopsD.length > 1" class="btn btn-sm" type="button" @click="dropStop(stopsD, i)">Quitar este lugar</button>
      </div>
      <button v-if="stopsD.length < 10" class="btn btn-sm" type="button" @click="addStop(stopsD)">+ Añadir otro lugar de descarga</button>
      <p v-if="totD !== null" class="small"><b>Total descargado: {{ palLabel(totD) }}</b></p>
      <label>Fecha de realización del transporte<input v-model="f.transport_date" type="date" required /></label>
    </fieldset>

    <fieldset>
      <legend>Mercancía</legend>
      <label>Naturaleza de la mercancía<input v-model="f.cargo" required maxlength="200" /></label>
      <div class="radio">
        <label><input v-model="f.weightMode" type="radio" value="kg" /> Peso en kg</label>
        <label><input v-model="f.weightMode" type="radio" value="alt" /> Peso de difícil determinación: otra magnitud</label>
      </div>
      <label v-if="f.weightMode === 'kg'">Peso (kg)<input v-model="f.weight_kg" inputmode="decimal" required placeholder="12450" /></label>
      <label v-else>Otra magnitud que determine el peso<span class="hint"> (p. ej. «24 palets de 500 kg aprox.»)</span><input v-model="f.alt_magnitude" required maxlength="200" /></label>
      <div class="grid3">
        <label>Número de unidades<span class="hint"> (se rellena solo con el total de palets cargados)</span><input v-model="f.units" type="number" min="0" max="999999" step="1" inputmode="numeric" @input="onUnits" /></label>
        <label>Tipo de embalaje<span class="hint"> (elige o escribe)</span><input v-model="f.packaging" list="decargo-packaging" maxlength="40" placeholder="Europalet" /><datalist id="decargo-packaging"><option v-for="p in PACKAGING" :key="p" :value="p" /></datalist></label>
        <label>Temperatura<span class="hint"> (opcional)</span><input v-model="f.temperature" maxlength="60" placeholder="Sin temperatura / +2 a +5 ºC" /></label>
      </div>
      <label class="check"><input v-model="f.adr" type="checkbox" /> Mercancía peligrosa (ADR)</label>
      <label v-if="f.adr">Detalle ADR<span class="hint"> (opcional: nº ONU, clase, grupo de embalaje… p. ej. «UN 1203, 3, II (D/E)»)</span><input v-model="f.adr_detail" maxlength="120" /></label>
      <label>Precio del transporte (€)<span class="hint"> (opcional; dato no obligatorio)</span><input v-model="f.price_eur" inputmode="decimal" placeholder="1250,00" /></label>
      <label>Autorización especial de circulación<span class="hint"> (solo si el vehículo circula amparado por una)</span><input v-model="f.aec_ref" maxlength="120" /></label>
      <label>Observaciones, reservas u otras indicaciones<span class="hint"> (opcional)</span><textarea v-model="f.remarks" maxlength="1000"></textarea></label>
    </fieldset>

    <fieldset>
      <legend>Asignación</legend>
      <div class="grid3">
        <label>Conductor
          <select v-model="f.driver_id"><option value="">Sin asignar todavía</option><option v-for="d in drivers" :key="d.id" :value="d.id">{{ d.full_name }} ({{ d.username }})</option></select>
        </label>
        <label>Vehículo (tractora o rígido)
          <select v-model="f.tractor_id" @change="f.trailer_id = ''"><option value="">Sin asignar todavía</option><option v-for="v in mains" :key="v.id" :value="v.id">{{ v.plate }} · {{ KIND[v.kind] }}</option></select>
        </label>
        <label>Remolque / semirremolque
          <select v-model="f.trailer_id" :disabled="!f.tractor_id"><option value="">Ninguno</option><option v-for="v in trailers" :key="v.id" :value="v.id">{{ v.plate }} · {{ KIND[v.kind] }}</option></select>
        </label>
      </div>
      <p v-if="!vehicles.length" class="alert alert-warn">No hay vehículos activos. Crea alguno en <RouterLink to="/oficina/vehiculos">Vehículos</RouterLink>.</p>
    </fieldset>

    <div class="card stack">
      <label class="row"><input v-model="f.generate_deca" type="checkbox" class="check" /> <span>Generar el DeCA al crear el transporte (necesita un vehículo)</span></label>
      <div v-if="docWarn.length" :class="['alert', docWarn.some((x) => x.status === 'CADUCADO') ? 'alert-err' : 'alert-warn']">
        <b>Documentación a revisar</b> (no impide crear el transporte):
        <ul class="plain"><li v-for="x in docWarn" :key="x.source + x.id"><b>{{ x.subject }}</b> · {{ x.what }} — {{ x.status === 'CADUCADO' ? 'caducado' : 'caduca' }} el {{ x.expires_on.split('-').reverse().join('/') }}</li></ul>
      </div>
      <p v-if="f.generate_deca && !f.tractor_id" class="alert alert-warn">Para generar el DeCA hay que elegir el vehículo: la matrícula es un dato obligatorio del documento.</p>
      <button class="btn btn-primary" :disabled="busy || (f.generate_deca && !f.tractor_id)">{{ busy ? 'Guardando…' : f.generate_deca ? 'Crear transporte y generar DeCA' : 'Crear transporte' }}</button>
    </div>
  </form>
</template>
