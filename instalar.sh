#!/bin/bash
# DECARGO · instalación en Linux (también la usa el instalador de Windows dentro de WSL).
#   ./instalar.sh            instalación guiada: comprueba requisitos, configura, arranca y crea el primer administrador
#   ./instalar.sh --check    solo comprueba los requisitos
# Se puede volver a ejecutar: no borra datos ni cambia los secretos ya creados.
set -euo pipefail
cd "$(dirname "$0")"

B=$'\e[1m'; R=$'\e[31m'; G=$'\e[32m'; Y=$'\e[33m'; N=$'\e[0m'
ok() { echo "  ${G}✔${N} $*"; }
ko() { echo "  ${R}✘${N} $*"; FALTA=1; }
aviso() { echo "  ${Y}!${N} $*"; }
FALTA=0

echo "${B}== DECARGO · instalación ==${N}"
echo
echo "${B}1. Requisitos${N}"
[ "$(uname -s)" = Linux ] && ok "Linux ($(. /etc/os-release 2>/dev/null; echo "${PRETTY_NAME:-desconocido}"))" || ko "Este instalador es para Linux (en Windows usa INSTALAR-WINDOWS.bat)"
command -v docker >/dev/null && ok "Docker: $(docker --version | cut -d, -f1)" || ko "Falta Docker. Instálalo siguiendo https://docs.docker.com/engine/install/ (o Docker Desktop)"
if command -v docker >/dev/null; then
  if docker info >/dev/null 2>&1; then ok "Docker está en marcha y este usuario puede usarlo"
  else ko "Docker no responde o este usuario no tiene permiso. Arráncalo (sudo systemctl start docker) y añade tu usuario al grupo docker (sudo usermod -aG docker \$USER; después cierra sesión y vuelve a entrar)"; fi
  docker compose version >/dev/null 2>&1 && ok "Docker Compose: $(docker compose version --short 2>/dev/null)" || ko "Falta el plugin Docker Compose v2 (paquete docker-compose-plugin)"
fi
for c in openssl python3 curl; do command -v "$c" >/dev/null && ok "$c" || ko "Falta $c (Debian/Ubuntu: sudo apt install $c)"; done
command -v ip >/dev/null && command -v ss >/dev/null && ok "iproute2 (ip, ss)" || ko "Falta iproute2 (Debian/Ubuntu: sudo apt install iproute2)"
MEM=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo 2>/dev/null || echo 0)
[ "$MEM" -ge 1800 ] && ok "Memoria: ${MEM} MB" || aviso "Memoria: ${MEM} MB (se recomiendan 2 GB o más)"
DISK=$(df -Pm . | awk 'NR==2 {print $4}')
[ "$DISK" -ge 5000 ] && ok "Disco libre: $((DISK / 1024)) GB" || aviso "Disco libre: ${DISK} MB (se recomiendan 5 GB o más, más el espacio de las copias de seguridad)"
if [ "$FALTA" = 1 ]; then echo; echo "${R}Faltan requisitos. Resuélvelos y vuelve a ejecutar ./instalar.sh${N}"; exit 1; fi
[ "${1:-}" = "--check" ] && { echo; echo "Todo listo para instalar."; exit 0; }
chmod +x deca scripts/*.sh 2>/dev/null || true

echo
echo "${B}2. Configuración${N}"
if [ -f .env ]; then ok "Ya existe .env: se conservan los secretos y la configuración"; else ./deca init; fi
echo
echo "Ahora el asistente pregunta la IP local de este equipo y la dirección pública https de los DeCA."
echo "Si todavía no tienes dominio, pulsa Intro: podrás ponerlo después en la web (Configuración) o con ./deca config set-domain."
echo
# El instalador de Windows ya ha elegido la IP (la de Windows, no la interna de WSL): se pasa al asistente.
if [ -n "${DECARGO_SETUP_IP:-}" ]; then ./deca setup --ip "$DECARGO_SETUP_IP"; else ./deca setup; fi

echo
echo "${B}3. Primer administrador${N}"
ADMINS=$(docker compose exec -T db psql -U postgres -d "$(grep -E '^POSTGRES_DB=' .env | cut -d= -f2- || echo decargo)" -Atc "SELECT count(*) FROM app_user WHERE role = 'admin'" </dev/null 2>/dev/null || echo 0)
if [ "${ADMINS:-0}" != "0" ]; then
  ok "Ya hay un administrador: no se crea otro"
else
  read -r -p "¿Crear ahora el administrador de la empresa? [S/n]: " C
  if [[ ! "${C:-S}" =~ ^[nN] ]]; then
    read -r -p "  Usuario (por ejemplo, nombre.apellido): " U
    read -r -p "  Nombre y apellidos: " NOMBRE
    read -r -p "  Razón social de la empresa: " EMP
    read -r -p "  NIF/CIF de la empresa: " NIF
    read -r -p "  Domicilio de la empresa: " DOM
    OUT=$(./deca create-user --username "$U" --name "$NOMBRE" --role admin --company-name "$EMP" --company-nif "$NIF" --company-address "$DOM" </dev/null)
    CODE=$(python3 -c 'import json,sys; d=json.loads(sys.stdin.read()); print(d.get("activation_code",""))' <<<"$OUT" 2>/dev/null || true)
    if [ -n "$CODE" ]; then
      echo
      echo "  ${B}Código de activación (se muestra UNA sola vez): ${CODE}${N}"
      echo "  Ábrelo en la aplicación → «Activar cuenta», con el usuario «$U», y elige la contraseña."
    else echo "$OUT"; fi
  fi
fi

APP=$(grep -E '^DECARGO_APP_PATH=' .env | cut -d= -f2-)
WIP=$(grep -E '^WEB_BIND=' .env | cut -d= -f2-); WPORT=$(grep -E '^WEB_PORT=' .env | cut -d= -f2-)
PUB=$(grep -E '^PUBLIC_DOCS_BASE_URL=' .env | cut -d= -f2-)
echo
echo "${B}== DECARGO está en marcha ==${N}"
echo "  Web pública (en la red local):  http://${WIP}:${WPORT}/"
echo "  Aplicación:                     http://${WIP}:${WPORT}/${APP}/   (activar cuenta: …/${APP}/activar)"
echo "  Dirección pública de los DeCA:  ${PUB}"
echo
echo "${B}Pasos siguientes (importantes)${N}"
echo "  1. HTTPS: los QR de los DeCA exigen una dirección https. Pon delante un proxy con certificado (Nginx Proxy Manager, Caddy…):"
echo "     el dominio → ${WIP}:${WPORT} (web), y la ruta /d/ → puerto $(grep -E '^DOCS_PORT=' .env | cut -d= -f2-) (documentos). Guía: docs/INSTALACION.md"
echo "  2. Copia de seguridad: guarda la RESTIC_PASSWORD del archivo .env FUERA de este equipo. Sin ella no se puede abrir ninguna copia."
echo "     Haz copias con ./deca backup (y programa una diaria). El volumen de copias debe estar en otro disco."
echo "  3. Antes de emitir DeCA reales, entra en Configuración y revisa la lista «antes de usar con datos reales»."
echo
echo "Ayuda: ./deca (sin argumentos) muestra todos los comandos. Documentación: README.md y docs/."
