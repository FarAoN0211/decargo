<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { ApiError, auth, homeFor, login } from '../api';
import { messageFor } from '../errors';

const router = useRouter();
const username = ref(''), password = ref(''), totp = ref('');
const needTotp = ref(false), busy = ref(false), error = ref(''), info = ref('');

async function submit(): Promise<void> {
  busy.value = true; error.value = ''; info.value = '';
  try {
    await login(username.value, password.value, needTotp.value ? totp.value : undefined);
    await router.replace(auth.mfaRequired ? '/activar/totp' : homeFor(auth.user?.role));
  } catch (e) {
    if (e instanceof ApiError && e.code === 'totp_required') { needTotp.value = true; info.value = messageFor(e); }
    else { error.value = messageFor(e); if (e instanceof ApiError && e.code === 'invalid_totp') totp.value = ''; }
  } finally { busy.value = false; }
}
</script>
<template>
  <main class="auth-page">
    <div class="auth-card">
      <img class="logo" src="/decargo-logo.png" alt="DECARGO" />
      <h1>Iniciar sesión</h1>
      <form @submit.prevent="submit">
        <label>Usuario<input v-model.trim="username" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" required autofocus /></label>
        <label>Contraseña<input v-model="password" type="password" autocomplete="current-password" required /></label>
        <label v-if="needTotp">Código de verificación<span class="hint"> (6 dígitos de tu aplicación autenticadora)</span>
          <input v-model.trim="totp" inputmode="numeric" autocomplete="one-time-code" maxlength="8" required />
        </label>
        <p v-if="info" class="alert alert-info">{{ info }}</p>
        <p v-if="error" class="alert alert-err">{{ error }}</p>
        <button class="btn btn-primary btn-block" :disabled="busy">{{ busy ? 'Entrando…' : 'Entrar' }}</button>
      </form>
      <p class="muted small">¿Primera vez? <RouterLink to="/activar">Activar mi cuenta con el código de la oficina</RouterLink></p>
    </div>
  </main>
</template>
