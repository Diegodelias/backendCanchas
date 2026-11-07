FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS run
ENV NODE_ENV=production
WORKDIR /app
# ffmpeg lee el RTSP de la cámara y lo convierte a MP4 para el navegador.
RUN apk add --no-cache ffmpeg
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# La API aplica estas migraciones al arrancar, antes de abrir el puerto.
COPY migrations ./migrations
USER node
EXPOSE 3100
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT:-3100}/api/health" || exit 1
CMD ["node", "dist/server.js"]
