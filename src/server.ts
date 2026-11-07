import { buildApp } from './app.js';
import { loadConfig, type Config } from './config.js';
import { createPgDatabase } from './db/client.js';
import { runMigrations } from './db/migrate.js';

async function main() {
  let config: Config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }

  // El esquema se pone al día antes de abrir el puerto; si falla, la API no arranca.
  try {
    const applied = await runMigrations(config.DATABASE_URL);
    console.log(
      applied.length > 0 ? `Migraciones aplicadas: ${applied.join(', ')}` : 'Migraciones: nada pendiente',
    );
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }

  const db = createPgDatabase(config.DATABASE_URL);
  const app = await buildApp({ config, db });

  const shutdown = async () => {
    await app.close();
    await db.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await app.listen({ port: config.PORT, host: config.HOST });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
