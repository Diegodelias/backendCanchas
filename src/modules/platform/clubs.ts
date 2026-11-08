import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../../app.js';
import type { Database } from '../../db/client.js';
import { AppError, badRequest, notFound } from '../../lib/errors.js';
import { ClubInputError, createClub, updateClub } from '../clubs/clubs.js';
import { requireSuperadmin } from './guard.js';

/** Clubes por página de la lista de la plataforma, y el máximo que se acepta. */
export const DEFAULT_PLATFORM_CLUBS_PER_PAGE = 20;
export const MAX_PLATFORM_CLUBS_PER_PAGE = 50;

const listQuery = z.object({
  q: z.string().trim().max(100, 'La búsqueda puede tener hasta 100 caracteres.').optional(),
  page: z.coerce
    .number({ error: 'La página debe ser un número.' })
    .int('La página debe ser un número entero.')
    .min(1, 'La página empieza en 1.')
    .default(1),
  limit: z.coerce
    .number({ error: 'El límite debe ser un número.' })
    .int('El límite debe ser un número entero.')
    .min(1, 'El límite mínimo es 1.')
    .max(MAX_PLATFORM_CLUBS_PER_PAGE, `El límite máximo es ${MAX_PLATFORM_CLUBS_PER_PAGE}.`)
    .default(DEFAULT_PLATFORM_CLUBS_PER_PAGE),
});

const createBody = z.object({
  id: z.string({ error: 'Falta el identificador del club.' }),
  name: z.string({ error: 'Falta el nombre del club.' }),
  zone: z.string({ error: 'Falta la zona del club.' }),
  city: z.string({ error: 'Falta la ciudad del club.' }),
  address: z.string({ error: 'Falta la dirección del club.' }),
});

const PATCHABLE = ['name', 'zone', 'city', 'address', 'active'] as const;

const patchBody = z.object({
  name: z.string({ error: 'El nombre del club debe ser un texto.' }).optional(),
  zone: z.string({ error: 'La zona del club debe ser un texto.' }).optional(),
  city: z.string({ error: 'La ciudad del club debe ser un texto.' }).optional(),
  address: z.string({ error: 'La dirección del club debe ser un texto.' }).optional(),
  active: z.boolean({ error: 'El estado del club debe ser verdadero o falso.' }).optional(),
});

const idParam = z.object({ id: z.string().min(1).max(100) });

/** Pasa a minúsculas y quita las tildes: la búsqueda no distingue mayúsculas ni tildes. */
export function normalizeSearch(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

/** Lo mismo que `normalizeSearch`, hecho en SQL sobre una columna (sin depender de la extensión unaccent). */
const SQL_NORMALIZE = (column: string) =>
  `translate(lower(${column}), 'áàâäãéèêëíìîïóòôöõúùûüñç', 'aaaaaeeeeiiiiooooouuuunc')`;

const escapeLike = (text: string) => text.replace(/[\\%_]/g, (ch) => `\\${ch}`);

interface ClubSummaryRow {
  id: string;
  name: string;
  zone: string;
  city: string;
  address: string;
  active: boolean;
  active_courts: number;
  admins: number;
}

const SUMMARY_COLUMNS = `c.id, c.name, c.zone, c.city, c.address, c.active,
  (SELECT count(*)::int FROM courts k WHERE k.club_id = c.id AND k.active AND k.deleted_at IS NULL) AS active_courts,
  (SELECT count(*)::int FROM users u WHERE u.club_id = c.id AND u.role = 'club_admin' AND u.deactivated_at IS NULL) AS admins`;

const toSummary = (row: ClubSummaryRow) => ({
  id: row.id,
  name: row.name,
  zone: row.zone,
  city: row.city,
  address: row.address,
  active: row.active,
  activeCourts: row.active_courts,
  admins: row.admins,
});

/** Un club con sus conteos, o null si no existe. */
export async function loadClubSummary(db: Database, id: string) {
  const [row] = await db.query<ClubSummaryRow>(`SELECT ${SUMMARY_COLUMNS} FROM clubs c WHERE c.id = $1`, [id]);
  return row ? toSummary(row) : null;
}

/** Un error de datos del club se responde como un error de validación (400), salvo el identificador repetido (409). */
function clubInputToHttp(err: unknown): never {
  if (err instanceof ClubInputError) {
    throw err.kind === 'taken'
      ? new AppError(409, 'club_id_taken', err.message)
      : new AppError(400, 'validation_error', err.message);
  }
  throw err;
}

export async function platformClubsRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());

  // GET /api/platform/clubs?q=&page=&limit= -> todos los clubes (activos y desactivados), de a 20 por defecto.
  app.get('/platform/clubs', async (req, reply) => {
    await requireSuperadmin(db, req, now());
    const { q, page, limit } = listQuery.parse(req.query);

    const search = q ? `%${escapeLike(normalizeSearch(q))}%` : null;
    const where = `WHERE ($1::text IS NULL OR ${SQL_NORMALIZE('c.name')} LIKE $1 ESCAPE '\\')`;

    const [countRows, rows] = await Promise.all([
      db.query<{ total: string }>(`SELECT count(*) AS total FROM clubs c ${where}`, [search]),
      db.query<ClubSummaryRow>(
        `SELECT ${SUMMARY_COLUMNS} FROM clubs c ${where} ORDER BY c.created_at, c.id LIMIT $2 OFFSET $3`,
        [search, limit, (page - 1) * limit],
      ),
    ]);
    const total = Number(countRows[0]?.total ?? 0);

    reply.header('Cache-Control', 'no-store');
    return { clubs: rows.map(toSummary), page, limit, total, totalPages: Math.ceil(total / limit) };
  });

  // POST /api/platform/clubs -> 201 { club }. Las mismas reglas que el comando crear-club.
  app.post('/platform/clubs', async (req, reply) => {
    await requireSuperadmin(db, req, now());
    const body = createBody.parse(req.body);
    try {
      const created = await createClub(db, body);
      return reply.status(201).send({ club: await loadClubSummary(db, created.id) });
    } catch (err) {
      return clubInputToHttp(err);
    }
  });

  // PATCH /api/platform/clubs/:id -> 200 { club }. Cambia datos y estado; el identificador no se cambia nunca.
  app.patch('/platform/clubs/:id', async (req) => {
    await requireSuperadmin(db, req, now());
    const { id } = idParam.parse(req.params);

    const raw = (req.body ?? {}) as Record<string, unknown>;
    if (typeof raw !== 'object' || Array.isArray(raw)) throw badRequest('El pedido no es válido.');
    if ('id' in raw) throw badRequest('El identificador de un club no se puede cambiar.', 'club_id_immutable');
    const unknown = Object.keys(raw).filter((key) => !(PATCHABLE as readonly string[]).includes(key));
    if (unknown.length > 0) throw badRequest(`Ese dato del club no se puede cambiar: ${unknown.join(', ')}.`);
    const body = patchBody.parse(raw);
    if (Object.values(body).every((value) => value === undefined)) throw badRequest('No hay nada para cambiar.');

    try {
      const updated = await updateClub(db, id, body);
      if (!updated) throw notFound('No encontramos ese club.');
      return { club: await loadClubSummary(db, id) };
    } catch (err) {
      return clubInputToHttp(err);
    }
  });
}
