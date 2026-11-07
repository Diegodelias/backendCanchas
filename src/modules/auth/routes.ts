import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../../app.js';
import { AppError } from '../../lib/errors.js';
import { accessEmail } from '../mail/accessEmail.js';
import { isLoginBlocked, pruneOldAttempts, recordFailedLogin } from './attempts.js';
import {
  consumeLoginToken,
  createLoginToken,
  isLinkRequestBlocked,
  pruneOldLinks,
  recordLinkRequest,
} from './links.js';
import { verifyAgainstDummy, verifyPassword } from './passwords.js';
import { createSession, deleteSession, resolveSession, SESSION_COOKIE } from './sessions.js';
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

/** Mismo texto para jugador existente, mail nuevo y mail de admin: no revela qué cuentas existen. */
const LINK_REQUESTED_MESSAGE =
  'Si el mail está bien escrito, te enviamos un link de acceso. Revisá tu bandeja de entrada y el correo no deseado. El link vence en 15 minutos.';

const TOO_MANY_LINK_REQUESTS = () =>
  new AppError(429, 'too_many_requests', 'Pediste demasiados links. Esperá 15 minutos y probá de nuevo.');

const LINK_USED = () => new AppError(410, 'link_used', 'Este link ya se usó. Pedí uno nuevo con tu mail.');

const LINK_EXPIRED = () =>
  new AppError(410, 'link_expired', 'Este link venció o no es válido. Pedí uno nuevo con tu mail.');

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

    const [user] = await db.query<UserRow>(
      `SELECT id, email, name, role, club_id, password_hash
         FROM users WHERE lower(email) = lower($1) AND role = 'club_admin'`,
      [email],
    );
    const ok = user?.password_hash
      ? await verifyPassword(user.password_hash, password)
      : await verifyAgainstDummy(password);

    if (!user || !ok) {
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
    if (await isLinkRequestBlocked(db, email, at)) throw TOO_MANY_LINK_REQUESTS();
    // Se cuenta todo pedido, se envíe o no un link: si no, el tope delataría los mails de admin.
    await recordLinkRequest(db, email, req.ip, at);

    const [existing] = await db.query<{ role: string }>(
      `SELECT role FROM users WHERE lower(email) = lower($1)`,
      [email],
    );
    if (existing?.role !== 'club_admin') {
      const token = await createLoginToken(db, email, at);
      const link = `${config.PUBLIC_APP_URL}/acceso?token=${encodeURIComponent(token)}`;
      // En segundo plano: esperar el envío haría que «se envió» tardara más que «no se envió nada».
      void mailer.send(accessEmail(email, link)).catch((err: unknown) => {
        // Solo el tipo de error: ni el link ni el destinatario van al log.
        const code = (err as { code?: string }).code;
        app.log.error({ errorName: (err as Error).name, code }, 'No se pudo enviar el mail de acceso');
      });
    }
    return reply.status(202).send({ message: LINK_REQUESTED_MESSAGE });
  });

  // POST /api/auth/player/confirm -> 200 { user } con la cookie de sesión; 410 si el link no sirve.
  app.post('/auth/player/confirm', async (req, reply) => {
    const { token } = confirmBody.parse(req.body);
    const at = now();

    const consumed = await consumeLoginToken(db, token, at);
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
