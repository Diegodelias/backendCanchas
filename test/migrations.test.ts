import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPgDatabase, type Database } from '../src/db/client.js';
import { MigrationError, MIGRATIONS_DIR, runMigrations } from '../src/db/migrate.js';
import { requireTestDatabaseUrl } from './helpers.js';

describe('migraciones', () => {
  let url: string;
  let db: Database;

  beforeAll(() => {
    url = requireTestDatabaseUrl();
    db = createPgDatabase(url);
  });
  afterAll(async () => {
    await db?.close();
  });

  it('una base vacía queda con el esquema completo', async () => {
    await db.query('DROP SCHEMA public CASCADE');
    await db.query('CREATE SCHEMA public');

    const applied = await runMigrations(url);
    expect(applied).toEqual(['1762500000000_acceso-admin', '1762600000000_acceso-jugador']);

    const tables = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`,
    );
    expect(tables.map((t) => t.table_name)).toEqual([
      'link_requests',
      'login_attempts',
      'login_tokens',
      'pgmigrations',
      'plays',
      'sessions',
      'users',
    ]);
  });

  it('el check impide un admin sin club o sin contraseña', async () => {
    await expect(
      db.query(`INSERT INTO users (email, name, role) VALUES ('a@club.example', 'A', 'club_admin')`),
    ).rejects.toThrow(/users_club_admin_needs_club_and_password/);
  });

  it('un jugador se puede crear sin nombre, pero un admin sigue necesitando club y contraseña', async () => {
    await db.query(`INSERT INTO users (email, role) VALUES ('jugador@mail.example', 'player')`);
    await expect(
      db.query(`INSERT INTO users (email, name, role) VALUES ('b@club.example', 'B', 'club_admin')`),
    ).rejects.toThrow(/users_club_admin_needs_club_and_password/);
    await db.query(`DELETE FROM users`);
  });

  it('un segundo arranque no aplica nada', async () => {
    expect(await runMigrations(url)).toEqual([]);
  });

  it('una migración rota falla con su nombre y no deja nada aplicado', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'canchas3-migr-'));
    try {
      for (const f of readdirSync(MIGRATIONS_DIR)) copyFileSync(path.join(MIGRATIONS_DIR, f), path.join(dir, f));
      writeFileSync(
        path.join(dir, '1999999999999_rota.sql'),
        '-- Up Migration\nCREATE TABLE tabla_parcial (id int);\nSELECT * FROM tabla_que_no_existe;\n',
      );

      const err = await runMigrations(url, { dir }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(MigrationError);
      expect((err as MigrationError).migration).toBe('1999999999999_rota');
      expect((err as Error).message).toContain('1999999999999_rota');

      const leftovers = await db.query(
        `SELECT 1 FROM information_schema.tables WHERE table_name = 'tabla_parcial'`,
      );
      expect(leftovers).toHaveLength(0);
      const recorded = await db.query(`SELECT 1 FROM pgmigrations WHERE name = '1999999999999_rota'`);
      expect(recorded).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('si las migraciones no se pueden aplicar, el servidor termina con código 1 sin abrir el puerto', () => {
    const backendDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
      cwd: backendDir,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        PORT: '3999',
        // Puerto sin base: la migración falla antes de buildApp/listen.
        DATABASE_URL: 'postgres://canchas3:canchas3@127.0.0.1:1/canchas3',
      },
      encoding: 'utf8',
      timeout: 30000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('migraciones');
    expect(result.stdout).not.toContain('Server listening');
  });
});
