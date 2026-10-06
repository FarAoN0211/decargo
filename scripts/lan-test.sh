#!/bin/bash
# DECARGO · comprobación NO destructiva de la publicación en red local. No crea datos ni toca volúmenes.
# Se ejecuta EN la máquina que corre Docker (la .130). Comprueba que api y docs solo escuchan donde deben.
set -uo pipefail
cd "$(dirname "$0")/.."
PROJ=$(docker compose config --format json | python3 -c 'import sys,json;print(json.load(sys.stdin)["name"])')   # nombre del proyecto de compose (nunca escrito a mano)
set -a; . ./.env; set +a
BIND_API="${API_BIND:-127.0.0.1}"; BIND_DOCS="${DOCS_BIND:-127.0.0.1}"; BIND_WEB="${WEB_BIND:-127.0.0.1}"; WEB_PORT="${WEB_PORT:-18082}"
TS=$(date -u +%Y%m%dT%H%M%SZ); REPORT="informes/lan-$TS.md"; : > "$REPORT.tmp"; PASS=0; FAIL=0
say(){ echo "$*" | tee -a "$REPORT.tmp"; }; ok(){ PASS=$((PASS+1)); say "- ✅ $1"; }; bad(){ FAIL=$((FAIL+1)); say "- ❌ $1"; }
say "# Publicación en red local · $TS"; say ""; say "api: \`$BIND_API:$API_PORT\` · docs: \`$BIND_DOCS:$DOCS_PORT\` · web: \`$BIND_WEB:$WEB_PORT\` · URL base de los QR: \`$PUBLIC_DOCS_BASE_URL\`"; say ""
code(){ curl -s -m 4 -o /dev/null -w '%{http_code}' "$1" 2>/dev/null; }

