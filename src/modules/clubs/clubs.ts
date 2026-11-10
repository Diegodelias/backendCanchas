import type { Database } from '../../db/client.js';

/**
 * Ciudades que el sitio conoce. Copia de `frontend2/src/data/cities.ts`: la lista de ciudades sigue
 * siendo del frontend. Un club con una ciudad que el sitio no conoce no se vería en la landing.
 */
export const CITY_IDS = ['buenos-aires', 'rosario', 'cordoba'] as const;

/** Mismo formato que el `check` de la tabla `clubs`. */
const CLUB_ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Error de datos al crear o editar un club: no se cambió nada. `taken` es un identificador que ya existe. */
export class ClubInputError extends Error {
  constructor(
    message: string,
    public readonly kind: 'invalid' | 'taken' = 'invalid',
  ) {
    super(message);
    this.name = 'ClubInputError';
  }
}

export interface NewClub {
  id: string;
  name: string;
  zone: string;
  city: string;
  address: string;
}

export interface Club extends NewClub {
  active: boolean;
  createdAt: Date;
}

/** Datos de un club que se pueden editar. El identificador no está: no se cambia nunca. */
export interface ClubFields {
  name: string;
  zone: string;
  city: string;
  address: string;
}

/** Valida y limpia el identificador de un club (formato y largo). */
export function validateClubId(rawId: string): string {
  const id = rawId.trim();
  if (id.length < 3 || id.length > 60 || !CLUB_ID_PATTERN.test(id)) {
    throw new ClubInputError(
      `El identificador «${id}» no es válido: usá entre 3 y 60 caracteres, solo minúsculas, números y guiones (ej. mi-club-norte).`,
    );
  }
  return id;
}

/**
 * Valida y limpia el nombre, la zona, la ciudad y la dirección de un club. Son las mismas reglas para el alta
 * (comando y panel de la plataforma) y para la edición.
 */
export function validateClubFields(input: ClubFields): ClubFields {
  const name = input.name.trim();
  const zone = input.zone.trim();
  const city = input.city.trim();
  const address = input.address.trim();

  if (!name) throw new ClubInputError('Falta el nombre del club.');
  if (name.length > 80) throw new ClubInputError('El nombre del club puede tener hasta 80 caracteres.');
  if (!zone) throw new ClubInputError('Falta la zona del club.');
  if (!address) throw new ClubInputError('Falta la dirección del club.');
  if (!(CITY_IDS as readonly string[]).includes(city)) {
    throw new ClubInputError(`La ciudad «${city}» no existe en el sitio. Ciudades válidas: ${CITY_IDS.join(', ')}.`);
  }
  return { name, zone, city, address };
}

interface ClubRow {
  id: string;
  name: string;
  zone: string;
  city: string;
  address: string;
  active: boolean;
  created_at: Date;
}

const toClub = (row: ClubRow): Club => ({
  id: row.id,
  name: row.name,
  zone: row.zone,
  city: row.city,
  address: row.address,
  active: row.active,
  createdAt: row.created_at,
});

export async function createClub(db: Database, input: NewClub): Promise<Club> {
  const id = validateClubId(input.id);
  const { name, zone, city, address } = validateClubFields(input);

  const taken = new ClubInputError(`Ya existe un club con el identificador ${id}.`, 'taken');
  const existing = await db.query(`SELECT 1 FROM clubs WHERE id = $1`, [id]);
  if (existing.length > 0) throw taken;

  try {
    const [row] = await db.query<ClubRow>(
      `INSERT INTO clubs (id, name, zone, city, address) VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, zone, city, address, active, created_at`,
      [id, name, zone, city, address],
    );
    return toClub(row!);
  } catch (err) {
    // Otro alta con el mismo identificador pudo entrar entre la consulta y el insert.
    if ((err as { code?: string }).code === '23505') throw taken;
    throw err;
  }
}

/** Resultado de `deleteClub`: se borró, no existe o tiene reservas o grabaciones (y no se tocó nada). */
export type DeleteClubResult =
  | { status: 'deleted' }
  | { status: 'not_found' }
  | { status: 'not_empty'; bookings: number; recordings: number };

/**
 * Elimina un club de forma definitiva, con sus admins, canchas y horarios, solo si no tiene reservas ni grabaciones.
 * Es una única sentencia: cuenta y borra juntos, así que no queda un club sin admins si algo falla a la mitad.
 */
export async function deleteClub(db: Database, id: string): Promise<DeleteClubResult> {
  const [row] = await db.query<{ bookings: number; recordings: number; existed: boolean; deleted: number }>(
    `WITH counts AS (
       SELECT
         (SELECT count(*)::int FROM bookings b JOIN courts k ON k.id = b.court_id WHERE k.club_id = $1) AS bookings,
         (SELECT count(*)::int FROM recordings r JOIN courts k ON k.id = r.court_id WHERE k.club_id = $1) AS recordings
     ),
     removed_admins AS (
       DELETE FROM users
       WHERE club_id = $1 AND role = 'club_admin' AND (SELECT bookings + recordings FROM counts) = 0
       RETURNING 1
     ),
     removed_club AS (
       DELETE FROM clubs WHERE id = $1 AND (SELECT bookings + recordings FROM counts) = 0
       RETURNING id
     )
     SELECT (SELECT bookings FROM counts) AS bookings,
            (SELECT recordings FROM counts) AS recordings,
            EXISTS (SELECT 1 FROM clubs WHERE id = $1) AS existed,
            (SELECT count(*)::int FROM removed_club) AS deleted`,
    [id],
  );
  if (!row) return { status: 'not_found' };
  if (row.deleted > 0) return { status: 'deleted' };
  if (!row.existed) return { status: 'not_found' };
  return { status: 'not_empty', bookings: row.bookings, recordings: row.recordings };
}

/** Qué se puede cambiar de un club. El identificador nunca. */
export interface ClubPatch extends Partial<ClubFields> {
  active?: boolean;
}

/**
 * Edita un club: nombre, zona, ciudad, dirección y estado. Cada dato cambiado se valida con las mismas
 * reglas que el alta. Devuelve null si el club no existe.
 */
export async function updateClub(db: Database, id: string, patch: ClubPatch): Promise<Club | null> {
  const [current] = await db.query<ClubRow>(
    `SELECT id, name, zone, city, address, active, created_at FROM clubs WHERE id = $1`,
    [id],
  );
  if (!current) return null;

  // Solo se revalidan los datos si el pedido cambia alguno: activar o desactivar no toca nada más.
  const editsFields = patch.name !== undefined || patch.zone !== undefined || patch.city !== undefined || patch.address !== undefined;
  const merged: ClubFields = {
    name: patch.name ?? current.name,
    zone: patch.zone ?? current.zone,
    city: patch.city ?? current.city,
    address: patch.address ?? current.address,
  };
  const fields = editsFields ? validateClubFields(merged) : merged;
  const [row] = await db.query<ClubRow>(
    `UPDATE clubs SET name = $2, zone = $3, city = $4, address = $5, active = $6 WHERE id = $1
     RETURNING id, name, zone, city, address, active, created_at`,
    [id, fields.name, fields.zone, fields.city, fields.address, patch.active ?? current.active],
  );
  return row ? toClub(row) : null;
}
