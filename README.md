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

Un admin de club o un superadmin ingresa con mail y contraseña (mismo formulario y mismas reglas) y recibe una cookie de sesión `c3_session` (`HttpOnly`, `SameSite=Lax`, `Secure` según `SESSION_COOKIE_SECURE`). La sesión dura 8 horas sin uso y se renueva mientras se usa. En la base se guardan el hash `argon2id` de la contraseña y el SHA-256 del token, nunca los valores originales.

| Método y ruta | Respuestas |
|---|---|
| `POST /api/auth/admin/login` `{ email, password }` | `200 { user }` con la cookie; `401 invalid_credentials` (mismo error si el mail no existe o la clave es incorrecta); `429 too_many_attempts`; `400 validation_error` |
| `POST /api/auth/admin/request-reset` `{ email }` | `202 { message }` (**el mismo para cualquier mail válido**, sea de un admin, de un jugador o sin cuenta); `429 too_many_requests`; `400 validation_error` |
| `POST /api/auth/admin/reset-password` `{ token, password }` | `204` (no abre sesión); `410 link_used`; `410 link_expired`; `400 validation_error` (contraseña de menos de 10 caracteres: **no consume el link**) |
| `GET /api/auth/admin/invitation?token=` | `200 { clubName, adminName }` sin consumir el link; `410 link_used` / `410 link_expired` |
| `POST /api/auth/admin/accept-invite` `{ token, password }` | `200 { user }` **con la cookie de sesión** (el admin queda Activo); `410 link_used`; `410 link_expired`; `400 validation_error` (contraseña corta: **no consume el link**) |
| `POST /api/auth/logout` | `204`; borra la sesión y la cookie |
| `GET /api/auth/me` | `200 { user }` o `200 { user: null }` |

`user` es `{ id, email, name, role, clubId }`; `role` es `club_admin` (con su `clubId`) o `superadmin` (con `clubId: null`). Una cuenta **dada de baja**, un admin **invitado que todavía no eligió contraseña** y un mail inexistente reciben el mismo `401 invalid_credentials` (y cuentan como intento fallido). Después de **5 intentos fallidos en 15 minutos**, por cuenta o por IP, el ingreso responde `429` aunque la contraseña sea correcta, hasta que pase la ventana.

> La IP sale de `X-Forwarded-For` (`trustProxy`). Es confiable solo si la API se publica detrás del proxy (Vite en desarrollo, nginx en producción) y no directamente.

### Recuperar la contraseña

Un admin que olvidó su contraseña la recupera por mail:

1. En el formulario de admin toca «Olvidé mi contraseña» y pone su mail. La respuesta es siempre la misma; **solo el mail de un admin de club o de un superadmin que no esté dado de baja recibe el link** (también un admin invitado que todavía no eligió contraseña).
2. El link (`<PUBLIC_APP_URL>/recuperar?token=…`) vale **una sola vez y 15 minutos**, y abre una página donde elige la contraseña nueva (10 caracteres o más). Una contraseña corta no gasta el link.
3. Al cambiarla, **se cierran todas sus sesiones** y no se abre una nueva: ingresa de nuevo con la contraseña nueva. Los intentos fallidos de ingreso no se borran: si estaba bloqueado, la espera de 15 minutos sigue.

Se permiten 3 pedidos por mail cada 15 minutos (cuentan todos, se envíe o no un link), con un límite **independiente** del de los links de acceso de jugadores. En desarrollo el mail se ve en Mailpit (`http://localhost:8025`).

> No hay un comando para cambiar la contraseña de un admin que ya existe. Si perdió también el acceso a su mail, hay que borrar su usuario en la base y volver a crearlo con `crear-admin`.

### Crear un superadmin

El superadmin opera la plataforma (clubes, canchas y admins de club) desde `/panel-plataforma`. **Es la única forma de crear uno**: ninguna ruta ni pantalla vuelve superadmin a un usuario. La cuenta no tiene club; el mail no puede tener ya una cuenta de ningún rol. La contraseña se pide por teclado (10 caracteres o más) o se lee de `ADMIN_PASSWORD`; nunca va como argumento.

