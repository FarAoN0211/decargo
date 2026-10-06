import { createRouter, createWebHistory } from 'vue-router';
import { APP_BASE, DEMO } from './base';
import { auth, homeFor, restoreSession, setOnSessionLost } from './api';

const router = createRouter({
  history: createWebHistory(APP_BASE),
  routes: [
    // «/» no pinta nada: la guarda de abajo redirige a /login o a la pantalla del rol. Sin esta ruta caía en el comodín y entraba en bucle.
    { path: '/', component: { render: () => null } },
    { path: '/sin-conexion', component: () => import('./views/Offline.vue'), meta: { public: true } },
    { path: '/login', component: DEMO ? () => import('./views/DemoStart.vue') : () => import('./views/Login.vue'), meta: { public: true } },
    { path: '/activar', component: () => import('./views/Activate.vue'), meta: { public: true } },
    { path: '/activar/totp', component: () => import('./views/TotpSetup.vue') },
    {
      path: '/oficina', component: () => import('./views/office/OfficeLayout.vue'), meta: { role: 'office' },
      children: [
        { path: '', component: () => import('./views/office/Home.vue') },
        { path: 'transportes', component: () => import('./views/office/Transports.vue') },
        { path: 'transportes/nuevo', component: () => import('./views/office/TransportNew.vue') },
        { path: 'transportes/:id', component: () => import('./views/office/TransportDetail.vue'), props: true },
        { path: 'conductores', component: () => import('./views/office/Drivers.vue') },
        { path: 'vehiculos', component: () => import('./views/office/Vehicles.vue') },
        { path: 'empresas', component: () => import('./views/office/Parties.vue') },
        { path: 'caducidades', component: () => import('./views/office/Expiries.vue') },
        { path: 'configuracion', component: () => import('./views/office/Settings.vue') }
      ]
    },
    { path: '/conductor', component: () => import('./views/driver/DriverHome.vue'), meta: { role: 'driver' } },
    { path: '/conductor/deca', component: () => import('./views/driver/DriverDeca.vue'), meta: { role: 'driver' } },
    { path: '/conductor/qr', component: () => import('./views/driver/DriverQr.vue'), meta: { role: 'driver' } },
    { path: '/:pathMatch(.*)*', redirect: '/' }
  ]
});

// Las guardas son solo comodidad de navegación: la autorización real la decide siempre el servidor.
router.beforeEach(async (to) => {
  await restoreSession();
  // Sin red al abrir la aplicación: no se pide la contraseña; se conserva la sesión y se reintenta.
  if (!auth.user && auth.offline && to.path !== '/sin-conexion') return '/sin-conexion';
  if (to.path === '/') return auth.user ? homeFor(auth.user.role) : '/login';
  if (to.path === '/sin-conexion' && !auth.offline) return auth.user ? homeFor(auth.user.role) : '/login';
  if (to.meta.public) return auth.user && !auth.mfaRequired && to.path === '/login' ? homeFor(auth.user.role) : true;
  if (!auth.user) return '/login';
  if (auth.mfaRequired && to.path !== '/activar/totp') return '/activar/totp';
  if (to.meta.role === 'office' && auth.user.role === 'conductor') return '/conductor';
  if (to.meta.role === 'driver' && auth.user.role !== 'conductor') return '/oficina';
  return true;
});

setOnSessionLost(() => { void router.replace('/login'); });
export default router;
