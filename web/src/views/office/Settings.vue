<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import FileViewer from '../../components/FileViewer.vue';
import { api, apiBlob, auth } from '../../api';
import { messageFor } from '../../errors';

interface Cfg { deca_show_driver: boolean; logo: { sha256: string; mime: string; width: number; height: number; updated_at: string; updated_by: string } | null; food_transport: boolean; expiry_warn_days: number; company: { name: string; nif: string; address: string; postal_code: string | null; city: string | null; province: string | null; country: string | null; transport_authorization?: string | null } | null; test_mode_source: string; dev_endpoints_available: boolean; public_base_url: string | null; source: 'web' | 'env'; env_public_base_url: string | null; error: string | null; https: boolean; insecure_allowed: boolean;
  test_mode: boolean; dev_endpoints: boolean; push_configured: boolean; fcm: { configured: boolean; project_id: string | null; package: string; updated_at: string | null; updated_by: string | null }; decas_total: number; decas_other_base: number }
interface Probe { ok: boolean; status: number | null; detail: string }
interface Check { url: string; checked: boolean; reason: string | null; web: Probe | null; docs: Probe | null }

const isAdmin = computed(() => auth.user?.role === 'admin');
const origin = window.location.origin;
const cfg = ref<Cfg | null>(null), check = ref<Check | null>(null);
const url = ref(''), error = ref(''), saved = ref(''), busy = reactive({ check: false, save: false });
const copied = ref('');
const bulkReason = ref('Dirección pública actualizada'), bulkBusy = ref(false), bulkMsg = ref('');
async function reissueAll(): Promise<void> {
  bulkBusy.value = true; error.value = ''; bulkMsg.value = '';
  try {
    const r = await api<{ reissued: number; failed: number; total: number }>('/admin/decas/reissue-outdated', { method: 'POST', body: { reason: bulkReason.value } });
    bulkMsg.value = `Reemitidos ${r.reissued} de ${r.total}${r.failed ? ` (${r.failed} con error: repite la operación)` : ''}. Los anteriores se conservan como sustituidos.`;
    await load();
  } catch (e) { error.value = messageFor(e); } finally { bulkBusy.value = false; }
}

const tplMsg = ref(''), preview = ref<null | { title: string; path: string; kind: 'pdf' | 'qr'; filename?: string }>(null);
// App Android: credenciales de Firebase (dos ficheros JSON que descarga el administrador de la consola de Firebase).
const fcmFiles = { gs: '', sa: '' }, fcmNames = ref({ gs: '', sa: '' }), fcmMsg = ref(''), fcmBusy = ref(false);
function readJson(kind: 'gs' | 'sa', ev: Event): void {
  const f = (ev.target as HTMLInputElement).files?.[0];
  if (!f) return;
  if (f.size > 20000) { error.value = 'Ese fichero es demasiado grande: no parece un JSON de Firebase.'; return; }
  const r = new FileReader();
  r.onload = () => { fcmFiles[kind] = String(r.result ?? ''); fcmNames.value = { ...fcmNames.value, [kind]: f.name }; };
  r.readAsText(f);
}
async function saveFcm(clear = false): Promise<void> {
  if (clear && !window.confirm('¿Quitar la configuración de Firebase? La app Android dejará de recibir avisos.')) return;
  fcmBusy.value = true; fcmMsg.value = ''; error.value = '';
  try {
    cfg.value = await api<Cfg>('/admin/config/fcm', { method: 'PUT', body: clear ? { clear: true } : { google_services: fcmFiles.gs, service_account: fcmFiles.sa } });
    fcmMsg.value = clear ? 'Configuración quitada.' : 'Guardado y comprobado con Google. Los conductores ya pueden activar los avisos en la app.';
    fcmFiles.gs = ''; fcmFiles.sa = ''; fcmNames.value = { gs: '', sa: '' };
  } catch (e) { error.value = messageFor(e); } finally { fcmBusy.value = false; }
}

async function saveTemplate(body: Record<string, unknown>): Promise<void> {
  error.value = ''; tplMsg.value = '';
  try { cfg.value = await api<Cfg>('/admin/config/template', { method: 'PUT', body }); tplMsg.value = 'Guardado. Se aplica a los DeCA que se emitan a partir de ahora.'; } catch (e) { error.value = messageFor(e); }
}
const showTpl = (mode: 'ejemplo' | 'blanco', title: string): void => { preview.value = { title, path: `/admin/config/template-preview?template=DECARGO&mode=${mode}`, kind: 'pdf', filename: `deca-decargo-${mode}.pdf` }; };

