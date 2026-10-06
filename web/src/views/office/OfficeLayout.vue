<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api, auth, logout } from '../../api';
import { ROLE } from '../../format';

const router = useRouter();
const readOnly = computed(() => auth.user?.role === 'solo_lectura');
const route = useRoute();
const exp = ref({ expired: 0, soon: 0 });
async function loadExp(): Promise<void> {
  try { const l = await api<any[]>('/expiries'); exp.value = { expired: l.filter((x) => x.status === 'CADUCADO').length, soon: l.filter((x) => x.status === 'PROXIMO').length }; } catch { /* sin insignia */ }
}
onMounted(loadExp);
watch(() => route.fullPath, loadExp);   // se refresca al cambiar de pantalla
async function out(): Promise<void> { await logout(); await router.replace('/login'); }
</script>
<template>
  <header class="topbar">
    <div class="topbar-in">
      <RouterLink class="brand" to="/oficina"><img src="/decargo-logo.png" alt="DECARGO" /></RouterLink>
      <nav class="nav" aria-label="Principal">
        <RouterLink to="/oficina" active-class="" exact-active-class="router-link-active">Inicio</RouterLink>
        <RouterLink to="/oficina/transportes">Transportes</RouterLink>
        <RouterLink to="/oficina/conductores">Conductores</RouterLink>
        <RouterLink to="/oficina/vehiculos">Vehículos</RouterLink>
        <RouterLink to="/oficina/empresas">Empresas</RouterLink>
        <RouterLink to="/oficina/caducidades">Caducidades<span v-if="exp.expired" class="badge b-bad exp-badge">{{ exp.expired }}</span><span v-else-if="exp.soon" class="badge b-pend exp-badge">{{ exp.soon }}</span></RouterLink>
        <RouterLink v-if="auth.user?.role === 'admin'" to="/oficina/configuracion">Configuración</RouterLink>
      </nav>
      <div class="who"><b>{{ auth.user?.full_name }}</b>{{ ROLE[auth.user?.role ?? ''] }}</div>
      <button class="btn btn-sm" type="button" @click="out">Salir</button>
    </div>
  </header>
  <main class="page">
    <p v-if="readOnly" class="alert alert-info">Tu usuario es de solo lectura: puedes consultar, no modificar.</p>
    <RouterView />
  </main>
</template>
