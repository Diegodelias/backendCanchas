import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../../app.js';
import { AppError } from '../../lib/errors.js';
import { accessEmail } from '../mail/accessEmail.js';
import { getSiteName } from '../site/settings.js';
import { passwordResetEmail } from '../mail/passwordResetEmail.js';
import { sendWithRetries } from '../mail/retries.js';
import { isLoginBlocked, pruneOldAttempts, recordFailedLogin } from './attempts.js';
import {
  consumeAccessCode,
  consumeLoginToken,
  createAccessLogin,
  createLoginToken,
  isLinkRequestBlocked,
  pruneOldLinks,
  recordLinkRequest,
  whyUnusable,
} from './links.js';
import { hashPassword, MIN_PASSWORD_LENGTH, verifyAgainstDummy, verifyPassword } from './passwords.js';
import { createSession, deleteSession, hashToken, resolveSession, SESSION_COOKIE } from './sessions.js';
import { toSessionUser, type UserRow } from './types.js';

const loginBody = z.object({
  email: z.string().trim().min(1, 'Ingresá tu mail.').max(254),
  password: z.string().min(1, 'Ingresá tu contraseña.').max(1024),
});

const requestLinkBody = z.object({
  email: z.email({ error: 'Ingresá un correo electrónico válido (ej. tu_nombre@gmail.com).' }).max(254),
});

const confirmBody = z.object({
  token: z.string().min(1, 'Falta el link de acceso.').max(200),
});

const confirmCodeBody = z.object({
  email: z.string().trim().min(1).max(254),
  code: z.string().min(1).max(32),
});

const INVALID_CODE = () =>
  new AppError(400, 'invalid_code', 'El código no es correcto o venció. Revisá el último mail o pedí uno nuevo.');

const TOO_MANY_CODE_ATTEMPTS = () =>
  new AppError(429, 'too_many_code_attempts', 'Hubo demasiados intentos con el código. Pedí un código nuevo.');

/** Mismo texto para jugador existente, mail nuevo y mail de admin: no revela qué cuentas existen. */
const LINK_REQUESTED_MESSAGE =
  'Si el mail está bien escrito, te enviamos un código y un link de acceso. Revisá tu bandeja de entrada y el correo no deseado. Vencen en 15 minutos.';

const resetPasswordBody = z.object({
  token: z.string().min(1, 'Falta el link de recuperación.').max(200),
  password: z
    .string()
    .min(MIN_PASSWORD_LENGTH, `La contraseña debe tener ${MIN_PASSWORD_LENGTH} caracteres o más.`)
    .max(1024, 'La contraseña es demasiado larga.'),
});

const acceptInviteBody = z.object({
  token: z.string().min(1, 'Falta el link de invitación.').max(200),
  password: z
    .string()
    .min(MIN_PASSWORD_LENGTH, `La contraseña debe tener ${MIN_PASSWORD_LENGTH} caracteres o más.`)
    .max(1024, 'La contraseña es demasiado larga.'),
});

const invitationQuery = z.object({
  token: z.string().min(1, 'Falta el link de invitación.').max(200),
});

/** Mismo texto para admin, jugador y mail sin cuenta: no revela qué cuentas existen. */
const RESET_REQUESTED_MESSAGE =
  'Si el mail es de un administrador, te enviamos un link para elegir una contraseña nueva. Revisá tu bandeja de entrada y el correo no deseado. El link vence en 15 minutos.';

const TOO_MANY_LINK_REQUESTS = () =>
  new AppError(429, 'too_many_requests', 'Pediste demasiados links. Esperá 15 minutos y probá de nuevo.');

const LINK_USED = () => new AppError(410, 'link_used', 'Este link ya se usó. Pedí uno nuevo con tu mail.');

const LINK_EXPIRED = () =>
  new AppError(410, 'link_expired', 'Este link venció o no es válido. Pedí uno nuevo con tu mail.');

const INVITE_USED = () =>
  new AppError(410, 'link_used', 'Esta invitación ya se usó. Si no podés entrar, pedí que te la reenvíen.');

const INVITE_EXPIRED = () =>
  new AppError(410, 'link_expired', 'Esta invitación venció o no es válida. Pedí que te la reenvíen.');

const INVALID_CREDENTIALS = () =>
  new AppError(401, 'invalid_credentials', 'El mail o la contraseña no son correctos.');

const TOO_MANY_ATTEMPTS = () =>
  new AppError(
    429,
    'too_many_attempts',
    'Hubo demasiados intentos fallidos. Esperá 15 minutos y probá de nuevo.',
  );

