#!/bin/bash
# DECARGO · backup y restauración con restic.
#   backup            volcado consistente de PostgreSQL + documentos + configuración → repositorio cifrado
#   restore [snap]    restaura documentos y base de datos (la BD debe estar vacía y los roles ya creados)
#   config [snap]     imprime la configuración guardada en el snapshot (sin RESTIC_PASSWORD)
#   snapshots | check
set -euo pipefail
export RESTIC_REPOSITORY=/repo
: "${RESTIC_PASSWORD:?falta RESTIC_PASSWORD}"
DB_HOST=${DB_HOST:-db}
DB_NAME=${DB_NAME:-decargo}
HOST_TAG=decargo        # nombre de host fijo: el de un contenedor cambia en cada ejecución

init_repo() { restic cat config >/dev/null 2>&1 || restic init; }

cmd=${1:-}; shift || true
case "$cmd" in
  backup)
    init_repo
    rm -rf /stage; mkdir -p /stage
    export PGPASSWORD="${DB_BACKUP_PASSWORD:?}"
    # 1) La base de datos primero: el volcado es una instantánea consistente.
    pg_dump -h "$DB_HOST" -U deca_backup -d "$DB_NAME" -Fc -f /stage/decargo.dump
    # 2) Los documentos después: son inmutables y direccionados por contenido, así que todo fichero que cite
    #    el volcado ya existe. Un documento escrito entre ambos pasos queda huérfano pero es inofensivo.
    # 3) Configuración: sin la contraseña de restic (no puede viajar dentro de su propio repositorio).
    grep -v '^RESTIC_PASSWORD=' /run/config/env > /stage/config.env
    DOC_FILES=$(find /data/documents -name '*.pdf' | wc -l)
    VERSIONS=$(psql -h "$DB_HOST" -U deca_backup -d "$DB_NAME" -Atc 'SELECT count(*) FROM deca_version')
    MIGR=$(psql -h "$DB_HOST" -U deca_backup -d "$DB_NAME" -Atc 'SELECT max(version) FROM schema_migrations')
    cat > /stage/manifest.json <<JSON
{"created_utc":"$(date -u +%FT%TZ)","decargo_version":"${DECARGO_VERSION:-?}","db":"$DB_NAME","last_migration":"$MIGR","deca_versions":$VERSIONS,"document_files":$DOC_FILES}
JSON
    restic backup --host "$HOST_TAG" --tag decargo /stage /data/documents
    restic check
    cat /stage/manifest.json
    ;;
  restore)
    SNAP=${1:-latest}
    rm -rf /restore; mkdir -p /restore
    restic restore "$SNAP" --host "$HOST_TAG" --target /restore
    cat /restore/stage/manifest.json
    export PGPASSWORD="${POSTGRES_PASSWORD:?}"
    pg_restore -h "$DB_HOST" -U postgres -d "$DB_NAME" --exit-on-error --single-transaction /restore/stage/decargo.dump
    mkdir -p /data/documents
    cp -a /restore/data/documents/. /data/documents/
    chown -R 1000:1000 /data/documents       # usuario `node` de la imagen del servidor
    echo "restauración de datos completada"
    ;;
  config)
    restic dump "${1:-latest}" /stage/config.env --host "$HOST_TAG"
    ;;
  snapshots) restic snapshots --host "$HOST_TAG" ;;
  check) restic check ;;
  *) echo "uso: backup | restore [snapshot] | config [snapshot] | snapshots | check"; exit 2 ;;
esac
