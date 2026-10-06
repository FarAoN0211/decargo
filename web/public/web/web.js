/* DECARGO · web pública: botones «Acceder» y «Probar DECARGO» desde la configuración del servidor, y datos de la APK publicada. */
(function () {
  'use strict';
  var setAll = function (sel, fn) { Array.prototype.forEach.call(document.querySelectorAll(sel), fn); };

  fetch('/api/v1/app/entry', { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (e) {
    if (!e) return;
    var app = typeof e.app_path === 'string' && e.app_path.charAt(0) === '/' ? e.app_path : null;
    if (app) {
      // La aplicación instalada (PWA o app Android antigua) que se abra aquí va directamente a DECARGO.
      var standalone = window.matchMedia && window.matchMedia('(display-mode: standalone)').matches;
      if (standalone || /DecargoAndroid/.test(navigator.userAgent)) { window.location.replace(app); return; }
      setAll('.js-acceder', function (a) { a.href = app; });
    }
    var nota = document.querySelector('.js-demo-nota');
    setAll('.js-demo', function (a) {
      if (e.demo_url) { a.href = e.demo_url; if (nota) nota.textContent = 'Demostración con datos ficticios: puedes tocarlo todo; al recargar vuelve al estado original.'; }
      else { a.removeAttribute('href'); a.setAttribute('aria-disabled', 'true'); a.title = 'Próximamente'; }
    });
  }).catch(function () { /* sin servidor: los enlaces quedan como están */ });

  var none = document.querySelector('.js-apk-none');
  fetch('/app/decargo.json', { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (m) {
    if (!m || !m.sha256) { if (none) none.textContent = 'La APK todavía no está publicada en esta instalación.'; return; }
    var txt = function (sel, v) { var el = document.querySelector(sel); if (el) el.textContent = v; };
    txt('.js-apk-version', m.version || '—');
    txt('.js-apk-date', m.published ? new Date(m.published).toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' }) : '—');
    txt('.js-apk-size', m.size ? (m.size / 1048576).toFixed(1).replace('.', ',') + ' MB' : '—');
    txt('.js-apk-sha', m.sha256);
    var link = document.querySelector('.js-apk-link'); if (link) link.hidden = false;
    if (none) none.hidden = true;
  }).catch(function () { if (none) none.textContent = 'No se pudo comprobar la versión publicada.'; });
})();