export async function authRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db, config } = deps;
  const now = deps.now ?? (() => new Date());
  const mailer = deps.mailer;
  if (!mailer) throw new Error('authRoutes necesita un mailer (lo arma buildApp).');

  const cookieOptions = {
    httpOnly: true,
    sameSite: 'lax' as const,
    path: '/',
    secure: config.SESSION_COOKIE_SECURE,
  };
  const clearCookie = (reply: FastifyReply) => reply.clearCookie(SESSION_COOKIE, cookieOptions);

  // POST /api/auth/admin/login -> 200 { user } con la cookie de sesión.
  app.post('/auth/admin/login', async (req, reply) => {
    const { email, password } = loginBody.parse(req.body);
    const at = now();

    // El límite se mira antes de verificar: bloqueado, ni siquiera la clave correcta entra.
    if (await isLoginBlocked(db, email, req.ip, at)) throw TOO_MANY_ATTEMPTS();

    const [user] = await db.query<UserRow & { deactivated_at: Date | null }>(
      `SELECT id, email, name, role, club_id, password_hash, deactivated_at
         FROM users WHERE lower(email) = lower($1) AND role IN ('club_admin', 'superadmin')`,
      [email],
    );
    // Una cuenta dada de baja, un admin invitado que todavía no eligió contraseña y un mail inexistente
    // pasan por la misma verificación falsa y dan el mismo error: no se distinguen desde afuera.
    const usable = user && !user.deactivated_at && user.password_hash ? user : null;
    const ok = usable
      ? await verifyPassword(usable.password_hash!, password)
      : await verifyAgainstDummy(password);

    if (!user || !usable || !ok) {
      await recordFailedLogin(db, email, req.ip, at);
      throw INVALID_CREDENTIALS();
    }

    await pruneOldAttempts(db, at);
    // Un navegador con otra sesión (de jugador u otro admin) la cierra al ingresar.
    await deleteSession(db, req.cookies[SESSION_COOKIE]);
    const token = await createSession(db, user.id, user.role, at);
    reply.setCookie(SESSION_COOKIE, token, cookieOptions);
    return { user: toSessionUser(user) };
  });

  // POST /api/auth/player/request-link -> 202 con el mismo cuerpo para cualquier mail válido.
  app.post('/auth/player/request-link', async (req, reply) => {
    const { email: typed } = requestLinkBody.parse(req.body);
    const email = typed.toLowerCase();
    const at = now();

    await pruneOldLinks(db, at);
    if (await isLinkRequestBlocked(db, 'access', email, at)) throw TOO_MANY_LINK_REQUESTS();
    // Se cuenta todo pedido, se envíe o no un link: si no, el tope delataría los mails de admin.
    await recordLinkRequest(db, 'access', email, req.ip, at);

    const [existing] = await db.query<{ role: string }>(
      `SELECT role FROM users WHERE lower(email) = lower($1)`,
      [email],
    );
    if (existing?.role !== 'club_admin') {
      const { token, code } = await createAccessLogin(db, email, at);
      const link = `${config.PUBLIC_APP_URL}/acceso?token=${encodeURIComponent(token)}`;
      // En segundo plano: esperar el envío haría que «se envió» tardara más que «no se envió nada».
      // Se reintenta hasta 3 veces; el log solo lleva el tipo de error: ni el link, ni el código ni el destinatario.
      const siteName = await getSiteName(db);
      sendWithRetries(mailer, accessEmail(email, link, code, siteName), app.log, 'No se pudo enviar el mail de acceso', deps.mailRetryDelaysMs);
    }
    return reply.status(202).send({ message: LINK_REQUESTED_MESSAGE });
  });

  // POST /api/auth/player/confirm -> 200 { user } con la cookie de sesión; 410 si el link no sirve.
  app.post('/auth/player/confirm', async (req, reply) => {
    const { token } = confirmBody.parse(req.body);
    const at = now();

    const consumed = await consumeLoginToken(db, 'access', token, at);
    if (!consumed.ok) throw consumed.reason === 'used' ? LINK_USED() : LINK_EXPIRED();

    // La cuenta de un mail nuevo se crea acá; ON CONFLICT cubre dos confirmaciones del mismo mail a la vez.
    await db.query(`INSERT INTO users (email, role) VALUES ($1, 'player') ON CONFLICT DO NOTHING`, [consumed.email]);
    const [user] = await db.query<UserRow>(
      `SELECT id, email, name, role, club_id, password_hash FROM users WHERE lower(email) = lower($1)`,
      [consumed.email],
    );
    // El mail se volvió de un admin después de pedir el link: no se abre sesión de jugador.
    if (!user || user.role !== 'player') throw LINK_EXPIRED();

    await deleteSession(db, req.cookies[SESSION_COOKIE]);
    const sessionToken = await createSession(db, user.id, user.role, at);
    reply.setCookie(SESSION_COOKIE, sessionToken, cookieOptions);
    return { user: toSessionUser(user) };
  });

  // POST /api/auth/player/confirm-code { email, code } -> 200 { user } con la cookie de sesión; 400 si no sirve.
  app.post('/auth/player/confirm-code', async (req, reply) => {
    const { email: typed, code: typedCode } = confirmCodeBody.parse(req.body);
    const email = typed.toLowerCase();
    const code = typedCode.replace(/\s+/g, '');
    const at = now();

    // Un código con formato inválido tampoco dice nada del mail: mismo error que uno equivocado.
    if (!/^\d{6}$/.test(code)) throw INVALID_CODE();
    const consumed = await consumeAccessCode(db, email, code, at);
    if (!consumed.ok) throw consumed.reason === 'too_many' ? TOO_MANY_CODE_ATTEMPTS() : INVALID_CODE();

    await db.query(`INSERT INTO users (email, role) VALUES ($1, 'player') ON CONFLICT DO NOTHING`, [consumed.email]);
    const [user] = await db.query<UserRow>(
      `SELECT id, email, name, role, club_id, password_hash FROM users WHERE lower(email) = lower($1)`,
      [consumed.email],
    );
    // El mail se volvió de un admin después de pedir el código: no se abre sesión de jugador.
    if (!user || user.role !== 'player') throw INVALID_CODE();

    await deleteSession(db, req.cookies[SESSION_COOKIE]);
    const sessionToken = await createSession(db, user.id, user.role, at);
    reply.setCookie(SESSION_COOKIE, sessionToken, cookieOptions);
    return { user: toSessionUser(user) };
  });

  // POST /api/auth/admin/request-reset -> 202 con el mismo cuerpo para cualquier mail válido.
  app.post('/auth/admin/request-reset', async (req, reply) => {
    const { email: typed } = requestLinkBody.parse(req.body);
    const email = typed.toLowerCase();
    const at = now();

    await pruneOldLinks(db, at);
    // Su propio límite, independiente del de los links de acceso; cuenta todo pedido, se envíe o no un link.
    if (await isLinkRequestBlocked(db, 'password_reset', email, at)) throw TOO_MANY_LINK_REQUESTS();
    await recordLinkRequest(db, 'password_reset', email, req.ip, at);

    const [admin] = await db.query<{ id: string }>(
      `SELECT id FROM users
        WHERE lower(email) = lower($1) AND role IN ('club_admin', 'superadmin') AND deactivated_at IS NULL`,
      [email],
    );
    if (admin) {
      const token = await createLoginToken(db, 'password_reset', email, at);
      const link = `${config.PUBLIC_APP_URL}/recuperar?token=${encodeURIComponent(token)}`;
      // En segundo plano, igual que el acceso del jugador: el tiempo de respuesta no distingue los casos.
      const siteName = await getSiteName(db);
      sendWithRetries(mailer, passwordResetEmail(email, link, siteName), app.log, 'No se pudo enviar el mail de recuperación', deps.mailRetryDelaysMs);
    }
    return reply.status(202).send({ message: RESET_REQUESTED_MESSAGE });
  });

  // POST /api/auth/admin/reset-password -> 204; no abre sesión. 410 si el link no sirve.
  app.post('/auth/admin/reset-password', async (req, reply) => {
    // La contraseña se valida ANTES de tocar el link: una corta no lo gasta y se puede reintentar.
    const { token, password } = resetPasswordBody.parse(req.body);
    const at = now();
    const passwordHash = await hashPassword(password);

    // Consumir el link, cambiar el hash y cerrar todas las sesiones del admin: una sola sentencia,
    // así que o pasa todo o no pasa nada, y dos pedidos con el mismo link no cambian la clave dos veces.
    const [result] = await db.query<{ consumed: number; changed: number }>(
      `WITH t AS (
         UPDATE login_tokens SET used_at = $2::timestamptz
          WHERE token_hash = $1 AND purpose = 'password_reset' AND used_at IS NULL AND expires_at > $2::timestamptz
          RETURNING email
       ), u AS (
         UPDATE users SET password_hash = $3
          WHERE lower(email) = (SELECT lower(email) FROM t)
            AND role IN ('club_admin', 'superadmin') AND deactivated_at IS NULL
          RETURNING id
       ), s AS (
         DELETE FROM sessions WHERE user_id IN (SELECT id FROM u)
       )
       SELECT (SELECT count(*)::int FROM t) AS consumed, (SELECT count(*)::int FROM u) AS changed`,
      [hashToken(token), at, passwordHash],
    );

    if ((result?.changed ?? 0) > 0) return reply.status(204).send();
    // El link se consumió pero ya no hay un admin con ese mail: no cambió nada.
    if ((result?.consumed ?? 0) > 0) throw LINK_EXPIRED();
    throw (await whyUnusable(db, 'password_reset', hashToken(token))) === 'used' ? LINK_USED() : LINK_EXPIRED();
  });

  // GET /api/auth/admin/invitation?token=… -> 200 { clubName, adminName } sin consumir el link; 410 si no sirve.
  // Sirve para que la página muestre «Elegí tu contraseña» con el nombre del club.
  app.get('/auth/admin/invitation', async (req, reply) => {
    const { token } = invitationQuery.parse(req.query);
    const at = now();
    const [row] = await db.query<{ admin_name: string | null; club_name: string }>(
      `SELECT u.name AS admin_name, c.name AS club_name
         FROM login_tokens t
         JOIN users u ON lower(u.email) = lower(t.email)
          AND u.role = 'club_admin' AND u.deactivated_at IS NULL AND u.password_hash IS NULL
         JOIN clubs c ON c.id = u.club_id
        WHERE t.token_hash = $1 AND t.purpose = 'admin_invite' AND t.used_at IS NULL AND t.expires_at > $2`,
      [hashToken(token), at],
    );
    if (!row) throw (await whyUnusable(db, 'admin_invite', hashToken(token))) === 'used' ? INVITE_USED() : INVITE_EXPIRED();
    reply.header('Cache-Control', 'no-store');
    return { clubName: row.club_name, adminName: row.admin_name };
  });

  // POST /api/auth/admin/accept-invite { token, password } -> 200 { user } con la cookie de sesión.
  // Fija la contraseña del admin invitado, lo pasa a Activo y abre su sesión. 410 si el link no sirve.
  app.post('/auth/admin/accept-invite', async (req, reply) => {
    // La contraseña se valida ANTES de tocar el link: una corta no lo gasta y se puede reintentar.
    const { token, password } = acceptInviteBody.parse(req.body);
    const at = now();
    const passwordHash = await hashPassword(password);

    // Consumir el link y fijar la contraseña van en una sola sentencia: o pasa todo o no pasa nada, y el link solo
    // se gasta si la cuenta sigue Invitada (sin contraseña y sin baja). Dos pedidos con el mismo link no pasan los dos.
    const [result] = await db.query<{ consumed: number; usr: UserRow | null }>(
      `WITH t AS (
         UPDATE login_tokens SET used_at = $2::timestamptz
          WHERE token_hash = $1 AND purpose = 'admin_invite' AND used_at IS NULL AND expires_at > $2::timestamptz
            AND EXISTS (
              SELECT 1 FROM users x
               WHERE lower(x.email) = lower(login_tokens.email)
                 AND x.role = 'club_admin' AND x.deactivated_at IS NULL AND x.password_hash IS NULL)
          RETURNING email
       ), u AS (
         UPDATE users SET password_hash = $3
          WHERE lower(email) = (SELECT lower(email) FROM t)
            AND role = 'club_admin' AND deactivated_at IS NULL AND password_hash IS NULL
          RETURNING id, email, name, role, club_id, password_hash
       )
       SELECT (SELECT count(*)::int FROM t) AS consumed, (SELECT row_to_json(u) FROM u LIMIT 1) AS usr`,
      [hashToken(token), at, passwordHash],
    );

    const user = result?.usr;
    if (!user) {
      if ((result?.consumed ?? 0) > 0) throw INVITE_EXPIRED();
      throw (await whyUnusable(db, 'admin_invite', hashToken(token))) === 'used' ? INVITE_USED() : INVITE_EXPIRED();
    }

    // Un navegador con otra sesión (de jugador u otro admin) la cierra al ingresar.
    await deleteSession(db, req.cookies[SESSION_COOKIE]);
    const sessionToken = await createSession(db, user.id, user.role, at);
    reply.setCookie(SESSION_COOKIE, sessionToken, cookieOptions);
    return { user: toSessionUser(user) };
  });

  // POST /api/auth/logout -> 204; invalida la sesión en la base (funciona aunque no haya sesión).
  app.post('/auth/logout', async (req, reply) => {
    await deleteSession(db, req.cookies[SESSION_COOKIE]);
    clearCookie(reply);
    return reply.status(204).send();
  });

  // GET /api/auth/me -> 200 { user } o 200 { user: null } (sin sesión es un estado normal).
  app.get('/auth/me', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    const user = await resolveSession(db, token, now());
    if (!user && token) clearCookie(reply);
    return { user };
  });
}
