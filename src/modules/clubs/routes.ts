import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../../app.js';
import { forbidden, notFound, unauthorized } from '../../lib/errors.js';
import { createPlayer, createPlayerBody } from '../auth/players.js';
import { resolveSession, SESSION_COOKIE } from '../auth/sessions.js';
import { listClubBookings } from '../bookings/bookings.js';
import { listClubRecordings } from '../recordings/recordings.js';
import { getSchedule, replaceSchedule, requireCourt, scheduleBody } from '../bookings/schedules.js';
import { CITY_IDS } from './clubs.js';
import {
  createCourt,
  createCourtBody,
  deleteCourt,
  listCourts,
  patchCourtBody,
  sport,
  updateCourt,
} from './courts.js';

const idParam = z.object({ id: z.string().min(1).max(100) });
const courtIdParam = z.object({ courtId: z.string().min(1).max(100) });

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

  // POST /api/club/players -> 201 { player, link, created, emailSent }.
  // El admin de club crea un jugador por mail y obtiene un link de acceso de 72 horas para entregarle.
  // Si el mail ya tiene cuenta (de jugador o admin) se rechaza: solo el superadmin puede pedir un link nuevo.
  app.post('/club/players', async (req, reply) => {
    await requireClubAdmin(req);
    const { mailer, config } = deps;
    if (!mailer) throw new Error('clubsRoutes necesita un mailer (lo arma buildApp).');
    const { email, sendEmail } = createPlayerBody.parse(req.body);
    const result = await createPlayer(
      { db, mailer, publicAppUrl: config.PUBLIC_APP_URL, log: app.log },
      { email, sendEmail, allowExisting: false, ip: req.ip, now: now() },
    );
    reply.header('Cache-Control', 'no-store');
    return reply.status(201).send(result);
  });

  // Arma los clubes públicos de `ids` (en ese orden) con sus canchas activas y no borradas, por orden de alta.
  async function loadPublicClubs(ids: string[]) {
    if (ids.length === 0) return [];
    const [clubRows, courtRows] = await Promise.all([
      db.query<PublicClubRow>(
        `SELECT id, name, zone, city, address, image_url FROM clubs WHERE id = ANY($1::text[]) AND active`,
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
        WHERE c.active AND ($1::text IS NULL OR c.city = $1)
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
  // El club trae su estado (`active`): uno desactivado sigue gestionándose, y el panel avisa que no se muestra.
  app.get('/club/courts', async (req, reply) => {
    const clubId = await requireClubAdmin(req);
    const [club] = await db.query<{ id: string; name: string; zone: string; city: string; address: string; active: boolean }>(
      `SELECT id, name, zone, city, address, active FROM clubs WHERE id = $1`,
      [clubId],
    );
    if (!club) throw notFound('No encontramos tu club.');
    reply.header('Cache-Control', 'no-store');
    return { club, courts: await listCourts(db, clubId) };
  });

  // POST /api/club/courts -> 201 { court } (activa); 409 si el nombre se repite o se llegó al tope.
  app.post('/club/courts', async (req, reply) => {
    const clubId = await requireClubAdmin(req);
    const body = createCourtBody.parse(req.body);
    return reply.status(201).send({ court: await createCourt(db, clubId, body) });
  });

  // PATCH /api/club/courts/:id -> 200 { court }; 404 si no existe, es de otro club o está borrada.
  app.patch('/club/courts/:id', async (req) => {
    const clubId = await requireClubAdmin(req);
    const { id } = idParam.parse(req.params);
    const body = patchCourtBody.parse(req.body);
    return { court: await updateCourt(db, clubId, id, body) };
  });

  // GET /api/club/bookings -> { bookings } de las canchas del club, solo lectura.
  app.get('/club/bookings', async (req, reply) => {
    const clubId = await requireClubAdmin(req);
    reply.header('Cache-Control', 'no-store');
    return { bookings: await listClubBookings(db, clubId) };
  });

  // GET /api/club/recordings -> { recordings } de las canchas del club (cualquier estado), solo lectura.
  app.get('/club/recordings', async (req, reply) => {
    const clubId = await requireClubAdmin(req);
    reply.header('Cache-Control', 'no-store');
    return { recordings: await listClubRecordings(db, clubId) };
  });

  // GET /api/club/courts/:courtId/schedule -> { days } del horario semanal; 404 si la cancha no es del club o está borrada.
  app.get('/club/courts/:courtId/schedule', async (req, reply) => {
    const clubId = await requireClubAdmin(req);
    const { courtId } = courtIdParam.parse(req.params);
    await requireCourt(db, clubId, courtId);
    reply.header('Cache-Control', 'no-store');
    return { days: await getSchedule(db, courtId) };
  });

  // PUT /api/club/courts/:courtId/schedule -> reemplaza todo el horario ({ days: [{ weekday, startHour, endHour }] }).
  app.put('/club/courts/:courtId/schedule', async (req) => {
    const clubId = await requireClubAdmin(req);
    const { courtId } = courtIdParam.parse(req.params);
    const body = scheduleBody.parse(req.body);
    await requireCourt(db, clubId, courtId);
    return { days: await replaceSchedule(db, courtId, body.days) };
  });

  // DELETE /api/club/courts/:id -> 204. Borrado lógico: la fila se conserva con `deleted_at`.
  // 404 si no existe, es de otro club o ya estaba borrada (todas se responden igual).
  app.delete('/club/courts/:id', async (req, reply) => {
    const clubId = await requireClubAdmin(req);
    const { id } = idParam.parse(req.params);
    await deleteCourt(db, clubId, id);
    return reply.status(204).send();
  });
}
