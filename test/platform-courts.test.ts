import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAdmin, createSuperadmin } from '../src/modules/auth/admins.js';
import { SESSION_COOKIE } from '../src/modules/auth/sessions.js';
import { createDbTestEnv, waitFor, type DbTestEnv } from './helpers.js';

const PASSWORD = 'clave-de-prueba-123';
const SUPER = { email: 'root@canchas3.example', name: 'Root', password: 'clave-de-super-123' };
const NEW_COURT = { name: 'Cancha Nueva', sport: 'Fútbol 7', price: 40000 };

describe('plataforma: canchas de cualquier club', () => {
  let env: DbTestEnv;
  let sa: string;

  beforeAll(async () => {
    env = await createDbTestEnv();
  });
  afterAll(async () => {
    await env?.close();
  });
  beforeEach(async () => {
    await env.reset();
    await createSuperadmin(env.db, SUPER);
    const res = await env.app.inject({ method: 'POST', url: '/api/auth/admin/login', payload: { email: SUPER.email, password: SUPER.password } });
    sa = res.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
  });

  const body = (res: LightMyRequestResponse) => res.json();
  const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, cookie?: string, payload?: object) =>
    env.app.inject({ method, url, cookies: cookie ? { [SESSION_COOKIE]: cookie } : {}, ...(payload ? { payload } : {}) });

  async function createClub(id: string) {
    await env.db.query(`INSERT INTO clubs (id, name, zone, city, address) VALUES ($1, $2, 'Zona', 'buenos-aires', 'Calle 123')`, [id, `Club ${id}`]);
    return id;
  }
  async function createCourt(clubId: string, name: string, opts: { active?: boolean; price?: number } = {}) {
    const rows = await env.db.query<{ id: string }>(
      `INSERT INTO courts (id, club_id, name, sport, price, active)
       VALUES (gen_random_uuid()::text, $1, $2, 'Fútbol 5', $3, $4) RETURNING id`,
      [clubId, name, opts.price ?? 30000, opts.active ?? true],
    );
    return rows[0]!.id;
  }
  async function loginAdmin(clubId: string): Promise<string> {
    const email = `admin@${clubId}.example`;
    await createAdmin(env.db, { email, name: 'Admin', clubId, password: PASSWORD });
    const res = await env.app.inject({ method: 'POST', url: '/api/auth/admin/login', payload: { email, password: PASSWORD } });
    return res.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
  }
  async function loginPlayer(): Promise<string> {
    const email = 'jugador@mail.example';
    await env.app.inject({ method: 'POST', url: '/api/auth/player/request-link', payload: { email } });
    await waitFor(() => env.mailer.lastLinkTo(email) !== null);
    const token = new URL(env.mailer.lastLinkTo(email)!).searchParams.get('token')!;
    const res = await env.app.inject({ method: 'POST', url: '/api/auth/player/confirm', payload: { token } });
    return res.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
  }
  const publicCourts = async (clubId: string) => {
    const clubs = body(await call('GET', '/api/clubs?limit=24')).clubs as { id: string; courts: { name: string; price: number }[] }[];
    return clubs.find((c) => c.id === clubId)?.courts ?? [];
  };

  it('lista el club y todas sus canchas, activas o no, sin las borradas', async () => {
    const club = await createClub('test-lista');
    await createCourt(club, 'Activa');
    await createCourt(club, 'Apagada', { active: false });
    const borrada = await createCourt(club, 'Borrada');
    await env.db.query(`UPDATE courts SET deleted_at = now() WHERE id = $1`, [borrada]);

    const res = await call('GET', `/api/platform/clubs/${club}/courts`, sa);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(body(res).club).toEqual({ id: club, name: 'Club test-lista', active: true });
    expect(body(res).courts.map((c: { name: string; active: boolean }) => [c.name, c.active])).toEqual([['Activa', true], ['Apagada', false]]);
  });

  it('también lista las canchas de un club desactivado', async () => {
    const club = await createClub('test-club-apagado');
    await createCourt(club, 'Cancha 1');
    await env.db.query(`UPDATE clubs SET active = false WHERE id = $1`, [club]);
    const res = await call('GET', `/api/platform/clubs/${club}/courts`, sa);
    expect(body(res).club.active).toBe(false);
    expect(body(res).courts).toHaveLength(1);
  });

  it('crea una cancha en otro club: queda activa, la ve el admin de ese club y la landing', async () => {
    const club = await createClub('test-otro');
    const admin = await loginAdmin(club);

    const res = await call('POST', `/api/platform/clubs/${club}/courts`, sa, NEW_COURT);
    expect(res.statusCode).toBe(201);
    expect(body(res).court).toMatchObject({ ...NEW_COURT, active: true });
    expect(body(res).court.id).toMatch(/^c-[0-9a-f-]{36}$/);

    expect(body(await call('GET', '/api/club/courts', admin)).courts.map((c: { name: string }) => c.name)).toEqual(['Cancha Nueva']);
    expect((await publicCourts(club)).map((c) => c.name)).toEqual(['Cancha Nueva']);
  });

  it('la cancha creada por el superadmin queda en el club elegido y no en otro', async () => {
    const a = await createClub('test-a');
    const b = await createClub('test-b');
    const { court } = body(await call('POST', `/api/platform/clubs/${a}/courts`, sa, NEW_COURT));
    const [row] = await env.db.query<{ club_id: string }>(`SELECT club_id FROM courts WHERE id = $1`, [court.id]);
    expect(row!.club_id).toBe(a);
    expect(await env.db.query(`SELECT 1 FROM courts WHERE club_id = $1`, [b])).toHaveLength(0);
  });

  describe('mismas reglas que el admin de club', () => {
    it('rechaza un nombre repetido en el club (aunque cambien las mayúsculas) y lo acepta en otro club', async () => {
      const a = await createClub('test-dup-a');
      const b = await createClub('test-dup-b');
      await createCourt(a, 'Cancha Uno');
      const dup = await call('POST', `/api/platform/clubs/${a}/courts`, sa, { ...NEW_COURT, name: 'CANCHA uno' });
      expect(dup.statusCode).toBe(409);
      expect(body(dup).error.code).toBe('court_name_taken');
      expect((await call('POST', `/api/platform/clubs/${b}/courts`, sa, { ...NEW_COURT, name: 'Cancha Uno' })).statusCode).toBe(201);
    });

    it.each([
      ['nombre vacío', { ...NEW_COURT, name: '  ' }, 'nombre'],
      ['deporte inexistente', { ...NEW_COURT, sport: 'Tenis' }, 'deporte'],
      ['precio cero', { ...NEW_COURT, price: 0 }, 'mayor que cero'],
      ['precio con decimales', { ...NEW_COURT, price: 1500.5 }, 'entero'],
    ])('rechaza %s con el mismo error de validación', async (_label, payload, fragment) => {
      const club = await createClub('test-valid');
      const res = await call('POST', `/api/platform/clubs/${club}/courts`, sa, payload);
      expect(res.statusCode).toBe(400);
      expect(body(res).error.code).toBe('validation_error');
      expect(body(res).error.message.toLowerCase()).toContain(fragment);
      expect(await env.db.query(`SELECT 1 FROM courts WHERE club_id = $1`, [club])).toHaveLength(0);
    });

    it('rechaza la cancha 51 indicando el tope, y las borradas no cuentan', async () => {
      const club = await createClub('test-tope');
      await env.db.query(
        `INSERT INTO courts (id, club_id, name, sport, price) SELECT 'tp-' || g, $1, 'Cancha ' || g, 'Fútbol 5', 1000 FROM generate_series(1, 50) g`,
        [club],
      );
      const full = await call('POST', `/api/platform/clubs/${club}/courts`, sa, NEW_COURT);
      expect(full.statusCode).toBe(409);
      expect(body(full).error.code).toBe('courts_limit_reached');
      expect(body(full).error.message).toContain('50');

      expect((await call('DELETE', `/api/platform/clubs/${club}/courts/tp-1`, sa)).statusCode).toBe(204);
      expect((await call('POST', `/api/platform/clubs/${club}/courts`, sa, NEW_COURT)).statusCode).toBe(201);
    });

    it('edita nombre, deporte y precio; activa y desactiva', async () => {
      const club = await createClub('test-editar');
      const id = await createCourt(club, 'Vieja', { price: 20000 });
      const edited = await call('PATCH', `/api/platform/clubs/${club}/courts/${id}`, sa, { name: 'Nueva', sport: 'Fútbol 8', price: 50000 });
      expect(edited.statusCode).toBe(200);
      expect(body(edited).court).toEqual({ id, name: 'Nueva', sport: 'Fútbol 8', price: 50000, active: true });

      const off = await call('PATCH', `/api/platform/clubs/${club}/courts/${id}`, sa, { active: false });
      expect(body(off).court.active).toBe(false);
      expect(await publicCourts(club)).toEqual([]);
      const on = await call('PATCH', `/api/platform/clubs/${club}/courts/${id}`, sa, { active: true });
      expect(body(on).court).toMatchObject({ active: true, price: 50000 });
    });

    it('rechaza renombrar a un nombre repetido y un cambio vacío', async () => {
      const club = await createClub('test-renombrar');
      await createCourt(club, 'Cancha A');
      const b = await createCourt(club, 'Cancha B');
      const dup = await call('PATCH', `/api/platform/clubs/${club}/courts/${b}`, sa, { name: 'cancha a' });
      expect(dup.statusCode).toBe(409);
      expect((await call('PATCH', `/api/platform/clubs/${club}/courts/${b}`, sa, {})).statusCode).toBe(400);
    });

    it('borra con borrado lógico: desaparece de todos lados, el nombre se reutiliza y no se puede editar', async () => {
      const club = await createClub('test-borrar');
      const admin = await loginAdmin(club);
      const id = await createCourt(club, 'Cancha Uno');

      expect((await call('DELETE', `/api/platform/clubs/${club}/courts/${id}`, sa)).statusCode).toBe(204);
      expect(body(await call('GET', `/api/platform/clubs/${club}/courts`, sa)).courts).toEqual([]);
      expect(body(await call('GET', '/api/club/courts', admin)).courts).toEqual([]);
      const [row] = await env.db.query<{ deleted_at: Date | null }>(`SELECT deleted_at FROM courts WHERE id = $1`, [id]);
      expect(row!.deleted_at).not.toBeNull();

      expect((await call('DELETE', `/api/platform/clubs/${club}/courts/${id}`, sa)).statusCode).toBe(404);
      expect((await call('PATCH', `/api/platform/clubs/${club}/courts/${id}`, sa, { price: 1 })).statusCode).toBe(404);
      expect((await call('POST', `/api/platform/clubs/${club}/courts`, sa, { ...NEW_COURT, name: 'cancha uno' })).statusCode).toBe(201);
    });
  });

  it('un cambio del superadmin lo ve el admin del club al recargar su panel', async () => {
    const club = await createClub('test-visible');
    const admin = await loginAdmin(club);
    const id = await createCourt(club, 'Cancha 1', { price: 30000 });
    expect(body(await call('GET', '/api/club/courts', admin)).courts[0].price).toBe(30000);

    await call('PATCH', `/api/platform/clubs/${club}/courts/${id}`, sa, { price: 35000 });
    expect(body(await call('GET', '/api/club/courts', admin)).courts[0].price).toBe(35000);
    expect((await publicCourts(club))[0]!.price).toBe(35000);
  });

  it('una cancha de otro club responde 404 y no se modifica', async () => {
    const a = await createClub('test-ajena-a');
    const b = await createClub('test-ajena-b');
    const ajena = await createCourt(b, 'Cancha de B', { price: 10000 });

    expect((await call('PATCH', `/api/platform/clubs/${a}/courts/${ajena}`, sa, { price: 99999, active: false })).statusCode).toBe(404);
    expect((await call('DELETE', `/api/platform/clubs/${a}/courts/${ajena}`, sa)).statusCode).toBe(404);
    const [row] = await env.db.query<{ price: number; active: boolean; deleted_at: Date | null }>(`SELECT price, active, deleted_at FROM courts WHERE id = $1`, [ajena]);
    expect(row).toEqual({ price: 10000, active: true, deleted_at: null });
  });

  it('un club que no existe responde 404 en las cuatro rutas', async () => {
    for (const [method, url, payload] of [
      ['GET', '/api/platform/clubs/test-no-existe/courts', undefined],
      ['POST', '/api/platform/clubs/test-no-existe/courts', NEW_COURT],
      ['PATCH', '/api/platform/clubs/test-no-existe/courts/x', { price: 1 }],
      ['DELETE', '/api/platform/clubs/test-no-existe/courts/x', undefined],
    ] as const) {
      expect((await call(method, url, sa, payload)).statusCode, `${method} ${url}`).toBe(404);
    }
  });

  it('los admins de club y los jugadores reciben 403, y sin sesión 401, y no se modifica nada', async () => {
    const club = await createClub('test-perm');
    const other = await createClub('test-perm-otro');
    const court = await createCourt(other, 'Cancha ajena', { price: 7000 });
    const admin = await loginAdmin(club);
    const player = await loginPlayer();

    for (const [cookie, status] of [[admin, 403], [player, 403], [undefined, 401]] as const) {
      expect((await call('GET', `/api/platform/clubs/${other}/courts`, cookie)).statusCode).toBe(status);
      expect((await call('POST', `/api/platform/clubs/${other}/courts`, cookie, NEW_COURT)).statusCode).toBe(status);
      expect((await call('PATCH', `/api/platform/clubs/${other}/courts/${court}`, cookie, { price: 1 })).statusCode).toBe(status);
      expect((await call('DELETE', `/api/platform/clubs/${other}/courts/${court}`, cookie)).statusCode).toBe(status);
    }
    const [row] = await env.db.query<{ price: number; deleted_at: Date | null }>(`SELECT price, deleted_at FROM courts WHERE id = $1`, [court]);
    expect(row).toEqual({ price: 7000, deleted_at: null });
    expect(await env.db.query(`SELECT 1 FROM courts WHERE club_id = $1`, [other])).toHaveLength(1);
  });
});