say "## Dónde escucha"
LISTEN=$(ss -ltn | awk '{print $4}' | grep -E ":(${API_PORT}|${DOCS_PORT}|${WEB_PORT})$")
[ "$(grep -c . <<<"$LISTEN")" = 3 ] && ok "los tres puertos (api, docs, web) están publicados: $(tr '\n' ' ' <<<"$LISTEN")" || bad "puertos publicados: $LISTEN"
grep -qE '^(0\.0\.0\.0|\*|\[::\]):' <<<"$LISTEN" && bad "algún puerto escucha en TODAS las interfaces" || ok "ninguno escucha en todas las interfaces (0.0.0.0 / ::)"
grep -qx "${BIND_API}:${API_PORT}" <<<"$LISTEN" && grep -qx "${BIND_DOCS}:${DOCS_PORT}" <<<"$LISTEN" && grep -qx "${BIND_WEB}:${WEB_PORT}" <<<"$LISTEN" && ok "coinciden con API_BIND, DOCS_BIND y WEB_BIND del .env" || bad "no coinciden con el .env"
# La dirección que mandan los DeCA nuevos es la fijada en Configuración (base de datos) o, si no, PUBLIC_DOCS_BASE_URL.
EFF=$(docker compose exec -T api node dist/cli.js public-url 2>/dev/null | python3 -c 'import sys,json; print(json.load(sys.stdin)["public_base_url"])' 2>/dev/null)
if [[ "$EFF" == https://* ]]; then ok "la dirección pública de los QR es https (${EFF}); no es una IP local"
elif [[ "$EFF" == "http://${BIND_DOCS}:${DOCS_PORT}" ]]; then ok "la URL base de los QR apunta a la misma dirección publicada (solo pruebas locales)"
else bad "la dirección pública de los QR (${EFF:-desconocida}) no es https ni coincide con DOCS_BIND:DOCS_PORT"; fi
case "$EFF" in *192.168.*|*10.*.*.*|*127.0.0.1*|*localhost*) [[ "$EFF" == https://* ]] && bad "la dirección pública contiene una IP local: un agente externo no podrá abrirla" ;; esac

say ""; say "## Se alcanza por la dirección publicada y por ninguna otra"
[ "$(code http://${BIND_API}:${API_PORT}/healthz)" = 200 ] && ok "api responde en $BIND_API:$API_PORT" || bad "api no responde en $BIND_API:$API_PORT"
RND=$(python3 -c 'import secrets;print(secrets.token_urlsafe(32))')
[ "$(code http://${BIND_DOCS}:${DOCS_PORT}/d/$RND)" = 404 ] && ok "docs responde en $BIND_DOCS:$DOCS_PORT (token inexistente → 404 uniforme)" || bad "docs no responde como se espera"
[ "$(code http://${BIND_WEB}:${WEB_PORT}/healthz)" = 200 ] && ok "web responde en $BIND_WEB:$WEB_PORT" || bad "web no responde en $BIND_WEB:$WEB_PORT"
[ "$(curl -s -m 4 -o /dev/null -w '%{http_code}' -X POST http://${BIND_WEB}:${WEB_PORT}/api/v1/dev/test-deca)" = 404 ] && ok "la web no expone los endpoints de prueba (404)" || bad "la web expone /api/v1/dev/"
if [ "$BIND_API" != 127.0.0.1 ]; then
  [ "$(code http://127.0.0.1:${API_PORT}/healthz)" = 000 ] && ok "api NO responde por 127.0.0.1" || bad "api responde también por 127.0.0.1"
  [ "$(code http://127.0.0.1:${DOCS_PORT}/d/x)" = 000 ] && ok "docs NO responde por 127.0.0.1" || bad "docs responde también por 127.0.0.1"
  [ "$(code http://127.0.0.1:${WEB_PORT}/healthz)" = 000 ] && ok "web NO responde por 127.0.0.1" || bad "web responde también por 127.0.0.1"
fi
for ip in $(ip -4 -o addr show scope global | awk '{print $4}' | cut -d/ -f1 | grep -v "^${BIND_API}$"); do
  c1=$(code http://$ip:${API_PORT}/healthz); c2=$(code http://$ip:${DOCS_PORT}/d/x); c3=$(code http://$ip:${WEB_PORT}/healthz)
  [ "$c1" = 000 ] && [ "$c2" = 000 ] && [ "$c3" = 000 ] && ok "no responde por $ip (otra interfaz de esta máquina)" || bad "responde por $ip ($c1/$c2/$c3)"
done
say "- ℹ️ no se comprueba desde otro equipo: hay que hacerlo manualmente (p. ej. curl desde otro dispositivo de la red)"

say ""; say "## Aislamiento"
R=$(docker exec ${PROJ}-docs-1 node -e 'fetch("https://registry.npmjs.org/",{signal:AbortSignal.timeout(4000)}).then(r=>console.log("SALIDA:"+r.status)).catch(e=>console.log("BLOQUEADA"))' 2>&1)
[ "$R" = BLOQUEADA ] && ok "docs sigue sin salida a Internet" || bad "docs tiene salida: $R"
docker compose ps --format '{{.Service}} {{.Health}}' | awk '$1!="migrate"' | grep -qv healthy && bad "algún servicio no está healthy" || ok "db, api, docs y web healthy"
V=$(docker compose exec -T api node dist/cli.js verify 2>&1)
python3 -c 'import sys,json; d=json.loads(sys.argv[1]); sys.exit(0 if not d["problems"] and d["audit_chain_ok"] else 1)' "$V" 2>/dev/null && ok "verify: sin problemas (documentos, tokens, TOTP, externos y cadena de auditoría)" || bad "verify con problemas"
[ "$DEV_ENDPOINTS" = 1 ] && say "- ⚠️ DEV_ENDPOINTS=1: el endpoint /api/v1/dev/test-deca está activo (protegido por DEV_API_KEY). Solo para pruebas; apágalo para uso real."
[ "${ALLOW_INSECURE_PUBLIC_URL:-0}" = 1 ] && say "- ⚠️ HTTP sin cifrar: contraseñas, códigos y tokens viajan en claro por la red local. Solo para pruebas en una red de confianza. La Resolución exige https para el QR real."
say ""; say "## Resumen"; say "- Superadas: **$PASS** · fallidas: **$FAIL**"
cat "$REPORT.tmp" > "$REPORT"; rm -f "$REPORT.tmp"; echo "Informe: $REPORT"; [ "$FAIL" = 0 ]