```bash
# Desarrollo local (lee DATABASE_URL del .env)
npm run crear-superadmin -- --email root@canchas3.example --nombre "Operación"

# Dentro del contenedor (con docker compose up corriendo)
docker compose exec api node dist/cli/crear-superadmin.js --email root@canchas3.example --nombre "Operación"
```

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

El jugador no tiene contraseña: pone su mail y recibe un mail con **un código de 6 dígitos y un link**, de un solo uso, que vencen a los **15 minutos**. Usar uno invalida el otro (viven en la misma fila de `login_tokens`). El link apunta a la página `/acceso` del frontend (`<PUBLIC_APP_URL>/acceso?token=…`), que pide confirmar con un botón; recién ahí el backend consume el link. Así un programa del correo que abre el link antes que la persona no lo gasta.

| Método y ruta | Respuestas |
|---|---|
| `POST /api/auth/player/request-link` `{ email }` | `202 { message }` (**el mismo para cualquier mail válido**, tenga o no cuenta, incluso si es de un admin); `429 too_many_requests` (3 pedidos por mail cada 15 minutos); `400 validation_error` |
| `POST /api/auth/player/confirm` `{ token }` | `200 { user }` con la cookie `c3_session`; `410 link_used`; `410 link_expired` (vencido o inexistente) |
| `POST /api/auth/player/confirm-code` `{ email, code }` | `200 { user }` con la cookie `c3_session` (igual que el link; crea la cuenta si es el primer ingreso); `400 invalid_code` (código equivocado, vencido, ya usado, formato inválido, mail sin pedidos o mail de un admin: **el mismo error para todos**); `429 too_many_code_attempts` |

- La cuenta de un mail nuevo se crea al confirmar el link, solo con el mail (`user.name` es `null`). Con el mail de un admin no se envía nada.
- La sesión del jugador dura **30 días sin uso** y se renueva mientras entra al sitio. Puede tener varias a la vez; `POST /api/auth/logout` cierra solo la del dispositivo actual.
- Pedir un link nuevo no invalida los anteriores; cada uno vence solo.
- Los links de acceso y los de recuperación de contraseña comparten tablas pero llevan un propósito (`access` o `password_reset`): uno no sirve para el otro.
- **El código:** son 6 dígitos (acepta el mail en mayúsculas y el código pegado con espacios). En la base solo queda un hash (`sha256(mail en minúsculas + ':' + código)`), nunca el código. El asunto del mail no lo lleva (se vería en las notificaciones del teléfono bloqueado).
- **Intentos:** cada código equivocado suma un intento a **todos** los pedidos vigentes del mail, así que pedir códigos nuevos no multiplica los intentos. A los **5 errores** el código deja de aceptarse (`429 too_many_code_attempts`, ni siquiera el correcto) y hay que pedir uno nuevo; el link de ese pedido sigue valiendo hasta vencer.
- **Entrega:** el mail se envía en segundo plano, para que la respuesta no tarde distinto según el caso. Si el servidor de mail falla, se **reintenta hasta 3 veces** (esperas de 2 y 10 segundos) y, si se agotan, se registra un solo error con el tipo de falla y los intentos, sin el mail, el link ni el código. La recuperación de contraseña de admin se envía igual; la invitación de un admin y la confirmación de una reserva esperan el resultado y **no** se reintentan. No hay cola: si el proceso se reinicia entre intentos, el jugador usa «Reenviar».
- **Log:** por cada mail enviado por SMTP queda una línea con los destinatarios aceptados y rechazados y el código de respuesta del servidor (nunca las direcciones). Al arrancar, el backend registra por qué medio salen los mails y, si es el buzón de pruebas o la consola, una advertencia `ATENCIÓN: … NO llegan a ninguna casilla real`.

### Mails en desarrollo

