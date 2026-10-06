<script setup lang="ts">
import { useRouter } from 'vue-router';
import { auth, homeFor } from '../api';
import { DEMO_PROFILES, demoLogin } from '../demo/server';

/** Demostración: se entra eligiendo un perfil (sin contraseñas). Todo son datos ficticios y se restauran al recargar la página. */
const router = useRouter();
async function enter(key: string): Promise<void> {
  const u = demoLogin(key);
  auth.user = u as typeof auth.user; auth.scope = 'FULL'; auth.mfaRequired = false; auth.deviceStatus = 'AUTORIZADO';
  await router.replace(homeFor(auth.user?.role));
}
</script>
<template>
  <main class="auth-page">
    <div class="auth-card stack demo-start">
      <img class="logo" src="/decargo-logo.png" alt="DECARGO" />
      <h1>Prueba DECARGO</h1>
      <p>Demostración con <b>datos totalmente ficticios</b>. Puedes crear, editar, anular y archivar lo que quieras: <b>al recargar la página todo vuelve al estado original</b>. Nada se guarda ni se envía a ningún sitio.</p>
      <p class="small muted">Elige con qué perfil quieres entrar (puedes cambiarlo cuando quieras desde la barra de arriba).</p>
      <button v-for="p in DEMO_PROFILES" :key="p.key" class="demo-profile" type="button" @click="enter(p.key)">
        <b>{{ p.label }}</b> <span class="muted">· {{ p.who }}</span>
        <span class="small">{{ p.desc }}</span>
      </button>
      <a class="small" href="/">← Volver a la web de DECARGO</a>
    </div>
  </main>
</template>
<style scoped>
.demo-start { max-width: 30rem; }
.demo-profile { display: grid; gap: .2rem; text-align: left; padding: .8rem 1rem; border: 1px solid var(--line); border-radius: 12px; background: var(--card); cursor: pointer; font: inherit; color: inherit; }
.demo-profile:hover, .demo-profile:focus-visible { border-color: var(--dark); }
</style>
