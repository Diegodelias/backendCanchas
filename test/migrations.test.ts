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
    expect(applied).toEqual([
      '1762500000000_acceso-admin',
      '1762600000000_acceso-jugador',
      '1762700000000_recuperar-contrasena',
      '1762800000000_clubes-y-canchas',
    ]);

    const tables = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`,
    );
    expect(tables.map((t) => t.table_name)).toEqual([
      'clubs',
      'courts',
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

  it('los links y los pedidos llevan un propósito, con acceso por defecto', async () => {
    await db.query(`INSERT INTO login_tokens (email, token_hash, expires_at) VALUES ('a@x.example', 'h1', now())`);
    const [row] = await db.query<{ purpose: string }>(`SELECT purpose FROM login_tokens WHERE token_hash = 'h1'`);
    expect(row!.purpose).toBe('access');
    await expect(
      db.query(`INSERT INTO login_tokens (email, token_hash, expires_at, purpose) VALUES ('a@x.example', 'h2', now(), 'otro')`),
    ).rejects.toThrow(/login_tokens_purpose_check/);
    await expect(
      db.query(`INSERT INTO link_requests (email, ip, purpose) VALUES ('a@x.example', '1.1.1.1', 'otro')`),
    ).rejects.toThrow(/link_requests_purpose_check/);
    await db.query(`DELETE FROM login_tokens`);
  });

  it('carga los 6 clubes y las 12 canchas de ejemplo, activas y en el orden de ejemplo', async () => {
    const clubs = await db.query<{ id: string; city: string }>('SELECT id, city FROM clubs ORDER BY created_at, id');
    expect(clubs.map((c) => c.id)).toEqual([
      'estacion-norte',
      'la-cantera-crespo',
      'polideportivo-belgrano',
      'parque-sur-caballito',
      'arena-nunez',
      'terraza-colegiales',
    ]);
    expect(new Set(clubs.map((c) => c.city))).toEqual(new Set(['buenos-aires']));

    const courts = await db.query<{ id: string; club_id: string; name: string; sport: string; price: number; active: boolean }>(
      'SELECT id, club_id, name, sport, price, active FROM courts ORDER BY created_at, id',
    );
    expect(courts).toHaveLength(12);
    expect(courts.every((c) => c.active)).toBe(true);
    expect(courts.map((c) => c.id)).toEqual([
      'en-f5-1', 'en-f7-1', 'lc-f5-a', 'lc-f7-b', 'pb-f5-1', 'pb-f8-2',
      'ps-f5-1', 'ps-f7-1', 'an-f5', 'an-f8', 'an-f11', 'tc-f5-1',
    ]);
    const perClub = (id: string) => courts.filter((c) => c.club_id === id).length;
    expect([
      'estacion-norte', 'la-cantera-crespo', 'polideportivo-belgrano',
      'parque-sur-caballito', 'arena-nunez', 'terraza-colegiales',
    ].map(perClub)).toEqual([2, 2, 2, 2, 3, 1]);
    expect(courts.find((c) => c.id === 'en-f5-1')).toMatchObject({
      name: 'Cancha 1 · Fútbol 5', sport: 'Fútbol 5', price: 28000, club_id: 'estacion-norte',
    });
    expect(courts.find((c) => c.id === 'an-f11')).toMatchObject({ sport: 'Fútbol 11', price: 68000 });
  });

  it('los checks de clubes y canchas rechazan datos inválidos', async () => {
    const club = (id: string) =>
      db.query(`INSERT INTO clubs (id, name, zone, city, address) VALUES ($1, 'N', 'Z', 'buenos-aires', 'D')`, [id]);
    await expect(club('Con Mayúsculas')).rejects.toThrow(/clubs_id_check/);
    await expect(club('ab')).rejects.toThrow(/clubs_id_check/);
    await expect(club('-empieza-con-guion')).rejects.toThrow(/clubs_id_check/);

    const court = (sport: string, price: number) =>
      db.query(
        `INSERT INTO courts (id, club_id, name, sport, price) VALUES (gen_random_uuid()::text, 'estacion-norte', gen_random_uuid()::text, $1, $2)`,
        [sport, price],
      );
    await expect(court('Tenis', 1000)).rejects.toThrow(/courts_sport_check/);
    await expect(court('Fútbol 5', 0)).rejects.toThrow(/courts_price_check/);
    await expect(court('Fútbol 5', -5)).rejects.toThrow(/courts_price_check/);
  });

  it('el nombre de una cancha es único dentro del club sin distinguir mayúsculas, y puede repetirse en otro club', async () => {
    await db.query(`INSERT INTO clubs (id, name, zone, city, address) VALUES ('test-unico-a', 'A', 'Z', 'buenos-aires', 'D'), ('test-unico-b', 'B', 'Z', 'buenos-aires', 'D')`);
    const court = (club: string, name: string) =>
      db.query(`INSERT INTO courts (id, club_id, name, sport, price) VALUES (gen_random_uuid()::text, $1, $2, 'Fútbol 5', 1000)`, [club, name]);
    await court('test-unico-a', 'Cancha Uno');
    await expect(court('test-unico-a', 'CANCHA uno')).rejects.toThrow(/courts_club_name_key/);
    await court('test-unico-b', 'Cancha Uno');
    await db.query(`DELETE FROM clubs WHERE id LIKE 'test-unico-%'`);
  });

  it('un admin no puede quedar asociado a un club que no existe', async () => {
    await expect(
      db.query(
        `INSERT INTO users (email, name, role, club_id, password_hash) VALUES ('fk@club.example', 'FK', 'club_admin', 'no-existe', 'hash')`,
      ),
    ).rejects.toThrow(/users_club_id_fkey/);
    await db.query(
      `INSERT INTO users (email, name, role, club_id, password_hash) VALUES ('fk@club.example', 'FK', 'club_admin', 'estacion-norte', 'hash')`,
    );
    await db.query(`DELETE FROM users WHERE email = 'fk@club.example'`);
  });

  it('un reinicio conserva los cambios de un admin sobre los datos iniciales y no duplica nada', async () => {
    await db.query(`UPDATE courts SET price = 35000, active = false WHERE id = 'en-f5-1'`);
    expect(await runMigrations(url)).toEqual([]);
    const [row] = await db.query<{ price: number; active: boolean }>(`SELECT price, active FROM courts WHERE id = 'en-f5-1'`);
    expect(row).toEqual({ price: 35000, active: false });
    expect(await db.query('SELECT 1 FROM clubs')).toHaveLength(6);
    expect(await db.query('SELECT 1 FROM courts')).toHaveLength(12);
    await db.query(`UPDATE courts SET price = 28000, active = true WHERE id = 'en-f5-1'`);
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
