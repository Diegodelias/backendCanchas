import { randomBytes } from 'node:crypto';
import type { Database } from '../../db/client.js';
import { hashToken } from './sessions.js';

/**
 * Para qué sirve un link: ingresar como jugador, elegir una contraseña nueva (admin) o aceptar la invitación
 * de un admin de club. Un link de un propósito no sirve para otro, y cada uno tiene su propio límite de pedidos
 * y su propio vencimiento.
 */
export type LinkPurpose = 'access' | 'password_reset' | 'admin_invite';

/** Pedidos de link permitidos por mail dentro de la ventana, por propósito. */
export const MAX_LINK_REQUESTS = 3;
export const LINK_REQUEST_WINDOW_MS = 15 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
/** Cuánto vive un link, por propósito: los de acceso y recuperación 15 minutos; la invitación de un admin, 72 horas. */
export const LINK_TTL_MS: Record<LinkPurpose, number> = {
  access: 15 * 60 * 1000,
  password_reset: 15 * 60 * 1000,
  admin_invite: 72 * HOUR_MS,
};
const KEEP_MS = 24 * HOUR_MS;

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

/**
 * Borra los pedidos de más de un día y los links que vencieron hace más de un día. Los links se podan por
 * vencimiento y no por creación: una invitación de 72 horas no puede desaparecer a las 24.
 */
export async function pruneOldLinks(db: Database, now: Date): Promise<void> {
  const before = new Date(now.getTime() - KEEP_MS);
  await db.query(`DELETE FROM link_requests WHERE requested_at < $1`, [before]);
  await db.query(`DELETE FROM login_tokens WHERE expires_at < $1`, [before]);
}

/** Crea un link vigente según su propósito y devuelve su identificador (en la base queda solo el hash). */
export async function createLoginToken(
  db: Database,
  purpose: LinkPurpose,
  email: string,
  now: Date,
): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await db.query(
    `INSERT INTO login_tokens (purpose, email, token_hash, created_at, expires_at) VALUES ($1, $2, $3, $4, $5)`,
    [purpose, email, hashToken(token), now, new Date(now.getTime() + LINK_TTL_MS[purpose])],
  );
  return token;
}

/**
 * Crea la invitación de un admin e invalida las que ese mail tenía sin usar: reenviar deja vivo solo el link
 * nuevo, y el viejo se informa como vencido o inválido.
 */
export async function replaceInviteToken(db: Database, email: string, now: Date): Promise<string> {
  await db.query(
    `DELETE FROM login_tokens WHERE purpose = 'admin_invite' AND lower(email) = lower($1) AND used_at IS NULL`,
    [email],
  );
  return createLoginToken(db, 'admin_invite', email, now);
}

/** true si el mail tiene una invitación sin usar y todavía vigente. */
export async function hasLiveInvite(db: Database, email: string, now: Date): Promise<boolean> {
  const rows = await db.query(
    `SELECT 1 FROM login_tokens
      WHERE purpose = 'admin_invite' AND lower(email) = lower($1) AND used_at IS NULL AND expires_at > $2
      LIMIT 1`,
    [email, now],
  );
  return rows.length > 0;
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
