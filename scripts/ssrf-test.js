// DECARGO · pruebas del descargador anti-SSRF (se ejecuta DENTRO de la imagen del servidor: node /t/ssrf-test.js).
// Servidores TLS locales con certificado propio + política real de direcciones. Imprime Markdown y sale con 1 si algo falla.
const https = require('https'), fs = require('fs'), net = require('net');
const { SafeFetcher, FetchError, looksLikePdf } = require('/app/dist/external/fetcher.js');
const { isPublicAddress, parseSafeUrl } = require('/app/dist/external/netpolicy.js');

let pass = 0, fail = 0;
const out = (s) => console.log(s);
const ok = (m) => { pass++; out(`- ✅ ${m}`); };
const bad = (m) => { fail++; out(`- ❌ ${m}`); };
const info = (m) => out(`- ℹ️ ${m}`);
const check = (c, m, d = '') => (c ? ok(m) : bad(`${m}${d ? ' → ' + d : ''}`));
const sec = (t) => out(`\n## ${t}`);

const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\n'), Buffer.alloc(300, 0x20), Buffer.from('\ntrailer<<>>\n%%EOF\n')]);
const cert = fs.readFileSync('/f/cert.pem'), key = fs.readFileSync('/f/key.pem');
let lastReq = null, inflight = 0, maxInflight = 0;

const server = https.createServer({ cert, key }, (req, res) => {
  lastReq = { headers: req.headers, url: req.url, method: req.method };
  const u = req.url;
  const redir = (loc) => { res.writeHead(302, { location: loc }); res.end(); };
  if (u === '/ok.pdf') { res.writeHead(200, { 'content-type': 'application/pdf' }); return res.end(PDF); }
  if (u === '/ct-html.pdf') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(PDF); }
  if (u === '/redir-ok') return redir('/ok.pdf');
  if (u === '/redir-http') return redir('http://pdf.test/ok.pdf');
  if (u === '/redir-loop') return redir('/redir-loop');
  if (u === '/redir-private') return redir('https://private.test/x.pdf');
  if (u === '/redir-meta') return redir('https://meta.test/latest/meta-data');
  if (u === '/redir-loopback2') return redir('https://loop2.test/x.pdf');
  if (u === '/redir-v6') return redir('https://v6loop.test/x.pdf');
  if (u === '/redir-mapped') return redir('https://mapped.test/x.pdf');
  if (u === '/redir-iplit') return redir('https://169.254.169.254/latest');
  if (u === '/redir-port') return redir('https://pdf.test:8443/ok.pdf');
  if (u === '/redir-userinfo') return redir('https://user:pass@pdf.test/ok.pdf');
  if (u === '/redir-nolocation') { res.writeHead(302); return res.end(); }
  if (u === '/html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<html>hola</html>'); }
  if (u === '/trunc') { res.writeHead(200); return res.end(Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(500, 0x20)])); }
  if (u === '/tiny') { res.writeHead(200); return res.end('%PDF-1.4 %%EOF'); }
  if (u === '/404') { res.writeHead(404); return res.end('no'); }
  if (u === '/500') { res.writeHead(500); return res.end('no'); }
  if (u === '/gz') { res.writeHead(200, { 'content-encoding': 'gzip' }); return res.end(PDF); }
  if (u === '/biglen') { res.writeHead(200, { 'content-length': 10_000_000 }); res.write(Buffer.alloc(1000)); return; }
  if (u === '/big') { res.writeHead(200); const t = setInterval(() => { if (!res.write(Buffer.alloc(65536, 0x20))) { /* contrapresión */ } }, 1); res.on('close', () => clearInterval(t)); return; }
  if (u === '/hang') return;
  if (u === '/slow') { res.writeHead(200); const t = setInterval(() => res.write(' '), 300); res.on('close', () => clearInterval(t)); return; }
  if (u === '/conc') { inflight++; maxInflight = Math.max(maxInflight, inflight); setTimeout(() => { inflight--; res.writeHead(200); res.end(PDF); }, 800); return; }
  res.writeHead(404); res.end();
});

