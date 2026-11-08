import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AdminInputError, createAdmin } from '../src/modules/auth/admins.js';
import { CITY_IDS, ClubInputError, createClub } from '../src/modules/clubs/clubs.js';
import { SESSION_COOKIE } from '../src/modules/auth/sessions.js';
import { createDbTestEnv, type DbTestEnv } from './helpers.js';

const backendDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const CLUB = {
  id: 'test-club-nuevo',
  name: 'Club Nuevo',
  zone: 'Palermo',
  city: 'buenos-aires',
  address: 'Av. Siempreviva 742',
};

describe('crear club', () => {
  let env: DbTestEnv;

  beforeAll(async () => {
    env = await createDbTestEnv();
  });
  afterAll(async () => {
    await env?.close();
  });
  beforeEach(async () => {
    await env.reset();
  });

  const countClubs = async () => (await env.db.query(`SELECT 1 FROM clubs WHERE id LIKE 'test-%'`)).length;

  it('crea el club y queda disponible para un admin y para sus canchas', async () => {
    const club = await createClub(env.db, CLUB);
    expect(club).toMatchObject(CLUB);

    // Un admin se puede crear para el club nuevo, sin cambiar ningún código.
    const admin = await createAdmin(env.db, { email: 'admin@nuevo.example', name: 'Admin', clubId: CLUB.id, password: 'clave-larga-456' });
    expect(admin.clubId).toBe(CLUB.id);

    const login = await env.app.inject({
      method: 'POST',
      url: '/api/auth/admin/login',
      payload: { email: 'admin@nuevo.example', password: 'clave-larga-456' },
    });
    const cookie = login.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
    const created = await env.app.inject({
      method: 'POST',
      url: '/api/club/courts',
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { name: 'Cancha 1', sport: 'Fútbol 5', price: 30000 },
    });
    expect(created.statusCode).toBe(201);

    // Y el club, ya con una cancha activa, aparece en el listado público.
    const list = (await env.app.inject({ method: 'GET', url: '/api/clubs?limit=24' })).json().clubs as { id: string }[];
    expect(list.map((c) => c.id)).toContain(CLUB.id);
  });

  it('recorta espacios de los datos', async () => {
    const club = await createClub(env.db, { ...CLUB, name: '  Club Nuevo  ', zone: ' Palermo ', address: '  Calle 1 ' });
    expect(club).toMatchObject({ name: 'Club Nuevo', zone: 'Palermo', address: 'Calle 1' });
  });

  it('rechaza un identificador repetido sin modificar el club existente', async () => {
    await createClub(env.db, CLUB);
    const err = await createClub(env.db, { ...CLUB, name: 'Otro nombre' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClubInputError);
    expect((err as Error).message).toContain(CLUB.id);
    const [row] = await env.db.query<{ name: string }>(`SELECT name FROM clubs WHERE id = $1`, [CLUB.id]);
    expect(row!.name).toBe('Club Nuevo');
    expect(await countClubs()).toBe(1);
  });

  it('rechaza el identificador de un club inicial', async () => {
    await expect(createClub(env.db, { ...CLUB, id: 'estacion-norte' })).rejects.toThrow(ClubInputError);
  });

  it.each([
    ['con mayúsculas', 'Test-Club'],
    ['con espacios', 'test club'],
    ['con caracteres especiales', 'test_club!'],
    ['con tildes', 'test-clúb'],
    ['empieza con guion', '-test-club'],
    ['termina con guion', 'test-club-'],
    ['con guiones seguidos', 'test--club'],
    ['demasiado corto', 'ab'],
    ['demasiado largo', 'test-' + 'x'.repeat(60)],
    ['vacío', ''],
  ])('rechaza un identificador %s y explica el formato', async (_label, id) => {
    const err = await createClub(env.db, { ...CLUB, id }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClubInputError);
    expect((err as Error).message).toMatch(/minúsculas, números y guiones/);
    expect(await countClubs()).toBe(0);
  });

  it('rechaza una ciudad que el sitio no conoce y nombra las válidas', async () => {
    const err = await createClub(env.db, { ...CLUB, city: 'atlantida' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClubInputError);
    for (const city of CITY_IDS) expect((err as Error).message).toContain(city);
    expect(await countClubs()).toBe(0);
  });

  it.each([
    ['sin nombre', { name: '   ' }],
    ['sin zona', { zone: '' }],
    ['sin dirección', { address: '  ' }],
    ['con un nombre de más de 80 caracteres', { name: 'x'.repeat(81) }],
  ])('rechaza un club %s', async (_label, patch) => {
    await expect(createClub(env.db, { ...CLUB, ...patch })).rejects.toThrow(ClubInputError);
    expect(await countClubs()).toBe(0);
  });

  it('dos altas simultáneas con el mismo identificador crean un solo club', async () => {
    const results = await Promise.allSettled([createClub(env.db, CLUB), createClub(env.db, CLUB)]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(await countClubs()).toBe(1);
  });

  describe('crear-admin con los clubes de la base', () => {
    it('rechaza un club que no existe y lista los que sí', async () => {
      const err = await createAdmin(env.db, { email: 'a@x.example', name: 'A', clubId: 'test-no-existe', password: 'clave-larga-456' }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AdminInputError);
      expect((err as Error).message).toContain('test-no-existe');
      expect((err as Error).message).toContain('estacion-norte');
      expect((err as Error).message).toContain('terraza-colegiales');
      expect(await env.db.query(`SELECT 1 FROM users`)).toHaveLength(0);
    });

    it('los clubes dados de alta después aparecen en esa lista', async () => {
      await createClub(env.db, CLUB);
      const err = await createAdmin(env.db, { email: 'a@x.example', name: 'A', clubId: 'test-otro', password: 'clave-larga-456' }).catch((e: unknown) => e);
      expect((err as Error).message).toContain(CLUB.id);
    });
  });

  describe('el comando', () => {
    const run = (args: string[]) =>
      spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/crear-club.ts', ...args], {
        cwd: backendDir,
        env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL },
        input: '',
        encoding: 'utf8',
      });

    const args = (over: Record<string, string> = {}) => {
      const values = { id: CLUB.id, nombre: CLUB.name, zona: CLUB.zone, ciudad: CLUB.city, direccion: CLUB.address, ...over };
      return Object.entries(values).flatMap(([k, v]) => [`--${k}`, v]);
    };

    it('crea el club y sugiere el paso siguiente', async () => {
      const result = run(args());
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('Club creado');
      expect(result.stdout).toContain(`crear-admin --club ${CLUB.id}`);
      expect(await countClubs()).toBe(1);
    });

    it('termina con código distinto de 0 y sin crear nada ante una ciudad desconocida', async () => {
      const result = run(args({ ciudad: 'atlantida' }));
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('Ciudades válidas');
      expect(await countClubs()).toBe(0);
    });

    it('termina con error ante un identificador inválido o repetido', async () => {
      const bad = run(args({ id: 'Con Mayusculas' }));
      expect(bad.status).not.toBe(0);
      expect(bad.stderr).toContain('minúsculas, números y guiones');

      expect(run(args()).status).toBe(0);
      const dup = run(args());
      expect(dup.status).not.toBe(0);
      expect(dup.stderr).toContain(CLUB.id);
      expect(await countClubs()).toBe(1);
    });

    it('muestra el uso si falta un dato', () => {
      const result = run(['--id', CLUB.id]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('Uso: crear-club');
    });
  });
});
