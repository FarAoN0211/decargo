#!/bin/bash
# DECARGO · prueba de la topología de red del servicio `docs` (mínimo privilegio: sin salida general a Internet).
set -uo pipefail
cd "$(dirname "$0")/.."
PROJ=$(docker compose config --format json | python3 -c 'import sys,json;print(json.load(sys.stdin)["name"])')   # nombre del proyecto de compose (nunca escrito a mano)
DC="docker compose"; TS=$(date -u +%Y%m%dT%H%M%SZ); REPORT="informes/docs-red-$TS.md"; : > "$REPORT.tmp"
PASS=0; FAIL=0
say(){ echo "$*" | tee -a "$REPORT.tmp"; }
ok(){ PASS=$((PASS+1)); say "- ✅ $1"; }
bad(){ FAIL=$((FAIL+1)); say "- ❌ $1"; }
info(){ say "- ℹ️ $1"; }
set -a; . ./.env; set +a
NODE_EGRESS='fetch("https://registry.npmjs.org/",{signal:AbortSignal.timeout(5000)}).then(r=>console.log("SALIDA:"+r.status)).catch(e=>console.log("BLOQUEADA:"+((e.cause&&e.cause.code)||e.name)))'
NODE_DNS='require("dns").promises.lookup("registry.npmjs.org").then(r=>console.log("RESUELVE:"+r.address)).catch(e=>console.log("NO RESUELVE:"+e.code))'
tcp(){ echo "const s=require('net').connect({host:'$1',port:$2,timeout:3000});s.on('connect',()=>{console.log('CONECTA');process.exit(0)});s.on('timeout',()=>{console.log('TIMEOUT');process.exit(0)});s.on('error',e=>{console.log('ERROR:'+e.code);process.exit(0)})"; }

say "# Red del servicio docs · $TS"; say ""
say "## 1. Topología"
NETS=$(docker inspect ${PROJ}-docs-1 --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}')
[ "$NETS" = "${PROJ}_back ${PROJ}_edge " ] && ok "docs está solo en ${PROJ}_back (interna) y ${PROJ}_edge (sin NAT de salida)" || bad "redes de docs: $NETS"
[ "$(docker network inspect ${PROJ}_back --format '{{.Internal}}')" = true ] && ok "${PROJ}_back es interna" || bad "${PROJ}_back no es interna"
[ "$(docker network inspect ${PROJ}_edge --format '{{index .Options "com.docker.network.bridge.enable_ip_masquerade"}}')" = false ] && ok "${PROJ}_edge sin enmascaramiento (sin NAT de salida)" || bad "${PROJ}_edge con NAT"

say ""; say "## 2. Funcionamiento de docs"
RESP=$(curl -s -X POST -H "Authorization: Bearer $DEV_API_KEY" "http://${API_BIND:-127.0.0.1}:${API_PORT}/api/v1/dev/test-deca")
URL=$(python3 -c 'import sys,json;print(json.loads(sys.argv[1])["url"])' "$RESP"); SHA=$(python3 -c 'import sys,json;print(json.loads(sys.argv[1])["sha256"])' "$RESP")
curl -s -o /tmp/.docs-net.pdf -w '%{http_code} %{content_type} redirects=%{num_redirects}' "$URL" > /tmp/.docs-net.meta
[ "$(cut -d' ' -f1-2 /tmp/.docs-net.meta)" = "200 application/pdf" ] && ok "descarga documental: $(cat /tmp/.docs-net.meta)" || bad "descarga: $(cat /tmp/.docs-net.meta)"
[ "$(sha256sum /tmp/.docs-net.pdf | cut -d' ' -f1)" = "$SHA" ] && ok "hash del PDF correcto (lee PostgreSQL y el almacén)" || bad "hash distinto"
[ "$($DC ps --format '{{.Service}} {{.Health}}' | awk '$1=="docs"{print $2}')" = healthy ] && ok "healthcheck de docs: healthy (consulta PostgreSQL y lee el almacén)" || bad "docs no healthy"
rm -f /tmp/.docs-net.pdf /tmp/.docs-net.meta