| `SMTP_URL` | Qué pasa |
|---|---|
| vacía (`npm run dev` sin Docker) | El link **se imprime en el log del backend** y no se envía nada |
| `smtp://mailpit:1025` (`docker compose`) | Se envía a **Mailpit**, un buzón de pruebas: abrí `http://localhost:8025` para ver los mails y tocar el link (`MAILPIT_UI_PORT` cambia el puerto) |
| una URL de un proveedor | Se envía de verdad |

> **Si «el mail no llega» en desarrollo:** mirá el log de arranque. `docker-compose.override.yml` apunta `SMTP_URL` a Mailpit (`smtp://mailpit:1025`); construir con `SMTP_URL=smtp://mailpit:1025 docker compose up -d --build api` manda **todo** al buzón de pruebas, aunque `backend/.env` tenga un SMTP real. Para volver al SMTP real de `.env` alcanza con `docker compose up -d api` (sin esa variable). Para comprobarlo: pedí el ingreso con un mail real y buscá en el log `Mail entregado al servidor SMTP` con `responseCode` 250.

### Para que los mails lleguen a la bandeja (y no a correo no deseado)

Que el servidor acepte el mail no garantiza que llegue a la bandeja principal. Con un dominio propio configurá:

- **Remitente del mismo dominio:** `MAIL_FROM` con una dirección de tu dominio (no `@gmail.com` ni el `canchas3.example` por defecto).
- **SPF:** registro TXT que autoriza al servidor de tu proveedor SMTP a enviar por tu dominio.
- **DKIM:** firma del proveedor, publicada como registro DNS (te lo da el proveedor).
- **DMARC:** registro TXT `_dmarc` con una política (empezá con `p=none` y mirá los reportes).
- Usá el SMTP de un proveedor de envío (no una casilla personal) y probá con un mail real a Gmail y Outlook antes de abrir el sitio a jugadores.

Variables: `PUBLIC_APP_URL` (dirección del frontend; por defecto `http://localhost:3000`), `SMTP_URL` y `MAIL_FROM` (por defecto `Canchas3 <no-reply@canchas3.example>`). **En producción `PUBLIC_APP_URL` y `SMTP_URL` son obligatorias**: sin ellas la API no arranca, para no dejar en el log los links de acceso de los jugadores. Guardá `SMTP_URL` como secreto de la plataforma.

## Jugadas

Cada jugada es de su dueño: una jugada ajena responde `404`, y los admins de club reciben `403`. Todas las rutas piden sesión de jugador (`401` sin sesión).

| Método y ruta | Respuestas |
|---|---|
| `GET /api/plays` | `200 { plays }`, las del jugador, de la más reciente a la más antigua |
| `POST /api/plays` `{ matchId, title, category?, captureMode?, timestamp, isLiveMoment?, clipStart?, clipEnd? }` | `201 { play }`; `409 plays_limit_reached` (tope de 200 por jugador); `400 validation_error` (también por un fragmento inválido) |
| `PATCH /api/plays/:id` `{ title?, category? }` | `200 { play }`; `404` |
| `GET /api/plays/:id/clip` | El mp4 del fragmento de la jugada (ver «Fragmento de una jugada»); `404` (ajena, inexistente, en vivo o con la grabación no disponible); `503 clip_busy`; `504 clip_timeout`; `502 clip_failed` |
| `DELETE /api/plays/:id` | `204`; `404` |

`play` es `{ id, matchId, title, category, captureMode, timestamp, isLiveMoment, clipStart, clipEnd, createdAt, recording }`. `matchId` es un texto de hasta 100 caracteres que **no se valida** contra ninguna grabación: puede ser una grabación, una cámara en vivo o algo que ya no existe. `recording` trae los datos de la grabación (ver «Grabaciones») o `null` si el `matchId` no corresponde a una grabación visible.

### Fragmento de una jugada

Cada jugada de una grabación guarda su **fragmento**: `clipStart` y `clipEnd`, en segundos del video.

