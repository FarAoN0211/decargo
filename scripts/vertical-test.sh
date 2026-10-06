#!/bin/bash
# DECARGO · prueba vertical del primer bloque (todo en LOCAL, sin Internet).
#   CREAR DATOS → GENERAR DeCA/PDF/QR/TOKEN → DESCARGA DIRECTA → HASH → RECREAR CONTENEDORES
#   → BACKUP → DESTRUIR DATOS → RESTAURAR → VERIFICAR (BD, documentos, hash, configuración, URL)
# Uso: ./scripts/vertical-test.sh      (destruye los volúmenes de datos de DECARGO tras hacer backup)
set -uo pipefail
cd "$(dirname "$0")/.."
PROJ=$(docker compose config --format json | python3 -c 'import sys,json;print(json.load(sys.stdin)["name"])')   # nombre del proyecto de compose (nunca escrito a mano)
set -a; . ./.env; set +a
DC="docker compose"
TS=$(date -u +%Y%m%dT%H%M%SZ)
REPORT="informes/prueba-vertical-$TS.md"
WORK=$(mktemp -d "$PWD/informes/.work-XXXX")
trap 'rm -rf "$WORK"' EXIT
PASS=0; FAIL=0
: > "$REPORT.tmp"

say()  { echo "$*" | tee -a "$REPORT.tmp"; }
ok()   { PASS=$((PASS+1)); say "- ✅ $1"; }
bad()  { FAIL=$((FAIL+1)); say "- ❌ $1"; }
check(){ local d="$1"; shift; if "$@" >/dev/null 2>&1; then ok "$d"; else bad "$d"; fi; }
# expect "descripción" "patrón" comando...  → captura la salida (evita falsos fallos de pipefail con grep -q)
expect(){ local d="$1" pat="$2"; shift 2; local out; out=$("$@" 2>&1); if grep -q -- "$pat" <<<"$out"; then ok "$d"; else bad "$d (salida: ${out:0:90})"; fi; }
expect_not(){ local d="$1" pat="$2"; shift 2; local out; out=$("$@" 2>&1); if grep -q -- "$pat" <<<"$out"; then bad "$d"; else ok "$d"; fi; }
now()  { date +%s; }
API="http://${API_BIND:-127.0.0.1}:${API_PORT}"
tools() { docker run --rm -u "$(id -u):$(id -g)" -v "$WORK":/w decargo-tools:dev "$@"; }
sha()  { sha256sum "$1" | cut -d' ' -f1; }
psql_as() { # usuario, contraseña, SQL → ejecuta dentro del contenedor db, sin mostrar la contraseña
  $DC exec -T -e PGPASSWORD="$2" db psql -h 127.0.0.1 -U "$1" -d "$POSTGRES_DB" -Atc "$3"; }

say "# Prueba vertical DECARGO · $TS"
say ""
say "Versión: ${DECARGO_VERSION} · imagen servidor: $(docker image inspect decargo-server:${DECARGO_VERSION} --format '{{.Id}}' 2>/dev/null | cut -c1-19)"
say ""
docker image inspect decargo-tools:dev >/dev/null 2>&1 || docker build -q -t decargo-tools:dev deploy/tools >/dev/null

say "## 1. Servicios"
$DC up -d --wait >/dev/null 2>&1
for s in db api docs; do
  st=$($DC ps --format '{{.Service}} {{.Health}}' | awk -v s=$s '$1==s{print $2}')
  [ "$st" = healthy ] && ok "servicio $s healthy" || bad "servicio $s: $st"
done

