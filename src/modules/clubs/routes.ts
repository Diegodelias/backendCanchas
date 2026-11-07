import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../../app.js';
import { AppError, forbidden, notFound, unauthorized } from '../../lib/errors.js';
import { resolveSession, SESSION_COOKIE } from '../auth/sessions.js';

/** Canchas que puede tener un club, activas o no. */
export const MAX_COURTS_PER_CLUB = 50;

export const SPORTS = ['Fútbol 5', 'Fútbol 7', 'Fútbol 8', 'Fútbol 11'] as const;

const name = z
  .string({ error: 'Poné un nombre para la cancha.' })
  .trim()
  .min(1, 'Poné un nombre para la cancha.')
  .max(60, 'El nombre puede tener hasta 60 caracteres.');

const sport = z.enum(SPORTS, { error: 'Elegí un deporte: Fútbol 5, Fútbol 7, Fútbol 8 o Fútbol 11.' });

const price = z
  .number({ error: 'El precio debe ser un número.' })
  .int('El precio debe ser un número entero de pesos.')
  .positive('El precio debe ser mayor que cero.')
  .max(100_000_000, 'El precio es demasiado alto.');

const createBody = z.object({ name, sport, price });

const patchBody = z
  .object({ name: name.optional(), sport: sport.optional(), price: price.optional(), active: z.boolean().optional() })
  .refine((b) => Object.values(b).some((v) => v !== undefined), { message: 'No hay nada para cambiar.' });

const idParam = z.object({ id: z.string().min(1).max(100) });

interface CourtRow {
  id: string;
  name: string;
  sport: string;
  price: number;
  active: boolean;
}

const COURT_COLUMNS = 'id, name, sport, price, active';

const toCourt = (row: CourtRow) => ({
  id: row.id,
  name: row.name,
  sport: row.sport,
  price: row.price,
  active: row.active,
});

const NAME_TAKEN = () =>
  new AppError(409, 'court_name_taken', 'Ya existe una cancha con ese nombre en tu club.');

export async function clubsRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());

  /** Sesión de admin de club: 401 sin sesión y 403 si no es admin. Devuelve el club de la sesión. */
  async function requireClubAdmin(req: FastifyRequest): Promise<string> {
    const user = await resolveSession(db, req.cookies[SESSION_COOKIE], now());
    if (!user) throw unauthorized('Iniciá sesión para gestionar las canchas de tu club.');
    if (user.role !== 'club_admin' || !user.clubId) {
      throw forbidden('La gestión de canchas es para administradores de club.');
    }
    return user.clubId;
  }

  // GET /api/clubs -> clubes con sus canchas activas. Público; sin copia guardada, para que un cambio
  // del admin se vea al instante. Un club sin canchas activas no aparece (el JOIN lo descarta).
  app.get('/clubs', async (_req, reply) => {
    const rows = await db.query<{
      club_id: string;
      club_name: string;
      zone: string;
      city: string;
      address: string;
      court_id: string;
      court_name: string;
      sport: string;
      price: number;
    }>(
      `SELECT c.id AS club_id, c.name AS club_name, c.zone, c.city, c.address,
              k.id AS court_id, k.name AS court_name, k.sport, k.price
         FROM clubs c
         JOIN courts k ON k.club_id = c.id AND k.active
        ORDER BY c.created_at, c.id, k.created_at, k.id`,
    );

    const clubs: {
      id: string;
      name: string;
      zone: string;
      city: string;
      address: string;
      courts: { id: string; name: string; sport: string; price: number }[];
    }[] = [];
    for (const row of rows) {
      let club = clubs[clubs.length - 1];
      if (!club || club.id !== row.club_id) {
        club = { id: row.club_id, name: row.club_name, zone: row.zone, city: row.city, address: row.address, courts: [] };
        clubs.push(club);
      }
      club.courts.push({ id: row.court_id, name: row.court_name, sport: row.sport, price: row.price });
    }

    reply.header('Cache-Control', 'no-store');
    return { clubs };
  });

  // GET /api/club/courts -> el club del admin y todas sus canchas (activas o no), por orden de alta.
  app.get('/club/courts', async (req, reply) => {
    const clubId = await requireClubAdmin(req);
    const [club] = await db.query<{ id: string; name: string; zone: string; city: string; address: string }>(
      `SELECT id, name, zone, city, address FROM clubs WHERE id = $1`,
      [clubId],
    );
    if (!club) throw notFound('No encontramos tu club.');
    const courts = await db.query<CourtRow>(
      `SELECT ${COURT_COLUMNS} FROM courts WHERE club_id = $1 ORDER BY created_at, id`,
      [clubId],
    );
    reply.header('Cache-Control', 'no-store');
    return { club, courts: courts.map(toCourt) };
  });

  // POST /api/club/courts -> 201 { court } (activa); 409 si el nombre se repite o se llegó al tope.
  app.post('/club/courts', async (req, reply) => {
    const clubId = await requireClubAdmin(req);
    const body = createBody.parse(req.body);

    try {
      // Un único INSERT condicional: no hay transacciones en `Database`, y así el tope y el alta van juntos.
      const rows = await db.query<CourtRow>(
        `INSERT INTO courts (id, club_id, name, sport, price)
         SELECT $1::text, $2::text, $3::text, $4::text, $5::int
          WHERE (SELECT count(*) FROM courts WHERE club_id = $2::text) < $6::int
         RETURNING ${COURT_COLUMNS}`,
        [`c-${randomUUID()}`, clubId, body.name, body.sport, body.price, MAX_COURTS_PER_CLUB],
      );
      const row = rows[0];
      if (!row) {
        throw new AppError(
          409,
          'courts_limit_reached',
          `Tu club llegó al máximo de ${MAX_COURTS_PER_CLUB} canchas. Desactivá o reutilizá alguna.`,
        );
      }
      return reply.status(201).send({ court: toCourt(row) });
    } catch (err) {
      // El índice único (club, nombre sin mayúsculas) detecta el nombre repetido, también entre dos pedidos a la vez.
      if ((err as { code?: string }).code === '23505') throw NAME_TAKEN();
      throw err;
    }
  });

  // PATCH /api/club/courts/:id -> 200 { court }; 404 si no existe o es de otro club. No hay DELETE.
  app.patch('/club/courts/:id', async (req) => {
    const clubId = await requireClubAdmin(req);
    const { id } = idParam.parse(req.params);
    const body = patchBody.parse(req.body);

    const params: unknown[] = [id, clubId];
    const sets: string[] = [];
    const set = (column: string, value: unknown) => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };
    if (body.name !== undefined) set('name', body.name);
    if (body.sport !== undefined) set('sport', body.sport);
    if (body.price !== undefined) set('price', body.price);
    if (body.active !== undefined) set('active', body.active);

    try {
      const rows = await db.query<CourtRow>(
        `UPDATE courts SET ${sets.join(', ')} WHERE id = $1 AND club_id = $2 RETURNING ${COURT_COLUMNS}`,
        params,
      );
      if (!rows[0]) throw notFound('No encontramos esa cancha.');
      return { court: toCourt(rows[0]) };
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw NAME_TAKEN();
      throw err;
    }
  });
}
