import { fileURLToPath } from 'node:url';
import { runner } from 'node-pg-migrate';

/** Carpeta `migrations/` del backend (vale igual desde `src/` y desde `dist/`). */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url));

export class MigrationError extends Error {
  constructor(
    /** Migración que falló, o null si el error fue antes de aplicar alguna (p. ej. sin conexión). */
    public readonly migration: string | null,
    cause: unknown,
  ) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(
      migration
        ? `Falló la migración ${migration}: ${detail}`
        : `No se pudieron aplicar las migraciones: ${detail}`,
    );
    this.name = 'MigrationError';
  }
}

export interface RunMigrationsOptions {
  /** Carpeta de migraciones; por defecto `MIGRATIONS_DIR`. */
  dir?: string;
  /** Destino de los mensajes del runner; por defecto ninguno. */
  log?: (message: string) => void;
}

/**
 * Aplica las migraciones pendientes, todas en una transacción.
 * Devuelve los nombres de las que aplicó (vacío si no había ninguna).
 * Si una falla, no queda ninguna aplicada y lanza `MigrationError` con su nombre.
 */
export async function runMigrations(
  databaseUrl: string,
  { dir = MIGRATIONS_DIR, log = () => {} }: RunMigrationsOptions = {},
): Promise<string[]> {
  let current: string | null = null;
  const write = (msg: unknown) => {
    const text = String(msg);
    const m = text.match(/### MIGRATION (.+) \((?:UP|DOWN)\) ###/);
    if (m) current = m[1]!;
    log(text);
  };
  try {
    const applied = await runner({
      databaseUrl,
      dir,
      direction: 'up',
      migrationsTable: 'pgmigrations',
      checkOrder: true,
      singleTransaction: true,
      logger: { debug: () => {}, info: write, warn: write, error: write },
    });
    return applied.map((m) => m.name);
  } catch (err) {
    throw new MigrationError(current, err);
  }
}
