import { createHash, randomBytes } from 'node:crypto';
import type { Database } from '../../db/client.js';
import { toSessionUser, type Role, type SessionUser, type UserRow } from './types.js';

export const SESSION_COOKIE = 'c3_session';

const HOUR = 60 * 60 * 1000;

/** Vida de la sesión sin uso, por rol. El change 2 agrega la del jugador. */
const SESSION_TTL_MS: Partial<Record<Role, number>> = {
  club_admin: 8 * HOUR,
};

/** Cada cuánto se renueva una sesión en uso (evita escribir en cada pedido). */
export const RENEW_AFTER_MS = 5 * 60 * 1000;

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function sessionTtlMs(role: Role): number {
  const ttl = SESSION_TTL_MS[role];
  if (ttl === undefined) throw new Error(`El rol ${role} todavía no tiene sesiones.`);
  return ttl;
}

/** Crea la sesión y devuelve el token que va en la cookie (en la base queda solo su hash). */
export async function createSession(db: Database, userId: string, role: Role, now: Date): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + sessionTtlMs(role));
  await db.query(
    `INSERT INTO sessions (token_hash, user_id, created_at, last_used_at, expires_at)
     VALUES ($1, $2, $3, $3, $4)`,
    [hashToken(token), userId, now, expiresAt],
  );
  return token;
}

/**
 * Devuelve el usuario de una sesión vigente, o null.
 * Si pasaron más de `RENEW_AFTER_MS` desde el último uso, extiende la sesión.
 */
export async function resolveSession(
  db: Database,
  token: string | undefined,
  now: Date,
): Promise<SessionUser | null> {
  if (!token) return null;
  const rows = await db.query<UserRow & { session_id: string; last_used_at: Date }>(
    `SELECT s.id AS session_id, s.last_used_at, u.id, u.email, u.name, u.role, u.club_id, u.password_hash
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > $2`,
    [hashToken(token), now],
  );
  const row = rows[0];
  if (!row) return null;
  const ttl = SESSION_TTL_MS[row.role];
  if (ttl === undefined) return null;

  if (now.getTime() - new Date(row.last_used_at).getTime() > RENEW_AFTER_MS) {
    await db.query(`UPDATE sessions SET last_used_at = $2, expires_at = $3 WHERE id = $1`, [
      row.session_id,
      now,
      new Date(now.getTime() + ttl),
    ]);
  }
  return toSessionUser(row);
}

export async function deleteSession(db: Database, token: string | undefined): Promise<void> {
  if (!token) return;
  await db.query(`DELETE FROM sessions WHERE token_hash = $1`, [hashToken(token)]);
}
