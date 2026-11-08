/**
 * Crea un admin de club para entregar una cuenta de prueba.
 *
 *   npm run crear-admin -- --email ana@club.example --nombre "Ana Pérez" --club estacion-norte
 *   docker compose exec api node dist/cli/crear-admin.js --email … --nombre "…" --club …
 *
 * La contraseña se pide por teclado (sin mostrarla). Sin terminal interactiva se lee de
 * ADMIN_PASSWORD. Nunca se pasa como argumento: quedaría en el historial de la shell.
 */
import { parseArgs } from 'node:util';
import { createPgDatabase } from '../db/client.js';
import { AdminInputError, createAdmin } from '../modules/auth/admins.js';
import { readPassword } from './password-prompt.js';

const USAGE = `Uso: crear-admin --email <mail> --nombre "<nombre>" --club <id>
El club tiene que existir (si no, el error lista los válidos; se dan de alta con crear-club).
La contraseña se pide por teclado, o se lee de ADMIN_PASSWORD si no hay terminal.`;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function main() {
  let values: { email?: string; nombre?: string; club?: string };
  try {
    ({ values } = parseArgs({
      options: {
        email: { type: 'string' },
        nombre: { type: 'string' },
        club: { type: 'string' },
      },
      strict: true,
    }));
  } catch (err) {
    fail(`${(err as Error).message}\n\n${USAGE}`);
  }
  if (!values.email || !values.nombre || !values.club) fail(USAGE);

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) fail('Falta DATABASE_URL (conexión a PostgreSQL).');

  const password = await readPassword(fail);
  const db = createPgDatabase(databaseUrl);
  try {
    const admin = await createAdmin(db, {
      email: values.email,
      name: values.nombre,
      clubId: values.club,
      password,
    });
    console.log(`Admin creado: ${admin.email} (${admin.name}), club ${admin.clubId}.`);
  } catch (err) {
    if (err instanceof AdminInputError) fail(`${err.message} No se creó nada.`);
    throw err;
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