- **Por defecto** es de 15 s antes a 5 s después del momento marcado (`timestamp`), con el inicio mínimo en 0. Si el pedido trae el fragmento, tiene que traer los dos valores, durar de **3 a 120 segundos**, tener el fin posterior al inicio y **contener** el momento marcado; si no, `400 validation_error`. Una jugada **en vivo** (`isLiveMoment`) guarda `null` en los dos (no hay grabación), aunque el pedido traiga un fragmento. La migración completó las jugadas anteriores con el fragmento por defecto. El fragmento no se edita después de guardar la jugada.
- **Descarga:** `GET /api/plays/:id/clip` corta con ffmpeg el video de la grabación entre `clipStart` y `clipEnd` y lo entrega como `video/mp4` (`Content-Disposition: attachment; filename="jugada-<título>.mp4"`). Solo la puede pedir el jugador dueño. El video sale de la grabación guardada en la base: el pedido **no puede** indicar ningún archivo ni dirección (cualquier parámetro se ignora). No hay descarga del partido completo.
- **Cómo se corta:** se recodifica (H.264 + AAC, `-preset veryfast`) con un alto máximo de **720**, a un archivo temporal en la carpeta temporal del sistema (`canchas3-clip-*.mp4`) que se borra siempre al terminar, falle, venza o el jugador corte la descarga. No se guardan los fragmentos generados. Si el fragmento pasa del final del video, sale hasta donde haya video; si empieza después del final, `502 clip_failed`.
- **Límites para el VPS:** como mucho `CLIP_MAX_CONCURRENT` cortes a la vez (por defecto **2**; el siguiente recibe `503 clip_busy` con «probá en unos segundos», sin cola) y como mucho `CLIP_TIMEOUT_MS` de trabajo por corte (por defecto **60000**; al vencer, se detiene ffmpeg y responde `504 clip_timeout` con «probá con uno más corto»). Los dos valores se cambian por variable de entorno.
- **Demostración:** el video de demostración dura **10 s**, así que un fragmento por defecto de 20 s sale de unos 10 s.

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
- **Los datos del club** (nombre, zona, ciudad, dirección) se dan de alta con el comando `crear-club` o por el panel de la plataforma, y **solo el superadmin** los edita (`PATCH /api/platform/clubs/:id`); el identificador no se cambia nunca. Un admin de club no tiene ninguna forma de cambiarlos.
- **Club activo o desactivado:** un club desactivado no aparece en `GET /api/clubs` ni en `GET /api/clubs/:id`, pero conserva sus canchas y sus admins, y estos siguen entrando a su panel (`GET /api/club/courts` trae `club.active`). Los clubes **no se borran**.
- **Datos iniciales:** la migración carga 6 clubes y 12 canchas de ejemplo (`estacion-norte`, `la-cantera-crespo`, `polideportivo-belgrano`, `parque-sur-caballito`, `arena-nunez` y `terraza-colegiales`), con los ids que usan los partidos, las cámaras y los carteles QR de ejemplo. Son datos normales: se editan y se desactivan como cualquier otro. En un despliegue real también quedan cargados; para sacarlos del sitio, desactivá sus canchas.

## Horarios y reservas

Cada cancha tiene un **horario semanal** y se puede **reservar** un turno de 60 minutos, sin pago. Todo se interpreta en hora de Argentina (UTC-3, sin horario de verano).

| Método y ruta | Quién | Respuestas |
|---|---|---|
| `GET /api/courts/:courtId/slots?date=AAAA-MM-DD` | Cualquiera, sin sesión | `200 { court, date, slots: [{ startsAt, time }] }` con los turnos libres de ese día (vacío si la cancha no tiene horarios o ese día está cerrada); `400 validation_error` si la fecha no es válida o está fuera de la ventana; `404` si la cancha está desactivada, borrada o es de un club desactivado |
| `POST /api/courts/:courtId/bookings` `{ startsAt, name, email, phone? }` | Cualquiera; con sesión de jugador alcanza `{ startsAt }` | `201 { booking, emailSent }`; `400 validation_error`; `404` (cancha no reservable o sin horarios); `409 slot_taken`; `429 too_many_bookings` |
| `GET /api/club/courts/:courtId/schedule` | Admin de club | `200 { days: [{ weekday, startHour, endHour }] }`; `404` si la cancha es de otro club o está borrada |
| `PUT /api/club/courts/:courtId/schedule` `{ days }` | Admin de club | `200 { days }`: reemplaza **todo** el horario; `400 validation_error` indica el día; `404` |
| `GET /api/club/bookings` | Admin de club | `200 { bookings }` de las canchas de su club, de la fecha de turno más lejana a la más cercana |
| `GET` y `PUT /api/platform/clubs/:clubId/courts/:courtId/schedule` | Superadmin | Igual que las del admin, sobre cualquier club |
| `GET /api/platform/clubs/:clubId/bookings` | Superadmin | `200 { club, bookings }` |