const MAP = { 'pdf.test': ['127.0.0.1'], 'rebind.test': ['127.0.0.1'], 'wrongname.test': ['127.0.0.1'], 'private.test': ['10.0.0.9'], 'meta.test': ['169.254.169.254'],
  'loop2.test': ['127.0.0.2'], 'v6loop.test': ['::1'], 'mapped.test': ['::ffff:127.0.0.1'], 'mixed.test': ['93.184.216.34', '10.0.0.9'], 'cgnat.test': ['100.64.0.1'], 'nat64.test': ['64:ff9b::7f00:1'] };
const resolve = async (h) => { if (!MAP[h]) { const e = new Error('ENOTFOUND'); throw e; } return MAP[h]; };
// Solo para la PRUEBA: 127.0.0.1 (el servidor de prueba) se considera alcanzable; todo lo demás pasa por la política REAL.
const allow = (ip) => ip === '127.0.0.1' || isPublicAddress(ip);

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const mk = (o = {}) => new SafeFetcher({ resolve, isAllowedAddress: allow, port, tls: { ca: cert }, ...o });
  const run = async (fetcher, url) => { try { const r = await fetcher.fetchPdf(url); return { ok: true, r }; } catch (e) { return { ok: false, o: e.outcome || 'ERROR:' + e.message, d: e.detail }; } };
  const expect = async (name, fetcher, url, outcome) => { const x = await run(fetcher, url); check(!x.ok && x.o === outcome, name, x.ok ? 'se ha descargado' : x.o); };

  sec('1. Validación de la URL (antes de cualquier conexión)');
  const bads = ['http://pdf.test/a.pdf', 'ftp://pdf.test/a.pdf', 'file:///etc/passwd', 'javascript:alert(1)', '//pdf.test/a.pdf', 'https://user:pass@pdf.test/a.pdf', 'https://pdf.test:8443/a.pdf', 'https://pdf.test:22/a.pdf',
    'https://127.0.0.1/a.pdf', 'https://[::1]/a.pdf', 'https://2130706433/a.pdf', 'https://0x7f000001/a.pdf', 'https://0177.0.0.1/a.pdf', 'https://127.1/a.pdf', 'https://169.254.169.254/latest/meta-data',
    'https://[::ffff:127.0.0.1]/a.pdf', 'https://localhost/a.pdf', 'https://foo.localhost/a.pdf', 'https://servicio.local/a.pdf', 'https://metadata.google.internal/a', 'https://db/a.pdf', 'https://intranet/a.pdf',
    'https://pdf.test/a.pdf\r\nHost: evil', 'https://pdf.test/a b.pdf', 'https://pdf.test\\@evil.com/', 'https://' + 'a'.repeat(300) + '.com/', 'https://pdf.test/' + 'a'.repeat(2100), '', 'no es una url', 'https://', 'https://.com/a', 'https://a..com/x', 'https://-a.com/x', 'https://a-.com/x', 'https://exa_mple.com/x', 'https://example.123/x', 'https://example.c/x'];
  let allBlocked = true;
  for (const b of bads) { let blocked = false; try { parseSafeUrl(b); } catch { blocked = true; } if (!blocked) { allBlocked = false; bad(`URL aceptada y NO debería: ${b.slice(0, 60)}`); } }
  check(allBlocked, `${bads.length} URL hostiles o mal formadas rechazadas (http, esquemas raros, credenciales, puertos, IP literal en todas sus formas, hosts locales, CRLF, longitud)`);
  const goods = ['https://example.com/a.pdf', 'https://www.cargador.es/descarga?id=abc123&t=xyz', 'https://xn--bcher-kva.example/a.pdf', 'https://a.b.c.example.org:443/x/y.pdf?z=1#frag'];
  check(goods.every((g) => { try { parseSafeUrl(g); return true; } catch { return false; } }), `${goods.length} URL legítimas aceptadas (https, nombre, puerto 443 explícito, punycode, query)`);

  sec('2. Política de direcciones IP');
  const priv = ['127.0.0.1', '127.255.255.254', '10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.255', '192.168.0.1', '192.168.1.130', '169.254.169.254', '169.254.0.1', '100.64.0.1', '100.127.255.255', '0.0.0.0', '0.1.2.3', '224.0.0.1', '239.255.255.255', '240.0.0.1', '255.255.255.255', '198.18.0.1', '192.0.2.1', '198.51.100.1', '203.0.113.1',
    '::', '::1', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:169.254.169.254', '::ffff:8.8.8.8', '::ffff:808:808', '0:0:0:0:0:ffff:7f00:1', '::7f00:1', '::10.0.0.1', '64:ff9b::7f00:1', '64:ff9b::808:808', '2002:7f00:1::', '2002:a00:1::', '2001:db8::1', '2001:0:4136:e378:8000:63bf:3fff:fdd2', 'fec0::1', 'no-es-una-ip', ''];
  const wrongPriv = priv.filter((a) => isPublicAddress(a));
  check(wrongPriv.length === 0, `${priv.length} direcciones privadas, locales, reservadas, de metadatos, IPv4 mapeadas, NAT64, 6to4 y Teredo: TODAS bloqueadas`, wrongPriv.join(' '));
  const pub = ['8.8.8.8', '1.1.1.1', '93.184.216.34', '151.101.1.69', '172.15.255.255', '172.32.0.1', '100.63.255.255', '100.128.0.1', '192.167.255.255', '169.253.255.255', '2606:4700:4700::1111', '2001:4860:4860::8888', '2a00:1450:4001::200e'];
  const wrongPub = pub.filter((a) => !isPublicAddress(a));
  check(wrongPub.length === 0, `${pub.length} direcciones públicas legítimas (incluidos los bordes de los rangos privados) permitidas`, wrongPub.join(' '));

  sec('3. DNS: nombres que resuelven a direcciones internas');
  const f = mk();
  await expect('nombre que resuelve a 10.0.0.9 (privada)', f, 'https://private.test/x.pdf', 'BLOCKED_ADDRESS');
  await expect('nombre que resuelve a 169.254.169.254 (metadatos de nube)', f, 'https://meta.test/x.pdf', 'BLOCKED_ADDRESS');
  await expect('nombre que resuelve a 127.0.0.2 (loopback)', f, 'https://loop2.test/x.pdf', 'BLOCKED_ADDRESS');
  await expect('nombre que resuelve a ::1', f, 'https://v6loop.test/x.pdf', 'BLOCKED_ADDRESS');
  await expect('nombre que resuelve a ::ffff:127.0.0.1 (IPv4 mapeada)', f, 'https://mapped.test/x.pdf', 'BLOCKED_ADDRESS');
  await expect('nombre que resuelve a 100.64.0.1 (CGNAT)', f, 'https://cgnat.test/x.pdf', 'BLOCKED_ADDRESS');
  await expect('nombre que resuelve a 64:ff9b::7f00:1 (NAT64 hacia 127.0.0.1)', f, 'https://nat64.test/x.pdf', 'BLOCKED_ADDRESS');
  await expect('respuesta DNS MIXTA (una pública y una privada): se rechaza entera', f, 'https://mixed.test/x.pdf', 'BLOCKED_ADDRESS');
  await expect('nombre inexistente', f, 'https://no-existe.test/x.pdf', 'DNS_ERROR');

  sec('4. Anti-rebinding: se conecta a la IP ya validada');
  let calls = 0; const counting = async (h) => { calls++; return resolve(h); };
  const r1 = await run(mk({ resolve: counting }), `https://pdf.test/ok.pdf`);
  check(r1.ok && calls === 1, `una sola resolución DNS por salto (${calls}) y la conexión va a la IP validada: 'pdf.test' no existe en el DNS del sistema, así que si se resolviera otra vez fallaría`);
  let n = 0; const flip = async (h) => (++n === 1 ? ['127.0.0.1'] : ['10.0.0.9']);
  const r2 = await run(mk({ resolve: flip }), `https://pdf.test/redir-ok`);
  check(!r2.ok && r2.o === 'BLOCKED_ADDRESS' && n === 2, 'DNS que «cambia» tras la primera consulta (127.0.0.1 → 10.0.0.9): cada salto repite la resolución y la validación, y el 2.º salto se BLOQUEA', r2.ok ? 'descargado' : `${r2.o}, consultas: ${n}`);

  sec('5. Redirecciones');
  const fr = mk();
  const rr = await run(fr, 'https://pdf.test/redir-ok'); check(rr.ok && rr.r.redirects === 1, 'redirección legítima relativa (1 salto) → se sigue');
  await expect('redirección a http://', fr, 'https://pdf.test/redir-http', 'REDIRECT_INVALID');
  await expect('bucle de redirecciones (límite 3)', fr, 'https://pdf.test/redir-loop', 'TOO_MANY_REDIRECTS');
  await expect('redirección a un nombre que resuelve a 10.0.0.9', fr, 'https://pdf.test/redir-private', 'BLOCKED_ADDRESS');
  await expect('redirección a metadatos de nube (nombre → 169.254.169.254)', fr, 'https://pdf.test/redir-meta', 'BLOCKED_ADDRESS');
  await expect('redirección a loopback 127.0.0.2', fr, 'https://pdf.test/redir-loopback2', 'BLOCKED_ADDRESS');
  await expect('redirección a ::1', fr, 'https://pdf.test/redir-v6', 'BLOCKED_ADDRESS');
  await expect('redirección a IPv4 mapeada', fr, 'https://pdf.test/redir-mapped', 'BLOCKED_ADDRESS');
  await expect('redirección a una IP literal (169.254.169.254)', fr, 'https://pdf.test/redir-iplit', 'REDIRECT_INVALID');
  await expect('redirección a otro puerto', fr, 'https://pdf.test/redir-port', 'REDIRECT_INVALID');
  await expect('redirección con credenciales en la URL', fr, 'https://pdf.test/redir-userinfo', 'REDIRECT_INVALID');
  await expect('redirección sin cabecera Location', fr, 'https://pdf.test/redir-nolocation', 'REDIRECT_INVALID');

  sec('6. TLS');
  await expect('certificado NO confiable (autofirmado, sin la CA de la prueba)', new SafeFetcher({ resolve, isAllowedAddress: allow, port }), 'https://pdf.test/ok.pdf', 'TLS_ERROR');
  await expect('certificado válido para otro nombre (wrongname.test)', fr, 'https://wrongname.test/ok.pdf', 'TLS_ERROR');

  sec('7. Tiempo, tamaño y contenido');
  await expect('servidor que no responde (plazo total acotado)', mk({ overallTimeoutMs: 1500, idleTimeoutMs: 1200 }), 'https://pdf.test/hang', 'TIMEOUT');
  const t0 = Date.now();
  await expect('goteo lento: 1 byte cada 300 ms (el plazo total corta)', mk({ overallTimeoutMs: 1500, idleTimeoutMs: 5000 }), 'https://pdf.test/slow', 'TIMEOUT');
  check(Date.now() - t0 < 4000, `el goteo se corta en ${Date.now() - t0} ms (no se espera indefinidamente)`);
  await expect('Content-Length de 10 MB: se rechaza sin descargar', fr, 'https://pdf.test/biglen', 'TOO_LARGE');
  const t1 = Date.now();
  await expect('flujo sin Content-Length que supera 5 MB: se corta al pasar el límite', fr, 'https://pdf.test/big', 'TOO_LARGE');
  check(Date.now() - t1 < 8000, `se corta en ${Date.now() - t1} ms`);
  await expect('Content-Encoding: gzip (posible bomba de descompresión)', fr, 'https://pdf.test/gz', 'ENCODED');
  await expect('HTML en lugar de PDF', fr, 'https://pdf.test/html', 'NOT_PDF');
  await expect('PDF truncado (cabecera sin %%EOF)', fr, 'https://pdf.test/trunc', 'NOT_PDF');
  await expect('fichero diminuto con cabecera de PDF', fr, 'https://pdf.test/tiny', 'NOT_PDF');
  await expect('HTTP 404', fr, 'https://pdf.test/404', 'HTTP_ERROR');
  await expect('HTTP 500', fr, 'https://pdf.test/500', 'HTTP_ERROR');
  const okr = await run(fr, 'https://pdf.test/ok.pdf');
  check(okr.ok && okr.r.body.equals(PDF) && okr.r.sha256 === require('crypto').createHash('sha256').update(PDF).digest('hex') && okr.r.httpStatus === 200, 'PDF correcto: contenido íntegro y SHA-256 calculado');
  const ct = await run(fr, 'https://pdf.test/ct-html.pdf');
  check(ct.ok && ct.r.contentType === 'text/html', 'no se confía en Content-Type: un PDF real servido como text/html se acepta, y se registra el tipo declarado');
  check(!looksLikePdf(Buffer.from('%PDF-1.4 hola')) && looksLikePdf(PDF), 'looksLikePdf: exige cabecera, tamaño mínimo y %%EOF');

  sec('8. Cabeceras enviadas y concurrencia');
  await run(fr, 'https://pdf.test/ok.pdf');
  const h = lastReq.headers;
  check(!h.cookie && !h.authorization && !h.referer && !h.origin, 'la petición no lleva Cookie, Authorization, Referer ni Origin');
  check(h['accept-encoding'] === 'identity' && h.connection === 'close' && lastReq.method === 'GET' && /DECARGO/.test(h['user-agent']), 'GET, sin compresión, conexión no persistente, User-Agent propio');
  check(h.host === 'pdf.test' || h.host.startsWith('pdf.test'), 'la cabecera Host es el nombre (no la IP): el servidor virtual correcto y el certificado se validan contra el nombre', h.host);
  const cf = mk({ concurrency: 2 });
  const res = await Promise.all([1, 2, 3, 4, 5].map(() => run(cf, 'https://pdf.test/conc')));
  const okN = res.filter((x) => x.ok).length, busyN = res.filter((x) => !x.ok && x.o === 'BUSY').length;
  check(okN === 2 && busyN === 3 && maxInflight <= 2, `concurrencia limitada: 5 simultáneas → ${okN} atendidas y ${busyN} rechazadas (BUSY, sin cola); máximo en vuelo en el servidor: ${maxInflight}`);

  sec('9. Política REAL contra Internet (sin inyecciones de prueba)');
  const strict = new SafeFetcher();
  for (const u of ['https://127.0.0.1/', 'https://localhost/', 'https://169.254.169.254/latest/meta-data', 'https://metadata.google.internal/', 'https://db/', 'https://[::1]/', 'http://example.com/a.pdf']) {
    const x = await run(strict, u); check(!x.ok && x.o === 'URL_INVALID', `política real: ${u} → rechazada sin conectar`, x.ok ? 'descargado' : x.o);
  }
  for (const u of ['https://localtest.me/a.pdf', 'https://127.0.0.1.nip.io/a.pdf', 'https://spoofed.burpcollaborator.net/a.pdf']) {
    const x = await run(strict, u);
    if (!x.ok && x.o === 'BLOCKED_ADDRESS') ok(`política real: ${u} (nombre PÚBLICO que resuelve a una IP interna) → BLOCKED_ADDRESS`);
    else if (!x.ok && x.o === 'DNS_ERROR') info(`${u}: sin resolución DNS desde este entorno (prueba no concluyente)`);
    else bad(`política real: ${u} → ${x.ok ? 'DESCARGADO' : x.o}`);
  }
  const real = await run(strict, 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf');
  if (real.ok) ok(`descarga REAL de un PDF público por HTTPS con la política estricta: ${real.r.body.length} bytes, IP ${real.r.remoteIp}, sha256 ${real.r.sha256.slice(0, 12)}…`);
  else info(`descarga real no concluyente (${real.o}): sin salida a Internet desde este entorno`);

  out(`\n## Resumen\n- Comprobaciones superadas: **${pass}** · fallidas: **${fail}**`);
  server.close(); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR en la prueba:', e); process.exit(2); });
