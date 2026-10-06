<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { auth, forgetSession, homeFor, retryRestore } from '../api';

const router = useRouter();
const busy = ref(false);
let timer: ReturnType<typeof setInterval> | undefined;

async function retry(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  try {
    if (await retryRestore() && auth.user) await router.replace(homeFor(auth.user.role));
    else if (!auth.offline) await router.replace('/login');
  } finally { busy.value = false; }
}
function again(): void { forgetSession(); void router.replace('/login'); }
onMounted(() => { timer = setInterval(() => { void retry(); }, 6000); window.addEventListener('online', retry); });
onBeforeUnmount(() => { if (timer) clearInterval(timer); window.removeEventListener('online', retry); });
</script>
<template>
  <main class="auth-page">
    <div class="auth-card stack">
      <img class="logo" src="/decargo-logo.png" alt="DECARGO" />
      <h1>Sin conexión</h1>
      <p>No hay conexión con el servidor. Tu sesión sigue guardada: en cuanto vuelva la red, entrarás automáticamente.</p>
      <button class="btn btn-primary" type="button" :disabled="busy" @click="retry">{{ busy ? 'Comprobando…' : 'Reintentar ahora' }}</button>
      <button class="btn btn-sm" type="button" @click="again">Entrar con otro usuario</button>
    </div>
  </main>
</template>
