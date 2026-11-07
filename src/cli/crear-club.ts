/**
 * Da de alta un club. Después se le asigna un admin con `crear-admin` y el admin carga sus canchas en el panel.
 *
 *   npm run crear-club -- --id mi-club --nombre "Mi Club" --zona Palermo --ciudad buenos-aires --direccion "Av. Siempreviva 742"
 *   docker compose exec api node dist/cli/crear-club.js --id … --nombre "…" --zona … --ciudad … --direccion "…"
 */
import { parseArgs } from 'node:util';
import { createPgDatabase } from '../db/client.js';
import { CITY_IDS, ClubInputError, createClub } from '../modules/clubs/clubs.js';

const USAGE = `Uso: crear-club --id <identificador> --nombre "<nombre>" --zona "<zona>" --ciudad <ciudad> --direccion "<dirección>"
El identificador usa minúsculas, números y guiones (ej. mi-club-norte).
Ciudades válidas: ${CITY_IDS.join(', ')}`;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function main() {
  let values: { id?: string; nombre?: string; zona?: string; ciudad?: string; direccion?: string };
  try {
    ({ values } = parseArgs({
      options: {
        id: { type: 'string' },
        nombre: { type: 'string' },
        zona: { type: 'string' },
        ciudad: { type: 'string' },
        direccion: { type: 'string' },
      },
      strict: true,
    }));
  } catch (err) {
    fail(`${(err as Error).message}\n\n${USAGE}`);
  }
  if (!values.id || !values.nombre || !values.zona || !values.ciudad || !values.direccion) fail(USAGE);

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) fail('Falta DATABASE_URL (conexión a PostgreSQL).');

  const db = createPgDatabase(databaseUrl);
  try {
    const club = await createClub(db, {
      id: values.id,
      name: values.nombre,
      zone: values.zona,
      city: values.ciudad,
      address: values.direccion,
    });
    console.log(`Club creado: ${club.id} (${club.name}), ${club.zone}, ${club.city}.`);
    console.log(`Siguiente paso: crear-admin --club ${club.id} …`);
  } catch (err) {
    if (err instanceof ClubInputError) fail(`${err.message} No se creó nada.`);
    throw err;
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
