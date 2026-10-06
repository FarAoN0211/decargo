<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import Modal from '../../components/Modal.vue';
import { api, auth } from '../../api';
import { messageFor } from '../../errors';
import DocsPanel from '../../components/DocsPanel.vue';
import ProfileForm from '../../components/ProfileForm.vue';
import { useRoute } from 'vue-router';
import { DEVICE, fmtDateTime } from '../../format';
import QRCode from 'qrcode';

const rows = ref<any[]>([]), error = ref(''), ok = ref(''), busy = ref(''), loading = ref(true);
const canWrite = computed(() => auth.user?.role === 'admin' || auth.user?.role === 'oficina');
const creating = ref(false), form = reactive({ username: '', full_name: '' });
const code = ref<null | { who: string; code: string; expires: string; qr: string; https: boolean }>(null);
/** Código de activación + QR con el enlace de activación (usuario y código en el «#»: no viajan al servidor). */
async function showCode(who: string, r: any): Promise<void> {
  const url: string | null = r.activation_url ?? null;
  const qr = url ? await QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'M', margin: 2 }) : '';
  code.value = { who, code: r.activation_code, expires: r.activation_expires_at, qr, https: !!url?.startsWith('https://') };
}
const open = ref<string>(''), devices = ref<any[]>([]);
const route = useRoute();
const profileFor = ref<string>('');
const docsOpen = ref<string>(String(route.query.abrir ?? ''));
const exp = ref<Record<string, { expired: number; soon: number }>>({});
async function loadExpiries(): Promise<void> {
  try { const m: Record<string, { expired: number; soon: number }> = {}; for (const e of await api<any[]>('/expiries')) { if (!e.user_id) continue; const x = (m[e.user_id] ??= { expired: 0, soon: 0 }); if (e.status === 'CADUCADO') x.expired++; else x.soon++; } exp.value = m; } catch { /* sin alertas */ }
}
interface PushTest { device_info?: Record<string, any> | null; device: string; test_id: string; created_at: string; sent_at: string | null; send_error: string | null; received_at: string | null; shown_at: string | null; clicked_at: string | null; waiting: boolean; failed: string }
const tests = ref<Record<string, PushTest>>({});
let poll: ReturnType<typeof setInterval> | undefined;
async function testPush(d: any): Promise<void> {
  error.value = ''; ok.value = '';
  try {
    const r = await api<{ test_id: string }>(`/devices/${d.id}/push-test`, { method: 'POST' });
    tests.value[d.id] = { device: d.id, test_id: r.test_id, created_at: new Date().toISOString(), sent_at: null, send_error: null, received_at: null, shown_at: null, clicked_at: null, waiting: true, failed: '' };
    if (poll) clearInterval(poll);
    let n = 0;
    poll = setInterval(async () => {
      n++;
      const t = tests.value[d.id];
      if (!t) return;
      try { Object.assign(t, await api<Partial<PushTest>>(`/push-test/${r.test_id}`)); } catch { /* se reintenta */ }
      if (t.shown_at || n >= 15) { t.waiting = false; if (poll) clearInterval(poll); }
    }, 2000);
  } catch (e) {
    const c = (e as { code?: string }).code;
    error.value = c === 'sin_suscripcion' ? 'Este dispositivo no ha activado los avisos: el conductor debe abrir la aplicación y pulsar «Activar avisos».'
      : c === 'suscripcion_caducada' ? 'La suscripción de este teléfono ha caducado: el conductor debe abrir la aplicación y pulsar «Activar avisos» otra vez.'
      : c === 'dispositivo_no_autorizado' ? 'Solo se pueden probar avisos en dispositivos autorizados.'
      : c === 'push_fallido' ? 'El servicio de avisos de Google no ha aceptado el envío. Inténtalo en un minuto.' : messageFor(e);
    await showDevices(open.value, true);
  }
}
onBeforeUnmount(() => { if (poll) clearInterval(poll); });