say ""; say "## 3. Ausencia de salida general a Internet"
R=$(docker exec ${PROJ}-docs-1 node -e "$NODE_EGRESS"); [[ "$R" == BLOQUEADA* ]] && ok "docs → https://registry.npmjs.org: $R" || bad "docs tiene salida a Internet: $R"
R=$(docker exec ${PROJ}-docs-1 node -e "$NODE_DNS"); [[ "$R" == "NO RESUELVE"* ]] && ok "docs no resuelve nombres externos (sin canal por DNS): $R" || info "docs RESUELVE nombres externos: $R (canal DNS; ver riesgo residual)"
R=$(docker exec ${PROJ}-docs-1 node -e "$(tcp 1.1.1.1 443)"); [ "$R" != CONECTA ] && ok "docs → 1.1.1.1:443 (IP directa): $R" || bad "docs conecta a 1.1.1.1:443"
R=$(docker exec ${PROJ}-docs-1 node -e "$(tcp db 5432)"); [ "$R" = CONECTA ] && ok "docs → db:5432: $R (necesario)" || bad "docs no llega a PostgreSQL: $R"
R=$(docker exec ${PROJ}-api-1 node -e "$NODE_EGRESS"); info "control: api → registry.npmjs.org: $R (api conserva su red actual; no se ha modificado)"
LAN=$(ip -4 route get 192.168.1.1 2>/dev/null | head -1 | awk '{for(i=1;i<=NF;i++) if($i=="via"||$i=="dev"){print $(i+1);exit}}')
R=$(docker exec ${PROJ}-docs-1 node -e "$(tcp 192.168.1.1 80)"); info "docs → 192.168.1.1:80 (red local): $R"
GW=$(docker inspect ${PROJ}-docs-1 --format "{{(index .NetworkSettings.Networks \"${PROJ}_edge\").Gateway}}")
R=$(docker exec ${PROJ}-docs-1 node -e "$(tcp $GW 80)"); info "docs → puerta de enlace de su red ($GW:80, servicios del host): $R"

say ""; say "## 4. Entrada: proxy externo simulado (sin abrir el puerto a la red local)"
BR=$(docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}')
DOCS_BIND=$BR $DC up -d --no-deps docs >/dev/null 2>&1; sleep 4
R=$(docker run --rm node:22.23.3-bookworm-slim node -e "fetch('http://$BR:${DOCS_PORT}/d/x').then(r=>console.log('RESPONDE:'+r.status)).catch(e=>console.log('ERROR:'+e.cause?.code))")
[ "$R" = "RESPONDE:404" ] && ok "un contenedor ajeno llega a docs por $BR:${DOCS_PORT} (como llegaría un proxy externo): $R" || bad "no llega desde fuera: $R"
URL2=$(echo "$URL" | sed "s#${PUBLIC_DOCS_BASE_URL}#http://$BR:${DOCS_PORT}#")
R=$(docker run --rm node:22.23.3-bookworm-slim node -e "fetch('$URL2').then(async r=>console.log(r.status+' '+r.headers.get('content-type')+' '+(await r.arrayBuffer()).byteLength+'B')).catch(e=>console.log('ERROR'))")
[[ "$R" == 200\ application/pdf* ]] && ok "descarga del PDF desde ese origen: $R" || bad "descarga desde el origen externo: $R"
R=$(docker exec ${PROJ}-docs-1 node -e "$NODE_EGRESS"); [[ "$R" == BLOQUEADA* ]] && ok "con el puerto abierto a ese origen, docs sigue sin salida: $R" || bad "docs con salida: $R"
$DC up -d --no-deps docs >/dev/null 2>&1; sleep 4   # vuelve a su dirección original
ss -ltn | awk '{print $4}' | grep -q "^${BR}:${DOCS_PORT}$" && bad "el puerto sigue abierto en $BR" || ok "restaurado: docs vuelve a publicar solo en ${DOCS_BIND:-127.0.0.1}"

say ""; say "## 5. Rate limit"
sleep 30
RND=$(python3 -c 'import secrets;print(secrets.token_urlsafe(32))')
CODES=$(for i in $(seq 1 650); do curl -s -o /dev/null -w '%{http_code}\n' "http://${DOCS_BIND:-127.0.0.1}:${DOCS_PORT}/d/$RND"; done | sort | uniq -c | tr -s ' ' | tr '\n' ';')
grep -q 429 <<<"$CODES" && ok "límite activo: 650 peticiones → $CODES" || bad "sin límite: $CODES"

say ""; say "## Resumen"; say "- Superadas: **$PASS** · fallidas: **$FAIL**"
cat "$REPORT.tmp" > "$REPORT"; rm -f "$REPORT.tmp"; echo "Informe: $REPORT"; [ "$FAIL" = 0 ]
