# Backend de Canchas3

API en TypeScript sobre Node con Fastify. Hoy incluye la estructura base (configuración, errores, conexión a Postgres, `GET /api/health`) y la **reproducción en vivo de una cámara real** (`GET /api/live/:cameraId/stream`). El resto de las funcionalidades (catálogo, jugadas, acceso) van en changes posteriores.

## Requisitos

- Node 20 o superior.
- ffmpeg instalado y en el `PATH` (o indicado con `FFMPEG`) para ver la cámara en vivo.
- Docker, solo para el entorno con Postgres o para desplegar.

## Desarrollo local (sin Docker)

```bash
cd backend
npm install
cp .env.example .env       # y completar DATABASE_URL
npm run dev                # http://localhost:3100
```

Comprobaciones:

```bash
curl http://localhost:3100/api/health            # {"status":"ok"}
curl "http://localhost:3100/api/health?db=true"  # además comprueba la base
```

`/api/health?db=true` responde 503 si la base no está disponible.

> **Puerto ocupado:** el backend usa el **3100** por defecto, el mismo que el PoC de RTSP (`contexto/poc-rtsp`). Si el PoC está corriendo, cambiá `PORT` en el `.env` (por ejemplo `3110`) o detené el PoC.

## Con Docker (API + Postgres)

```bash
cd backend
docker compose up --build
curl "http://localhost:3100/api/health?db=true"
```

Si el 3100 está ocupado en tu máquina, elegí otro puerto del host: `API_PORT=3110 docker compose up --build` y consultá `http://localhost:3110`.

Las variables de la cámara se leen de `backend/.env` (si existe). No se escriben en el `docker-compose.yml`.

## Cámara en vivo

`GET /api/live/:cameraId/stream` lee el RTSP de la cámara con ffmpeg y entrega MP4 fragmentado, listo para un `<video>`. Funciona con **una sola cámara**, configurada por variables de entorno:

| Variable | Descripción | Por defecto |
|---|---|---|
| `CAM_USER` | Usuario de la cámara | — |
| `CAM_PASS` | Contraseña de la cámara | — |
| `CAM_HOST` | Host y puerto RTSP (ej. `camara.ejemplo.com:554`) | — |
| `LIVE_CAMERA_ID` | Identificador de la cámara en la URL (ej. `estacion-norte-c1`) | — |
| `LIVE_CAMERA_CHANNEL` | Canal: `101`, `102`, `201` o `202` | `201` |
| `LIVE_MAX_VIEWERS` | Espectadores simultáneos permitidos | `3` |
| `LIVE_FIRST_BYTE_TIMEOUT_MS` | Espera máxima del primer byte de video | `20000` |
| `FFMPEG` | Ruta de ffmpeg si no está en el `PATH` | `ffmpeg` |

- Las cuatro primeras (`CAM_USER`, `CAM_PASS`, `CAM_HOST`, `LIVE_CAMERA_ID`) son **todo o nada**: sin ninguna, el backend arranca igual y la ruta responde "La cámara en vivo no está configurada" (503); con algunas pero no todas, el arranque falla nombrando las que faltan.
- **Solo el canal `201` está verificado** (H.264, se reproduce sin transcodificar). El `101` es HEVC y el navegador no lo reproduce: el reproductor mostrará su estado de error.
- Cada espectador abre su propio ffmpeg. Al superar `LIVE_MAX_VIEWERS` la ruta responde 503 con "Hay muchos espectadores viendo esta cámara".
- Los errores y los logs nunca incluyen la dirección RTSP, el usuario ni la contraseña.

| Respuesta | Cuándo |
|---|---|
| `200` video | La cámara responde |
| `404` | El identificador no es el de la cámara registrada |
| `503` `camera_not_configured` | No hay cámara configurada |
| `503` `too_many_viewers` | Se alcanzó el tope de espectadores |
| `502` `camera_unreachable` | No se pudo conectar con la cámara o no llegó el primer byte a tiempo |

### Probar con la cámara real

Las credenciales no están en el repositorio. Cargalas solo en tu `.env` local (que no se versiona):

```bash
cd backend
cp .env.example .env
# editar .env: DATABASE_URL, CAM_USER, CAM_PASS, CAM_HOST y LIVE_CAMERA_ID (ej. estacion-norte-c1)
npm run dev
```