- **Horario:** `weekday` va de 1 (lunes) a 7 (domingo); `startHour` de 0 a 23 y `endHour` de 1 a 24, horas enteras, con el cierre posterior a la apertura. Un día que no está en `days` es un día cerrado; una cancha sin días no tiene turnos y no se puede reservar. Cambiar el horario **no toca las reservas ya hechas**. Los listados de canchas del panel traen `hasSchedule`.
- **Turnos libres:** se calculan al consultar (horario del día menos reservas); no hay una fila por turno. Se ofrecen los que empiezan al menos 1 hora después de ahora y hasta hoy + 14 días.
- **Doble reserva:** la impide el índice único `bookings (court_id, starts_at)` de la base; quien pierde recibe `409 slot_taken`. Eso vale mientras todos los turnos sean de 60 minutos en hora en punto: si algún día cambia la duración, hay que cambiar el índice.
- **Quién reserva:** un invitado manda nombre y mail (teléfono opcional); un jugador con sesión usa los de su cuenta y la reserva queda asociada a ella. La reserva guarda el precio de la cancha al reservar.
- **Mail de confirmación:** sale después de guardar la reserva (puede tardar hasta los tiempos máximos del SMTP). Si falla, la reserva queda y la respuesta trae `emailSent: false`; el log registra solo el id de la reserva y el tipo de error.
- **Límite por IP:** 10 reservas cada 15 minutos por IP (`MAX_BOOKINGS_PER_IP` en `src/modules/bookings/bookings.ts`); se cuentan en la tabla `bookings`, no en `login_attempts`.
- **Fuera de alcance por ahora:** cancelar o mover reservas, bloqueos, pago online. Las canchas de ejemplo no traen horarios: se cargan desde el panel.

### Dar de alta un club

```bash
# Desarrollo local (lee DATABASE_URL del .env)
npm run crear-club -- --id mi-club --nombre "Mi Club" --zona Palermo --ciudad buenos-aires --direccion "Av. Siempreviva 742"

# Dentro del contenedor (con docker compose up corriendo)
docker compose exec api node dist/cli/crear-club.js --id mi-club --nombre "Mi Club" --zona Palermo --ciudad buenos-aires --direccion "Av. Siempreviva 742"
```

El identificador usa minúsculas, números y guiones (de 3 a 60 caracteres). La ciudad es una de las que conoce el sitio: `buenos-aires`, `rosario` o `cordoba`. Con un identificador inválido o repetido, una ciudad desconocida o un dato vacío, el comando termina con error y no crea nada.

Después se le asigna un admin con `crear-admin --club mi-club …` (el club tiene que existir; si no, el error lista los válidos), y el admin carga sus canchas en el panel. Hasta que haya una cancha activa, el club no se muestra en el sitio.

## Plataforma (superadmin)

Todas las rutas de `/api/platform/...` son **solo para un superadmin con sesión**: un admin de club o un jugador reciben `403` y sin sesión `401`, sin importar lo que muestre la pantalla. Responden con `Cache-Control: no-store`.

