import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import type { Database } from '../../db/client.js';
import { AppError } from '../../lib/errors.js';
import { accessEmail } from '../mail/accessEmail.js';
import type { Mailer } from '../mail/mailer.js';
import { getSiteName } from '../site/settings.js';
import { createLoginToken, isLinkRequestBlocked, PLAYER_HANDOVER_TTL_MS, pruneOldLinks, recordLinkRequest } from './links.js';

/** Cuerpo de «crear jugador», igual para el panel del club y el de la plataforma. */
export const createPlayerBody = z.object({
  email: z.email({ error: 'Ingresá un correo electrónico válido (ej. nombre@gmail.com).' }).max(254, 'El mail es demasiado largo.'),
  sendEmail: z.boolean({ error: 'sendEmail debe ser verdadero o falso.' }).default(false),
});

export interface CreatePlayerContext {
  db: Database;
  mailer: Mailer;
  publicAppUrl: string;
  log: Pick<FastifyBaseLogger, 'error'>;
}

export interface CreatePlayerInput {
  email: string;
  sendEmail: boolean;
  /** Superadmin: un jugador existente recibe un link nuevo. Admin de club: se rechaza. */
  allowExisting: boolean;
  ip: string;
  now: Date;
}

export interface CreatePlayerResult {
  player: { id: string; email: string };
  /** Link de un solo uso (72 horas) para entregar al jugador. Solo viaja en la respuesta a quien lo creó. */
  link: string;
  /** false si la cuenta ya existía (solo el superadmin llega acá). */
  created: boolean;
  /** null si no se pidió el mail; true / false según el resultado del envío. */
  emailSent: boolean | null;
}

const EMAIL_IS_PLAYER = () =>
  new AppError(409, 'email_is_player', 'Ese mail ya tiene una cuenta de jugador. Pedile que ingrese con su mail o consultá al superadmin.');

const EMAIL_IS_ADMIN = () => new AppError(409, 'email_is_admin', 'Ese mail ya es de un administrador.');

const TOO_MANY_REQUESTS = () =>
  new AppError(429, 'too_many_requests', 'Ya se pidieron varios links para ese mail. Esperá 15 minutos y probá de nuevo.');

/**
 * Crea la cuenta de un jugador a pedido de un admin y devuelve un link de acceso de 72 horas para entregarlo.
 * A diferencia del pedido público de link, acá quien pide está autenticado: los rechazos dicen qué pasa con el mail.
 * El mail solo se envía si se pide, y su falla no deshace nada. Al log nunca van el mail, el link ni el código.
 */
export async function createPlayer(ctx: CreatePlayerContext, input: CreatePlayerInput): Promise<CreatePlayerResult> {
  const { db } = ctx;
  const email = input.email.toLowerCase();
  const at = input.now;

  const [existing] = await db.query<{ id: string; role: string }>(
    `SELECT id, role FROM users WHERE lower(email) = lower($1)`,
    [email],
  );
  if (existing && existing.role !== 'player') throw EMAIL_IS_ADMIN();
  if (existing && !input.allowExisting) throw EMAIL_IS_PLAYER();

  // El mismo límite que el ingreso público: 3 pedidos por mail cada 15 minutos, contando todo pedido.
  await pruneOldLinks(db, at);
  if (await isLinkRequestBlocked(db, 'access', email, at)) throw TOO_MANY_REQUESTS();
  await recordLinkRequest(db, 'access', email, input.ip, at);

  // ON CONFLICT cubre dos altas del mismo mail a la vez: RETURNING devuelve la fila solo si la creó este pedido.
  const [inserted] = await db.query<{ id: string }>(
    `INSERT INTO users (email, role) VALUES ($1, 'player') ON CONFLICT DO NOTHING RETURNING id`,
    [email],
  );
  const [row] = await db.query<{ id: string; email: string; role: string }>(
    `SELECT id, email, role FROM users WHERE lower(email) = lower($1)`,
    [email],
  );
  if (!row || row.role !== 'player') throw EMAIL_IS_ADMIN();
  // Si otra alta ganó la carrera por este mail, para este pedido la cuenta ya existía.
  const created = inserted !== undefined;
  if (!created && !input.allowExisting) throw EMAIL_IS_PLAYER();

  const token = await createLoginToken(db, 'access', row.email, at, PLAYER_HANDOVER_TTL_MS);
  const link = `${ctx.publicAppUrl}/acceso?token=${encodeURIComponent(token)}`;

  let emailSent: boolean | null = null;
  if (input.sendEmail) {
    try {
      await ctx.mailer.send(accessEmail(row.email, link, undefined, await getSiteName(db)));
      emailSent = true;
    } catch (err) {
      const code = (err as { code?: string }).code;
      ctx.log.error({ errorName: (err as Error).name, code }, 'No se pudo enviar el mail de acceso del jugador');
      emailSent = false;
    }
  }

  return { player: { id: row.id, email: row.email }, link, created, emailSent };
}