1. Con el frontend levantado (`cd frontEnd && npm run dev`), abrí `/en-vivo/estacion-norte-c1`: debería verse el video en vivo.
2. Sin frontend, probá el flujo directo: `curl -o prueba.mp4 -m 10 http://localhost:3100/api/live/estacion-norte-c1/stream` y abrí `prueba.mp4` (corta a los 10 s).
3. Con un identificador inexistente (`/api/live/otra/stream`) debe responder 404.
4. Con la cámara apagada o `CAM_HOST` mal puesto debe responder 502 con un mensaje legible.
5. Cerrá la pestaña y comprobá que el proceso `ffmpeg` desaparece (en Windows: `Get-Process ffmpeg`).

El video puede tardar en aparecer: con `-c copy` empieza en el primer fotograma clave de la cámara.

## Despliegue en Dokploy y Coolify

El destino final son Dokploy y Coolify. En ambos, **la unidad de despliegue es el `Dockerfile`** (el `docker-compose.yml` es solo para desarrollo local).

| Tema | Configuración |
|---|---|
| Build | Desde `backend/Dockerfile` (la imagen ya trae ffmpeg) |
| Puerto del contenedor | `3100` (variable `PORT`) |
| Health check | `GET /api/health` (el `Dockerfile` ya define un `HEALTHCHECK`) |
| Base de datos | Un recurso Postgres de la plataforma; su URL en `DATABASE_URL` |
| Cámara | `CAM_USER`, `CAM_PASS`, `CAM_HOST`, `LIVE_CAMERA_ID` como **secretos**, nunca en el repositorio |
| Límites | Fijar memoria y CPU del contenedor desde la plataforma (ver `docs/servidor-demo-consideraciones.md`) |
| Red | El servidor debe poder alcanzar el puerto RTSP (554) de la cámara |

**Dos puntos a verificar al desplegar** (no se pueden comprobar en desarrollo):

1. **Flujo largo detrás del proxy.** El video es una respuesta HTTP que dura minutos. Los proxies de las plataformas (Traefik, según lo observado en Dokploy) podrían cortarla por inactividad o hacer buffering. Probar una reproducción de **más de 3 minutos**. La ruta ya envía `Cache-Control: no-store` y `X-Accel-Buffering: no`.
2. **`/api` bajo el mismo dominio que el frontend.** Se necesita que la plataforma enrute `/api` hacia el backend y el resto hacia el frontend. Si alguna no lo permite, el plan B es un subdominio aparte para la API, que exigiría configurar CORS (y cuidar las cookies en changes posteriores).

## Scripts

| Comando | Qué hace |
|---|---|
| `npm run dev` | Servidor con recarga automática (lee `.env`) |
| `npm run build` | Compila a `dist/` |
| `npm start` | Ejecuta lo compilado (`dist/server.js`) |
| `npm test` | Pruebas (Vitest) |
| `npm run lint` | Chequeo de tipos (`tsc --noEmit`) |

## Variables de entorno

| Variable | Obligatoria | Por defecto |
|---|---|---|
| `DATABASE_URL` | Sí | — |
| `PORT` | No | `3100` |
| `HOST` | No | `0.0.0.0` |
| `NODE_ENV` | No | `development` |

Las variables de la cámara están en la sección "Cámara en vivo". Si falta `DATABASE_URL`, el arranque termina con un mensaje que lo indica.

## Formato de errores

Todos los errores responden con el mismo cuerpo:

```json
{ "error": { "code": "validation_error", "message": "edad: ...", "details": [] } }
```

## Estructura

```text
backend/
├── src/
│   ├── app.ts                 # servidor Fastify, errores y /api/health
│   ├── config.ts              # variables de entorno validadas
│   ├── server.ts              # arranque
│   ├── db/client.ts           # conexión a Postgres
│   ├── lib/errors.ts          # errores de la aplicación
│   └── modules/live/          # cámara en vivo
│       ├── routes.ts          #   GET /api/live/:cameraId/stream
│       ├── rtsp.ts            #   URL RTSP, argumentos de ffmpeg y sanitizado de logs
│       ├── launcher.ts        #   lanzador de ffmpeg (reemplazable en pruebas)
│       └── viewers.ts         #   tope de espectadores
└── test/                      # pruebas
```