| Método y ruta | Respuestas |
|---|---|
| `GET /api/platform/clubs?q=&page=&limit=` | `200 { clubs, page, limit, total, totalPages }`: **todos** los clubes (activos y desactivados) con `{ id, name, zone, city, address, active, activeCourts, admins }`; de a 20 (máximo 50). `q` busca por nombre sin distinguir mayúsculas ni tildes. `admins` cuenta invitados y activos, no los dados de baja |
| `POST /api/platform/clubs` `{ id, name, zone, city, address }` | `201 { club }`; `400 validation_error` (mismas reglas que `crear-club`); `409 club_id_taken` |
| `PATCH /api/platform/clubs/:id` `{ name?, zone?, city?, address?, active? }` | `200 { club }`; `400 club_id_immutable` si trae `id`; `400` ante un dato desconocido o inválido; `404` |
| `GET /api/platform/clubs/:clubId/courts` | `200 { club, courts }`: todas las canchas del club (activas o no, sin las borradas) |
| `POST` / `PATCH` / `DELETE /api/platform/clubs/:clubId/courts[/:courtId]` | Las mismas reglas y respuestas que `/api/club/courts` (tope de 50, nombre único, borrado lógico); `404` si el club no existe o la cancha es de otro club |
| `GET /api/platform/clubs/:clubId/admins` | `200 { club, admins }`: `{ id, email, name, status, invitationExpired }` con `status` `invited` / `active` / `deactivated` |
| `POST /api/platform/clubs/:clubId/admins` `{ email, name }` | `201 { admin, emailSent }`; `409 email_is_admin` / `email_is_player` / `email_other_club`; `429 too_many_requests`; `400 validation_error` |
| `POST /api/platform/clubs/:clubId/admins/:adminId/invitation` | `200 { admin, emailSent }`; `409 admin_not_invited` (solo se reenvía a un Invitado); `429`; `404` |
| `DELETE /api/platform/clubs/:clubId/admins/:adminId` | `204` (baja lógica); `404` (no existe, es de otro club o ya estaba de baja) |

### Admins de club por invitación

El superadmin no conoce ni elige la contraseña de nadie ni cambia un mail:

1. **Invitar** crea la cuenta del club **sin contraseña** (`invited`) y manda un mail con un link (`<PUBLIC_APP_URL>/invitacion?token=…`) de **72 horas y un solo uso**. A diferencia de los demás mails, el envío **se espera**: si el servidor de mail falla, la cuenta queda creada, la respuesta trae `emailSent: false` y el superadmin puede reenviar. En el log solo queda el tipo de error, nunca el link ni el destinatario.
2. El admin abre el link, elige su contraseña (10 caracteres o más, que se valida antes de gastar el link) y **queda con la sesión abierta** (`active`). Si la cuenta se dio de baja antes o ya tenía contraseña, el link se informa como vencido.
3. **Reenviar** solo se permite a un `invited`, venza o no la anterior, e **invalida el link viejo**. Invitar y reenviar comparten un límite de **3 envíos por mail cada 15 minutos**, independiente del de acceso y recuperación.
4. **Dar de baja** marca `deactivated_at`, cierra todas sus sesiones y borra sus links sin usar. La cuenta se conserva: no ingresa ni recibe la recuperación de contraseña. Se la puede **reinvitar al mismo club** (vuelve sin contraseña); un mail de otro club, de un admin activo/invitado, de un superadmin o de un jugador se rechaza.

El estado de un admin no se guarda: sale de `deactivated_at` y `password_hash`.

## Grabaciones

Las grabaciones de partidos son **registros reales de la base** (tabla `recordings`): un turno (cancha + inicio), un estado (`available`, `processing`, `unavailable` o `error`), la duración y el **nombre** del archivo de video. No tienen título, marcador ni torneo. Por ahora el video de todas es **uno solo, de demostración** (`videos/demo-partido.mp4`); el en vivo es otra cosa (ver «Cámara en vivo») y no se guarda como grabación.

| Método y ruta | Quién | Respuestas |
|---|---|---|
| `GET /api/recordings?clubId=&courtId=&date=AAAA-MM-DD` | Cualquiera, sin sesión | `200 { recordings }`: solo las **reproducibles** (`available` con archivo), de la más reciente a la más antigua; `400 validation_error` si la fecha no es válida |
| `GET /api/recordings/:id` | Cualquiera, sin sesión | `200 { recording }` en **cualquier estado** (el reproductor explica por qué no se puede ver); `404` si no existe, el club está desactivado o la cancha está borrada |
| `GET /api/club/recordings` | Admin de club | `200 { recordings }` de las canchas de su club, en cualquier estado, solo lectura; `401` / `403` |
| `GET /api/videos/:file` | Cualquiera, sin sesión | El mp4 con soporte de `Range` (`200`, `206`, `416`); `404` si el nombre no es un mp4 simple o no existe |

