#!/usr/bin/env node
// DECARGO · pruebas de INTEGRACIÓN de identidad, sesiones y dispositivos (D-05). Sin mocks:
// API real (127.0.0.1), PostgreSQL real, usuarios reales creados durante la prueba.
//   node scripts/identity-test.mjs run                  → batería completa (guarda estado en STATE_FILE si se indica)
//   node scripts/identity-test.mjs restore-check        → backup, destrucción, restauración y comprobaciones posteriores
// Requiere Node >= 18 en el equipo que lanza la prueba (solo herramienta de pruebas; no forma parte del despliegue).
import { execFileSync, execSync } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ROOT);
const envFile = () => Object.fromEntries(readFileSync('.env', 'utf8').split('\n').filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.split('=')[0], l.slice(l.indexOf('=') + 1)]));
let ENV = envFile();
const PROJ = JSON.parse(execSync('docker compose config --format json', { encoding: 'utf8' })).name;   // nombre del proyecto de compose (nunca escrito a mano)
const API = () => `http://${ENV.API_BIND || '127.0.0.1'}:${ENV.API_PORT}`;
const STATE_FILE = process.env.STATE_FILE || join(ROOT, 'informes', '.identity-state.json');
const TS = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';

// ------------------------------------------------------------------ utilidades
const lines = []; let pass = 0, fail = 0;
const say = (s) => { console.log(s); lines.push(s); };
const ok = (m) => { pass++; say(`- ✅ ${m}`); };
const bad = (m) => { fail++; say(`- ❌ ${m}`); };
const info = (m) => say(`- ℹ️ ${m}`);
const check = (cond, m, detail = '') => (cond ? ok(m) : bad(`${m}${detail ? ` → ${detail}` : ''}`));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const authCalls = [];
async function paceAuth() {   // el límite de /auth es de 120/min por IP: la prueba se auto-regula para no tocarlo
  const now = Date.now();
  while (authCalls.length && now - authCalls[0] > 60_000) authCalls.shift();
  if (authCalls.length >= 100) await sleep(61_000 - (now - authCalls[0]));
  authCalls.push(Date.now());
}
async function http(method, path, { token, body, raw } = {}) {
  if (path.startsWith('/api/v1/auth/')) await paceAuth();
  const res = await fetch(API() + path, {
    method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const buf = Buffer.from(await res.arrayBuffer());
  let json = null; try { json = JSON.parse(buf.toString('utf8')); } catch { /* no JSON */ }
  return { status: res.status, json, buf, headers: res.headers, text: raw ? undefined : buf.toString('utf8').slice(0, 200) };
}
const sh = (cmd, opts = {}) => execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
const psql = (sql) => execFileSync('docker', ['compose', 'exec', '-T', 'db', 'psql', '-U', 'postgres', '-d', 'decargo', '-Atc', sql], { encoding: 'utf8' }).trim();
const psqlAs = (user, pw, sql) => {
  try { return execFileSync('docker', ['compose', 'exec', '-T', '-e', `PGPASSWORD=${pw}`, 'db', 'psql', '-h', '127.0.0.1', '-U', user, '-d', 'decargo', '-Atc', sql], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch (e) { return String(e.stderr || e.message).trim(); }
};
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
// Decodificación de QR y texto de PDF con la imagen de pruebas (poppler, zbar, cairosvg).
const TOOLS_DIR = mkdtempSync(join(tmpdir(), 'dcg-tools-'));
const inTools = (name, buf, ...cmd) => { writeFileSync(join(TOOLS_DIR, name), buf); return execFileSync('docker', ['run', '--rm', '-v', `${TOOLS_DIR}:/w:ro`, 'decargo-tools:dev', ...cmd.map((c) => c.replace('{f}', `/w/${name}`))], { encoding: 'utf8' }).trim(); };
const decodeQr = (buf, name) => inTools(name, buf, 'qrdecode', '{f}');
const pdfText = (buf) => inTools('doc.pdf', buf, 'pdftotext', '-layout', '{f}', '-');
// Texto en el orden en que se dibuja y con los espacios y saltos colapsados: no mezcla las columnas de una casilla ni se parte por el ancho.
const pdfRaw = (buf) => inTools('doc.pdf', buf, 'pdftotext', '-raw', '{f}', '-').replace(/\s+/g, ' ');
const sidOf = (access) => JSON.parse(Buffer.from(access.split('.')[1], 'base64url').toString()).sid;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const b32dec = (str) => { let bits = 0, v = 0; const o = []; for (const ch of str) { v = (v << 5) | B32.indexOf(ch); bits += 5; if (bits >= 8) { o.push((v >>> (bits - 8)) & 255); bits -= 8; } } return Buffer.from(o); };
const b32enc = (buf) => { let bits = 0, v = 0, o = ''; for (const b of buf) { v = (v << 8) | b; bits += 8; while (bits >= 5) { o += B32[(v >>> (bits - 5)) & 31]; bits -= 5; } } return bits ? o + B32[(v << (5 - bits)) & 31] : o; };
// Implementación TOTP de la PRUEBA (independiente de la del servidor): si ambas coinciden, el servidor es compatible con RFC 6238.
const totpAt = (secret, step) => { const c = Buffer.alloc(8); c.writeBigUInt64BE(BigInt(step)); const h = createHmac('sha1', b32dec(secret)).update(c).digest(); const o = h[h.length - 1] & 15; return String((((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1e6).padStart(6, '0'); };
const lastUsed = {};                                   // secreto → último paso usado (el servidor no acepta un paso ya usado)
const nowStep = () => Math.floor(Date.now() / 30000);
async function nextCode(secret) {                      // siguiente código válido y NO usado; si no hay, espera al siguiente paso
  for (;;) {
    const cur = nowStep(), last = lastUsed[secret] ?? -1;
    const step = cur > last ? cur : cur + 1 > last ? cur + 1 : null;
    if (step !== null) { lastUsed[secret] = step; return totpAt(secret, step); }
    await sleep((cur + 1) * 30000 - Date.now() + 700);
  }
}
const badCode = (secret) => { const ok = new Set([-2, -1, 0, 1, 2].map((d) => totpAt(secret, nowStep() + d))); let c; do { c = String(Math.floor(Math.random() * 1e6)).padStart(6, '0'); } while (ok.has(c)); return c; };
const sfx = randomBytes(3).toString('hex');
const PW = () => `Ruta-${randomBytes(3).toString('hex')}-Larga-${randomBytes(2).toString('hex')}`;   // fuerte y distinta cada vez
const secretsSeen = new Set();                 // todo secreto en claro generado por la prueba (para buscarlo en la BD y los logs)
const keep = (...v) => v.forEach((x) => x && secretsSeen.add(x));

async function newUser(token, role, base) {
  const username = `${base}-${sfx}`;
  const r = await http('POST', '/api/v1/users', { token, body: { username, full_name: `Prueba ${base}`, role } });
  if (r.status === 201) keep(r.json.activation_code);
  return { r, username, id: r.json?.id, code: r.json?.activation_code };
}
async function activate(u, password, label = 'telefono-1', totpCode) {
  keep(password);
  const r = await http('POST', '/api/v1/auth/activate', { body: { username: u.username, code: u.code, password, device_label: label, ...(totpCode ? { totp_code: totpCode } : {}) } });
  if (r.status === 200) keep(r.json.access_token, r.json.refresh_token, r.json.device.secret);
  u.password = password;
  return r;
}
async function loginAs(u, device, label, opts = {}) {
  const totp = opts.totp !== undefined ? opts.totp : (u.totpSecret ? await nextCode(u.totpSecret) : undefined);
  const r = await http('POST', '/api/v1/auth/login', { body: { username: u.username, password: u.password, ...(totp ? { totp_code: totp } : {}), ...(device ? { device } : {}), ...(label ? { device_label: label } : {}) } });
  if (r.status === 200) keep(r.json.access_token, r.json.refresh_token, r.json.device.secret);
  return r;
}
async function enrollTotp(u, token) {                 // alta del segundo factor: setup → código → enable
  const setup = await http('POST', '/api/v1/auth/totp/setup', { token });
  if (setup.status !== 200) return { setup };
  u.totpSecret = setup.json.secret; keep(setup.json.secret);
  const enable = await http('POST', '/api/v1/auth/totp/enable', { token, body: { code: await nextCode(u.totpSecret) } });
  return { setup, enable };
}
const devCreds = (r) => ({ id: r.json.device.id, secret: r.json.device.secret });
const resetThrottle = () => psql('DELETE FROM login_throttle');
const createTestDeca = async () => (await fetch(`${API()}/api/v1/dev/test-deca`, { method: 'POST', headers: { authorization: `Bearer ${ENV.DEV_API_KEY}` } }).then((r) => r.json()));
const section = (t) => { say(''); say(`## ${t}`); };

// ------------------------------------------------------------------ batería completa
async function run() {
  say(`# Pruebas de integración de identidad · ${TS}`);

  section('1. Creación del primer administrador y activación');
  const out = sh(`./deca create-user --username adm-${sfx} --name "Administrador de prueba" --role admin --company-name "Empresa de prueba DECARGO" --company-nif B00000000 --company-address "Calle de prueba 1"`);
  const created = JSON.parse(out.slice(out.indexOf('{')));
  const admin = { username: `adm-${sfx}`, code: created.activation_code }; keep(admin.code);
  check(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/.test(admin.code), 'el CLI entrega una vez el código de activación (16 caracteres, 80 bits)');
  const u0 = psql(`SELECT active, password_hash IS NULL, role FROM app_user WHERE username='${admin.username}'`);
  check(u0 === 't|t|admin', 'el usuario nace activo, sin contraseña y con rol admin', u0);
  const tokenRow = psql(`SELECT secret_hash LIKE '$argon2id$%', secret_hash <> '${admin.code}' FROM activation_token a JOIN app_user u ON u.id=a.user_id WHERE u.username='${admin.username}'`);
  check(tokenRow === 't|t', 'la credencial temporal se guarda solo como hash Argon2id (no en claro)', tokenRow);

  const ghost = await http('POST', '/api/v1/auth/activate', { body: { username: `fantasma-${sfx}`, code: 'AAAA-BBBB-CCCC-DDDD', password: 'Una-clave-larga-123' } });
  const wrongCode = await http('POST', '/api/v1/auth/activate', { body: { username: admin.username, code: 'AAAA-BBBB-CCCC-DDDD', password: 'Una-clave-larga-123' } });
  check(ghost.status === 401 && wrongCode.status === 401 && JSON.stringify(ghost.json) === JSON.stringify(wrongCode.json), 'activación con código incorrecto: misma respuesta que para un usuario inexistente (sin enumeración)', `${ghost.status}/${wrongCode.status}`);
  for (const [pw, reason] of [['password123', 'too_common'], ['corta1', 'too_short'], [`${admin.username}-2026x`, 'contains_username'], ['aaaaaaaaaaaa', 'repetitive'], ['1234567890', 'too_common']]) {
    const r = await http('POST', '/api/v1/auth/activate', { body: { username: admin.username, code: admin.code, password: pw } });
    check(r.status === 400 && r.json.error === 'weak_password', `contraseña rechazada (${reason}): "${pw.slice(0, 14)}"`, `${r.status} ${JSON.stringify(r.json)}`);
  }
  check(psql(`SELECT used_at IS NULL FROM activation_token a JOIN app_user u ON u.id=a.user_id WHERE u.username='${admin.username}'`) === 't', 'una contraseña débil NO consume la credencial temporal');
  admin.password = PW();
  const act = await activate(admin, admin.password, 'pc-admin');
  check(act.status === 200 && act.json.scope === 'MFA_PENDING' && act.json.device.status === 'AUTORIZADO' && act.json.device.secret, 'activación correcta: contraseña definitiva + primer dispositivo AUTORIZADO; el administrador queda en MFA_PENDING hasta configurar el TOTP');
  admin.device = devCreds(act); admin.token = act.json.access_token;
  const adminEn = await enrollTotp(admin, admin.token);
  check(adminEn.enable?.status === 200 && adminEn.enable.json.scope === 'FULL', 'el administrador configura su TOTP y su sesión pasa a FULL');
  const hashRow = psql(`SELECT password_hash LIKE '$argon2id$v=19$m=19456,t=2,p=1$%' FROM app_user WHERE username='${admin.username}'`);
  check(hashRow === 't', 'la contraseña se guarda con Argon2id (m=19456, t=2, p=1)');
  const reuse = await http('POST', '/api/v1/auth/activate', { body: { username: admin.username, code: admin.code, password: PW() } });
  check(reuse.status === 401, 'la credencial temporal es de UN SOLO USO: reutilizarla falla', String(reuse.status));
  check(psql(`SELECT used_at IS NOT NULL FROM activation_token a JOIN app_user u ON u.id=a.user_id WHERE u.username='${admin.username}'`) === 't', 'credencial invalidada tras su uso correcto');

  section('2. Roles y permisos de gestión de usuarios');
  const ofi = await newUser(admin.token, 'oficina', 'ofi'); check(ofi.r.status === 201, 'admin crea usuario oficina');
  const ro = await newUser(admin.token, 'solo_lectura', 'ro'); check(ro.r.status === 201, 'admin crea usuario solo_lectura');
  const dup = await newUser(admin.token, 'oficina', 'ofi'); check(dup.r.status === 409, 'nombre de usuario duplicado → 409', String(dup.r.status));
  const badRole = await http('POST', '/api/v1/users', { token: admin.token, body: { username: `x-${sfx}`, full_name: 'x', role: 'superadmin' } });
  check(badRole.status === 400, 'rol inexistente → 400');
  // expiración de la credencial temporal
  const ofiAct = ofi.code;
  psql(`UPDATE activation_token SET expires_at = now() - interval '1 minute' WHERE user_id='${ofi.id}'`);
  const expired = await http('POST', '/api/v1/auth/activate', { body: { username: ofi.username, code: ofiAct, password: PW() } });
  check(expired.status === 401, 'credencial temporal CADUCADA → rechazada');
  const re = await http('POST', `/api/v1/users/${ofi.id}/activation`, { token: admin.token });
  check(re.status === 200 && re.json.activation_code && re.json.activation_code !== ofiAct, 'admin reemite una credencial nueva'); keep(re.json.activation_code);
  const oldAfterReissue = await http('POST', '/api/v1/auth/activate', { body: { username: ofi.username, code: ofiAct, password: PW() } });
  check(oldAfterReissue.status === 401, 'la credencial anterior queda invalidada al reemitir');
  ofi.code = re.json.activation_code; ofi.password = PW();
  const ofiAc = await activate(ofi, ofi.password, 'pc-oficina'); check(ofiAc.status === 200, 'oficina activa su cuenta'); ofi.token = ofiAc.json.access_token; ofi.device = devCreds(ofiAc);
  check((await enrollTotp(ofi, ofi.token)).enable?.status === 200, 'oficina configura su TOTP');
  ro.password = PW(); ro.code = ro.code; const roAc = await activate(ro, ro.password, 'pc-lectura'); check(roAc.status === 200, 'solo_lectura activa su cuenta'); ro.token = roAc.json.access_token;
  check((await enrollTotp(ro, ro.token)).enable?.status === 200, 'solo_lectura configura su TOTP');
  // intentos de activación
  const brute = await newUser(admin.token, 'conductor', 'brute');
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await http('POST', '/api/v1/auth/activate', { body: { username: brute.username, code: 'ZZZZ-ZZZZ-ZZZZ-ZZZ' + i, password: PW() } })).status);
  const during = await http('POST', '/api/v1/auth/activate', { body: { username: brute.username, code: brute.code, password: PW() } });
  check(codes.every((c) => c === 401) && during.status === 429 && during.headers.get('retry-after'), '5 intentos fallidos de activación → bloqueo temporal (429 + Retry-After), ni siquiera el código bueno pasa', `${codes} / ${during.status}`);
  resetThrottle();
  const afterMax = await http('POST', '/api/v1/auth/activate', { body: { username: brute.username, code: brute.code, password: PW() } });
  check(afterMax.status === 401, 'tras 5 intentos fallidos la credencial queda agotada: hay que reemitirla', String(afterMax.status));

  // oficina crea conductores; límites de rol
  const c1 = await newUser(ofi.token, 'conductor', 'cond1'); check(c1.r.status === 201, 'oficina crea conductor');
  const c2 = await newUser(ofi.token, 'conductor', 'cond2'); check(c2.r.status === 201, 'oficina crea otro conductor');
  for (const [role, who] of [['admin', 'admin'], ['oficina', 'oficina'], ['solo_lectura', 'solo_lectura']]) {
    const r = await http('POST', '/api/v1/users', { token: ofi.token, body: { username: `no-${who}-${sfx}`, full_name: 'x', role } });
    check(r.status === 403, `oficina NO puede crear usuarios ${who}`, String(r.status));
  }
  check((await http('POST', '/api/v1/users', { token: ro.token, body: { username: `no-ro-${sfx}`, full_name: 'x', role: 'conductor' } })).status === 403, 'solo_lectura NO puede crear usuarios');
  const listOfi = await http('GET', '/api/v1/users', { token: ofi.token }); const listAdm = await http('GET', '/api/v1/users', { token: admin.token });
  check(listOfi.json.every((u) => u.role === 'conductor') && listAdm.json.some((u) => u.role === 'admin'), 'oficina solo ve conductores; admin ve todos');
  check(!JSON.stringify(listAdm.json).includes('password_hash'), 'el listado de usuarios no expone hashes');

  section('2 bis. Segundo factor TOTP de oficina (RFC 6238)');
  const rfcSecret = b32enc(Buffer.from('12345678901234567890'));
  check([[59, '287082'], [1111111109, '081804'], [1234567890, '005924'], [2000000000, '279037']].every(([t, c]) => totpAt(rfcSecret, Math.floor(t / 30)) === c), 'el generador de la prueba reproduce los vectores del RFC 6238 (implementación independiente de la del servidor)');
  const of2 = await newUser(admin.token, 'oficina', 'ofi2'); of2.password = PW();
  const of2a = await activate(of2, of2.password, 'pc-ofi2');
  check(of2a.status === 200 && of2a.json.scope === 'MFA_PENDING' && of2a.json.mfa_required === true, 'usuario de oficina recién activado: sesión con alcance MFA_PENDING');
  const tk = of2a.json.access_token;
  const blocked = [];
  for (const [m, p, b] of [['GET', '/api/v1/users'], ['GET', '/api/v1/devices'], ['GET', '/api/v1/transports'], ['POST', '/api/v1/users', { username: `x-${sfx}`, full_name: 'x', role: 'conductor' }], ['GET', '/api/v1/decas/00000000-0000-4000-8000-000000000000']]) { const r = await http(m, p, { token: tk, body: b }); blocked.push(r.status === 403 && r.json.error === 'mfa_required'); }
  check(blocked.every(Boolean), 'MFA_PENDING: las 5 funciones de oficina (usuarios, dispositivos, transportes, alta de usuario, DeCA) devuelven 403 mfa_required (el segundo factor no se puede saltar)');
  check((await http('GET', '/api/v1/audit', { token: tk })).status === 403, 'MFA_PENDING: la auditoría (solo admin) también devuelve 403');
  check((await http('GET', '/api/v1/me', { token: tk })).json.mfa_required === true, '/me informa de que falta el segundo factor');
  check((await http('POST', '/api/v1/auth/totp/enable', { token: tk, body: { code: '123456' } })).json.error === 'no_pending_setup', 'confirmar sin haber iniciado el alta → 409 no_pending_setup');
  const st = await http('POST', '/api/v1/auth/totp/setup', { token: tk });
  check(st.status === 200 && st.json.otpauth_uri.startsWith(`otpauth://totp/DECARGO:${of2.username}`) && /^[A-Z2-7]{32}$/.test(st.json.secret) && st.json.qr_svg.includes('<svg'), 'alta: secreto de 160 bits, URI otpauth:// y QR SVG para la aplicación autenticadora');
  of2.totpSecret = st.json.secret; keep(of2.totpSecret);
  check((await http('POST', '/api/v1/auth/totp/enable', { token: tk, body: { code: badCode(of2.totpSecret) } })).status === 401, 'confirmar con un código incorrecto → 401 y el TOTP sigue sin activarse');
  check((await http('GET', '/api/v1/users', { token: tk })).status === 403, 'sigue bloqueado hasta confirmar');
  const en = await http('POST', '/api/v1/auth/totp/enable', { token: tk, body: { code: await nextCode(of2.totpSecret) } });
  check(en.status === 200 && en.json.scope === 'FULL', 'confirmar con un código correcto → TOTP activado y la MISMA sesión pasa a FULL');
  check((await http('GET', '/api/v1/users', { token: tk })).status === 200, 'ya puede usar las funciones de oficina con ese token');
  check((await http('POST', '/api/v1/auth/totp/setup', { token: tk })).json.error === 'totp_already_enabled', 'con el TOTP activo no se puede volver a hacer el alta (un atacante con una sesión no puede sustituir el autenticador)');
  const encRow = psql(`SELECT totp_secret_enc IS NOT NULL, totp_secret_enc <> '${of2.totpSecret}', totp_enabled_at IS NOT NULL FROM app_user WHERE username='${of2.username}'`);
  check(encRow === 't|t|t', 'el secreto TOTP se guarda cifrado (no en claro)', encRow);
  // inicio de sesión con segundo factor
  const cnt = () => psql(`SELECT (SELECT count(*) FROM device WHERE user_id='${of2.id}')||'/'||(SELECT count(*) FROM session WHERE user_id='${of2.id}')`);
  const before2 = cnt();
  const noCode = await http('POST', '/api/v1/auth/login', { body: { username: of2.username, password: of2.password } });
  const wrongTotp = await http('POST', '/api/v1/auth/login', { body: { username: of2.username, password: of2.password, totp_code: badCode(of2.totpSecret) } });
  check(noCode.status === 401 && noCode.json.error === 'totp_required' && wrongTotp.status === 401 && wrongTotp.json.error === 'invalid_totp', 'login con contraseña correcta pero sin código / con código erróneo → 401 (totp_required / invalid_totp)');
  check(cnt() === before2, `sin segundo factor NO se crea sesión ni dispositivo (antes y después: ${before2} dispositivos/sesiones)`);
  const c1code = await nextCode(of2.totpSecret);
  const good2 = await http('POST', '/api/v1/auth/login', { body: { username: of2.username, password: of2.password, totp_code: c1code, device_label: 'pc-ofi2-b' } }); keep(good2.json?.refresh_token, good2.json?.access_token, good2.json?.device?.secret);
  check(good2.status === 200 && good2.json.scope === 'FULL' && good2.json.mfa_required === false, 'login con contraseña + código correcto → sesión FULL');
  const replay = await http('POST', '/api/v1/auth/login', { body: { username: of2.username, password: of2.password, totp_code: c1code } });
  check(replay.status === 401 && replay.json.error === 'invalid_totp', 'ANTI-REPETICIÓN: reutilizar el mismo código (aunque siga vigente) → 401');
  check((await loginAs(of2, null, 'pc-ofi2-c')).status === 200, 'el siguiente código sí se acepta');
  const foreign = await http('POST', '/api/v1/auth/login', { body: { username: of2.username, password: of2.password, totp_code: await nextCode(ofi.totpSecret) } });
  check(foreign.status === 401, 'un código válido de OTRO usuario no sirve');
  resetThrottle(); const tb = [];
  for (let i = 0; i < 6; i++) tb.push(await http('POST', '/api/v1/auth/login', { body: { username: of2.username, password: of2.password, totp_code: badCode(of2.totpSecret) } }));
  check(tb.slice(0, 5).every((r) => r.status === 401) && tb[5].status === 429 && tb[5].headers.get('retry-after'), 'fuerza bruta sobre el código TOTP: 5 fallos → 429 con Retry-After', tb.map((r) => r.status).join(','));
  check((await loginAs(of2, null)).status === 429, 'durante el bloqueo ni el código correcto entra');
  resetThrottle();
  // refresh conserva el alcance; sesión sin MFA no se eleva sola
  const rfo = await http('POST', '/api/v1/auth/refresh', { body: { refresh_token: good2.json.refresh_token } }); keep(rfo.json?.refresh_token);
  check(rfo.status === 200 && rfo.json.scope === 'FULL', 'refresh de una sesión con segundo factor mantiene FULL');
  const of3 = await newUser(admin.token, 'oficina', 'ofi3'); of3.password = PW(); const of3a = await activate(of3, of3.password, 'pc-ofi3');
  const rp = await http('POST', '/api/v1/auth/refresh', { body: { refresh_token: of3a.json.refresh_token } });
  check(rp.status === 200 && rp.json.scope === 'MFA_PENDING', 'refresh de una sesión SIN segundo factor sigue en MFA_PENDING (refrescar no la eleva)');
  psql(`UPDATE session SET mfa_at = NULL WHERE id='${sidOf(good2.json.access_token)}'`);
  const premfa = await http('GET', '/api/v1/users', { token: good2.json.access_token });
  check(premfa.status === 403 && premfa.json.error === 'mfa_required', 'una sesión de oficina sin constancia de segundo factor (p. ej. anterior a esta versión) queda en MFA_PENDING');
  // reinicio del TOTP
  check((await http('POST', `/api/v1/users/${of2.id}/totp/reset`, { token: ofi.token })).status === 403, 'oficina NO puede reiniciar el TOTP de nadie');
  const adminId = psql(`SELECT id FROM app_user WHERE username='${admin.username}'`);
  check((await http('POST', `/api/v1/users/${adminId}/totp/reset`, { token: admin.token })).status === 403, 'el administrador no puede reiniciar su PROPIO TOTP (403)');
  const oldTok = tk;
  check((await http('POST', `/api/v1/users/${of2.id}/totp/reset`, { token: admin.token })).status === 204, 'un administrador reinicia el TOTP de otro usuario (autenticador perdido)');
  check((await http('GET', '/api/v1/users', { token: oldTok })).status === 401, 'el reinicio revoca las sesiones del usuario');
  const oldSecret = of2.totpSecret; delete of2.totpSecret;
  const afterReset = await loginAs(of2, null, 'pc-ofi2-d');
  check(afterReset.status === 200 && afterReset.json.scope === 'MFA_PENDING', 'tras el reinicio, el login solo con contraseña da MFA_PENDING (hay que configurar un TOTP nuevo)');
  const st2 = await http('POST', '/api/v1/auth/totp/setup', { token: afterReset.json.access_token }); keep(st2.json?.secret);
  check((await http('POST', '/api/v1/auth/totp/enable', { token: afterReset.json.access_token, body: { code: totpAt(oldSecret, nowStep()) } })).status === 401, 'el secreto ANTERIOR ya no vale para confirmar el alta nueva');
  of2.totpSecret = st2.json.secret;
  check((await http('POST', '/api/v1/auth/totp/enable', { token: afterReset.json.access_token, body: { code: await nextCode(of2.totpSecret) } })).status === 200, 'alta del TOTP nuevo completada');
  // restablecimiento de contraseña con TOTP activo
  const re2 = await http('POST', `/api/v1/users/${of2.id}/activation`, { token: admin.token }); keep(re2.json.activation_code);
  of2.code = re2.json.activation_code; const newPw = PW(); const oldPw = of2.password;
  const a1x = await activate(of2, newPw, 'pc-ofi2-e');
  check(a1x.status === 401 && a1x.json.error === 'totp_required', 'reemitir la credencial NO salta el segundo factor: sin código TOTP → 401 totp_required');
  const a2x = await activate(of2, newPw, 'pc-ofi2-e', badCode(of2.totpSecret));
  check(a2x.status === 401 && a2x.json.error === 'invalid_totp', 'con código TOTP erróneo → 401 invalid_totp');
  check(psql(`SELECT count(*) FROM activation_token WHERE user_id='${of2.id}' AND used_at IS NULL AND superseded_at IS NULL`) === '1', 'la credencial de activación NO se consume mientras falle el segundo factor');
  const a3x = await activate(of2, newPw, 'pc-ofi2-e', await nextCode(of2.totpSecret));
  check(a3x.status === 200 && a3x.json.scope === 'FULL', 'con contraseña nueva + credencial + código TOTP → sesión FULL');
  of2.password = newPw;
  check((await http('POST', '/api/v1/auth/login', { body: { username: of2.username, password: oldPw, totp_code: await nextCode(of2.totpSecret) } })).status === 401, 'la contraseña anterior deja de valer');
  // CLI de recuperación
  sh(`./deca reset-totp --username ${of2.username}`); delete of2.totpSecret;
  check((await loginAs(of2, null, 'pc-ofi2-f')).json?.scope === 'MFA_PENDING', 'recuperación por CLI (./deca reset-totp): vuelve a exigir el alta');

  section('3. Transportes y asignación');
  const T1 = await createTestDeca(), T2 = await createTestDeca(), T3 = await createTestDeca();
  check(T1.deca_id && T2.deca_id && T3.deca_id, 'tres transportes con DeCA creados (T1, T2, T3)');
  for (const [tok, who] of [[ro.token, 'solo_lectura']]) check((await http('POST', `/api/v1/transports/${T1.transport_id}/assign-driver`, { token: tok, body: { driver_id: c1.id } })).status === 403, `${who} NO puede asignar conductores`);
  check((await http('POST', `/api/v1/transports/${T1.transport_id}/assign-driver`, { token: ofi.token, body: { driver_id: c1.id } })).status === 204, 'oficina asigna T1 → conductor 1');
  check((await http('POST', `/api/v1/transports/${T2.transport_id}/assign-driver`, { token: ofi.token, body: { driver_id: c2.id } })).status === 204, 'oficina asigna T2 → conductor 2');
  check((await http('POST', `/api/v1/transports/${T3.transport_id}/assign-driver`, { token: ofi.token, body: { driver_id: ro.id } })).status === 404, 'no se puede asignar un transporte a un usuario que no es conductor');

  section('4. Primer dispositivo del conductor (activación → AUTORIZADO)');
  c1.password = PW(); const a1 = await activate(c1, c1.password, 'movil-conductor-1');
  check(a1.status === 200 && a1.json.scope === 'FULL' && a1.json.device.status === 'AUTORIZADO', 'conductor 1: activación → primer dispositivo AUTORIZADO');
  c1.d1 = devCreds(a1); c1.tok1 = a1.json.access_token;
  c2.password = PW(); const a2 = await activate(c2, c2.password, 'movil-conductor-2'); check(a2.status === 200, 'conductor 2 activado'); c2.d1 = devCreds(a2); c2.tok = a2.json.access_token;
  const tl = await http('GET', '/api/v1/driver/transports', { token: c1.tok1 });
  check(tl.status === 200 && tl.json.length === 1 && tl.json[0].id === T1.transport_id, 'dispositivo autorizado: ve SOLO su transporte (T1)', JSON.stringify(tl.json?.map?.((x) => x.id)));
  const pdf1 = await http('GET', `/api/v1/driver/decas/${T1.deca_id}/current.pdf`, { token: c1.tok1 });
  check(pdf1.status === 200 && pdf1.headers.get('content-type') === 'application/pdf' && sha256(pdf1.buf) === T1.sha256, 'obtiene el PDF vigente de su DeCA y su SHA-256 coincide con el registrado');
  const qr1 = await http('GET', `/api/v1/driver/decas/${T1.deca_id}/qr.svg`, { token: c1.tok1 });
  check(qr1.status === 200 && qr1.buf.toString().includes('<svg'), 'obtiene el QR de su DeCA (SVG)');
  const qrUrl1 = decodeQr((await http('GET', `/api/v1/driver/decas/${T1.deca_id}/qr.svg`, { token: c1.tok1 })).buf, 'qr1.svg');
  const viaDocs = await fetch(qrUrl1).then(async (r) => ({ s: r.status, h: sha256(Buffer.from(await r.arrayBuffer())) }));
  check(viaDocs.s === 200 && viaDocs.h === T1.sha256, 'el QR que recibe el conductor apunta a la URL del servicio docs, que sirve el mismo PDF');
  check((await http('GET', '/api/v1/me', { token: c1.tok1 })).json.scope === 'FULL', '/me: alcance FULL');

  section('5. Teléfono nuevo con credenciales correctas → PENDIENTE (D-05)');
  const snapBefore = psql(`SELECT md5(string_agg(t.id::text||t.status, ',' ORDER BY t.id)) FROM transport t`) + '|' + psql(`SELECT md5(string_agg(v.sha256||v.version_no, ',' ORDER BY v.deca_id, v.version_no)) FROM deca_version v`) + '|' + psql(`SELECT md5(string_agg(a.id::text||coalesce(a.valid_to::text,''), ',' ORDER BY a.id)) FROM transport_driver_assignment a`);
  const p1 = await loginAs(c1, null, 'movil-nuevo');
  check(p1.status === 200 && p1.json.scope === 'LIMITED' && p1.json.device.status === 'PENDIENTE_DE_CONFIRMACION', 'credenciales correctas + dispositivo desconocido → PENDIENTE_DE_CONFIRMACION con sesión LIMITADA (no se bloquea al conductor)');
  c1.pend = devCreds(p1); c1.pendTok = p1.json.access_token; c1.pendRef = p1.json.refresh_token; c1.pendDeviceId = p1.json.device.id;
  const hrs = (new Date(p1.json.session_expires_at) - Date.now()) / 3600_000;
  check(hrs > 71.9 && hrs <= 72.0, `la sesión provisional dura 72 h (real: ${hrs.toFixed(2)} h)`);
  info(`access token: ${p1.json.access_expires_in} s · refresh hasta ${p1.json.refresh_expires_at} · sesión hasta ${p1.json.session_expires_at}`);
  const pl = await http('GET', '/api/v1/driver/transports', { token: c1.pendTok });
  check(pl.status === 200 && pl.json.length === 1 && pl.json[0].id === T1.transport_id, 'pendiente: ve SOLO sus transportes ya asignados (T1)');
  const ppdf = await http('GET', `/api/v1/driver/decas/${T1.deca_id}/current.pdf`, { token: c1.pendTok });
  check(ppdf.status === 200 && sha256(ppdf.buf) === T1.sha256, 'pendiente: obtiene el DeCA vigente de T1 (hash correcto)');
  check((await http('GET', `/api/v1/driver/decas/${T1.deca_id}/qr.svg`, { token: c1.pendTok })).status === 200, 'pendiente: muestra el QR de T1');
  // IDOR
  const idor = [];
  for (const [p, d] of [[`/api/v1/driver/transports/${T2.transport_id}`, 'transporte de OTRO conductor'], [`/api/v1/driver/decas/${T2.deca_id}/current.pdf`, 'PDF del DeCA de otro conductor'],
                        [`/api/v1/driver/decas/${T2.deca_id}/qr.svg`, 'QR del DeCA de otro conductor'], [`/api/v1/driver/transports/${T3.transport_id}`, 'transporte sin asignar'],
                        ['/api/v1/driver/transports/00000000-0000-4000-8000-000000000000', 'UUID inexistente'], ['/api/v1/driver/transports/no-es-uuid', 'id mal formado'],
                        [`/api/v1/driver/decas/${T2.deca_id}%27%20OR%201=1--/current.pdf`, 'inyección en el id']]) {
    for (const [tok, nm] of [[c1.pendTok, 'pendiente'], [c1.tok1, 'autorizado']]) { const r = await http('GET', p, { token: tok }); idor.push(r.status); if (r.status !== 404) bad(`IDOR (${nm}): ${d} → ${r.status}`); }
  }
  check(idor.every((s) => s === 404), `IDOR: ${idor.length} intentos sobre recursos ajenos o inexistentes → todos 404 (no se revela su existencia)`);
  // funciones de oficina
  const forb = [['GET', '/api/v1/users'], ['POST', '/api/v1/users', { username: `z-${sfx}`, full_name: 'z', role: 'conductor' }], ['GET', '/api/v1/devices'], ['POST', `/api/v1/devices/${c1.pendDeviceId}/authorize`],
                ['POST', `/api/v1/devices/${c1.pendDeviceId}/revoke`], ['GET', '/api/v1/audit'], ['GET', '/api/v1/transports'], ['POST', `/api/v1/transports/${T1.transport_id}/assign-driver`, { driver_id: c1.id }],
                ['GET', `/api/v1/decas/${T1.deca_id}`], ['GET', `/api/v1/decas/${T1.deca_id}/versions/1/pdf`], ['POST', `/api/v1/users/${c2.id}/deactivate`], ['POST', `/api/v1/users/${c2.id}/activation`],
                ['POST', '/api/v1/auth/totp/setup'], ['POST', '/api/v1/auth/totp/enable', { code: '123456' }], ['POST', `/api/v1/users/${c2.id}/totp/reset`]];
  for (const [tok, nm] of [[c1.pendTok, 'pendiente'], [c1.tok1, 'autorizado']]) {
    const codes = []; for (const [m, p, b] of forb) codes.push((await http(m, p, { token: tok, body: b })).status);
    check(codes.every((c) => c === 403), `conductor ${nm}: ${forb.length} endpoints de oficina/admin/auditoría → todos 403`, codes.join(','));
  }
  // nada de modificar
  const modif = [];
  for (const [m, p] of [['POST', `/api/v1/driver/transports/${T1.transport_id}/finish`], ['PATCH', `/api/v1/driver/transports/${T1.transport_id}`], ['PUT', `/api/v1/driver/transports/${T1.transport_id}`],
                        ['DELETE', `/api/v1/driver/transports/${T1.transport_id}`], ['POST', `/api/v1/decas/${T1.deca_id}/modify`]]) modif.push((await http(m, p, { token: c1.pendTok, body: m === 'DELETE' ? undefined : {} })).status);
  check(modif.every((s) => s === 404 || s === 403), 'pendiente: finalizar y modificar datos legales → no existen / prohibidos (el DeCA externo se habilita aparte, sección 15)', modif.join(','));
  const snapAfter = psql(`SELECT md5(string_agg(t.id::text||t.status, ',' ORDER BY t.id)) FROM transport t`) + '|' + psql(`SELECT md5(string_agg(v.sha256||v.version_no, ',' ORDER BY v.deca_id, v.version_no)) FROM deca_version v`) + '|' + psql(`SELECT md5(string_agg(a.id::text||coalesce(a.valid_to::text,''), ',' ORDER BY a.id)) FROM transport_driver_assignment a`);
  check(snapBefore === snapAfter, 'tras todos esos intentos, transportes, DeCA y asignaciones siguen EXACTAMENTE igual (huella de BD idéntica)');
  // sin token / token manipulado
  check((await http('GET', '/api/v1/driver/transports')).status === 401, 'sin token → 401');
  check((await http('GET', '/api/v1/driver/transports', { token: 'basura' })).status === 401, 'token basura → 401');
  const tam = c1.pendTok.split('.'); tam[1] = Buffer.from(JSON.stringify({ sid: sidOf(c1.tok1), exp: 9999999999 })).toString('base64url');
  check((await http('GET', '/api/v1/driver/transports', { token: tam.join('.') })).status === 401, 'token manipulado (sid y exp cambiados) → 401 (firma inválida)');
  // asignación posterior al registro
  check((await http('POST', `/api/v1/transports/${T3.transport_id}/assign-driver`, { token: ofi.token, body: { driver_id: c1.id } })).status === 204, 'oficina asigna T3 al conductor 1 DESPUÉS de registrarse el teléfono nuevo');
  const pl2 = await http('GET', '/api/v1/driver/transports', { token: c1.pendTok }); const al2 = await http('GET', '/api/v1/driver/transports', { token: c1.tok1 });
  check(pl2.json.length === 1 && pl2.json[0].id === T1.transport_id, 'pendiente: NO ve T3 (asignado después de registrarse)');
  check(al2.json.length === 2, 'autorizado: ve T1 y T3');
  check((await http('GET', `/api/v1/driver/decas/${T3.deca_id}/current.pdf`, { token: c1.pendTok })).status === 404, 'pendiente: tampoco puede pedir el PDF de T3 directamente');

  section('6. La oficina AUTORIZA el dispositivo pendiente');
  const pend = await http('GET', '/api/v1/devices?status=PENDIENTE_DE_CONFIRMACION', { token: ofi.token });
  check(pend.status === 200 && pend.json.some((d) => d.id === c1.pendDeviceId), 'oficina ve «NUEVO DISPOSITIVO PENDIENTE» (listado con estado)');
  check((await http('POST', `/api/v1/devices/${c1.pendDeviceId}/authorize`, { token: ofi.token })).status === 204, 'oficina AUTORIZA');
  const me = await http('GET', '/api/v1/me', { token: c1.pendTok });
  check(me.json.scope === 'FULL' && me.json.device.status === 'AUTORIZADO', 'la sesión que ya tenía el teléfono pasa a FULL sin volver a iniciar sesión (el alcance se calcula en el servidor)');
  const pl3 = await http('GET', '/api/v1/driver/transports', { token: c1.pendTok }); check(pl3.json.length === 2, 'ya ve también T3');
  const rf = await http('POST', '/api/v1/auth/refresh', { body: { refresh_token: c1.pendRef } }); keep(rf.json?.access_token, rf.json?.refresh_token);
  const hrs2 = (new Date(rf.json.session_expires_at) - Date.now()) / 86400_000;
  check(rf.status === 200 && rf.json.scope === 'FULL' && hrs2 > 89 && hrs2 <= 90, `tras autorizar, el refresh amplía la sesión a la política de dispositivo autorizado (${hrs2.toFixed(1)} días)`);
  check((await http('POST', `/api/v1/devices/${c1.pendDeviceId}/authorize`, { token: ofi.token })).status === 409, 'autorizar un dispositivo ya autorizado → 409');
  check((await http('POST', `/api/v1/devices/${admin.device.id}/revoke`, { token: ofi.token })).status === 404, 'oficina no puede tocar dispositivos de un admin (404)');
  c1.pendTok = rf.json.access_token; c1.pendRef = rf.json.refresh_token;

  section('7. La oficina REVOCA el dispositivo');
  check((await http('POST', `/api/v1/devices/${c1.pendDeviceId}/revoke`, { token: ofi.token })).status === 204, 'oficina REVOCA el dispositivo');
  check((await http('GET', '/api/v1/driver/transports', { token: c1.pendTok })).status === 401, 'el access token de ese dispositivo deja de funcionar al instante');
  check((await http('POST', '/api/v1/auth/refresh', { body: { refresh_token: c1.pendRef } })).status === 401, 'el refresh token deja de funcionar');
  const rev = await loginAs(c1, c1.pend);
  check(rev.status === 403 && rev.json.error === 'device_revoked', 'iniciar sesión desde el dispositivo revocado → 403 device_revoked');
  check(psql(`SELECT count(*) FROM session WHERE device_id='${c1.pendDeviceId}' AND revoked_at IS NULL`) === '0', 'todas las sesiones de ese dispositivo quedan revocadas en la base de datos');
  check((await http('GET', '/api/v1/driver/transports', { token: c1.tok1 })).status === 200, 'el OTRO dispositivo autorizado del mismo conductor sigue funcionando (la revocación es por dispositivo)');

  section('8. Credenciales incorrectas, usuario inexistente, desactivado y fuerza bruta');
  const wrong = await http('POST', '/api/v1/auth/login', { body: { username: c2.username, password: 'Clave-equivocada-123' } });
  const nouser = await http('POST', '/api/v1/auth/login', { body: { username: `no-existe-${sfx}`, password: 'Clave-equivocada-123' } });
  check(wrong.status === 401 && nouser.status === 401 && JSON.stringify(wrong.json) === JSON.stringify(nouser.json), 'contraseña incorrecta y usuario inexistente: MISMA respuesta (sin enumeración de usuarios)', `${wrong.status} ${JSON.stringify(wrong.json)} / ${nouser.status} ${JSON.stringify(nouser.json)}`);
  const timeIt = async (u) => { const t = []; for (let i = 0; i < 3; i++) { const s = process.hrtime.bigint(); await http('POST', '/api/v1/auth/login', { body: { username: u, password: 'Clave-equivocada-123' } }); t.push(Number(process.hrtime.bigint() - s) / 1e6); } return t.sort((a, b) => a - b)[1]; };
  resetThrottle(); const tEx = await timeIt(c2.username); resetThrottle(); const tNo = await timeIt(`otro-inexistente-${sfx}`);
  info(`tiempo de respuesta (mediana, ms): usuario existente ${tEx.toFixed(0)} · inexistente ${tNo.toFixed(0)} (se verifica un hash ficticio para igualarlos)`); resetThrottle();
  // desactivado
  check((await http('GET', '/api/v1/driver/transports', { token: c2.tok })).status === 200, 'conductor 2 con sesión válida antes de desactivarlo');
  const c2ref = a2.json.refresh_token;
  check((await http('POST', `/api/v1/users/${c2.id}/deactivate`, { token: ofi.token })).status === 204, 'oficina desactiva al conductor 2');
  check((await http('GET', '/api/v1/driver/transports', { token: c2.tok })).status === 401, 'usuario desactivado: pierde el acceso al instante aunque conserve el token');
  check((await http('POST', '/api/v1/auth/refresh', { body: { refresh_token: c2ref } })).status === 401, 'usuario desactivado: su refresh deja de funcionar');
  const dis = await loginAs(c2, c2.d1);
  check(dis.status === 401 && JSON.stringify(dis.json) === JSON.stringify(wrong.json), 'usuario desactivado con contraseña correcta: misma respuesta genérica de credenciales inválidas');
  const stillThere = (await http('GET', '/api/v1/users', { token: ofi.token })).json.find((u) => u.id === c2.id);
  check(stillThere && stillThere.active === false, 'el usuario desactivado NO se borra (histórico conservado)');
  check(psqlAs('deca_api', ENV.DB_API_PASSWORD, 'DELETE FROM app_user').includes('permission denied'), 'ni siquiera la aplicación puede borrar usuarios (sin permiso DELETE)');
  // fuerza bruta
  const c3 = await newUser(ofi.token, 'conductor', 'cond3'); c3.password = PW(); check((await activate(c3, c3.password)).status === 200, 'conductor 3 activado (para la prueba de fuerza bruta)');
  resetThrottle(); const bf = [];
  for (let i = 0; i < 6; i++) bf.push(await http('POST', '/api/v1/auth/login', { body: { username: c3.username, password: `Mal-${i}-clave-larga` } }));
  check(bf.slice(0, 5).every((r) => r.status === 401) && bf[5].status === 429 && bf[5].headers.get('retry-after'), 'fuerza bruta: 5 fallos → el 6.º recibe 429 con Retry-After', bf.map((r) => r.status).join(','));
  const bfOk = await loginAs(c3, null); check(bfOk.status === 429, 'durante el bloqueo ni la contraseña correcta entra');
  const gh = []; for (let i = 0; i < 6; i++) gh.push((await http('POST', '/api/v1/auth/login', { body: { username: `fantasma2-${sfx}`, password: `Mal-${i}-clave-larga` } })).status);
  check(gh.join() === '401,401,401,401,401,429', 'un usuario INEXISTENTE se bloquea igual (mismo patrón: sin enumeración)', gh.join());
  resetThrottle(); check((await loginAs(c3, null)).status === 200, 'el bloqueo es temporal: pasado, el conductor vuelve a entrar');
  check(Number(psql(`SELECT count(*) FROM login_throttle`)) >= 0 && psql(`SELECT count(*) FROM information_schema.tables WHERE table_name='login_throttle'`) === '1', 'los contadores de fuerza bruta viven en la base de datos (sobreviven a un reinicio del servicio)');

  section('9. Máximo de 3 dispositivos pendientes');
  const c4 = await newUser(ofi.token, 'conductor', 'cond4'); c4.password = PW(); check((await activate(c4, c4.password)).status === 200, 'conductor 4 activado');
  const pendIds = [];
  for (let i = 1; i <= 3; i++) { const r = await loginAs(c4, null, `nuevo-${i}`); check(r.status === 200 && r.json.device.status === 'PENDIENTE_DE_CONFIRMACION', `dispositivo pendiente ${i}/3 creado`); pendIds.push(r.json.device.id); }
  const fourth = await loginAs(c4, null, 'nuevo-4');
  check(fourth.status === 409 && fourth.json.error === 'pending_device_limit' && fourth.json.max === 3, 'el 4.º dispositivo NO se crea: 409 pending_device_limit', `${fourth.status} ${JSON.stringify(fourth.json)}`);
  check(psql(`SELECT count(*) FROM device WHERE user_id='${c4.id}' AND status='PENDIENTE_DE_CONFIRMACION'`) === '3', 'siguen exactamente 3 pendientes: ninguno eliminado automáticamente');
  check((await http('POST', `/api/v1/devices/${pendIds[0]}/revoke`, { token: ofi.token })).status === 204, 'oficina revoca uno de los pendientes (lo resuelve desde oficina)');
  const fifth = await loginAs(c4, null, 'nuevo-5');
  check(fifth.status === 200 && fifth.json.device.status === 'PENDIENTE_DE_CONFIRMACION', 'los REVOCADOS no cuentan: ahora sí se crea otro pendiente');
  check(psql(`SELECT count(*) FROM device WHERE user_id='${c4.id}' AND status='REVOCADO'`) === '1', 'el dispositivo revocado se conserva (histórico)');
  const c5 = await newUser(ofi.token, 'conductor', 'cond5'); c5.password = PW(); await activate(c5, c5.password);
  const par = await Promise.all(Array.from({ length: 6 }, (_, i) => loginAs(c5, null, `par-${i}`)));
  const okN = par.filter((r) => r.status === 200).length, limN = par.filter((r) => r.status === 409).length;
  check(okN === 3 && limN === 3 && psql(`SELECT count(*) FROM device WHERE user_id='${c5.id}' AND status='PENDIENTE_DE_CONFIRMACION'`) === '3', `6 inicios de sesión SIMULTÁNEOS: exactamente 3 pendientes y 3 rechazados (sin condición de carrera)`, `${okN} ok / ${limN} límite`);
  // dispositivo de oficina
  const ofiNew = await loginAs(ofi, null, 'otro-pc'); info(`oficina desde un dispositivo nuevo: estado ${ofiNew.json?.device?.status} (los roles distintos de conductor NO usan el modo pendiente; su control es el TOTP)`);

  section('10. Expiración de la sesión provisional (72 h)');
  const c6 = await newUser(ofi.token, 'conductor', 'cond6'); c6.password = PW(); await activate(c6, c6.password);
  check((await http('POST', `/api/v1/transports/${T2.transport_id}/assign-driver`, { token: ofi.token, body: { driver_id: c6.id } })).status === 204, 'T2 se reasigna al conductor 6 (el conductor 2 está desactivado)');
  const before = psql(`SELECT md5(string_agg(t.id::text||t.status, ',' ORDER BY t.id)) FROM transport t`) + psql(`SELECT md5(string_agg(a.id::text||coalesce(a.valid_to::text,''), ',' ORDER BY a.id)) FROM transport_driver_assignment a WHERE valid_to IS NULL`);
  const ex = await loginAs(c6, null, 'nuevo-ex'); check(ex.status === 200 && ex.json.scope === 'LIMITED', 'conductor 6 en teléfono nuevo: sesión provisional');
  const exSid = sidOf(ex.json.access_token); const exDev = devCreds(ex);
  psql(`UPDATE session SET expires_at = now() - interval '1 minute' WHERE id='${exSid}'`);
  check((await http('GET', '/api/v1/driver/transports', { token: ex.json.access_token })).status === 401, 'sesión provisional agotada: el access token deja de valer');
  check((await http('POST', '/api/v1/auth/refresh', { body: { refresh_token: ex.json.refresh_token } })).status === 401, 'sesión provisional agotada: el refresh también');
  const ex2 = await loginAs(c6, exDev);
  check(ex2.status === 200 && ex2.json.scope === 'LIMITED' && ex2.json.device.status === 'PENDIENTE_DE_CONFIRMACION' && ex2.json.device.id === exDev.id, 'el usuario vuelve a autenticarse; el dispositivo SIGUE pendiente y recibe solo el alcance provisional (mismo dispositivo, nueva sesión)');
  const after = psql(`SELECT md5(string_agg(t.id::text||t.status, ',' ORDER BY t.id)) FROM transport t`) + psql(`SELECT md5(string_agg(a.id::text||coalesce(a.valid_to::text,''), ',' ORDER BY a.id)) FROM transport_driver_assignment a WHERE valid_to IS NULL`);
  check(before === after, 'la expiración NO modifica transportes, DeCA ni asignaciones');
  check((await http('GET', '/api/v1/driver/transports', { token: ex2.json.access_token })).json.length === 1, 'con la nueva sesión sigue viendo su transporte asignado antes de registrarse');

  section('11. Refresh rotatorio y detección de reutilización');
  const base = await loginAs(c3, null); const c3dev = base.json.device; keep(base.json.refresh_token);
  const R0 = base.json.refresh_token;
  const r1 = await http('POST', '/api/v1/auth/refresh', { body: { refresh_token: R0 } }); keep(r1.json.refresh_token, r1.json.access_token);
  check(r1.status === 200 && r1.json.refresh_token !== R0 && r1.json.access_token, 'refresh correcto: entrega un refresh token NUEVO (rotación)');
  const r2 = await http('POST', '/api/v1/auth/refresh', { body: { refresh_token: r1.json.refresh_token } }); keep(r2.json.refresh_token);
  check(r2.status === 200 && r2.json.refresh_token !== r1.json.refresh_token, 'segunda rotación correcta (cadena R0 → R1 → R2)');
  // Un conductor que pierde la red al renovar reintenta con el token anterior: dentro de 60 s NO es robo (sesión viva); oficina no tiene gracia.
  const g0 = (await loginAs(c3, devCreds(base))).json; keep(g0.refresh_token);
  const g1 = await http('POST', '/api/v1/auth/refresh', { body: { refresh_token: g0.refresh_token } }); keep(g1.json.refresh_token);
  const g2 = await http('POST', '/api/v1/auth/refresh', { body: { refresh_token: g0.refresh_token } }); keep(g2.json.refresh_token);
  check(g1.status === 200 && g2.status === 200 && (await http('GET', '/api/v1/me', { token: g2.json.access_token })).status === 200 && psql(`SELECT revoked_at IS NULL FROM session WHERE id='${sidOf(g2.json.access_token)}'`) === 't', 'CONDUCTOR: reintentar con el token recién rotado (red perdida) dentro de la ventana de gracia → 200 y la sesión sigue viva');
  const o0 = (await loginAs(ofi, ofi.device)).json; keep(o0.refresh_token);
  const o1 = await http('POST', '/api/v1/auth/refresh', { body: { refresh_token: o0.refresh_token } }); keep(o1.json.refresh_token);
  check(o1.status === 200 && (await http('POST', '/api/v1/auth/refresh', { body: { refresh_token: o0.refresh_token } })).status === 401 && psql(`SELECT revoked_reason FROM session WHERE id='${sidOf(o1.json.access_token)}'`) === 'refresh_reuse', 'OFICINA: sin ventana de gracia, reutilizar el token rotado revoca la sesión');
  psql(`UPDATE refresh_token SET used_at = used_at - interval '5 minutes' WHERE used_at IS NOT NULL AND session_id = '${sidOf(r2.json.access_token)}'`);   // fuera de la ventana de gracia
  const reuseR0 = await http('POST', '/api/v1/auth/refresh', { body: { refresh_token: R0 } });
  check(reuseR0.status === 401, 'REUTILIZAR el refresh token ya rotado (R0) → 401');
  check((await http('POST', '/api/v1/auth/refresh', { body: { refresh_token: r2.json.refresh_token } })).status === 401, 'detección de robo: el refresh vigente de la MISMA familia (R2) también deja de funcionar');
  check((await http('GET', '/api/v1/me', { token: r2.json.access_token })).status === 401, 'detección de robo: el access token de esa sesión también queda invalidado');
  const reason = psql(`SELECT revoked_reason FROM session WHERE id='${sidOf(r2.json.access_token)}'`);
  check(reason === 'refresh_reuse', 'la sesión queda marcada revocada por reutilización', reason);
  check((await loginAs(c3, null)).status === 200, 'el usuario puede volver a iniciar sesión con normalidad');

  section('12. Secretos en reposo y en logs');
  const dump = execSync('docker compose exec -T db pg_dump -U postgres -d decargo', { encoding: 'utf8', maxBuffer: 1 << 28 });
  const logs = execSync('docker compose logs api docs 2>&1', { encoding: 'utf8', maxBuffer: 1 << 28 });
  let inDb = 0, inLogs = 0; for (const s of secretsSeen) { if (dump.includes(s)) inDb++; if (logs.includes(s)) inLogs++; }
  check(inDb === 0, `ninguno de los ${secretsSeen.size} secretos en claro generados (contraseñas, códigos, access/refresh tokens, secretos de dispositivo) aparece en un volcado completo de la base de datos`, `${inDb} hallados`);
  check(inLogs === 0, 'ninguno aparece en los logs de api ni docs', `${inLogs} hallados`);
  const fm = psql(`SELECT bool_and(token_hash ~ '^[0-9a-f]{64}$') FROM refresh_token`) + psql(`SELECT bool_and(secret_hash ~ '^[0-9a-f]{64}$') FROM device`) + psql(`SELECT bool_and(secret_hash LIKE '$argon2id$%') FROM activation_token`) + psql(`SELECT bool_and(password_hash LIKE '$argon2id$%') FROM app_user WHERE password_hash IS NOT NULL`);
  check(fm === 'tttt', 'formatos en reposo: refresh y dispositivo = SHA-256; contraseñas y credenciales temporales = Argon2id', fm);

  section('13. Permisos de base de datos');
  for (const t of ['app_user', 'session', 'device', 'refresh_token', 'activation_token', 'login_throttle', 'transport_driver_assignment']) {
    check(psqlAs('deca_docs', ENV.DB_DOCS_PASSWORD, `SELECT 1 FROM ${t} LIMIT 1`).includes('permission denied'), `deca_docs NO puede leer ${t}`);
  }
  for (const t of ['app_user', 'device', 'session', 'refresh_token', 'transport_driver_assignment']) {
    check(psqlAs('deca_api', ENV.DB_API_PASSWORD, `DELETE FROM ${t}`).includes('permission denied'), `deca_api NO puede borrar de ${t}`);
  }
  check(psqlAs('deca_api', ENV.DB_API_PASSWORD, `UPDATE app_user SET role='admin'`).includes('permission denied'), 'deca_api NO puede cambiar roles de usuario (UPDATE solo en columnas concretas)');
  check(psqlAs('deca_api', ENV.DB_API_PASSWORD, `UPDATE device SET user_id=user_id`).includes('permission denied'), 'deca_api NO puede reasignar un dispositivo a otro usuario');

  section('14. Auditoría');
  const aud = await http('GET', '/api/v1/audit?limit=500', { token: admin.token });
  const acts = new Set(aud.json.map((a) => a.action));
  for (const a of ['USER_CREATED', 'ACTIVATION_ISSUED', 'USER_ACTIVATED', 'DEVICE_REGISTERED_AUTHORIZED', 'DEVICE_REGISTERED_PENDING', 'DEVICE_AUTHORIZED', 'DEVICE_REVOKED', 'DEVICE_LIMIT_REACHED', 'SESSION_REUSE_DETECTED', 'USER_DEACTIVATED', 'TRANSPORT_DRIVER_ASSIGNED', 'TOTP_ENABLED', 'TOTP_RESET'])
    check(acts.has(a), `auditado: ${a}`);
  check((await http('GET', '/api/v1/audit', { token: ofi.token })).status === 403, 'oficina NO accede a la auditoría (solo admin)');
  const v = sh('./deca verify'); const vj = JSON.parse(v.slice(v.indexOf('{')));
  check(vj.audit_chain_ok && vj.problems.length === 0 && vj.totp_decryptable >= 3, `verify: cadena de auditoría íntegra (${vj.audit_rows} filas), ${vj.documents_verified} documentos y ${vj.totp_decryptable} secretos TOTP descifrables`);

  section('15. DeCA externo: dispositivo pendiente, cuotas y descargador anti-SSRF');
  {   // ámbito propio: esta sección reutiliza nombres de variables de las anteriores
  const PUB = 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf';
  const mkDriver = async (base) => { const u = await newUser(ofi.token, 'conductor', base); u.password = PW(); const a = await activate(u, u.password, `movil-${base}`); u.devA = devCreds(a); return u; };
  const assign = async (T, u) => (await http('POST', `/api/v1/transports/${T.transport_id}/assign-driver`, { token: ofi.token, body: { driver_id: u.id } })).status;
  const ext = (token, T, url) => http('POST', '/api/v1/driver/external-deca', { token, body: { transport_id: T.transport_id, url } });
  const logN = (u, where = '') => Number(psql(`SELECT count(*) FROM external_fetch_log WHERE user_id='${u.id}' ${where}`));

  const cx = await mkDriver('condx'); const TX = await createTestDeca(), TY = await createTestDeca();
  check(await assign(TX, cx) === 204, 'T asignado al conductor ANTES de usar el teléfono nuevo');
  const px = await loginAs(cx, null, 'movil-nuevo-x');
  check(px.status === 200 && px.json.scope === 'LIMITED' && px.json.device.status === 'PENDIENTE_DE_CONFIRMACION', 'el conductor entra en un teléfono nuevo: dispositivo PENDIENTE (alcance limitado)');
  check(await assign(TY, cx) === 204, 'otro transporte se asigna DESPUÉS de registrarse ese teléfono');
  const ptok = px.json.access_token;

  const a1 = await ext(ptok, TX, PUB);
  if (a1.status === 201) {
    check(a1.json.review_status === 'PENDIENTE_DE_REVISION' && a1.json.validated === false && /No se ha comprobado que sea un DeCA válido/.test(a1.json.notice), 'DISPOSITIVO PENDIENTE añade un DeCA externo: queda PENDIENTE_DE_REVISION y la respuesta dice expresamente que NO está validado');
    check(a1.json.size_bytes > 0 && /^[0-9a-f]{64}$/.test(a1.json.sha256) && a1.json.duplicate === false, `PDF recibido y almacenado: ${a1.json.size_bytes} bytes, SHA-256 ${a1.json.sha256.slice(0, 12)}…`);
    const dup = await ext(ptok, TX, PUB);
    check(dup.status === 201 && dup.json.duplicate === true && dup.json.id === a1.json.id, 'el mismo documento otra vez: se reconoce como duplicado (sin segunda copia)');
    check(psql(`SELECT count(*) FROM external_deca WHERE transport_id='${TX.transport_id}'`) === '1', 'una sola fila en la base de datos');
    const row = psql(`SELECT device_status, pdf_header_ok, source_url, http_status, redirects FROM external_deca WHERE id='${a1.json.id}'`);
    check(row.startsWith('PENDIENTE_DE_CONFIRMACION|t|' + PUB) && row.endsWith('|200|0') || row.startsWith('PENDIENTE_DE_CONFIRMACION|t|' + PUB), 'se conserva la URL de origen, el estado del dispositivo en ese momento y el resultado técnico', row);
    const det = await http('GET', `/api/v1/driver/transports/${TX.transport_id}`, { token: ptok });
    check(det.json.external_decas.length === 1 && det.json.external_decas[0].validated === false, 'el conductor ve el documento en su transporte, siempre con validated=false');
    const dpdf = await http('GET', `/api/v1/driver/external-decas/${a1.json.id}/pdf`, { token: ptok });
    check(dpdf.status === 200 && dpdf.headers.get('content-type') === 'application/pdf' && sha256(dpdf.buf) === a1.json.sha256, 'el conductor puede abrir el PDF externo (hash idéntico)');
    check((await http('GET', `/api/v1/driver/external-decas/${a1.json.id}/pdf`, { token: c1.tok1 })).status === 404, 'OTRO conductor no puede abrir ese PDF externo (404)');
    const lst = await http('GET', '/api/v1/external-decas?status=PENDIENTE_DE_REVISION', { token: ofi.token });
    const mine = lst.json.find((e) => e.id === a1.json.id);
    check(mine && mine.device_status === 'PENDIENTE_DE_CONFIRMACION' && mine.added_by === cx.username, 'la oficina lo ve pendiente de revisión, con quién lo añadió y que fue desde un dispositivo PENDIENTE');
    const opdf = await http('GET', `/api/v1/external-decas/${a1.json.id}/pdf`, { token: ofi.token });
    check(opdf.status === 200 && sha256(opdf.buf) === a1.json.sha256, 'la oficina descarga el PDF (hash idéntico)');
    check((await http('POST', `/api/v1/external-decas/${a1.json.id}/review`, { token: ro.token, body: {} })).status === 403, 'solo_lectura NO puede marcarlo como revisado');
    check((await http('POST', `/api/v1/external-decas/${a1.json.id}/review`, { token: ptok, body: {} })).status === 403, 'el conductor NO puede marcarlo como revisado');
    check((await http('POST', `/api/v1/external-decas/${a1.json.id}/review`, { token: ofi.token, body: { notes: 'Revisado por oficina (prueba)' } })).status === 204, 'oficina lo marca REVISADO');
    check((await http('POST', `/api/v1/external-decas/${a1.json.id}/review`, { token: ofi.token, body: {} })).status === 409, 'revisarlo dos veces → 409');
    check(psql(`SELECT review_status FROM external_deca WHERE id='${a1.json.id}'`) === 'REVISADO', 'REVISADO solo significa «mirado por la oficina»: no hay ningún estado «válido» en el modelo (el CHECK solo admite PENDIENTE_DE_REVISION o REVISADO)');
    check(psql(`SELECT count(*) FROM deca WHERE kind='EXTERNAL'`) === '0' && psql(`SELECT count(*) FROM deca_version`) === psql(`SELECT count(*) FROM deca`), 'el DeCA externo NO sustituye ni altera ningún DeCA propio (ninguna fila nueva en deca/deca_version)');
  } else info(`descarga pública no concluyente desde este entorno (${a1.status} ${JSON.stringify(a1.json)}): se omiten las comprobaciones que dependen de ella`);
  // aislamiento
  check((await ext(ptok, TY, PUB)).status === 404, 'transporte asignado DESPUÉS del registro del dispositivo pendiente → 404');
  check((await ext(ptok, T1, PUB)).status === 404, 'transporte de OTRO conductor → 404');
  check((await ext(c1.tok1, TX, PUB)).status === 404, 'otro conductor intenta añadir un documento a un transporte que no es suyo → 404');
  check((await ext(ptok, { transport_id: 'no-es-uuid' }, PUB)).status === 404, 'id de transporte mal formado → 404');
  check((await ext(ro.token, TX, PUB)).status === 403, 'solo_lectura NO puede usar el endpoint de conductor (403)');
  check((await http('POST', '/api/v1/driver/external-deca', { body: { transport_id: TX.transport_id, url: PUB } })).status === 401, 'sin autenticar → 401');
  check((await http('POST', '/api/v1/driver/external-deca', { token: ptok, body: { transport_id: TX.transport_id } })).status === 400, 'falta el campo url → 400 (validación del esquema, sin descargar nada)');
  check((await http('POST', `/api/v1/driver/transports/${TX.transport_id}/finish`, { token: ptok, body: {} })).status === 403, 'FINALIZAR no está permitido a un dispositivo pendiente de autorizar (403, D-05)');

  // SSRF por la API
  const before = logN(cx);
  const urlBad = ['http://example.com/a.pdf', 'https://127.0.0.1/a.pdf', 'https://localhost/a.pdf', 'https://169.254.169.254/latest/meta-data/', 'https://db/a.pdf', 'https://[::1]/a.pdf', 'https://2130706433/a.pdf', 'file:///etc/passwd', 'https://user:pw@example.com/a.pdf', 'https://example.com:8443/a.pdf'];
  const r400 = []; for (const u of urlBad) r400.push((await ext(ptok, TX, u)));
  check(r400.every((r) => r.status === 400 && r.json.error === 'url_no_valida'), `${urlBad.length} URL hostiles por la API → 400 url_no_valida`, r400.map((r) => r.status).join(','));
  check(logN(cx) === before, 'rechazadas por validación SIN abrir ninguna conexión y SIN consumir cuota');
  const sLocal = await ext(ptok, TX, 'https://localtest.me/a.pdf'), sNip = await ext(ptok, TX, 'https://127.0.0.1.nip.io/a.pdf'), sNx = await ext(ptok, TX, `https://no-existe-${sfx}.invalid/a.pdf`);
  check([sLocal, sNip, sNx].every((r) => r.status === 422 && r.json.reason === 'no_se_pudo_descargar'), 'nombres públicos que resuelven a 127.0.0.1 → 422; el motivo es el MISMO que para un nombre inexistente (no se filtra si el destino era interno)', [sLocal, sNip, sNx].map((r) => `${r.status}/${r.json.reason}`).join(' '));
  const outc = psql(`SELECT string_agg(outcome||':'||n, ',' ORDER BY outcome) FROM (SELECT outcome, count(*) n FROM external_fetch_log WHERE user_id='${cx.id}' GROUP BY outcome) x`);
  check(/BLOCKED_ADDRESS:2/.test(outc) && /DNS_ERROR:1/.test(outc), `internamente SÍ se registra el motivo real de cada intento: ${outc}`);
  check(!JSON.stringify([sLocal, sNip]).includes('127.0.0.1') && !JSON.stringify(sLocal.json).includes('BLOCKED'), 'la respuesta al conductor no contiene IP ni detalle técnico');
  // cuota por hora: 5 intentos con red (los que ya se hicieron + éstos)
  const used = logN(cx, `AND outcome NOT IN ('BUSY')`);
  const need = 5 - used; for (let i = 0; i < need; i++) await ext(ptok, TX, `https://no-existe-${sfx}-${i}.invalid/a.pdf`);
  const q = await ext(ptok, TX, PUB);
  check(q.status === 429 && q.json.error === 'quota_exceeded' && q.json.retry_after_seconds > 0 && q.headers.get('retry-after'), `CUOTA POR HORA (5 intentos, también los fallidos): el 6.º → 429 quota_exceeded con Retry-After (${q.json.retry_after_seconds} s)`);
  check(logN(cx) === 5, 'el intento rechazado por cuota no se registra como intento y no se conectó a nada');
  // otros usuarios no se ven afectados
  const cy = await mkDriver('condy'); const TW = await createTestDeca(); await assign(TW, cy);
  const html = await ext((await loginAs(cy, cy.devA)).json.access_token, TW, 'https://www.w3.org/');
  if (html.status === 422) check(html.json.reason === 'no_es_pdf', 'una página HTML pública en lugar de un PDF → 422 no_es_pdf'); else info(`página HTML: ${html.status} ${JSON.stringify(html.json)} (no concluyente sin Internet)`);
  check(logN(cy) >= 1, 'la cuota es POR USUARIO: el agotamiento de uno no afecta al otro');
  // cuota diaria
  const cw = await mkDriver('condw'); const TV = await createTestDeca(); await assign(TV, cw);
  psql(`INSERT INTO external_fetch_log (user_id, requested_at, outcome, url_host) SELECT '${cw.id}', now() - interval '3 hours' - (g || ' minutes')::interval, 'HTTP_ERROR', 'ejemplo.test' FROM generate_series(1,15) g`);
  const qd = await ext((await loginAs(cw, cw.devA)).json.access_token, TV, PUB);
  check(qd.status === 429 && qd.json.error === 'quota_exceeded', 'CUOTA DIARIA (15): con 15 intentos en las últimas 24 h, aunque ninguno sea de la última hora → 429', `${qd.status} ${JSON.stringify(qd.json)}`);
  // máximo por transporte
  const cz = await mkDriver('condz'); const TU = await createTestDeca(); await assign(TU, cz);
  psql(`INSERT INTO external_deca (company_id, transport_id, source_url, file_key, sha256, size_bytes, pdf_header_ok, added_by_user, device_status) SELECT t.company_id, t.id, 'https://x.test/'||g, repeat('a',64), repeat(g::text,64)::text, 1000, true, '${cz.id}', 'AUTORIZADO' FROM transport t, generate_series(1,5) g WHERE t.id='${TU.transport_id}'`);
  const cap = await ext((await loginAs(cz, cz.devA)).json.access_token, TU, PUB);
  check(cap.status === 409 && cap.json.error === 'limit_per_transport' && cap.json.max === 5, 'máximo de 5 documentos externos por transporte → 409 limit_per_transport');
  psql(`DELETE FROM external_deca WHERE transport_id='${TU.transport_id}' AND file_key = repeat('a',64)`);   // filas ficticias de la prueba: no deben quedar sin fichero
  // auditoría y permisos
  const aud2 = await http('GET', '/api/v1/audit?limit=500', { token: admin.token }); const acts2 = new Set(aud2.json.map((a) => a.action));
  for (const a of ['EXTERNAL_FETCH_REJECTED', ...(a1.status === 201 ? ['EXTERNAL_DECA_ADDED', 'EXTERNAL_DECA_REVIEWED'] : [])]) check(acts2.has(a), `auditado: ${a}`);
  if (a1.status === 201) check(aud2.json.some((a) => a.action === 'EXTERNAL_DECA_ADDED' && a.after?.device_status === 'PENDIENTE_DE_CONFIRMACION'), 'la auditoría marca que el documento se añadió desde un dispositivo PENDIENTE');
  for (const t of ['external_deca', 'external_fetch_log']) {
    check(psqlAs('deca_docs', ENV.DB_DOCS_PASSWORD, `SELECT 1 FROM ${t} LIMIT 1`).includes('permission denied'), `deca_docs NO puede leer ${t}`);
    check(psqlAs('deca_api', ENV.DB_API_PASSWORD, `DELETE FROM ${t}`).includes('permission denied'), `deca_api NO puede borrar de ${t}`);
  }
  check(psqlAs('deca_api', ENV.DB_API_PASSWORD, `UPDATE external_deca SET sha256 = repeat('0',64)`).includes('permission denied'), 'deca_api NO puede alterar el hash ni el contenido de un documento externo (solo los campos de revisión)');
  if (a1.status === 201) { const vv = sh('./deca verify'); const vj2 = JSON.parse(vv.slice(vv.indexOf('{'))); check(vj2.external_total >= 1 && vj2.external_verified === vj2.external_total && vj2.problems.length === 0, `verify: ${vj2.external_verified}/${vj2.external_total} DeCA externos con su hash íntegro`); }

  }

  section('16. Interfaz web: vehículos, transportes, permisos, IDOR, PDF/QR, fugas, proxy, reactivación y seed');
  {   // ámbito propio
  resetThrottle();
  const WEB = `http://${ENV.WEB_BIND || '127.0.0.1'}:${ENV.WEB_PORT || 18082}`;
  const DOCS = `http://${ENV.DOCS_BIND || '127.0.0.1'}:${ENV.DOCS_PORT}`;
  const SFX = sfx.toUpperCase(), today = new Date().toISOString().slice(0, 10);
  const nTr = () => Number(psql('SELECT count(*) FROM transport')), nVe = () => Number(psql('SELECT count(*) FROM vehicle'));
  const LEAK = /password_hash|secret_hash|totp_secret|token_enc|token_hash|refresh_hash/;
  const safeBodies = [];            // respuestas que NO deben contener ningún token público (listados, panel, vehículos, conductor)
  const allBodies = [];             // todas: ninguna debe contener hashes ni secretos
  const call = async (m, p, o = {}, safe = false) => { const r = await http(m, p, o); if (o.token && r.buf.length && !(r.headers.get('content-type') || '').includes('pdf')) { allBodies.push(r.buf.toString('utf8')); if (safe) safeBodies.push(r.buf.toString('utf8')); } return r; };

  // Sesiones nuevas y completas (los tokens de secciones anteriores pueden haber caducado)
  const oL = await loginAs(ofi, ofi.device); check(oL.status === 200 && oL.json.scope === 'FULL', 'oficina inicia sesión (contraseña + TOTP + dispositivo autorizado)', `${oL.status}`);
  const O = oL.json.access_token;
  const aL = await loginAs(admin, admin.device); const AD = aL.json?.access_token;
  const mkUser = async (role, base) => {
    const u = await newUser(role === 'conductor' ? O : AD, role, base);   // oficina solo crea conductores
    u.password = PW(); const a = await activate(u, u.password, `web-${base}`);
    u.dev = a.status === 200 ? devCreds(a) : null;
    if (role === 'conductor') u.tok = a.json?.access_token;
    else { await enrollTotp(u, a.json.access_token); u.tok = a.json.access_token; }   // la misma sesión pasa de MFA_PENDING a FULL al confirmar el TOTP
    return u;
  };
  const ro16 = await mkUser('solo_lectura', 'ro16'); check(!!ro16.tok, 'solo_lectura de la prueba con sesión FULL');
  const dA = await mkUser('conductor', 'webA'), dB = await mkUser('conductor', 'webB');
  check(dA.tok && dB.tok, 'dos conductores nuevos (A y B), cada uno con su primer dispositivo AUTORIZADO');

  // ---- 16.1 vehículos
  info('16.1 Vehículos');
  const pT = `S${SFX}1`, pR = `R${SFX}2`, pX = `X${SFX}3`;
  const vT = await call('POST', '/api/v1/vehicles', { token: O, body: { plate: pT, kind: 'TRACTORA' } });
  const vR = await call('POST', '/api/v1/vehicles', { token: O, body: { plate: pR, kind: 'SEMIRREMOLQUE' } });
  const vX = await call('POST', '/api/v1/vehicles', { token: O, body: { plate: `${pX.slice(0, 3)} ${pX.slice(3)}`.toLowerCase(), kind: 'RIGIDO' } });
  check(vT.status === 201 && vR.status === 201 && vX.status === 201 && vX.json.plate === `${pX.slice(0, 3)} ${pX.slice(3)}`, 'oficina crea tractora, semirremolque y rígido (la matrícula se normaliza a mayúsculas)', `${vT.status}/${vR.status}/${vX.status}`);
  const dupV = await call('POST', '/api/v1/vehicles', { token: O, body: { plate: `${pT.slice(0, 3)}-${pT.slice(3)}`, kind: 'TRACTORA' } });
  check(dupV.status === 409 && dupV.json.error === 'plate_taken', 'matrícula duplicada (aunque cambie el formato: espacios, guiones, minúsculas) → 409 plate_taken', `${dupV.status}`);
  const n0 = nVe();
  for (const [b, why] of [[{ plate: '!!', kind: 'TRACTORA' }, 'matrícula inválida'], [{ plate: 'AB', kind: 'TRACTORA' }, 'matrícula demasiado corta'], [{ plate: 'ZZZ111', kind: 'AVION' }, 'tipo inexistente'], [{ plate: 'ZZZ222' }, 'sin tipo'], [{ plate: 'A'.repeat(40), kind: 'RIGIDO' }, 'matrícula larga']]) {
    const r = await call('POST', '/api/v1/vehicles', { token: O, body: b }); check(r.status === 400, `vehículo rechazado (${why}) → 400`, `${r.status}`);
  }
  check(nVe() === n0, 'ningún vehículo inválido se guardó');
  const pU = await call('PATCH', `/api/v1/vehicles/${vX.json.id}`, { token: O, body: { plate: `Q${SFX}9`, kind: 'RIGIDO' } });
  check(pU.status === 204, 'un vehículo SIN uso puede corregir su matrícula', `${pU.status}`);

  // el listado separa los vehículos por tipo, en este orden: tractoras, semirremolques, camión rígido y remolques
  const vRem = await call('POST', '/api/v1/vehicles', { token: O, body: { plate: `M${SFX}4`, kind: 'REMOLQUE' } });
  const vList = (await call('GET', '/api/v1/vehicles', { token: O })).json, rank = { TRACTORA: 1, SEMIRREMOLQUE: 2, RIGIDO: 3, REMOLQUE: 4 };
  check(vRem.status === 201 && vList.every((v, i, a) => i === 0 || rank[a[i - 1].kind] < rank[v.kind] || (rank[a[i - 1].kind] === rank[v.kind] && a[i - 1].plate <= v.plate)) && new Set(vList.map((v) => v.kind)).size === 4, 'los vehículos salen separados por tipo en este orden: tractoras, semirremolques, camión rígido y remolques (y por matrícula dentro de cada tipo)');
  check((await call('GET', '/api/v1/vehicles?kind=RIGIDO,TRACTORA', { token: O })).json.map((v) => v.kind).join(',').replace(/(TRACTORA,)*/, '').indexOf('TRACTORA') === -1, 'con varios tipos pedidos, también se respeta el orden (tractoras antes que camión rígido)');

  // ---- 16.2 transportes: validación
  info('16.2 Transportes: validación y alta');
  const tbody = (o = {}) => ({ shipper_name: 'CARGADOR WEB S.A.', shipper_nif: 'A12345678', shipper_address: 'Calle Prueba 5, 04001 Almería', origin: 'Almacén Origen, El Ejido', destination: 'Destino Final, Roquetas de Mar',
    transport_date: today, cargo: `Hortalizas ${sfx}`, weight_kg: 1234.5, tractor_id: vT.json.id, trailer_id: vR.json.id, driver_id: dA.id, ...o });
  const t0 = nTr();
  for (const [o, why] of [[{ shipper_name: '' }, 'cargador vacío'], [{ shipper_nif: '!' }, 'NIF inválido'], [{ transport_date: '2026-02-30' }, 'fecha inexistente'], [{ transport_date: '30/02/2026' }, 'fecha con formato erróneo'],
    [{ weight_kg: -5 }, 'peso negativo'], [{ weight_kg: undefined }, 'sin peso ni otra magnitud'], [{ cargo: 'x\u0001y' }, 'carácter de control en la mercancía'], [{ tractor_id: undefined }, 'sin matrícula (g)'],
    [{ tractor_id: vR.json.id, trailer_id: undefined }, 'un semirremolque como vehículo principal'], [{ trailer_id: vT.json.id }, 'una tractora como remolque'], [{ driver_id: ofi.id }, 'conductor que no es conductor'],
    [{ tractor_id: 'no-es-uuid' }, 'UUID de vehículo inválido'], [{ origin: 'a'.repeat(500) }, 'origen demasiado largo']]) {
    const r = await call('POST', '/api/v1/transports', { token: O, body: tbody(o) });
    check(r.status === 400, `transporte rechazado (${why}) → 400`, `${r.status} ${r.text}`);
  }
  check(nTr() === t0, 'ningún transporte inválido se guardó (sin filas a medias)');
  check(psql(`SELECT count(*) FROM transport WHERE shipper_name='CARGADOR WEB S.A.'`) === '0', 'tampoco queda ningún transporte de la prueba creado por error');
  const tc = await call('POST', '/api/v1/transports', { token: O, body: tbody({ remarks: 'Línea 1\nLínea 2' }) });
  check(tc.status === 201 && tc.json.id && tc.json.deca_id, 'transporte válido con conductor y vehículos → 201 con DeCA emitido', `${tc.status} ${tc.text}`);
  const TID = tc.json.id, DID = tc.json.deca_id;
  const det = await call('GET', `/api/v1/transports/${TID}`, { token: O });
  check(det.status === 200 && det.json.driver?.id === dA.id && det.json.vehicles?.tractor?.plate === pT && det.json.vehicles?.trailer?.plate === pR && det.json.deca?.version === 1, 'el detalle devuelve conductor, vehículos y DeCA v1');
  check(psql(`SELECT count(*) FROM audit_log WHERE entity_id='${TID}' AND action='TRANSPORT_CREATED'`) === '1', 'el alta del transporte queda en la auditoría');

  const tcar = await call('POST', '/api/v1/transports', { token: O, body: tbody({ carrier_name: `TRANSPORTES EFECTIVOS ${SFX} S.L.`, carrier_nif: 'B87654321', cargo: `Subcontratado ${sfx}`, driver_id: undefined }) });
  const dcar = tcar.status === 201 ? await call('GET', `/api/v1/transports/${tcar.json.id}`, { token: O }) : null;
  check(tcar.status === 201 && dcar.json.carrier.name === `TRANSPORTES EFECTIVOS ${SFX} S.L.` && dcar.json.carrier.nif === 'B87654321', 'el transportista efectivo puede ser otra empresa distinta de la propia (se guarda en el transporte)', `${tcar.status}`);
  const pcar = pdfText((await call('GET', `/api/v1/decas/${tcar.json.deca_id}/versions/1/pdf`, { token: O })).buf);
  check(pcar.includes(`TRANSPORTES EFECTIVOS ${SFX} S.L.`) && pcar.includes('B87654321'), 'y el PDF imprime ese transportista (no el de la empresa)');
  check(det.json.carrier.name !== dcar.json.carrier.name, 'sin indicarlo, el transportista sigue siendo la empresa propia');
  const t2 = nTr();
  check((await call('POST', '/api/v1/transports', { token: O, body: tbody({ carrier_name: 'SOLO NOMBRE S.L.' }) })).status === 400 && (await call('POST', '/api/v1/transports', { token: O, body: tbody({ carrier_name: 'X S.L.', carrier_nif: '!' }) })).status === 400 && nTr() === t2, 'un transportista incompleto o con NIF inválido → 400 y no se guarda nada');
  const dsh = await call('GET', '/api/v1/dashboard', { token: O });
  check(dsh.json.public_base_url === (ENV.PUBLIC_DOCS_BASE_URL || '').replace(/\/+$/, '') && dsh.json.decas_other_base === 0, 'el panel muestra la dirección pública configurada y cuántos DeCA llevan otra (0 aquí)', JSON.stringify([dsh.json.public_base_url, dsh.json.decas_other_base]));
  psql(`UPDATE deca SET public_url = replace(public_url, '://', '://otro.dominio.test.') WHERE id = '${tcar.json.deca_id}'`);   // simula un DeCA emitido con una dirección anterior (solo en la copia de pruebas)
  check((await call('GET', '/api/v1/dashboard', { token: O })).json.decas_other_base === 1 && (await call('GET', `/api/v1/transports/${tcar.json.id}`, { token: O })).json.deca.technical.other_base === true, 'un DeCA emitido con otra dirección se señala en el panel y en su detalle');
  psql(`UPDATE deca SET public_url = replace(public_url, '://otro.dominio.test.', '://') WHERE id = '${tcar.json.deca_id}'`);

  // ---- 16.3 PDF y QR: misma URL y mismo documento
  info('16.3 PDF y QR');
  const pubUrl = det.json.deca?.technical?.public_url, shaDb = det.json.deca?.technical?.sha256;
  check(/^https?:\/\/[^/]+\/d\/[A-Za-z0-9_-]{43}$/.test(pubUrl || ''), 'la URL pública guardada con el DeCA tiene la forma /d/<token de 256 bits>');
  const pdfO = await call('GET', `/api/v1/decas/${DID}/versions/1/pdf`, { token: O });
  const pdfD = await call('GET', `/api/v1/driver/decas/${DID}/current.pdf`, { token: dA.tok });
  check(pdfO.status === 200 && pdfD.status === 200 && sha256(pdfO.buf) === sha256(pdfD.buf) && sha256(pdfO.buf) === shaDb, 'el PDF de oficina y el del conductor son byte a byte el mismo y coinciden con el SHA-256 registrado');
  const qrOff = decodeQr((await call('GET', `/api/v1/decas/${DID}/qr.svg`, { token: O })).buf, 'qo16.svg');
  const qrDrv = decodeQr((await call('GET', `/api/v1/driver/decas/${DID}/qr.svg`, { token: dA.tok })).buf, 'qd16.svg');
  const qrPdf = decodeQr(pdfO.buf, 'doc16.pdf');
  check(qrOff === pubUrl && qrDrv === pubUrl && qrPdf === pubUrl, 'el QR de oficina, el QR del conductor y el QR DENTRO del PDF decodifican la MISMA URL que la guardada (sin segundo generador)', `${qrOff} | ${qrDrv} | ${qrPdf}`);
  const viaDocs16 = await fetch(DOCS + new URL(pubUrl).pathname).then(async (r) => ({ s: r.status, h: sha256(Buffer.from(await r.arrayBuffer())), ct: r.headers.get('content-type') }));
  check(viaDocs16.s === 200 && viaDocs16.h === shaDb && viaDocs16.ct === 'application/pdf', 'esa URL, sin autenticación, descarga directamente el mismo PDF');
  const txt = pdfText(pdfO.buf);
  check(txt.includes(pT) && txt.includes(pR) && txt.includes(`Hortalizas ${sfx}`) && txt.includes('CARGADOR WEB S.A.') && txt.includes('A12345678') && txt.includes('Línea 2'), 'el PDF imprime los datos tecleados: cargador, NIF, mercancía, matrículas y observaciones (con salto de línea)');
  if (ENV.DECA_TEST_MODE !== '0') check(/DOCUMENTO DE PRUEBA/.test(txt), 'con DECA_TEST_MODE activo el PDF lleva el rótulo de prueba');
  check(pdfO.buf.length < 5_000_000 && pdfO.buf.subarray(0, 4).toString() === '%PDF', `PDF nativo y por debajo del límite de 5 MB (${pdfO.buf.length} bytes)`);

  // ---- 16.4 emisión posterior y cambios de vehículo
  info('16.4 Emisión del DeCA y cambios de vehículo');
  const tn = await call('POST', '/api/v1/transports', { token: O, body: tbody({ generate_deca: false, tractor_id: undefined, trailer_id: undefined, driver_id: undefined, cargo: `Sin DeCA ${sfx}` }) });
  check(tn.status === 201 && tn.json.deca_id === null, 'transporte sin DeCA aún (borrador sin vehículo)', `${tn.status}`);
  check((await call('POST', `/api/v1/transports/${tn.json.id}/deca`, { token: O })).status === 409, 'emitir el DeCA sin matrícula → 409 vehicle_required');
  check((await call('PUT', `/api/v1/transports/${tn.json.id}/vehicles`, { token: O, body: { tractor_id: vR.json.id } })).status === 400, 'asignar un semirremolque como vehículo principal → 400');
  check((await call('PUT', `/api/v1/transports/${tn.json.id}/vehicles`, { token: O, body: { tractor_id: vT.json.id, trailer_id: vR.json.id } })).status === 204, 'asignar tractora + semirremolque a un transporte sin DeCA → 204');
  const em = await call('POST', `/api/v1/transports/${tn.json.id}/deca`, { token: O });
  check(em.status === 201 && em.json.deca_id, 'emitir el DeCA posteriormente → 201');
  check((await call('POST', `/api/v1/transports/${tn.json.id}/deca`, { token: O })).status === 409, 'un segundo DeCA para el mismo transporte → 409 (1 transporte = 1 DeCA)');
  const chg = await call('PUT', `/api/v1/transports/${tn.json.id}/vehicles`, { token: O, body: { tractor_id: vT.json.id } });
  check(chg.status === 409 && chg.json.error === 'deca_emitido', 'cambiar vehículos con el DeCA ya emitido → 409 deca_emitido (sería una modificación legal; no implementada)');
  const inUse = await call('PATCH', `/api/v1/vehicles/${vT.json.id}`, { token: O, body: { plate: `Z${SFX}7` } });
  check(inUse.status === 409 && inUse.json.error === 'vehicle_in_use', 'una matrícula ya usada en un DeCA NO se reescribe → 409 vehicle_in_use', `${inUse.status}`);
  check((await call('PATCH', `/api/v1/vehicles/${vX.json.id}`, { token: O, body: { active: false } })).status === 204, 'desactivar un vehículo sí se permite');
  const vlist = await call('GET', '/api/v1/vehicles?active=true', { token: O }, true);
  check(vlist.status === 200 && !vlist.json.some((v) => v.id === vX.json.id) && vlist.json.some((v) => v.id === vT.json.id && v.in_use === true), 'el listado filtra inactivos y marca los vehículos en uso');

  // ---- 16.5 matriz de permisos
  info('16.5 Matriz de permisos (sin sesión, conductor, solo_lectura)');
  const eps = [['GET', '/api/v1/dashboard', 'R'], ['GET', '/api/v1/transports', 'R'], ['GET', `/api/v1/transports/${TID}`, 'R'], ['GET', '/api/v1/vehicles', 'R'], ['GET', `/api/v1/vehicles/${vT.json.id}`, 'R'],
    ['GET', `/api/v1/decas/${DID}/qr.svg`, 'R'], ['GET', `/api/v1/decas/${DID}`, 'R'], ['GET', `/api/v1/decas/${DID}/versions/1/pdf`, 'R'],
    ['POST', '/api/v1/transports', 'W', tbody({ cargo: 'no debe crearse' })], ['POST', `/api/v1/transports/${TID}/deca`, 'W', {}], ['PUT', `/api/v1/transports/${TID}/vehicles`, 'W', { tractor_id: vT.json.id }],
    ['POST', '/api/v1/vehicles', 'W', { plate: `W${SFX}5`, kind: 'RIGIDO' }], ['PATCH', `/api/v1/vehicles/${vR.json.id}`, 'W', { active: false }], ['POST', `/api/v1/transports/${TID}/assign-driver`, 'W', { driver_id: dB.id }],
    ['GET', '/api/v1/users', 'O'], ['GET', '/api/v1/devices', 'R']];
  const t1 = nTr(), v1 = nVe(), vrActive = psql(`SELECT active FROM vehicle WHERE id='${vR.json.id}'`);
  let denied = 0, total = 0, wrong = [];
  for (const [m, p, kind, body] of eps) {
    for (const [who, tok, want] of [['sin sesión', undefined, 401], ['conductor', dA.tok, 403], ['solo_lectura', ro16.tok, kind === 'R' ? 200 : 403]]) {
      const r = await http(m, p, { token: tok, body }); total++;
      if (r.status === want) denied++; else wrong.push(`${who} ${m} ${p.slice(0, 40)} → ${r.status} (esperado ${want})`);
    }
  }
  check(wrong.length === 0, `matriz de permisos: ${denied}/${total} respuestas correctas (sin sesión 401, conductor 403, solo_lectura solo lectura)`, wrong.slice(0, 4).join(' ; '));
  check(nTr() === t1 && nVe() === v1 && psql(`SELECT active FROM vehicle WHERE id='${vR.json.id}'`) === vrActive && psql(`SELECT driver_user_id FROM transport_driver_assignment WHERE transport_id='${TID}' AND valid_to IS NULL`) === dA.id, 'los intentos denegados no cambiaron NADA en la base de datos');
  check((await http('GET', `/api/v1/transports/${TID}`, { token: 'abc.def.ghi' })).status === 401 && (await http('GET', '/api/v1/transports', { token: O + 'x' })).status === 401, 'un token manipulado → 401');
  for (const p of ['/api/v1/transports/zzz', '/api/v1/vehicles/zzz', '/api/v1/decas/zzz/qr.svg', `/api/v1/transports/${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}`, `/api/v1/transports/${TID}'%20OR%201=1--`]) {
    const r = await http('GET', p, { token: O }); check(r.status === 404 || r.status === 400, `identificador inválido o inexistente → ${r.status}, nunca 500 (${p.slice(0, 44)})`);
  }

  // ---- 16.6 IDOR del conductor
  info('16.6 IDOR del conductor');
  const lA = await call('GET', '/api/v1/driver/transports', { token: dA.tok }, true), lB = await call('GET', '/api/v1/driver/transports', { token: dB.tok }, true);
  check(lA.status === 200 && lA.json.some((t) => t.id === TID) && lB.status === 200 && !lB.json.some((t) => t.id === TID), 'cada conductor ve solo sus transportes (A ve el suyo; B no)');
  for (const [p, what] of [[`/api/v1/driver/transports/${TID}`, 'el transporte'], [`/api/v1/driver/decas/${DID}/current.pdf`, 'el PDF'], [`/api/v1/driver/decas/${DID}/qr.svg`, 'el QR']]) {
    const r = await http('GET', p, { token: dB.tok }); check(r.status === 404, `IDOR: el conductor B NO puede leer ${what} del conductor A → 404 (sin revelar que existe)`, `${r.status}`);
  }
  check(JSON.stringify((await http('GET', `/api/v1/driver/transports/${TID}`, { token: dB.tok })).json) === JSON.stringify((await http('GET', `/api/v1/driver/transports/${'1'.repeat(8)}-1111-1111-1111-${'1'.repeat(12)}`, { token: dB.tok })).json), 'la respuesta ante un transporte ajeno es idéntica a la de uno inexistente');
  const drvJ = await call('GET', `/api/v1/driver/transports/${TID}`, { token: dA.tok }, true);
  check(drvJ.status === 200 && drvJ.json.vehicles && !/sha256|"url"/.test(drvJ.text + JSON.stringify(drvJ.json)), 'el transporte del conductor trae los vehículos y NO expone hash ni URL del documento');
  check((await http('GET', `/api/v1/transports/${TID}`, { token: dA.tok })).status === 403 && (await http('GET', `/api/v1/decas/${DID}/qr.svg`, { token: dA.tok })).status === 403, 'el conductor no puede usar los endpoints de oficina para leer su propio transporte (403)');
  const re1 = await http('POST', `/api/v1/transports/${TID}/assign-driver`, { token: O, body: { driver_id: dB.id } });
  const aAfter = await http('GET', `/api/v1/driver/transports/${TID}`, { token: dA.tok }), bAfter = await http('GET', `/api/v1/driver/transports/${TID}`, { token: dB.tok });
  check(re1.status === 204 && aAfter.status === 404 && bAfter.status === 200, 'al reasignar el transporte, el conductor A pierde el acceso al instante y B lo gana', `${re1.status}/${aAfter.status}/${bAfter.status}`);
  check((await http('GET', `/api/v1/driver/decas/${DID}/current.pdf`, { token: dA.tok })).status === 404, 'el conductor A tampoco puede ya descargar el PDF');
  const ev = psql(`SELECT count(*) FROM audit_log WHERE entity_id='${TID}' AND action='TRANSPORT_DRIVER_ASSIGNED'`); check(ev === '1' && psql(`SELECT after->>'driver' FROM audit_log WHERE entity_id='${TID}' AND action='TRANSPORT_CREATED'`) === dA.id, `la asignación inicial (en el alta) y la reasignación constan en la auditoría (${ev} reasignación)`);

  // ---- 16.7 fugas
  info('16.7 Fugas de datos sensibles');
  await call('GET', '/api/v1/dashboard', { token: O }, true); await call('GET', '/api/v1/transports', { token: O }, true); await call('GET', '/api/v1/users', { token: O }, true);
  const tokenOf = pubUrl.split('/d/')[1];
  check(allBodies.length > 20 && allBodies.every((b) => !LEAK.test(b)), `ninguna de las ${allBodies.length} respuestas de la interfaz contiene hashes ni secretos de usuarios, dispositivos o TOTP`);
  check(safeBodies.length > 5 && safeBodies.every((b) => !b.includes(tokenOf)), `el token público del DeCA no aparece en listados, panel, vehículos ni respuestas del conductor (${safeBodies.length} respuestas revisadas)`);

  // ---- 16.8 proxy web
  info('16.8 Servicio web (nginx)');
  const wr = await fetch(WEB + '/'); const wh = (n) => wr.headers.get(n) || '';
  check(wr.status === 200 && wh('content-type').startsWith('text/html') && wh('content-security-policy').includes("default-src 'none'") && wh('x-content-type-options') === 'nosniff' && wh('x-frame-options') === 'DENY' && wh('referrer-policy') === 'no-referrer', 'la web responde con CSP estricta, nosniff, X-Frame-Options DENY y Referrer-Policy no-referrer');
  check(!/\d/.test(wh('server')) && !wh('x-powered-by'), 'la web no revela versiones de servidor');
  // Grupo B: la raíz es la web pública y la aplicación vive en /<DECARGO_APP_PATH>/ (configurable, estable).
  const APPP = ENV.DECARGO_APP_PATH;
  check(/^[A-Za-z0-9_-]{16,64}$/.test(APPP || '') && !/^(app|admin|panel|login|decargo|dashboard|gestion|office)$/i.test(APPP), 'la ruta interna de la aplicación está configurada en .env y no es una palabra obvia');
  const rootHtml = await (await fetch(WEB + '/')).text();
  check(/Probar DECARGO/.test(rootHtml) && /App para conductores/.test(rootHtml) && !rootHtml.includes('/src/main.ts') && !/assets\/index-/.test(rootHtml) && !rootHtml.includes(APPP), '«/» es la web pública (no la aplicación) y no lleva escrita la ruta interna');
  const appHtml = await fetch(WEB + `/${APPP}/`), appSub = await fetch(WEB + `/${APPP}/conductor/lo-que-sea`);
  check(appHtml.status === 200 && /assets\/index-/.test(await appHtml.text()) && appSub.status === 200 && (await fetch(WEB + `/${APPP}`, { redirect: 'manual' })).status === 301, 'la aplicación responde en su ruta (y en sus subrutas, para recargar la página)');
  const legacy = await fetch(WEB + '/conductor?t=abc', { redirect: 'manual' });
  check(legacy.status === 302 && legacy.headers.get('location') === `/${APPP}/conductor?t=abc` && (await fetch(WEB + '/login', { redirect: 'manual' })).headers.get('location') === `/${APPP}/login`, 'las rutas antiguas de la aplicación (favoritos, app instalada, avisos ya enviados) redirigen a la ruta nueva');
  check((await fetch(WEB + '/assets/no-existe.js')).status === 404 && (await fetch(WEB + '/no-existe')).status === 404 && (await fetch(WEB + '/index.html')).status === 404 && (await fetch(WEB + '/app')).status === 404 && (await fetch(WEB + '/admin')).status === 404, 'lo que no existe da 404 (también /index.html, /app y /admin: la aplicación no está en rutas obvias)');
  const appHtml2 = async () => (await fetch(WEB + `/${APPP}/`)).text();
  const ent = await (await fetch(WEB + '/api/v1/app/entry')).json();
  check(ent.app_path === `/${APPP}/` && ent.demo_url === '/demo/', 'la API pública da la ruta de la aplicación (botón «Acceder» y app Android) y la demo incluida');
  const demoP = await fetch(WEB + '/demo/'), demoH = await demoP.text();
  check(demoP.status === 200 && /DECARGO · Demostración/.test(demoH) && !/rel="manifest"/.test(demoH) && (await fetch(WEB + '/demo/transportes')).status === 200 && /noindex/.test(demoP.headers.get('x-robots-tag') || ''), 'la demo se sirve en /demo/ (sin manifiesto instalable, sin indexar) y admite recargar en cualquier pantalla');
  const mainJs = (await appHtml2()).match(/\/assets\/index-[^"]+\.js/)?.[0];
  check(!!mainJs && !(await (await fetch(WEB + mainJs)).text()).includes('Transportes Ejemplo del Sur'), 'el código de la demo no va dentro de la aplicación real');
  const mf = await fetch(WEB + '/manifest.webmanifest'), mfj = await mf.json();
  check(mf.status === 200 && mfj.start_url === `/${APPP}/` && mfj.id === '/' && mfj.scope === '/', 'el manifiesto de la aplicación instalable arranca en la ruta de la aplicación y conserva su identidad');
  check((await fetch(WEB + '/api/v1/transports')).status === 401 && (await fetch(WEB + `/${APPP}/api/v1/transports`)).status === 200 && !(/"id"/.test(await (await fetch(WEB + `/${APPP}/api/v1/transports`)).text())), 'sin sesión no hay datos: la API sigue exigiendo credenciales y la ruta de la aplicación solo devuelve la página');

  const sw = await fetch(WEB + '/service-worker.js'); check(sw.status === 200 && /no-store/.test(sw.headers.get('cache-control') || ''), 'el service worker no se cachea');
  const devWeb = await fetch(WEB + '/api/v1/dev/test-deca', { method: 'POST', headers: { authorization: `Bearer ${ENV.DEV_API_KEY}` } });
  check(devWeb.status === 404, 'los endpoints de PRUEBA no son accesibles a través de la web, ni siquiera con la clave correcta');
  const lw = await fetch(WEB + '/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: `nadie-${sfx}`, password: 'x' }) });
  check(lw.status === 401 && /no-store/.test(lw.headers.get('cache-control') || ''), 'el proxy reenvía /api (401 en un login inválido) con Cache-Control no-store');
  const apiMe = await fetch(WEB + '/api/v1/me', { headers: { authorization: `Bearer ${dA.tok}` } });
  check(apiMe.status === 200 || apiMe.status === 401, 'las respuestas autenticadas atraviesan el proxy');
  // La IP del cliente: la API directa NO se fía de X-Forwarded-For (no viene de la red interna de `web`)
  resetThrottle();
  await fetch(API() + '/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.77' }, body: JSON.stringify({ username: `spoof-${sfx}`, password: 'x' }) });
  check(psql(`SELECT count(*) FROM login_throttle WHERE key LIKE '%198.51.100.77%'`) === '0' && Number(psql(`SELECT count(*) FROM login_throttle WHERE key LIKE '%spoof-${sfx}%'`)) > 0, 'la API directa ignora un X-Forwarded-For falsificado (el límite de intentos usa la IP real de la conexión)');
  await fetch(WEB + '/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.88' }, body: JSON.stringify({ username: `viaweb-${sfx}`, password: 'x' }) });
  const viaKeys = psql(`SELECT string_agg(key, ' ; ') FROM login_throttle WHERE key LIKE 'ip:%' AND updated_at > now() - interval '30 seconds'`);
  info(`IP registrada tras pasar por la web con X-Forwarded-For: ${viaKeys}. Es lo previsto si esta prueba corre en el mismo equipo (llega por la pasarela de Docker, que se trata como NPM); un cliente de la LAN no puede falsearla.`);
  resetThrottle();

  // ---- 16.9 desactivar / reactivar
  info('16.9 Desactivar y reactivar un usuario');
  const dC = await mkUser('conductor', 'webC');
  check((await http('POST', `/api/v1/users/${dC.id}/reactivate`, { token: dA.tok })).status === 403 && (await http('POST', `/api/v1/users/${dC.id}/reactivate`, { token: ro16.tok })).status === 403, 'ni un conductor ni solo_lectura pueden reactivar usuarios (403)');
  check((await http('POST', `/api/v1/users/${dC.id}/deactivate`, { token: O })).status === 204, 'oficina desactiva al conductor C');
  const lc1 = await loginAs(dC, dC.dev); check(lc1.status === 401, 'un usuario desactivado no puede entrar (401 genérico)', `${lc1.status}`);
  check((await http('GET', '/api/v1/driver/transports', { token: dC.tok })).status === 401, 'su sesión anterior queda cerrada');
  check((await http('POST', `/api/v1/users/${dC.id}/reactivate`, { token: O })).status === 204, 'oficina lo reactiva');
  const lc2 = await loginAs(dC, dC.dev); check(lc2.status === 200 && lc2.json.scope === 'FULL' && lc2.json.device.status === 'AUTORIZADO', 'tras reactivarlo entra con su contraseña y su dispositivo sigue autorizado');
  check(psql(`SELECT count(*) FROM audit_log WHERE entity_id='${dC.id}' AND action IN ('USER_DEACTIVATED','USER_REACTIVATED')`) === '2', 'desactivación y reactivación constan en la auditoría');

  // ---- 16.11 Configuración: dirección pública desde la web
  info('16.11 Configuración (dirección pública)');
  const AD2 = (await loginAs(admin, admin.device)).json.access_token;
  for (const [who, tok, want] of [['sin sesión', undefined, 401], ['conductor', dA.tok, 403], ['oficina', O, 403], ['solo_lectura', ro16.tok, 403], ['administrador', AD2, 200]]) {
    const g = await http('GET', '/api/v1/admin/config', { token: tok }), pu = tok === AD2 ? null : await http('PUT', '/api/v1/admin/config/public-base-url', { token: tok, body: { url: 'https://intruso.example.com' } });
    check(g.status === want && (!pu || pu.status === (tok ? 403 : 401)), `Configuración: ${who} → lectura ${want}${pu ? ' y escritura denegada' : ''}`, `${g.status}/${pu?.status}`);
  }
  const cfg0 = (await http('GET', '/api/v1/admin/config', { token: AD2 })).json;
  check(cfg0.source === 'env' && cfg0.public_base_url === (ENV.PUBLIC_DOCS_BASE_URL || '').replace(/\/+$/, '') && !JSON.stringify(cfg0).match(/VAPID_PRIVATE|APP_KEY|DB_.*PASSWORD/) && typeof cfg0.decas_total === 'number', 'la configuración parte de la dirección del .env, informa de cuántos DeCA hay y no expone ningún secreto');
  for (const [u, why] of [['ftp://decargo.example.com', 'protocolo no permitido'], ['https://decargo.example.com/ruta', 'con ruta'], ['https://usuario:clave@decargo.example.com', 'con credenciales'], ['https://decargo.example.com/?a=1', 'con parámetros'], ['no es una url', 'texto libre'], ['', 'vacía']]) {
    const r = await http('PUT', '/api/v1/admin/config/public-base-url', { token: AD2, body: { url: u } }); check(r.status === 400 && r.json.error === 'invalid_public_url', `dirección rechazada (${why}) → 400`, `${r.status}`);
  }
  check((await http('GET', '/api/v1/admin/config', { token: AD2 })).json.source === 'env', 'ninguna dirección inválida se guardó');
  const NEWB = 'http://dominio-nuevo.test:28081';
  const put = await http('PUT', '/api/v1/admin/config/public-base-url', { token: AD2, body: { url: `${NEWB}/` } });
  check(put.status === 200 && put.json.public_base_url === NEWB && put.json.source === 'web' && put.json.decas_other_base >= 1, 'el administrador fija una dirección nueva (se normaliza) y el panel cuenta los DeCA con la dirección anterior', `${put.status} ${JSON.stringify(put.json).slice(0, 120)}`);
  const tNew = await call('POST', '/api/v1/transports', { token: O, body: tbody({ cargo: `Tras el cambio ${sfx}`, driver_id: dA.id }) });
  const dNew = await call('GET', `/api/v1/transports/${tNew.json.id}`, { token: O });
  const qrNew = decodeQr((await call('GET', `/api/v1/decas/${tNew.json.deca_id}/qr.svg`, { token: O })).buf, 'qnew.svg'), pdfNew = decodeQr((await call('GET', `/api/v1/decas/${tNew.json.deca_id}/versions/1/pdf`, { token: O })).buf, 'pnew.pdf');
  check(dNew.json.deca.technical.public_url.startsWith(`${NEWB}/d/`) && qrNew === dNew.json.deca.technical.public_url && pdfNew === qrNew && dNew.json.deca.technical.other_base === false, 'un DeCA emitido tras el cambio lleva la dirección nueva, igual en el PDF, en el QR y en el detalle');
  check(det.json.deca.technical.public_url === (await call('GET', `/api/v1/transports/${TID}`, { token: O })).json.deca.technical.public_url && (await call('GET', `/api/v1/transports/${TID}`, { token: O })).json.deca.technical.other_base === true, 'el DeCA anterior conserva su dirección impresa y se señala como emitido con otra');
  const viaNew = await fetch(DOCS + new URL(dNew.json.deca.technical.public_url).pathname); check(viaNew.status === 200 && sha256(Buffer.from(await viaNew.arrayBuffer())) === dNew.json.deca.technical.sha256, 'el servicio documental sirve el DeCA nuevo con cualquier nombre de dominio (solo cuenta el código)');
  check(psql(`SELECT count(*) FROM audit_log WHERE action='CONFIG_PUBLIC_URL_CHANGED' AND after->>'url'='${NEWB}'`) === '1', 'el cambio de dirección queda en la auditoría (quién, antes y después)');
  const ck1 = await http('POST', '/api/v1/admin/config/check', { token: AD2, body: { url: 'http://docs:8081' } }), ck2 = await http('POST', '/api/v1/admin/config/check', { token: AD2, body: { url: 'http://web:8080' } });
  check(ck1.status === 200 && ck1.json.docs?.ok === true && ck1.json.web?.ok === false, 'Comprobar: contra el servicio documental, «/d/» responde y «/» no es DECARGO', JSON.stringify(ck1.json).slice(0, 200));
  check(ck2.status === 200 && ck2.json.web?.ok === true && ck2.json.docs?.ok === false, 'Comprobar: contra la web, «/» es DECARGO y «/d/» NO llega a documentos (falta la ruta en el proxy)', JSON.stringify(ck2.json).slice(0, 200));
  check((await http('POST', '/api/v1/admin/config/check', { token: AD2, body: { url: 'ftp://x.example.com' } })).status === 400 && (await http('POST', '/api/v1/admin/config/check', { token: O, body: {} })).status === 403, 'Comprobar rechaza una dirección inválida (400) y solo la usa el administrador (403)');
  check(psqlAs('deca_docs', ENV.DB_DOCS_PASSWORD, `SELECT 1 FROM app_setting LIMIT 1`).includes('permission denied') && psqlAs('deca_api', ENV.DB_API_PASSWORD, `DELETE FROM app_setting`).includes('permission denied'), 'permisos de BD: docs no lee los ajustes y la API no puede borrarlos');
  const back = await http('PUT', '/api/v1/admin/config/public-base-url', { token: AD2, body: { url: (ENV.PUBLIC_DOCS_BASE_URL || '').replace(/\/+$/, '') } });
  check(back.status === 200 && back.json.decas_other_base >= 1, 'se puede volver a la dirección anterior');
  const cliShow = JSON.parse(sh('./deca config show').split('\n').find((l) => l.includes('public_base_url')).replace(/^[^{]*/, ''));
  check(cliShow.public_base_url === (ENV.PUBLIC_DOCS_BASE_URL || '').replace(/\/+$/, '') && cliShow.source === 'web', './deca config show informa de la dirección vigente (la de la base de datos)');

  // ---- 16.12 Reemisión con la dirección actual
  info('16.12 Reemisión con la dirección actual');
  const ENVB = (ENV.PUBLIC_DOCS_BASE_URL || '').replace(/\/+$/, '');
  const oldId = tNew.json.deca_id, oldUrl = dNew.json.deca.technical.public_url, oldSha = dNew.json.deca.technical.sha256;
  const rq = (tok, id, reason) => http('POST', `/api/v1/admin/decas/${id}/reissue`, { token: tok, body: reason === undefined ? {} : { reason } });
  check([await rq(undefined, oldId, 'motivo valido'), await rq(dA.tok, oldId, 'motivo valido'), await rq(O, oldId, 'motivo valido'), await rq(ro16.tok, oldId, 'motivo valido')].map((r) => r.status).join() === '401,403,403,403', 'reemitir: sin sesión 401; conductor, oficina y solo_lectura 403 (solo el administrador)');
  check((await rq(AD2, oldId)).status === 400 && (await rq(AD2, oldId, 'ab')).status === 400 && (await rq(AD2, 'zzz', 'motivo valido')).status === 404, 'reemitir exige un motivo (400) y un identificador válido (404)');
  const rs = await rq(AD2, oldId, 'Dirección pública actualizada');
  check(rs.status === 201 && rs.json.deca_id && rs.json.deca_id !== oldId && rs.json.url.startsWith(`${ENVB}/d/`), 'el administrador reemite un DeCA: token, URL y PDF nuevos con la dirección actual', `${rs.status} ${JSON.stringify(rs.json).slice(0, 100)}`);
  const dRe = await call('GET', `/api/v1/transports/${tNew.json.id}`, { token: O });
  const pdfRe = await call('GET', `/api/v1/decas/${rs.json.deca_id}/versions/1/pdf`, { token: O });
  check(dRe.json.deca.id === rs.json.deca_id && dRe.json.deca.version === 1 && dRe.json.deca.technical.other_base === false && decodeQr(pdfRe.buf, 'reiss.pdf') === rs.json.url && dRe.json.deca.technical.public_url === rs.json.url, 'el transporte pasa a mostrar el DeCA nuevo (una sola vez) y su PDF lleva el QR con la dirección actual');
  check(psql(`SELECT status FROM deca WHERE id='${oldId}'`) === 'SUPERSEDED' && psql(`SELECT count(*) FROM deca_version WHERE deca_id='${oldId}'`) === '1', 'el DeCA anterior queda SUPERSEDED y conserva su versión y su PDF');
  const oldServed = await fetch(DOCS + new URL(oldUrl).pathname); check(oldServed.status === 200 && sha256(Buffer.from(await oldServed.arrayBuffer())) === oldSha, 'la URL antigua sigue sirviendo su PDF original (un QR ya entregado no se rompe)');
  const lst = await call('GET', '/api/v1/transports', { token: O }, true); check(lst.json.filter((x) => x.id === tNew.json.id).length === 1, 'el listado de transportes no duplica el transporte');
  const dlist = await http('GET', '/api/v1/driver/transports', { token: dA.tok });
  check(dlist.json.find((x) => x.id === tNew.json.id)?.deca.id === rs.json.deca_id && (await http('GET', `/api/v1/driver/decas/${oldId}/current.pdf`, { token: dA.tok })).status === 404 && (await http('GET', `/api/v1/driver/decas/${rs.json.deca_id}/current.pdf`, { token: dA.tok })).status === 200, 'el conductor pasa a ver el DeCA nuevo; el sustituido ya no se le sirve');
  check((await rq(AD2, oldId, 'otra vez')).status === 409 && (await call('POST', `/api/v1/transports/${tNew.json.id}/deca`, { token: O })).status === 409 && (await call('PUT', `/api/v1/transports/${tNew.json.id}/vehicles`, { token: O, body: { tractor_id: vT.json.id } })).status === 409, 'un DeCA sustituido no se puede reemitir de nuevo y el transporte sigue teniendo un único DeCA vigente');
  check(psql(`SELECT count(*) FROM audit_log WHERE action='DECA_REISSUED' AND entity_id='${oldId}' AND after->>'replaced_by'='${rs.json.deca_id}'`) === '1', 'la reemisión queda en la auditoría (DeCA anterior, nuevo y motivo)');
  // masiva: cambia la dirección, todos los vigentes quedan «con otra», se reemiten y se vuelve
  await http('PUT', '/api/v1/admin/config/public-base-url', { token: AD2, body: { url: NEWB } });
  const cA = (await http('GET', '/api/v1/admin/config', { token: AD2 })).json;
  check(cA.decas_other_base === cA.decas_total && cA.decas_total >= 3, `con otra dirección, los ${cA.decas_total} DeCA vigentes se señalan como emitidos con otra`);
  check((await http('POST', '/api/v1/admin/decas/reissue-outdated', { token: O, body: { reason: 'masivo valido' } })).status === 403 && (await http('POST', '/api/v1/admin/decas/reissue-outdated', { token: AD2, body: {} })).status === 400, 'la reemisión masiva exige administrador (403) y motivo (400)');
  const bulk = await http('POST', '/api/v1/admin/decas/reissue-outdated', { token: AD2, body: { reason: 'Dirección pública actualizada' } });
  check(bulk.status === 200 && bulk.json.reissued === cA.decas_total && bulk.json.failed === 0, `reemisión masiva: ${bulk.json.reissued}/${bulk.json.total} reemitidos, 0 errores`, JSON.stringify(bulk.json));
  check((await http('GET', '/api/v1/admin/config', { token: AD2 })).json.decas_other_base === 0 && psql(`SELECT count(*) FROM deca WHERE status='ACTIVE' AND left(public_url, ${NEWB.length + 3}) <> '${NEWB}/d/'`) === '0', 'tras la reemisión masiva ningún DeCA vigente lleva otra dirección');
  const own = await call('GET', `/api/v1/transports/${TID}`, { token: O }); check(own.json.deca.technical.public_url.startsWith(`${NEWB}/d/`) && own.json.deca.version === 1, 'cada transporte muestra su DeCA vigente nuevo');
  await http('PUT', '/api/v1/admin/config/public-base-url', { token: AD2, body: { url: ENVB } });
  const bulk2 = await http('POST', '/api/v1/admin/decas/reissue-outdated', { token: AD2, body: { reason: 'Vuelta a la dirección habitual' } });
  check(bulk2.status === 200 && bulk2.json.failed === 0 && bulk2.json.reissued >= 3, 'y se puede volver a la dirección habitual reemitiendo otra vez');
  const vj16 = JSON.parse((() => { const o = sh('./deca verify'); return o.slice(o.indexOf('{')); })()); check(vj16.problems.length === 0 && vj16.audit_chain_ok && vj16.tokens_recoverable === vj16.decas, `verify tras reemitir: ${vj16.decas} DeCA (incluidos los sustituidos), todos con su PDF, token recuperable y cadena de auditoría íntegra`);

  // ---- 16.13 Varios lugares de carga y descarga, empresa y modo de pruebas
  info('16.13 Lugares de carga y descarga, empresa propia y modo de pruebas');
  const tm = await call('POST', '/api/v1/transports', { token: O, body: tbody({ driver_id: dA.id, origin: undefined, destination: undefined,
    origins: [{ party: 'Cargadora Uno S.L.', address: 'Nave 1, Polígono Norte, Almería' }, { address: 'Almacén 2, El Ejido' }],
    destinations: [{ party: 'Cliente Dos S.A.', address: 'Calle Mayor 5, Roquetas' }, { party: 'Cliente Tres S.L.', address: 'Mercado Central, Níjar' }, { address: 'Muelle 4, Motril' }], cargo: `Multiparada ${sfx}` }) });
  check(tm.status === 201 && tm.json.deca_id, 'un transporte con 2 lugares de carga y 3 de descarga (con empresas distintas al cargar y al descargar) se crea con su DeCA', `${tm.status} ${tm.text}`);
  const dm = await call('GET', `/api/v1/transports/${tm.json.id}`, { token: O });
  check(dm.json.origins.length === 2 && dm.json.destinations.length === 3 && dm.json.origins[0].party === 'Cargadora Uno S.L.' && dm.json.origins[1].party === null && dm.json.destinations[1].party === 'Cliente Tres S.L.', 'el detalle devuelve cada lugar con su empresa (la empresa es opcional)');
  const ptm = pdfText((await call('GET', `/api/v1/decas/${tm.json.deca_id}/versions/1/pdf`, { token: O })).buf);
  check(ptm.includes('Lugares de origen (carga)') && ptm.includes('Lugares de destino (descarga)') && ptm.includes('Cargadora Uno S.L.') && ptm.includes('Cliente Tres S.L.') && ptm.includes('Muelle 4, Motril') && /1\)/.test(ptm) && /3\)/.test(ptm), 'el PDF imprime todos los lugares numerados, con la empresa de cada uno');
  const ltm = (await call('GET', '/api/v1/transports', { token: O }, true)).json.find((x) => x.id === tm.json.id);
  check(ltm && !ltm.origin.includes('\n') && ltm.origin.includes('Cargadora Uno S.L.') && ltm.origin.includes(' · '), 'el listado muestra los lugares en una línea');
  const dtm = await http('GET', `/api/v1/driver/transports/${tm.json.id}`, { token: dA.tok });
  check(dtm.status === 200 && dtm.json.origin.includes('Almacén 2, El Ejido') && dtm.json.destination.includes('Cliente Dos S.A.'), 'el conductor ve todos los lugares de su transporte');
  const t13 = nTr();
  for (const [o, why] of [[{ origins: [] }, 'lista de carga vacía'], [{ destinations: Array.from({ length: 11 }, (_, i) => ({ address: `Lugar número ${i}` })) }, 'más de 10 lugares'], [{ origins: [{ party: 'Sin dirección' }] }, 'un lugar sin dirección'],
    [{ origins: 'texto' }, 'lugares que no son una lista'], [{ destinations: [{ party: 'x\u0001y', address: 'Calle válida 1' }] }, 'carácter de control en la empresa'], [{ origins: [{ address: 'ab' }] }, 'dirección demasiado corta']]) {
    const r = await call('POST', '/api/v1/transports', { token: O, body: tbody(o) }); check(r.status === 400, `lugares rechazados (${why}) → 400`, `${r.status}`);
  }
  check(nTr() === t13, 'ningún transporte con lugares inválidos se guardó');
  // Empresa = transportista efectivo por defecto
  const coBefore = (await http('GET', '/api/v1/admin/config', { token: AD2 })).json.company;
  for (const [who, tok, want] of [['sin sesión', undefined, 401], ['conductor', dA.tok, 403], ['oficina', O, 403], ['solo_lectura', ro16.tok, 403]]) check((await http('PUT', '/api/v1/admin/config/company', { token: tok, body: { name: 'Intrusa S.L.', nif: 'B11111111', address: 'Calle X 1' } })).status === want, `datos de la empresa: ${who} → ${want}`);
  check((await http('PUT', '/api/v1/admin/config/company', { token: AD2, body: { name: 'Mi Empresa Real S.L.', nif: '!', address: 'Calle Real 1, Almería' } })).status === 400, 'datos de la empresa con NIF inválido → 400');
  const coPut = await http('PUT', '/api/v1/admin/config/company', { token: AD2, body: { name: `Transportes Reales ${SFX} S.L.`, nif: 'B12345674', address: 'Calle Real 1, 04001 Almería' } });
  check(coPut.status === 200 && coPut.json.company.name === `Transportes Reales ${SFX} S.L.`, 'el administrador cambia los datos de su empresa (transportista efectivo por defecto)');
  const tcoN = await call('POST', '/api/v1/transports', { token: O, body: tbody({ cargo: `Con empresa nueva ${sfx}`, driver_id: undefined }) });
  const dcoN = await call('GET', `/api/v1/transports/${tcoN.json.id}`, { token: O });
  const pcoN = pdfText((await call('GET', `/api/v1/decas/${tcoN.json.deca_id}/versions/1/pdf`, { token: O })).buf);
  check(dcoN.json.carrier.name === `Transportes Reales ${SFX} S.L.` && dcoN.json.carrier.nif === 'B12345674' && pcoN.includes(`Transportes Reales ${SFX} S.L.`) && pcoN.includes('B12345674'), 'los transportes y DeCA nuevos llevan como transportista efectivo la empresa configurada');
  check((await call('GET', `/api/v1/transports/${TID}`, { token: O })).json.carrier.name === coBefore.name, 'los DeCA ya emitidos conservan su transportista');
  check(psql(`SELECT count(*) FROM audit_log WHERE action='COMPANY_UPDATED' AND after->>'name'='Transportes Reales ${SFX} S.L.'`) === '1', 'el cambio de empresa queda en la auditoría (antes y después)');
  await http('PUT', '/api/v1/admin/config/company', { token: AD2, body: coBefore });
  // Interruptores
  for (const [who, tok, want] of [['sin sesión', undefined, 401], ['oficina', O, 403], ['solo_lectura', ro16.tok, 403]]) check((await http('PUT', '/api/v1/admin/config/flags', { token: tok, body: { test_mode: false } })).status === want, `interruptores: ${who} → ${want}`);
  check((await http('PUT', '/api/v1/admin/config/flags', { token: AD2, body: {} })).status === 400 && (await http('PUT', '/api/v1/admin/config/flags', { token: AD2, body: { test_mode: 'no' } })).status === 400, 'interruptores: sin datos o con un valor que no es booleano → 400');
  const fOff = await http('PUT', '/api/v1/admin/config/flags', { token: AD2, body: { test_mode: false } });
  check(fOff.status === 200 && fOff.json.test_mode === false && fOff.json.test_mode_source === 'web', 'el administrador desactiva el modo de pruebas desde la web');
  const treal = await call('POST', '/api/v1/transports', { token: O, body: tbody({ cargo: `Sin rótulo ${sfx}`, driver_id: undefined }) });
  const preal = pdfText((await call('GET', `/api/v1/decas/${treal.json.deca_id}/versions/1/pdf`, { token: O })).buf);
  check(!/DOCUMENTO DE PRUEBA/.test(preal) && /Sin rótulo/.test(preal), 'con el modo de pruebas desactivado, el DeCA nuevo sale SIN el rótulo de prueba');
  check(/DOCUMENTO DE PRUEBA/.test(pcoN), 'los DeCA anteriores conservan su rótulo de prueba');
  const fOn = await http('PUT', '/api/v1/admin/config/flags', { token: AD2, body: { test_mode: true } });
  const tback = await call('POST', '/api/v1/transports', { token: O, body: tbody({ cargo: `Con rótulo ${sfx}`, driver_id: undefined }) });
  check(fOn.json.test_mode === true && /DOCUMENTO DE PRUEBA/.test(pdfText((await call('GET', `/api/v1/decas/${tback.json.deca_id}/versions/1/pdf`, { token: O })).buf)), 'y se puede volver al modo de pruebas');
  check(psql(`SELECT count(*) FROM audit_log WHERE action='CONFIG_FLAG_CHANGED' AND entity_id='test_mode'`) === '2', 'los dos cambios del modo de pruebas constan en la auditoría');
  const devCall = () => fetch(`${API()}/api/v1/dev/test-deca`, { method: 'POST', headers: { authorization: `Bearer ${ENV.DEV_API_KEY}` } }).then((r) => r.status);
  check(await devCall() === 201, 'con los endpoints de prueba activados, el de prueba responde');
  const dOff = await http('PUT', '/api/v1/admin/config/flags', { token: AD2, body: { dev_endpoints: false } });
  check(dOff.json.dev_endpoints === false && await devCall() === 404, 'el administrador desactiva los endpoints de prueba desde la web y dejan de existir (404) sin reiniciar nada');
  check((await http('PUT', '/api/v1/admin/config/flags', { token: AD2, body: { dev_endpoints: true } })).json.dev_endpoints === true && await devCall() === 201, 'y se pueden volver a activar');

  // ---- 16.14 «Probar aviso» lanzado por la oficina, con seguimiento (sin enviar nada real a Internet)
  info('16.14 Probar aviso desde la oficina');
  const pt = (tok, id) => http('POST', `/api/v1/devices/${id}/push-test`, { token: tok });
  const pend16 = await loginAs(dB, null, 'movil-nuevo-b'); const pendDev = pend16.json?.device?.id;
  check([await pt(undefined, dA.dev.id), await pt(dA.tok, dA.dev.id), await pt(ro16.tok, dA.dev.id)].map((r) => r.status).join() === '401,403,403', 'probar aviso: sin sesión 401; conductor y solo_lectura 403 (solo oficina y administrador)');
  const noSub = await pt(O, dA.dev.id); check(noSub.status === 409 && noSub.json.error === 'sin_suscripcion', 'un dispositivo sin avisos activados → 409 sin_suscripcion (se le dice al conductor que los active)');
  check(pend16.status === 200 && (await pt(O, pendDev)).json.error === 'dispositivo_no_autorizado', 'un dispositivo PENDIENTE no se puede probar (409): no recibe avisos (D-05)');
  check((await pt(O, admin.device.id)).status === 404 && (await pt(O, 'zzz')).status === 404 && (await pt(O, '0'.repeat(8) + '-0000-0000-0000-' + '0'.repeat(12))).status === 404, 'oficina solo prueba dispositivos de conductores (el de un administrador y los inexistentes → 404)');
  const devs = await call('GET', `/api/v1/devices?user_id=${dA.id}`, { token: O });
  check(devs.json.length >= 1 && devs.json.every((d) => d.push_subscribed === false), 'el listado de dispositivos indica si tienen los avisos activados');
  // circuito de acuses: lo que haría el service worker del teléfono
  const tid = psql(`INSERT INTO push_test (device_id, requested_by, sent_at) VALUES ('${dA.dev.id}', '${ofi.id}', now()) RETURNING id`).split('\n')[0];
  const ack = (n, event) => http('POST', '/api/v1/push/ack', { body: { n, event } });
  const st0 = await http('GET', `/api/v1/push-test/${tid}`, { token: O });
  check(st0.status === 200 && st0.json.sent_at && !st0.json.received_at && !st0.json.shown_at && !st0.json.clicked_at, 'estado inicial de una prueba: enviada, sin acuses del teléfono');
  check([await ack(tid, 'received'), await ack(tid, 'shown'), await ack(tid, 'clicked')].every((r) => r.status === 204), 'el teléfono confirma sin sesión: recibido, mostrado y pulsado (204)');
  const st1 = (await http('GET', `/api/v1/push-test/${tid}`, { token: O })).json;
  check(st1.received_at && st1.shown_at && st1.clicked_at, 'la oficina ve los tres acuses');
  const was = st1.received_at; await ack(tid, 'received'); check((await http('GET', `/api/v1/push-test/${tid}`, { token: O })).json.received_at === was, 'un acuse repetido no cambia la hora del primero');
  // datos del teléfono con el acuse: se guardan acotados (claves cortas, textos recortados, nada anidado)
  const tid3 = psql(`INSERT INTO push_test (device_id, requested_by, sent_at) VALUES ('${dA.dev.id}', '${ofi.id}', now()) RETURNING id`).split('\n')[0];
  await ack3(tid3);
  async function ack3(id) { await http('POST', '/api/v1/push/ack', { body: { n: id, event: 'shown', info: { model: 'Pixel 8', os: 'Android 14', perm: 'granted', active: 1, ua: 'x'.repeat(900), 'clave mala!': 'x', anidado: { a: 1 }, lista: [1, 2] } } }); }
  const inf = (await http('GET', `/api/v1/push-test/${tid3}`, { token: O })).json.device_info;
  check(inf && inf.model === 'Pixel 8' && inf.os === 'Android 14' && inf.perm === 'granted' && inf.active === 1 && inf.ua.length === 300 && !('clave mala!' in inf) && !('anidado' in inf) && !('lista' in inf), 'los datos del teléfono (modelo, sistema, permiso, aviso activo) se guardan acotados y la oficina los ve; claves raras y datos anidados se descartan');
  const tid2 = psql(`INSERT INTO push_test (device_id, requested_by, sent_at) VALUES ('${dA.dev.id}', '${ofi.id}', now()) RETURNING id`).split('\n')[0];
  check([await ack(tid2, 'otra-cosa'), await ack('no-es-uuid', 'received'), await ack('0'.repeat(8) + '-0000-0000-0000-' + '0'.repeat(12), 'received'), await http('POST', '/api/v1/push/ack', { body: {} })].every((r) => r.status === 204 || r.status === 400) && !(await http('GET', `/api/v1/push-test/${tid2}`, { token: O })).json.received_at, 'acuses inválidos (evento desconocido, identificador falso o inexistente) no cambian nada y no revelan nada');
  psql(`UPDATE push_test SET created_at = now() - interval '11 minutes' WHERE id = '${tid2}'`); await ack(tid2, 'received');
  check(!(await http('GET', `/api/v1/push-test/${tid2}`, { token: O })).json.received_at, 'un acuse de una prueba de hace más de 10 minutos se ignora');
  const tAdm = psql(`INSERT INTO push_test (device_id, requested_by) VALUES ('${admin.device.id}', '${ofi.id}') RETURNING id`).split('\n')[0];
  check((await http('GET', `/api/v1/push-test/${tAdm}`, { token: O })).status === 404 && (await http('GET', `/api/v1/push-test/${tid}`, { token: dA.tok })).status === 403 && (await http('GET', `/api/v1/push-test/${tid}`)).status === 401, 'el estado de una prueba: oficina solo ve las de conductores (404 si no); el conductor 403; sin sesión 401');
  check(psqlAs('deca_api', ENV.DB_API_PASSWORD, `DELETE FROM push_test`).includes('permission denied') && psqlAs('deca_docs', ENV.DB_DOCS_PASSWORD, `SELECT 1 FROM push_test LIMIT 1`).includes('permission denied'), 'permisos de BD: la API no borra pruebas y docs no las lee');
  check((await http('POST', '/api/v1/driver/push/test', { token: dA.tok })).status === 404, 'ya no existe el botón de prueba del lado del conductor (la prueba la lanza la oficina)');

  // ---- 16.15 Control de documentos, caducidades y tarjetas de vehículo
  info('16.15 Documentos con caducidad, tarjetas de combustible y VIA-T');
  const iso = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
  const DOC = (tok, body) => http('POST', '/api/v1/documents', { token: tok, body });
  const catR = await http('GET', '/api/v1/documents/catalog', { token: O });
  const codes = (k) => catR.json[k].map((t) => t.code);
  check(catR.status === 200 && codes('driver').includes('CAP') && codes('vehicle').includes('ITV') && codes('company').includes('VISADO') && !codes('vehicle').includes('ATP') && !codes('driver').includes('MANIPULADOR') && catR.json.warn_days === 30, 'el catálogo trae los documentos habituales y, sin transporte de alimentos, oculta ATP y manipulador');
  check([await http('GET', '/api/v1/documents/catalog'), await http('GET', '/api/v1/documents/catalog', { token: dA.tok })].map((r) => r.status).join() === '401,403' && (await http('GET', '/api/v1/documents/catalog', { token: ro16.tok })).status === 200, 'catálogo: sin sesión 401, conductor 403, solo_lectura puede consultarlo');
  check((await http('PUT', '/api/v1/admin/config/documents', { token: O, body: { food_transport: true } })).status === 403 && [0, 400, 'x', 1.5].every(async () => true), 'solo el administrador cambia los ajustes de documentos (oficina → 403)');
  for (const w of [0, 400, 'x', 1.5]) check((await http('PUT', '/api/v1/admin/config/documents', { token: AD2, body: { warn_days: w } })).status === 400, `días de aviso inválidos (${w}) → 400`);
  const fOn15 = await http('PUT', '/api/v1/admin/config/documents', { token: AD2, body: { food_transport: true } });
  const cat2 = await http('GET', '/api/v1/documents/catalog', { token: O });
  check(fOn15.json.food_transport === true && cat2.json.vehicle.some((t) => t.code === 'ATP') && cat2.json.driver.some((t) => t.code === 'MANIPULADOR') && cat2.json.company.some((t) => t.code === 'RGSEAA'), 'con transporte de alimentos activado aparecen ATP, equipo de frío, manipulador y registro sanitario');

  // validaciones
  const n15 = () => psql('SELECT count(*) FROM control_document'); const c0 = n15();
  for (const [b, why] of [[{ subject_kind: 'DRIVER', user_id: dA.id, doc_type: 'NO_EXISTE' }, 'tipo inexistente'], [{ subject_kind: 'DRIVER', user_id: dA.id, doc_type: 'OTRO' }, 'otro sin nombre'],
    [{ subject_kind: 'DRIVER', user_id: dA.id, doc_type: 'CAP', issued_on: iso(10), expires_on: iso(-10) }, 'caduca antes de expedirse'], [{ subject_kind: 'DRIVER', user_id: dA.id, doc_type: 'CAP', expires_on: '2026-02-30' }, 'fecha inexistente'],
    [{ subject_kind: 'DRIVER', user_id: ofi.id, doc_type: 'CAP' }, 'usuario que no es conductor'], [{ subject_kind: 'DRIVER', doc_type: 'CAP' }, 'sin conductor'], [{ subject_kind: 'VEHICLE', doc_type: 'ITV' }, 'sin vehículo'],
    [{ subject_kind: 'VEHICLE', vehicle_id: vT.json.id, doc_type: 'ATP' }, 'ATP en una tractora'], [{ subject_kind: 'VEHICLE', vehicle_id: vR.json.id, doc_type: 'TACOGRAFO' }, 'tacógrafo en un semirremolque'],
    [{ subject_kind: 'COMPANY', doc_type: 'CAP' }, 'tipo de otro ámbito'], [{ subject_kind: 'XXX', doc_type: 'CAP' }, 'ámbito inexistente'], [{ subject_kind: 'DRIVER', user_id: dA.id, doc_type: 'CAP', number: 'x\u0001y' }, 'carácter de control']]) {
    const r = await DOC(O, b); check(r.status === 400, `documento rechazado (${why}) → 400`, `${r.status} ${r.text}`);
  }
  check(n15() === c0, 'ningún documento inválido se guardó');
  // permisos
  const sample = { subject_kind: 'DRIVER', user_id: dA.id, doc_type: 'DNI', expires_on: iso(400) };
  check([await DOC(undefined, sample), await DOC(dA.tok, sample), await DOC(ro16.tok, sample)].map((r) => r.status).join() === '401,403,403' && n15() === c0, 'crear documentos: sin sesión 401; conductor y solo_lectura 403; no se guarda nada');
  check([await http('GET', `/api/v1/documents?user_id=${dA.id}`), await http('GET', `/api/v1/documents?user_id=${dA.id}`, { token: dA.tok })].map((r) => r.status).join() === '401,403' && (await http('GET', `/api/v1/documents?user_id=${dA.id}`, { token: ro16.tok })).status === 200, 'ver documentos: el conductor no ve los de nadie (403); solo_lectura puede consultar');

  // alta y estados
  const cap = await DOC(O, { subject_kind: 'DRIVER', user_id: dA.id, doc_type: 'CAP', number: 'CAP-123', expires_on: iso(-10), notes: 'Renovar ya' });
  const dni = await DOC(O, { subject_kind: 'DRIVER', user_id: dA.id, doc_type: 'DNI', expires_on: iso(10) });
  const itvF = await DOC(O, { subject_kind: 'VEHICLE', vehicle_id: vT.json.id, doc_type: 'ITV', expires_on: iso(200) });
  const segN = await DOC(O, { subject_kind: 'VEHICLE', vehicle_id: vT.json.id, doc_type: 'SEGURO' });
  const atp = await DOC(O, { subject_kind: 'VEHICLE', vehicle_id: vR.json.id, doc_type: 'ATP', detail: 'FRC', expires_on: iso(25) });
  const visado = await DOC(O, { subject_kind: 'COMPANY', doc_type: 'VISADO', expires_on: iso(-3) });
  const otro = await DOC(O, { subject_kind: 'DRIVER', user_id: dA.id, doc_type: 'OTRO', label: 'Tarjeta de la nave', expires_on: iso(500) });
  check([cap, dni, itvF, segN, atp, visado, otro].every((r) => r.status === 201) && cap.json.days_left === -10 && segN.json.days_left === null && atp.json.detail === 'FRC', 'se anotan documentos de conductor, vehículo (con ATP en el semirremolque) y empresa; los sin caducidad no tienen fecha');
  const exp0 = await http('GET', '/api/v1/expiries', { token: O });
  const names = exp0.json.map((x) => x.what);
  check(exp0.status === 200 && names.some((n) => /CAP/.test(n)) && names.some((n) => /DNI/.test(n)) && names.some((n) => /ATP/.test(n)) && names.some((n) => /Visado/.test(n)) && !names.some((n) => /ITV/.test(n)) && !names.some((n) => /Seguro/.test(n)) && !names.some((n) => /Tarjeta de la nave/.test(n)), 'caducidades: aparecen caducados y los que caducan en 30 días; no los lejanos ni los que no caducan');
  check(exp0.json[0].status === 'CADUCADO' && exp0.json.every((x, i, a) => i === 0 || a[i - 1].days_left <= x.days_left) && exp0.json.find((x) => /Visado/.test(x.what)).subject === 'Empresa', 'ordenadas por urgencia (primero los caducados) y los de empresa se identifican');
  const dsh15 = (await http('GET', '/api/v1/dashboard', { token: O })).json.expiries; check(dsh15.expired >= 2 && dsh15.soon >= 2, `el panel de Inicio cuenta caducados y próximos (${dsh15.expired} / ${dsh15.soon})`);
  check((await http('GET', '/api/v1/expiries?days=300', { token: O })).json.some((x) => /ITV/.test(x.what)) && [-1, 'x', 999].every(async () => true), 'con 300 días de ventana entra también la ITV lejana');
  for (const d of [-1, 'x', 999]) check((await http('GET', `/api/v1/expiries?days=${d}`, { token: O })).status === 400, `ventana de días inválida (${d}) → 400`);
  await http('PUT', '/api/v1/admin/config/documents', { token: AD2, body: { warn_days: 5 } });
  check(!(await http('GET', '/api/v1/expiries', { token: O })).json.some((x) => /DNI/.test(x.what)) && (await http('GET', '/api/v1/documents/catalog', { token: O })).json.warn_days === 5 && (await http('GET', `/api/v1/documents?user_id=${dA.id}`, { token: O })).json.find((x) => x.doc_type === 'DNI').days_left === 10, 'el plazo de aviso es configurable (con 5 días, el DNI que caduca en 10 deja de avisar)');
  await http('PUT', '/api/v1/admin/config/documents', { token: AD2, body: { warn_days: 30 } });
  // modificar, archivar y auditoría
  const upd = await http('PATCH', `/api/v1/documents/${cap.json.id}`, { token: O, body: { expires_on: iso(1800), number: 'CAP-999', notes: '' } });
  check(upd.status === 200 && upd.json.days_left >= 1799 && upd.json.number === 'CAP-999' && !(await http('GET', '/api/v1/expiries', { token: O })).json.some((x) => /CAP/.test(x.what)), 'renovar un documento (nueva fecha) lo saca de las alertas');
  check((await http('PATCH', `/api/v1/documents/${cap.json.id}`, { token: O, body: {} })).status === 400 && (await http('PATCH', `/api/v1/documents/${cap.json.id}`, { token: O, body: { expires_on: '2001-01-01', issued_on: '2010-01-01' } })).status === 400 && (await http('PATCH', `/api/v1/documents/${cap.json.id}`, { token: ro16.tok, body: { notes: 'x' } })).status === 403 && (await http('PATCH', '/api/v1/documents/zzz', { token: O, body: { notes: 'x' } })).status === 404, 'modificar: sin cambios o con fechas incoherentes 400; solo_lectura 403; identificador inexistente 404');
  const arch = await http('PATCH', `/api/v1/documents/${visado.json.id}`, { token: O, body: { active: false } });
  check(arch.status === 200 && !(await http('GET', '/api/v1/expiries', { token: O })).json.some((x) => /Visado/.test(x.what)) && !(await http('GET', '/api/v1/documents?company=1', { token: O })).json.some((x) => x.id === visado.json.id) && (await http('GET', '/api/v1/documents?company=1&all=1', { token: O })).json.some((x) => x.id === visado.json.id), 'archivar quita el documento de las alertas y de la lista (se ve con «ver archivados»); no se borra');
  check(psql(`SELECT count(*) FROM audit_log WHERE entity_id='${cap.json.id}' AND action IN ('DOCUMENT_CREATED','DOCUMENT_UPDATED')`) === '2' && psql(`SELECT count(*) FROM audit_log WHERE entity_id='${visado.json.id}' AND action='DOCUMENT_ARCHIVED'`) === '1', 'altas, cambios y archivados quedan en la auditoría');
  check(psqlAs('deca_api', ENV.DB_API_PASSWORD, 'DELETE FROM control_document').includes('permission denied') && psqlAs('deca_api', ENV.DB_API_PASSWORD, 'DELETE FROM vehicle_asset').includes('permission denied') && psqlAs('deca_docs', ENV.DB_DOCS_PASSWORD, 'SELECT 1 FROM control_document LIMIT 1').includes('permission denied') && psqlAs('deca_api', ENV.DB_API_PASSWORD, `UPDATE control_document SET doc_type='ITV'`).includes('permission denied'), 'permisos de BD: la API no borra ni cambia el tipo de un documento; docs no los lee');
  // usuarios inactivos no generan alertas
  const dcDoc = await DOC(O, { subject_kind: 'DRIVER', user_id: dC.id, doc_type: 'PERMISO', detail: 'C+E', expires_on: iso(-5) });
  const has = async () => (await http('GET', '/api/v1/expiries', { token: O })).json.some((x) => x.user_id === dC.id);
  await http('POST', `/api/v1/users/${dC.id}/deactivate`, { token: O }); const whileOff = await has(); await http('POST', `/api/v1/users/${dC.id}/reactivate`, { token: O });
  check(dcDoc.status === 201 && whileOff === false && (await has()) === true, 'un conductor desactivado deja de generar alertas y las recupera al reactivarlo');

  // tarjetas de combustible y VIA-T
  const AS = (tok, id, body) => http('POST', `/api/v1/vehicles/${id}/assets`, { token: tok, body });
  const fuel = await AS(O, vT.json.id, { kind: 'FUEL_CARD', provider: 'Solred', identifier: '7078-1234-5678', pin: 'zX7pQ4', expires_on: iso(20), notes: 'Tarjeta principal' });
  const viat = await AS(O, vT.json.id, { kind: 'VIA_T', provider: 'Telepeaje', identifier: 'SN-00991122', expires_on: iso(300) });
  check(fuel.status === 201 && fuel.json.has_pin === true && !('pin' in fuel.json) && !('pin_enc' in fuel.json) && viat.status === 201 && viat.json.has_pin === false, 'se anotan una tarjeta de combustible (con PIN) y un VIA-T; la respuesta nunca incluye el PIN');
  check(psql(`SELECT pin_enc IS NOT NULL AND pin_enc NOT LIKE '%zX7pQ4%' FROM vehicle_asset WHERE id='${fuel.json.id}'`) === 't', 'el PIN se guarda cifrado (no aparece en claro en la tabla)');
  const dump16 = execFileSync('docker', ['compose', 'exec', '-T', 'db', 'pg_dump', '-U', 'postgres', 'decargo'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  check(!dump16.includes('zX7pQ4'), 'ni en un volcado completo de la base de datos se ve el PIN en claro');
  for (const [b, why] of [[{ kind: 'VIA_T', identifier: 'SN-1234', pin: '1234' }, 'PIN en un VIA-T'], [{ kind: 'FUEL_CARD', identifier: '123456', pin: '12' }, 'PIN demasiado corto'], [{ kind: 'FUEL_CARD', identifier: '123456', pin: 'a b!' }, 'PIN con caracteres raros'],
    [{ kind: 'FUEL_CARD', identifier: '12' }, 'número demasiado corto'], [{ kind: 'COCHE', identifier: '123456' }, 'tipo inexistente'], [{ kind: 'FUEL_CARD', identifier: '123456', expires_on: '2026-13-01' }, 'fecha inválida']]) {
    check((await AS(O, vT.json.id, b)).status === 400, `tarjeta rechazada (${why}) → 400`);
  }
  check([await AS(undefined, vT.json.id, { kind: 'FUEL_CARD', identifier: '123456' }), await AS(dA.tok, vT.json.id, { kind: 'FUEL_CARD', identifier: '123456' }), await AS(ro16.tok, vT.json.id, { kind: 'FUEL_CARD', identifier: '123456' })].map((r) => r.status).join() === '401,403,403' && (await AS(O, '0'.repeat(8) + '-0000-0000-0000-' + '0'.repeat(12), { kind: 'FUEL_CARD', identifier: '123456' })).status === 404, 'crear tarjetas: sin sesión 401; conductor y solo_lectura 403; vehículo inexistente 404');
  const lstAssets = await http('GET', `/api/v1/vehicles/${vT.json.id}/assets`, { token: ro16.tok });
  check(lstAssets.status === 200 && lstAssets.json.length === 2 && !JSON.stringify(lstAssets.json).includes('zX7pQ4') && !JSON.stringify(lstAssets.json).includes('pin_enc'), 'solo_lectura ve las tarjetas pero nunca el PIN');
  const rev = await fetch(`${API()}/api/v1/assets/${fuel.json.id}/reveal-pin`, { method: 'POST', headers: { authorization: `Bearer ${O}` } });
  const revJ = await rev.json();
  check(rev.status === 200 && revJ.pin === 'zX7pQ4' && /no-store/.test(rev.headers.get('cache-control') || ''), 'la oficina puede ver el PIN cuando lo pide (respuesta sin caché)');
  check([await http('POST', `/api/v1/assets/${fuel.json.id}/reveal-pin`), await http('POST', `/api/v1/assets/${fuel.json.id}/reveal-pin`, { token: dA.tok }), await http('POST', `/api/v1/assets/${fuel.json.id}/reveal-pin`, { token: ro16.tok })].map((r) => r.status).join() === '401,403,403', 'ver el PIN: sin sesión 401; conductor y solo_lectura 403');
  check((await http('POST', `/api/v1/assets/${viat.json.id}/reveal-pin`, { token: O })).status === 404 && psql(`SELECT count(*) FROM audit_log WHERE action='VEHICLE_ASSET_PIN_REVEALED' AND entity_id='${fuel.json.id}'`) === '1', 'una tarjeta sin PIN → 404, y cada consulta de un PIN queda en la auditoría');
  const pinUp = await http('PATCH', `/api/v1/assets/${fuel.json.id}`, { token: O, body: { pin: 'wK9mT2' } });
  check(pinUp.status === 200 && (await http('POST', `/api/v1/assets/${fuel.json.id}/reveal-pin`, { token: O })).json.pin === 'wK9mT2', 'cambiar el PIN');
  check((await http('PATCH', `/api/v1/assets/${fuel.json.id}`, { token: O, body: { pin: null } })).json.has_pin === false && (await http('POST', `/api/v1/assets/${fuel.json.id}/reveal-pin`, { token: O })).status === 404, 'borrar el PIN');
  const aud16 = (await http('GET', '/api/v1/audit?limit=500', { token: AD2 })).json.filter((a) => a.entity_id === fuel.json.id);
  check(aud16.length >= 4 && !JSON.stringify(aud16).includes('zX7pQ4') && !JSON.stringify(aud16).includes('wK9mT2'), 'la auditoría de la tarjeta no contiene nunca el PIN');
  const logs = execFileSync('docker', ['compose', 'logs', '--no-color', 'api'], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
  check(!logs.includes('zX7pQ4') && !logs.includes('wK9mT2'), 'los PIN no aparecen en los registros de la API');
  const exp1 = (await http('GET', '/api/v1/expiries', { token: O })).json;
  check(exp1.some((x) => x.source === 'asset' && /5678/.test(x.what)) && !exp1.some((x) => /SN-00991122|9911/.test(x.what)), 'la tarjeta que caduca en 20 días avisa (solo con los 4 últimos dígitos); el VIA-T lejano no');
  check((await http('PATCH', `/api/v1/assets/${fuel.json.id}`, { token: O, body: { active: false } })).status === 200 && !(await http('GET', '/api/v1/expiries', { token: O })).json.some((x) => x.source === 'asset') && (await http('GET', `/api/v1/vehicles/${vT.json.id}/assets`, { token: O })).json.length === 1 && (await http('GET', `/api/v1/vehicles/${vT.json.id}/assets?all=1`, { token: O })).json.length === 2, 'archivar una tarjeta la quita de alertas y lista (visible con «ver archivados»)');
  await http('PATCH', `/api/v1/assets/${fuel.json.id}`, { token: O, body: { active: true } });
  // aviso al preparar un transporte
  const chk = await http('GET', `/api/v1/expiries/check?driver_id=${dA.id}&tractor_id=${vT.json.id}&trailer_id=${vR.json.id}`, { token: O });
  check(chk.status === 200 && chk.json.some((x) => /Tarjeta de combustible/.test(x.what)) && chk.json.some((x) => /ATP/.test(x.what)) && chk.json.every((x) => [dA.id, vT.json.id, vR.json.id].includes(x.user_id ?? x.vehicle_id)), 'al elegir conductor y vehículos se avisa de lo que caduca de ESOS y solo de ellos');
  check((await http('GET', `/api/v1/expiries/check?driver_id=${dB.id}`, { token: O })).json.length === 0 && (await http('GET', '/api/v1/expiries/check?driver_id=zzz', { token: O })).status === 400 && [await http('GET', '/api/v1/expiries/check', { token: dA.tok }), await http('GET', '/api/v1/expiries/check', { token: ro16.tok })].map((r) => r.status).join() === '403,403', 'comprobación previa: otro conductor sin documentos → vacío; id inválido 400; conductor y solo_lectura 403');
  await http('PUT', '/api/v1/admin/config/documents', { token: AD2, body: { food_transport: false } });
  check(!(await http('GET', '/api/v1/documents/catalog', { token: O })).json.vehicle.some((t) => t.code === 'ATP') && (await http('GET', `/api/v1/documents?vehicle_id=${vR.json.id}`, { token: O })).json.some((x) => x.doc_type === 'ATP'), 'al desactivar «transporta alimentos» el ATP se oculta del catálogo pero los ya anotados se conservan');

  // ---- 16.16 Ficha del conductor (datos personales, IBAN con banco, cifrado y enmascarado)
  info('16.16 Ficha del conductor');
  const prof = (tok, id) => http('GET', `/api/v1/users/${id}/profile`, { token: tok });
  const putP = (tok, id, body) => http('PUT', `/api/v1/users/${id}/profile`, { token: tok, body });
  const p0 = await prof(O, dA.id);
  check(p0.status === 200 && p0.json.profile.nif.set === false && p0.json.profile.iban.set === false && p0.json.user.id === dA.id, 'la ficha de un conductor sin rellenar se ve vacía');
  check([await prof(undefined, dA.id), await prof(dA.tok, dA.id), await prof(ro16.tok, dA.id)].map((r) => r.status).join() === '401,403,403' && (await prof(O, ofi.id)).status === 404 && (await prof(O, 'zzz')).status === 404, 'ficha: sin sesión 401; conductor y solo_lectura 403 (no ven datos personales); un usuario que no es conductor o inexistente → 404');
  const full = { full_name: 'Carlos Pérez Gómez', nif: '12345678Z', birth_date: '1985-04-12', nationality: 'Española', phone: '600 111 222', email: 'carlos@example.com', street: 'Calle Mayor 12, 2ºA', postal_code: '04001', city: 'Almería', province: 'Almería', country: 'España',
    hire_date: '2024-03-01', contract_type: 'INDEFINIDO', job_category: 'Conductor de camión', ss: '28 1234567890', emergency_name: 'Ana Gómez', emergency_phone: '611222333', iban_holder: 'Carlos Pérez Gómez', iban: 'ES91 2100 0418 4502 0005 1332', notes: 'Prefiere rutas nacionales' };
  const sv = await putP(O, dA.id, full);
  check(sv.status === 200 && sv.json.user.full_name === 'Carlos Pérez Gómez' && sv.json.profile.street === 'Calle Mayor 12, 2ºA' && sv.json.profile.contract_type === 'INDEFINIDO' && sv.json.profile.birth_date === '1985-04-12', 'se guarda la ficha completa (nombre, domicilio, laborales, contacto)', `${sv.status} ${sv.text}`);
  const pj = sv.json.profile;
  check(pj.iban.set && pj.iban.bank === 'CaixaBank' && pj.iban.bank_code === '2100' && pj.iban.country === 'España' && pj.iban.valid === true && /1332$/.test(pj.iban.masked) && !pj.iban.masked.includes('0418'), 'el IBAN se valida, se identifica el banco (CaixaBank) y se muestra enmascarado');
  check(pj.nif.set && /Z$/.test(pj.nif.masked) && !pj.nif.masked.includes('12345678') && pj.ss.set && !pj.ss.masked.includes('2812345'), 'DNI y Seguridad Social se devuelven enmascarados');
  const body16 = JSON.stringify((await prof(O, dA.id)).json);
  check(!body16.includes('12345678Z') && !body16.includes('281234567890') && !body16.includes('ES9121000418450200051332') && !body16.includes('_enc'), 'ninguna respuesta de la ficha contiene el DNI, la Seguridad Social ni el IBAN en claro');
  check(psql(`SELECT nif_enc NOT LIKE '%12345678Z%' AND ss_enc NOT LIKE '%281234567890%' AND iban_enc NOT LIKE '%ES91%' AND nif_enc IS NOT NULL FROM driver_profile WHERE user_id='${dA.id}'`) === 't', 'DNI, Seguridad Social e IBAN se guardan CIFRADOS en la base de datos');
  const dump17 = execFileSync('docker', ['compose', 'exec', '-T', 'db', 'pg_dump', '-U', 'postgres', 'decargo'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  check(!dump17.includes('12345678Z') && !dump17.includes('281234567890') && !dump17.includes('ES9121000418450200051332'), 'ni en un volcado completo de la base de datos aparecen en claro');
  const list17 = (await http('GET', '/api/v1/users', { token: O })).json.find((u) => u.id === dA.id);
  check(list17.full_name === 'Carlos Pérez Gómez', 'el cambio de nombre se refleja en el listado de conductores');
  // validaciones
  const before17 = JSON.stringify((await prof(O, dA.id)).json.profile);
  for (const [b, why] of [[{ nif: '12345678A' }, 'letra del DNI incorrecta'], [{ nif: '1234' }, 'DNI sin formato'], [{ ss: '123' }, 'Seguridad Social corta'], [{ iban: 'ES91 2100 0418 4502 0005 1333' }, 'IBAN con control incorrecto'], [{ iban: 'no es un iban' }, 'IBAN sin formato'],
    [{ email: 'sin-arroba' }, 'correo inválido'], [{ phone: 'abc' }, 'teléfono inválido'], [{ postal_code: '1234' }, 'código postal español de 4 cifras'], [{ birth_date: '2030-01-01' }, 'nacimiento en el futuro'], [{ birth_date: '2026-02-30' }, 'fecha inexistente'],
    [{ contract_type: 'XX' }, 'contrato inexistente'], [{ city: 'x\u0001y' }, 'carácter de control'], [{ full_name: 'x' }, 'nombre demasiado corto'], [{}, 'sin ningún dato']]) {
    const r = await putP(O, dA.id, b); check(r.status === 400, `ficha rechazada (${why}) → 400`, `${r.status} ${r.text}`);
  }
  check(JSON.stringify((await prof(O, dA.id)).json.profile) === before17, 'ningún dato inválido cambió la ficha');
  check((await putP(O, dA.id, { nif: 'X1234567L' })).status === 200 && (await putP(O, dA.id, { nif: '12345678Z' })).status === 200, 'un NIE válido (X1234567L) también se admite');
  check([await putP(undefined, dA.id, { phone: '611000111' }), await putP(dA.tok, dA.id, { phone: '611000111' }), await putP(ro16.tok, dA.id, { phone: '611000111' })].map((r) => r.status).join() === '401,403,403' && (await putP(O, ofi.id, { phone: '611000111' })).status === 404, 'modificar la ficha: sin sesión 401; conductor y solo_lectura 403; usuario que no es conductor 404');
  const part = await putP(O, dA.id, { phone: '655 000 111' });
  check(part.status === 200 && part.json.profile.phone === '655 000 111' && part.json.profile.nif.set && part.json.profile.iban.set && part.json.profile.iban.bank === 'CaixaBank', 'un cambio parcial no borra los datos protegidos');
  // mostrar en claro
  const rv = (tok, field) => http('POST', `/api/v1/users/${dA.id}/profile/reveal`, { token: tok, body: { field } });
  const rvIban = await rv(O, 'iban'), rvNif = await rv(O, 'nif'), rvSs = await rv(O, 'ss');
  check(rvIban.json.value === 'ES9121000418450200051332' && rvIban.json.formatted === 'ES91 2100 0418 4502 0005 1332' && rvNif.json.value === '12345678Z' && rvSs.json.value === '281234567890' && /no-store/.test(rvIban.headers.get('cache-control') || ''), 'la oficina puede ver cada dato en claro cuando lo pide (sin caché)');
  check([await rv(undefined, 'iban'), await rv(dA.tok, 'iban'), await rv(ro16.tok, 'iban')].map((r) => r.status).join() === '401,403,403' && (await rv(O, 'password')).status === 400, 'mostrar datos: sin sesión 401; conductor y solo_lectura 403; un campo no permitido 400');
  check(psql(`SELECT count(*) FROM audit_log WHERE action='DRIVER_PROFILE_FIELD_REVEALED' AND entity_id='${dA.id}'`) === '3', 'cada consulta de un dato protegido queda auditada (quién, cuándo y qué campo)');
  const aud17 = (await http('GET', '/api/v1/audit?limit=500', { token: AD2 })).json.filter((a) => a.entity_id === dA.id && /DRIVER_PROFILE/.test(a.action));
  check(aud17.length >= 6 && aud17.some((a) => a.action === 'DRIVER_PROFILE_UPDATED' && /nif/.test(a.after.fields)) && !JSON.stringify(aud17).match(/12345678Z|281234567890|ES9121|Calle Mayor|600 111|carlos@/), 'la auditoría anota qué campos se tocaron pero nunca los valores');
  const logs17 = execFileSync('docker', ['compose', 'logs', '--no-color', 'api'], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
  check(!logs17.includes('12345678Z') && !logs17.includes('281234567890') && !logs17.includes('ES9121000418450200051332'), 'los datos personales no aparecen en los registros de la API');
  const clr = await putP(O, dA.id, { iban: null, ss: '' });
  check(clr.json.profile.iban.set === false && clr.json.profile.ss.set === false && clr.json.profile.nif.set === true && (await rv(O, 'iban')).status === 404, 'se pueden borrar el IBAN y la Seguridad Social (el DNI se conserva)');
  // IBAN: comprobación mientras se escribe
  const ic = (tok, iban) => http('POST', '/api/v1/iban/check', { token: tok, body: { iban } });
  const ok1 = await ic(O, 'es91 2100 0418 4502 0005 1332'), ok2 = await ic(O, 'GB82 WEST 1234 5698 7654 32'), ko1 = await ic(O, 'ES91 2100 0418 4502 0005 1333'), ko2 = await ic(O, 'ES00');
  check(ok1.json.valid && ok1.json.bank === 'CaixaBank' && ok1.json.formatted === 'ES91 2100 0418 4502 0005 1332' && ok2.json.valid && ok2.json.bank === null && ok2.json.country === 'Reino Unido' && ko1.json.valid === false && ko1.json.reason === 'control' && ko2.json.reason === 'formato', 'comprobar un IBAN: válido con su banco, de otro país sin banco, y los inválidos con el motivo');
  const ibans = { '0049': 'Banco Santander', '0182': 'BBVA', '0081': 'Banco Sabadell', '2100': 'CaixaBank', '0128': 'Bankinter', '2085': 'Ibercaja Banco', '2103': 'Unicaja Banco', '2080': 'ABANCA', '3058': 'Cajamar Caja Rural', '1465': 'ING', '0073': 'Openbank' };
  const mk = (ent) => { const w = [1, 2, 4, 8, 5, 10, 9, 7, 3, 6], dc = (d) => { const x = 11 - (d.split('').reduce((a, c, i) => a + Number(c) * w[i], 0) % 11); return x === 11 ? 0 : x === 10 ? 1 : x; }; const acc = '0123456789'; const ccc = ent + '0001' + String(dc('00' + ent + '0001')) + String(dc(acc)) + acc; const chk = (98n - BigInt(ccc + '142800') % 97n); return `ES${String(chk).padStart(2, '0')}${ccc}`; };
  const bankErr = []; for (const [ent, name] of Object.entries(ibans)) { const r = await ic(O, mk(ent)); if (!(r.json.valid && r.json.bank === name)) bankErr.push(`${ent}:${JSON.stringify(r.json)}`); }
  check(bankErr.length === 0, `los bancos más habituales se identifican por el código de entidad (${Object.keys(ibans).length} comprobados)`, bankErr.join(' '));
  check((await ic(O, mk('9999'))).json.bank === null && (await ic(O, mk('9999'))).json.bank_code === '9999', 'una entidad que no figura en la tabla muestra solo su código (no se inventa el nombre)');
  check([await ic(undefined, 'ES00'), await ic(dA.tok, 'ES00'), await ic(ro16.tok, 'ES00')].map((r) => r.status).join() === '401,403,403', 'comprobar IBAN: sin sesión 401; conductor y solo_lectura 403');
  check(psqlAs('deca_api', ENV.DB_API_PASSWORD, 'DELETE FROM driver_profile').includes('permission denied') && psqlAs('deca_docs', ENV.DB_DOCS_PASSWORD, 'SELECT 1 FROM driver_profile LIMIT 1').includes('permission denied') && psqlAs('deca_api', ENV.DB_API_PASSWORD, `UPDATE driver_profile SET user_id=user_id`).includes('permission denied'), 'permisos de BD: la API no borra fichas ni cambia su dueño; docs no las lee');

  // ---- 16.17 Modelo de documento «Carta de porte» (casillas numeradas) y datos adicionales
  info('16.17 Modelo de documento: carta de porte');
  const TPL = (tok, body) => http('PUT', '/api/v1/admin/config/template', { token: tok, body });
  const cfgT = (await http('GET', '/api/v1/admin/config', { token: AD2 })).json;
  check(cfgT.doc_template === 'ESTANDAR' && cfgT.doc_templates.length === 2 && cfgT.deca_show_driver === false, 'por defecto se usa el modelo DECARGO y no se imprimen los datos del conductor');
  check([await TPL(undefined, { template: 'CARTA_DE_PORTE' }), await TPL(O, { template: 'CARTA_DE_PORTE' }), await TPL(ro16.tok, { template: 'CARTA_DE_PORTE' }), await TPL(dA.tok, { template: 'CARTA_DE_PORTE' })].map((r) => r.status).join() === '401,403,403,403', 'cambiar el modelo: solo el administrador (sin sesión 401; oficina, solo_lectura y conductor 403)');
  check((await TPL(AD2, { template: 'OTRO' })).status === 400 && (await TPL(AD2, { show_driver: 'si' })).status === 400 && (await TPL(AD2, {})).status === 400, 'modelo inexistente, valor no booleano o petición vacía → 400');
  const prv = (tok, template, mode) => fetch(`${API()}/api/v1/admin/config/template-preview?template=${template}&mode=${mode}`, { headers: tok ? { authorization: `Bearer ${tok}` } : {} });
  check([await prv(undefined, 'CARTA_DE_PORTE', 'ejemplo'), await prv(O, 'CARTA_DE_PORTE', 'ejemplo'), await prv(dA.tok, 'CARTA_DE_PORTE', 'ejemplo')].map((r) => r.status).join() === '401,403,403' && (await prv(AD2, 'XX', 'ejemplo')).status === 400, 'vista previa: solo administrador; modelo inexistente → 400');
  const pvE = Buffer.from(await (await prv(AD2, 'CARTA_DE_PORTE', 'ejemplo')).arrayBuffer()), pvB = Buffer.from(await (await prv(AD2, 'CARTA_DE_PORTE', 'blanco')).arrayBuffer()), pvS = Buffer.from(await (await prv(AD2, 'ESTANDAR', 'ejemplo')).arrayBuffer());
  const tE = pdfText(pvE), tB = pdfText(pvB), tS = pdfText(pvS);
  check(pvE.subarray(0, 4).toString() === '%PDF' && /1\. Cargador o remitente/.test(tE) && /15\. Recibo de la mercancía/.test(tE) && /MODELO DE EJEMPLO/.test(tE) && /CARGADOR DE EJEMPLO/.test(tE), 'vista previa de la carta de porte con datos de ejemplo y el rótulo «MODELO DE EJEMPLO»');
  check(/1\. Cargador o remitente/.test(tB) && /12\.1\./.test(tB) && !/EJEMPLO/.test(tB) && !/CARGADOR/.test(tB) && !/Documento en línea/.test(tB), 'el formulario en blanco trae todas las casillas y ningún dato (ni QR ni identificadores)');
  check(/CARGADOR CONTRACTUAL/.test(tS) && /Orden FOM\/2861\/2012/.test(tS), 'el otro modelo (DECARGO) sigue disponible con su diseño');
  // activar el modelo y emitir un DeCA con todos los datos
  const setT = await TPL(AD2, { template: 'CARTA_DE_PORTE' });
  check(setT.status === 200 && setT.json.doc_template === 'CARTA_DE_PORTE' && psql(`SELECT count(*) FROM audit_log WHERE action='CONFIG_FLAG_CHANGED' AND entity_id='doc_template'`) === '1', 'el administrador elige la carta de porte y queda auditado');
  const cbody = (o = {}) => tbody({ cargo: `Carta ${sfx}`, packages: '21 palets', load_reference: `REF-${SFX}`, temperature: 'Sin temperatura', price_eur: '1250,5', remarks: 'Entregar antes de las 10:00', driver_id: dA.id,
    origins: [{ party: 'ABBOTT LABORATORIOS S.A.', address: 'Camino de Purchil, 68, 18004 Granada' }, { address: 'Almacén 2, El Ejido' }],
    destinations: [{ party: 'TJ MADRID', address: 'C/ Quebec 8, Centro de Carga Aérea, 28042 Madrid' }], origin: undefined, destination: undefined, ...o });
  const cp = await call('POST', '/api/v1/transports', { token: O, body: cbody() });
  check(cp.status === 201 && cp.json.deca_id, 'un transporte con los datos adicionales emite su DeCA con el modelo elegido', `${cp.status} ${cp.text}`);
  const cpPdf = (await call('GET', `/api/v1/decas/${cp.json.deca_id}/versions/1/pdf`, { token: O })).buf, cpt = pdfText(cpPdf);
  check(/1\. Cargador o remitente/.test(cpt) && /2\. Consignatario o destinatario/.test(cpt) && /TJ MADRID/.test(cpt) && /ABBOTT|CARGADOR WEB/.test(cpt) && /3\. Lugar de origen/.test(cpt) && /Granada/.test(cpt) && /El Ejido/.test(cpt) && /Madrid/.test(cpt), 'la carta de porte imprime cargador, consignatario y las localidades de origen y destino sacadas de las direcciones');
  check(/1\.?250,50 €/.test(cpt) && /21 palets/.test(cpt) && new RegExp(`REFERENCIA DE CARGA: REF-${SFX}`).test(cpt) && /Sin temperatura/.test(cpt) && /1\.?234,5 kg/.test(cpt) && cpt.includes(pT) && cpt.includes(pR) && /Entregar antes de las 10:00/.test(cpt), 'precio, bultos, referencia de carga, temperatura, peso, matrículas y observaciones');
  check(/Firma y sello del cargador/.test(cpt) && /Firma y sello de la empresa transportista/.test(cpt) && /Firma y sello del consignatario/.test(cpt) && /FOM\/2861\/2012/.test(cpt) && /DOCUMENTO DE PRUEBA/.test(cpt), 'trae las casillas de firma y sello, el texto legal de la Orden y el rótulo de prueba (modo de pruebas activo)');
  const cpDet = (await call('GET', `/api/v1/transports/${cp.json.id}`, { token: O })).json;
  check(decodeQr(cpPdf, 'carta.pdf') === cpDet.deca.technical.public_url && cpPdf.length < 5_000_000 && cpDet.price_eur === '1250.50' && cpDet.packages === '21 palets' && cpDet.carrier_address, 'el QR del PDF coincide con la URL guardada, el PDF pesa menos de 5 MB y el detalle devuelve los datos nuevos');
  check(!/DNI: |TLF: /.test(cpt) && !cpt.includes('12345678Z'), 'con el ajuste por defecto NO se imprimen el DNI ni el teléfono del conductor');
  await TPL(AD2, { show_driver: true });
  const cp2 = await call('POST', '/api/v1/transports', { token: O, body: cbody({ cargo: `Con conductor ${sfx}` }) });
  const cpt2 = pdfText((await call('GET', `/api/v1/decas/${cp2.json.deca_id}/versions/1/pdf`, { token: O })).buf);
  check(/9\. Datos conductor efectivo/.test(cpt2) && /Carlos Pérez Gómez/.test(cpt2) && /DNI: 12345678Z/.test(cpt2) && /TLF: 655 000 111/.test(cpt2), 'con el ajuste activado, la casilla 9 lleva el nombre, DNI y teléfono del conductor tomados de su ficha');
  const cp3 = await call('POST', '/api/v1/transports', { token: O, body: cbody({ cargo: `Sin conductor ${sfx}`, driver_id: undefined }) });
  check(!/DNI: /.test(pdfText((await call('GET', `/api/v1/decas/${cp3.json.deca_id}/versions/1/pdf`, { token: O })).buf)), 'sin conductor asignado la casilla 9 queda vacía');
  const cp4 = await call('POST', '/api/v1/transports', { token: O, body: cbody({ cargo: `Otro transportista ${sfx}`, carrier_name: 'SUBCONTRATA S.L.', carrier_nif: 'B87654321', carrier_address: 'Polígono Sur 4, Sevilla', driver_id: undefined }) });
  const cpt4 = pdfText((await call('GET', `/api/v1/decas/${cp4.json.deca_id}/versions/1/pdf`, { token: O })).buf);
  check(/SUBCONTRATA S\.L\./.test(cpt4) && /Polígono Sur 4, Sevilla/.test(cpt4) && /B87654321/.test(cpt4), 'con otra empresa como transportista, la casilla 7 lleva su nombre, domicilio y NIF');
  const lateT = await call('POST', '/api/v1/transports', { token: O, body: cbody({ cargo: `Emisión posterior ${sfx}`, generate_deca: false, driver_id: undefined }) });
  const lateE = await call('POST', `/api/v1/transports/${lateT.json.id}/deca`, { token: O });
  check(lateE.status === 201 && /15\. Recibo de la mercancía/.test(pdfText((await call('GET', `/api/v1/decas/${lateE.json.deca_id}/versions/1/pdf`, { token: O })).buf)) && /REF-/.test(pdfText((await call('GET', `/api/v1/decas/${lateE.json.deca_id}/versions/1/pdf`, { token: O })).buf)), 'la emisión posterior (botón «Generar DeCA») usa también el modelo y los datos nuevos');
  for (const [b, why] of [[{ price_eur: 'abc' }, 'precio no numérico'], [{ price_eur: '-5' }, 'precio negativo'], [{ price_eur: '99999999999' }, 'precio desorbitado'], [{ packages: 'x'.repeat(100) }, 'bultos demasiado largo'], [{ temperature: 'x\u0001y' }, 'carácter de control']]) {
    check((await call('POST', '/api/v1/transports', { token: O, body: cbody(b) })).status === 400, `datos adicionales rechazados (${why}) → 400`);
  }
  // reemisión con el modelo vigente y vuelta al modelo por defecto
  const rsT = await http('POST', `/api/v1/admin/decas/${cp.json.deca_id}/reissue`, { token: AD2, body: { reason: 'Prueba de reemisión con modelo' } });
  check(rsT.status === 201 && /Cargador o remitente/.test(pdfText((await call('GET', `/api/v1/decas/${rsT.json.deca_id}/versions/1/pdf`, { token: O })).buf)), 'al reemitir un DeCA se usa el modelo vigente y se conservan sus datos');
  await TPL(AD2, { template: 'ESTANDAR', show_driver: false });
  const back17 = await call('POST', '/api/v1/transports', { token: O, body: cbody({ cargo: `Vuelta ${sfx}`, driver_id: undefined }) });
  check(/CARGADOR CONTRACTUAL/.test(pdfText((await call('GET', `/api/v1/decas/${back17.json.deca_id}/versions/1/pdf`, { token: O })).buf)), 'al volver al modelo DECARGO, los DeCA nuevos usan ese diseño (los ya emitidos no cambian)');
  check(/1\. Cargador o remitente/.test(pdfText((await call('GET', `/api/v1/decas/${cp2.json.deca_id}/versions/1/pdf`, { token: O })).buf)), 'los DeCA ya emitidos conservan el modelo con el que se emitieron');

  // ---- 16.18 Agenda de empresas y lugares con ubicación
  info('16.18 Agenda de empresas');
  const PA = (tok, body) => http('POST', '/api/v1/parties', { token: tok, body });
  const tx = (tok, nif) => http('POST', '/api/v1/taxid/check', { token: tok, body: { nif } });
  const goodCif = ['A28015865', 'A15022510', 'A46103834', 'A08099681', 'G28029643'], cifRes = await Promise.all(goodCif.map((n) => tx(O, n)));
  check(cifRes.every((r) => r.json.kind === 'CIF' && r.json.valid === true) && (await tx(O, 'a-28015866')).json.valid === false && (await tx(O, '12345678Z')).json.kind === 'DNI' && (await tx(O, '12345678A')).json.valid === false && (await tx(O, 'X1234567L')).json.kind === 'NIE' && (await tx(O, 'DE123456789')).json.valid === null, 'comprobar NIF sin conexión: CIF reales correctos, errata detectada, DNI y NIE con su letra, formato extranjero sin juicio');
  check([await tx(undefined, 'A28015865'), await tx(dA.tok, 'A28015865')].map((r) => r.status).join() === '401,403' && (await tx(ro16.tok, 'A28015865')).status === 200 && (await http('POST', '/api/v1/taxid/check', { token: O, body: { nif: 123 } })).status === 400, 'comprobar NIF: sin sesión 401, conductor 403, solo_lectura puede, valor inválido 400');
  const tel = await PA(O, { name: 'Telefónica de España S.A.U.', nif: 'a-28015865', address: 'Gran Vía 28, 28013 Madrid', notes: 'Cliente de prueba' });
  check(tel.status === 201 && tel.json.nif === 'A28015865' && tel.json.nif_check.valid === true && tel.json.sites.length === 0, 'se crea una empresa (el NIF se normaliza y se comprueba)', `${tel.status} ${tel.text}`);
  const dupP = await PA(O, { name: 'Otra Telefónica', nif: 'A28015865' });
  check(dupP.status === 409 && dupP.json.error === 'party_exists' && dupP.json.id === tel.json.id, 'un NIF repetido → 409 e indica la empresa que ya existe');
  for (const [b, why] of [[{ name: 'x' }, 'nombre corto'], [{ name: 'Empresa válida', nif: '!!!' }, 'NIF con formato inválido'], [{ name: 'Empresa\u0001mala' }, 'carácter de control'], [{ name: 'Empresa válida', notes: 'n'.repeat(600) }, 'notas demasiado largas'], [{}, 'sin datos']]) {
    check((await PA(O, b)).status === 400, `empresa rechazada (${why}) → 400`);
  }
  check([await PA(undefined, { name: 'Intrusa S.L.' }), await PA(dA.tok, { name: 'Intrusa S.L.' }), await PA(ro16.tok, { name: 'Intrusa S.L.' })].map((r) => r.status).join() === '401,403,403', 'crear empresas: sin sesión 401; conductor y solo_lectura 403');
  const srch = (tok, q, extra = '') => http('GET', `/api/v1/parties?q=${encodeURIComponent(q)}${extra}`, { token: tok });
  check((await srch(O, 'telefonica')).json.some((x) => x.id === tel.json.id) && (await srch(O, 'TELEFÓNICA')).json.some((x) => x.id === tel.json.id) && (await srch(O, 'A28015')).json.some((x) => x.id === tel.json.id) && (await srch(O, 'zzzzzz')).json.length === 0, 'la búsqueda no distingue mayúsculas ni tildes y encuentra por nombre o por NIF');
  check((await srch(ro16.tok, 'telef')).status === 200 && [await srch(undefined, 'a'), await srch(dA.tok, 'a')].map((r) => r.status).join() === '401,403' , 'buscar: solo_lectura puede; sin sesión 401, conductor 403');
  // lugares y ubicación
  const SI = (tok, id, body) => http('POST', `/api/v1/parties/${id}/sites`, { token: tok, body });
  const s1 = await SI(O, tel.json.id, { label: 'Sede Gran Vía', kind: 'SEDE', address: 'Gran Vía 28, 28013 Madrid', lat: '40.420000', lon: '-3.705000', notes: 'Recepción de 9 a 14 h' });
  check(s1.status === 201 && s1.json.lat === 40.42 && s1.json.lon === -3.705 && s1.json.maps_url === 'https://www.google.com/maps/dir/?api=1&destination=40.42,-3.705', 'un lugar con coordenadas genera su enlace «Cómo llegar»');
  const s2 = await SI(O, tel.json.id, { label: 'Almacén Coslada', kind: 'CARGA', address: 'Polígono Los Olivos, Coslada', map_url: 'https://www.google.com/maps/place/Coslada/@40.4237,-3.5613,15z/data=!3m1!4b1' });
  check(s2.status === 201 && s2.json.lat === 40.4237 && s2.json.lon === -3.5613, 'si el enlace largo del mapa trae coordenadas, se rellenan solas');
  const s3 = await SI(O, tel.json.id, { address: 'Camino del Puerto 3, Motril', map_url: 'https://maps.app.goo.gl/abc123XYZ' });
  check(s3.status === 201 && s3.json.lat === null && s3.json.maps_url === 'https://maps.app.goo.gl/abc123XYZ', 'un enlace corto se guarda tal cual (no se hacen peticiones a terceros para resolverlo)');
  for (const [b, why] of [[{ address: 'Calle X 1', lat: '40.1' }, 'solo latitud'], [{ address: 'Calle X 1', lat: '95', lon: '0' }, 'latitud fuera de rango'], [{ address: 'Calle X 1', lat: '0', lon: '200' }, 'longitud fuera de rango'], [{ address: 'Calle X 1', lat: 'abc', lon: '1' }, 'coordenada no numérica'],
    [{ address: 'Calle X 1', kind: 'OTRO' }, 'tipo inexistente'], [{ address: 'Calle X 1', map_url: 'https://evil.example.com/maps' }, 'enlace de un sitio desconocido'], [{ address: 'Calle X 1', map_url: 'http://www.google.com/maps' }, 'enlace sin https'],
    [{ address: 'Calle X 1', map_url: 'javascript:alert(1)' }, 'enlace javascript'], [{ address: 'Calle X 1', map_url: 'https://user:pw@www.google.com/maps' }, 'enlace con credenciales'], [{ address: 'ab' }, 'dirección corta']]) {
    check((await SI(O, tel.json.id, b)).status === 400, `lugar rechazado (${why}) → 400`);
  }
  check([await SI(undefined, tel.json.id, { address: 'Calle Y 2' }), await SI(dA.tok, tel.json.id, { address: 'Calle Y 2' }), await SI(ro16.tok, tel.json.id, { address: 'Calle Y 2' })].map((r) => r.status).join() === '401,403,403' && (await SI(O, '0'.repeat(8) + '-0000-0000-0000-' + '0'.repeat(12), { address: 'Calle Y 2' })).status === 404, 'crear lugares: sin sesión 401; conductor y solo_lectura 403; empresa inexistente 404');
  const upS = await http('PATCH', `/api/v1/sites/${s1.json.id}`, { token: O, body: { lat: '40.5', lon: '-3.6', notes: 'Cambio de horario' } });
  check(upS.status === 200 && upS.json.lat === 40.5 && upS.json.notes === 'Cambio de horario' && (await http('PATCH', `/api/v1/sites/${s1.json.id}`, { token: ro16.tok, body: { notes: 'x' } })).status === 403 && (await http('PATCH', `/api/v1/sites/${s1.json.id}`, { token: O, body: {} })).status === 400, 'modificar un lugar (y solo oficina; sin cambios → 400)');
  const gp = await http('GET', `/api/v1/parties/${tel.json.id}`, { token: ro16.tok });
  check(gp.status === 200 && gp.json.sites.length === 3 && gp.json.sites.some((x) => x.maps_url), 'solo_lectura ve la empresa con sus lugares y ubicaciones');
  // registro automático al crear transportes
  const tb = (o = {}) => tbody({ cargo: `Agenda ${sfx}`, shipper_name: 'MERCADONA S.A.', shipper_nif: 'A46103834', shipper_address: 'Calle Valencia 5, 46016 Tavernes Blanques', driver_id: dA.id,
    origins: [{ party: 'Mercadona Almacén Granada', address: 'Polígono Juncaril, Peligros, Granada' }], destinations: [{ party: 'Telefónica de España S.A.U.', address: 'Gran Vía 28, 28013 Madrid' }, { party: 'Cliente Nuevo Madrid S.L.', address: 'Calle Alcalá 100, Madrid' }], origin: undefined, destination: undefined, ...o });
  const nPar = () => Number(psql('SELECT count(*) FROM party')), nSit = () => Number(psql('SELECT count(*) FROM party_site'));
  const pBase = nPar();
  const auditBefore = Number(psql(`SELECT count(*) FROM audit_log WHERE action='PARTY_CREATED' AND after->>'origin'='transporte'`));
  const t18 = await call('POST', '/api/v1/transports', { token: O, body: tb() });
  check(t18.status === 201 && t18.json.registered.parties === 3 && t18.json.registered.sites === 2 && nPar() === pBase + 3, 'al crear un transporte se guardan solas las empresas nuevas (cargador, empresa de carga y destinatario nuevo) y sus lugares', `${t18.status} ${JSON.stringify(t18.json.registered)}`);
  const merc = (await srch(O, 'mercadona')).json;
  check(merc.some((x) => x.nif === 'A46103834') && merc.some((x) => x.name === 'Mercadona Almacén Granada' && x.nif === null), 'quedan en la agenda: el cargador con su NIF y la empresa de carga solo con nombre');
  const t18b = await call('POST', '/api/v1/transports', { token: O, body: tb({ shipper_name: 'MERCADONA, S.A. (otro nombre)', cargo: `Agenda 2 ${sfx}` }) });
  check(t18b.json.registered.parties === 0 && t18b.json.registered.sites === 0 && nPar() === pBase + 3, 'repetir los mismos datos no duplica nada (el cargador se reconoce por su NIF y el resto por nombre y dirección)');
  check((await srch(O, 'mercadona')).json.find((x) => x.nif === 'A46103834').name === 'MERCADONA S.A.', 'una empresa ya guardada nunca se pisa con datos tecleados distintos');
  const telSites = (await http('GET', `/api/v1/parties/${tel.json.id}`, { token: O })).json.sites;
  check(telSites.length === 3 && telSites.some((x) => x.address === 'Gran Vía 28, 28013 Madrid' && x.lat === 40.5), 'un lugar ya guardado de la agenda se reutiliza (no se crea otro igual)');
  const det18 = (await call('GET', `/api/v1/transports/${t18.json.id}`, { token: O })).json;
  check(det18.destinations[0].site_id && det18.destinations[0].party_id && det18.destinations[0].maps_url === 'https://www.google.com/maps/dir/?api=1&destination=40.5,-3.6' && det18.destinations[0].site_notes === 'Cambio de horario' && det18.destinations[1].maps_url === null, 'el detalle del transporte enlaza con la agenda: «Cómo llegar» e indicaciones del lugar (y sin ubicación si no la hay)');
  const dr18 = await http('GET', `/api/v1/driver/transports/${t18.json.id}`, { token: dA.tok });
  check(dr18.status === 200 && dr18.json.destinations[0].maps_url === det18.destinations[0].maps_url && dr18.json.destinations[0].notes === 'Cambio de horario' && dr18.json.origins[0].party === 'Mercadona Almacén Granada' && !JSON.stringify(dr18.json).match(/site_id|party_id|use_count/), 'el conductor ve en su transporte los puntos con «Cómo llegar» e indicaciones, sin identificadores internos');
  await http('PATCH', `/api/v1/sites/${s1.json.id}`, { token: O, body: { lat: '41.0', lon: '-4.0' } });
  check((await http('GET', `/api/v1/driver/transports/${t18.json.id}`, { token: dA.tok })).json.destinations[0].maps_url === 'https://www.google.com/maps/dir/?api=1&destination=41,-4', 'si se corrige la ubicación en la agenda, el conductor ve la nueva (no la antigua)');
  check((await http('GET', `/api/v1/driver/transports/${t18.json.id}`, { token: dB.tok })).status === 404 && [await http('GET', '/api/v1/parties', { token: dA.tok }), await http('GET', `/api/v1/parties/${tel.json.id}`, { token: dA.tok })].map((r) => r.status).join() === '403,403', 'otro conductor no ve ese transporte (404) y ningún conductor puede consultar la agenda (403)');
  const bySite = await call('POST', '/api/v1/transports', { token: O, body: tb({ cargo: `Por lugar ${sfx}`, destinations: [{ party: 'Telefónica de España S.A.U.', address: 'Gran Vía 28, 28013 Madrid', site_id: s1.json.id }] }) });
  check(bySite.status === 201 && bySite.json.registered.parties === 0 && bySite.json.registered.sites === 0, 'elegir un lugar de la agenda enlaza el transporte sin crear nada nuevo');
  check((await call('POST', '/api/v1/transports', { token: O, body: tb({ destinations: [{ address: 'Calle Z 9, Madrid', site_id: '0'.repeat(8) + '-0000-0000-0000-' + '0'.repeat(12) }] }) })).status === 400 && (await call('POST', '/api/v1/transports', { token: O, body: tb({ destinations: [{ address: 'Calle Z 9, Madrid', party_id: 'zzz' }] }) })).status === 400, 'un lugar o empresa de la agenda inexistente o inválido → 400 y no se guarda el transporte');
  check(Number(psql(`SELECT count(*) FROM audit_log WHERE action='PARTY_CREATED' AND after->>'origin'='transporte'`)) === auditBefore + 3 && Number(psql(`SELECT count(*) FROM audit_log WHERE action='PARTY_SITE_CREATED'`)) >= 5, 'el alta de empresas y lugares desde un transporte queda auditada');
  const arch18 = await http('PATCH', `/api/v1/parties/${tel.json.id}`, { token: O, body: { active: false } });
  check(arch18.status === 200 && !(await srch(O, 'telefonica')).json.some((x) => x.id === tel.json.id) && (await srch(O, 'telefonica', '&all=1')).json.some((x) => x.id === tel.json.id), 'archivar una empresa la quita del buscador (se ve con «ver archivadas») y no se borra nada');
  check(psqlAs('deca_api', ENV.DB_API_PASSWORD, 'DELETE FROM party').includes('permission denied') && psqlAs('deca_api', ENV.DB_API_PASSWORD, 'DELETE FROM party_site').includes('permission denied') && psqlAs('deca_docs', ENV.DB_DOCS_PASSWORD, 'SELECT 1 FROM party LIMIT 1').includes('permission denied'), 'permisos de BD: la API no borra empresas ni lugares; docs no los lee');

  // ---- 16.19 Palets por lugar de carga y descarga, y total en el DeCA
  info('16.19 Palets por lugar');
  const palO = [{ party: 'Frutas del Sur S.L.', address: 'Camino Viejo 4, 18004 Granada', pallets: 12 }, { party: 'Hortalizas Norte S.A.', address: 'Polígono Norte, 28042 Madrid', pallets: '6' }, { party: 'Cooperativa Este', address: 'Calle Mayor 1, 46001 Valencia', pallets: 3 }];
  const palD = [{ party: 'Cliente Uno S.L.', address: 'Avenida Sur 8, Sevilla', pallets: 10 }, { party: 'Cliente Dos S.L.', address: 'Calle Norte 2, Córdoba', pallets: 11 }];
  const pl = await call('POST', '/api/v1/transports', { token: O, body: tb({ cargo: `Palets ${sfx}`, origins: palO, destinations: palD, driver_id: dA.id }) });
  const plDet = pl.status === 201 ? (await call('GET', `/api/v1/transports/${pl.json.id}`, { token: O })).json : null;
  check(pl.status === 201 && plDet.origins.map((x) => x.pallets).join() === '12,6,3' && plDet.destinations.map((x) => x.pallets).join() === '10,11' && plDet.packages === '21 palets', 'los palets de cada lugar se guardan y, sin indicar bultos, el total cargado (21 palets) pasa a la casilla de bultos', `${pl.status} ${pl.text}`);
  const plStd = pdfRaw((await call('GET', `/api/v1/decas/${pl.json.deca_id}/versions/1/pdf`, { token: O })).buf);
  check(/12 palets/.test(plStd) && /6 palets/.test(plStd) && /3 palets/.test(plStd) && /Total: 21 palets/.test(plStd) && /10 palets/.test(plStd) && /11 palets/.test(plStd) && /Total: 21 palets/.test(plStd), 'el DeCA del modelo DECARGO muestra los palets de cada lugar de carga y de descarga y el total');
  await TPL(AD2, { template: 'CARTA_DE_PORTE' });
  const pl2 = await call('POST', '/api/v1/transports', { token: O, body: tb({ cargo: `Palets carta ${sfx}`, origins: palO, destinations: palD, driver_id: dA.id }) });
  const plCarta = pdfRaw((await call('GET', `/api/v1/decas/${pl2.json.deca_id}/versions/1/pdf`, { token: O })).buf);
  check(/1\) Granada — 12 palets/.test(plCarta) && /2\) Madrid — 6 palets/.test(plCarta) && /3\) Valencia — 3 palets/.test(plCarta) && /Total cargado: 21 palets/.test(plCarta) && /1\) Sevilla — 10 palets/.test(plCarta) && /2\) Córdoba — 11 palets/.test(plCarta) && /Total descargado: 21 palets/.test(plCarta) && /3\. Lugar de origen de la expedición Granada \/ Madrid \/ Valencia/.test(plCarta) && /21 palets/.test(plCarta), 'la carta de porte: las casillas 3 y 4 solo llevan los lugares y la casilla 12 el desglose por lugar con palets, el total cargado, el total descargado y el total en bultos');
  const dr19 = await http('GET', `/api/v1/driver/transports/${pl.json.id}`, { token: dA.tok });
  check(dr19.status === 200 && dr19.json.origins.map((x) => x.pallets).join() === '12,6,3' && dr19.json.destinations.map((x) => x.pallets).join() === '10,11', 'el conductor ve los palets de cada punto de su transporte');
  const one = await call('POST', '/api/v1/transports', { token: O, body: tb({ cargo: `Un palet ${sfx}`, origins: [{ address: 'Almacén Único 1, Granada', pallets: 1 }], destinations: [{ address: 'Destino Único 2, Madrid' }], driver_id: undefined }) });
  const oneDet = (await call('GET', `/api/v1/transports/${one.json.id}`, { token: O })).json;
  check(oneDet.packages === '1 palet' && /1 palet/.test(pdfRaw((await call('GET', `/api/v1/decas/${one.json.deca_id}/versions/1/pdf`, { token: O })).buf)) && !/Total:/.test(pdfRaw((await call('GET', `/api/v1/decas/${one.json.deca_id}/versions/1/pdf`, { token: O })).buf)), 'con un solo lugar se dice «1 palet» (singular) y no se imprime «Total»');
  const keepPk = await call('POST', '/api/v1/transports', { token: O, body: tb({ cargo: `Bultos propios ${sfx}`, packages: '20 palets + 2 jaulas', origins: palO, destinations: palD, driver_id: undefined }) });
  check((await call('GET', `/api/v1/transports/${keepPk.json.id}`, { token: O })).json.packages === '20 palets + 2 jaulas', 'si se indican los bultos a mano, no se sustituyen por el total de palets');
  const zero = await call('POST', '/api/v1/transports', { token: O, body: tb({ cargo: `Cero ${sfx}`, origins: [{ address: 'Almacén Cero 1, Granada', pallets: 0 }], destinations: [{ address: 'Destino Cero 2, Madrid' }], driver_id: undefined }) });
  check(zero.status === 201 && (await call('GET', `/api/v1/transports/${zero.json.id}`, { token: O })).json.origins[0].pallets === 0, 'cero palets es un valor válido en un lugar');
  for (const [v, why] of [[-1, 'negativo'], [1.5, 'decimal'], ['x', 'texto'], [10000, 'demasiado grande']]) {
    check((await call('POST', '/api/v1/transports', { token: O, body: tb({ origins: [{ address: 'Almacén X 1, Granada', pallets: v }], destinations: [{ address: 'Destino X 2, Madrid' }] }) })).status === 400, `palets rechazados (${why}) → 400`);
  }
  const same = await call('POST', '/api/v1/transports', { token: O, body: tb({ cargo: `Misma localidad ${sfx}`, origins: [{ party: 'Empresa A', address: 'Calle 1, Granada', pallets: 4 }, { party: 'Empresa B', address: 'Calle 2, Granada', pallets: 5 }], destinations: [{ address: 'Destino 3, Madrid' }], driver_id: undefined }) });
  check(/Granada · Empresa A — 4 palets/.test(pdfRaw((await call('GET', `/api/v1/decas/${same.json.deca_id}/versions/1/pdf`, { token: O })).buf)) && /Granada · Empresa B — 5 palets/.test(pdfRaw((await call('GET', `/api/v1/decas/${same.json.deca_id}/versions/1/pdf`, { token: O })).buf)), 'si dos lugares están en la misma localidad, se distinguen por la empresa');
  const many = await call('POST', '/api/v1/transports', { token: O, body: tb({ cargo: `Muchos lugares ${sfx}`, origins: Array.from({ length: 8 }, (_, i) => ({ party: `Proveedor ${i + 1}`, address: `Calle ${i + 1}, Ciudad ${'ABCDEFGHIJ'[i]}`, pallets: i + 1 })), destinations: [{ address: 'Destino 3, Madrid' }], driver_id: undefined }) });
  const manyPdf = (await call('GET', `/api/v1/decas/${many.json.deca_id}/versions/1/pdf`, { token: O })).buf;
  check(many.status === 201 && /Total cargado: 36 palets/.test(pdfRaw(manyPdf)) && manyPdf.length < 5_000_000 && decodeQr(manyPdf, 'muchos.pdf') === (await call('GET', `/api/v1/transports/${many.json.id}`, { token: O })).json.deca.technical.public_url, 'con 8 lugares de carga el DeCA sigue legible (total 36 palets), pesa menos de 5 MB y su QR sigue coincidiendo con la URL');
  // Peor caso: 10 lugares de carga y 10 de descarga, con observaciones largas. Ningún dato puede quedar recortado.
  const worst = await call('POST', '/api/v1/transports', { token: O, body: tb({ cargo: `Peor caso ${sfx}`, remarks: 'Observaciones largas de prueba. '.repeat(8), driver_id: undefined,
    origins: Array.from({ length: 10 }, (_, i) => ({ party: `Proveedor ${i + 1}`, address: `Calle ${i + 1}, Ciudad ${'ABCDEFGHIJ'[i]}`, pallets: i + 1 })), destinations: Array.from({ length: 10 }, (_, i) => ({ party: `Cliente ${i + 1}`, address: `Avenida ${i + 1}, Destino ${'ABCDEFGHIJ'[i]}`, pallets: i + 2 })) }) });
  const worstBuf = (await call('GET', `/api/v1/decas/${worst.json.deca_id}/versions/1/pdf`, { token: O })).buf, worstTxt = pdfRaw(worstBuf);
  check(Array.from({ length: 10 }, (_, i) => new RegExp(`Ciudad ${'ABCDEFGHIJ'[i]} — ${i + 1} (palet|palets)`).test(worstTxt) && new RegExp(`Destino ${'ABCDEFGHIJ'[i]} — ${i + 2} palets`).test(worstTxt)).every(Boolean) && /Total cargado: 55 palets/.test(worstTxt) && /Total descargado: 65 palets/.test(worstTxt) && /Observaciones largas de prueba/.test(worstTxt), 'peor caso (10 lugares de carga y 10 de descarga): aparecen TODOS con sus palets y los dos totales, sin recortar nada');
  check(decodeQr(worstBuf, 'peor.pdf') === (await call('GET', `/api/v1/transports/${worst.json.id}`, { token: O })).json.deca.technical.public_url && worstBuf.length < 5_000_000 && /Firma y sello del consignatario/.test(worstTxt), 'en el peor caso el QR sigue leyéndose y coincidiendo con la URL, y las casillas de firma siguen ahí');
  await TPL(AD2, { template: 'ESTANDAR', show_driver: false });

  // ---- 16.20 Referencias de carga/descarga y precintos por lugar
  info('16.20 Referencias y precintos');
  const refT = await call('POST', '/api/v1/transports', { token: O, body: tb({ cargo: `Referencias ${sfx}`, load_reference: undefined, driver_id: dA.id,
    origins: [{ party: 'Almacén Uno', address: 'Calle A 1, Granada', pallets: 5, references: ['LOAD-1', 'LOAD-2'], seals: ['PR-1001'] }, { party: 'Almacén Dos', address: 'Calle B 2, Málaga', pallets: 7, references: 'LOAD-3; LOAD-1', seals: 'PR-1002, PR-1003' }],
    destinations: [{ party: 'Cliente Final', address: 'Calle C 3, Madrid', references: ['DESC-9'], seals: ['PR-1001'] }] }) });
  const refD = refT.status === 201 ? (await call('GET', `/api/v1/transports/${refT.json.id}`, { token: O })).json : null;
  check(refT.status === 201 && refD.origins[0].references.join() === 'LOAD-1,LOAD-2' && refD.origins[1].references.join() === 'LOAD-3,LOAD-1' && refD.origins[1].seals.join() === 'PR-1002,PR-1003' && refD.destinations[0].references.join() === 'DESC-9', 'cada lugar guarda sus referencias (una o varias, como lista o separadas por comas y puntos y coma) y sus precintos', `${refT.status} ${refT.text}`);
  const refStd = pdfRaw((await call('GET', `/api/v1/decas/${refT.json.deca_id}/versions/1/pdf`, { token: O })).buf).replace(/\s+/g, ' ');   // el texto se parte según el ancho de la casilla
  check(/Referencias: LOAD-1, LOAD-2/.test(refStd) && /Precinto: PR-1001/.test(refStd) && /Precintos: PR-1002, PR-1003/.test(refStd) && /Referencia: DESC-9/.test(refStd), 'el DeCA del modelo DECARGO muestra las referencias y precintos junto a cada lugar');
  await TPL(AD2, { template: 'CARTA_DE_PORTE' });
  const refC = await call('POST', '/api/v1/transports', { token: O, body: tb({ cargo: `Referencias carta ${sfx}`, load_reference: undefined, driver_id: undefined,
    origins: [{ party: 'Almacén Uno', address: 'Calle A 1, Granada', pallets: 5, references: ['LOAD-1', 'LOAD-2'], seals: ['PR-1001'] }, { party: 'Almacén Dos', address: 'Calle B 2, Málaga', pallets: 7, references: 'LOAD-3', seals: 'PR-1002' }],
    destinations: [{ party: 'Cliente Final', address: 'Calle C 3, Madrid', references: ['DESC-9', 'DESC-10'], seals: [] }] }) });
  const refCt = pdfRaw((await call('GET', `/api/v1/decas/${refC.json.deca_id}/versions/1/pdf`, { token: O })).buf).replace(/\s+/g, ' ');
  check(/Granada — 5 palets · Referencias: LOAD-1, LOAD-2 · Precinto: PR-1001/.test(refCt) && /Málaga — 7 palets · Ref\.: LOAD-3 · Precinto: PR-1002/.test(refCt) && /Madrid · Referencias: DESC-9, DESC-10/.test(refCt), 'la carta de porte muestra en las casillas 3 y 4 las referencias y precintos de cada lugar');
  check(/ CARGA 1\) Granada/.test(refCt) && /DESCARGA Madrid/.test(refCt) && /Total cargado: 12 palets/.test(refCt) && /3\. Lugar de origen de la expedición Granada \/ Málaga/.test(refCt), 'el desglose de la casilla 12 reúne por lugar los palets, referencias y precintos con el total cargado, y las casillas 3 y 4 solo llevan los lugares');
  const drR = await http('GET', `/api/v1/driver/transports/${refT.json.id}`, { token: dA.tok });
  check(drR.status === 200 && drR.json.origins[0].references.join() === 'LOAD-1,LOAD-2' && drR.json.origins[1].seals.join() === 'PR-1002,PR-1003' && drR.json.destinations[0].references.join() === 'DESC-9', 'el conductor ve las referencias y los precintos de cada punto de su transporte');
  const oneRef = await call('POST', '/api/v1/transports', { token: O, body: tb({ cargo: `Una ref ${sfx}`, load_reference: undefined, driver_id: undefined, origins: [{ address: 'Calle D 4, Granada', references: ['SOLO-1'] }], destinations: [{ address: 'Calle E 5, Madrid' }] }) });
  check(/REFERENCIA DE CARGA: SOLO-1/.test(pdfRaw((await call('GET', `/api/v1/decas/${oneRef.json.deca_id}/versions/1/pdf`, { token: O })).buf)) && !/REFERENCIAS DE CARGA/.test(pdfRaw((await call('GET', `/api/v1/decas/${oneRef.json.deca_id}/versions/1/pdf`, { token: O })).buf)), 'con una sola referencia se usa el singular');
  const dedupe = await call('POST', '/api/v1/transports', { token: O, body: tb({ cargo: `Limpieza ${sfx}`, load_reference: undefined, driver_id: undefined, origins: [{ address: 'Calle D 4, Granada', references: ' A1 , ,A1,  B2 ;; ', seals: [' ', 'S1', 'S1'] }], destinations: [{ address: 'Calle E 5, Madrid' }] }) });
  const dedD = (await call('GET', `/api/v1/transports/${dedupe.json.id}`, { token: O })).json;
  check(dedupe.status === 201 && dedD.origins[0].references.join() === 'A1,B2' && dedD.origins[0].seals.join() === 'S1', 'los vacíos y repetidos se descartan y los espacios se recortan');
  for (const [o, why] of [[{ references: Array.from({ length: 11 }, (_, i) => `R${i}`) }, 'más de 10 referencias'], [{ references: ['x'.repeat(41)] }, 'una referencia de más de 40 caracteres'], [{ seals: ['y'.repeat(31)] }, 'un precinto de más de 30 caracteres'], [{ seals: Array.from({ length: 11 }, (_, i) => `P${i}`) }, 'más de 10 precintos'], [{ references: ['a\u0001b'] }, 'carácter de control'], [{ references: 123 }, 'un valor que no es texto ni lista'], [{ seals: [1, 2] }, 'precintos que no son texto']]) {
    check((await call('POST', '/api/v1/transports', { token: O, body: tb({ driver_id: undefined, origins: [{ address: 'Calle F 6, Granada', ...o }], destinations: [{ address: 'Calle G 7, Madrid' }] }) })).status === 400, `referencias o precintos rechazados (${why}) → 400`);
  }
  await TPL(AD2, { template: 'ESTANDAR', show_driver: false });

  // ---- 16.21 Bultos como palets, domicilio completo y localidad en las casillas 3 y 4
  info('16.21 Bultos y domicilios');
  await TPL(AD2, { template: 'CARTA_DE_PORTE', show_driver: false });
  const pkT = (v) => call('POST', '/api/v1/transports', { token: O, body: tb({ packages: v, driver_id: undefined, cargo: `Bultos ${v} ${sfx}`, origins: [{ address: 'Almacén P 1, Granada' }], destinations: [{ address: 'Destino P 2, Madrid' }] }) });
  const pk = await Promise.all(['10', '1', '12 cajas', '10 palets'].map(pkT));
  const pkD = await Promise.all(pk.map((r) => call('GET', `/api/v1/transports/${r.json.id}`, { token: O })));
  check(pkD.map((d) => d.json.packages).join('|') === '10 palets|1 palet|12 cajas|10 palets', 'si en los bultos se escribe solo un número, se entiende que son palets («10» → «10 palets», «1» → «1 palet»); otros textos se respetan');
  check(/Paquetería|Bultos 10/.test(pdfRaw((await call('GET', `/api/v1/decas/${pk[0].json.deca_id}/versions/1/pdf`, { token: O })).buf)) && /10 palets/.test(pdfRaw((await call('GET', `/api/v1/decas/${pk[0].json.deca_id}/versions/1/pdf`, { token: O })).buf)), 'en la casilla 12 del DeCA aparece «10 palets»');
  // el caso real: «CAMINO DE PURCHIL, 68 (GRANADA)» y «C/QUEBEC, 8» sin localidad
  const ad = await call('POST', '/api/v1/transports', { token: O, body: tb({ cargo: `Domicilios ${sfx}`, driver_id: undefined, shipper_address: 'Camino de Purchil, 68', shipper_postal_code: '18004', shipper_city: 'Granada', shipper_province: 'Granada', shipper_country: 'España',
    origins: [{ party: 'Almacén Granada', address: 'CAMINO DE PURCHIL, 68 (GRANADA)' }], destinations: [{ party: 'TJ MADRID', address: 'C/QUEBEC, 8', postal_code: '28042', city: 'Madrid', province: 'Madrid', country: 'España' }] }) });
  const adT = pdfRaw((await call('GET', `/api/v1/decas/${ad.json.deca_id}/versions/1/pdf`, { token: O })).buf);
  check(ad.status === 201 && /3\. Lugar de origen de la expedición GRANADA(?! —)/.test(adT) && !/Lugar de origen de la expedición 68/.test(adT) && /4\. Lugar de destino de la expedición Madrid/.test(adT) && !/Lugar de destino de la expedición 8\b/.test(adT), 'las casillas 3 y 4 llevan solo la localidad («GRANADA», «Madrid») y no un número de la calle');
  check(/Camino de Purchil, 68, 18004 Granada/.test(adT) && /C\/QUEBEC, 8, 28042 Madrid/.test(adT), 'el cargador y el consignatario se imprimen con su domicilio completo (calle, código postal y localidad)');
  const adDet = (await call('GET', `/api/v1/transports/${ad.json.id}`, { token: O })).json;
  check(adDet.destinations[0].city === 'Madrid' && adDet.destinations[0].postal_code === '28042' && /18004 Granada/.test(adDet.shipper.address), 'el detalle devuelve la localidad y el código postal de cada lugar y el domicilio completo del cargador');
  for (const [o, why] of [[{ postal_code: '!!' }, 'código postal inválido'], [{ city: 'x\u0001y' }, 'carácter de control en la localidad'], [{ province: 'p'.repeat(100) }, 'provincia demasiado larga']]) {
    check((await call('POST', '/api/v1/transports', { token: O, body: tb({ driver_id: undefined, destinations: [{ address: 'Calle Z 1, Madrid', ...o }] }) })).status === 400, `domicilio rechazado (${why}) → 400`);
  }
  // empresa propia (transportista efectivo) con domicilio completo
  const coFull = await http('PUT', '/api/v1/admin/config/company', { token: AD2, body: { name: 'Arturo Logística S.L', nif: 'B18726174', address: 'Paseo del Charcón, 12', postal_code: '18110', city: 'Las Gabias', province: 'Granada', country: 'España' } });
  check(coFull.status === 200 && coFull.json.company.city === 'Las Gabias' && coFull.json.company.postal_code === '18110' && coFull.json.company.province === 'Granada', 'en Configuración se guarda el domicilio completo de la empresa: código postal, localidad, provincia y país');
  check((await http('PUT', '/api/v1/admin/config/company', { token: AD2, body: { name: 'Arturo Logística S.L', nif: 'B18726174', address: 'Paseo del Charcón, 12', postal_code: '!!' } })).status === 400, 'un código postal inválido en la empresa → 400');
  const coT = await call('POST', '/api/v1/transports', { token: O, body: tb({ cargo: `Empresa completa ${sfx}`, driver_id: undefined }) });
  check(/Paseo del Charcón, 12, 18110 Las Gabias \(Granada\)/.test(pdfRaw((await call('GET', `/api/v1/decas/${coT.json.deca_id}/versions/1/pdf`, { token: O })).buf)), 'la casilla 7 (transportista) lleva el domicilio completo de la empresa');
  await http('PUT', '/api/v1/admin/config/company', { token: AD2, body: { name: coBefore.name, nif: coBefore.nif, address: coBefore.address, postal_code: coBefore.postal_code ?? null, city: coBefore.city ?? null, province: coBefore.province ?? null, country: coBefore.country ?? null } });
  // agenda con domicilio completo
  const peF = await PA(O, { name: 'Empresa Estructurada S.L.', nif: 'B12345674', address: 'Calle Mayor 5', postal_code: '18001', city: 'Granada', province: 'Granada', country: 'España' });
  check(peF.status === 201 && peF.json.city === 'Granada' && peF.json.postal_code === '18001' && peF.json.province === 'Granada', 'la agenda guarda el domicilio completo de cada empresa');
  const siF = await SI(O, peF.json.id, { label: 'Nave', kind: 'CARGA', address: 'Polígono Sur 3', postal_code: '41007', city: 'Sevilla', province: 'Sevilla', country: 'España' });
  check(siF.status === 201 && siF.json.city === 'Sevilla' && siF.json.postal_code === '41007' && (await SI(O, peF.json.id, { address: 'Calle Q 1', postal_code: '??' })).status === 400, 'los lugares de la agenda también llevan código postal, localidad, provincia y país');
  const viaSite = await call('POST', '/api/v1/transports', { token: O, body: tb({ cargo: `Lugar con localidad ${sfx}`, driver_id: undefined, origins: [{ party: 'Empresa Estructurada S.L.', address: 'Polígono Sur 3', site_id: siF.json.id }], destinations: [{ address: 'Calle Y 2, Madrid' }] }) });
  check(/3\. Lugar de origen de la expedición Sevilla/.test(pdfRaw((await call('GET', `/api/v1/decas/${viaSite.json.deca_id}/versions/1/pdf`, { token: O })).buf)), 'al elegir un lugar de la agenda, el transporte hereda su localidad (Sevilla) para el DeCA');
  const noCity = await call('POST', '/api/v1/transports', { token: O, body: tb({ driver_id: undefined, destinations: [{ address: 'C/QUEBEC, 8' }] }) });
  check(noCity.status === 400 && noCity.json.error === 'localidad_requerida' && noCity.json.field === 'destinations', 'un lugar sin localidad (ni deducible de la dirección) → 400 localidad_requerida: nunca se imprime la calle en la casilla 4');
  const pv = await call('POST', '/api/v1/transports', { token: O, body: tb({ cargo: `Provincia y país ${sfx}`, driver_id: undefined, temperature: '+2 a +5', remarks: 'Entregar por muelle 3',
    origins: [{ address: 'Paseo del Charcón, 12', postal_code: '18110', city: 'Las Gabias', province: 'Granada' }], destinations: [{ address: 'Rue de la République 1', postal_code: '69002', city: 'Lyon', province: 'Rhône', country: 'Francia' }] }) });
  const pvT = pdfRaw((await call('GET', `/api/v1/decas/${pv.json.deca_id}/versions/1/pdf`, { token: O })).buf);
  check(pv.status === 201 && /3\. Lugar de origen de la expedición Las Gabias \(Granada\)/.test(pvT) && /4\. Lugar de destino de la expedición Lyon \(Rhône\), Francia/.test(pvT) && !/expedición Paseo|expedición Rue/.test(pvT), 'casillas 3 y 4: localidad, provincia si es distinta y país si no es España; sin calle ni número');
  check(/11\. Observaciones Temperatura de transporte: \+2 a \+5 ºC/.test(pvT) && /Entregar por muelle 3/.test(pvT) && !/12\.[^]*\+2 a \+5[^]*11\. Observaciones/.test(pvT), 'la temperatura va en Observaciones («Temperatura de transporte: +2 a +5 ºC»), no en la naturaleza de la mercancía');
  const pe = await PA(O, { name: 'Herencia Calle S.L.', address: 'Camino de Purchil, 68', postal_code: '18006', city: 'Granada', province: 'Granada', country: 'España' });
  const se = await SI(O, pe.json.id, { kind: 'CARGA', address: 'CAMINO DE PURCHIL, 68 (GRANADA)' });
  const pg = (await call('GET', `/api/v1/parties/${pe.json.id}`, { token: O })).json.sites.find((x) => x.id === se.json.id);
  check(pg && pg.postal_code === '18006' && pg.city === 'Granada' && pg.province === 'Granada', 'un lugar en la misma calle que su empresa toma de ella el código postal, la localidad y la provincia');
  const se2 = await SI(O, pe.json.id, { kind: 'DESCARGA', address: 'Polígono Otro 9' });
  check(!(await call('GET', `/api/v1/parties/${pe.json.id}`, { token: O })).json.sites.find((x) => x.id === se2.json.id).city, 'un lugar en otra calle NO hereda la localidad de la empresa');
  const he = await call('POST', '/api/v1/transports', { token: O, body: tb({ cargo: `Herencia ${sfx}`, driver_id: undefined, origins: [{ party: 'Herencia Calle S.L.', address: 'CAMINO DE PURCHIL, 68 (GRANADA)', site_id: se.json.id }], destinations: [{ address: 'Calle Y 2, Madrid' }] }) });
  const heD = (await call('GET', `/api/v1/transports/${he.json.id}`, { token: O })).json;
  check(he.status === 201 && heD.origins[0].postal_code === '18006' && heD.origins[0].city === 'Granada', 'al usar ese lugar en un transporte, el transporte guarda el código postal y la localidad heredados');
  await TPL(AD2, { template: 'ESTANDAR', show_driver: false });
  const pvSLoc = pdfRaw((await call('POST', '/api/v1/transports', { token: O, body: tb({ cargo: `Temperatura estándar ${sfx}`, driver_id: undefined, temperature: '-18 ºC' }) }).then((r) => call('GET', `/api/v1/decas/${r.json.deca_id}/versions/1/pdf`, { token: O }))).buf);
  check(/Observaciones Temperatura de transporte: -18 ºC/.test(pvSLoc), 'en el modelo DECARGO la temperatura también sale en Observaciones (sin duplicar «ºC»)');
  await TPL(AD2, { template: 'CARTA_DE_PORTE', show_driver: false });
  const csg = await call('POST', '/api/v1/transports', { token: O, body: tb({ cargo: `Consignatario por líneas ${sfx}`, driver_id: undefined, destinations: [{ party: 'Empresa Estructurada S.L.', address: 'Polígono Sur 3', site_id: siF.json.id }] }) });
  const csgL = pdfText((await call('GET', `/api/v1/decas/${csg.json.deca_id}/versions/1/pdf`, { token: O })).buf).split('\n');
  const nameL = csgL.find((l) => l.includes('Empresa Estructurada S.L.')) ?? '';
  check(csg.status === 201 && nameL && !nameL.includes('Polígono Sur 3') && csgL.some((l) => /Polígono Sur 3, 41007 Sevilla/.test(l) && !l.includes('Empresa Estructurada')) && csgL.some((l) => /NIF: B12345674/.test(l)), 'casilla 2: el consignatario sale con un dato por línea (razón social, domicilio y NIF de la agenda)');
  await TPL(AD2, { template: 'ESTANDAR', show_driver: false });

  // ---- 16.22 Conductor en el DeCA, cambio de vehículo, anular y finalizar
  info('16.22 Conductor en el DeCA, cambio de vehículo, anulación y finalización');
  const dA22 = (await loginAs(dA, dA.dev)).json.access_token, dB22 = (await loginAs(dB, dB.dev)).json.access_token;
  const base22 = (o = {}) => tb({ driver_id: undefined, origins: [{ address: 'Calle S 1, Granada' }], destinations: [{ address: 'Calle S 2, Madrid' }], ...o });
  const asg = (tid, drv) => http('POST', `/api/v1/transports/${tid}/assign-driver`, { token: O, body: { driver_id: drv } });
  const det22 = async (tid) => (await call('GET', `/api/v1/transports/${tid}`, { token: O })).json;
  const verPdf = async (decaId, n) => pdfRaw((await call('GET', `/api/v1/decas/${decaId}/versions/${n}/pdf`, { token: O })).buf);
  await TPL(AD2, { template: 'CARTA_DE_PORTE', show_driver: true });
  const nd = await call('POST', '/api/v1/transports', { token: O, body: base22({ cargo: `Conductor después ${sfx}` }) });
  const nd1 = await det22(nd.json.id);
  check(nd1.deca.version === 1 && !/DNI: /.test(await verPdf(nd.json.deca_id, 1)), 'un DeCA emitido sin conductor lleva la casilla 9 vacía (versión 1)');
  check((await asg(nd.json.id, dA.id)).status === 204, 'se asigna el conductor al transporte ya emitido');
  const nd2 = await det22(nd.json.id), nd2Pdf = await verPdf(nd.json.deca_id, 2);
  check(nd2.deca.version === 2 && nd2.deca.technical.public_url === nd1.deca.technical.public_url && nd2.deca.technical.sha256 !== nd1.deca.technical.sha256 && /DNI: 12345678Z/.test(nd2Pdf) && /Carlos Pérez Gómez/.test(nd2Pdf), 'al asignar el conductor el DeCA recibe una versión 2 con el MISMO enlace, con su nombre, DNI y teléfono en la casilla 9');
  check(!/DNI: /.test(await verPdf(nd.json.deca_id, 1)) && (await call('GET', `/api/v1/decas/${nd.json.deca_id}`, { token: O })).json.versions.length === 2, 'la versión 1 se conserva intacta (sin conductor) junto a la 2');
  const docNow = await fetch(DOCS + new URL(nd2.deca.technical.public_url).pathname);
  check(docNow.status === 200 && sha256(Buffer.from(await docNow.arrayBuffer())) === nd2.deca.technical.sha256 && decodeQr((await call('GET', `/api/v1/decas/${nd.json.deca_id}/versions/2/pdf`, { token: O })).buf, 'v2.pdf') === nd1.deca.technical.public_url, 'el enlace público y el QR (los mismos de siempre) sirven ya la versión 2');
  check((await asg(nd.json.id, dA.id)).status === 204 && (await det22(nd.json.id)).deca.version === 2, 'volver a asignar al mismo conductor no crea otra versión');
  check((await asg(nd.json.id, dB.id)).status === 204, 'se cambia de conductor');
  const nd3Pdf = await verPdf(nd.json.deca_id, 3);
  check((await det22(nd.json.id)).deca.version === 3 && /9\.1 Datos conductor efectivo sucesivo\. Prueba webB/.test(nd3Pdf) && /DNI: 12345678Z/.test(nd3Pdf), 'al cambiar de conductor, el nuevo va en la casilla 9.1 (sucesivo) y el primero se conserva en la 9');
  check(Number(psql(`SELECT count(*) FROM audit_log WHERE action='DECA_VERSION_ADDED' AND entity_id='${nd.json.deca_id}'`)) === 2, 'cada nueva versión queda en la auditoría');
  await TPL(AD2, { show_driver: false });
  const nd0 = await call('POST', '/api/v1/transports', { token: O, body: base22({ cargo: `Sin datos del conductor ${sfx}` }) });
  await asg(nd0.json.id, dA.id);
  check((await det22(nd0.json.id)).deca.version === 1, 'con «imprimir datos del conductor» desactivado, asignar el conductor no cambia el DeCA');
  await TPL(AD2, { template: 'ESTANDAR', show_driver: true });
  const ne = await call('POST', '/api/v1/transports', { token: O, body: base22({ cargo: `Modelo estándar ${sfx}` }) });
  await asg(ne.json.id, dA.id);
  check((await det22(ne.json.id)).deca.version === 1, 'con el modelo DECARGO (que no imprime conductor), asignar el conductor no cambia el DeCA');
  await TPL(AD2, { template: 'CARTA_DE_PORTE', show_driver: false });

  // cambio de vehículo
  const vN = await call('POST', '/api/v1/vehicles', { token: O, body: { plate: `W${SFX}8`, kind: 'TRACTORA' } }), vNr = await call('POST', '/api/v1/vehicles', { token: O, body: { plate: `W${SFX}9`, kind: 'SEMIRREMOLQUE' } });
  const vc = await call('POST', '/api/v1/transports', { token: O, body: base22({ cargo: `Cambio de vehículo ${sfx}`, driver_id: dA.id }) });
  const vc1 = await det22(vc.json.id);
  const VC = (tok, id, b) => http('POST', `/api/v1/transports/${id}/vehicle-change`, { token: tok, body: b });
  const vcR = await VC(O, vc.json.id, { tractor_id: vN.json.id, trailer_id: vNr.json.id, reason: 'Avería' });
  const vc2 = await det22(vc.json.id), vc2Pdf = await verPdf(vc.json.deca_id, 2);
  check(vcR.status === 200 && vcR.json.deca_version === 2 && vc2.vehicles.tractor.plate === `W${SFX}8` && vc2.deca.version === 2 && vc2.deca.technical.public_url === vc1.deca.technical.public_url, 'cambio de vehículo: el transporte pasa al vehículo nuevo y el DeCA recibe una versión 2 con el mismo enlace');
  check(new RegExp(`6\\. ?|8\\. Matrícula del vehículo.*${pT}`).test(vc2Pdf) && vc2Pdf.includes(pT) && vc2Pdf.includes(`W${SFX}8`) && /8\.1\. Si iniciada la operación/.test(vc2Pdf) && !(await verPdf(vc.json.deca_id, 1)).includes(`W${SFX}8`), 'la versión 2 conserva la matrícula original (casilla 8) y anota la nueva en la 8.1; la versión 1 no cambia');
  check((await http('GET', `/api/v1/driver/transports/${vc.json.id}`, { token: dA22 })).json.vehicles.tractor === `W${SFX}8`, 'el conductor ve el vehículo nuevo en su transporte');
  const vcB = await VC(O, vc.json.id, { tractor_id: vT.json.id, trailer_id: vR.json.id });
  const vc3Pdf = await verPdf(vc.json.deca_id, 3);
  check(vcB.json.deca_version === 3 && vc3Pdf.includes(`W${SFX}8`) && (vc3Pdf.match(new RegExp(pT, 'g')) ?? []).length >= 2, 'un segundo cambio añade otra línea en la 8.1 y conserva la anterior');
  check((await VC(O, vc.json.id, { tractor_id: vT.json.id, trailer_id: vR.json.id })).status === 409 && (await VC(O, vc.json.id, { trailer_id: vR.json.id })).status === 400 && (await VC(O, vc.json.id, { tractor_id: vT.json.id, trailer_id: vT.json.id })).status === 400 && (await VC(O, vc.json.id, { tractor_id: '0'.repeat(8) + '-0000-0000-0000-' + '0'.repeat(12) })).status === 400, 'cambio de vehículo: el mismo vehículo → 409; sin tractora, remolque incompatible o vehículo inexistente → 400');
  check([await VC(undefined, vc.json.id, { tractor_id: vN.json.id }), await VC(dA22, vc.json.id, { tractor_id: vN.json.id }), await VC(ro16.tok, vc.json.id, { tractor_id: vN.json.id })].map((r) => r.status).join() === '401,403,403' && (await VC(O, 'zzz', { tractor_id: vN.json.id })).status === 404, 'cambio de vehículo: sin sesión 401; conductor y solo_lectura 403; transporte inexistente 404');
  check(Number(psql(`SELECT count(*) FROM audit_log WHERE action='TRANSPORT_VEHICLE_CHANGED' AND entity_id='${vc.json.id}'`)) === 2, 'los cambios de vehículo quedan auditados');
  const vNoDeca = await call('POST', '/api/v1/transports', { token: O, body: base22({ cargo: `Borrador ${sfx}`, generate_deca: false }) });
  const vcNo = await VC(O, vNoDeca.json.id, { tractor_id: vN.json.id });
  check(vcNo.status === 200 && vcNo.json.deca_version === null && (await det22(vNoDeca.json.id)).vehicles.tractor.plate === `W${SFX}8` && !(await det22(vNoDeca.json.id)).deca, 'cambio de vehículo en un transporte sin DeCA: cambia el vehículo y no crea ningún DeCA');
  // anular
  const cx = await call('POST', '/api/v1/transports', { token: O, body: base22({ cargo: `Anulable ${sfx}`, driver_id: dA.id }) });
  const CX = (tok, id, reason) => http('POST', `/api/v1/transports/${id}/cancel`, { token: tok, body: reason === undefined ? {} : { reason } });
  check([await CX(undefined, cx.json.id, 'Cliente cancela'), await CX(dA22, cx.json.id, 'Cliente cancela'), await CX(ro16.tok, cx.json.id, 'Cliente cancela')].map((r) => r.status).join() === '401,403,403' && (await CX(O, cx.json.id)).status === 400 && (await CX(O, cx.json.id, 'ab')).status === 400 && (await CX(O, 'zzz', 'Cliente cancela')).status === 404, 'anular: sin sesión 401; conductor y solo_lectura 403; sin motivo o motivo corto 400; inexistente 404');
  check((await http('GET', `/api/v1/driver/transports/${cx.json.id}`, { token: dA22 })).status === 200, 'antes de anular, el conductor ve el transporte');
  check((await CX(O, cx.json.id, 'El cliente cancela el servicio')).status === 204 && (await det22(cx.json.id)).status === 'CANCELADO', 'la oficina anula el transporte con su motivo y queda como CANCELADO');
  check((await http('GET', `/api/v1/driver/transports/${cx.json.id}`, { token: dA22 })).status === 404 && !(await http('GET', '/api/v1/driver/transports', { token: dA22 })).json.some((x) => x.id === cx.json.id), 'el conductor deja de ver el transporte anulado');
  const cxDeca = await call('GET', `/api/v1/decas/${cx.json.deca_id}/versions/1/pdf`, { token: O }), cxPub = await fetch(DOCS + new URL((await det22(cx.json.id)).deca.technical.public_url).pathname);
  check(cxDeca.status === 200 && cxPub.status === 200, 'el DeCA del transporte anulado se conserva: la oficina lo descarga y su enlace sigue funcionando');
  check((await CX(O, cx.json.id, 'Otra vez')).status === 409 && (await VC(O, cx.json.id, { tractor_id: vN.json.id })).status === 409, 'un transporte anulado no se puede anular otra vez ni cambiarle el vehículo (409)');
  check(psql(`SELECT after->>'status' || '|' || reason FROM audit_log WHERE action='TRANSPORT_CANCELLED' AND entity_id='${cx.json.id}'`) === 'CANCELADO|El cliente cancela el servicio', 'la anulación queda auditada con su motivo');
  check(psqlAs('deca_api', ENV.DB_API_PASSWORD, 'DELETE FROM transport').includes('permission denied'), 'permisos de BD: la API sigue sin poder borrar transportes (solo anular)');
  // finalizar por el conductor
  const fn = await call('POST', '/api/v1/transports', { token: O, body: base22({ cargo: `Finalizable ${sfx}`, driver_id: dA.id }) });
  const FN = (tok, id) => http('POST', `/api/v1/driver/transports/${id}/finish`, { token: tok });
  check((await FN(undefined, fn.json.id)).status === 401 && (await FN(O, fn.json.id)).status === 403 && (await FN(dB22, fn.json.id)).status === 404 && (await FN(dA22, 'zzz')).status === 404, 'finalizar: sin sesión 401; oficina 403; otro conductor y transporte inexistente 404 (sin revelar nada)');
  const pendB = await loginAs(dB, null, 'tel-pendiente-b3'); const fnB = await call('POST', '/api/v1/transports', { token: O, body: base22({ cargo: `Finalizable B ${sfx}`, driver_id: dB.id }) });
  check(pendB.status === 200 && pendB.json.scope === 'LIMITED' && (await FN(pendB.json.access_token, fnB.json.id)).status === 403, 'un dispositivo PENDIENTE de autorizar no puede finalizar (solo lectura, D-05)');
  const fnR = await FN(dA22, fn.json.id), fnD = await det22(fn.json.id);
  check(fnR.status === 200 && fnR.json.finished_at && fnD.status === 'FINALIZADO' && psql(`SELECT finished_at IS NOT NULL AND started_at IS NOT NULL FROM transport WHERE id='${fn.json.id}'`) === 't', 'el conductor finaliza su transporte: queda FINALIZADO con su hora');
  check(!(await http('GET', '/api/v1/driver/transports', { token: dA22 })).json.some((x) => x.id === fn.json.id) && (await http('GET', `/api/v1/driver/transports/${fn.json.id}`, { token: dA22 })).status === 404, 'el conductor deja de ver el transporte finalizado');
  const yr = new Date().getFullYear() + 1;
  check(psql(`SELECT retain_not_before::text FROM deca WHERE id='${fn.json.deca_id}'`) === `${yr}-12-31`, `al finalizar se fija el plazo mínimo de conservación del DeCA (hasta el 31/12/${yr})`);
  check((await FN(dA22, fn.json.id)).status === 409 && (await VC(O, fn.json.id, { tractor_id: vN.json.id })).status === 409 && (await CX(O, fn.json.id, 'Ya finalizado')).status === 409, 'un transporte finalizado no se puede finalizar, anular ni cambiarle el vehículo otra vez (409)');
  check([404, 409].includes((await FN(dA22, cx.json.id)).status) && (await det22(cx.json.id)).status === 'CANCELADO', 'un transporte anulado ya no se puede finalizar desde la app del conductor (sigue ANULADO)');
  check(psql(`SELECT count(*) FROM audit_log WHERE action='TRANSPORT_FINISHED' AND entity_id='${fn.json.id}' AND after->>'by'='conductor'`) === '1', 'la finalización queda auditada');
  await TPL(AD2, { template: 'ESTANDAR', show_driver: false });

  // ---- 16.23 Avisos al conductor de cualquier cambio en su transporte
  info('16.23 Avisos de cambios en el transporte');
  const devA = psql(`SELECT id FROM device WHERE user_id = '${dA.id}' AND status = 'AUTORIZADO' LIMIT 1`);
  const devB = psql(`SELECT id FROM device WHERE user_id = '${dB.id}' AND status = 'AUTORIZADO' LIMIT 1`);
  // Suscripción simulada (dominio inexistente): el envío falla, pero cada aviso queda registrado en push_event con su tipo.
  psql(`DELETE FROM push_subscription WHERE device_id IN ('${devA}','${devB}'); INSERT INTO push_subscription (device_id, endpoint, kind) VALUES ('${devA}', 'tokA-${sfx}', 'FCM'), ('${devB}', 'tokB-${sfx}', 'FCM')`);
  const evs = async (tid, user, n) => { for (let k = 0; k < 20; k++) { const r = psql(`SELECT string_agg(type, ',' ORDER BY id) FROM push_event WHERE transport_id = '${tid}' AND user_id = '${user}'`); if (r.split(',').filter(Boolean).length >= n) return r; await new Promise((ok) => setTimeout(ok, 300)); } return psql(`SELECT string_agg(type, ',' ORDER BY id) FROM push_event WHERE transport_id = '${tid}' AND user_id = '${user}'`); };
  await TPL(AD2, { template: 'ESTANDAR', show_driver: false });
  const nt = await call('POST', '/api/v1/transports', { token: O, body: tb({ cargo: `Avisos ${sfx}`, driver_id: dA.id, origins: [{ address: 'Calle N 1, Granada' }], destinations: [{ address: 'Calle N 2, Madrid' }] }) });
  check(nt.status === 201 && (await evs(nt.json.id, dA.id, 1)) === 'TRANSPORT_ASSIGNED', 'crear un transporte con el conductor ya elegido le envía el aviso de «Nuevo transporte asignado» (antes no se enviaba)');
  const vN23 = await call('POST', '/api/v1/vehicles', { token: O, body: { plate: `V${SFX}3`, kind: 'TRACTORA' } });
  await http('POST', `/api/v1/transports/${nt.json.id}/vehicle-change`, { token: O, body: { tractor_id: vN23.json.id, reason: 'Avería' } });
  check((await evs(nt.json.id, dA.id, 2)) === 'TRANSPORT_ASSIGNED,TRANSPORT_UPDATED', 'cambiar el vehículo avisa al conductor («Transporte modificado»)');
  await http('POST', `/api/v1/transports/${nt.json.id}/assign-driver`, { token: O, body: { driver_id: dB.id } });
  check((await evs(nt.json.id, dA.id, 3)) === 'TRANSPORT_ASSIGNED,TRANSPORT_UPDATED,TRANSPORT_UNASSIGNED' && (await evs(nt.json.id, dB.id, 1)) === 'TRANSPORT_ASSIGNED', 'reasignar: el conductor anterior recibe «Transporte retirado» y el nuevo «Nuevo transporte asignado»');
  await http('POST', `/api/v1/transports/${nt.json.id}/cancel`, { token: O, body: { reason: 'El cliente lo anula' } });
  check((await evs(nt.json.id, dB.id, 2)) === 'TRANSPORT_ASSIGNED,TRANSPORT_CANCELLED' && (await evs(nt.json.id, dA.id, 3)).split(',').length === 3, 'anular avisa SOLO al conductor actual («Transporte anulado»)');
  const nd23 = await call('POST', '/api/v1/transports', { token: O, body: tb({ cargo: `Avisos DeCA ${sfx}`, driver_id: dA.id, generate_deca: false, origins: [{ address: 'Calle N 1, Granada' }], destinations: [{ address: 'Calle N 2, Madrid' }] }) });
  await call('POST', `/api/v1/transports/${nd23.json.id}/deca`, { token: O });
  check((await evs(nd23.json.id, dA.id, 2)) === 'TRANSPORT_ASSIGNED,TRANSPORT_UPDATED', 'emitir el DeCA después avisa al conductor');
  const nn = await call('POST', '/api/v1/transports', { token: O, body: tb({ cargo: `Sin conductor ${sfx}`, driver_id: undefined }) });
  await new Promise((ok) => setTimeout(ok, 800));
  check(psql(`SELECT count(*) FROM push_event WHERE transport_id = '${nn.json.id}'`) === '0', 'un transporte sin conductor no avisa a nadie');
  psql(`DELETE FROM push_subscription WHERE endpoint IN ('tokA-${sfx}', 'tokB-${sfx}')`);

  // ---- 16.24 Estados por conductor, relevo («he terminado mi parte») y PIN para el conductor
  info('16.24 Estados, relevo y PIN de la tarjeta');
  const dA24 = (await loginAs(dA, dA.dev)).json.access_token, dB24 = (await loginAs(dB, dB.dev)).json.access_token;
  const b24 = (o = {}) => tb({ origins: [{ address: 'Calle R 1, Granada' }], destinations: [{ address: 'Calle R 2, Madrid' }], ...o });
  const st = async (id) => (await call('GET', `/api/v1/transports/${id}`, { token: O })).json;
  const sinC = await call('POST', '/api/v1/transports', { token: O, body: b24({ cargo: `Sin conductor ${sfx}`, driver_id: undefined }) });
  const conC = await call('POST', '/api/v1/transports', { token: O, body: b24({ cargo: `Con conductor ${sfx}`, driver_id: dA.id }) });
  check((await st(sinC.json.id)).status === 'PENDIENTE' && (await st(conC.json.id)).status === 'EN_CURSO', 'sin conductor → PENDIENTE; con conductor → EN CURSO');
  const lp = (await call('GET', '/api/v1/transports?status=PENDIENTE', { token: O })).json, le = (await call('GET', '/api/v1/transports?status=EN_CURSO', { token: O })).json;
  check(lp.some((x) => x.id === sinC.json.id) && !lp.some((x) => x.id === conC.json.id) && le.some((x) => x.id === conC.json.id) && lp.every((x) => !x.driver_user_id) && le.every((x) => !!x.driver_user_id), 'los filtros de la oficina: Pendientes = sin conductor, En curso = con conductor');
  await http('POST', `/api/v1/transports/${sinC.json.id}/assign-driver`, { token: O, body: { driver_id: dA.id } });
  check((await st(sinC.json.id)).status === 'EN_CURSO', 'al asignar conductor pasa a EN CURSO');
  // Relevo
  const rel = await http('POST', `/api/v1/transports/${conC.json.id}/assign-driver`, { token: O, body: { driver_id: dB.id, relay: true } });
  const conD = await st(conC.json.id);
  check(rel.status === 204 && conD.driver.id === dA.id && conD.relay?.id === dB.id, 'programar relevo: el conductor actual SIGUE con el transporte y el relevo queda anotado');
  check((await http('POST', `/api/v1/transports/${conC.json.id}/assign-driver`, { token: O, body: { driver_id: dA.id, relay: true } })).status === 409, 'el relevo no puede ser el mismo conductor (409)');
  const aList = (await http('GET', '/api/v1/driver/transports', { token: dA24 })).json;
  check(aList.find((x) => x.id === conC.json.id)?.relay && !(await http('GET', '/api/v1/driver/transports', { token: dB24 })).json.some((x) => x.id === conC.json.id), 'el conductor actual ve quién le releva; el relevo aún no lo ve');
  const FP = (tok, id) => http('POST', `/api/v1/driver/transports/${id}/finish-part`, { token: tok });
  check((await FP(undefined, conC.json.id)).status === 401 && (await FP(O, conC.json.id)).status === 403 && (await FP(dB24, conC.json.id)).status === 404 && (await FP(pendB.json.access_token, conC.json.id)).status === 403, 'terminar mi parte: sin sesión 401; oficina 403; otro conductor 404; dispositivo pendiente 403');
  const fp1 = await FP(dA24, conC.json.id);
  const after1 = await st(conC.json.id);
  check(fp1.status === 200 && fp1.json.next_driver === true && after1.status === 'EN_CURSO' && after1.driver.id === dB.id && !after1.relay, '«He terminado mi parte»: pasa al relevo y sigue EN CURSO');
  check(!(await http('GET', '/api/v1/driver/transports', { token: dA24 })).json.some((x) => x.id === conC.json.id) && (await http('GET', '/api/v1/driver/transports', { token: dB24 })).json.some((x) => x.id === conC.json.id), 'al primer conductor le desaparece; el relevo ya lo ve');
  const fp2 = await FP(dB24, conC.json.id), after2 = await st(conC.json.id);
  check(fp2.json.next_driver === false && after2.status === 'PENDIENTE' && !after2.driver && after2.drivers_history.length === 2 && after2.drivers_history.every((h) => h.valid_to), 'sin relevo, al terminar su parte vuelve a PENDIENTE (sin conductor) y queda el historial de tramos');
  check(psql(`SELECT count(*) FROM audit_log WHERE action = 'TRANSPORT_LEG_FINISHED' AND entity_id = '${conC.json.id}'`) === '2' && psql(`SELECT count(*) FROM audit_log WHERE action = 'TRANSPORT_RELAY_SET' AND entity_id = '${conC.json.id}'`) === '1', 'los tramos y el relevo quedan auditados');
  await http('POST', `/api/v1/transports/${conC.json.id}/assign-driver`, { token: O, body: { driver_id: dA.id } });
  await http('POST', `/api/v1/transports/${conC.json.id}/assign-driver`, { token: O, body: { driver_id: dB.id, relay: true } });
  check((await http('DELETE', `/api/v1/transports/${conC.json.id}/relay`, { token: O })).status === 204 && !(await st(conC.json.id)).relay && (await http('DELETE', `/api/v1/transports/${conC.json.id}/relay`, { token: dA24 })).status === 403, 'la oficina puede quitar el relevo (el conductor no)');
  await http('POST', `/api/v1/transports/${conC.json.id}/cancel`, { token: O, body: { reason: 'Fin de la prueba' } });
  check((await http('POST', `/api/v1/transports/${conC.json.id}/assign-driver`, { token: O, body: { driver_id: dB.id } })).status === 409, 'no se asigna conductor a un transporte anulado (409)');
  // PIN de la tarjeta de combustible del vehículo asignado
  const CARDS = (tok, id) => http('GET', `/api/v1/driver/transports/${id}/cards`, { token: tok });
  const pinT = await call('POST', '/api/v1/transports', { token: O, body: b24({ cargo: `PIN ${sfx}`, driver_id: dA.id }) });
  const pinTr = (await st(pinT.json.id)).vehicles.tractor.id;
  const card24 = await AS(O, pinTr, { kind: 'FUEL_CARD', provider: 'DKV', identifier: `7078-9999-${SFX}`, pin: 'kP4wR8', expires_on: iso(60) });
  const auditPin0 = Number(psql(`SELECT count(*) FROM audit_log WHERE action = 'VEHICLE_ASSET_PIN_REVEALED' AND entity_id = '${pinT.json.id}'`));
  const cr = await CARDS(dA24, pinT.json.id);
  check(cr.status === 200 && card24.status === 201 && cr.json.some((c) => c.kind === 'FUEL_CARD' && c.pin === 'kP4wR8' && c.identifier === `7078-9999-${SFX}`), 'el conductor ve la tarjeta de combustible del vehículo asignado con su PIN');
  check(Number(psql(`SELECT count(*) FROM audit_log WHERE action = 'VEHICLE_ASSET_PIN_REVEALED' AND entity_id = '${pinT.json.id}'`)) === auditPin0 + 1 && !JSON.stringify((await http('GET', '/api/v1/driver/transports', { token: dA24 })).json).includes('kP4wR8'), 'cada consulta del PIN queda auditada y el PIN nunca va en la lista de transportes');
  check((await CARDS(dB24, pinT.json.id)).status === 404 && (await CARDS(O, pinT.json.id)).status === 403 && (await CARDS(undefined, pinT.json.id)).status === 401 && (await CARDS(pendB.json.access_token, pinT.json.id)).status === 403, 'PIN: otro conductor 404; oficina por esta vía 403; sin sesión 401; dispositivo pendiente 403');
  check(!execFileSync('docker', ['compose', 'logs', '--no-color', 'api', 'web'], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 }).includes('kP4wR8'), 'el PIN no aparece en los registros de la API ni de la web');

  // ---- 16.10 seed de desarrollo
  info('16.10 Seed de desarrollo (credenciales aleatorias, idempotente)');
  const seedState = () => psql(`SELECT (SELECT count(*) FROM app_user)||':'||(SELECT count(*) FROM vehicle)||':'||(SELECT count(*) FROM transport)||':'||(SELECT count(*) FROM deca)||':'||(SELECT md5(string_agg(password_hash, ',' ORDER BY username)) FROM app_user WHERE username LIKE '%.dev')`);
  if (psql(`SELECT count(*) FROM app_user WHERE username LIKE '%.dev'`) !== '0') { bad('16.10 NO se ejecuta: ya existen usuarios *.dev (¿es la base real?). Esta prueba renueva contraseñas y borra .dev-credentials; úsala solo en una copia desechable'); } else {
  const s1 = sh('./deca seed-dev'); const sAfter1 = seedState();
  check(/Credenciales nuevas guardadas/.test(s1) && psql(`SELECT count(*) FROM app_user WHERE username LIKE '%.dev' AND password_hash LIKE '$argon2id$%'`) === '4', 'el seed crea 4 usuarios de desarrollo con contraseña Argon2id y guarda las credenciales en .dev-credentials');
  const mode = (execSync('stat -c %a .dev-credentials', { encoding: 'utf8' })).trim();
  check(mode === '600', `.dev-credentials tiene permisos 600 (${mode})`);
  const creds = Object.fromEntries(readFileSync('.dev-credentials', 'utf8').split('\n').filter((l) => /^\S+\.dev\s+\S+-\S+-\S+-\S+$/.test(l)).map((l) => l.trim().split(/\s+/)));
  check(Object.keys(creds).length === 4 && Object.values(creds).every((p) => /^[a-z0-9]{4}(-[a-z0-9]{4}){3}$/.test(p)) && new Set(Object.values(creds)).size === 4, 'las 4 contraseñas tienen 16 caracteres aleatorios y son distintas entre sí');
  keep(...Object.values(creds));
  const dump = execFileSync('docker', ['compose', 'exec', '-T', 'db', 'pg_dump', '-U', 'postgres', 'decargo'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  check(Object.values(creds).every((p) => !dump.includes(p)), 'ninguna contraseña del seed aparece en un volcado completo de la base de datos');
  const s2 = sh('./deca seed-dev'); const sAfter2 = seedState();
  check(/ya tienen contraseña/.test(s2) && /nada nuevo/.test(s2) && sAfter1 === sAfter2, 'repetir el seed no crea nada ni cambia ninguna contraseña (idempotente)', `${sAfter1} / ${sAfter2}`);
  check(psql(`SELECT count(*) FROM deca WHERE public_url IS NULL`) === '0', 'todos los DeCA (incluidos los del seed) guardan la URL con la que se emitió su PDF');
  const dl = await http('POST', '/api/v1/auth/login', { body: { username: 'conductor1.dev', password: creds['conductor1.dev'] } });
  check(dl.status === 200 && dl.json.user.role === 'conductor', 'conductor1.dev entra con la contraseña del fichero (desde un navegador nuevo queda PENDIENTE y de solo lectura)', `${dl.status} ${dl.json?.scope}`);
  const dm = await http('POST', '/api/v1/auth/login', { body: { username: 'admin.dev', password: creds['admin.dev'] } });
  check(dm.status === 200 && dm.json.scope === 'MFA_PENDING' && (await http('GET', '/api/v1/dashboard', { token: dm.json.access_token })).status === 403, 'admin.dev sin TOTP enrolado: la contraseña sola da solo una sesión MFA_PENDING que no puede leer nada (solo enrolar el segundo factor)', `${dm.status} ${dm.json?.scope}`);
  const dTr = dl.status === 200 ? await http('GET', '/api/v1/driver/transports', { token: dl.json.access_token }) : { json: [] };
  info(`conductor1.dev (dispositivo pendiente) ve ${dTr.json.length} transporte(s) asignado(s) antes de registrarse`);
  const rp = sh('./deca seed-dev --reset-passwords'); check(/Credenciales nuevas/.test(rp) && seedState().split(':').slice(0, 4).join(':') === sAfter2.split(':').slice(0, 4).join(':'), '--reset-passwords renueva solo las contraseñas (no duplica datos)');
  check((await http('POST', '/api/v1/auth/login', { body: { username: 'conductor1.dev', password: creds['conductor1.dev'] } })).status === 401, 'la contraseña anterior deja de valer tras renovarla');
  rmSync('.dev-credentials', { force: true });
  }
  }

  say(''); say('## Resumen'); say(`- Comprobaciones superadas: **${pass}** · fallidas: **${fail}**`);
  // La sección 16 reemite DeCA (masivamente): T1..T3 deben apuntar a su DeCA VIGENTE para las comprobaciones posteriores a la restauración.
  for (const T of [T1, T2, T3]) {
    const cur = psql(`SELECT d.id||'|'||v.sha256 FROM deca_transport dt JOIN deca d ON d.id = dt.deca_id AND d.status = 'ACTIVE' JOIN deca_version v ON v.deca_id = d.id AND v.version_no = d.current_version WHERE dt.transport_id = '${T.transport_id}'`).split('|');
    [T.deca_id, T.sha256] = cur;
  }
  // estado para la prueba de restauración (contiene credenciales de PRUEBA; fichero 600, se borra después)
  const state = { sfx, ofi: pick(ofi), admin: pick(admin), c1: { ...pick(c1), d1: c1.d1, pend: c1.pend, pendDeviceId: c1.pendDeviceId }, c2: pick(c2), c4: pick(c4), c6: { ...pick(c6), dev: exDev }, T1, T2, T3, totpLast: lastUsed };
  mkdirSync(dirname(STATE_FILE), { recursive: true }); writeFileSync(STATE_FILE, JSON.stringify(state)); chmodSync(STATE_FILE, 0o600);
  writeReport('identidad');
}
const pick = (u) => ({ username: u.username, password: u.password, id: u.id, totpSecret: u.totpSecret });
function writeReport(name) { const f = `informes/${name}-${TS}.md`; writeFileSync(f, lines.join('\n') + '\n'); console.log(`\nInforme: ${f}`); }

// ------------------------------------------------------------------ backup → destrucción → restauración → comprobaciones
const fingerprint = () => ({
  users: psql(`SELECT md5(string_agg(id::text||username||role||active::text||coalesce(password_hash,''), ',' ORDER BY id)) FROM app_user`),
  nUsers: psql('SELECT count(*) FROM app_user'),
  roles: psql(`SELECT string_agg(role||':'||n, ',' ORDER BY role) FROM (SELECT role, count(*) n FROM app_user GROUP BY role) x`),
  devices: psql(`SELECT md5(string_agg(id::text||user_id::text||status||secret_hash, ',' ORDER BY id)) FROM device`),
  deviceStates: psql(`SELECT string_agg(status||':'||n, ',' ORDER BY status) FROM (SELECT status, count(*) n FROM device GROUP BY status) x`),
  assignments: psql(`SELECT md5(string_agg(id::text||transport_id::text||driver_user_id::text||coalesce(valid_to::text,''), ',' ORDER BY id)) FROM transport_driver_assignment`),
  nAssign: psql('SELECT count(*) FROM transport_driver_assignment'),
  decas: psql(`SELECT md5(string_agg(deca_id::text||version_no||sha256, ',' ORDER BY deca_id, version_no)) FROM deca_version`),
  nDecas: psql('SELECT count(*) FROM deca'),
  totp: psql(`SELECT md5(string_agg(id::text||coalesce(totp_secret_enc,'')||coalesce(totp_enabled_at::text,'')||coalesce(totp_last_step::text,''), ',' ORDER BY id)) FROM app_user`),
  nTotp: psql('SELECT count(*) FROM app_user WHERE totp_enabled_at IS NOT NULL'),
  ext: psql(`SELECT md5(string_agg(id::text||sha256||review_status||device_status, ',' ORDER BY id)) FROM external_deca`),
  nExt: psql('SELECT count(*) FROM external_deca'),
  vehicles: psql(`SELECT md5(string_agg(id::text||plate_norm||plate_display||kind||active::text, ',' ORDER BY id)) FROM vehicle`),
  nVehicles: psql('SELECT count(*) FROM vehicle'),
  vassign: psql(`SELECT md5(string_agg(id::text||transport_id::text||tractor_id::text||coalesce(trailer_id::text,'')||coalesce(valid_to::text,''), ',' ORDER BY id)) FROM transport_vehicle_assignment`),
  transports: psql(`SELECT md5(string_agg(id::text||status||shipper_name||shipper_nif||cargo_description||coalesce(weight_kg::text,'')||transport_date::text, ',' ORDER BY id)) FROM transport`),
  nTransports: psql('SELECT count(*) FROM transport'),
  urls: psql(`SELECT md5(string_agg(id::text||coalesce(public_url,''), ',' ORDER BY id)) FROM deca`),
  parties: psql(`SELECT md5(string_agg(id::text||name||coalesce(nif,'')||coalesce(address,''), ',' ORDER BY id)) FROM party`),
  sites: psql(`SELECT md5(string_agg(id::text||address||coalesce(lat::text,'')||coalesce(map_url,''), ',' ORDER BY id)) FROM party_site`),
  nParties: psql('SELECT count(*)||\':\'||(SELECT count(*) FROM party_site) FROM party'),
  profiles: psql(`SELECT md5(string_agg(user_id::text||coalesce(nif_enc,'')||coalesce(iban_enc,'')||coalesce(ss_enc,'')||coalesce(street,'')||coalesce(phone,''), ',' ORDER BY user_id)) FROM driver_profile`),
  nProfiles: psql('SELECT count(*) FROM driver_profile'),
  docs: psql(`SELECT md5(string_agg(id::text||doc_type||coalesce(expires_on::text,'')||active::text||coalesce(number,''), ',' ORDER BY id)) FROM control_document`),
  assets: psql(`SELECT md5(string_agg(id::text||kind||identifier||coalesce(pin_enc,'')||coalesce(expires_on::text,''), ',' ORDER BY id)) FROM vehicle_asset`),
  nDocs: psql('SELECT count(*)||\':\'||(SELECT count(*) FROM vehicle_asset) FROM control_document'),
  audit: psql(`SELECT count(*)||':'||max(hash) FROM audit_log`)
});

async function restoreCheck() {
  say(`# Backup y restauración con identidad · ${TS}`);
  const S = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  Object.assign(lastUsed, S.totpLast || {});
  section('1. Estado antes del desastre');
  const f0 = fingerprint();
  say(`- usuarios: ${f0.nUsers} (${f0.roles}) · dispositivos: ${f0.deviceStates} · asignaciones: ${f0.nAssign} · DeCA: ${f0.nDecas} · auditoría: ${f0.audit.split(':')[0]} filas`);
  const liveSessions = psql(`SELECT count(*) FROM session WHERE revoked_at IS NULL AND expires_at > now()`);
  info(`sesiones activas antes del backup: ${liveSessions}`);
  const oldAccess = (await loginAs({ username: S.c1.username, password: S.c1.password }, S.c1.d1)).json; keep();
  check(oldAccess?.access_token, 'sesión viva del conductor 1 (dispositivo autorizado) justo antes del backup');

  section('2. Backup, destrucción y restauración');
  const t0 = Date.now(); sh('./deca backup'); const tb = (Date.now() - t0) / 1000; ok(`backup completado en ${tb.toFixed(0)} s`);
  const snap = sh('./deca snapshots').split('\n').filter((l) => /^[0-9a-f]{8} /.test(l)).pop().split(' ')[0]; info(`snapshot: ${snap}`);
  sh('./deca destroy-test-data --yes-destroy-test-data', { env: { ...process.env, DECARGO_ALLOW_DESTROY: '1' } });
  const vol = (n) => { try { sh(`docker volume inspect ${n}`); return true; } catch { return false; } };
  check(!vol(`${PROJ}_pgdata`) && !vol(`${PROJ}_documents`) && vol(`${PROJ}_backups`), 'datos de prueba destruidos: volúmenes pgdata y documents eliminados; repositorio de backup intacto');
  const t1 = Date.now(); const rout = sh(`./deca restore ${snap}`); const tr = (Date.now() - t1) / 1000;
  check(/sessions_revoked/.test(rout), `restauración completada en ${tr.toFixed(0)} s e invalidación de sesiones ejecutada`);
  ENV = envFile();

  section('3. Datos conservados tras la restauración');
  const f1 = fingerprint();
  check(f0.users === f1.users && f0.nUsers === f1.nUsers, `usuarios, roles y HASHES de contraseña idénticos (${f1.nUsers} usuarios; ${f1.roles})`);
  check(f0.devices === f1.devices, `dispositivos idénticos incluidos sus secretos (hash) y estados: ${f1.deviceStates}`);
  check(f0.totp === f1.totp && Number(f1.nTotp) >= 2, `secretos TOTP (cifrados), activación y último paso usado idénticos (${f1.nTotp} usuarios con TOTP)`);
  check(f0.ext === f1.ext && Number(f1.nExt) >= 1, `DeCA externos idénticos (${f1.nExt}), con su estado de revisión y el estado del dispositivo con que se añadieron`);
  check(f0.assignments === f1.assignments && f0.nAssign === f1.nAssign, `asignaciones de conductor idénticas (${f1.nAssign})`);
  check(f0.vehicles === f1.vehicles && f0.vassign === f1.vassign && f0.nVehicles === f1.nVehicles && Number(f1.nVehicles) >= 3, `vehículos y sus asignaciones a transportes idénticos (${f1.nVehicles} vehículos)`);
  check(f0.parties === f1.parties && f0.sites === f1.sites && f0.nParties === f1.nParties && !f1.nParties.startsWith('0:'), `agenda de empresas y lugares con su ubicación idéntica tras restaurar (${f1.nParties.replace(':', ' empresas / ')} lugares)`);
  check(f0.profiles === f1.profiles && f0.nProfiles === f1.nProfiles && Number(f1.nProfiles) >= 1, `fichas de conductor (con sus datos cifrados) idénticas tras restaurar (${f1.nProfiles})`);
  check(f0.docs === f1.docs && f0.assets === f1.assets && f0.nDocs === f1.nDocs && !f1.nDocs.startsWith('0:'), `documentos con caducidad y tarjetas (con su PIN cifrado) idénticos tras restaurar (${f1.nDocs.replace(':', ' documentos / ')} tarjetas)`);
  check(f0.transports === f1.transports && f0.nTransports === f1.nTransports && f0.urls === f1.urls, `transportes (${f1.nTransports}) y la URL pública guardada con cada DeCA idénticos`);
  check(f0.decas === f1.decas && f0.nDecas === f1.nDecas, `DeCA y versiones idénticos (${f1.nDecas})`);
  check(f1.audit.split(':')[0] >= f0.audit.split(':')[0], 'auditoría conservada (la restauración añade el registro de invalidación de sesiones)', `${f0.audit.split(':')[0]} → ${f1.audit.split(':')[0]}`);
  const v = sh('./deca verify'); const vj = JSON.parse(v.slice(v.indexOf('{')));
  check(vj.problems.length === 0 && vj.audit_chain_ok && vj.tokens_recoverable === vj.decas && vj.external_verified === vj.external_total && vj.totp_decryptable === Number(f1.nTotp) + psql(`SELECT count(*) FROM app_user WHERE totp_secret_enc IS NOT NULL AND totp_enabled_at IS NULL`) * 1, `verify: ${vj.documents_verified} documentos, ${vj.tokens_recoverable} tokens recuperables, ${vj.totp_decryptable} secretos TOTP descifrables con la APP_KEY restaurada, cadena de auditoría íntegra`);

  section('4. Sesiones: decisión de invalidarlas al restaurar');
  check((await http('GET', '/api/v1/driver/transports', { token: oldAccess.access_token })).status === 401, 'el access token anterior a la restauración ya no vale');
  check((await http('POST', '/api/v1/auth/refresh', { body: { refresh_token: oldAccess.refresh_token } })).status === 401, 'el refresh token anterior a la restauración ya no vale');
  check(psql(`SELECT count(*) FROM session WHERE revoked_at IS NULL`) === '0' && Number(psql(`SELECT count(*) FROM session WHERE revoked_reason='restore'`)) > 0, 'todas las sesiones de antes quedan revocadas con motivo «restore» (ninguna activa)');
  info('DECISIÓN: se invalidan TODAS las sesiones al restaurar. Motivo: el estado restaurado puede ir por detrás de lo que tienen los clientes (refresh tokens rotados después del backup) y una restauración es un momento de recuperación ante incidente. Los dispositivos conservan su confianza: solo hay que volver a iniciar sesión.');

  section('5. Funcionamiento tras restaurar');
  const L1 = await loginAs({ username: S.c1.username, password: S.c1.password }, S.c1.d1);
  check(L1.status === 200 && L1.json.scope === 'FULL', 'conductor 1: la contraseña restaurada funciona y su dispositivo AUTORIZADO sigue autorizado (sin volver a pasar por pendiente)');
  const tl = await http('GET', '/api/v1/driver/transports', { token: L1.json.access_token });
  check(tl.json.length === 2 && tl.json.some((t) => t.id === S.T1.transport_id) && tl.json.some((t) => t.id === S.T3.transport_id), 'conserva sus asignaciones (T1 y T3)');
  const pdf = await http('GET', `/api/v1/driver/decas/${S.T1.deca_id}/current.pdf`, { token: L1.json.access_token });
  check(pdf.status === 200 && sha256(pdf.buf) === S.T1.sha256, 'obtiene el DeCA con el mismo hash');
  const qrUrlR = decodeQr((await http('GET', `/api/v1/driver/decas/${S.T1.deca_id}/qr.svg`, { token: L1.json.access_token })).buf, 'qrr.svg');
  const viaDocs = await fetch(qrUrlR).then(async (r) => ({ s: r.status, h: sha256(Buffer.from(await r.arrayBuffer())) }));
  check(viaDocs.s === 200 && viaDocs.h === S.T1.sha256, 'el QR (URL con token) sigue sirviendo el mismo PDF');
  const rv = await loginAs({ username: S.c1.username, password: S.c1.password }, S.c1.pend);
  check(rv.status === 403 && rv.json.error === 'device_revoked', 'el dispositivo REVOCADO sigue revocado tras restaurar');
  const L4 = await http('POST', '/api/v1/auth/login', { body: { username: S.c4.username, password: S.c4.password } });
  check(L4.status === 409 && L4.json.error === 'pending_device_limit', 'el conductor 4 conserva sus 3 dispositivos pendientes (el límite sigue aplicándose)');
  const L2 = await http('POST', '/api/v1/auth/login', { body: { username: S.c2.username, password: S.c2.password } });
  check(L2.status === 401, 'el usuario desactivado sigue desactivado');
  const noTotp = await http('POST', '/api/v1/auth/login', { body: { username: S.ofi.username, password: S.ofi.password } });
  check(noTotp.status === 401 && noTotp.json.error === 'totp_required', 'tras restaurar, oficina SIGUE necesitando el segundo factor (contraseña sola → totp_required)');
  const Lo = await loginAs({ username: S.ofi.username, password: S.ofi.password, totpSecret: S.ofi.totpSecret }, null);
  check(Lo.status === 200 && Lo.json.user.role === 'oficina' && Lo.json.scope === 'FULL', 'oficina inicia sesión con su contraseña y su TOTP restaurados (el secreto cifrado se descifra con la APP_KEY recuperada)');
  const pendCount = (await http('GET', '/api/v1/devices?status=PENDIENTE_DE_CONFIRMACION', { token: Lo.json.access_token })).json.length;
  check(pendCount >= 3, `oficina ve los dispositivos pendientes restaurados (${pendCount})`);
  const C6 = await loginAs({ username: S.c6.username, password: S.c6.password }, S.c6.dev);
  check(C6.status === 200 && C6.json.scope === 'LIMITED' && C6.json.device.status === 'PENDIENTE_DE_CONFIRMACION', 'un dispositivo PENDIENTE sigue pendiente (alcance limitado)');
  const aud = await http('GET', '/api/v1/audit?limit=500', { token: (await loginAs({ username: S.admin.username, password: S.admin.password, totpSecret: S.admin.totpSecret }, S.admin.device)).json.access_token });
  check(aud.status === 200 && aud.json.some((a) => a.action === 'SESSIONS_REVOKED'), 'el administrador ve en la auditoría la invalidación de sesiones por restauración');

  say(''); say('## Resumen'); say(`- Comprobaciones superadas: **${pass}** · fallidas: **${fail}** · backup ${tb.toFixed(0)} s · restauración ${tr.toFixed(0)} s · snapshot \`${snap}\``);
  writeReport('identidad-restauracion');
  try { rmSync(STATE_FILE); } catch { /* ya no existe */ }
}

// ------------------------------------------------------------------ purga de datos de ejemplo (en una copia desechable)
async function purgeCheck() {
  say(`# Purga de datos de ejemplo · ${TS}`);
  section('1. Antes de la purga');
  const cnt = () => psql(`SELECT (SELECT count(*) FROM transport)||':'||(SELECT count(*) FROM deca)||':'||(SELECT count(*) FROM vehicle)||':'||(SELECT count(*) FROM app_user)||':'||(SELECT count(*) FROM app_user WHERE role='admin')||':'||(SELECT count(*) FROM company)||':'||(SELECT count(*) FROM audit_log)`).split(':').map(Number);
  const [t0, d0, v0, u0, a0, c0, l0] = cnt();
  check(t0 > 0 && d0 > 0 && v0 > 0 && u0 > a0, `hay datos de ejemplo: ${t0} transportes, ${d0} DeCA, ${v0} vehículos, ${u0} usuarios (${a0} administradores)`);
  const docs0 = psql(`SELECT (SELECT count(*) FROM vehicle_asset)||':'||(SELECT count(*) FROM control_document WHERE subject_kind='COMPANY')`).split(':').map(Number);
  check(docs0[0] > 0 && docs0[1] > 0, `hay tarjetas de vehículo (${docs0[0]}) y documentos de empresa (${docs0[1]}) antes de la purga`);
  const files0 = Number(sh('docker compose exec -T api sh -c "find /data/documents -name \'*.pdf\' | wc -l"').trim());
  check(files0 > 0, `el almacén tiene ${files0} PDF`);
  section('2. Seguridad: con el modo de pruebas desactivado no se purga sin permiso expreso');
  psql(`INSERT INTO app_setting (key, value, updated_by) VALUES ('test_mode','0','prueba') ON CONFLICT (key) DO UPDATE SET value='0'`);
  let refused = false, msg = ''; try { sh('./deca purge-examples --yes 2>&1'); } catch (e) { refused = true; msg = String(e.stdout || '') + String(e.stderr || ''); }
  check(refused && /RECHAZADO/.test(msg) && cnt().join() === [t0, d0, v0, u0, a0, c0, l0].join(), 'con el modo de pruebas desactivado la purga se niega y no borra nada');
  psql(`DELETE FROM app_setting WHERE key='test_mode'`);
  section('3. Purga');
  const out = sh('./deca purge-examples --yes 2>&1');
  check(/"files_removed"/.test(out), 'la purga se ejecuta (con copia de seguridad previa)');
  const [t1, d1, v1, u1, a1, c1, l1] = cnt();
  check(t1 === 0 && d1 === 0 && v1 === 0, 'no queda ningún transporte, DeCA ni vehículo');
  check(u1 === a1 && a1 === a0 && c1 === c0, `solo quedan los administradores (${a1}) y la empresa se conserva`);
  check(psql(`SELECT (SELECT count(*) FROM vehicle_asset)||':'||(SELECT count(*) FROM control_document WHERE subject_kind='VEHICLE' OR user_id IS NOT NULL AND user_id NOT IN (SELECT id FROM app_user))||':'||(SELECT count(*) FROM control_document WHERE subject_kind='COMPANY')||':'||(SELECT count(*) FROM driver_profile)||':'||(SELECT count(*) FROM party)||':'||(SELECT count(*) FROM party_site)`) === `0:0:${docs0[1]}:0:0:0`, 'la purga borra las tarjetas, las fichas y los documentos de vehículos y conductores eliminados, y conserva los de la empresa');
  check(psql('SELECT (SELECT count(*) FROM deca_version)+(SELECT count(*) FROM external_deca)+(SELECT count(*) FROM transport_driver_assignment)+(SELECT count(*) FROM device WHERE user_id NOT IN (SELECT id FROM app_user))+(SELECT count(*) FROM session WHERE user_id NOT IN (SELECT id FROM app_user))') === '0', 'no quedan filas huérfanas');
  check(Number(sh('docker compose exec -T api sh -c "find /data/documents -name \'*.pdf\' | wc -l"').trim()) === 0, 'se han borrado los PDF del almacén');
  check(l1 === l0 + 1 && psql(`SELECT count(*) FROM audit_log WHERE action='EXAMPLE_DATA_PURGED'`) === '1', 'la auditoría se conserva y recibe una anotación de la purga');
  const v = sh('./deca verify'); const vj = JSON.parse(v.slice(v.indexOf('{')));
  check(vj.problems.length === 0 && vj.audit_chain_ok && vj.decas === 0, 'verify: sin problemas y la cadena de auditoría sigue íntegra');
  section('4. El sistema sigue funcionando tras la purga');
  const o = sh(`./deca create-user --username adm3-${sfx} --name "Administrador nuevo" --role admin`);
  const adm = { username: `adm3-${sfx}`, code: JSON.parse(o.slice(o.indexOf('{'))).activation_code }; keep(adm.code); adm.password = PW();
  const ac = await activate(adm, adm.password, 'pc'); await enrollTotp(adm, ac.json.access_token);
  const vv = await http('POST', '/api/v1/vehicles', { token: ac.json.access_token, body: { plate: `N${sfx.toUpperCase()}1`, kind: 'TRACTORA' } });
  const tt = vv.status === 201 ? await http('POST', '/api/v1/transports', { token: ac.json.access_token, body: { shipper_name: 'CARGADOR NUEVO S.A.', shipper_nif: 'A12345678', shipper_address: 'Calle Nueva 1, Almería', origin: 'Almacén nuevo, Almería', destination: 'Destino nuevo, Roquetas', transport_date: new Date().toISOString().slice(0, 10), cargo: 'Hortalizas', weight_kg: 1000, tractor_id: vv.json.id } }) : { status: 0 };
  check(vv.status === 201 && tt.status === 201 && tt.json.deca_id, 'un administrador nuevo puede crear un vehículo y un transporte con su DeCA tras la purga');
  const v2 = sh('./deca verify'); const vj2 = JSON.parse(v2.slice(v2.indexOf('{')));
  check(vj2.problems.length === 0 && vj2.decas === 1 && vj2.documents_verified === 1, 'verify tras crear datos nuevos: 1 DeCA y su PDF correctos');
  say(''); say('## Resumen'); say(`- Comprobaciones superadas: **${pass}** · fallidas: **${fail}**`);
  writeReport('identidad-purga');
}

const mode = process.argv[2];
(mode === 'restore-check' ? restoreCheck() : mode === 'purge-check' ? purgeCheck() : mode === 'run' ? run() : Promise.reject(new Error('uso: run | restore-check')))
  .then(() => process.exit(fail ? 1 : 0)).catch((e) => { console.error('ERROR en la prueba:', e); process.exit(2); });
