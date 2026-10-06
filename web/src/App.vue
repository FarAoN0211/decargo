<script setup lang="ts">
import { useRouter } from 'vue-router';
import { notice } from './notice';
import { DEMO } from './base';
import { auth, logout } from './api';

const router = useRouter();
/** Demostración: volver a elegir perfil (los datos modificados se conservan hasta recargar la página). */
async function switchProfile(): Promise<void> { await logout(); await router.replace('/login'); }
function view(): void {
  const id = notice.id;
  notice.kind = '';
  void router.push({ path: '/conductor', query: id ? { t: id } : {} });
}
</script>
<template>
  <div v-if="DEMO" class="demo-bar" role="note">
    <span><b>Versión de demostración</b> · datos ficticios. Puedes crear, editar y eliminar: <b>al recargar la página todo vuelve al estado original</b>.</span>
    <span class="demo-actions">
      <button v-if="auth.user" class="btn btn-sm" type="button" @click="switchProfile">Cambiar de perfil</button>
      <a class="btn btn-sm" href="/">Salir de la demo</a>
    </span>
  </div>
  <div v-if="notice.kind" class="push-banner" role="alert">
    <span v-if="notice.kind === 'TEST'"><b>✔ Aviso de prueba recibido.</b> Las notificaciones llegan a este teléfono.</span>
    <span v-else><b>Nuevo transporte disponible</b></span>
    <span class="push-actions">
      <button v-if="notice.kind === 'TRANSPORT'" class="btn btn-accent" type="button" @click="view">Ver transporte</button>
      <button class="btn btn-sm" type="button" @click="notice.kind = ''">Cerrar</button>
    </span>
  </div>
  <RouterView />
</template>
