<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api, auth, homeFor, loadMe, logout } from '../api';
import { messageFor } from '../errors';

const router = useRouter();
const qrUrl = ref(''), secret = ref(''), code = ref(''), busy = ref(false), error = ref(''), loading = ref(true);

onMounted(async () => {
  try {
    const r = await api<{ secret: string; qr_svg: string }>('/auth/totp/setup', { method: 'POST' });
    secret.value = r.secret;
    qrUrl.value = URL.createObjectURL(new Blob([r.qr_svg], { type: 'image/svg+xml' }));   // se muestra como imagen: un SVG en <img> no ejecuta nada
  } catch (e) { error.value = messageFor(e); } finally { loading.value = false; }
});
onUnmounted(() => { if (qrUrl.value) URL.revokeObjectURL(qrUrl.value); });

async function enable(): Promise<void> {
  busy.value = true; error.value = '';
  try {
    await api('/auth/totp/enable', { method: 'POST', body: { code: code.value } });
    await loadMe();
    await router.replace(homeFor(auth.user?.role));
  } catch (e) { error.value = messageFor(e); code.value = ''; } finally { busy.value = false; }
}
async function cancel(): Promise<void> { await logout(); await router.replace('/login'); }
</script>
<template>
  <main class="auth-page">
    <div class="auth-card">
      <img class="logo" src="/decargo-logo.png" alt="DECARGO" />
      <h1>Verificación en dos pasos</h1>
      <p class="muted small">Para usar la oficina hace falta una aplicación autenticadora (Google Authenticator, Microsoft Authenticator, Aegis, 2FAS…). Escanea este código y escribe el número que te muestre.</p>
      <p v-if="loading" class="muted">Preparando…</p>
      <template v-else-if="qrUrl">
        <img class="qr-setup" :src="qrUrl" alt="Código QR para la aplicación autenticadora" />
        <p class="small muted">¿No puedes escanear? Introduce esta clave a mano (tipo «basado en tiempo»):<br /><span class="mono">{{ secret }}</span></p>
        <form @submit.prevent="enable">
          <label>Código de 6 dígitos<input v-model.trim="code" inputmode="numeric" autocomplete="one-time-code" maxlength="8" required autofocus /></label>
          <p v-if="error" class="alert alert-err">{{ error }}</p>
          <button class="btn btn-primary btn-block" :disabled="busy">{{ busy ? 'Comprobando…' : 'Activar verificación' }}</button>
        </form>
      </template>
      <p v-else class="alert alert-err">{{ error }}</p>
      <p class="muted small"><a href="#" @click.prevent="cancel">Cancelar y salir</a></p>
    </div>
  </main>
</template>
