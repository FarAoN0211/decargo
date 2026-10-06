# DECARGO · interfaz web: se compila con Node y se sirve con nginx sin privilegios (solo ficheros estáticos + proxy de /api).
FROM node:22.23.3-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts index.html ./
COPY public ./public
COPY src ./src
RUN npm run build && npm run build:demo

FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY nginx.conf /etc/nginx/nginx.conf
COPY security-headers.conf /etc/nginx/security-headers.conf
COPY templates /etc/nginx/templates
COPY --chmod=755 entrypoint/05-decargo-conf-dir.sh /docker-entrypoint.d/05-decargo-conf-dir.sh
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
