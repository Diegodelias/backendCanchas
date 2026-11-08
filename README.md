# Backend de Canchas3

API en TypeScript sobre Node con Fastify. Hoy incluye la estructura base (configuración, errores, conexión a Postgres, `GET /api/health`), la **reproducción en vivo de una cámara real** (`GET /api/live/:cameraId/stream`) el **ingreso de admins de club** con mail y contraseña, el **ingreso de jugadores por un link enviado a su mail** las **jugadas guardadas** de cada jugador y los **clubes con sus canchas**, que el admin gestiona desde el panel. El resto de las funcionalidades (horarios y reservas, partidos guardados) van en changes posteriores.

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

## Base de datos y migraciones

El esquema se versiona con [`node-pg-migrate`](https://salsita.github.io/node-pg-migrate/) en `migrations/` (archivos `.sql` con secciones `-- Up Migration` y `-- Down Migration`). La tabla `pgmigrations` registra cuáles ya se aplicaron.

- **Al arrancar, la API aplica las migraciones pendientes antes de abrir el puerto**, tanto con `npm run dev` como en Docker. Se aplican todas en una transacción: si una falla, no queda ninguna aplicada, el log nombra la que falló y el proceso termina con código 1.
- `npm run migrate` aplica las pendientes a mano (lee `DATABASE_URL` del `.env`).
- `npm run migrate:create -- <nombre>` crea una migración nueva en SQL.

## Acceso de admins de club

Un admin ingresa con mail y contraseña y recibe una cookie de sesión `c3_session` (`HttpOnly`, `SameSite=Lax`, `Secure` según `SESSION_COOKIE_SECURE`). La sesión dura 8 horas sin uso y se renueva mientras se usa. En la base se guardan el hash `argon2id` de la contraseña y el SHA-256 del token, nunca los valores originales.

| Método y ruta | Respuestas |
|---|---|
| `POST /api/auth/admin/login` `{ email, password }` | `200 { user }` con la cookie; `401 invalid_credentials` (mismo error si el mail no existe o la clave es incorrecta); `429 too_many_attempts`; `400 validation_error` |
| `POST /api/auth/admin/request-reset` `{ email }` | `202 { message }` (**el mismo para cualquier mail válido**, sea de un admin, de un jugador o sin cuenta); `429 too_many_requests`; `400 validation_error` |
| `POST /api/auth/admin/reset-password` `{ token, password }` | `204` (no abre sesión); `410 link_used`; `410 link_expired`; `400 validation_error` (contraseña de menos de 10 caracteres: **no consume el link**) |
| `POST /api/auth/logout` | `204`; borra la sesión y la cookie |
| `GET /api/auth/me` | `200 { user }` o `200 { user: null }` |

`user` es `{ id, email, name, role, clubId }`. Después de **5 intentos fallidos en 15 minutos**, por cuenta o por IP, el ingreso responde `429` aunque la contraseña sea correcta, hasta que pase la ventana.

> La IP sale de `X-Forwarded-For` (`trustProxy`). Es confiable solo si la API se publica detrás del proxy (Vite en desarrollo, nginx en producción) y no directamente.

### Recuperar la contraseña

Un admin que olvidó su contraseña la recupera por mail:

1. En el formulario de admin toca «Olvidé mi contraseña» y pone su mail. La respuesta es siempre la misma; **solo un mail de admin recibe el link**.
2. El link (`<PUBLIC_APP_URL>/recuperar?token=…`) vale **una sola vez y 15 minutos**, y abre una página donde elige la contraseña nueva (10 caracteres o más). Una contraseña corta no gasta el link.
3. Al cambiarla, **se cierran todas sus sesiones** y no se abre una nueva: ingresa de nuevo con la contraseña nueva. Los intentos fallidos de ingreso no se borran: si estaba bloqueado, la espera de 15 minutos sigue.

Se permiten 3 pedidos por mail cada 15 minutos (cuentan todos, se envíe o no un link), con un límite **independiente** del de los links de acceso de jugadores. En desarrollo el mail se ve en Mailpit (`http://localhost:8025`).

> No hay un comando para cambiar la contraseña de un admin que ya existe. Si perdió también el acceso a su mail, hay que borrar su usuario en la base y volver a crearlo con `crear-admin`.

### Crear una cuenta de prueba

No hay pantalla de alta: los admins se crean por comando. La contraseña se pide por teclado y no se muestra (10 caracteres o más). Sin terminal interactiva se lee de `ADMIN_PASSWORD`. Nunca va como argumento.

```bash
# Desarrollo local (lee DATABASE_URL del .env)
npm run crear-admin -- --email ana@club.example --nombre "Ana Pérez" --club estacion-norte

# Dentro del contenedor (con docker compose up corriendo)
docker compose exec api node dist/cli/crear-admin.js --email ana@club.example --nombre "Ana Pérez" --club estacion-norte
```

El club tiene que **existir en la base** (ver «Clubes y canchas»): los de ejemplo son `estacion-norte`, `la-cantera-crespo`, `polideportivo-belgrano`, `parque-sur-caballito`, `arena-nunez` y `terraza-colegiales`, y los nuevos se dan de alta con `crear-club`. Con un club inexistente (el error lista los válidos), un mail repetido o una contraseña corta, el comando termina con error y no crea nada.

## Acceso de jugadores por mail

El jugador no tiene contraseña: pone su mail y recibe un link de un solo uso que vence a los **15 minutos**. El link apunta a la página `/acceso` del frontend (`<PUBLIC_APP_URL>/acceso?token=…`), que pide confirmar con un botón; recién ahí el backend consume el link. Así un programa del correo que abre el link antes que la persona no lo gasta.

| Método y ruta | Respuestas |
|---|---|
| `POST /api/auth/player/request-link` `{ email }` | `202 { message }` (**el mismo para cualquier mail válido**, tenga o no cuenta, incluso si es de un admin); `429 too_many_requests` (3 pedidos por mail cada 15 minutos); `400 validation_error` |
| `POST /api/auth/player/confirm` `{ token }` | `200 { user }` con la cookie `c3_session`; `410 link_used`; `410 link_expired` (vencido o inexistente) |

- La cuenta de un mail nuevo se crea al confirmar el link, solo con el mail (`user.name` es `null`). Con el mail de un admin no se envía nada.
- La sesión del jugador dura **30 días sin uso** y se renueva mientras entra al sitio. Puede tener varias a la vez; `POST /api/auth/logout` cierra solo la del dispositivo actual.
- Pedir un link nuevo no invalida los anteriores; cada uno vence solo.
- Los links de acceso y los de recuperación de contraseña comparten tablas pero llevan un propósito (`access` o `password_reset`): uno no sirve para el otro.
- El mail se envía en segundo plano, para que la respuesta no tarde distinto según el caso. Si el envío falla, solo se registra el tipo de error (sin el link ni el mail).

### Mails en desarrollo

| `SMTP_URL` | Qué pasa |
|---|---|
| vacía (`npm run dev` sin Docker) | El link **se imprime en el log del backend** y no se envía nada |
| `smtp://mailpit:1025` (`docker compose`) | Se envía a **Mailpit**, un buzón de pruebas: abrí `http://localhost:8025` para ver los mails y tocar el link (`MAILPIT_UI_PORT` cambia el puerto) |
| una URL de un proveedor | Se envía de verdad |

Variables: `PUBLIC_APP_URL` (dirección del frontend; por defecto `http://localhost:3000`), `SMTP_URL` y `MAIL_FROM` (por defecto `Canchas3 <no-reply@canchas3.example>`). **En producción `PUBLIC_APP_URL` y `SMTP_URL` son obligatorias**: sin ellas la API no arranca, para no dejar en el log los links de acceso de los jugadores. Guardá `SMTP_URL` como secreto de la plataforma.

## Jugadas

Cada jugada es de su dueño: una jugada ajena responde `404`, y los admins de club reciben `403`. Todas las rutas piden sesión de jugador (`401` sin sesión).

| Método y ruta | Respuestas |
|---|---|
| `GET /api/plays` | `200 { plays }`, las del jugador, de la más reciente a la más antigua |
| `POST /api/plays` `{ matchId, title, category?, captureMode?, timestamp, isLiveMoment? }` | `201 { play }`; `409 plays_limit_reached` (tope de 200 por jugador); `400 validation_error` |
| `PATCH /api/plays/:id` `{ title?, category? }` | `200 { play }`; `404` |
| `DELETE /api/plays/:id` | `204`; `404` |

`play` es `{ id, matchId, title, category, captureMode, timestamp, isLiveMoment, createdAt }`. El backend no guarda el club, la cancha, el horario ni el video: salen del `matchId` en el frontend, porque los partidos siguen siendo datos de ejemplo (por eso `matchId` es un texto de hasta 100 caracteres, sin validar contra partidos).

## Clubes y canchas

Los clubes y sus canchas viven en la base. Un club se da de alta **por comando** (no hay pantalla ni superadmin); el admin del club gestiona sus canchas desde el panel (`/panel-club`, pestaña «Canchas»), y la landing las lee del listado público.

| Método y ruta | Quién | Respuestas |
|---|---|---|
| `GET /api/clubs?page=&limit=&city=&sport=` | Cualquiera, sin sesión | `200 { clubs, page, limit, total, totalPages }`: una página de clubes (por defecto la 1, con 6; máximo 24) con sus **canchas activas**. `city` y `sport` filtran; con `sport` aparecen los clubes con al menos una cancha activa de ese deporte, cada uno con todas las suyas. Un club sin canchas activas no aparece. Una página fuera de rango devuelve `clubs: []`; un parámetro inválido, `400 validation_error`. Responde con `Cache-Control: no-store`: un cambio del admin se ve al instante. |
| `GET /api/clubs/:id` | Cualquiera, sin sesión | `200 { club }` con sus canchas activas; `404` si no existe o no tiene canchas activas |
| `GET /api/club/courts` | Admin de club | `200 { club, courts }`: su club y **todas** sus canchas (activas o no) |
| `POST /api/club/courts` `{ name, sport, price }` | Admin de club | `201 { court }` (queda activa); `400 validation_error`; `409 court_name_taken`; `409 courts_limit_reached` |
| `PATCH /api/club/courts/:id` `{ name?, sport?, price?, active? }` | Admin de club | `200 { court }`; `400`; `404`; `409 court_name_taken` |
| `DELETE /api/club/courts/:id` | Admin de club | `204`; `404` (no existe, es de otro club o ya estaba borrada) |

- **Cancha:** `{ id, name, sport, price, active }`. El nombre es obligatorio, de hasta 60 caracteres y **único dentro del club** sin distinguir mayúsculas. El deporte es `Fútbol 5`, `Fútbol 7`, `Fútbol 8` o `Fútbol 11`. El precio es un entero de pesos mayor que cero. Un club tiene hasta **50 canchas**, activas o no (sin contar las borradas).
- **Desactivar y borrar son distintos:** desactivar (`active: false`) saca la cancha del sitio y se puede reactivar. Borrar es **lógico**: se marca `deleted_at`, la cancha desaparece de la lista del admin y del sitio y no se puede editar ni reactivar, pero la fila se conserva (para no perder el historial cuando existan las reservas). El nombre de una borrada se puede reutilizar y no cuenta para el tope de 50.
- **Imagen:** `clubs.image_url` y `courts.image_url` son opcionales y se devuelven como `imageUrl` (`null` si no hay). Ninguna ruta las escribe: se cargan directamente en la base.
- **Cada admin solo accede a su club:** la cancha de otro club responde `404`; un jugador recibe `403` y sin sesión `401`.
- **Los datos del club** (nombre, zona, ciudad, dirección) los fija el comando `crear-club` o la base: ningún endpoint los edita.
- **Datos iniciales:** la migración carga 6 clubes y 12 canchas de ejemplo (`estacion-norte`, `la-cantera-crespo`, `polideportivo-belgrano`, `parque-sur-caballito`, `arena-nunez` y `terraza-colegiales`), con los ids que usan los partidos, las cámaras y los carteles QR de ejemplo. Son datos normales: se editan y se desactivan como cualquier otro. En un despliegue real también quedan cargados; para sacarlos del sitio, desactivá sus canchas.

### Dar de alta un club

```bash
# Desarrollo local (lee DATABASE_URL del .env)
npm run crear-club -- --id mi-club --nombre "Mi Club" --zona Palermo --ciudad buenos-aires --direccion "Av. Siempreviva 742"

# Dentro del contenedor (con docker compose up corriendo)
docker compose exec api node dist/cli/crear-club.js --id mi-club --nombre "Mi Club" --zona Palermo --ciudad buenos-aires --direccion "Av. Siempreviva 742"
```

El identificador usa minúsculas, números y guiones (de 3 a 60 caracteres). La ciudad es una de las que conoce el sitio: `buenos-aires`, `rosario` o `cordoba`. Con un identificador inválido o repetido, una ciudad desconocida o un dato vacío, el comando termina con error y no crea nada.

Después se le asigna un admin con `crear-admin --club mi-club …` (el club tiene que existir; si no, el error lista los válidos), y el admin carga sus canchas en el panel. Hasta que haya una cancha activa, el club no se muestra en el sitio.

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

- Canal de la cámara (medido en esta cámara): el `201` es el único que sirve (H.264 1920×1080). El `101` es HEVC (no reproduce en navegadores) y el `102`/`202` anuncian H.264 pero con tamaño 0×0 y ffmpeg no obtiene ningún stream de ellos. Se deja el `201`.
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
| `npm test` | Pruebas (Vitest); las de auth necesitan `TEST_DATABASE_URL` |
| `npm run lint` | Chequeo de tipos (`tsc --noEmit`) |
| `npm run migrate` | Aplica las migraciones pendientes |
| `npm run migrate:create -- <nombre>` | Crea una migración SQL nueva |
| `npm run crear-admin -- …` | Crea un admin de club (ver «Crear una cuenta de prueba») |
| `npm run crear-club -- …` | Da de alta un club (ver «Dar de alta un club») |

### Tests contra la base

Los tests de migraciones y de auth corren contra un PostgreSQL real, en una base aparte que vacían en cada caso. Con el Postgres del compose:

```bash
docker compose up -d db
docker compose exec db psql -U canchas3 -d canchas3 -c "CREATE DATABASE canchas3_test"
TEST_DATABASE_URL=postgres://canchas3:canchas3@localhost:5432/canchas3_test npm test
```

En PowerShell: `$env:TEST_DATABASE_URL="postgres://canchas3:canchas3@localhost:5432/canchas3_test"; npm test`. Si falta la variable, esos tests fallan con un mensaje que explica cómo levantarla; no se saltean.

## Variables de entorno

| Variable | Obligatoria | Por defecto |
|---|---|---|
| `DATABASE_URL` | Sí | — |
| `PORT` | No | `3100` |
| `HOST` | No | `0.0.0.0` |
| `NODE_ENV` | No | `development` |
| `SESSION_COOKIE_SECURE` | No | `true` en `production`, `false` en el resto |
| `PUBLIC_APP_URL` | En producción | `http://localhost:3000` |
| `SMTP_URL` | En producción | vacía (el link se imprime en el log) |
| `MAIL_FROM` | No | `Canchas3 <no-reply@canchas3.example>` |

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
│   ├── db/migrate.ts          # aplica las migraciones al arrancar
│   ├── cli/crear-admin.ts     # comando para crear admins
│   ├── cli/crear-club.ts      # comando para dar de alta clubes
│   ├── lib/errors.ts          # errores de la aplicación
│   ├── modules/auth/          # ingreso de admins y de jugadores, sesiones y límites
│   ├── modules/clubs/         # listado público, canchas del admin y alta de clubes
│   ├── modules/mail/          # envío de mails (consola o SMTP) y mail de acceso
│   ├── modules/plays/         # jugadas de cada jugador
│   └── modules/live/          # cámara en vivo
│       ├── routes.ts          #   GET /api/live/:cameraId/stream
│       ├── rtsp.ts            #   URL RTSP, argumentos de ffmpeg y sanitizado de logs
│       ├── launcher.ts        #   lanzador de ffmpeg (reemplazable en pruebas)
│       └── viewers.ts         #   tope de espectadores
├── migrations/                # esquema de la base (node-pg-migrate)
└── test/                      # pruebas
```