say ""; say "## 2. Crear datos de prueba y generar el DeCA"
T0=$(now)
RESP=$(curl -s -X POST -H "Authorization: Bearer $DEV_API_KEY" "$API/api/v1/dev/test-deca")
DECA_ID=$(echo "$RESP" | python3 -c 'import sys,json;print(json.load(sys.stdin)["deca_id"])' 2>/dev/null)
URL=$(echo "$RESP" | python3 -c 'import sys,json;print(json.load(sys.stdin)["url"])' 2>/dev/null)
DB_SHA=$(echo "$RESP" | python3 -c 'import sys,json;print(json.load(sys.stdin)["sha256"])' 2>/dev/null)
SIZE=$(echo "$RESP" | python3 -c 'import sys,json;print(json.load(sys.stdin)["size_bytes"])' 2>/dev/null)
[ -n "$DECA_ID" ] && ok "DeCA generado: $DECA_ID (PDF de $SIZE bytes)" || { bad "no se pudo generar el DeCA: $RESP"; }
[ "$SIZE" -le 5000000 ] 2>/dev/null && ok "tamaño ≤ 5 000 000 bytes" || bad "tamaño fuera de límite"
say "- URL local de prueba: \`${URL%/d/*}/d/<token oculto>\` (http: NO cumple la Resolución; solo pruebas locales)"

say ""; say "## 3. Descarga directa desde el servicio \`docs\`"
curl -s -o "$WORK/d1.pdf" -D "$WORK/h1.txt" -w '%{http_code} %{num_redirects} %{content_type}' "$URL" > "$WORK/w1.txt"
read -r CODE REDIR CT < "$WORK/w1.txt"
[ "$CODE" = 200 ] && ok "HTTP 200" || bad "HTTP $CODE"
[ "$REDIR" = 0 ] && ok "sin redirecciones" || bad "redirecciones: $REDIR"
[ "$CT" = application/pdf ] && ok "Content-Type: application/pdf directo" || bad "Content-Type: $CT"
! grep -qi '^set-cookie' "$WORK/h1.txt" && ok "sin cookies" || bad "el servicio fija cookies"
[ "$(head -c 5 "$WORK/d1.pdf")" = '%PDF-' ] && ok "el cuerpo empieza por %PDF-" || bad "no es un PDF"
[ "$(sha "$WORK/d1.pdf")" = "$DB_SHA" ] && ok "SHA-256 descargado == SHA-256 registrado en PostgreSQL" || bad "el hash no coincide"
HASH_BEFORE=$(sha "$WORK/d1.pdf")

say ""; say "## 4. Contenido del PDF"
tools pdfinfo /w/d1.pdf > "$WORK/info.txt" 2>&1
grep -q '^CreationDate' "$WORK/info.txt" && grep -q '^ModDate' "$WORK/info.txt" && ok "metadatos CreationDate y ModDate presentes" || bad "faltan metadatos de fecha"
tools pdftotext -layout /w/d1.pdf - > "$WORK/text.txt" 2>&1
for k in "CARGADOR CONTRACTUAL" "TRANSPORTISTA EFECTIVO" "ORIGEN Y DESTINO" "MERCANCÍA" "MATRÍCULA" "12450.00 kg"; do
  grep -q "$k" "$WORK/text.txt" && ok "texto real extraíble: «$k»" || bad "falta el texto «$k»"; done
[ "$(tools pdfimages -list /w/d1.pdf | tail -n +3 | wc -l)" = 0 ] && ok "sin imágenes (PDF nativo, no escaneado)" || bad "contiene imágenes"
FONTS=$(tools pdffonts /w/d1.pdf | tail -n +3 | awk '{print $(NF-4)}'); if grep -qv yes <<<"$FONTS"; then bad "hay fuentes sin embeber"; else ok "fuentes embebidas ($(wc -l <<<"$FONTS") fuentes)"; fi
tools qrdecode /w/d1.pdf > "$WORK/qr.txt" 2>&1
[ "$(cat "$WORK/qr.txt")" = "$URL" ] && ok "el QR incrustado decodifica exactamente la URL del documento" || bad "el QR no coincide con la URL"

say ""; say "## 5. Respuestas de error uniformes y alcance del servicio \`docs\`"
DOCS="${URL%/d/*}"
RND=$(python3 -c 'import secrets;print(secrets.token_urlsafe(32))')
for p in "/d/$RND" "/d/corto" "/d/" "/" "/healthz" "/api/v1/decas/$DECA_ID"; do
  curl -s -o "$WORK/e.txt" -w '%{http_code}' "$DOCS$p" > "$WORK/ec.txt"; echo " $(cat "$WORK/e.txt")" >> "$WORK/ec.txt"
  [ "$(cat "$WORK/ec.txt")" = "404 Not found" ] && ok "GET $(echo $p | sed 's#/d/.*#/d/…#; s#/api/v1/decas/.*#/api/v1/decas/…#') → 404 genérico" || bad "GET $p → $(cat "$WORK/ec.txt")"
