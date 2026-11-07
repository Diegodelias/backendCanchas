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

const USAGE = `Uso: crear-admin --email <mail> --nombre "<nombre>" --club <id>
El club tiene que existir (si no, el error lista los válidos; se dan de alta con crear-club).
La contraseña se pide por teclado, o se lee de ADMIN_PASSWORD si no hay terminal.`;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/** Lee una línea del teclado sin mostrarla. */
function promptHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stdout.write(question);
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write('\n');
          resolve(value);
          return;
        }
        if (ch === '\u0003') {
          stdin.setRawMode(false);
          process.stdout.write('\n');
          reject(new Error('Cancelado.'));
          return;
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function readPassword(): Promise<string> {
  if (process.stdin.isTTY) {
    const first = await promptHidden('Contraseña: ');
    const second = await promptHidden('Repetí la contraseña: ');
    if (first !== second) fail('Las contraseñas no coinciden. No se creó nada.');
    return first;
  }
  const fromEnv = process.env.ADMIN_PASSWORD;
  if (!fromEnv) fail('No hay terminal interactiva: definí ADMIN_PASSWORD con la contraseña. No se creó nada.');
  return fromEnv;
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

  const password = await readPassword();
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
