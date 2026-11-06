# Backend de Canchas3 (estructura base)

API en TypeScript sobre Node con Fastify. Por ahora solo tiene la estructura base: configuración, servidor, manejo de errores, conexión a Postgres y `GET /api/health`. Las funcionalidades (catálogo, jugadas, acceso) van en changes posteriores.

## Requisitos

- Node 20 o superior.
- Docker, solo para el entorno con Postgres.

## Desarrollo local (sin Docker)

```bash
cd backend
npm install
cp .env.example .env       # y completar DATABASE_URL
npm run dev                # http://localhost:3001
```

Comprobaciones:

```bash
curl http://localhost:3001/api/health            # {"status":"ok"}
curl "http://localhost:3001/api/health?db=true"  # además comprueba la base
```

`/api/health?db=true` responde 503 si la base no está disponible.

## Con Docker (API + Postgres)

```bash
cd backend
docker compose up --build
curl http://localhost:3001/api/health?db=true
```

## Scripts

| Comando | Qué hace |
|---|---|
| `npm run dev` | Servidor con recarga automática |
| `npm run build` | Compila a `dist/` |
| `npm start` | Ejecuta lo compilado (`dist/server.js`) |
| `npm test` | Pruebas (Vitest) |
| `npm run lint` | Chequeo de tipos (`tsc --noEmit`) |

## Variables de entorno

| Variable | Obligatoria | Por defecto |
|---|---|---|
| `DATABASE_URL` | Sí | — |
| `PORT` | No | `3001` |
| `HOST` | No | `0.0.0.0` |
| `NODE_ENV` | No | `development` |

Si falta `DATABASE_URL`, el arranque termina con un mensaje que lo indica.

## Formato de errores

Todos los errores responden con el mismo cuerpo:

```json
{ "error": { "code": "validation_error", "message": "edad: ...", "details": [] } }
```

## Estructura

```text
backend/
├── src/
│   ├── app.ts         # servidor Fastify, errores y /api/health
│   ├── config.ts      # variables de entorno validadas
│   ├── server.ts      # arranque
│   ├── db/client.ts   # conexión a Postgres
│   └── lib/errors.ts  # errores de la aplicación
└── test/              # pruebas
```