done
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$URL")" = 404 ] && ok "POST sobre la URL del DeCA → 404" || bad "POST no devuelve 404"
[ "$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$URL")" = 404 ] && ok "DELETE sobre la URL del DeCA → 404" || bad "DELETE no devuelve 404"
[ "$(curl -s -o /dev/null -w '%{http_code}' -I "$URL")" = 404 ] && ok "HEAD → 404 (solo GET)" || bad "HEAD no devuelve 404"
TOKEN="${URL##*/d/}"; DOCSLOG=$($DC logs docs 2>&1)
if grep -qF -- "$TOKEN" <<<"$DOCSLOG"; then bad "EL TOKEN APARECE EN LOS LOGS DE docs"; else ok "el token no aparece en los logs de docs ($(wc -l <<<"$DOCSLOG") líneas revisadas)"; fi

say ""; say "## 6. Permisos mínimos"
[ "$(psql_as deca_docs "$DB_DOCS_PASSWORD" 'SELECT count(*) FROM docs_resolve')" -ge 1 ] 2>/dev/null && ok "deca_docs lee docs_resolve" || bad "deca_docs no puede leer docs_resolve"
for t in deca deca_version audit_log company transport vehicle schema_migrations; do
  expect "deca_docs NO puede leer la tabla $t" 'permission denied' psql_as deca_docs "$DB_DOCS_PASSWORD" "SELECT 1 FROM $t LIMIT 1"; done
expect "deca_docs NO puede escribir" 'permission denied' psql_as deca_docs "$DB_DOCS_PASSWORD" "INSERT INTO company(name,nif,address) VALUES ('x','x','x')"
expect "deca_api no tiene UPDATE sobre deca (solo INSERT/SELECT en este bloque)" 'permission denied' psql_as deca_api "$DB_API_PASSWORD" "UPDATE deca SET public_active=false"
expect "deca_api NO puede borrar la auditoría" 'permission denied' psql_as deca_api "$DB_API_PASSWORD" "DELETE FROM audit_log"
expect "ni el superusuario puede borrar la auditoría (trigger de inmutabilidad)" 'protegida' $DC exec -T db psql -U postgres -d "$POSTGRES_DB" -Atc "DELETE FROM audit_log"
expect "ni el superusuario puede vaciar la auditoría (TRUNCATE)" 'protegida' $DC exec -T db psql -U postgres -d "$POSTGRES_DB" -Atc "TRUNCATE audit_log"
expect "las versiones de DeCA son inmutables" 'protegida' $DC exec -T db psql -U postgres -d "$POSTGRES_DB" -Atc "UPDATE deca_version SET reason='x'"
WOUT=$($DC exec -T docs sh -c 'touch /data/documents/x 2>&1; touch /app/x 2>&1')
[ "$(grep -c 'Read-only file system' <<<"$WOUT")" = 2 ] && ok "docs: volumen de documentos y sistema de ficheros de solo lectura" || bad "docs puede escribir en disco: $WOUT"
[ "$($DC exec -T docs id -u)" = 1000 ] && ok "docs se ejecuta sin root (uid 1000)" || bad "docs corre como root"
CAP=$($DC exec -T docs sh -c 'grep CapEff /proc/1/status' | awk '{print $2}')
[ "$CAP" = 0000000000000000 ] && ok "docs sin capacidades Linux (cap_drop ALL)" || bad "docs conserva capacidades: $CAP"
LISTEN=$(ss -ltn | awk '{print $4}' | grep -E ":(${API_PORT}|${DOCS_PORT})$")
if grep -qE '^(0\.0\.0\.0|\*|\[::\]):' <<<"$LISTEN"; then bad "algún puerto de DECARGO escucha en TODAS las interfaces: $LISTEN"; else ok "api y docs publican solo en la dirección configurada, no en todas las interfaces ($(tr '\n' ' ' <<<"$LISTEN"))"; fi

