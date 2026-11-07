import type { Database } from '../../db/client.js';

/** Intentos fallidos permitidos por cuenta y por IP dentro de la ventana. */
export const MAX_FAILED_ATTEMPTS = 5;
export const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const KEEP_ATTEMPTS_MS = 24 * 60 * 60 * 1000;

/** true si la cuenta o la IP ya llegaron al máximo de fallos en los últimos 15 minutos. */
export async function isLoginBlocked(db: Database, email: string, ip: string, now: Date): Promise<boolean> {
  const since = new Date(now.getTime() - ATTEMPT_WINDOW_MS);
  const [row] = await db.query<{ by_email: number; by_ip: number }>(
    `SELECT
        count(*) FILTER (WHERE lower(email) = lower($1))::int AS by_email,
        count(*) FILTER (WHERE ip = $2)::int AS by_ip
       FROM login_attempts
      WHERE attempted_at > $3 AND (lower(email) = lower($1) OR ip = $2)`,
    [email, ip, since],
  );
  return (row?.by_email ?? 0) >= MAX_FAILED_ATTEMPTS || (row?.by_ip ?? 0) >= MAX_FAILED_ATTEMPTS;
}

export async function recordFailedLogin(db: Database, email: string, ip: string, now: Date): Promise<void> {
  await db.query(`INSERT INTO login_attempts (email, ip, attempted_at) VALUES ($1, $2, $3)`, [email, ip, now]);
}

/** Borra los intentos de más de un día; se llama en cada ingreso correcto. */
export async function pruneOldAttempts(db: Database, now: Date): Promise<void> {
  await db.query(`DELETE FROM login_attempts WHERE attempted_at < $1`, [
    new Date(now.getTime() - KEEP_ATTEMPTS_MS),
  ]);
}
