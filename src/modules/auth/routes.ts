import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../../app.js';
import { AppError } from '../../lib/errors.js';
import { isLoginBlocked, pruneOldAttempts, recordFailedLogin } from './attempts.js';
import { verifyAgainstDummy, verifyPassword } from './passwords.js';
import { createSession, deleteSession, resolveSession, SESSION_COOKIE } from './sessions.js';
import { toSessionUser, type UserRow } from './types.js';

const loginBody = z.object({
  email: z.string().trim().min(1, 'Ingresá tu mail.').max(254),
  password: z.string().min(1, 'Ingresá tu contraseña.').max(1024),
});

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
    const token = await createSession(db, user.id, user.role, at);
    reply.setCookie(SESSION_COOKIE, token, cookieOptions);
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
