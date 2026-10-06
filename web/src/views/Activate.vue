<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { activate, ApiError, auth, homeFor } from '../api';
import { messageFor } from '../errors';

const router = useRouter();
const username = ref(''), code = ref(''), password = ref(''), password2 = ref(''), totp = ref('');
const needTotp = ref(false), busy = ref(false), error = ref('');

async function submit(): Promise<void> {
  error.value = '';
  if (password.value !== password2.value) { error.value = 'Las contraseñas no coinciden.'; return; }
  busy.value = true;
  try {
    await activate(username.value, code.value, password.value, needTotp.value ? totp.value : undefined);
    await router.replace(auth.mfaRequired ? '/activar/totp' : homeFor(auth.user?.role));
  } catch (e) {
    if (e instanceof ApiError && e.code === 'totp_required') { needTotp.value = true; error.value = messageFor(e); }
    else error.value = messageFor(e);
  } finally { busy.value = false; }
}
</script>
<template>
  <main class="auth-page">
    <div class="auth-card">
      <img class="logo" src="/decargo-logo.png" alt="DECARGO" />
      <h1>Activar mi cuenta</h1>
      <p class="muted small">Usa el código de activación que te ha dado la oficina (es de un solo uso) y elige tu contraseña.</p>
      <form @submit.prevent="submit">
        <label>Usuario<input v-model.trim="username" autocomplete="username" autocapitalize="none" spellcheck="false" required /></label>
        <label>Código de activación<input v-model.trim="code" class="mono" autocapitalize="characters" spellcheck="false" placeholder="XXXX-XXXX-XXXX-XXXX" required /></label>
        <label>Nueva contraseña<span class="hint"> (mínimo 10 caracteres; evita las contraseñas comunes)</span><input v-model="password" type="password" autocomplete="new-password" required /></label>
        <label>Repite la contraseña<input v-model="password2" type="password" autocomplete="new-password" required /></label>
        <label v-if="needTotp">Código de verificación actual<input v-model.trim="totp" inputmode="numeric" autocomplete="one-time-code" maxlength="8" required /></label>
        <p v-if="error" class="alert alert-err">{{ error }}</p>
        <button class="btn btn-primary btn-block" :disabled="busy">{{ busy ? 'Activando…' : 'Activar cuenta' }}</button>
      </form>
      <p class="muted small"><RouterLink to="/login">Volver a iniciar sesión</RouterLink></p>
    </div>
  </main>
</template>
