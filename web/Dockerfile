# DECARGO · interfaz web: se compila con Node y se sirve con nginx sin privilegios (solo ficheros estáticos + proxy de /api).
FROM node:22.23.3-bookworm-slim AS build
# Fuentes del DeCA (las mismas que usa el servidor) para la demostración, que genera los PDF en el navegador.
RUN apt-get update && apt-get install -y --no-install-recommends fonts-dejavu-core && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts index.html ./
COPY public ./public
COPY src ./src
# La demostración usa EXACTAMENTE el mismo generador de DeCA que el servidor (contexto «server» de docker-compose.yml).
COPY --from=server src/pdf ./src/shared/pdf
COPY --from=server src/office/address.ts ./src/shared/office/address.ts
# Web pública y demostración: SOLO en el sitio del proyecto (DECARGO_PUBLIC_SITE=1). En una instalación de empresa no se construyen
# (de la carpeta web/ solo queda la página «no encontrado»).
ARG PUBLIC_SITE=0
RUN rm -f src/shared/pdf/render.ts && npm run build \
 && if [ "$PUBLIC_SITE" = "1" ]; then \
      npm run build:demo && mkdir -p dist/demo/fonts && cp /usr/share/fonts/truetype/dejavu/DejaVuSans.ttf /usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf dist/demo/fonts/; \
    else \
      find dist/web -type f ! -name 404.html ! -name web.css -delete; \
    fi

FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY nginx.conf /etc/nginx/nginx.conf
COPY security-headers.conf /etc/nginx/security-headers.conf
COPY templates /etc/nginx/templates
COPY --chmod=755 entrypoint/05-decargo-conf-dir.sh /docker-entrypoint.d/05-decargo-conf-dir.sh
COPY --chmod=755 entrypoint/06-decargo-site.sh /docker-entrypoint.d/06-decargo-site.sh
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
