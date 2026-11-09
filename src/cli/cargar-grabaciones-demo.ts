/**
 * Carga o renueva las grabaciones de demostración (los 3 días anteriores a hoy) usando los clips de demostración de
 * VIDEOS_DIR (uno por cancha). Se puede volver a correr cuando las fechas queden viejas. NO corre solo al arrancar la API.
 *
 *   npm run cargar-grabaciones-demo
 *   docker compose exec api node dist/cli/cargar-grabaciones-demo.js
 */
import { createPgDatabase } from '../db/client.js';
import { DEMO_DAYS_BACK, DemoLoadError, loadDemoRecordings } from '../modules/recordings/demo.js';

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) fail('Falta DATABASE_URL (conexión a PostgreSQL).');
  const videosDir = process.env.VIDEOS_DIR || './videos';

  const db = createPgDatabase(databaseUrl);
  try {
    const result = await loadDemoRecordings(db, videosDir, new Date());
    console.log(`Grabaciones de demostración cargadas: ${result.loaded} (los ${DEMO_DAYS_BACK} días anteriores a hoy).`);
    if (result.missingCourts.length > 0) {
      console.warn(`Se omitieron las canchas que no existen: ${result.missingCourts.join(', ')}.`);
    }
    if (result.skippedExisting > 0) {
      console.warn(`Se omitieron ${result.skippedExisting} porque la cancha ya tenía otra grabación a esa hora.`);
    }
  } catch (err) {
    if (err instanceof DemoLoadError) fail(`${err.message} No se cargó nada.`);
    throw err;
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
