import { createApp } from 'vue';
import App from './App.vue';
import router from './router';
import './styles.css';

import { notice } from './notice';
import { APP_BASE, DEMO } from './base';

createApp(App).use(router).mount('#app');

// La aplicación instalada se actualiza SOLA: comprueba si hay versión nueva al abrirla, al volver a ella y cada minuto, y se recarga.
// (Sin esto, una aplicación instalada seguiría con el código antiguo hasta cerrarla del todo.)
const ASSET = /\/assets\/index-[^"']+\.js/;
const running = (): string | null => { const el = document.querySelector('script[type="module"][src*="/assets/index-"]'); return el ? new URL((el as HTMLScriptElement).src).pathname : null; };
let reloading = false, wantReload = false;
/** No se recarga mientras alguien está rellenando un formulario (se espera al siguiente minuto). */
const typing = (): boolean => Array.from(document.querySelectorAll<HTMLInputElement>('form input, form textarea')).some((e) => !e.disabled && e.type !== 'hidden' && e.type !== 'checkbox' && e.type !== 'radio' && e.type !== 'date' && e.value !== '');
function reloadWhenIdle(): void { wantReload = true; if (!reloading && !typing()) { reloading = true; location.reload(); } }
async function checkForNewVersion(): Promise<void> {
  if (reloading) return;
  if (wantReload) { reloadWhenIdle(); return; }
  try {
    const now = running();
    if (!now) return;
    const html = await (await fetch(APP_BASE, { cache: 'no-store' })).text();
    const latest = ASSET.exec(html)?.[0];
    if (latest && latest !== now) reloadWhenIdle();
  } catch { /* sin red: se vuelve a comprobar más tarde */ }
}

// Service worker: instalación, avisos push y abrir la aplicación sin cobertura (guarda solo la carcasa de la app; nunca API, sesiones ni PDF).
if (DEMO) { /* demostración: sin service worker ni actualizaciones automáticas (no debe interferir con la aplicación real) */ }
else if ('serviceWorker' in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  window.addEventListener('load', () => {
    // El service worker sabe en qué ruta vive la aplicación (para abrirla sin cobertura y para los avisos).
    navigator.serviceWorker.register(`/service-worker.js?base=${encodeURIComponent(APP_BASE)}`, { updateViaCache: 'none' }).then((reg) => {
      const update = (): void => { void reg.update().catch(() => undefined); void checkForNewVersion(); };
      document.addEventListener('visibilitychange', () => { if (!document.hidden) update(); });
      window.addEventListener('online', update);
      setInterval(update, 60_000);
      update();
    }).catch(() => {
      // La web sigue funcionando con normalidad si el navegador bloquea el registro.
    });
  });
  // Aviso recibido con la aplicación abierta: se muestra también dentro de ella (y vibra si el teléfono lo permite).
  navigator.serviceWorker.addEventListener('message', (e: MessageEvent) => {
    const d = e.data as { type?: string; kind?: string; id?: string } | null;
    if (d?.type !== 'decargo-push' || (d.kind !== 'TEST' && d.kind !== 'TRANSPORT')) return;
    notice.kind = d.kind; notice.id = typeof d.id === 'string' ? d.id : '';
    try { navigator.vibrate?.([300, 150, 300]); } catch { /* sin vibración */ }
  });
  // Un service worker nuevo toma el control al instante: se recarga para usar también el código nuevo de la página.
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController) reloadWhenIdle(); });
} else {
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void checkForNewVersion(); });
  setInterval(() => { void checkForNewVersion(); }, 60_000);
}
