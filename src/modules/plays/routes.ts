import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../../app.js';
import { AppError, forbidden, notFound, unauthorized } from '../../lib/errors.js';
import { resolveSession, SESSION_COOKIE } from '../auth/sessions.js';
import type { SessionUser } from '../auth/types.js';

/** Jugadas que puede tener cada jugador. */
export const MAX_PLAYS_PER_PLAYER = 200;

export const PLAY_CATEGORIES = ['Gol', 'Caño / Galleta', 'Atajada', 'Buena jugada', 'Bloopers', 'Otro'] as const;

const createBody = z.object({
  // Texto libre: los partidos siguen siendo datos de ejemplo del frontend, así que no se valida contra ninguno.
  matchId: z.string().min(1, 'Falta el partido.').max(100, 'El identificador del partido es demasiado largo.'),
  title: z.string().trim().min(1, 'Poné un título para la jugada.').max(120, 'El título es demasiado largo.'),
  category: z.enum(PLAY_CATEGORIES).nullish(),
  captureMode: z.enum(['video', 'voice_commentary']).default('video'),
  timestamp: z.number().min(0, 'El momento marcado no puede ser negativo.').max(86400),
  isLiveMoment: z.boolean().default(false),
});

const patchBody = z
  .object({
    title: z.string().trim().min(1, 'Poné un título para la jugada.').max(120, 'El título es demasiado largo.').optional(),
    category: z.enum(PLAY_CATEGORIES).nullable().optional(),
  })
  .refine((b) => b.title !== undefined || b.category !== undefined, { message: 'No hay nada para cambiar.' });

const idParam = z.object({ id: z.uuid() });

interface PlayRow {
  id: string;
  match_id: string;
  title: string;
  category: string | null;
  capture_mode: 'video' | 'voice_commentary';
  timestamp_seconds: number;
  is_live_moment: boolean;
  created_at: Date;
}

const COLUMNS = 'id, match_id, title, category, capture_mode, timestamp_seconds, is_live_moment, created_at';

function toPlay(row: PlayRow) {
  return {
    id: row.id,
    matchId: row.match_id,
    title: row.title,
    category: row.category,
    captureMode: row.capture_mode,
    timestamp: row.timestamp_seconds,
    isLiveMoment: row.is_live_moment,
    createdAt: row.created_at,
  };
}

/** Un id que no es un uuid es una jugada que no existe, no un error de formato. */
function parseId(params: unknown): string {
  const parsed = idParam.safeParse(params);
  if (!parsed.success) throw notFound('No encontramos esa jugada.');
  return parsed.data.id;
}

export async function playsRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());

  /** Sesión de jugador: 401 sin sesión y 403 para un admin (los admins no ven jugadas de jugadores). */
  async function requirePlayer(req: FastifyRequest): Promise<SessionUser> {
    const user = await resolveSession(db, req.cookies[SESSION_COOKIE], now());
    if (!user) throw unauthorized('Iniciá sesión para ver y guardar tus jugadas.');
    if (user.role !== 'player') throw forbidden('Las jugadas son de los jugadores.');
    return user;
  }

  // GET /api/plays -> las del jugador, de la más reciente a la más antigua.
  app.get('/plays', async (req) => {
    const user = await requirePlayer(req);
    const rows = await db.query<PlayRow>(
      `SELECT ${COLUMNS} FROM plays WHERE user_id = $1 ORDER BY created_at DESC, id`,
      [user.id],
    );
    return { plays: rows.map(toPlay) };
  });

  // POST /api/plays -> 201 { play }; 409 si ya tiene 200.
  app.post('/plays', async (req, reply) => {
    const user = await requirePlayer(req);
    const body = createBody.parse(req.body);

    // Un solo INSERT condicional: no hay transacciones en `Database`, y así el tope y el alta van juntos.
    const rows = await db.query<PlayRow>(
      `INSERT INTO plays (user_id, match_id, title, category, capture_mode, timestamp_seconds, is_live_moment, created_at)
       SELECT $1::uuid, $2::text, $3::text, $4::text, $5::text, $6::int, $7::boolean, $8::timestamptz
        WHERE (SELECT count(*) FROM plays WHERE user_id = $1::uuid) < $9::int
       RETURNING ${COLUMNS}`,
      [
        user.id,
        body.matchId,
        body.title,
        body.category ?? null,
        body.captureMode,
        Math.floor(body.timestamp),
        body.isLiveMoment,
        now(),
        MAX_PLAYS_PER_PLAYER,
      ],
    );
    const row = rows[0];
    if (!row) {
      throw new AppError(
        409,
        'plays_limit_reached',
        `Llegaste al máximo de ${MAX_PLAYS_PER_PLAYER} jugadas guardadas. Borrá alguna para guardar otra.`,
      );
    }
    return reply.status(201).send({ play: toPlay(row) });
  });

  // PATCH /api/plays/:id -> 200 { play }; 404 si no existe o es de otro jugador.
  app.patch('/plays/:id', async (req) => {
    const user = await requirePlayer(req);
    const id = parseId(req.params);
    const body = patchBody.parse(req.body);

    const sets: string[] = [];
    const params: unknown[] = [id, user.id];
    if (body.title !== undefined) {
      params.push(body.title);
      sets.push(`title = $${params.length}`);
    }
    if (body.category !== undefined) {
      params.push(body.category);
      sets.push(`category = $${params.length}`);
    }
    const rows = await db.query<PlayRow>(
      `UPDATE plays SET ${sets.join(', ')} WHERE id = $1 AND user_id = $2 RETURNING ${COLUMNS}`,
      params,
    );
    if (!rows[0]) throw notFound('No encontramos esa jugada.');
    return { play: toPlay(rows[0]) };
  });

  // DELETE /api/plays/:id -> 204; 404 si no existe o es de otro jugador.
  app.delete('/plays/:id', async (req, reply) => {
    const user = await requirePlayer(req);
    const id = parseId(req.params);
    const rows = await db.query(`DELETE FROM plays WHERE id = $1 AND user_id = $2 RETURNING id`, [id, user.id]);
    if (rows.length === 0) throw notFound('No encontramos esa jugada.');
    return reply.status(204).send();
  });
}
