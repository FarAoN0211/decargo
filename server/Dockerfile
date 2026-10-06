# DECARGO: imagen única para api, docs y migraciones (cambia solo el comando).
FROM node:22.23.3-bookworm-slim AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build

FROM node:22.23.3-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /usr/share/fonts/truetype/dejavu/DejaVuSans.ttf /usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf ./assets/fonts/
COPY migrations ./migrations
# El directorio de documentos existe con propietario `node`; un volumen nuevo hereda ese propietario.
RUN mkdir -p /data/documents && chown -R node:node /data
USER node
CMD ["node", "dist/api/main.js"]
