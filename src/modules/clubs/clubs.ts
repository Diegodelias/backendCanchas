import type { Database } from '../../db/client.js';

/**
 * Ciudades que el sitio conoce. Copia de `frontend2/src/data/cities.ts`: la lista de ciudades sigue
 * siendo del frontend. Un club con una ciudad que el sitio no conoce no se vería en la landing.
 */
export const CITY_IDS = ['buenos-aires', 'rosario', 'cordoba'] as const;

/** Mismo formato que el `check` de la tabla `clubs`. */
const CLUB_ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Error de datos al crear un club: no se creó nada. */
export class ClubInputError extends Error {
  constructor(message: string) {
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
  createdAt: Date;
}

export async function createClub(db: Database, input: NewClub): Promise<Club> {
  const id = input.id.trim();
  const name = input.name.trim();
  const zone = input.zone.trim();
  const city = input.city.trim();
  const address = input.address.trim();

  if (id.length < 3 || id.length > 60 || !CLUB_ID_PATTERN.test(id)) {
    throw new ClubInputError(
      `El identificador «${id}» no es válido: usá entre 3 y 60 caracteres, solo minúsculas, números y guiones (ej. mi-club-norte).`,
    );
  }
  if (!name) throw new ClubInputError('Falta el nombre del club.');
  if (name.length > 80) throw new ClubInputError('El nombre del club puede tener hasta 80 caracteres.');
  if (!zone) throw new ClubInputError('Falta la zona del club.');
  if (!address) throw new ClubInputError('Falta la dirección del club.');
  if (!(CITY_IDS as readonly string[]).includes(city)) {
    throw new ClubInputError(`La ciudad «${city}» no existe en el sitio. Ciudades válidas: ${CITY_IDS.join(', ')}.`);
  }

  const taken = new ClubInputError(`Ya existe un club con el identificador ${id}.`);
  const existing = await db.query(`SELECT 1 FROM clubs WHERE id = $1`, [id]);
  if (existing.length > 0) throw taken;

  try {
    const [row] = await db.query<{ id: string; name: string; zone: string; city: string; address: string; created_at: Date }>(
      `INSERT INTO clubs (id, name, zone, city, address) VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, zone, city, address, created_at`,
      [id, name, zone, city, address],
    );
    return { id: row!.id, name: row!.name, zone: row!.zone, city: row!.city, address: row!.address, createdAt: row!.created_at };
  } catch (err) {
    // Otro alta con el mismo identificador pudo entrar entre la consulta y el insert.
    if ((err as { code?: string }).code === '23505') throw taken;
    throw err;
  }
}