- **Forma de una grabación:** `{ id, club: { id, name }, court: { id, name }, startsAt, date, time, status, durationSeconds, videoUrl }`. `date` y `time` están en hora de Argentina; `videoUrl` (`/api/videos/<archivo>`) solo viene si está `available`.
- **Visibilidad:** un club desactivado o una cancha borrada esconden sus grabaciones; una cancha **desactivada** conserva las suyas (es historial).
- **Videos:** la API los sirve desde `VIDEOS_DIR` (por defecto `./videos`; con Docker, `./videos` se monta de solo lectura en `/data/videos`). El nombre se valida (`^[A-Za-z0-9][A-Za-z0-9._-]*\.mp4$`) y nunca se lee fuera de la carpeta. Cuando haya un nginx delante, puede servir esa misma carpeta sin cambiar el modelo.
- **Jugadas:** cada jugada de `/api/plays` trae `recording` (los datos de su grabación) o `null` si su partido no corresponde a una grabación visible: una jugada en vivo, o una cuya grabación ya no existe (se conserva y se muestra como no disponible).

### Cargar las grabaciones de demostración

Un comando crea (o renueva) 7 grabaciones de ejemplo en cada uno de los **3 días anteriores a hoy** (hora de Argentina), con los ids de siempre para ayer (`match-en-f5-1900`, …) y sufijo `-d2` / `-d3` para los otros. Es **idempotente**: se puede volver a correr cuando las fechas queden viejas y no duplica nada. **No corre solo** al arrancar la API.

```bash
# Desarrollo local (lee DATABASE_URL y VIDEOS_DIR del .env)
npm run cargar-grabaciones-demo

# Dentro del contenedor (con docker compose up corriendo)
docker compose exec api node dist/cli/cargar-grabaciones-demo.js
```

> **El video de demostración no está en el repositorio** (`videos/` pesa 5,5 MB y no se versiona). Quien clone el backend tiene que copiar a mano un mp4 como `backend/videos/demo-partido.mp4` (de ~10 segundos, H.264 + AAC) antes de cargar las grabaciones de demostración o probar las descargas de fragmentos.

Si falta `videos/demo-partido.mp4` no carga nada y lo avisa; una cancha de ejemplo que no existe se omite con un aviso, y nunca pisa una grabación real que ocupe el mismo turno.

### Pendiente: almacenamiento de grabaciones reales

Esto sirve para la demostración. **No está resuelto** cómo se guardan las grabaciones reales: cuántas habrá y cuánto pesan, cuánto tiempo se conservan (retención), cuánto disco hay en el servidor y dónde viven los videos reales (disco del VPS, volumen o almacenamiento externo). Tampoco hay carga desde el panel ni grabación automática desde la cámara, y los videos son públicos (sin política de acceso). Antes de grabar de verdad hay que decidir todo eso.

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
| `npm run crear-superadmin -- …` | Crea un superadmin (ver «Crear un superadmin») |
| `npm run crear-club -- …` | Da de alta un club (ver «Dar de alta un club») |
| `npm run cargar-grabaciones-demo` | Carga o renueva las grabaciones de demostración (ver «Grabaciones») |

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
| `VIDEOS_DIR` | No | `./videos` (con Docker, `/data/videos`) |
| `CLIP_MAX_CONCURRENT` | No | `2` (cortes de fragmentos a la vez) |
| `CLIP_TIMEOUT_MS` | No | `60000` (tiempo máximo de cada corte) |

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
│   ├── cli/crear-superadmin.ts # comando para crear superadmins
│   ├── cli/password-prompt.ts # pedido de la contraseña de los comandos
│   ├── modules/platform/      # API de la plataforma (clubes, canchas por club, admins)
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
