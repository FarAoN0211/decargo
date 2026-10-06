#!/bin/sh
# DECARGO · web pública (presentación + demostración) SOLO si DECARGO_PUBLIC_SITE=1 (el sitio del propio proyecto).
# En una instalación de empresa (por defecto) no se sirve: «/» lleva directamente a la aplicación y /demo/ no existe.
set -eu
out=/tmp/nginx-conf/site.conf
app="${DECARGO_APP_PATH:?falta DECARGO_APP_PATH}"
if [ "${DECARGO_PUBLIC_SITE:-0}" = "1" ] && [ -f /usr/share/nginx/html/web/index.html ]; then
  cat > "$out" <<CONF
# Web pública: presentación, app Android, instalación y demostración (sin sesión ni datos).
location = / {
  include /etc/nginx/security-headers.conf;
  add_header Cache-Control "no-cache" always;
  try_files /web/index.html =404;
}
location /web/ {
  include /etc/nginx/security-headers.conf;
  add_header Cache-Control "no-cache" always;
  try_files \$uri =404;
}
location ^~ /demo/assets/ {
  include /etc/nginx/security-headers.conf;
  add_header Cache-Control "public, max-age=31536000, immutable" always;
  try_files \$uri =404;
}
location = /demo { return 301 /demo/; }
location ^~ /demo/ {
  include /etc/nginx/security-headers.conf;
  add_header Cache-Control "no-cache" always;
  add_header X-Robots-Tag "noindex" always;
  try_files \$uri /demo/index.html;
}
CONF
  echo "DECARGO: web pública activada"
else
  cat > "$out" <<CONF
# Instalación de empresa: sin web pública ni demostración. La raíz lleva a la aplicación.
location = / { return 302 /${app}/; }
location ^~ /demo { return 404; }
location /web/ { location = /web/web.css { include /etc/nginx/security-headers.conf; try_files \$uri =404; } return 404; }   # solo la hoja de estilo de la página «no encontrado»
CONF
  echo "DECARGO: sin web pública («/» → aplicación)"
fi
