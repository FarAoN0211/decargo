#!/bin/bash
# DECARGO · prueba de restauración en ENTORNO LIMPIO (simula un servidor nuevo).
#   Parte de un sistema con datos → backup → "servidor nuevo": sin volúmenes de datos, sin imágenes de DECARGO y con un
#   .env NUEVO (secretos aleatorios distintos); el administrador solo aporta RESTIC_PASSWORD (guardada fuera del servidor).
#   → ./deca restore → verificaciones. Se conserva el volumen de backups, como ocurriría al conectar el repositorio.
set -uo pipefail
cd "$(dirname "$0")/.."
PROJ=$(docker compose config --format json | python3 -c 'import sys,json;print(json.load(sys.stdin)["name"])')   # nombre del proyecto de compose (nunca escrito a mano)
DC="docker compose"
TS=$(date -u +%Y%m%dT%H%M%SZ)
REPORT="informes/restauracion-limpia-$TS.md"
WORK=$(mktemp -d "$PWD/informes/.work-XXXX"); trap 'rm -rf "$WORK"' EXIT
PASS=0; FAIL=0; : > "$REPORT.tmp"
say(){ echo "$*" | tee -a "$REPORT.tmp"; }
ok(){ PASS=$((PASS+1)); say "- ✅ $1"; }
bad(){ FAIL=$((FAIL+1)); say "- ❌ $1"; }
expect(){ local d="$1" pat="$2"; shift 2; local out; out=$("$@" 2>&1); if grep -q -- "$pat" <<<"$out"; then ok "$d"; else bad "$d (salida: ${out:0:90})"; fi; }
now(){ date +%s; }
sha(){ sha256sum "$1" | cut -d' ' -f1; }
tools(){ docker run --rm -u "$(id -u):$(id -g)" -v "$WORK":/w decargo-tools:dev "$@"; }
envget(){ grep "^$2=" "$1" | cut -d= -f2-; }
hashof(){ printf '%s' "$1" | sha256sum | cut -c1-12; }

set -a; . ./.env; set +a
say "# Restauración en entorno limpio · $TS"; say ""
say "## 1. Estado de partida"
$DC up -d --wait >/dev/null 2>&1
RESP=$(curl -s -X POST -H "Authorization: Bearer $DEV_API_KEY" "http://${API_BIND:-127.0.0.1}:${API_PORT}/api/v1/dev/test-deca")
URL=$(python3 -c 'import sys,json;print(json.loads(sys.argv[1])["url"])' "$RESP" 2>/dev/null)
[ -n "$URL" ] && ok "DeCA de prueba generado antes del backup" || { bad "no se pudo generar el DeCA: $RESP"; exit 1; }
# El límite de peticiones de docs puede estar agotado por una prueba anterior: se espera a que se libere.
for i in $(seq 1 14); do C=$(curl -s -o "$WORK/a.pdf" -w '%{http_code}' "$URL"); [ "$C" = 200 ] && break; sleep 5; done
[ "$C" = 200 ] && ok "descarga de referencia del DeCA original (HTTP 200)" || bad "no se pudo descargar el DeCA de referencia ($C)"
H0=$(sha "$WORK/a.pdf")
./deca verify > "$WORK/v0.json" 2>&1 && ok "verify previo correcto" || bad "verify previo con problemas"
N0=$(python3 -c 'import json;d=json.load(open("'$WORK'/v0.json"));print(d["decas"],d["versions"],d["documents_verified"])')
A0=$(python3 -c 'import json;print(json.load(open("'$WORK'/v0.json"))["audit_rows"])')
say "- datos de partida (DeCA, versiones, documentos): $N0 · filas de auditoría: $A0"
KEYHASH0=$(hashof "$(envget .env APP_KEY)"); DBPW0=$(hashof "$(envget .env DB_API_PASSWORD)"); RESTIC0=$(envget .env RESTIC_PASSWORD)

say ""; say "## 2. Backup"
./deca backup > "$WORK/b.out" 2>&1 && ok "backup correcto" || bad "backup fallido"
SNAP=$(./deca snapshots 2>/dev/null | grep -E '^[0-9a-f]{8} ' | tail -1 | cut -d' ' -f1)
say "- snapshot utilizado: \`$SNAP\`"; grep created_utc "$WORK/b.out" | tail -1 | sed 's/^/- manifiesto: `/; s/$/`/' | tee -a "$REPORT.tmp"

say ""; say "## 3. Simular servidor nuevo"
$DC down >/dev/null 2>&1
docker volume rm ${PROJ}_pgdata ${PROJ}_documents >/dev/null 2>&1
docker image rm decargo-server:${DECARGO_VERSION} decargo-backup:${DECARGO_VERSION} >/dev/null 2>&1
mv .env .env.old-test
./deca init >/dev/null 2>&1
sed -i "s/^RESTIC_PASSWORD=.*/RESTIC_PASSWORD=$RESTIC0/" .env
# Ajustes de ENTORNO (no secretos) que el administrador de un servidor nuevo vuelve a poner: direcciones, puertos y URL base.
for k in DECARGO_VERSION PUBLIC_DOCS_BASE_URL ALLOW_INSECURE_PUBLIC_URL API_PORT DOCS_PORT WEB_PORT API_BIND DOCS_BIND WEB_BIND DEV_ENDPOINTS DECA_TEST_MODE; do
  v=$(grep "^$k=" .env.old-test | cut -d= -f2-); [ -n "$v" ] && { grep -q "^$k=" .env && sed -i "s#^$k=.*#$k=$v#" .env || echo "$k=$v" >> .env; }