async function load(): Promise<void> {
  try { rows.value = (await api<any[]>('/users')).filter((u) => u.role === 'conductor'); } catch (e) { error.value = messageFor(e); } finally { loading.value = false; }
}
async function act(key: string, fn: () => Promise<unknown>, done = ''): Promise<void> {
  busy.value = key; error.value = ''; ok.value = '';
  try { await fn(); if (done) ok.value = done; await load(); if (open.value) await showDevices(open.value, true); } catch (e) { error.value = messageFor(e); } finally { busy.value = ''; }
}
async function create(): Promise<void> {
  busy.value = 'new'; error.value = '';
  try {
    const r = await api<any>('/users', { method: 'POST', body: { username: form.username, full_name: form.full_name, role: 'conductor' } });
    await showCode(form.full_name, r);
    creating.value = false; form.username = ''; form.full_name = ''; await load();
  } catch (e) { error.value = messageFor(e); } finally { busy.value = ''; }
}
async function reissue(u: any): Promise<void> {
  busy.value = `c-${u.id}`; error.value = '';
  try { const r = await api<any>(`/users/${u.id}/activation`, { method: 'POST' }); await showCode(u.full_name, r); } catch (e) { error.value = messageFor(e); } finally { busy.value = ''; }
}
async function showDevices(id: string, keep = false): Promise<void> {
  if (!keep && open.value === id) { open.value = ''; return; }
  open.value = id;
  try { devices.value = await api(`/devices?user_id=${id}`); } catch (e) { error.value = messageFor(e); }
}
const state = (u: any): { t: string; c: string } => !u.active ? { t: 'Inactivo', c: 'b-off' } : u.pending_activation ? { t: 'Pendiente de activar', c: 'b-pend' } : { t: 'Activo', c: 'b-fin' };
onMounted(() => { void load(); void loadExpiries(); });
</script>
<template>
  <div class="page-title"><h1>Conductores</h1><button v-if="canWrite" class="btn btn-accent" @click="creating = true">Nuevo conductor</button></div>
  <p v-if="error" class="alert alert-err">{{ error }}</p>
  <p v-if="ok" class="alert alert-ok">{{ ok }}</p>
  <p v-if="loading" class="muted">Cargando…</p>
  <p v-else-if="!rows.length" class="muted">Todavía no hay conductores.</p>
  <div v-else class="table-wrap">
    <table>
      <thead><tr><th>Conductor</th><th>Usuario</th><th>Estado</th><th>Dispositivos pendientes</th><th></th></tr></thead>
      <tbody>
        <template v-for="u in rows" :key="u.id">
          <tr>
            <td>{{ u.full_name }}<span v-if="exp[u.id]?.expired" class="badge b-bad exp-badge">{{ exp[u.id].expired }} caducado{{ exp[u.id].expired > 1 ? 's' : '' }}</span><span v-if="exp[u.id]?.soon" class="badge b-pend exp-badge">{{ exp[u.id].soon }} por caducar</span></td><td class="mono">{{ u.username }}</td>
            <td><span :class="['badge', state(u).c]">{{ state(u).t }}</span></td>
            <td>{{ u.pending_devices || '—' }}</td>
            <td class="right nowrap">
              <button class="btn btn-sm" @click="profileFor = u.id">Ficha</button>
              <button class="btn btn-sm" @click="docsOpen = docsOpen === u.id ? '' : u.id">Documentos</button>
              <button class="btn btn-sm" @click="showDevices(u.id)">Dispositivos</button>
              <template v-if="canWrite">
                <button v-if="u.pending_activation && u.active" class="btn btn-sm" :disabled="busy === `c-${u.id}`" @click="reissue(u)">Nuevo código</button>
                <button v-if="u.active" class="btn btn-sm btn-danger" :disabled="busy === u.id" @click="act(u.id, () => api(`/users/${u.id}/deactivate`, { method: 'POST' }), 'Conductor desactivado: pierde el acceso al instante.')">Desactivar</button>
                <button v-else class="btn btn-sm btn-primary" :disabled="busy === u.id" @click="act(u.id, () => api(`/users/${u.id}/reactivate`, { method: 'POST' }), 'Conductor activado.')">Activar</button>
              </template>
            </td>
          </tr>
          <tr v-if="docsOpen === u.id"><td colspan="5"><DocsPanel subject="DRIVER" :subject-id="u.id" :can-write="canWrite" @changed="loadExpiries" /></td></tr>
          <tr v-if="open === u.id"><td colspan="5">
            <p v-if="!devices.length" class="muted small">Este conductor no tiene dispositivos registrados.</p>
            <table v-else>
              <thead><tr><th>Dispositivo</th><th>Estado</th><th>Avisos</th><th>Registrado</th><th>Último acceso</th><th></th></tr></thead>
              <tbody><tr v-for="d in devices" :key="d.id">
                <td>{{ d.label ?? 'Sin nombre' }}</td>
                <td><span :class="['badge', d.status === 'AUTORIZADO' ? 'b-fin' : d.status === 'REVOCADO' ? 'b-bad' : 'b-pend']">{{ DEVICE[d.status] }}</span></td>
                <td><span :class="['badge', d.push_subscribed ? 'b-fin' : 'b-off']">{{ d.push_subscribed ? 'Activados' : 'Sin activar' }}</span></td>
                <td>{{ fmtDateTime(d.registered_at) }}</td><td>{{ fmtDateTime(d.last_seen) }}</td>
                <td v-if="canWrite" class="right nowrap">
                  <button v-if="d.status === 'AUTORIZADO'" class="btn btn-sm" :disabled="tests[d.id]?.waiting" @click="testPush(d)">Probar aviso</button>
                  <button v-if="d.status === 'PENDIENTE_DE_CONFIRMACION'" class="btn btn-sm btn-primary" :disabled="busy === d.id" @click="act(d.id, () => api(`/devices/${d.id}/authorize`, { method: 'POST' }), 'Dispositivo autorizado.')">Autorizar</button>
                  <button v-if="d.status !== 'REVOCADO'" class="btn btn-sm btn-danger" :disabled="busy === d.id" @click="act(d.id, () => api(`/devices/${d.id}/revoke`, { method: 'POST' }), 'Dispositivo revocado: sus sesiones dejan de funcionar.')">Revocar</button>
                </td>
              </tr></tbody>
            </table>
            <template v-for="d in devices" :key="'t' + d.id">
              <div v-if="tests[d.id]" class="alert alert-info stack">
                <b>Prueba de aviso · {{ d.label ?? 'dispositivo' }}</b>
                <ul class="plain">
                  <li><b>{{ tests[d.id].sent_at ? '✔' : tests[d.id].send_error ? '✘' : '…' }}</b> Enviado al servicio de avisos de Google</li>
                  <li><b>{{ tests[d.id].received_at ? '✔' : tests[d.id].waiting ? '…' : '✘' }}</b> Recibido por el teléfono</li>
                  <li><b>{{ tests[d.id].shown_at ? '✔' : tests[d.id].waiting ? '…' : '✘' }}</b> Mostrado en pantalla</li>
                  <li><b>{{ tests[d.id].clicked_at ? '✔' : '·' }}</b> Pulsado por el conductor <span class="muted small">(opcional)</span></li>
                </ul>
                <p v-if="tests[d.id].device_info" class="small muted">Teléfono: {{ [tests[d.id].device_info?.model, tests[d.id].device_info?.os, tests[d.id].device_info?.browser].filter(Boolean).join(' · ') || tests[d.id].device_info?.ua }} · permiso: <b>{{ tests[d.id].device_info?.perm }}</b> · aviso en la bandeja: <b>{{ tests[d.id].device_info?.active === undefined ? 'n/d' : tests[d.id].device_info?.active > 0 ? 'sí' : 'no' }}</b></p>
                <p v-if="!tests[d.id].waiting && tests[d.id].shown_at" class="small">El aviso llegó y se mostró. Si no se encendió la pantalla, el conductor debe poner la prioridad de las notificaciones de DECARGO en «Urgente / Emergente».</p>
                <p v-else-if="!tests[d.id].waiting && tests[d.id].received_at" class="small">El teléfono recibió el aviso pero no llegó a mostrarlo: revisa que las notificaciones de DECARGO / Chrome estén permitidas en los ajustes del teléfono.</p>
                <p v-else-if="!tests[d.id].waiting" class="small">Google aceptó el aviso pero el teléfono no lo ha recibido en 30 s. Causas habituales: el teléfono sin datos, ahorro de batería que restringe Chrome / DECARGO, o la aplicación instalada con una versión antigua (ábrela una vez para que se actualice y repite la prueba).</p>
                <p v-else class="small muted">Esperando al teléfono…</p>
              </div>
            </template>
          </td></tr>
        </template>
      </tbody>
    </table>
  </div>

  <ProfileForm v-if="profileFor" :user-id="profileFor" :can-write="canWrite" @close="profileFor = ''" @saved="load" />
  <Modal v-if="creating" title="Nuevo conductor" @close="creating = false">
    <form @submit.prevent="create">
      <label>Nombre completo<input v-model="form.full_name" required maxlength="100" /></label>
      <label>Usuario<span class="hint"> (3 a 40 caracteres: letras minúsculas, números, punto, guion)</span><input v-model.trim="form.username" required maxlength="40" autocapitalize="none" spellcheck="false" /></label>
      <p class="muted small">Al crearlo se genera un código de activación de un solo uso para entregárselo al conductor. La contraseña la elige él.</p>
      <button class="btn btn-primary" :disabled="busy === 'new'">Crear conductor</button>
    </form>
  </Modal>
  <Modal v-if="code" :title="`Código de activación de ${code.who}`" @close="code = null">
    <div class="stack">
      <div class="code-box">{{ code.code }}</div>
      <div v-if="code.qr" class="act-qr">
        <div class="act-qr-img" v-html="code.qr"></div>
        <p class="small">El conductor puede <b>escanear este QR</b> con la app DECARGO («Escanear QR de activación») o con la cámara del móvil: entra con su usuario y el código ya puestos, elige su contraseña y ese móvil queda activado.</p>
      </div>
      <p v-if="code.qr && !code.https" class="small muted">La app Android solo usa direcciones https: pon la dirección pública en Configuración para que el QR sirva en la app. Con la cámara funciona en la red local.</p>
      <p class="alert alert-warn">Se muestra <b>una sola vez</b>: anótalo ahora. Caduca el {{ fmtDateTime(code.expires) }} y solo sirve una vez. El QR contiene el código: no lo compartas.</p>
      <p class="small muted">También puede entrar en esta misma dirección, elegir «Activar mi cuenta» e introducir su usuario y este código.</p>
    </div>
  </Modal>
</template>
