import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../../app.js';
import type { Database } from '../../db/client.js';
import { AppError, notFound } from '../../lib/errors.js';
import { isLinkRequestBlocked, pruneOldLinks, recordLinkRequest, replaceInviteToken } from '../auth/links.js';
import { inviteEmail } from '../mail/inviteEmail.js';
import type { Mailer } from '../mail/mailer.js';
import { requireSuperadmin } from './guard.js';

const clubParam = z.object({ clubId: z.string().min(1).max(100) });
const adminParams = z.object({ clubId: z.string().min(1).max(100), adminId: z.string().min(1).max(100) });

const inviteBody = z.object({
  email: z.email({ error: 'Ingresá un correo electrónico válido (ej. nombre@club.com).' }).max(254, 'El mail es demasiado largo.'),
  name: z
    .string({ error: 'Poné el nombre del admin.' })
    .trim()
    .min(1, 'Poné el nombre del admin.')
    .max(120, 'El nombre puede tener hasta 120 caracteres.'),
});

/** Estado de un admin de club, derivado de sus datos (no se guarda). */
export type AdminStatus = 'invited' | 'active' | 'deactivated';

interface AdminRow {
  id: string;
  email: string;
  name: string | null;
  password_hash: string | null;
  deactivated_at: Date | null;
}

export function adminStatus(row: Pick<AdminRow, 'password_hash' | 'deactivated_at'>): AdminStatus {
  if (row.deactivated_at) return 'deactivated';
  return row.password_hash ? 'active' : 'invited';
}

/** Lo que la API cuenta de un admin: nunca su contraseña, su hash ni su sesión. */
export function toAdminDto(row: AdminRow, hasLiveInvite: boolean) {
  const status = adminStatus(row);
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    status,
    // Solo tiene sentido para un Invitado: su link venció (o no tiene uno vigente) y hay que reenviarlo.
    invitationExpired: status === 'invited' && !hasLiveInvite,
  };
}

const TOO_MANY_INVITES = () =>
  new AppError(429, 'too_many_requests', 'Ya enviaste varias invitaciones a ese mail. Esperá 15 minutos y probá de nuevo.');

/** Datos de un club para armar la invitación; null si no existe. */
async function findClub(db: Database, clubId: string) {
  const [club] = await db.query<{ id: string; name: string }>(`SELECT id, name FROM clubs WHERE id = $1`, [clubId]);
  return club ?? null;
}

interface AdminListRow extends AdminRow {
  live_invite: boolean;
}

const ADMIN_COLUMNS = `u.id, u.email, u.name, u.password_hash, u.deactivated_at,
  EXISTS (SELECT 1 FROM login_tokens t
           WHERE t.purpose = 'admin_invite' AND lower(t.email) = lower(u.email)
             AND t.used_at IS NULL AND t.expires_at > $2) AS live_invite`;

/** Un admin del club (de cualquier estado), o null si no existe o es de otro club. */
async function findClubAdmin(db: Database, clubId: string, adminId: string, now: Date) {
  // El id es un uuid: un valor que no lo es no puede existir (y la base lo rechazaría con un error).
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(adminId)) return null;
  const [row] = await db.query<AdminListRow>(
    `SELECT ${ADMIN_COLUMNS} FROM users u WHERE u.id = $1 AND u.club_id = $3 AND u.role = 'club_admin'`,
    [adminId, now, clubId],
  );
  return row ?? null;
}

interface InviteContext {
  db: Database;
  mailer: Mailer;
  publicAppUrl: string;
  log: Pick<FastifyBaseLogger, 'error'>;
}

/**
 * Manda el mail de invitación y espera el resultado. A diferencia del acceso de jugador y la recuperación,
 * acá no hay nada que ocultar (lo pide un superadmin autenticado): si falla, el superadmin tiene que enterarse.
 * Al log va solo el tipo de error: nunca el link ni el destinatario.
 */
