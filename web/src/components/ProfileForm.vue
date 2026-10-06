<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import Modal from './Modal.vue';
import { api } from '../api';
import { messageFor } from '../errors';

/** Ficha del conductor. DNI, Seguridad Social e IBAN llegan ENMASCARADOS; solo se ven con «Mostrar» (queda auditado). */
const props = defineProps<{ userId: string; canWrite: boolean }>();
const emit = defineEmits<{ (e: 'close'): void; (e: 'saved'): void }>();

type Sec = { set: boolean; masked: string | null; editing: boolean; value: string; clear: boolean; shown: string };
const secret = (): Sec => ({ set: false, masked: null, editing: false, value: '', clear: false, shown: '' });
const loading = ref(true), busy = ref(false), error = ref(''), ok = ref('');
const user = ref<{ username: string; full_name: string } | null>(null);
const f = reactive<Record<string, string>>({});
const orig = ref<Record<string, string>>({});
const sec = reactive<{ nif: Sec; ss: Sec; iban: Sec }>({ nif: secret(), ss: secret(), iban: secret() });
const ibanInfo = ref<any>(null), ibanSaved = ref<any>(null);
const PLAIN = ['birth_date', 'nationality', 'phone', 'email', 'street', 'postal_code', 'city', 'province', 'country', 'hire_date', 'contract_type', 'job_category', 'emergency_name', 'emergency_phone', 'iban_holder', 'notes'];
const timers: Record<string, ReturnType<typeof setTimeout>> = {};

async function load(): Promise<void> {
  try {
    const r = await api<any>(`/users/${props.userId}/profile`);
    user.value = r.user; f.full_name = r.user.full_name; const o: Record<string, string> = { full_name: r.user.full_name };
    for (const k of PLAIN) { f[k] = r.profile[k] ?? ''; o[k] = f[k]; }
    if (!f.country) f.country = 'España';
    orig.value = o;
    for (const k of ['nif', 'ss', 'iban'] as const) Object.assign(sec[k], { set: r.profile[k].set, masked: r.profile[k].masked, editing: false, value: '', clear: false, shown: '' });
    ibanSaved.value = r.profile.iban;
  } catch (e) { error.value = messageFor(e); } finally { loading.value = false; }
}
onMounted(load);
onBeforeUnmount(() => Object.values(timers).forEach(clearTimeout));

async function reveal(k: 'nif' | 'ss' | 'iban'): Promise<void> {
  error.value = '';
  try { const r = await api<{ value: string; formatted?: string }>(`/users/${props.userId}/profile/reveal`, { method: 'POST', body: { field: k } }); sec[k].shown = r.formatted ?? r.value; clearTimeout(timers[k]); timers[k] = setTimeout(() => { sec[k].shown = ''; }, 15000); }
  catch (e) { error.value = messageFor(e); }
}
let deb: ReturnType<typeof setTimeout> | undefined;
watch(() => sec.iban.value, (v) => {
  clearTimeout(deb); ibanInfo.value = null;
  if (v.replace(/\s/g, '').length < 8) return;
  deb = setTimeout(async () => { try { ibanInfo.value = await api('/iban/check', { method: 'POST', body: { iban: v } }); } catch { ibanInfo.value = null; } }, 350);
});

