/* DECARGO usa el service worker para la instalación, los avisos y para ABRIR LA APLICACIÓN SIN COBERTURA.
   Solo guarda la «carcasa» de la aplicación (index.html y los ficheros /assets/ con huella, que nunca cambian): nunca la API,
   sesiones ni documentos. Los DeCA que el conductor puede ver sin cobertura los guarda la propia página (offline.ts) con caducidad. */
const SHELL = 'decargo-shell-v1';
// Ruta de la aplicación («/<ruta>/»): la página la pasa al registrar el service worker. La raíz es la web pública (no se toca).
const BASE = (() => { const b = new URL(self.location.href).searchParams.get('base') || '/'; return /^\/([A-Za-z0-9_-]{16,64}\/)?$/.test(b) ? b : '/'; })();
/** Rutas de la aplicación que llegan en los avisos («/conductor?t=…») → dentro de la ruta de la aplicación. */
const appUrl = (p) => (typeof p === 'string' && p.startsWith('/') && !p.startsWith('//') && !p.startsWith(BASE) ? BASE + p.slice(1) : (p || BASE));
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

/** Cuando cambia la versión de la aplicación, se borran los ficheros de versiones anteriores que ya no usa (se vuelven a guardar al usarse). */
async function keepShell(html) {
  const used = new Set((html.match(/\/assets\/[^"'\s)]+/g) || []));
  const c = await caches.open(SHELL);
  const prev = await c.match(BASE);
  const prevMain = prev ? ((await prev.text()).match(/\/assets\/index-[^"']+\.js/) || [''])[0] : '';
  const nowMain = (html.match(/\/assets\/index-[^"']+\.js/) || [''])[0];
  await c.put(BASE, new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } }));
  if (prevMain && nowMain && prevMain !== nowMain) {
    for (const req of await c.keys()) { const p = new URL(req.url).pathname; if (p.startsWith('/assets/') && !used.has(p)) await c.delete(req); }
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/d/') || url.pathname.startsWith('/app/')) return;   // siempre a la red
  if (req.mode === 'navigate') {
    if (BASE === '/' || !url.pathname.startsWith(BASE)) return;   // web pública y demás: siempre a la red
    // Red primero; sin cobertura, la última versión guardada de la aplicación.
    event.respondWith(fetch(req).then((res) => {
      if (res.ok && (res.headers.get('content-type') || '').includes('text/html')) event.waitUntil(res.clone().text().then(keepShell).catch(() => undefined));
      return res;
    }).catch(async () => (await caches.match(BASE)) || Response.error()));
    return;
  }
  if (url.pathname.startsWith('/assets/')) {
    // Con huella en el nombre: si está guardado se usa; si no, se descarga y se guarda.
    event.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); event.waitUntil(caches.open(SHELL).then((c) => c.put(req, copy))); }
      return res;
    })));
    return;
  }
  if (/^\/(decargo-logo|icon-192|favicon)\.png$/.test(url.pathname)) {
    event.respondWith(fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); event.waitUntil(caches.open(SHELL).then((c) => c.put(req, copy))); }
      return res;
    }).catch(async () => (await caches.match(req)) || Response.error()));
  }
});

/** Acuse al servidor de una prueba de aviso (sin sesión: el identificador de la prueba es un UUID aleatorio). Nunca debe romper el aviso. */
const ack = (n, ev, info) => (n ? fetch('/api/v1/push/ack', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ n, event: ev, ...(info ? { info } : {}) }) }).catch(() => undefined) : Promise.resolve());

