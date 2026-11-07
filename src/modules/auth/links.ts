import { randomBytes } from 'node:crypto';
import type { Database } from '../../db/client.js';
import { hashToken } from './sessions.js';

/**
 * Para qué sirve un link: ingresar como jugador o elegir una contraseña nueva (admin).
 * Un link de un propósito no sirve para el otro, y cada uno tiene su propio límite de pedidos.
 */
export type LinkPurpose = 'access' | 'password_reset';

/** Pedidos de link permitidos por mail dentro de la ventana, por propósito. */
export const MAX_LINK_REQUESTS = 3;
export const LINK_REQUEST_WINDOW_MS = 15 * 60 * 1000;
export const LINK_TTL_MS = 15 * 60 * 1000;
const KEEP_MS = 24 * 60 * 60 * 1000;

/** true si el mail ya hizo el máximo de pedidos en los últimos 15 minutos (se haya enviado o no un link). */
export async function isLinkRequestBlocked(
  db: Database,
  purpose: LinkPurpose,
  email: string,
  now: Date,
): Promise<boolean> {
  const [row] = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM link_requests
      WHERE purpose = $1 AND lower(email) = lower($2) AND requested_at > $3`,
    [purpose, email, new Date(now.getTime() - LINK_REQUEST_WINDOW_MS)],
  );
  return (row?.n ?? 0) >= MAX_LINK_REQUESTS;
}

export async function recordLinkRequest(
  db: Database,
  purpose: LinkPurpose,
  email: string,
  ip: string,
  now: Date,
): Promise<void> {
  await db.query(
    `INSERT INTO link_requests (purpose, email, ip, requested_at) VALUES ($1, $2, $3, $4)`,
    [purpose, email, ip, now],
  );
}

/** Borra pedidos y links de más de un día. */
export async function pruneOldLinks(db: Database, now: Date): Promise<void> {
  const before = new Date(now.getTime() - KEEP_MS);
  await db.query(`DELETE FROM link_requests WHERE requested_at < $1`, [before]);
  await db.query(`DELETE FROM login_tokens WHERE created_at < $1`, [before]);
}

/** Crea un link vigente 15 minutos y devuelve su identificador (en la base queda solo el hash). */
export async function createLoginToken(
  db: Database,
  purpose: LinkPurpose,
  email: string,
  now: Date,
): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await db.query(
    `INSERT INTO login_tokens (purpose, email, token_hash, created_at, expires_at) VALUES ($1, $2, $3, $4, $5)`,
    [purpose, email, hashToken(token), now, new Date(now.getTime() + LINK_TTL_MS)],
  );
  return token;
}

export type ConsumeResult = { ok: true; email: string } | { ok: false; reason: 'used' | 'expired' };

/**
 * Consume el link con una sola sentencia: dos confirmaciones simultáneas no pueden usarlo a la vez.
 * Un identificador inexistente, vencido o de otro propósito se informa como vencido, y no se consume.
 */
export async function consumeLoginToken(
  db: Database,
  purpose: LinkPurpose,
  token: string,
  now: Date,
): Promise<ConsumeResult> {
  const hash = hashToken(token);
  const [consumed] = await db.query<{ email: string }>(
    `UPDATE login_tokens SET used_at = $3
      WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > $3
      RETURNING email`,
    [hash, purpose, now],
  );
  if (consumed) return { ok: true, email: consumed.email };
  return { ok: false, reason: await whyUnusable(db, purpose, hash) };
}

/** Por qué un link no sirve: ya se usó, o venció / no existe / es de otro propósito. */
export async function whyUnusable(
  db: Database,
  purpose: LinkPurpose,
  tokenHash: string,
): Promise<'used' | 'expired'> {
  const [existing] = await db.query<{ used_at: Date | null }>(
    `SELECT used_at FROM login_tokens WHERE token_hash = $1 AND purpose = $2`,
    [tokenHash, purpose],
  );
  return existing?.used_at ? 'used' : 'expired';
}