// Logo de la empresa (cabecera del Modelo DECARGO). La imagen se vuelve a dibujar en el navegador (PNG, o JPEG si pesa mucho) antes de subirla:
// así se reduce su tamaño y el servidor solo recibe una imagen limpia y pequeña.
const LOGO_MAX = 256 * 1024;
const logoUrl = ref(''), logoMsg = ref(''), logoBusy = ref(false);
async function loadLogo(): Promise<void> {
  if (logoUrl.value) { URL.revokeObjectURL(logoUrl.value); logoUrl.value = ''; }
  if (!cfg.value?.logo) return;
  try { logoUrl.value = URL.createObjectURL(await apiBlob('/admin/config/logo')); } catch { /* sin vista previa */ }
}
function toBase64(b: Blob): Promise<string> {
  return new Promise((ok, ko) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1] ?? ''); r.onerror = () => ko(r.error); r.readAsDataURL(b); });
}
async function prepareLogo(file: File): Promise<Blob> {
  const src = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise<void>((ok, ko) => { img.onload = () => ok(); img.onerror = () => ko(new Error('imagen')); img.src = src; });
    if (!img.naturalWidth || !img.naturalHeight) throw new Error('imagen');
    for (const max of [1200, 900, 600, 400]) {
      const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const cv = document.createElement('canvas');
      cv.width = Math.max(1, Math.round(img.naturalWidth * k)); cv.height = Math.max(1, Math.round(img.naturalHeight * k));
      const g = cv.getContext('2d')!;
      g.drawImage(img, 0, 0, cv.width, cv.height);
      const png = await new Promise<Blob | null>((ok) => cv.toBlob(ok, 'image/png'));
      if (png && png.size <= LOGO_MAX) return png;
      g.globalCompositeOperation = 'destination-over'; g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height);   // JPEG: sin transparencia, fondo blanco
      const jpg = await new Promise<Blob | null>((ok) => cv.toBlob(ok, 'image/jpeg', 0.9));
      if (jpg && jpg.size <= LOGO_MAX) return jpg;
    }
    throw new Error('grande');
  } finally { URL.revokeObjectURL(src); }
}
async function uploadLogo(ev: Event): Promise<void> {
  const input = ev.target as HTMLInputElement, file = input.files?.[0];
  input.value = '';
  if (!file) return;
  error.value = ''; logoMsg.value = ''; logoBusy.value = true;
  try {
    let blob: Blob;
    try { blob = await prepareLogo(file); } catch { error.value = 'No se puede usar esta imagen. Usa un PNG, JPEG, WebP o SVG.'; return; }
    cfg.value = await api<Cfg>('/admin/config/logo', { method: 'PUT', body: { data: await toBase64(blob) } });
    await loadLogo(); logoMsg.value = 'Logo guardado. Sale en los DeCA que se emitan a partir de ahora.';
  } catch (e) { error.value = messageFor(e); } finally { logoBusy.value = false; }
}
async function removeLogo(): Promise<void> {
  error.value = ''; logoMsg.value = ''; logoBusy.value = true;
  try { cfg.value = await api<Cfg>('/admin/config/logo', { method: 'PUT', body: { data: null } }); await loadLogo(); logoMsg.value = 'Logo quitado. Los DeCA ya emitidos conservan el suyo.'; }
  catch (e) { error.value = messageFor(e); } finally { logoBusy.value = false; }
}
const docMsg = ref(''), warn = ref(30);
async function saveDocs(food?: boolean): Promise<void> {
  error.value = ''; docMsg.value = '';
  try { cfg.value = await api<Cfg>('/admin/config/documents', { method: 'PUT', body: { ...(food === undefined ? {} : { food_transport: food }), warn_days: Number(warn.value) } }); warn.value = cfg.value.expiry_warn_days; docMsg.value = 'Guardado.'; } catch (e) { error.value = messageFor(e); }
}
const co = reactive({ name: '', nif: '', address: '', postal_code: '', city: '', province: '', country: '', transport_authorization: '' }), coMsg = ref(''), flagBusy = ref('');
function fillCompany(): void { if (cfg.value) warn.value = cfg.value.expiry_warn_days; if (cfg.value?.company) { const c = cfg.value.company; co.name = c.name; co.nif = c.nif; co.address = c.address; co.postal_code = c.postal_code ?? ''; co.transport_authorization = c.transport_authorization ?? ''; co.city = c.city ?? ''; co.province = c.province ?? ''; co.country = c.country ?? ''; } }
async function saveCompany(): Promise<void> {
  error.value = ''; coMsg.value = '';
  try { cfg.value = await api<Cfg>('/admin/config/company', { method: 'PUT', body: { ...co, transport_authorization: co.transport_authorization.trim() || null, postal_code: co.postal_code || null, city: co.city || null, province: co.province || null, country: co.country || null } }); fillCompany(); coMsg.value = 'Datos guardados. Todos los transportes y DeCA nuevos llevarán este transportista efectivo.'; } catch (e) { error.value = messageFor(e); }
}
async function setFlag(name: 'test_mode' | 'dev_endpoints', value: boolean): Promise<void> {
  if (name === 'test_mode' && !value && !window.confirm('A partir de ahora los PDF nuevos NO llevarán el rótulo «DOCUMENTO DE PRUEBA» y se emitirán como documentos reales. Los DeCA ya emitidos conservan su rótulo. ¿Continuar?')) return;
  flagBusy.value = name; error.value = '';
  try { cfg.value = await api<Cfg>('/admin/config/flags', { method: 'PUT', body: { [name]: value } }); } catch (e) { error.value = messageFor(e); } finally { flagBusy.value = ''; }
}
async function load(): Promise<void> {
  try { cfg.value = await api<Cfg>('/admin/config'); url.value = cfg.value.public_base_url ?? ''; fillCompany(); await loadLogo(); } catch (e) { error.value = messageFor(e); }
}
async function runCheck(): Promise<void> {
  busy.check = true; error.value = ''; saved.value = ''; check.value = null;
  try { check.value = await api<Check>('/admin/config/check', { method: 'POST', body: { url: url.value } }); } catch (e) { error.value = messageFor(e); } finally { busy.check = false; }
}
async function save(): Promise<void> {
  busy.save = true; error.value = ''; saved.value = '';
  try {
    cfg.value = await api<Cfg>('/admin/config/public-base-url', { method: 'PUT', body: { url: url.value } });
    url.value = cfg.value.public_base_url ?? ''; saved.value = 'Dirección guardada. Los DeCA que emitas desde ahora llevarán esta dirección.';
  } catch (e) { error.value = messageFor(e); } finally { busy.save = false; }
}
async function copy(text: string): Promise<void> {
  try { await navigator.clipboard.writeText(text); copied.value = text; setTimeout(() => { copied.value = ''; }, 1500); } catch { /* el texto se puede seleccionar a mano */ }
}
const steps = [
  { t: 'En el servidor antiguo: haz una copia de seguridad', c: './deca backup', n: 'Guarda aparte la clave RESTIC_PASSWORD del fichero .env: sin ella no se puede abrir la copia.' },
  { t: 'En el servidor nuevo: copia la carpeta del proyecto y lanza el asistente', c: './deca setup', n: 'Detecta la IP local, pregunta la dirección pública y comprueba que los puertos estén libres.' },
  { t: 'Conecta la copia de seguridad y restaura', c: './deca restore', n: 'Recupera usuarios, transportes, DeCA y PDF. Todas las sesiones se cierran: cada persona vuelve a entrar.' },
  { t: 'En el proxy (NPM u otro): apunta el dominio a la web y la ruta /d/ al servicio documental', c: '', n: 'Dominio → web (puerto de la web). Ruta /d/ → docs (puerto de documentos). Con certificado HTTPS.' },
  { t: 'Vuelve aquí, escribe la dirección pública nueva y pulsa Comprobar y Guardar', c: '', n: 'Los DeCA ya emitidos conservan la dirección que llevan impresa en su QR; los nuevos usarán la nueva.' }
];
onMounted(() => { if (isAdmin.value) void load(); });
</script>
<template>
  <div class="page-title"><h1>Configuración</h1></div>
  <p v-if="!isAdmin" class="alert alert-warn">Solo el administrador puede ver y cambiar la configuración.</p>
  <template v-else>
    <p v-if="error" class="alert alert-err">{{ error }}</p>
    <section v-if="cfg" class="card">
      <h2>Tu empresa · transportista efectivo</h2>
      <p class="muted">Son los datos del transportista efectivo (apartado b del DeCA) que llevarán por defecto todos los transportes nuevos. En un transporte concreto se puede indicar otro. Los DeCA ya emitidos conservan los suyos.</p>
      <form class="stack" @submit.prevent="saveCompany">
        <div class="grid2"><label>Nombre o denominación social<input v-model="co.name" required maxlength="120" /></label><label>NIF<input v-model="co.nif" required maxlength="16" /></label></div>
        <label>Domicilio (calle y número)<input v-model="co.address" required maxlength="200" /></label>
        <label>Nº de autorización de transporte<span class="hint small"> (opcional: el de la autorización de transporte público de mercancías / Registro de Empresas y Actividades de Transporte; sale en el Modelo DECARGO)</span><input v-model="co.transport_authorization" maxlength="30" /></label>
        <div class="grid4"><label>Código postal<input v-model="co.postal_code" maxlength="10" inputmode="numeric" /></label><label>Localidad<input v-model="co.city" maxlength="80" /></label><label>Provincia<input v-model="co.province" maxlength="80" /></label><label>País<input v-model="co.country" maxlength="60" placeholder="España" /></label></div>
        <div class="row"><button class="btn btn-primary" type="submit">Guardar</button></div>
      </form>
      <p v-if="coMsg" class="alert alert-ok">{{ coMsg }}</p>
    </section>

    <section v-if="cfg" class="card">
      <h2>Documento (DeCA)</h2>
      <p class="muted">Los DeCA se emiten con el <b>Modelo DECARGO</b>: en fichas y en una sola página, con cabecera con QR, intervinientes, carga y entrega con hora, vehículo y conductor, mercancía y observaciones.</p>
      <span class="row"><button class="btn btn-sm" type="button" @click="showTpl('ejemplo', 'Ejemplo · Modelo DECARGO')">Ver ejemplo</button>
        <button class="btn btn-sm" type="button" @click="showTpl('blanco', 'En blanco · Modelo DECARGO')">Formulario en blanco</button></span>

      <h3>Logo de la empresa</h3>
      <p class="muted small">Sale en la cabecera del DeCA, a la izquierda (el QR va a la derecha). PNG, JPEG, WebP o SVG; mejor con fondo transparente o blanco. Solo cambia los DeCA que se emitan a partir de ahora: los ya emitidos, y sus versiones, conservan el logo con el que se emitieron.</p>
      <div class="logo-row">
        <div class="logo-box"><img v-if="logoUrl" :src="logoUrl" alt="Logo de la empresa" /><span v-else class="muted small">Sin logo</span></div>
        <span class="row">
          <label class="btn btn-sm" :class="{ disabled: logoBusy }">{{ cfg.logo ? 'Cambiar logo' : 'Subir logo' }}<input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" style="display: none" :disabled="logoBusy" @change="uploadLogo" /></label>
          <button v-if="cfg.logo" class="btn btn-sm" type="button" :disabled="logoBusy" @click="removeLogo">Quitar logo</button>
        </span>
      </div>
      <p v-if="logoMsg" class="alert alert-ok">{{ logoMsg }}</p>

      <h3>Datos del conductor</h3>
      <label class="check"><input type="checkbox" :checked="cfg.deca_show_driver" @change="saveTemplate({ show_driver: ($event.target as HTMLInputElement).checked })" /> Imprimir en el DeCA los datos del conductor (nombre, DNI y teléfono)</label>
      <p class="muted small">El DeCA se descarga con su enlace o QR por quien lo recibe: incluir el DNI y el teléfono del conductor es una decisión de la empresa. Por defecto no se imprimen.</p>
      <p v-if="tplMsg" class="alert alert-ok">{{ tplMsg }}</p>
    </section>

    <section v-if="cfg" class="card">
      <h2>Control de documentos y caducidades</h2>
      <p class="muted">Documentos de conductores y vehículos (carnet, CAP, tacógrafo, ITV, ATP…) y tarjetas de combustible / VIA-T. Es un control interno: tú anotas la fecha de caducidad de cada documento.</p>
      <label class="check"><input type="checkbox" :checked="cfg.food_transport" @change="saveDocs(($event.target as HTMLInputElement).checked)" /> La empresa transporta alimentos (muestra ATP, equipo de frío, carné de manipulador y registro sanitario)</label>
      <form class="row" @submit.prevent="saveDocs()"><label>Avisar con<input v-model.number="warn" type="number" min="1" max="365" class="narrow" /> días de antelación</label><button class="btn btn-sm" type="submit">Guardar</button></form>
      <p v-if="docMsg" class="alert alert-ok">{{ docMsg }}</p>
    </section>

    <section v-if="cfg" class="card">
      <h2>Dirección pública de los DeCA</h2>
      <p class="muted">Es la dirección que se imprime en el QR de cada DeCA nuevo. Cámbiala aquí cuando cambie el dominio o el servidor: no hace falta tocar ningún fichero.</p>
      <p>Dirección actual: <b class="mono">{{ cfg.public_base_url ?? 'sin configurar' }}</b>
        <span class="muted small"> · {{ cfg.source === 'web' ? 'fijada desde esta pantalla' : 'tomada de la instalación (.env)' }}</span></p>
      <p v-if="cfg.error" class="alert alert-err">{{ cfg.error }}</p>
      <p v-if="cfg.public_base_url && !cfg.https" class="alert alert-warn">Esta dirección no usa https. La Resolución exige https para el QR del DeCA: solo vale para pruebas.</p>
      <p v-if="cfg.decas_other_base" class="alert alert-info">{{ cfg.decas_other_base }} de {{ cfg.decas_total }} DeCA ya emitidos llevan otra dirección en su QR. Siguen funcionando mientras esa dirección apunte a este servidor.</p>
      <div v-if="cfg.decas_other_base" class="stack">
        <label>Motivo de la reemisión<input v-model="bulkReason" maxlength="500" /></label>
        <button class="btn" type="button" :disabled="bulkBusy || bulkReason.trim().length < 3" @click="reissueAll">{{ bulkBusy ? 'Reemitiendo…' : `Reemitir ${cfg.decas_other_base} DeCA con la dirección actual` }}</button>
        <p class="muted small">Genera PDF y QR nuevos con los mismos datos. Los anteriores se conservan (no se borran) y sus enlaces siguen funcionando. También se puede hacer DeCA a DeCA desde el detalle de cada transporte.</p>
      </div>
      <p v-if="bulkMsg" class="alert alert-ok">{{ bulkMsg }}</p>
      <form class="stack" @submit.prevent="save">
        <label>Nueva dirección pública<input v-model="url" type="text" inputmode="url" placeholder="https://decargo.tuempresa.com" maxlength="255" autocomplete="off" /></label>
        <div class="row">
          <button class="btn" type="button" :disabled="busy.check || !url" @click="runCheck">{{ busy.check ? 'Comprobando…' : 'Comprobar' }}</button>
          <button class="btn btn-primary" type="submit" :disabled="busy.save || !url || url === cfg.public_base_url">{{ busy.save ? 'Guardando…' : 'Guardar' }}</button>
        </div>
      </form>
      <p v-if="saved" class="alert alert-ok">{{ saved }}</p>
      <div v-if="check" class="stack">
        <p v-if="!check.checked" class="alert alert-info">No se puede comprobar desde el servidor ({{ check.reason === 'privada' ? 'el dominio apunta a una dirección interna' : 'el dominio no se resuelve desde aquí' }}). Pruébala desde un navegador: la web en «/» y un DeCA en «/d/…».</p>
        <template v-else>
          <p :class="['alert', check.web?.ok ? 'alert-ok' : 'alert-err']">{{ check.web?.ok ? '✔' : '✘' }} Web: {{ check.web?.detail }}</p>
          <p :class="['alert', check.docs?.ok ? 'alert-ok' : 'alert-err']">{{ check.docs?.ok ? '✔' : '✘' }} Documentos: {{ check.docs?.detail }}</p>
        </template>
      </div>
    </section>

    <section v-if="cfg" class="card">
      <h2>App Android para conductores</h2>
      <p>La app es la misma web dentro de una aplicación que puede <b>encender la pantalla</b> y mostrar el aviso aunque el teléfono esté bloqueado.
        Descárgala desde el teléfono del conductor: <a class="mono" href="/app/decargo.apk">{{ origin }}/app/decargo.apk</a></p>
      <p>Avisos de la app: <b>{{ cfg.fcm.configured ? `✔ configurados (proyecto ${cfg.fcm.project_id})` : '✘ sin configurar' }}</b></p>
      <details :open="!cfg.fcm.configured">
        <summary>{{ cfg.fcm.configured ? 'Cambiar las credenciales de Firebase' : 'Cómo configurarlos (una sola vez)' }}</summary>
        <ol class="small">
          <li>Entra en <span class="mono">console.firebase.google.com</span> con la cuenta de Google de la empresa y crea un proyecto (gratuito).</li>
          <li>Añade una app <b>Android</b> con el nombre de paquete <b class="mono">{{ cfg.fcm.package }}</b> y descarga <b class="mono">google-services.json</b>.</li>
          <li>Configuración del proyecto → Cuentas de servicio → <b>Generar nueva clave privada</b> (descarga otro JSON).</li>
          <li>Sube aquí los dos ficheros. Se comprueban con Google antes de guardarse; la clave privada se guarda cifrada.</li>
        </ol>
        <div class="grid2">
          <label>google-services.json<input type="file" accept="application/json,.json" @change="readJson('gs', $event)" /></label>
          <label>Clave de la cuenta de servicio (.json)<input type="file" accept="application/json,.json" @change="readJson('sa', $event)" /></label>
        </div>
        <p class="row"><button class="btn btn-primary" type="button" :disabled="fcmBusy || !fcmNames.gs || !fcmNames.sa" @click="saveFcm()">{{ fcmBusy ? 'Comprobando…' : 'Guardar y comprobar' }}</button>
          <button v-if="cfg.fcm.configured" class="btn" type="button" :disabled="fcmBusy" @click="saveFcm(true)">Quitar</button></p>
      </details>
      <p v-if="fcmMsg" class="alert alert-ok">{{ fcmMsg }}</p>
    </section>

    <section v-if="cfg" class="card">
      <h2>Modo de pruebas y uso con datos reales</h2>
      <ul class="plain flags">
        <li><b>{{ cfg.https ? '✔' : '✘' }}</b> Dirección pública con https</li>
        <li><b>{{ cfg.test_mode ? '✘' : '✔' }}</b>
          <span class="grow"><b>Rótulo «DOCUMENTO DE PRUEBA»</b> {{ cfg.test_mode ? 'activo: los PDF nuevos NO son válidos.' : 'desactivado: los PDF nuevos se emiten como reales.' }}</span>
          <button class="btn btn-sm" :class="cfg.test_mode ? 'btn-primary' : ''" type="button" :disabled="flagBusy === 'test_mode'" @click="setFlag('test_mode', !cfg.test_mode)">{{ cfg.test_mode ? 'Desactivar modo de pruebas' : 'Volver al modo de pruebas' }}</button></li>
        <li><b>{{ cfg.dev_endpoints ? '✘' : '✔' }}</b>
          <span class="grow"><b>Endpoints de prueba</b> {{ cfg.dev_endpoints ? 'activos (solo para pruebas técnicas).' : 'desactivados.' }}</span>
          <button v-if="cfg.dev_endpoints || cfg.dev_endpoints_available" class="btn btn-sm" :class="cfg.dev_endpoints ? 'btn-primary' : ''" type="button" :disabled="flagBusy === 'dev_endpoints'" @click="setFlag('dev_endpoints', !cfg.dev_endpoints)">{{ cfg.dev_endpoints ? 'Desactivar' : 'Activar' }}</button></li>
        <li><b>{{ cfg.push_configured ? '✔' : '✘' }}</b> Avisos al móvil (Web Push) {{ cfg.push_configured ? 'configurados' : 'sin claves VAPID' }}</li>
      </ul>
      <p class="muted small">Antes de empezar a trabajar de verdad: desactiva el modo de pruebas y elimina los datos de ejemplo con <span class="mono">./deca purge-examples</span> en el servidor.</p>
    </section>

    <section class="card">
      <h2>Trasladar DECARGO a otro servidor</h2>
      <p class="muted">Cinco pasos. Los comandos se escriben en una terminal del servidor, dentro de la carpeta de DECARGO.</p>
      <ol class="steps">
        <li v-for="s in steps" :key="s.t">
          <b>{{ s.t }}</b>
          <div v-if="s.c" class="cmd"><code class="mono">{{ s.c }}</code><button class="btn btn-sm" type="button" @click="copy(s.c)">{{ copied === s.c ? 'Copiado' : 'Copiar' }}</button></div>
          <p class="muted small">{{ s.n }}</p>
        </li>
      </ol>
    </section>
  </template>
  <FileViewer v-if="preview" :title="preview.title" :path="preview.path" :kind="preview.kind" :filename="preview.filename" @close="preview = null" />
</template>
