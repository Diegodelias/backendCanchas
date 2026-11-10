import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAdmin, createSuperadmin } from '../src/modules/auth/admins.js';
import { SESSION_COOKIE } from '../src/modules/auth/sessions.js';
import { createDbTestEnv, waitFor, type DbTestEnv } from './helpers.js';

const PASSWORD = 'clave-de-prueba-123';
const SUPER = { email: 'root@canchas3.example', name: 'Root', password: 'clave-de-super-123' };

interface ClubSummary {
  id: string;
  name: string;
  zone: string;
  city: string;
  address: string;
  active: boolean;
  activeCourts: number;
  admins: number;
}

describe('plataforma: clubes', () => {
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

  const body = (res: LightMyRequestResponse) => res.json();
  const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, cookie?: string, payload?: object) =>
    env.app.inject({ method, url, cookies: cookie ? { [SESSION_COOKIE]: cookie } : {}, ...(payload ? { payload } : {}) });

  async function loginSuperadmin(): Promise<string> {
    await createSuperadmin(env.db, SUPER);
    const res = await env.app.inject({ method: 'POST', url: '/api/auth/admin/login', payload: { email: SUPER.email, password: SUPER.password } });
    return res.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
  }

  async function createClub(id: string, name = `Club ${id}`, extra: { city?: string; zone?: string } = {}) {
    await env.db.query(
      `INSERT INTO clubs (id, name, zone, city, address) VALUES ($1, $2, $3, $4, 'Calle 123')`,
      [id, name, extra.zone ?? 'Zona', extra.city ?? 'buenos-aires'],
    );
    return id;
  }

  async function createCourt(clubId: string, name: string, opts: { active?: boolean; sport?: string } = {}) {
    const rows = await env.db.query<{ id: string }>(
      `INSERT INTO courts (id, club_id, name, sport, price, active)
       VALUES (gen_random_uuid()::text, $1, $2, $3, 30000, $4) RETURNING id`,
      [clubId, name, opts.sport ?? 'Fútbol 5', opts.active ?? true],
    );
    return rows[0]!.id;
  }

  async function loginAdmin(clubId: string, email = `admin@${clubId}.example`): Promise<string> {
    await createAdmin(env.db, { email, name: 'Admin', clubId, password: PASSWORD });
    const res = await env.app.inject({ method: 'POST', url: '/api/auth/admin/login', payload: { email, password: PASSWORD } });
    return res.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
  }

  async function loginPlayer(email = 'jugador@mail.example'): Promise<string> {
    await env.app.inject({ method: 'POST', url: '/api/auth/player/request-link', payload: { email } });
    await waitFor(() => env.mailer.lastLinkTo(email) !== null);
    const token = new URL(env.mailer.lastLinkTo(email)!).searchParams.get('token')!;
    const res = await env.app.inject({ method: 'POST', url: '/api/auth/player/confirm', payload: { token } });
    return res.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
  }

  const listClubs = async (cookie: string, query = '') => body(await call('GET', `/api/platform/clubs${query}`, cookie));
  const publicIds = async () => (body(await call('GET', '/api/clubs?limit=24')).clubs as { id: string }[]).map((c) => c.id);

  describe('lista y búsqueda', () => {
    it('muestra todos los clubes, activos y desactivados, con estado, canchas activas y admins', async () => {
      const sa = await loginSuperadmin();
      const club = await createClub('test-lista', 'Club Lista');
      await createCourt(club, 'Cancha 1');
      await createCourt(club, 'Cancha 2');
      await createCourt(club, 'Cancha 3', { active: false });
      const borrada = await createCourt(club, 'Cancha 4');
      await env.db.query(`UPDATE courts SET deleted_at = now() WHERE id = $1`, [borrada]);
      await loginAdmin(club, 'a1@lista.example');
      await loginAdmin(club, 'a2@lista.example');
      await env.db.query(`INSERT INTO users (email, name, role, club_id) VALUES ('inv@lista.example', 'Inv', 'club_admin', $1)`, [club]);
      await env.db.query(`INSERT INTO users (email, name, role, club_id, deactivated_at, password_hash) VALUES ('baja@lista.example', 'Baja', 'club_admin', $1, now(), 'h')`, [club]);
      const off = await createClub('test-apagado', 'Club Apagado');
      await env.db.query(`UPDATE clubs SET active = false WHERE id = $1`, [off]);

      const res = await call('GET', '/api/platform/clubs?limit=50', sa);
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const clubs = body(res).clubs as ClubSummary[];
      expect(clubs.slice(0, 6).map((c) => c.id)).toEqual([
        'estacion-norte', 'la-cantera-crespo', 'polideportivo-belgrano', 'parque-sur-caballito', 'arena-nunez', 'terraza-colegiales',
      ]);
      expect(clubs.find((c) => c.id === 'estacion-norte')).toMatchObject({ active: true, activeCourts: 2, admins: 0 });
      // 2 activas (la desactivada y la borrada no cuentan); 3 admins: 2 activos + 1 invitado (el dado de baja no cuenta).
      expect(clubs.find((c) => c.id === club)).toMatchObject({ name: 'Club Lista', active: true, activeCourts: 2, admins: 3 });
      expect(clubs.find((c) => c.id === off)).toMatchObject({ active: false, activeCourts: 0, admins: 0 });
    });

    it('pagina de a 20: 25 clubes dan 2 páginas, en el orden de alta y sin repetir', async () => {
      const sa = await loginSuperadmin();
      for (let i = 1; i <= 19; i++) await createClub(`test-p${String(i).padStart(2, '0')}`);
      const first = await listClubs(sa);
      const second = await listClubs(sa, '?page=2');
      expect(first).toMatchObject({ page: 1, limit: 20, total: 25, totalPages: 2 });
      expect(first.clubs).toHaveLength(20);
      expect(second.clubs.map((c: ClubSummary) => c.id)).toEqual(['test-p15', 'test-p16', 'test-p17', 'test-p18', 'test-p19']);
      const ids = [...first.clubs, ...second.clubs].map((c: ClubSummary) => c.id);
      expect(new Set(ids).size).toBe(25);
    });

    it('rechaza una página o un límite inválidos', async () => {
      const sa = await loginSuperadmin();
      for (const query of ['?page=0', '?limit=0', '?limit=51', '?page=abc']) {
        const res = await call('GET', `/api/platform/clubs${query}`, sa);
        expect(res.statusCode, query).toBe(400);
        expect(body(res).error.code).toBe('validation_error');
      }
    });

    it('busca por nombre sin distinguir mayúsculas ni tildes, y el total cuenta solo lo encontrado', async () => {
      const sa = await loginSuperadmin();
      const belgrano = await listClubs(sa, '?q=BELGRANO');
      expect(belgrano.clubs.map((c: ClubSummary) => c.id)).toEqual(['polideportivo-belgrano']);
      expect(belgrano).toMatchObject({ total: 1, totalPages: 1 });

      for (const q of ['nunez', 'NÚÑEZ', 'Núñez', 'núnez']) {
        const res = await listClubs(sa, `?q=${encodeURIComponent(q)}`);
        expect(res.clubs.map((c: ClubSummary) => c.id), q).toEqual(['arena-nunez']);
      }
    });

    it('la búsqueda también encuentra clubes desactivados', async () => {
      const sa = await loginSuperadmin();
      await env.db.query(`UPDATE clubs SET active = false WHERE id = 'terraza-colegiales'`);
      try {
        expect((await listClubs(sa, '?q=terraza')).clubs).toMatchObject([{ id: 'terraza-colegiales', active: false }]);
      } finally {
        // Es un club de los datos iniciales: se restaura para no afectar a los demás archivos de tests.
        await env.db.query(`UPDATE clubs SET active = true WHERE id = 'terraza-colegiales'`);
      }
    });

    it('sin resultados devuelve la lista vacía; % y _ se buscan como texto, no como comodines', async () => {
      const sa = await loginSuperadmin();
      expect(await listClubs(sa, '?q=zzz-no-existe')).toMatchObject({ clubs: [], total: 0, totalPages: 0 });
      for (const q of ['%', '_', '\\']) {
        expect((await listClubs(sa, `?q=${encodeURIComponent(q)}`)).total, q).toBe(0);
      }
    });

    it('una búsqueda en blanco equivale a no buscar', async () => {
      const sa = await loginSuperadmin();
      expect((await listClubs(sa, '?q=%20%20')).total).toBe(6);
    });
  });

  describe('alta de clubes', () => {
    const NEW_CLUB = { id: 'test-nuevo', name: 'Club Nuevo', zone: 'Palermo', city: 'buenos-aires', address: 'Av. Siempreviva 742' };

    it('crea un club activo, sin canchas ni admins, y no aparece en la landing', async () => {
      const sa = await loginSuperadmin();
      const res = await call('POST', '/api/platform/clubs', sa, NEW_CLUB);
      expect(res.statusCode).toBe(201);
      expect(body(res).club).toEqual({ ...NEW_CLUB, active: true, activeCourts: 0, admins: 0 });
      expect((await listClubs(sa, '?q=nuevo')).clubs.map((c: ClubSummary) => c.id)).toEqual(['test-nuevo']);
      expect(await publicIds()).not.toContain('test-nuevo');
    });

    it('con una cancha activa el club nuevo aparece en la landing', async () => {
      const sa = await loginSuperadmin();
      await call('POST', '/api/platform/clubs', sa, NEW_CLUB);
      await createCourt('test-nuevo', 'Cancha 1');
      expect(await publicIds()).toContain('test-nuevo');
    });

    it('rechaza un identificador repetido y no modifica el club existente', async () => {
      const sa = await loginSuperadmin();
      const res = await call('POST', '/api/platform/clubs', sa, { ...NEW_CLUB, id: 'estacion-norte', name: 'Otro' });
      expect(res.statusCode).toBe(409);
      expect(body(res).error.code).toBe('club_id_taken');
      const [row] = await env.db.query<{ name: string }>(`SELECT name FROM clubs WHERE id = 'estacion-norte'`);
      expect(row!.name).toBe('Estación Norte Club');
    });

    it.each([
      ['identificador con mayúsculas', { id: 'Con Mayúsculas' }, /identificador/],
      ['identificador de menos de 3 caracteres', { id: 'ab' }, /identificador/],
      ['identificador que empieza con guion', { id: '-mal' }, /identificador/],
      ['nombre vacío', { name: '  ' }, /nombre/],
      ['nombre de más de 80 caracteres', { name: 'x'.repeat(81) }, /80 caracteres/],
      ['zona vacía', { zone: '' }, /zona/],
      ['dirección vacía', { address: '' }, /dirección/],
      ['ciudad desconocida', { city: 'narnia' }, /Ciudades válidas/],
    ])('rechaza %s y no crea nada', async (_label, change, message) => {
      const sa = await loginSuperadmin();
      const res = await call('POST', '/api/platform/clubs', sa, { ...NEW_CLUB, ...change });
      expect(res.statusCode).toBe(400);
      expect(body(res).error.code).toBe('validation_error');
      expect(body(res).error.message).toMatch(message);
      expect(await env.db.query(`SELECT 1 FROM clubs WHERE id LIKE 'test-%'`)).toHaveLength(0);
    });

    it('rechaza un pedido al que le faltan datos', async () => {
      const sa = await loginSuperadmin();
      const res = await call('POST', '/api/platform/clubs', sa, { id: 'test-incompleto', name: 'Sin zona' });
      expect(res.statusCode).toBe(400);
      expect(await env.db.query(`SELECT 1 FROM clubs WHERE id LIKE 'test-%'`)).toHaveLength(0);
    });
  });

  describe('edición y estado de los clubes', () => {
    it('cambia la dirección y la landing y la lista de la plataforma la muestran al instante', async () => {
      const sa = await loginSuperadmin();
      const club = await createClub('test-editar', 'Club Editar');
      await createCourt(club, 'Cancha 1');

      const res = await call('PATCH', `/api/platform/clubs/${club}`, sa, { address: '  Dirección Nueva 99  ', zone: 'Zona Nueva' });
      expect(res.statusCode).toBe(200);
      expect(body(res).club).toMatchObject({ id: club, address: 'Dirección Nueva 99', zone: 'Zona Nueva', activeCourts: 1 });

      const publicClub = (body(await call('GET', '/api/clubs?limit=24')).clubs as { id: string; address: string }[]).find((c) => c.id === club);
      expect(publicClub!.address).toBe('Dirección Nueva 99');
      expect((await listClubs(sa, '?q=editar')).clubs[0].address).toBe('Dirección Nueva 99');
    });

    it('rechaza datos inválidos y el club conserva los suyos', async () => {
      const sa = await loginSuperadmin();
      const club = await createClub('test-conserva', 'Club Conserva');
      for (const patch of [{ name: '   ' }, { city: 'narnia' }, { name: 'x'.repeat(81) }]) {
        expect((await call('PATCH', `/api/platform/clubs/${club}`, sa, patch)).statusCode).toBe(400);
      }
      const [row] = await env.db.query<{ name: string; city: string }>(`SELECT name, city FROM clubs WHERE id = $1`, [club]);
      expect(row).toEqual({ name: 'Club Conserva', city: 'buenos-aires' });
    });

    it('el identificador no se puede cambiar, ni ningún otro dato desconocido', async () => {
      const sa = await loginSuperadmin();
      const club = await createClub('test-id-fijo', 'Club Fijo');
      const withId = await call('PATCH', `/api/platform/clubs/${club}`, sa, { id: 'otro-id', name: 'Nuevo nombre' });
      expect(withId.statusCode).toBe(400);
      expect(body(withId).error.code).toBe('club_id_immutable');
      const unknown = await call('PATCH', `/api/platform/clubs/${club}`, sa, { createdAt: '2020-01-01' });
      expect(unknown.statusCode).toBe(400);
      expect(await call('PATCH', `/api/platform/clubs/${club}`, sa, {})).toMatchObject({ statusCode: 400 });
      const [row] = await env.db.query<{ id: string; name: string }>(`SELECT id, name FROM clubs WHERE id = $1`, [club]);
      expect(row).toEqual({ id: club, name: 'Club Fijo' });
    });

    it('desactivar saca al club de la landing sin tocar sus canchas ni sus admins, y reactivar lo devuelve igual', async () => {
      const sa = await loginSuperadmin();
      const club = await createClub('test-estado', 'Club Estado');
      const court = await createCourt(club, 'Cancha 1');
      await loginAdmin(club);
      expect(await publicIds()).toContain(club);

      const off = await call('PATCH', `/api/platform/clubs/${club}`, sa, { active: false });
      expect(off.statusCode).toBe(200);
      expect(body(off).club).toMatchObject({ active: false, activeCourts: 1, admins: 1 });
      expect(await publicIds()).not.toContain(club);
      expect((await call('GET', `/api/clubs/${club}`)).statusCode).toBe(404);
      expect(await env.db.query(`SELECT 1 FROM courts WHERE id = $1 AND active AND deleted_at IS NULL`, [court])).toHaveLength(1);

      const on = await call('PATCH', `/api/platform/clubs/${club}`, sa, { active: true });
      expect(body(on).club).toMatchObject({ active: true, activeCourts: 1, admins: 1 });
      expect(await publicIds()).toContain(club);
    });

    it('un club que no existe responde 404', async () => {
      const sa = await loginSuperadmin();
      const res = await call('PATCH', '/api/platform/clubs/test-no-existe', sa, { name: 'X' });
      expect(res.statusCode).toBe(404);
    });

    it('desactivar un club no lo elimina: sigue existiendo y se puede reactivar', async () => {
      const sa = await loginSuperadmin();
      const club = await createClub('test-sin-borrar');
      expect((await call('PATCH', `/api/platform/clubs/${club}`, sa, { active: false })).statusCode).toBe(200);
      expect(await env.db.query(`SELECT 1 FROM clubs WHERE id = $1`, [club])).toHaveLength(1);
      const res = await call('PATCH', `/api/platform/clubs/${club}`, sa, { active: true });
      expect(body(res).club).toMatchObject({ id: club, active: true });
    });
  });

  describe('eliminar un club', () => {
    const count = async (sql: string, params: unknown[]) =>
      Number((await env.db.query<{ n: string }>(sql, params))[0]!.n);

    async function addBooking(courtId: string) {
      await env.db.query(
        `INSERT INTO bookings (id, court_id, starts_at, price, name, email, created_ip)
         VALUES (gen_random_uuid()::text, $1, '2030-01-07T20:00:00-03:00', 1000, 'Ana', 'ana@mail.example', '1.1.1.1')`,
        [courtId],
      );
    }
    async function addRecording(courtId: string) {
      await env.db.query(
        `INSERT INTO recordings (id, court_id, starts_at, status, video_file, duration_seconds)
         VALUES (gen_random_uuid()::text, $1, '2030-01-07T17:30:00-03:00', 'available', 'demo.mp4', 60)`,
        [courtId],
      );
    }

    it('elimina un club con canchas y admins, sin reservas ni grabaciones, y deja el resto igual', async () => {
      const sa = await loginSuperadmin();
      const club = await createClub('test-borrar', 'Club Borrar');
      const court = await createCourt(club, 'Cancha 1');
      const borrada = await createCourt(club, 'Cancha 2');
      await env.db.query(`UPDATE courts SET deleted_at = now() WHERE id = $1`, [borrada]);
      await env.db.query(`INSERT INTO court_schedules (court_id, weekday, start_hour, end_hour) VALUES ($1, 1, 10, 22)`, [court]);
      await loginAdmin(club, 'a@borrar.example');
      await env.db.query(`INSERT INTO users (email, name, role, club_id) VALUES ('inv@borrar.example', 'Inv', 'club_admin', $1)`, [club]);
      const otro = await createClub('test-otro', 'Club Otro');
      await createCourt(otro, 'Cancha X');
      await loginAdmin(otro, 'a@otro.example');

      const res = await call('DELETE', `/api/platform/clubs/${club}`, sa);
      expect(res.statusCode).toBe(204);
      expect(await count(`SELECT count(*) AS n FROM clubs WHERE id = $1`, [club])).toBe(0);
      expect(await count(`SELECT count(*) AS n FROM courts WHERE club_id = $1`, [club])).toBe(0);
      expect(await count(`SELECT count(*) AS n FROM court_schedules WHERE court_id = $1`, [court])).toBe(0);
      expect(await count(`SELECT count(*) AS n FROM users WHERE club_id = $1`, [club])).toBe(0);
      // El admin eliminado ya no puede iniciar sesión.
      const login = await env.app.inject({ method: 'POST', url: '/api/auth/admin/login', payload: { email: 'a@borrar.example', password: PASSWORD } });
      expect(login.statusCode).toBe(401);
      expect((await listClubs(sa, '?limit=50')).clubs.map((c: ClubSummary) => c.id)).not.toContain(club);
      expect(await publicIds()).not.toContain(club);

      // Los demás clubes quedan intactos.
      expect(await count(`SELECT count(*) AS n FROM courts WHERE club_id = $1`, [otro])).toBe(1);
      expect(await count(`SELECT count(*) AS n FROM users WHERE club_id = $1`, [otro])).toBe(1);
    });

    it('elimina un club activo sin pedir que se desactive antes', async () => {
      const sa = await loginSuperadmin();
      const club = await createClub('test-activo');
      expect((await listClubs(sa, '?limit=50')).clubs.find((c: ClubSummary) => c.id === club).active).toBe(true);
      expect((await call('DELETE', `/api/platform/clubs/${club}`, sa)).statusCode).toBe(204);
    });

    it('rechaza con 409 y los conteos si tiene reservas o grabaciones, y no cambia nada', async () => {
      const sa = await loginSuperadmin();
      const club = await createClub('test-datos');
      const court = await createCourt(club, 'Cancha 1');
      await loginAdmin(club, 'a@datos.example');
      await addBooking(court);
      await addRecording(court);

      const res = await call('DELETE', `/api/platform/clubs/${club}`, sa);
      expect(res.statusCode).toBe(409);
      expect(body(res).error.code).toBe('club_not_empty');
      expect(body(res).error.message).toContain('1 reserva y 1 grabación');
      expect(await count(`SELECT count(*) AS n FROM clubs WHERE id = $1`, [club])).toBe(1);
      expect(await count(`SELECT count(*) AS n FROM courts WHERE club_id = $1`, [club])).toBe(1);
      expect(await count(`SELECT count(*) AS n FROM users WHERE club_id = $1`, [club])).toBe(1);
      expect(await count(`SELECT count(*) AS n FROM bookings WHERE court_id = $1`, [court])).toBe(1);
      expect(await count(`SELECT count(*) AS n FROM recordings WHERE court_id = $1`, [court])).toBe(1);
    });

    it('responde 404 si el club no existe o ya se eliminó', async () => {
      const sa = await loginSuperadmin();
      const club = await createClub('test-dos-veces');
      expect((await call('DELETE', `/api/platform/clubs/${club}`, sa)).statusCode).toBe(204);
      expect((await call('DELETE', `/api/platform/clubs/${club}`, sa)).statusCode).toBe(404);
      expect((await call('DELETE', '/api/platform/clubs/no-existe', sa)).statusCode).toBe(404);
    });

    it('deja libre el identificador: se puede crear otro club con el mismo', async () => {
      const sa = await loginSuperadmin();
      const club = await createClub('test-reuso');
      expect((await call('DELETE', `/api/platform/clubs/${club}`, sa)).statusCode).toBe(204);
      const res = await call('POST', '/api/platform/clubs', sa, { id: club, name: 'Nuevo', zone: 'Z', city: 'buenos-aires', address: 'D' });
      expect(res.statusCode).toBe(201);
    });

    it('solo el superadmin puede eliminar: admin de club y jugador reciben 403, sin sesión 401', async () => {
      const club = await createClub('test-permisos');
      const admin = await loginAdmin(club);
      const player = await loginPlayer();
      expect((await call('DELETE', `/api/platform/clubs/${club}`, admin)).statusCode).toBe(403);
      expect((await call('DELETE', '/api/platform/clubs/estacion-norte', admin)).statusCode).toBe(403);
      expect((await call('DELETE', `/api/platform/clubs/${club}`, player)).statusCode).toBe(403);
      expect((await call('DELETE', `/api/platform/clubs/${club}`)).statusCode).toBe(401);
      expect(await count(`SELECT count(*) AS n FROM clubs WHERE id = $1`, [club])).toBe(1);
      expect(await count(`SELECT count(*) AS n FROM users WHERE club_id = $1`, [club])).toBe(1);
    });
  });

  describe('permisos', () => {
    it('un admin de club recibe 403 en la lista, el alta y la edición, y no se modifica nada', async () => {
      const club = await createClub('test-perm');
      const admin = await loginAdmin(club);
      const before = await env.db.query(`SELECT 1 FROM clubs`);

      expect((await call('GET', '/api/platform/clubs', admin)).statusCode).toBe(403);
      const create = await call('POST', '/api/platform/clubs', admin, { id: 'test-hack', name: 'H', zone: 'Z', city: 'buenos-aires', address: 'D' });
      expect(create.statusCode).toBe(403);
      expect((await call('PATCH', `/api/platform/clubs/${club}`, admin, { name: 'Hackeado' })).statusCode).toBe(403);
      expect((await call('PATCH', '/api/platform/clubs/estacion-norte', admin, { active: false })).statusCode).toBe(403);

      expect(await env.db.query(`SELECT 1 FROM clubs`)).toHaveLength(before.length);
      const [row] = await env.db.query<{ name: string; active: boolean }>(`SELECT name, active FROM clubs WHERE id = 'estacion-norte'`);
      expect(row).toEqual({ name: 'Estación Norte Club', active: true });
    });

    it('un jugador recibe 403 y una persona sin sesión recibe 401', async () => {
      const player = await loginPlayer();
      expect((await call('GET', '/api/platform/clubs', player)).statusCode).toBe(403);
      expect((await call('POST', '/api/platform/clubs', player, {})).statusCode).toBe(403);

      expect((await call('GET', '/api/platform/clubs')).statusCode).toBe(401);
      expect((await call('POST', '/api/platform/clubs', undefined, {})).statusCode).toBe(401);
      expect((await call('PATCH', '/api/platform/clubs/estacion-norte', undefined, { active: false })).statusCode).toBe(401);
    });

    it('la gestión de canchas del propio club sigue siendo solo de los admins de club', async () => {
      const sa = await loginSuperadmin();
      const res = await call('GET', '/api/club/courts', sa);
      expect(res.statusCode).toBe(403);
      expect((await call('POST', '/api/club/courts', sa, { name: 'X', sport: 'Fútbol 5', price: 1000 })).statusCode).toBe(403);
    });
  });
});
