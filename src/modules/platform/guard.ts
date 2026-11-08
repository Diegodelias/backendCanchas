import type { FastifyRequest } from 'fastify';
import type { Database } from '../../db/client.js';
import { forbidden, unauthorized } from '../../lib/errors.js';
import { resolveSession, SESSION_COOKIE } from '../auth/sessions.js';
import type { SessionUser } from '../auth/types.js';

/**
 * Sesión de superadmin: 401 sin sesión y 403 si la sesión es de otro rol (admin de club o jugador).
 * Es lo único que decide el acceso a `/api/platform/...`: no depende de lo que muestre la pantalla.
 */
export async function requireSuperadmin(db: Database, req: FastifyRequest, now: Date): Promise<SessionUser> {
  const user = await resolveSession(db, req.cookies[SESSION_COOKIE], now);
  if (!user) throw unauthorized('Iniciá sesión para usar el panel de la plataforma.');
  if (user.role !== 'superadmin') throw forbidden('El panel de la plataforma es solo para el superadmin.');
  return user;
}