/** Datos del teléfono para diagnosticar por qué no se ve un aviso: navegador, sistema, modelo, permiso y si el aviso sigue activo en la bandeja. */
async function phoneInfo(tag) {
  const info = { ua: String(navigator.userAgent || '').slice(0, 200), perm: typeof Notification === 'undefined' ? 'n/d' : Notification.permission };
  try {
    const u = navigator.userAgentData;
    if (u) {
      const h = await u.getHighEntropyValues(['model', 'platformVersion', 'fullVersionList']);
      info.model = String(h.model || '').slice(0, 60); info.os = `${u.platform || ''} ${h.platformVersion || ''}`.trim().slice(0, 60);
      info.browser = (h.fullVersionList || u.brands || []).map((b) => `${b.brand} ${b.version || ''}`.trim()).join(', ').slice(0, 250);
    }
  } catch { /* sin datos de cliente */ }
  try { await new Promise((r) => setTimeout(r, 1200)); info.active = (await self.registration.getNotifications({ tag })).length; } catch { /* */ }
  return info;
}

/** Si la aplicación está abierta, el aviso también aparece DENTRO de ella (aunque Android no pinte la notificación). */
async function tellPages(msg) {
  try { for (const c of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) c.postMessage(msg); } catch { /* */ }
}

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { /* aviso genérico */ }
  if (data.type === 'TEST') {   // prueba lanzada por la oficina: se avisa al servidor de hasta dónde llega (recibido → mostrado → pulsado)
    const n = typeof data.n === 'string' ? data.n : '';
    // El aviso se muestra YA; los acuses al servidor van en paralelo y nunca lo retrasan.
    const shown = self.registration.showNotification('DECARGO · Aviso de prueba', {
      body: 'La oficina ha enviado un aviso de prueba. Si lo ves, las notificaciones funcionan en este teléfono.', icon: '/icon-192.png', badge: '/icon-192.png',
      tag: 'decargo-test', renotify: true, requireInteraction: true, silent: false, timestamp: Date.now(), vibrate: [300, 150, 300, 150, 300], data: { url: appUrl('/conductor'), n }
    });
    event.waitUntil(Promise.all([ack(n, 'received'), tellPages({ type: 'decargo-push', kind: 'TEST' }), shown.then(async () => ack(n, 'shown', await phoneInfo('decargo-test')))]));
    return;
  }
  const id = typeof data.transport_id === 'string' && /^[0-9a-f-]{36}$/.test(data.transport_id) ? data.transport_id : '';
  // Cualquier cambio en el transporte (asignado, modificado, anulado, retirado) llega con su título y su motivo.
  const open = data.type === 'TRANSPORT_ASSIGNED' || data.type === 'TRANSPORT_UPDATED' || !data.type;
  const url = appUrl(id && open ? `/conductor?t=${encodeURIComponent(id)}` : '/conductor');
  const title = typeof data.title === 'string' && data.title ? `DECARGO · ${data.title.slice(0, 60)}` : 'DECARGO · Nuevo transporte';
  const text = typeof data.body === 'string' && data.body ? data.body.slice(0, 300) : 'Tienes un nuevo transporte disponible';
  // Aviso de máxima prioridad: el servidor lo envía con urgency=high (despierta el teléfono) y aquí se pide sonido, vibración y que
  // no desaparezca solo hasta que el conductor lo atienda. Con el botón «Ver transporte» se abre directamente ese transporte.
  event.waitUntil(Promise.all([tellPages({ type: 'decargo-push', kind: 'TRANSPORT', id }), self.registration.showNotification(title, {
    body: text,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: id ? `transport-${id}` : 'decargo-transport',
    renotify: true,
    requireInteraction: true,
    silent: false,
    timestamp: Date.now(),
    vibrate: [300, 150, 300, 150, 300],
    data: { url },
    actions: [{ action: 'view', title: open ? 'Ver transporte' : 'Abrir DECARGO' }]
  })]));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const testN = event.notification.data?.n;
  if (testN) event.waitUntil(ack(testN, 'clicked'));
  const url = new URL(appUrl(event.notification.data?.url || '/conductor'), self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (windows) => {
    for (const client of windows) {
      if ('navigate' in client) await client.navigate(url);
      return client.focus();
    }
    return self.clients.openWindow(url);
  }));
});
