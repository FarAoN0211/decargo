#!/bin/bash
# DECARGO · prueba del descargador anti-SSRF. Genera un certificado de PRUEBA y ejecuta la batería dentro de la imagen del servidor.
set -uo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
TS=$(date -u +%Y%m%dT%H%M%SZ); REPORT="informes/ssrf-$TS.md"
F=$(mktemp -d); trap 'rm -rf "$F"' EXIT
SAN="DNS:pdf.test,DNS:rebind.test,DNS:private.test,DNS:meta.test,DNS:loop2.test,DNS:v6loop.test,DNS:mapped.test,DNS:mixed.test,DNS:cgnat.test,DNS:nat64.test"
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$F/key.pem" -out "$F/cert.pem" -days 1 -subj "/CN=pdf.test" -addext "subjectAltName=$SAN" 2>/dev/null
chmod 644 "$F/key.pem"
{ echo "# Descargador anti-SSRF · $TS"; echo; echo "Imagen: decargo-server:${DECARGO_VERSION}"; } > "$REPORT"
docker run --rm -v "$PWD/scripts/ssrf-test.js":/t/ssrf-test.js:ro -v "$F":/f:ro decargo-server:${DECARGO_VERSION} node /t/ssrf-test.js 2>&1 | tee -a "$REPORT"
RC=${PIPESTATUS[0]}
echo; echo "Informe: $REPORT"; exit $RC
