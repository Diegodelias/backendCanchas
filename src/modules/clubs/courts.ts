import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Database } from '../../db/client.js';
import { AppError, notFound } from '../../lib/errors.js';

/**
 * Reglas y operaciones sobre las canchas de UN club. Las usan dos puertas con el mismo comportamiento:
 * el admin de club (siempre sobre el club de su sesión) y el superadmin (sobre el club que elige).
 * Todas reciben el `clubId` ya resuelto por quien las llama.
 */

/** Canchas que puede tener un club, activas o no, sin contar las borradas. */
export const MAX_COURTS_PER_CLUB = 50;

export const SPORTS = ['Fútbol 5', 'Fútbol 7', 'Fútbol 8', 'Fútbol 11'] as const;

const name = z
  .string({ error: 'Poné un nombre para la cancha.' })
  .trim()
  .min(1, 'Poné un nombre para la cancha.')
  .max(60, 'El nombre puede tener hasta 60 caracteres.');

export const sport = z.enum(SPORTS, { error: 'Elegí un deporte: Fútbol 5, Fútbol 7, Fútbol 8 o Fútbol 11.' });

const price = z
  .number({ error: 'El precio debe ser un número.' })
  .int('El precio debe ser un número entero de pesos.')
  .positive('El precio debe ser mayor que cero.')
  .max(100_000_000, 'El precio es demasiado alto.');

export const createCourtBody = z.object({ name, sport, price });

export const patchCourtBody = z
  .object({ name: name.optional(), sport: sport.optional(), price: price.optional(), active: z.boolean().optional() })
  .refine((b) => Object.values(b).some((v) => v !== undefined), { message: 'No hay nada para cambiar.' });

export type CreateCourtInput = z.infer<typeof createCourtBody>;
export type PatchCourtInput = z.infer<typeof patchCourtBody>;

interface CourtRow {
  id: string;
  name: string;
  sport: string;
  price: number;
  active: boolean;
}

const COURT_COLUMNS = 'id, name, sport, price, active';

export const toCourt = (row: CourtRow) => ({
  id: row.id,
  name: row.name,
  sport: row.sport,
  price: row.price,
  active: row.active,
});

const NAME_TAKEN = () =>
  new AppError(409, 'court_name_taken', 'Ya existe una cancha con ese nombre en tu club.');

/** Las canchas del club (activas o no, sin las borradas), por orden de alta. */
export async function listCourts(db: Database, clubId: string) {
  const rows = await db.query<CourtRow & { has_schedule: boolean }>(
    `SELECT ${COURT_COLUMNS},
            EXISTS (SELECT 1 FROM court_schedules s WHERE s.court_id = courts.id) AS has_schedule
       FROM courts WHERE club_id = $1 AND deleted_at IS NULL ORDER BY created_at, id`,
    [clubId],
  );
  // `hasSchedule` marca las canchas sin horarios cargados (no tienen turnos); solo lo trae el listado del panel.
  return rows.map((row) => ({ ...toCourt(row), hasSchedule: row.has_schedule }));
}

/** Crea una cancha activa. 409 si el nombre se repite en el club o se llegó al tope. */
export async function createCourt(db: Database, clubId: string, input: CreateCourtInput) {
  try {
    // Un único INSERT condicional: no hay transacciones en `Database`, y así el tope y el alta van juntos.
    const rows = await db.query<CourtRow>(
      `INSERT INTO courts (id, club_id, name, sport, price)
       SELECT $1::text, $2::text, $3::text, $4::text, $5::int
        WHERE (SELECT count(*) FROM courts WHERE club_id = $2::text AND deleted_at IS NULL) < $6::int
       RETURNING ${COURT_COLUMNS}`,
      [`c-${randomUUID()}`, clubId, input.name, input.sport, input.price, MAX_COURTS_PER_CLUB],
    );
    const row = rows[0];
    if (!row) {
      throw new AppError(
        409,
        'courts_limit_reached',
        `Tu club llegó al máximo de ${MAX_COURTS_PER_CLUB} canchas. Desactivá o reutilizá alguna.`,
      );
    }
    return toCourt(row);
  } catch (err) {
    // El índice único (club, nombre sin mayúsculas) detecta el nombre repetido, también entre dos pedidos a la vez.
    if ((err as { code?: string }).code === '23505') throw NAME_TAKEN();
    throw err;
  }
}

/** Cambia una cancha. 404 si no existe, es de otro club o está borrada. */
export async function updateCourt(db: Database, clubId: string, courtId: string, input: PatchCourtInput) {
  const params: unknown[] = [courtId, clubId];
  const sets: string[] = [];
  const set = (column: string, value: unknown) => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };
  if (input.name !== undefined) set('name', input.name);
  if (input.sport !== undefined) set('sport', input.sport);
  if (input.price !== undefined) set('price', input.price);
  if (input.active !== undefined) set('active', input.active);

  try {
    const rows = await db.query<CourtRow>(
      `UPDATE courts SET ${sets.join(', ')} WHERE id = $1 AND club_id = $2 AND deleted_at IS NULL RETURNING ${COURT_COLUMNS}`,
      params,
    );
    if (!rows[0]) throw notFound('No encontramos esa cancha.');
    return toCourt(rows[0]);
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw NAME_TAKEN();
    throw err;
  }
}

/**
 * Borrado lógico: la fila se conserva con `deleted_at`. 404 si no existe, es de otro club o ya estaba borrada
 * (las tres se responden igual).
 */
export async function deleteCourt(db: Database, clubId: string, courtId: string): Promise<void> {
  const rows = await db.query<{ id: string }>(
    `UPDATE courts SET deleted_at = now() WHERE id = $1 AND club_id = $2 AND deleted_at IS NULL RETURNING id`,
    [courtId, clubId],
  );
  if (!rows[0]) throw notFound('No encontramos esa cancha.');
}