say ""; say "## 7. Persistencia tras recrear contenedores"
IDS_BEFORE=$($DC ps -q | sort | tr '\n' ' ')
T1=$(now); $DC down >/dev/null 2>&1; $DC up -d --wait >/dev/null 2>&1; T2=$(now)
IDS_AFTER=$($DC ps -q | sort | tr '\n' ' ')
[ "$IDS_BEFORE" != "$IDS_AFTER" ] && ok "los contenedores se han recreado (IDs distintos) en $((T2-T1)) s" || bad "los contenedores no se recrearon"
[ "$(curl -s -o "$WORK/d2.pdf" -w '%{http_code}' "$URL")" = 200 ] && [ "$(sha "$WORK/d2.pdf")" = "$HASH_BEFORE" ] && ok "tras 'down' + 'up -d': mismo DeCA, mismo hash" || bad "el DeCA cambió o no está disponible tras recrear"

say ""; say "## 8. Backup"
T3=$(now); ./deca backup > "$WORK/backup.out" 2>&1; BRC=$?; T4=$(now)
[ $BRC = 0 ] && ok "backup terminado sin errores en $((T4-T3)) s (incluye restic check)" || { bad "el backup falló"; tail -5 "$WORK/backup.out" | sed 's/^/    /' | tee -a "$REPORT.tmp"; }
grep -E 'created_utc' "$WORK/backup.out" | tail -1 | sed 's/^/- manifiesto: `/; s/$/`/' | tee -a "$REPORT.tmp"
SNAP=$(./deca snapshots 2>/dev/null | grep -E '^[0-9a-f]{8} ' | tail -1 | cut -d' ' -f1)
[ -n "$SNAP" ] && ok "snapshot restic: $SNAP" || bad "no hay snapshot"
./deca snapshots > "$WORK/snaps.txt" 2>&1; ./deca backup > /dev/null 2>&1   # segundo backup: demuestra versionado
N=$(./deca snapshots 2>/dev/null | grep -cE '^[0-9a-f]{8} ')
[ "$N" -ge 2 ] && ok "backup versionado: $N snapshots en el repositorio" || bad "el repositorio no acumula versiones"
SNAP=$(./deca snapshots 2>/dev/null | grep -E '^[0-9a-f]{8} ' | tail -1 | cut -d' ' -f1)
say "- snapshot utilizado para restaurar: \`$SNAP\`"

say ""; say "## 9. Destruir los datos de prueba"
DECARGO_ALLOW_DESTROY=1 ./deca destroy-test-data --yes-destroy-test-data > "$WORK/destroy.out" 2>&1
docker volume inspect ${PROJ}_pgdata >/dev/null 2>&1 && bad "${PROJ}_pgdata sigue existiendo" || ok "volumen de la base de datos eliminado"
docker volume inspect ${PROJ}_documents >/dev/null 2>&1 && bad "${PROJ}_documents sigue existiendo" || ok "volumen de documentos eliminado"
docker volume inspect ${PROJ}_backups >/dev/null 2>&1 && ok "el repositorio de backup sigue intacto (volumen separado)" || bad "se perdió el volumen de backups"
curl -s -o /dev/null -m 3 "$URL" && bad "el DeCA responde con los datos destruidos" || ok "con los datos destruidos la URL ya no responde"

say ""; say "## 10. Restaurar"
T5=$(now); ./deca restore "$SNAP" > "$WORK/restore.out" 2>&1; RRC=$?; T6=$(now)
[ $RRC = 0 ] && ok "restauración terminada en $((T6-T5)) s" || { bad "la restauración falló"; tail -8 "$WORK/restore.out" | sed 's/^/    /' | tee -a "$REPORT.tmp"; }
for s in db api docs; do
  st=$($DC ps --format '{{.Service}} {{.Health}}' | awk -v s=$s '$1==s{print $2}')
  [ "$st" = healthy ] && ok "tras restaurar, servicio $s healthy" || bad "tras restaurar, $s: $st"; done

