<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api, apiBlob, auth, loadMe, logout } from '../../api';
import { OFFLINE_DAYS, isNetworkError, offlineTransports, syncOffline } from '../../offline';
import { messageFor } from '../../errors';
import { fmtDate, kg } from '../../format';
import { enablePush, pushStateAndSync, type PushState } from '../../push';
import NativeAlerts from '../../components/NativeAlerts.vue';
import { isNativeApp } from '../../native';
const inApp = isNativeApp();
// Menú de ajustes (hamburguesa): avisos y salir. Se oculta con v-show para que los avisos de la app sigan registrándose aunque esté cerrado.
const menu = ref(false), nativeOk = ref(true);
const alertsOk = computed(() => (inApp ? nativeOk.value : pushState.value === 'active'));
const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') menu.value = false; };

const router = useRouter();
const route = useRoute();
const list = ref<any[]>([]), error = ref(''), loading = ref(true);
const pushState = ref<PushState>('off'), pushBusy = ref(false), pushError = ref('');
const current = computed(() => list.value[0] ?? null), next = computed(() => list.value[1] ?? null);
const pendingDevice = computed(() => auth.scope === 'LIMITED');
const firstName = computed(() => (auth.user?.full_name ?? '').split(' ')[0]);
const offlineAt = ref(0);   // > 0: sin cobertura, se muestra la copia guardada en el teléfono (hora de la última sincronización)
function show(rows: any[]): void {
  const target = typeof route.query.t === 'string' ? route.query.t : '';
  list.value = target ? [...rows].sort((a, b) => Number(b.id === target) - Number(a.id === target)) : rows;
}
async function load(): Promise<void> {
  try {
    const rows = await api<any[]>('/driver/transports');
    if (auth.cached) await loadMe().catch(() => undefined);   // vuelve la cobertura tras abrir sin ella: datos reales de la sesión
    show(rows); offlineAt.value = 0; error.value = '';
    const u = auth.user;
    if (u) void syncOffline({ id: u.id, username: u.username, full_name: u.full_name, role: 'conductor' }, rows, apiBlob).catch(() => undefined);
    // Deja en el teléfono las pantallas del DeCA y del QR y el lector de PDF, para poder abrirlas sin cobertura.
    void import('./DriverDeca.vue').catch(() => undefined); void import('./DriverQr.vue').catch(() => undefined);
    void import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url').then((m) => fetch(m.default)).catch(() => undefined);
  } catch (e) {
    const copy = isNetworkError(e) && auth.user ? await offlineTransports(auth.user.id) : null;
    if (copy) { show(copy.transports); offlineAt.value = copy.savedAt; error.value = ''; }
    else error.value = messageFor(e);
  } finally { loading.value = false; }
}
const savedText = computed(() => new Date(offlineAt.value).toLocaleString('es-ES', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }));
const onOnline = (): void => { void load(); };
async function syncPush(): Promise<void> {
  try { pushState.value = await pushStateAndSync(); } catch { pushState.value = 'off'; }
}
async function activatePush(): Promise<void> {
  pushBusy.value = true; pushError.value = '';
  try { pushState.value = await enablePush(); }
  catch { pushError.value = 'No se pudieron activar los avisos. Comprueba los permisos de notificación del navegador.'; }
  finally { pushBusy.value = false; }
}
const finishBusy = ref(false), finishMsg = ref('');
/**
 * Al pulsar FINALIZAR el conductor elige: el transporte COMPLETO (entregado: queda finalizado) o SOLO SU PARTE (lo continúa otro conductor:
 * le desaparece de la app y pasa al relevo, o vuelve a «pendiente» para que la oficina asigne otro). No se puede deshacer desde la app.
 */
