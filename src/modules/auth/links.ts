import { randomBytes } from 'node:crypto';
import type { Database } from '../../db/client.js';
import { hashToken } from './sessions.js';

/** Pedidos de link permitidos por mail dentro de la ventana. */
export const MAX_LINK_REQUESTS = 3;
export const LINK_REQUEST_WINDOW_MS = 15 * 60 * 1000;
export const LINK_TTL_MS = 15 * 60 * 1000;
const KEEP_MS = 24 * 60 * 60 * 1000;

/** true si el mail ya hizo el máximo de pedidos en los últimos 15 minutos (se haya enviado o no un link). */
export async function isLinkRequestBlocked(db: Database, email: string, now: Date): Promise<boolean> {
  const [row] = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM link_requests WHERE lower(email) = lower($1) AND requested_at > $2`,
    [email, new Date(now.getTime() - LINK_REQUEST_WINDOW_MS)],
  );
  return (row?.n ?? 0) >= MAX_LINK_REQUESTS;
}

export async function recordLinkRequest(db: Database, email: string, ip: string, now: Date): Promise<void> {
  await db.query(`INSERT INTO link_requests (email, ip, requested_at) VALUES ($1, $2, $3)`, [email, ip, now]);
}

/** Borra pedidos y links de más de un día. */
export async function pruneOldLinks(db: Database, now: Date): Promise<void> {
  const before = new Date(now.getTime() - KEEP_MS);
  await db.query(`DELETE FROM link_requests WHERE requested_at < $1`, [before]);
  await db.query(`DELETE FROM login_tokens WHERE created_at < $1`, [before]);
}

/** Crea un link vigente 15 minutos y devuelve su identificador (en la base queda solo el hash). */
export async function createLoginToken(db: Database, email: string, now: Date): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await db.query(
    `INSERT INTO login_tokens (email, token_hash, created_at, expires_at) VALUES ($1, $2, $3, $4)`,
    [email, hashToken(token), now, new Date(now.getTime() + LINK_TTL_MS)],
  );
  return token;
}

export type ConsumeResult = { ok: true; email: string } | { ok: false; reason: 'used' | 'expired' };

/**
 * Consume el link con una sola sentencia: dos confirmaciones simultáneas no pueden usarlo a la vez.
 * Un identificador inexistente se informa igual que uno vencido.
 */
export async function consumeLoginToken(db: Database, token: string, now: Date): Promise<ConsumeResult> {
  const hash = hashToken(token);
  const [consumed] = await db.query<{ email: string }>(
    `UPDATE login_tokens SET used_at = $2
      WHERE token_hash = $1 AND used_at IS NULL AND expires_at > $2
      RETURNING email`,
    [hash, now],
  );
  if (consumed) return { ok: true, email: consumed.email };

  const [existing] = await db.query<{ used_at: Date | null }>(
    `SELECT used_at FROM login_tokens WHERE token_hash = $1`,
    [hash],
  );
  return { ok: false, reason: existing?.used_at ? 'used' : 'expired' };
}
