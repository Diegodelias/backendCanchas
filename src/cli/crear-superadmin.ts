/**
 * Crea la cuenta de un superadmin: el rol que opera la plataforma (clubes, canchas y admins de club).
 * Es la única forma de crear un superadmin; no hay ruta ni pantalla que lo haga.
 *
 *   npm run crear-superadmin -- --email root@canchas3.example --nombre "Operación"
 *   docker compose exec api node dist/cli/crear-superadmin.js --email … --nombre "…"
 *
 * La contraseña se pide por teclado (sin mostrarla). Sin terminal interactiva se lee de
 * ADMIN_PASSWORD. Nunca se pasa como argumento: quedaría en el historial de la shell.
 */
import { parseArgs } from 'node:util';
import { createPgDatabase } from '../db/client.js';
import { AdminInputError, createSuperadmin } from '../modules/auth/admins.js';
import { readPassword } from './password-prompt.js';

const USAGE = `Uso: crear-superadmin --email <mail> --nombre "<nombre>"
El superadmin no pertenece a ningún club. El mail no puede tener ya una cuenta (de ningún rol).
La contraseña se pide por teclado, o se lee de ADMIN_PASSWORD si no hay terminal.`;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function main() {
  let values: { email?: string; nombre?: string };
  try {
    ({ values } = parseArgs({
      options: {
        email: { type: 'string' },
        nombre: { type: 'string' },
      },
      strict: true,
    }));
  } catch (err) {
    fail(`${(err as Error).message}\n\n${USAGE}`);
  }
  if (!values.email || !values.nombre) fail(USAGE);

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) fail('Falta DATABASE_URL (conexión a PostgreSQL).');

  const password = await readPassword(fail);
  const db = createPgDatabase(databaseUrl);
  try {
    const admin = await createSuperadmin(db, { email: values.email, name: values.nombre, password });
    console.log(`Superadmin creado: ${admin.email} (${admin.name}).`);
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