const finishAsk = ref(false);
async function finish(part: boolean): Promise<void> {
  if (!current.value) return;
  finishAsk.value = false; finishBusy.value = true; error.value = ''; finishMsg.value = '';
  try {
    if (part) {
      const r = await api<{ next_driver: boolean }>(`/driver/transports/${current.value.id}/finish-part`, { method: 'POST' });
      finishMsg.value = r.next_driver ? 'Tu parte está terminada: el transporte pasa al siguiente conductor.' : 'Tu parte está terminada. La oficina asignará el siguiente conductor.';
    } else {
      await api(`/driver/transports/${current.value.id}/finish`, { method: 'POST' });
      finishMsg.value = 'Transporte finalizado. ¡Buen trabajo!';
    }
    cards.value = []; await load();
  } catch (e) { error.value = messageFor(e); } finally { finishBusy.value = false; }
}
// Tarjetas de combustible / VIA-T de los vehículos del transporte, con su PIN (cada consulta queda registrada; no se guardan en el teléfono).
const cards = ref<any[]>([]), cardsOpen = ref(false), cardsBusy = ref(false), cardsMsg = ref('');
async function showCards(): Promise<void> {
  if (!current.value) return;
  if (cardsOpen.value) { cardsOpen.value = false; cards.value = []; return; }
  cardsBusy.value = true; cardsMsg.value = '';
  try { cards.value = await api<any[]>(`/driver/transports/${current.value.id}/cards`); cardsOpen.value = true; if (!cards.value.length) cardsMsg.value = 'Los vehículos de este transporte no tienen tarjetas registradas.'; }
  catch (e) { cardsMsg.value = messageFor(e); } finally { cardsBusy.value = false; }
}
async function out(): Promise<void> { await logout(); await router.replace('/login'); }
const go = (path: string): void => { void router.push({ path, query: { t: current.value.id } }); };
onMounted(() => { void load(); if (!inApp) void syncPush(); window.addEventListener('keydown', onKey); window.addEventListener('online', onOnline); });
onBeforeUnmount(() => { window.removeEventListener('keydown', onKey); window.removeEventListener('online', onOnline); });
watch(() => route.query.t, () => { void load(); });   // al pulsar «Ver transporte» en el aviso interno
</script>
<template>
  <div class="d-page">
    <header class="d-top"><img src="/decargo-logo.png" alt="DECARGO" />
      <button class="d-burger" type="button" :aria-expanded="menu" aria-controls="d-menu" :aria-label="alertsOk ? 'Ajustes' : 'Ajustes (los avisos no están activados)'" @click="menu = !menu">
        <span class="bars" aria-hidden="true"></span><span v-if="!alertsOk" class="dot" aria-hidden="true"></span>
      </button>
    </header>
    <div v-show="menu" class="d-menu-back" @click.self="menu = false">
      <nav id="d-menu" class="d-menu" aria-label="Ajustes">
        <div class="d-menu-head"><b>Ajustes</b><button class="btn btn-sm" type="button" aria-label="Cerrar" @click="menu = false">✕</button></div>
        <p class="small muted">{{ auth.user?.full_name }}</p>
        <h3>Avisos de transportes</h3>
        <NativeAlerts v-if="inApp" @status="nativeOk = $event" />
        <div v-else-if="pushState !== 'active'" class="alert alert-info">
          <template v-if="pushState === 'unsupported'">Este navegador no admite avisos en segundo plano.</template>
          <template v-else-if="pushState === 'blocked'">Los avisos están bloqueados. Permite las notificaciones de DECARGO en los ajustes del navegador.</template>
          <template v-else>Activa los avisos para enterarte cuando te asignen un transporte.</template>
          <button v-if="pushState === 'off'" class="btn btn-primary btn-sm" type="button" :disabled="pushBusy" @click="activatePush">
            {{ pushBusy ? 'Activando…' : 'Activar avisos' }}
          </button>
        </div>
        <div v-else class="alert alert-ok stack">
          <p>Avisos de nuevos transportes activados.</p>
          <p class="small muted">La oficina puede enviarte un aviso de prueba. Para que encienda la pantalla: Ajustes del teléfono → Aplicaciones → DECARGO (o Chrome) → Notificaciones → prioridad «Urgente» / «Emergente».</p>
        </div>
        <p v-if="pushError" class="alert alert-err">{{ pushError }}</p>
        <button class="btn d-menu-out" type="button" @click="out">Salir</button>
      </nav>
    </div>
    <div class="d-wrap">
      <p class="d-hello">Hola, <b>{{ firstName }}</b></p>
      <p v-if="offlineAt" class="alert alert-warn">Sin cobertura: ves la copia guardada en este teléfono ({{ savedText }}). El DeCA y el QR se pueden enseñar igual. Se borra sola a los {{ OFFLINE_DAYS }} días o al finalizar el transporte.</p>
      <p v-if="pendingDevice" class="alert alert-warn">Este teléfono está pendiente de confirmación por la oficina. Puedes ver tus transportes y mostrar el DeCA y el QR.</p>
      <p v-if="error" class="alert alert-err">{{ error }}</p>
      <p v-if="loading" class="muted">Cargando…</p>

      <p v-else-if="!current" class="d-card">No tienes transportes asignados.</p>
      <section v-else class="d-card" aria-label="Transporte actual">
        <div class="d-label">Transporte actual</div>
        <div class="d-route"><span class="pt">{{ current.origin }}</span><span class="arrow">↓</span><span class="pt">{{ current.destination }}</span></div>
        <div v-for="(grp, gi) in [{ t: 'Carga', l: current.origins }, { t: 'Descarga', l: current.destinations }]" :key="gi">
          <template v-for="(s, i) in grp.l" :key="i">
            <a v-if="s.maps_url" class="btn btn-accent d-way" :href="s.maps_url" target="_blank" rel="noopener noreferrer">Cómo llegar · {{ grp.t }}{{ grp.l.length > 1 ? ' ' + (i + 1) : '' }}{{ s.party ? ' · ' + s.party : '' }}</a>
            <p v-if="s.pallets !== null && s.pallets !== undefined" class="small"><b>{{ grp.t }}{{ grp.l.length > 1 ? ' ' + (i + 1) : '' }}{{ s.party ? ' · ' + s.party : '' }}: {{ s.pallets }} {{ s.pallets === 1 ? 'palet' : 'palets' }}</b></p>
            <p v-if="s.references?.length || s.seals?.length" class="small"><template v-if="s.references?.length">{{ s.references.length > 1 ? 'Referencias' : 'Referencia' }}: <b>{{ s.references.join(', ') }}</b></template><template v-if="s.references?.length && s.seals?.length"> · </template><template v-if="s.seals?.length">{{ s.seals.length > 1 ? 'Precintos' : 'Precinto' }}: <b>{{ s.seals.join(', ') }}</b></template></p>
            <p v-if="s.notes" class="small muted">{{ grp.t }}{{ s.label ? ' · ' + s.label : '' }}: {{ s.notes }}</p>
          </template>
        </div>
        <div class="d-facts">
          <div><span>Mercancía</span><b>{{ current.cargo }}</b></div>
          <div><span>Peso</span><b>{{ current.weight_kg ? kg(current.weight_kg) : current.alt_magnitude }}</b></div>
          <div><span>Fecha</span><b>{{ fmtDate(current.transport_date) }}</b></div>
          <div><span>Tractora</span><b class="mono">{{ current.vehicles?.tractor ?? 'Sin asignar' }}</b></div>
          <div v-if="current.vehicles?.trailer"><span>Remolque</span><b class="mono">{{ current.vehicles.trailer }}</b></div>
        </div>
        <template v-if="current.deca">
          <button class="d-btn d-btn-main" type="button" @click="go('/conductor/deca')">VER DeCA</button>
          <button class="d-btn d-btn-qr" type="button" @click="go('/conductor/qr')">MOSTRAR QR</button>
        </template>
        <p v-else class="alert alert-warn">Este transporte todavía no tiene DeCA. Avisa a la oficina.</p>
        <button v-if="current.vehicles" class="d-btn d-btn-card" type="button" :disabled="pendingDevice || cardsBusy || !!offlineAt" @click="showCards">{{ cardsOpen ? 'OCULTAR TARJETAS' : cardsBusy ? 'CARGANDO…' : 'TARJETA DE COMBUSTIBLE · PIN' }}</button>
        <div v-if="cardsOpen && cards.length" class="d-cards">
          <div v-for="c in cards" :key="c.id" class="d-cardpin">
            <div class="small muted">{{ c.kind === 'FUEL_CARD' ? 'Tarjeta de combustible' : 'VIA-T' }}{{ c.provider ? ' · ' + c.provider : '' }} · {{ c.plate }}</div>
            <div class="mono">{{ c.identifier }}</div>
            <div v-if="c.pin" class="pin">PIN <b class="mono">{{ c.pin }}</b></div>
            <div v-if="c.expires_on" class="small muted">Caduca: {{ fmtDate(c.expires_on) }}</div>
          </div>
        </div>
        <p v-if="cardsMsg" class="small muted">{{ cardsMsg }}</p>
        <p v-if="current.relay" class="d-note">Relevo: al terminar tu parte, el transporte pasa a <b>{{ current.relay }}</b>.</p>
        <button class="d-btn d-btn-end" type="button" :disabled="pendingDevice || finishBusy || !!offlineAt" @click="finishAsk = true">{{ finishBusy ? 'FINALIZANDO…' : 'FINALIZAR' }}</button>
        <div v-if="finishAsk" class="d-menu-back" @click.self="finishAsk = false">
          <div class="d-ask" role="dialog" aria-label="¿Qué has terminado?">
            <h3>¿Qué has terminado?</h3>
            <button class="d-btn d-btn-end" type="button" @click="finish(false)">EL TRANSPORTE COMPLETO<span class="sub">Entregado en destino: queda finalizado</span></button>
            <button class="d-btn d-btn-main" type="button" @click="finish(true)">SOLO MI PARTE<span class="sub">{{ current.relay ? `Lo continúa ${current.relay}` : 'Lo continúa otro conductor' }}</span></button>
            <button class="btn" type="button" @click="finishAsk = false">Cancelar</button>
          </div>
        </div>
        <p v-if="pendingDevice" class="d-note">Este teléfono aún no está autorizado por la oficina: de momento solo puedes consultar el transporte.</p>
        <p v-if="finishMsg" class="alert alert-ok">{{ finishMsg }}</p>
      </section>

      <section v-if="next" class="d-next" aria-label="Siguiente transporte">
        <div class="d-label">Siguiente transporte</div>
        <div class="pt">{{ next.origin }} → {{ next.destination }}</div>
        <div class="muted small">{{ fmtDate(next.transport_date) }} · {{ next.cargo }}</div>
      </section>
    </div>
  </div>
</template>