done
[ ! -e /var/lib/docker/volumes/${PROJ}_pgdata ] && ok "sin volúmenes de datos" || true
docker volume inspect ${PROJ}_pgdata >/dev/null 2>&1 && bad "queda volumen de BD" || ok "sin volumen de base de datos ni de documentos"
docker image inspect decargo-server:${DECARGO_VERSION} >/dev/null 2>&1 && bad "queda la imagen del servidor" || ok "sin imágenes de DECARGO (se reconstruirán)"
[ "$(hashof "$(envget .env DB_API_PASSWORD)")" != "$DBPW0" ] && ok ".env nuevo con credenciales de BD distintas a las originales" || bad "el .env nuevo repite credenciales"
[ "$(hashof "$(envget .env APP_KEY)")" != "$KEYHASH0" ] && ok ".env nuevo con APP_KEY distinta (debe recuperarse del backup)" || bad "APP_KEY ya coincide (la prueba no es válida)"
docker volume inspect ${PROJ}_backups >/dev/null 2>&1 && ok "repositorio de backup disponible (volumen conservado)" || bad "falta el repositorio de backup"

say ""; say "## 4. Restaurar"
set -a; . ./.env; set +a
T0=$(now); ./deca restore "$SNAP" > "$WORK/r.out" 2>&1; RC=$?; T1=$(now)
[ $RC = 0 ] && ok "restauración completada en $((T1-T0)) s (incluye reconstrucción de imágenes)" || { bad "la restauración falló"; tail -8 "$WORK/r.out" | sed 's/^/    /' | tee -a "$REPORT.tmp"; }
grep -q "APP_KEY recuperada" "$WORK/r.out" && ok "APP_KEY recuperada automáticamente desde el backup" || bad "no se recuperó APP_KEY"
set -a; . ./.env; set +a
[ "$(hashof "$(envget .env APP_KEY)")" = "$KEYHASH0" ] && ok "APP_KEY idéntica a la original" || bad "APP_KEY distinta"
for s in db api docs web; do st=$($DC ps --format '{{.Service}} {{.Health}}' | awk -v s=$s '$1==s{print $2}'); [ "$st" = healthy ] && ok "servicio $s healthy" || bad "servicio $s: $st"; done

say ""; say "## 5. Verificación"
./deca verify > "$WORK/v1.json" 2>&1 && ok "verify: documentos, hashes, tokens y cadena de auditoría íntegros" || bad "verify con problemas"
N1=$(python3 -c 'import json;d=json.load(open("'$WORK'/v1.json"));print(d["decas"],d["versions"],d["documents_verified"])')
A1=$(python3 -c 'import json;print(json.load(open("'$WORK'/v1.json"))["audit_rows"])')
[ "$N0" = "$N1" ] && ok "mismos DeCA, versiones y documentos que antes del desastre: $N1" || bad "los recuentos difieren: antes $N0, ahora $N1"
[ "$A1" = "$((A0+1))" ] && ok "auditoría conservada ($A0 filas) más 1: la invalidación de sesiones al restaurar" || bad "auditoría: antes $A0, ahora $A1 (se esperaba $((A0+1)))"
python3 - "$WORK/v1.json" <<'PY' | tee -a "$REPORT.tmp"
import json,sys
d=json.load(open(sys.argv[1]))
print("- verify: tokens recuperables=%s de %s DeCA · cadena de auditoría íntegra=%s · problemas=%s"%(d["tokens_recoverable"],d["decas"],d["audit_chain_ok"],d["problems"]))
PY
[ "$(curl -s -o "$WORK/b.pdf" -w '%{http_code}' "$URL")" = 200 ] && ok "el MISMO DeCA responde por su URL local original" || bad "la URL no responde"
[ "$(sha "$WORK/b.pdf")" = "$H0" ] && ok "SHA-256 idéntico al del DeCA original" || bad "hash distinto"
[ "$(tools qrdecode /w/b.pdf)" = "$URL" ] && ok "QR del PDF restaurado == URL" || bad "QR distinto"
expect "deca_docs sin acceso a tablas tras restaurar" 'permission denied' $DC exec -T -e PGPASSWORD="$DB_DOCS_PASSWORD" db psql -h 127.0.0.1 -U deca_docs -d decargo -Atc "SELECT 1 FROM deca LIMIT 1"
expect "auditoría protegida tras restaurar" 'protegida' $DC exec -T db psql -U postgres -d decargo -Atc "DELETE FROM audit_log"
$DC --profile tools run --rm -T backup config "$SNAP" 2>/dev/null | tr -d '\r' > "$WORK/cfg.env"
DIFFS=$(diff <(grep -v '^RESTIC_PASSWORD=' .env.old-test | cut -d= -f1,2 | sort) <(grep -v '^RESTIC_PASSWORD=' .env | cut -d= -f1,2 | sort) | grep '^>' | cut -d= -f1 | sed 's/^> //' | tr '\n' ' ')
say "- verificación de configuración: el .env nuevo difiere del original solo en: **${DIFFS:-nada}** (esperado: credenciales de BD y clave de pruebas, que se regeneran en un servidor nuevo; APP_KEY coincide)"
echo "$DIFFS" | grep -q APP_KEY && bad "APP_KEY difiere" || ok "la configuración restaurada es coherente (APP_KEY recuperada)"
rm -f .env.old-test

say ""; say "## Resumen"; say "- Comprobaciones superadas: **$PASS** · fallidas: **$FAIL** · restauración: $((T1-T0)) s"
cat "$REPORT.tmp" > "$REPORT"; rm -f "$REPORT.tmp"; echo; echo "Informe: $REPORT"
[ "$FAIL" = 0 ]