say ""; say "## 11. Verificación posterior"
./deca verify > "$WORK/verify.json" 2>&1; VRC=$?
[ $VRC = 0 ] && ok "verify: documentos y cadena de auditoría íntegros" || bad "verify con discrepancias"
python3 - "$WORK/verify.json" <<'PY' | tee -a "$REPORT.tmp"
import json,sys
d=json.load(open(sys.argv[1]))
print("- resultado de verify: DeCA=%s, versiones=%s, filas de auditoría=%s, documentos verificados=%s, cadena de auditoría íntegra=%s, problemas=%s"%(d["decas"],d["versions"],d["audit_rows"],d["documents_verified"],d["audit_chain_ok"],d["problems"]))
PY
[ "$(curl -s -o "$WORK/d3.pdf" -w '%{http_code}' "$URL")" = 200 ] && ok "el MISMO DeCA (misma URL/token) sigue disponible tras restaurar" || bad "la URL no responde tras restaurar"
[ "$(sha "$WORK/d3.pdf")" = "$HASH_BEFORE" ] && ok "SHA-256 idéntico al original" || bad "el hash difiere tras restaurar"
[ "$(tools qrdecode /w/d3.pdf)" = "$URL" ] && ok "el QR del PDF restaurado sigue apuntando a la misma URL" || bad "el QR no coincide tras restaurar"
$DC --profile tools run --rm backup config "$SNAP" 2>/dev/null | tr -d '\r' > "$WORK/cfg.env"
diff <(grep -v '^RESTIC_PASSWORD=' .env) "$WORK/cfg.env" >/dev/null && ok "la configuración guardada en el backup coincide con la actual (sin RESTIC_PASSWORD)" || bad "la configuración no coincide"
[ "$(psql_as deca_docs "$DB_DOCS_PASSWORD" 'SELECT count(*) FROM docs_resolve')" -ge 1 ] 2>/dev/null && ok "tras restaurar, deca_docs sigue pudiendo leer docs_resolve" || bad "deca_docs sin acceso tras restaurar"
expect "tras restaurar, deca_docs sigue SIN acceso a las tablas" 'permission denied' psql_as deca_docs "$DB_DOCS_PASSWORD" "SELECT 1 FROM deca LIMIT 1"
expect "tras restaurar, deca_api NO puede borrar la auditoría" 'permission denied' psql_as deca_api "$DB_API_PASSWORD" "DELETE FROM audit_log"
expect "tras restaurar, el trigger de inmutabilidad sigue activo" 'protegida' $DC exec -T db psql -U postgres -d "$POSTGRES_DB" -Atc "DELETE FROM audit_log"
expect "tras restaurar, el sistema puede generar un DeCA nuevo" 'deca_id' curl -s -X POST -H "Authorization: Bearer $DEV_API_KEY" "$API/api/v1/dev/test-deca"
true && true

say ""; say "## 12. Límite de peticiones del servicio docs (al final: agota el límite)"
RND2=$(python3 -c 'import secrets;print(secrets.token_urlsafe(32))')
CODES=$(for i in $(seq 1 650); do curl -s -o /dev/null -w '%{http_code}\n' "$DOCS/d/$RND2"; done | sort | uniq -c | tr -s ' ' | tr '\n' ';')
grep -q '429' <<<"$CODES" && ok "límite por IP activo: 650 peticiones en <1 min → $CODES" || bad "no se aplica el límite de peticiones: $CODES"

say ""; say "## Resumen"
say "- Comprobaciones superadas: **$PASS** · fallidas: **$FAIL**"
say "- Duraciones: backup $((T4-T3)) s · restauración $((T6-T5)) s · recreación de contenedores $((T2-T1)) s"
{ cat "$REPORT.tmp"; } > "$REPORT"; rm -f "$REPORT.tmp"
echo; echo "Informe: $REPORT"
[ "$FAIL" = 0 ]
