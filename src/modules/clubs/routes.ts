import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../../app.js';
import { AppError, forbidden, notFound, unauthorized } from '../../lib/errors.js';
import { resolveSession, SESSION_COOKIE } from '../auth/sessions.js';
import { CITY_IDS } from './clubs.js';

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

/** Clubes por página del listado público cuando no se pide otra cantidad, y el máximo que se acepta. */
export const DEFAULT_CLUBS_PER_PAGE = 6;
export const MAX_CLUBS_PER_PAGE = 24;

const listQuery = z.object({
  page: z.coerce
    .number({ error: 'La página debe ser un número.' })
    .int('La página debe ser un número entero.')
    .min(1, 'La página empieza en 1.')
    .default(1),
  limit: z.coerce
    .number({ error: 'El límite debe ser un número.' })
    .int('El límite debe ser un número entero.')
    .min(1, 'El límite mínimo es 1.')
    .max(MAX_CLUBS_PER_PAGE, `El límite máximo es ${MAX_CLUBS_PER_PAGE}.`)
    .default(DEFAULT_CLUBS_PER_PAGE),
  city: z.enum(CITY_IDS, { error: `La ciudad no existe en el sitio. Ciudades válidas: ${CITY_IDS.join(', ')}.` }).optional(),
  sport: sport.optional(),
});

interface PublicClubRow {
  id: string;
  name: string;
  zone: string;
  city: string;
  address: string;
  image_url: string | null;
}

interface PublicCourtRow {
  id: string;
  club_id: string;
  name: string;
  sport: string;
  price: number;
  image_url: string | null;
}

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

  // Arma los clubes públicos de `ids` (en ese orden) con sus canchas activas y no borradas, por orden de alta.
  async function loadPublicClubs(ids: string[]) {
    if (ids.length === 0) return [];
    const [clubRows, courtRows] = await Promise.all([
      db.query<PublicClubRow>(
        `SELECT id, name, zone, city, address, image_url FROM clubs WHERE id = ANY($1::text[])`,
        [ids],
      ),
      db.query<PublicCourtRow>(
        `SELECT id, club_id, name, sport, price, image_url
           FROM courts
          WHERE club_id = ANY($1::text[]) AND active AND deleted_at IS NULL
          ORDER BY created_at, id`,
        [ids],
      ),
    ]);
    const byId = new Map(clubRows.map((row) => [row.id, row]));
    return ids.flatMap((id) => {
      const club = byId.get(id);
      if (!club) return [];
      return [
        {
          id: club.id,
          name: club.name,
          zone: club.zone,
          city: club.city,
          address: club.address,
          imageUrl: club.image_url,
          courts: courtRows
            .filter((court) => court.club_id === id)
            .map((court) => ({ id: court.id, name: court.name, sport: court.sport, price: court.price, imageUrl: court.image_url })),
        },
      ];
    });
  }

  // GET /api/clubs?page=&limit=&city=&sport= -> una página de clubes con sus canchas activas, y el total.
  // Público; sin copia guardada, para que un cambio del admin se vea al instante. Un club sin canchas activas
  // no aparece. Con `sport`, aparecen los clubes con al menos una cancha activa de ese deporte (con todas las suyas).
  app.get('/clubs', async (req, reply) => {
    const { page, limit, city, sport: sportFilter } = listQuery.parse(req.query);
    const filterParams = [city ?? null, sportFilter ?? null];
    const matching = `FROM clubs c
        WHERE ($1::text IS NULL OR c.city = $1)
          AND EXISTS (SELECT 1 FROM courts k
                       WHERE k.club_id = c.id AND k.active AND k.deleted_at IS NULL
                         AND ($2::text IS NULL OR k.sport = $2))`;

    const [countRows, pageRows] = await Promise.all([
      db.query<{ total: string }>(`SELECT count(*) AS total ${matching}`, filterParams),
      db.query<{ id: string }>(
        `SELECT c.id ${matching} ORDER BY c.created_at, c.id LIMIT $3 OFFSET $4`,
        [...filterParams, limit, (page - 1) * limit],
      ),
    ]);
    const total = Number(countRows[0]?.total ?? 0);

    reply.header('Cache-Control', 'no-store');
    return {
      clubs: await loadPublicClubs(pageRows.map((row) => row.id)),
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    };
  });

  // GET /api/clubs/:id -> un club con sus canchas activas; 404 si no existe o no tiene canchas activas.
  app.get('/clubs/:id', async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const [club] = await loadPublicClubs([id]);
    if (!club || club.courts.length === 0) throw notFound('No encontramos ese club.');
    reply.header('Cache-Control', 'no-store');
    return { club };
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
      `SELECT ${COURT_COLUMNS} FROM courts WHERE club_id = $1 AND deleted_at IS NULL ORDER BY created_at, id`,
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
          WHERE (SELECT count(*) FROM courts WHERE club_id = $2::text AND deleted_at IS NULL) < $6::int
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

  // PATCH /api/club/courts/:id -> 200 { court }; 404 si no existe, es de otro club o está borrada.
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
        `UPDATE courts SET ${sets.join(', ')} WHERE id = $1 AND club_id = $2 AND deleted_at IS NULL RETURNING ${COURT_COLUMNS}`,
        params,
      );
      if (!rows[0]) throw notFound('No encontramos esa cancha.');
      return { court: toCourt(rows[0]) };
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw NAME_TAKEN();
      throw err;
    }
  });

  // DELETE /api/club/courts/:id -> 204. Borrado lógico: la fila se conserva con `deleted_at`.
  // 404 si no existe, es de otro club o ya estaba borrada (todas se responden igual).
  app.delete('/club/courts/:id', async (req, reply) => {
    const clubId = await requireClubAdmin(req);
    const { id } = idParam.parse(req.params);
    const rows = await db.query<{ id: string }>(
      `UPDATE courts SET deleted_at = now() WHERE id = $1 AND club_id = $2 AND deleted_at IS NULL RETURNING id`,
      [id, clubId],
    );
    if (!rows[0]) throw notFound('No encontramos esa cancha.');
    return reply.status(204).send();
  });
}