const dirty = computed(() => Object.keys(orig.value).some((k) => f[k] !== orig.value[k]) || (['nif', 'ss', 'iban'] as const).some((k) => sec[k].value || sec[k].clear));
async function save(): Promise<void> {
  busy.value = true; error.value = ''; ok.value = '';
  const body: Record<string, unknown> = {};
  for (const k of Object.keys(orig.value)) if (f[k] !== orig.value[k]) body[k] = f[k] === '' ? null : f[k];
  if (body.full_name === null) delete body.full_name;
  for (const k of ['nif', 'ss', 'iban'] as const) { if (sec[k].value) body[k] = sec[k].value; else if (sec[k].clear) body[k] = null; }
  try { await api(`/users/${props.userId}/profile`, { method: 'PUT', body }); ok.value = 'Ficha guardada.'; await load(); emit('saved'); }
  catch (e) { error.value = messageFor(e); } finally { busy.value = false; }
}
const reasonText: Record<string, string> = { formato: 'formato incorrecto', longitud: 'longitud incorrecta para ese país', control: 'dígitos de control incorrectos', cuenta: 'dígitos de control de la cuenta incorrectos' };
</script>
<template>
  <Modal :title="`Ficha de ${user?.full_name ?? 'conductor'}`" wide @close="emit('close')">
    <p v-if="loading" class="muted">Cargando…</p>
    <form v-else class="stack ficha" @submit.prevent="save">
      <p v-if="error" class="alert alert-err">{{ error }}</p>
      <p v-if="ok" class="alert alert-ok">{{ ok }}</p>
      <p class="muted small">Solo se guardan los datos necesarios para la relación laboral. El DNI, la Seguridad Social y el IBAN se guardan cifrados y se ven enmascarados; al pulsar «Mostrar» queda anotado en la auditoría.</p>

      <fieldset><legend>Datos personales</legend>
        <div class="grid2"><label>Nombre completo<input v-model="f.full_name" required maxlength="100" :disabled="!canWrite" /></label>
          <div class="secret"><label>DNI / NIE</label>
            <template v-if="sec.nif.set && !sec.nif.editing"><span class="mono">{{ sec.nif.shown || sec.nif.masked }}</span>
              <button v-if="!sec.nif.shown" class="btn btn-sm" type="button" @click="reveal('nif')">Mostrar</button>
              <template v-if="canWrite"><button class="btn btn-sm" type="button" @click="sec.nif.editing = true">Cambiar</button><button class="btn btn-sm" type="button" @click="sec.nif.clear = !sec.nif.clear">{{ sec.nif.clear ? 'No borrar' : 'Borrar' }}</button></template>
              <span v-if="sec.nif.clear" class="small muted"> se borrará al guardar</span></template>
            <input v-else-if="canWrite" v-model="sec.nif.value" maxlength="12" autocomplete="off" placeholder="12345678Z" /></div></div>
        <div class="grid2"><label>Fecha de nacimiento<input v-model="f.birth_date" type="date" :disabled="!canWrite" /></label><label>Nacionalidad<input v-model="f.nationality" maxlength="120" :disabled="!canWrite" /></label></div>
        <div class="grid2"><label>Teléfono<input v-model="f.phone" maxlength="20" inputmode="tel" :disabled="!canWrite" /></label><label>Correo electrónico<input v-model="f.email" type="email" maxlength="120" :disabled="!canWrite" /></label></div>
      </fieldset>

      <fieldset><legend>Domicilio postal</legend>
        <label>Dirección (calle, número, piso)<input v-model="f.street" maxlength="120" :disabled="!canWrite" /></label>
        <div class="grid2"><label>Código postal<input v-model="f.postal_code" maxlength="10" inputmode="numeric" :disabled="!canWrite" /></label><label>Municipio<input v-model="f.city" maxlength="120" :disabled="!canWrite" /></label></div>
        <div class="grid2"><label>Provincia<input v-model="f.province" maxlength="120" :disabled="!canWrite" /></label><label>País<input v-model="f.country" maxlength="120" :disabled="!canWrite" /></label></div>
      </fieldset>

      <fieldset><legend>Datos laborales</legend>
        <div class="grid2"><label>Fecha de alta en la empresa<input v-model="f.hire_date" type="date" :disabled="!canWrite" /></label>
          <label>Tipo de contrato<select v-model="f.contract_type" :disabled="!canWrite"><option value="">—</option><option value="INDEFINIDO">Indefinido</option><option value="TEMPORAL">Temporal</option><option value="FIJO_DISCONTINUO">Fijo discontinuo</option><option value="AUTONOMO">Autónomo colaborador</option></select></label></div>
        <div class="grid2"><label>Categoría profesional<input v-model="f.job_category" maxlength="120" placeholder="Conductor de camión" :disabled="!canWrite" /></label>
          <div class="secret"><label>Nº de la Seguridad Social</label>
            <template v-if="sec.ss.set && !sec.ss.editing"><span class="mono">{{ sec.ss.shown || sec.ss.masked }}</span>
              <button v-if="!sec.ss.shown" class="btn btn-sm" type="button" @click="reveal('ss')">Mostrar</button>
              <template v-if="canWrite"><button class="btn btn-sm" type="button" @click="sec.ss.editing = true">Cambiar</button><button class="btn btn-sm" type="button" @click="sec.ss.clear = !sec.ss.clear">{{ sec.ss.clear ? 'No borrar' : 'Borrar' }}</button></template>
              <span v-if="sec.ss.clear" class="small muted"> se borrará al guardar</span></template>
            <input v-else-if="canWrite" v-model="sec.ss.value" maxlength="16" autocomplete="off" placeholder="12 dígitos" /></div></div>
      </fieldset>

      <fieldset><legend>Cuenta bancaria</legend>
        <div class="grid2"><label>Titular de la cuenta<input v-model="f.iban_holder" maxlength="120" :disabled="!canWrite" /></label>
          <div class="secret"><label>IBAN</label>
            <template v-if="sec.iban.set && !sec.iban.editing"><span class="mono">{{ sec.iban.shown || sec.iban.masked }}</span>
              <button v-if="!sec.iban.shown" class="btn btn-sm" type="button" @click="reveal('iban')">Mostrar</button>
              <template v-if="canWrite"><button class="btn btn-sm" type="button" @click="sec.iban.editing = true">Cambiar</button><button class="btn btn-sm" type="button" @click="sec.iban.clear = !sec.iban.clear">{{ sec.iban.clear ? 'No borrar' : 'Borrar' }}</button></template>
              <span v-if="sec.iban.clear" class="small muted"> se borrará al guardar</span>
              <div class="small"><b v-if="ibanSaved?.bank">{{ ibanSaved.bank }}</b><span v-else-if="ibanSaved?.bank_code"> Entidad {{ ibanSaved.bank_code }} (no figura en la tabla)</span><span v-if="ibanSaved?.country" class="muted"> · {{ ibanSaved.country }}</span></div></template>
            <template v-else-if="canWrite"><input v-model="sec.iban.value" maxlength="40" autocomplete="off" placeholder="ES00 0000 0000 00 0000000000" />
              <div v-if="ibanInfo" class="small"><template v-if="ibanInfo.valid"><b class="ok-text">✔ IBAN válido</b> · <b v-if="ibanInfo.bank">{{ ibanInfo.bank }}</b><span v-else-if="ibanInfo.bank_code">entidad {{ ibanInfo.bank_code }} (no figura en la tabla)</span> · {{ ibanInfo.country }}</template>
                <b v-else class="err-text">✘ IBAN no válido: {{ reasonText[ibanInfo.reason] ?? 'revísalo' }}</b></div></template></div></div>
      </fieldset>

      <fieldset><legend>Contacto de emergencia y notas</legend>
        <div class="grid2"><label>Persona de contacto<input v-model="f.emergency_name" maxlength="120" :disabled="!canWrite" /></label><label>Teléfono de contacto<input v-model="f.emergency_phone" maxlength="20" inputmode="tel" :disabled="!canWrite" /></label></div>
        <label>Notas internas<input v-model="f.notes" maxlength="500" :disabled="!canWrite" /></label>
      </fieldset>
      <p class="muted small">Los documentos con caducidad (carnet, CAP, tarjeta del conductor…) se anotan en «Documentos».</p>
      <button v-if="canWrite" class="btn btn-primary" :disabled="busy || !dirty">{{ busy ? 'Guardando…' : 'Guardar ficha' }}</button>
    </form>
  </Modal>
</template>
