<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { api } from '../api';
import { messageFor } from '../errors';
import { native, nativeState, type NativeState } from '../native';

/** Avisos en la app Android: lista de permisos con su botón y registro del token del teléfono en el servidor. */
const st = ref<NativeState | null>(nativeState());
const sent = ref(''), error = ref(''), open = ref(false);
const registered = computed(() => !!st.value?.token && sent.value === st.value.token);
// En Xiaomi también hacen falta sus dos permisos propios (si MIUI no deja saber su estado, no se bloquea: se pide comprobarlo).
const xiaomiOk = computed(() => !st.value?.xiaomi || (st.value.lockscreen !== false && st.value.bgstart !== false));
const required = computed(() => !!st.value && st.value.notifications === 'granted' && st.value.fullscreen && xiaomiOk.value && registered.value);
const emit = defineEmits<{ (e: 'status', ok: boolean): void }>();
const allOk = computed(() => required.value && !!st.value?.overlay && !!st.value?.battery);

watch(required, (v) => emit('status', v), { immediate: true });   // el menú marca con un punto rojo si faltan permisos
async function update(): Promise<void> {
  st.value = nativeState();
  const s = st.value;
  if (!s || s.notifications !== 'granted' || !s.token || sent.value === s.token) return;
  try { await api('/driver/push/fcm', { method: 'POST', body: { token: s.token } }); sent.value = s.token; error.value = ''; }
  catch (e) { error.value = messageFor(e); }
}
const mark = (v: boolean | null | undefined): string => (v === true ? 'ok' : v === false ? 'no' : 'opt');
const sym = (v: boolean | null | undefined): string => (v === true ? '✔' : v === false ? '✘' : '•');
const onEv = (): void => { void update(); };
const onVis = (): void => { if (document.visibilityState === 'visible') void update(); };
onMounted(() => { window.addEventListener('decargo-native', onEv); document.addEventListener('visibilitychange', onVis); void update(); });
onBeforeUnmount(() => { window.removeEventListener('decargo-native', onEv); document.removeEventListener('visibilitychange', onVis); });
</script>
<template>
  <div v-if="st" :class="['alert', required ? 'alert-ok' : 'alert-info', 'stack']">
    <p v-if="required"><b>Avisos activados en este teléfono.</b> Con la pantalla apagada, se encenderá y verás el aviso.
      <button v-if="!open" class="btn btn-sm" type="button" @click="open = true">{{ allOk ? 'Revisar permisos' : 'Mejorar avisos' }}</button></p>
    <p v-else><b>Activa los avisos</b> para que el teléfono se encienda cuando te asignen un transporte.</p>
    <ul v-if="!required || open" class="nat-list">
      <li><span :class="st.notifications === 'granted' ? 'ok' : 'no'">{{ st.notifications === 'granted' ? '✔' : '✘' }}</span> Notificaciones
        <button v-if="st.notifications !== 'granted'" class="btn btn-primary btn-sm" type="button" @click="st.notifications === 'denied' ? native.openAppSettings() : native.requestNotifications()">{{ st.notifications === 'denied' ? 'Abrir ajustes' : 'Permitir' }}</button></li>
      <li><span :class="st.fullscreen ? 'ok' : 'no'">{{ st.fullscreen ? '✔' : '✘' }}</span> Encender la pantalla con el aviso
        <button v-if="!st.fullscreen" class="btn btn-primary btn-sm" type="button" @click="native.openFullScreenSettings()">Permitir</button></li>
      <template v-if="st.xiaomi">
        <li><span :class="mark(st.lockscreen)">{{ sym(st.lockscreen) }}</span> Mostrar en la pantalla de bloqueo <span v-if="st.lockscreen === null" class="muted small">(compruébalo)</span>
          <button v-if="st.lockscreen !== true" class="btn btn-primary btn-sm" type="button" @click="native.openXiaomiPermissions()">Abrir permisos</button></li>
        <li><span :class="mark(st.bgstart)">{{ sym(st.bgstart) }}</span> Abrir nuevas ventanas mientras se ejecuta en segundo plano <span v-if="st.bgstart === null" class="muted small">(compruébalo)</span>
          <button v-if="st.bgstart !== true" class="btn btn-primary btn-sm" type="button" @click="native.openXiaomiPermissions()">Abrir permisos</button></li>
        <li v-if="st.lockscreen !== true || st.bgstart !== true" class="muted small">En «Otros permisos» de DECARGO, marca «Permitir» en las dos opciones y vuelve a la app.</li>
        <li><span class="opt">•</span> Inicio automático <span class="muted small">(recomendado en Xiaomi)</span>
          <button class="btn btn-sm" type="button" @click="native.openXiaomiAutostart()">Abrir</button></li>
      </template>
      <li><span :class="st.overlay ? 'ok' : 'opt'">{{ st.overlay ? '✔' : '•' }}</span> Mostrar el aviso aunque estés usando otra app <span class="muted small">(recomendado)</span>
        <button v-if="!st.overlay" class="btn btn-sm" type="button" @click="native.openOverlaySettings()">Permitir</button></li>
      <li><span :class="st.battery ? 'ok' : 'opt'">{{ st.battery ? '✔' : '•' }}</span> Sin restricciones de batería <span class="muted small">(recomendado)</span>
        <button v-if="!st.battery" class="btn btn-sm" type="button" @click="native.requestBattery()">Permitir</button></li>
      <li><span :class="registered ? 'ok' : 'no'">{{ registered ? '✔' : '✘' }}</span> Conexión con el servidor de avisos
        <span v-if="st.firebase === 'no_config'" class="muted small">— la empresa aún no ha configurado los avisos de la app (Configuración → App Android).</span>
        <span v-else-if="st.firebase === 'error'" class="muted small">— no se pudo conectar. <button class="btn btn-sm" type="button" @click="native.refresh()">Reintentar</button></span>
        <span v-else-if="!st.token" class="muted small">— conectando…</span></li>
    </ul>
    <p v-if="error" class="small">{{ error }}</p>
    <p class="small muted">App DECARGO {{ st.version }}. La oficina puede enviarte un aviso de prueba para comprobarlo.</p>
  </div>
</template>
<style scoped>
.nat-list { list-style: none; padding: 0; margin: .3rem 0; display: grid; gap: .45rem; }
.nat-list li { display: flex; flex-wrap: wrap; align-items: center; gap: .45rem; }
.ok { color: #1d7a2a; font-weight: 700; } .no { color: #b3261e; font-weight: 700; } .opt { color: #8a6d00; font-weight: 700; }
</style>