async function sendInvite(ctx: InviteContext, admin: { email: string; name: string | null }, clubName: string, now: Date): Promise<boolean> {
  const token = await replaceInviteToken(ctx.db, admin.email, now);
  const link = `${ctx.publicAppUrl}/invitacion?token=${encodeURIComponent(token)}`;
  try {
    await ctx.mailer.send(inviteEmail(admin.email, link, clubName, admin.name));
    return true;
  } catch (err) {
    const code = (err as { code?: string }).code;
    ctx.log.error({ errorName: (err as Error).name, code }, 'No se pudo enviar el mail de invitación');
    return false;
  }
}

export async function platformAdminsRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db, config } = deps;
  const now = deps.now ?? (() => new Date());
  const mailer = deps.mailer;
  if (!mailer) throw new Error('platformAdminsRoutes necesita un mailer (lo arma buildApp).');
  const ctx: InviteContext = { db, mailer, publicAppUrl: config.PUBLIC_APP_URL, log: app.log };

  // POST /api/platform/clubs/:clubId/admins -> 201 { admin, emailSent }.
  // Crea la cuenta del admin SIN contraseña (Invitado) o reactiva a uno dado de baja del mismo club.
  app.post('/platform/clubs/:clubId/admins', async (req, reply) => {
    await requireSuperadmin(db, req, now());
    const { clubId } = clubParam.parse(req.params);
    const { email: typed, name } = inviteBody.parse(req.body);
    const email = typed.toLowerCase();
    const club = await findClub(db, clubId);
    if (!club) throw notFound('No encontramos ese club.');
    const at = now();

    // Un mail tiene una sola cuenta, de cualquier rol: se decide qué hacer con la que ya existe, si hay.
    const [existing] = await db.query<AdminRow & { role: string; club_id: string | null }>(
      `SELECT id, email, name, role, club_id, password_hash, deactivated_at FROM users WHERE lower(email) = lower($1)`,
      [email],
    );
    if (existing) {
      if (existing.role === 'player') {
        throw new AppError(409, 'email_is_player', 'Ese mail ya tiene una cuenta de jugador. Invitá a otro mail.');
      }
      if (existing.role === 'superadmin') {
        throw new AppError(409, 'email_is_admin', 'Ese mail ya es de un administrador.');
      }
      if (!existing.deactivated_at) {
        throw new AppError(409, 'email_is_admin', 'Ese mail ya es de un administrador.');
      }
      if (existing.club_id !== clubId) {
        throw new AppError(409, 'email_other_club', 'Ese mail pertenece a un administrador dado de baja de otro club.');
      }
    }

    // El mismo límite que los links de acceso: 3 envíos por mail cada 15 minutos, contando todo pedido.
    await pruneOldLinks(db, at);
    if (await isLinkRequestBlocked(db, 'admin_invite', email, at)) throw TOO_MANY_INVITES();
    await recordLinkRequest(db, 'admin_invite', email, req.ip, at);

    let row: AdminRow;
    if (existing) {
      // Reinvitar a un admin dado de baja de este mismo club: vuelve sin contraseña, con una invitación nueva.
      const [reactivated] = await db.query<AdminRow>(
        `UPDATE users SET deactivated_at = NULL, password_hash = NULL, name = $2
          WHERE id = $1 AND deactivated_at IS NOT NULL AND club_id = $3
          RETURNING id, email, name, password_hash, deactivated_at`,
        [existing.id, name, clubId],
      );
      if (!reactivated) throw new AppError(409, 'email_is_admin', 'Ese mail ya es de un administrador.');
      row = reactivated;
    } else {
      try {
        const [created] = await db.query<AdminRow>(
          `INSERT INTO users (email, name, role, club_id) VALUES ($1, $2, 'club_admin', $3)
           RETURNING id, email, name, password_hash, deactivated_at`,
          [email, name, clubId],
        );
        row = created!;
      } catch (err) {
        // Otra invitación al mismo mail pudo entrar entre la consulta y el insert.
        if ((err as { code?: string }).code === '23505') {
          throw new AppError(409, 'email_is_admin', 'Ese mail ya es de un administrador.');
        }
        throw err;
      }
    }

    const emailSent = await sendInvite(ctx, row, club.name, at);
    // La invitación se crea aunque el envío falle, así que está vigente: reenviarla genera una nueva.
    return reply.status(201).send({ admin: toAdminDto(row, true), emailSent });
  });

  // GET /api/platform/clubs/:clubId/admins -> los admins del club con su estado (Invitado / Activo / Dado de baja).
  app.get('/platform/clubs/:clubId/admins', async (req, reply) => {
    await requireSuperadmin(db, req, now());
    const { clubId } = clubParam.parse(req.params);
    const club = await findClub(db, clubId);
    if (!club) throw notFound('No encontramos ese club.');
    const rows = await db.query<AdminListRow>(
      `SELECT ${ADMIN_COLUMNS} FROM users u WHERE u.club_id = $1 AND u.role = 'club_admin' ORDER BY u.created_at, u.id`,
      [clubId, now()],
    );
    reply.header('Cache-Control', 'no-store');
    return { club: { id: club.id, name: club.name }, admins: rows.map((row) => toAdminDto(row, row.live_invite)) };
  });

  // POST /api/platform/clubs/:clubId/admins/:adminId/invitation -> 200 { admin, emailSent }.
  // Reenvía la invitación SOLO a un admin Invitado (venza o no la anterior); la anterior deja de servir.
  app.post('/platform/clubs/:clubId/admins/:adminId/invitation', async (req) => {
    await requireSuperadmin(db, req, now());
    const { clubId, adminId } = adminParams.parse(req.params);
    const club = await findClub(db, clubId);
    if (!club) throw notFound('No encontramos ese club.');
    const at = now();
    const admin = await findClubAdmin(db, clubId, adminId, at);
    if (!admin) throw notFound('No encontramos a ese admin en este club.');
    if (adminStatus(admin) !== 'invited') {
      throw new AppError(409, 'admin_not_invited', 'Solo se puede reenviar la invitación a un admin que todavía no eligió su contraseña.');
    }

    const email = admin.email.toLowerCase();
    await pruneOldLinks(db, at);
    if (await isLinkRequestBlocked(db, 'admin_invite', email, at)) throw TOO_MANY_INVITES();
    await recordLinkRequest(db, 'admin_invite', email, req.ip, at);

    const emailSent = await sendInvite(ctx, admin, club.name, at);
    return { admin: toAdminDto(admin, true), emailSent };
  });

  // DELETE /api/platform/clubs/:clubId/admins/:adminId -> 204. Baja lógica: la cuenta se conserva, pero se cierran
  // todas sus sesiones y no puede ingresar ni recuperar su contraseña. 404 si no existe, es de otro club o ya estaba de baja.
  app.delete('/platform/clubs/:clubId/admins/:adminId', async (req, reply) => {
    await requireSuperadmin(db, req, now());
    const { clubId, adminId } = adminParams.parse(req.params);
    const at = now();
    const admin = await findClubAdmin(db, clubId, adminId, at);
    if (!admin || admin.deactivated_at) throw notFound('No encontramos a ese admin en este club.');

    const [removed] = await db.query<{ id: string; email: string }>(
      `UPDATE users SET deactivated_at = $3
        WHERE id = $1 AND club_id = $2 AND role = 'club_admin' AND deactivated_at IS NULL
        RETURNING id, email`,
      [adminId, clubId, at],
    );
    if (!removed) throw notFound('No encontramos a ese admin en este club.');
    await db.query(`DELETE FROM sessions WHERE user_id = $1`, [removed.id]);
    // Los links que le quedaban sin usar (invitación, recuperación) dejan de existir.
    await db.query(
      `DELETE FROM login_tokens
        WHERE lower(email) = lower($1) AND used_at IS NULL AND purpose IN ('admin_invite', 'password_reset')`,
      [removed.email],
    );
    return reply.status(204).send();
  });
}
