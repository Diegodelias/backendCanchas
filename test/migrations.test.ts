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
      '1762900000000_canchas-borrado-e-imagen',
      '1763000000000_panel-superadmin',
      '1763100000000_horarios-y-reservas',
      '1763200000000_grabaciones',
      '1763300000000_fragmento-de-jugada',
      '1763400000000_codigo-de-acceso',
      '1763500000000_nombre-del-sitio',
    ]);

    const tables = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`,
    );
    expect(tables.map((t) => t.table_name)).toEqual([
      'bookings',
      'clubs',
      'court_schedules',
      'courts',
      'link_requests',
      'login_attempts',
      'login_tokens',
      'pgmigrations',
      'plays',
      'recordings',
      'sessions',
      'site_settings',
      'users',
    ]);
  });

  it('el check impide un admin de club sin club', async () => {
    await expect(
      db.query(`INSERT INTO users (email, name, role) VALUES ('a@club.example', 'A', 'club_admin')`),
    ).rejects.toThrow(/users_role_shape_check/);
  });

  it('un jugador se puede crear sin nombre, pero un admin sigue necesitando club', async () => {
    await db.query(`INSERT INTO users (email, role) VALUES ('jugador@mail.example', 'player')`);
    await expect(
      db.query(`INSERT INTO users (email, name, role) VALUES ('b@club.example', 'B', 'club_admin')`),
    ).rejects.toThrow(/users_role_shape_check/);
    await db.query(`DELETE FROM users`);
  });

  it('un admin de club invitado puede existir sin contraseña, y un superadmin no tiene club y sí contraseña', async () => {
    // Invitado: club y sin contraseña.
    await db.query(
      `INSERT INTO users (email, name, role, club_id) VALUES ('invitado@club.example', 'Inv', 'club_admin', 'estacion-norte')`,
    );
    const [inv] = await db.query<{ password_hash: string | null; deactivated_at: Date | null }>(
      `SELECT password_hash, deactivated_at FROM users WHERE email = 'invitado@club.example'`,
    );
    expect(inv).toEqual({ password_hash: null, deactivated_at: null });

    // Superadmin válido: sin club, con contraseña.
    await db.query(`INSERT INTO users (email, name, role, password_hash) VALUES ('super@mail.example', 'S', 'superadmin', 'hash')`);
    // Superadmin inválido: con club, o sin contraseña.
    await expect(
      db.query(`INSERT INTO users (email, name, role, club_id, password_hash) VALUES ('s2@mail.example', 'S', 'superadmin', 'estacion-norte', 'hash')`),
    ).rejects.toThrow(/users_role_shape_check/);
    await expect(
      db.query(`INSERT INTO users (email, name, role) VALUES ('s3@mail.example', 'S', 'superadmin')`),
    ).rejects.toThrow(/users_role_shape_check/);
    // Un rol desconocido sigue rechazado.
    await expect(
      db.query(`INSERT INTO users (email, name, role, password_hash) VALUES ('s4@mail.example', 'S', 'root', 'hash')`),
    ).rejects.toThrow(/users_role_check/);

    await db.query(`DELETE FROM users WHERE email IN ('invitado@club.example', 'super@mail.example')`);
  });

  it('los clubes arrancan activos y los links aceptan el propósito de invitación', async () => {
    const clubs = await db.query<{ active: boolean }>('SELECT active FROM clubs');
    expect(clubs.length).toBeGreaterThan(0);
    expect(clubs.every((c) => c.active)).toBe(true);

    await db.query(`INSERT INTO login_tokens (email, token_hash, expires_at, purpose) VALUES ('i@x.example', 'inv1', now(), 'admin_invite')`);
    await db.query(`INSERT INTO link_requests (email, ip, purpose) VALUES ('i@x.example', '1.1.1.1', 'admin_invite')`);
    await expect(
      db.query(`INSERT INTO login_tokens (email, token_hash, expires_at, purpose) VALUES ('i@x.example', 'inv2', now(), 'otro')`),
    ).rejects.toThrow(/login_tokens_purpose_check/);
    await db.query(`DELETE FROM login_tokens WHERE email = 'i@x.example'`);
    await db.query(`DELETE FROM link_requests WHERE email = 'i@x.example'`);
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

  it('los horarios y las reservas rechazan datos inválidos y una segunda reserva del mismo turno', async () => {
    await db.query(`INSERT INTO clubs (id, name, zone, city, address) VALUES ('test-reservas', 'R', 'Z', 'buenos-aires', 'D')`);
    await db.query(`INSERT INTO courts (id, club_id, name, sport, price) VALUES ('test-reservas-c1', 'test-reservas', 'Cancha', 'Fútbol 5', 1000)`);

    const schedule = (weekday: number, start: number, end: number) =>
      db.query(`INSERT INTO court_schedules (court_id, weekday, start_hour, end_hour) VALUES ('test-reservas-c1', $1, $2, $3)`, [weekday, start, end]);
    await schedule(1, 16, 23);
    await schedule(2, 0, 24); // abierta las 24 horas
    await expect(schedule(1, 10, 12)).rejects.toThrow(/court_schedules_pkey/); // un solo rango por día
    await expect(schedule(8, 10, 12)).rejects.toThrow(/weekday_check/);
    await expect(schedule(3, 12, 12)).rejects.toThrow(/court_schedules_range_check/);
    await expect(schedule(3, 14, 12)).rejects.toThrow(/court_schedules_range_check/);
    await expect(schedule(3, 24, 25)).rejects.toThrow(/start_hour_check|end_hour_check/);

    const booking = (startsAt: string, name = 'Ana', email = 'ana@mail.example') =>
      db.query(
        `INSERT INTO bookings (id, court_id, starts_at, price, name, email, created_ip)
         VALUES (gen_random_uuid()::text, 'test-reservas-c1', $1, 1000, $2, $3, '1.1.1.1')`,
        [startsAt, name, email],
      );
    await booking('2030-01-07T20:00:00-03:00');
    await expect(booking('2030-01-07T20:00:00-03:00', 'Beto', 'beto@mail.example')).rejects.toThrow(/bookings_court_slot_key/);
    await expect(booking('2030-01-07T20:30:00-03:00')).rejects.toThrow(/bookings_starts_on_the_hour_check/);
    await expect(booking('2030-01-07T21:00:00-03:00', '')).rejects.toThrow(/bookings_name_check/);
    await booking('2030-01-07T21:00:00-03:00'); // otro turno de la misma cancha sí

    await db.query(`DELETE FROM clubs WHERE id = 'test-reservas'`); // arrastra canchas, horarios y reservas
    const [left] = await db.query<{ n: string }>(`SELECT count(*) AS n FROM bookings WHERE court_id = 'test-reservas-c1'`);
    expect(left!.n).toBe('0');
  });

  it('las grabaciones rechazan datos inválidos y un turno repetido', async () => {
    await db.query(`INSERT INTO clubs (id, name, zone, city, address) VALUES ('test-grab', 'G', 'Z', 'buenos-aires', 'D')`);
    await db.query(`INSERT INTO courts (id, club_id, name, sport, price) VALUES ('test-grab-c1', 'test-grab', 'Cancha', 'Fútbol 5', 1000)`);

    const rec = (id: string, startsAt: string, status: string, file: string | null) =>
      db.query(
        `INSERT INTO recordings (id, court_id, starts_at, status, video_file, duration_seconds)
         VALUES ($1, 'test-grab-c1', $2, $3, $4, 60)`,
        [id, startsAt, status, file],
      );
    await rec('r1', '2030-01-07T17:30:00-03:00', 'available', 'demo-partido.mp4'); // el inicio no tiene que ser en punto
    await rec('r2', '2030-01-07T19:00:00-03:00', 'processing', null);
    await rec('r3', '2030-01-07T20:00:00-03:00', 'unavailable', null);
    await expect(rec('r4', '2030-01-07T17:30:00-03:00', 'processing', null)).rejects.toThrow(/recordings_court_start_key/);
    await expect(rec('r5', '2030-01-08T17:00:00-03:00', 'listo', 'a.mp4')).rejects.toThrow(/recordings_status_check/);
    await expect(rec('r6', '2030-01-08T17:00:00-03:00', 'available', null)).rejects.toThrow(/recordings_available_needs_video_check/);
    for (const bad of ['../x.mp4', 'a/b.mp4', '.oculto.mp4', 'video.avi', 'con espacio.mp4', '']) {
      await expect(rec('r7', '2030-01-08T17:00:00-03:00', 'available', bad), bad).rejects.toThrow(/recordings_video_file_check/);
    }

    await db.query(`DELETE FROM clubs WHERE id = 'test-grab'`); // arrastra canchas y grabaciones
    const [left] = await db.query<{ n: string }>(`SELECT count(*) AS n FROM recordings WHERE court_id = 'test-grab-c1'`);
    expect(left!.n).toBe('0');
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

  it('las canchas se borran de forma lógica, llevan una imagen opcional y el nombre solo es único entre las no borradas', async () => {
    await db.query(`INSERT INTO clubs (id, name, zone, city, address) VALUES ('test-borrado', 'B', 'Z', 'buenos-aires', 'D')`);
    const court = (name: string) =>
      db.query(`INSERT INTO courts (id, club_id, name, sport, price) VALUES (gen_random_uuid()::text, 'test-borrado', $1, 'Fútbol 5', 1000)`, [name]);
    await court('Cancha Uno');
    await expect(court('cancha UNO')).rejects.toThrow(/courts_club_name_key/);

    await db.query(`UPDATE courts SET deleted_at = now() WHERE club_id = 'test-borrado'`);
    await court('Cancha Uno'); // el nombre de una borrada se puede reutilizar

    const [fresh] = await db.query<{ deleted_at: Date | null; image_url: string | null }>(
      `SELECT deleted_at, image_url FROM courts WHERE club_id = 'test-borrado' AND deleted_at IS NULL`,
    );
    expect(fresh).toEqual({ deleted_at: null, image_url: null });

    await expect(db.query(`UPDATE clubs SET image_url = '' WHERE id = 'test-borrado'`)).rejects.toThrow(/image_url_check/);
    await expect(
      db.query(`UPDATE courts SET image_url = $1 WHERE club_id = 'test-borrado'`, ['x'.repeat(501)]),
    ).rejects.toThrow(/image_url_check/);
    await db.query(`UPDATE clubs SET image_url = '/assets/x.jpg' WHERE id = 'test-borrado'`);

    await db.query(`DELETE FROM clubs WHERE id = 'test-borrado'`);
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
  it('las jugadas llevan su fragmento: las existentes se completan y los checks rechazan lo inválido', async () => {
    // Un esquema que llega hasta la migración anterior, con jugadas ya guardadas.
    await db.query('DROP SCHEMA public CASCADE');
    await db.query('CREATE SCHEMA public');
    const partial = mkdtempSync(path.join(tmpdir(), 'canchas3-migr-clip-'));
    try {
      for (const f of readdirSync(MIGRATIONS_DIR)) {
        if (f < '1763300000000_') copyFileSync(path.join(MIGRATIONS_DIR, f), path.join(partial, f));
      }
      await runMigrations(url, { dir: partial });
      await db.query(`INSERT INTO users (id, email, role) VALUES ('11111111-1111-1111-1111-111111111111', 'p@mail.example', 'player')`);
      const play = (id: string, ts: number, live: boolean) =>
        db.query(
          `INSERT INTO plays (id, user_id, match_id, title, capture_mode, timestamp_seconds, is_live_moment)
           VALUES ($1, '11111111-1111-1111-1111-111111111111', 'm', 't', 'video', $2, $3)`,
          [id, ts, live],
        );
      await play('21111111-1111-1111-1111-111111111111', 19, false);
      await play('22222222-2222-2222-2222-222222222222', 6, false);
      await play('23333333-3333-3333-3333-333333333333', 40, true);
    } finally {
      rmSync(partial, { recursive: true, force: true });
    }

    expect(await runMigrations(url)).toEqual([
      '1763300000000_fragmento-de-jugada',
      '1763400000000_codigo-de-acceso',
      '1763500000000_nombre-del-sitio',
    ]);
    const clips = await db.query<{ id: string; clip_start_seconds: number | null; clip_end_seconds: number | null }>(
      `SELECT id, clip_start_seconds, clip_end_seconds FROM plays ORDER BY id`,
    );
    expect(clips).toEqual([
      { id: '21111111-1111-1111-1111-111111111111', clip_start_seconds: 4, clip_end_seconds: 24 }, // 19 s: de 4 a 24
      { id: '22222222-2222-2222-2222-222222222222', clip_start_seconds: 0, clip_end_seconds: 11 }, // 6 s: no baja de 0
      { id: '23333333-3333-3333-3333-333333333333', clip_start_seconds: null, clip_end_seconds: null }, // en vivo
    ]);

    const withClip = (start: number | null, end: number | null, ts = 30) =>
      db.query(
        `INSERT INTO plays (user_id, match_id, title, capture_mode, timestamp_seconds, clip_start_seconds, clip_end_seconds)
         VALUES ('11111111-1111-1111-1111-111111111111', 'm', 't', 'video', $1, $2, $3)`,
        [ts, start, end],
      );
    await withClip(20, 45); // válido
    await withClip(27, 30); // 3 s justos
    await withClip(0, 120, 100); // 120 s justos
    await expect(withClip(20, null)).rejects.toThrow(/plays_clip_pair_check/);
    await expect(withClip(null, 40)).rejects.toThrow(/plays_clip_pair_check/);
    await expect(withClip(-1, 30)).rejects.toThrow(/plays_clip_range_check/);
    await expect(withClip(28, 30)).rejects.toThrow(/plays_clip_range_check/); // 2 s
    await expect(withClip(0, 121, 100)).rejects.toThrow(/plays_clip_range_check/); // 121 s
    await expect(withClip(40, 30)).rejects.toThrow(/plays_clip_(range|contains_mark)_check/); // fin antes del inicio
    await expect(withClip(31, 40, 30)).rejects.toThrow(/plays_clip_contains_mark_check/); // no contiene el momento
    await expect(withClip(10, 20, 30)).rejects.toThrow(/plays_clip_contains_mark_check/);
    await db.query(`DELETE FROM users WHERE id = '11111111-1111-1111-1111-111111111111'`);
  });

  it('los links llevan el código: los existentes quedan sin código, se rechazan intentos negativos y se puede bajar', async () => {
    await db.query('DROP SCHEMA public CASCADE');
    await db.query('CREATE SCHEMA public');
    const partial = mkdtempSync(path.join(tmpdir(), 'canchas3-migr-code-'));
    try {
      for (const f of readdirSync(MIGRATIONS_DIR)) {
        if (f < '1763400000000_') copyFileSync(path.join(MIGRATIONS_DIR, f), path.join(partial, f));
      }
      await runMigrations(url, { dir: partial });
      await db.query(
        `INSERT INTO login_tokens (purpose, email, token_hash, created_at, expires_at)
         VALUES ('access', 'viejo@mail.example', 'hash-viejo', now(), now() + interval '15 minutes')`,
      );
    } finally {
      rmSync(partial, { recursive: true, force: true });
    }

    expect(await runMigrations(url)).toEqual(['1763400000000_codigo-de-acceso', '1763500000000_nombre-del-sitio']);
    const [old] = await db.query<{ code_hash: string | null; code_attempts: number }>(
      `SELECT code_hash, code_attempts FROM login_tokens WHERE token_hash = 'hash-viejo'`,
    );
    expect(old).toEqual({ code_hash: null, code_attempts: 0 });

    await expect(
      db.query(
        `INSERT INTO login_tokens (purpose, email, token_hash, created_at, expires_at, code_attempts)
         VALUES ('access', 'x@mail.example', 'hash-x', now(), now() + interval '15 minutes', -1)`,
      ),
    ).rejects.toThrow(/login_tokens_code_attempts_check/);

    // Bajar las dos últimas (el nombre del sitio y el código de acceso): las columnas desaparecen y los links siguen.
    const { runner } = await import('node-pg-migrate');
    await runner({
      databaseUrl: url,
      dir: MIGRATIONS_DIR,
      direction: 'down',
      count: 2,
      migrationsTable: 'pgmigrations',
      checkOrder: true,
      singleTransaction: true,
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    });
    const cols = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'login_tokens'`,
    );
    expect(cols.map((c) => c.column_name)).not.toContain('code_hash');
    expect(cols.map((c) => c.column_name)).not.toContain('code_attempts');
    expect((await db.query(`SELECT 1 FROM login_tokens WHERE token_hash = 'hash-viejo'`)).length).toBe(1);
    // La bajada de la configuración del sitio borra su tabla.
    expect(await db.query(`SELECT 1 FROM information_schema.tables WHERE table_name = 'site_settings'`)).toHaveLength(0);
    await runMigrations(url);
    expect(await db.query(`SELECT name FROM site_settings`)).toEqual([{ name: 'Canchas3' }]);
  });
});
