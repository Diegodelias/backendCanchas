import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAdmin } from '../src/modules/auth/admins.js';
import { SESSION_COOKIE } from '../src/modules/auth/sessions.js';
import { createDbTestEnv, waitFor, type DbTestEnv } from './helpers.js';

const PASSWORD = 'clave-de-prueba-123';

describe('clubes y canchas', () => {
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

  /** Crea un club de prueba (id con prefijo `test-`, que `reset` borra) y devuelve su id. */
  async function createClub(id: string, name = `Club ${id}`) {
    await env.db.query(
      `INSERT INTO clubs (id, name, zone, city, address) VALUES ($1, $2, 'Zona', 'buenos-aires', 'Calle 123')`,
      [id, name],
    );
    return id;
  }

  async function createCourt(clubId: string, name: string, opts: { sport?: string; price?: number; active?: boolean } = {}) {
    const rows = await env.db.query<{ id: string }>(
      `INSERT INTO courts (id, club_id, name, sport, price, active)
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5) RETURNING id`,
      [clubId, name, opts.sport ?? 'Fútbol 5', opts.price ?? 30000, opts.active ?? true],
    );
    return rows[0]!.id;
  }

  /** Crea un admin del club y devuelve su cookie de sesión. */
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

  const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, cookie?: string, payload?: object) =>
    env.app.inject({ method, url, cookies: cookie ? { [SESSION_COOKIE]: cookie } : {}, ...(payload ? { payload } : {}) });

  interface PublicClub {
    id: string;
    name: string;
    city: string;
    imageUrl: string | null;
    courts: { id: string; name: string; sport: string; price: number; imageUrl: string | null }[];
  }

  /** Todos los clubes públicos, recorriendo las páginas de a 24. */
  const publicClubs = async (): Promise<PublicClub[]> => {
    const all: PublicClub[] = [];
    for (let page = 1; ; page++) {
      const res = body(await call('GET', `/api/clubs?page=${page}&limit=24`));
      all.push(...res.clubs);
      if (page >= res.totalPages) return all;
    }
  };

  describe('listado público', () => {
    it('devuelve los clubes iniciales en orden, con sus canchas activas, sin iniciar sesión', async () => {
      const res = await call('GET', '/api/clubs');
      expect(res.statusCode).toBe(200);
      const clubs = body(res).clubs;
      expect(clubs.slice(0, 6).map((c: { id: string }) => c.id)).toEqual([
        'estacion-norte',
        'la-cantera-crespo',
        'polideportivo-belgrano',
        'parque-sur-caballito',
        'arena-nunez',
        'terraza-colegiales',
      ]);
      const norte = clubs[0];
      expect(norte).toMatchObject({ name: 'Estación Norte Club', zone: 'Palermo', city: 'buenos-aires', address: 'Av. Dorrego 1840, Palermo' });
      expect(norte.imageUrl).toBeNull();
      expect(norte.courts).toEqual([
        { id: 'en-f5-1', name: 'Cancha 1 · Fútbol 5', sport: 'Fútbol 5', price: 28000, imageUrl: null },
        { id: 'en-f7-1', name: 'Cancha Central · Fútbol 7', sport: 'Fútbol 7', price: 36000, imageUrl: null },
      ]);
      expect(clubs[4].courts.map((c: { id: string }) => c.id)).toEqual(['an-f5', 'an-f8', 'an-f11']);
    });

    it('no incluye datos de ningún usuario', async () => {
      await createClub('test-privado');
      await createCourt('test-privado', 'Cancha 1');
      await loginAdmin('test-privado');
      const text = (await call('GET', '/api/clubs')).body;
      expect(text).not.toContain('@');
      expect(text).not.toContain('password');
    });

    it('lleva Cache-Control: no-store y refleja un cambio de precio al instante', async () => {
      const club = await createClub('test-fresco');
      const courtId = await createCourt(club, 'Cancha 1', { price: 30000 });
      const first = await call('GET', '/api/clubs');
      expect(first.headers['cache-control']).toBe('no-store');
      const find = async () => (await publicClubs()).find((c) => c.id === club)!.courts.find((k) => k.id === courtId)!;
      expect((await find()).price).toBe(30000);

      const admin = await loginAdmin(club);
      expect((await call('PATCH', `/api/club/courts/${courtId}`, admin, { price: 35000 })).statusCode).toBe(200);
      expect((await find()).price).toBe(35000);
    });

    it('una cancha desactivada no aparece y el resto del club sigue; reactivarla la devuelve', async () => {
      const club = await createClub('test-parcial');
      const a = await createCourt(club, 'Cancha A');
      await createCourt(club, 'Cancha B');
      const admin = await loginAdmin(club);

      await call('PATCH', `/api/club/courts/${a}`, admin, { active: false });
      expect((await publicClubs()).find((c) => c.id === club)!.courts.map((k) => k.name)).toEqual(['Cancha B']);

      await call('PATCH', `/api/club/courts/${a}`, admin, { active: true });
      expect((await publicClubs()).find((c) => c.id === club)!.courts.map((k) => k.name)).toEqual(['Cancha A', 'Cancha B']);
    });

    it('un club sin canchas, o sin canchas activas, no aparece; con una activa vuelve', async () => {
      const sin = await createClub('test-sin-canchas');
      const apagado = await createClub('test-apagado');
      const court = await createCourt(apagado, 'Cancha 1', { active: false });
      let ids = (await publicClubs()).map((c) => c.id);
      expect(ids).not.toContain(sin);
      expect(ids).not.toContain(apagado);

      await env.db.query(`UPDATE courts SET active = true WHERE id = $1`, [court]);
      ids = (await publicClubs()).map((c) => c.id);
      expect(ids).toContain(apagado);
    });

    it('los clubes y canchas nuevos van después de los iniciales, en orden de alta', async () => {
      const uno = await createClub('test-orden-1');
      await createCourt(uno, 'Primera');
      await createCourt(uno, 'Segunda');
      const dos = await createClub('test-orden-2');
      await createCourt(dos, 'Unica');
      const clubs = await publicClubs();
      expect(clubs.slice(0, 6).map((c) => c.id)[0]).toBe('estacion-norte');
      const mine = clubs.filter((c) => c.id.startsWith('test-orden'));
      expect(mine.map((c) => c.id)).toEqual(['test-orden-1', 'test-orden-2']);
      expect(mine[0]!.courts.map((k) => k.name)).toEqual(['Primera', 'Segunda']);
    });
  });

  describe('listado paginado', () => {
    /** Crea `n` clubes de prueba con una cancha activa cada uno (después de los 6 iniciales). */
    async function createClubs(n: number, opts: { sport?: string; city?: string } = {}) {
      for (let i = 1; i <= n; i++) {
        const id = `test-pag-${String(i).padStart(2, '0')}`;
        await env.db.query(
          `INSERT INTO clubs (id, name, zone, city, address, created_at)
           VALUES ($1, $2, 'Zona', $3, 'Calle 123', now() + $4 * interval '1 second')`,
          [id, `Club ${i}`, opts.city ?? 'buenos-aires', i],
        );
        await createCourt(id, 'Cancha 1', { sport: opts.sport });
      }
    }

    const page = async (query = '') => body(await call('GET', `/api/clubs${query}`));

    it('por defecto devuelve la página 1 con 6 clubes, el total y las páginas', async () => {
      await createClubs(2); // 6 iniciales + 2
      const res = await call('GET', '/api/clubs');
      expect(res.statusCode).toBe(200);
      expect(body(res)).toMatchObject({ page: 1, limit: 6, total: 8, totalPages: 2 });
      expect(body(res).clubs).toHaveLength(6);
    });

    it('la página 2 trae el resto, en orden de alta y sin repetir', async () => {
      await createClubs(2);
      const first = (await page('?page=1')).clubs.map((c: { id: string }) => c.id);
      const second = (await page('?page=2')).clubs.map((c: { id: string }) => c.id);
      expect(second).toEqual(['test-pag-01', 'test-pag-02']);
      expect(first.filter((id: string) => second.includes(id))).toEqual([]);
      expect(first[0]).toBe('estacion-norte');
    });

    it('una página fuera de rango devuelve la lista vacía con el total correcto', async () => {
      await createClubs(2);
      const res = await page('?page=5');
      expect(res.clubs).toEqual([]);
      expect(res).toMatchObject({ page: 5, total: 8, totalPages: 2 });
    });

    it('respeta el límite pedido', async () => {
      const res = await page('?limit=3&page=2');
      expect(res.clubs.map((c: { id: string }) => c.id)).toEqual(['parque-sur-caballito', 'arena-nunez', 'terraza-colegiales']);
      expect(res).toMatchObject({ limit: 3, total: 6, totalPages: 2 });
    });

    it('filtra por ciudad y el total cuenta solo esos clubes', async () => {
      await createClubs(2, { city: 'rosario' });
      const rosario = await page('?city=rosario');
      expect(rosario.clubs.map((c: { id: string }) => c.id)).toEqual(['test-pag-01', 'test-pag-02']);
      expect(rosario.total).toBe(2);
      expect((await page('?city=buenos-aires')).total).toBe(6);
    });

    it('filtra por deporte: solo clubes con una cancha activa de ese deporte, cada uno con todas sus canchas', async () => {
      const res = await page('?sport=' + encodeURIComponent('Fútbol 8'));
      expect(res.clubs.map((c: { id: string }) => c.id)).toEqual(['polideportivo-belgrano', 'arena-nunez']);
      expect(res.total).toBe(2);
      expect(res.clubs[0].courts.map((c: { sport: string }) => c.sport)).toEqual(['Fútbol 5', 'Fútbol 8']);
    });

    it('una cancha desactivada no cuenta para el filtro de deporte', async () => {
      await env.db.query(`UPDATE courts SET active = false WHERE id = 'pb-f8-2'`);
      try {
        const res = await page('?sport=' + encodeURIComponent('Fútbol 8'));
        expect(res.clubs.map((c: { id: string }) => c.id)).toEqual(['arena-nunez']);
      } finally {
        await env.db.query(`UPDATE courts SET active = true WHERE id = 'pb-f8-2'`);
      }
    });

    it.each([
      ['página 0', '?page=0', 'página'],
      ['página no numérica', '?page=abc', 'página'],
      ['límite 100', '?limit=100', 'límite'],
      ['límite 0', '?limit=0', 'límite'],
      ['deporte inexistente', '?sport=Tenis', 'deporte'],
      ['ciudad inexistente', '?city=narnia', 'ciudad'],
    ])('rechaza %s con un error de validación', async (_label, query, fragment) => {
      const res = await call('GET', `/api/clubs${query}`);
      expect(res.statusCode).toBe(400);
      expect(body(res).error.code).toBe('validation_error');
      expect(body(res).error.message.toLowerCase()).toContain(fragment);
    });

    it('devuelve la imagen de un club y de una cancha cuando la tienen, y nula cuando no', async () => {
      const club = await createClub('test-imagen');
      const court = await createCourt(club, 'Cancha 1');
      await env.db.query(`UPDATE clubs SET image_url = '/assets/complejos/x.jpg' WHERE id = $1`, [club]);
      await env.db.query(`UPDATE courts SET image_url = '/assets/canchas/y.jpg' WHERE id = $1`, [court]);
      const all = await publicClubs();
      const found = all.find((c) => c.id === club)!;
      expect(found.imageUrl).toBe('/assets/complejos/x.jpg');
      expect(found.courts[0]!.imageUrl).toBe('/assets/canchas/y.jpg');
      expect(all[0]!.imageUrl).toBeNull();
    });
  });

  describe('detalle de un club', () => {
    it('devuelve el club con sus canchas activas, sin iniciar sesión', async () => {
      const res = await call('GET', '/api/clubs/estacion-norte');
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(body(res).club).toMatchObject({ id: 'estacion-norte', name: 'Estación Norte Club', zone: 'Palermo', imageUrl: null });
      expect(body(res).club.courts.map((c: { id: string }) => c.id)).toEqual(['en-f5-1', 'en-f7-1']);
    });

    it('no incluye las canchas desactivadas ni las borradas', async () => {
      const club = await createClub('test-detalle');
      await createCourt(club, 'Visible');
      await createCourt(club, 'Apagada', { active: false });
      const borrada = await createCourt(club, 'Borrada');
      await env.db.query(`UPDATE courts SET deleted_at = now() WHERE id = $1`, [borrada]);
      const res = await call('GET', `/api/clubs/${club}`);
      expect(body(res).club.courts.map((c: { name: string }) => c.name)).toEqual(['Visible']);
    });

    it('responde 404 si el club no existe', async () => {
      const res = await call('GET', '/api/clubs/no-existe');
      expect(res.statusCode).toBe(404);
    });

    it('responde 404 si el club no tiene canchas activas', async () => {
      const club = await createClub('test-detalle-apagado');
      await createCourt(club, 'Apagada', { active: false });
      expect((await call('GET', `/api/clubs/${club}`)).statusCode).toBe(404);
      expect((await call('GET', `/api/clubs/${await createClub('test-detalle-vacio')}`)).statusCode).toBe(404);
    });
  });

  describe('gestión de canchas del admin', () => {
    it('lista todas las canchas de su club, activas y desactivadas, con los datos del club', async () => {
      const club = await createClub('test-lista', 'Club Lista');
      await createCourt(club, 'Cancha 1', { price: 31000 });
      await createCourt(club, 'Cancha 2', { sport: 'Fútbol 7', price: 41000, active: false });
      const admin = await loginAdmin(club);

      const res = await call('GET', '/api/club/courts', admin);
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(body(res).club).toEqual({ id: club, name: 'Club Lista', zone: 'Zona', city: 'buenos-aires', address: 'Calle 123' });
      expect(body(res).courts).toEqual([
        expect.objectContaining({ name: 'Cancha 1', sport: 'Fútbol 5', price: 31000, active: true }),
        expect.objectContaining({ name: 'Cancha 2', sport: 'Fútbol 7', price: 41000, active: false }),
      ]);
    });

    it('un club sin canchas devuelve la lista vacía', async () => {
      const club = await createClub('test-vacio');
      const admin = await loginAdmin(club);
      expect(body(await call('GET', '/api/club/courts', admin)).courts).toEqual([]);
    });

    it('cada admin ve solo las canchas de su club', async () => {
      const a = await createClub('test-club-a');
      const b = await createClub('test-club-b');
      await createCourt(a, 'Cancha de A');
      await createCourt(b, 'Cancha de B');
      const adminA = await loginAdmin(a);
      const adminB = await loginAdmin(b);
      expect(body(await call('GET', '/api/club/courts', adminA)).courts.map((c: { name: string }) => c.name)).toEqual(['Cancha de A']);
      expect(body(await call('GET', '/api/club/courts', adminB)).courts.map((c: { name: string }) => c.name)).toEqual(['Cancha de B']);
    });

    describe('crear', () => {
      it('crea una cancha válida: queda activa, en su club, con id generado, y aparece en el listado', async () => {
        const club = await createClub('test-crear');
        const admin = await loginAdmin(club);
        const res = await call('POST', '/api/club/courts', admin, { name: '  Cancha 4 · Fútbol 7  ', sport: 'Fútbol 7', price: 40000 });
        expect(res.statusCode).toBe(201);
        expect(body(res).court).toMatchObject({ name: 'Cancha 4 · Fútbol 7', sport: 'Fútbol 7', price: 40000, active: true });
        expect(body(res).court.id).toMatch(/^c-[0-9a-f-]{36}$/);
        const [row] = await env.db.query<{ club_id: string }>(`SELECT club_id FROM courts WHERE id = $1`, [body(res).court.id]);
        expect(row!.club_id).toBe(club);
        expect(body(await call('GET', '/api/club/courts', admin)).courts).toHaveLength(1);
        expect((await publicClubs()).find((c) => c.id === club)!.courts).toHaveLength(1);
      });

      it.each([
        ['nombre vacío', { name: '   ', sport: 'Fútbol 5', price: 1000 }, 'nombre'],
        ['nombre de más de 60 caracteres', { name: 'x'.repeat(61), sport: 'Fútbol 5', price: 1000 }, '60'],
        ['deporte inexistente', { name: 'Cancha', sport: 'Tenis', price: 1000 }, 'deporte'],
        ['sin deporte', { name: 'Cancha', price: 1000 }, 'deporte'],
        ['precio cero', { name: 'Cancha', sport: 'Fútbol 5', price: 0 }, 'mayor que cero'],
        ['precio negativo', { name: 'Cancha', sport: 'Fútbol 5', price: -1 }, 'mayor que cero'],
        ['precio con decimales', { name: 'Cancha', sport: 'Fútbol 5', price: 1500.5 }, 'entero'],
        ['precio como texto', { name: 'Cancha', sport: 'Fútbol 5', price: '1000' }, 'número'],
        ['sin precio', { name: 'Cancha', sport: 'Fútbol 5' }, 'precio'],
      ])('rechaza %s con un error de validación y no crea nada', async (_label, payload, fragment) => {
        const club = await createClub('test-invalida');
        const admin = await loginAdmin(club);
        const res = await call('POST', '/api/club/courts', admin, payload);
        expect(res.statusCode).toBe(400);
        expect(body(res).error.code).toBe('validation_error');
        expect(body(res).error.message.toLowerCase()).toContain(fragment);
        expect(await env.db.query(`SELECT 1 FROM courts WHERE club_id = $1`, [club])).toHaveLength(0);
      });

      it('acepta un nombre de exactamente 60 caracteres', async () => {
        const club = await createClub('test-sesenta');
        const admin = await loginAdmin(club);
        expect((await call('POST', '/api/club/courts', admin, { name: 'x'.repeat(60), sport: 'Fútbol 5', price: 1000 })).statusCode).toBe(201);
      });

      it('rechaza un nombre repetido en su club aunque cambien las mayúsculas, y lo acepta en otro club', async () => {
        const a = await createClub('test-dup-a');
        const b = await createClub('test-dup-b');
        await createCourt(a, 'Cancha Uno');
        const adminA = await loginAdmin(a);
        const adminB = await loginAdmin(b);

        const dup = await call('POST', '/api/club/courts', adminA, { name: 'CANCHA uno', sport: 'Fútbol 5', price: 1000 });
        expect(dup.statusCode).toBe(409);
        expect(body(dup).error.code).toBe('court_name_taken');
        expect(await env.db.query(`SELECT 1 FROM courts WHERE club_id = $1`, [a])).toHaveLength(1);

        expect((await call('POST', '/api/club/courts', adminB, { name: 'Cancha Uno', sport: 'Fútbol 5', price: 1000 })).statusCode).toBe(201);
      });

      it('rechaza la cancha 51 con un mensaje que indica el tope', async () => {
        const club = await createClub('test-tope');
        await env.db.query(
          `INSERT INTO courts (id, club_id, name, sport, price)
           SELECT 'tope-' || g, $1, 'Cancha ' || g, 'Fútbol 5', 1000 FROM generate_series(1, 50) g`,
          [club],
        );
        const admin = await loginAdmin(club);
        const res = await call('POST', '/api/club/courts', admin, { name: 'Cancha 51', sport: 'Fútbol 5', price: 1000 });
        expect(res.statusCode).toBe(409);
        expect(body(res).error.code).toBe('courts_limit_reached');
        expect(body(res).error.message).toContain('50');
        expect(await env.db.query(`SELECT 1 FROM courts WHERE club_id = $1`, [club])).toHaveLength(50);
      });

      it('el tope cuenta también las canchas desactivadas', async () => {
        const club = await createClub('test-tope-inactivas');
        await env.db.query(
          `INSERT INTO courts (id, club_id, name, sport, price, active)
           SELECT 'inact-' || g, $1, 'Cancha ' || g, 'Fútbol 5', 1000, false FROM generate_series(1, 50) g`,
          [club],
        );
        const admin = await loginAdmin(club);
        expect((await call('POST', '/api/club/courts', admin, { name: 'Otra', sport: 'Fútbol 5', price: 1000 })).statusCode).toBe(409);
      });

      it('dos altas simultáneas con el mismo nombre crean una sola', async () => {
        const club = await createClub('test-simultanea');
        const admin = await loginAdmin(club);
        const payload = { name: 'Cancha Repetida', sport: 'Fútbol 5', price: 1000 };
        const results = await Promise.all([call('POST', '/api/club/courts', admin, payload), call('POST', '/api/club/courts', admin, payload)]);
        expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
        expect(await env.db.query(`SELECT 1 FROM courts WHERE club_id = $1`, [club])).toHaveLength(1);
      });
    });

    describe('editar, desactivar y reactivar', () => {
      it('edita nombre, deporte y precio', async () => {
        const club = await createClub('test-editar');
        const id = await createCourt(club, 'Vieja', { sport: 'Fútbol 5', price: 20000 });
        const admin = await loginAdmin(club);
        const res = await call('PATCH', `/api/club/courts/${id}`, admin, { name: 'Nueva', sport: 'Fútbol 8', price: 50000 });
        expect(res.statusCode).toBe(200);
        expect(body(res).court).toEqual({ id, name: 'Nueva', sport: 'Fútbol 8', price: 50000, active: true });
      });

      it('cambiar solo el precio no choca con el propio nombre y deja el resto igual', async () => {
        const club = await createClub('test-solo-precio');
        const id = await createCourt(club, 'Cancha Central', { sport: 'Fútbol 7', price: 20000 });
        const admin = await loginAdmin(club);
        const res = await call('PATCH', `/api/club/courts/${id}`, admin, { price: 25000 });
        expect(res.statusCode).toBe(200);
        expect(body(res).court).toEqual({ id, name: 'Cancha Central', sport: 'Fútbol 7', price: 25000, active: true });
        // Reenviar el mismo nombre tampoco cuenta como repetido.
        expect((await call('PATCH', `/api/club/courts/${id}`, admin, { name: 'cancha central' })).statusCode).toBe(200);
      });

      it('renombrar a un nombre de otra cancha del club se rechaza y conserva el nombre', async () => {
        const club = await createClub('test-renombrar');
        await createCourt(club, 'Cancha A');
        const b = await createCourt(club, 'Cancha B');
        const admin = await loginAdmin(club);
        const res = await call('PATCH', `/api/club/courts/${b}`, admin, { name: 'cancha a' });
        expect(res.statusCode).toBe(409);
        expect(body(res).error.code).toBe('court_name_taken');
        expect(body(await call('GET', '/api/club/courts', admin)).courts.map((c: { name: string }) => c.name)).toEqual(['Cancha A', 'Cancha B']);
      });

      it('desactiva y reactiva, conservando los datos', async () => {
        const club = await createClub('test-activar');
        const id = await createCourt(club, 'Cancha 1', { price: 33000 });
        const admin = await loginAdmin(club);

        const off = await call('PATCH', `/api/club/courts/${id}`, admin, { active: false });
        expect(body(off).court).toMatchObject({ active: false, price: 33000, name: 'Cancha 1' });
        expect(body(await call('GET', '/api/club/courts', admin)).courts[0].active).toBe(false);

        const on = await call('PATCH', `/api/club/courts/${id}`, admin, { active: true });
        expect(body(on).court).toMatchObject({ active: true, price: 33000, name: 'Cancha 1' });
      });

      it('rechaza un cambio vacío o con datos inválidos', async () => {
        const club = await createClub('test-patch-invalido');
        const id = await createCourt(club, 'Cancha 1');
        const admin = await loginAdmin(club);
        expect((await call('PATCH', `/api/club/courts/${id}`, admin, {})).statusCode).toBe(400);
        expect((await call('PATCH', `/api/club/courts/${id}`, admin, { price: 0 })).statusCode).toBe(400);
        expect((await call('PATCH', `/api/club/courts/${id}`, admin, { sport: 'Rugby' })).statusCode).toBe(400);
        expect((await call('PATCH', `/api/club/courts/${id}`, admin, { name: '' })).statusCode).toBe(400);
      });

      it('una cancha que no existe responde 404', async () => {
        const club = await createClub('test-404');
        const admin = await loginAdmin(club);
        const res = await call('PATCH', '/api/club/courts/no-existe', admin, { price: 1000 });
        expect(res.statusCode).toBe(404);
      });
    });

    describe('borrar', () => {
      it('borra una cancha activa: desaparece de la lista del admin y del sitio, pero la fila se conserva', async () => {
        const club = await createClub('test-borrar');
        const id = await createCourt(club, 'Cancha 1');
        await createCourt(club, 'Cancha 2');
        const admin = await loginAdmin(club);

        const res = await call('DELETE', `/api/club/courts/${id}`, admin);
        expect(res.statusCode).toBe(204);
        expect(body(await call('GET', '/api/club/courts', admin)).courts.map((c: { name: string }) => c.name)).toEqual(['Cancha 2']);
        expect((await publicClubs()).find((c) => c.id === club)!.courts.map((c) => c.name)).toEqual(['Cancha 2']);
        const [row] = await env.db.query<{ deleted_at: Date | null }>(`SELECT deleted_at FROM courts WHERE id = $1`, [id]);
        expect(row!.deleted_at).not.toBeNull();
      });

      it('borra una cancha desactivada', async () => {
        const club = await createClub('test-borrar-apagada');
        const id = await createCourt(club, 'Cancha 1', { active: false });
        const admin = await loginAdmin(club);
        expect((await call('DELETE', `/api/club/courts/${id}`, admin)).statusCode).toBe(204);
        expect(body(await call('GET', '/api/club/courts', admin)).courts).toEqual([]);
      });

      it('borrar dos veces responde 404 la segunda', async () => {
        const club = await createClub('test-borrar-dos');
        const id = await createCourt(club, 'Cancha 1');
        const admin = await loginAdmin(club);
        expect((await call('DELETE', `/api/club/courts/${id}`, admin)).statusCode).toBe(204);
        expect((await call('DELETE', `/api/club/courts/${id}`, admin)).statusCode).toBe(404);
      });

      it('una cancha borrada no se puede editar ni reactivar', async () => {
        const club = await createClub('test-borrar-editar');
        const id = await createCourt(club, 'Cancha 1', { active: false });
        const admin = await loginAdmin(club);
        await call('DELETE', `/api/club/courts/${id}`, admin);
        expect((await call('PATCH', `/api/club/courts/${id}`, admin, { active: true })).statusCode).toBe(404);
        expect((await call('PATCH', `/api/club/courts/${id}`, admin, { price: 1 })).statusCode).toBe(404);
        const [row] = await env.db.query<{ active: boolean }>(`SELECT active FROM courts WHERE id = $1`, [id]);
        expect(row!.active).toBe(false);
      });

      it('el nombre de una cancha borrada se puede reutilizar', async () => {
        const club = await createClub('test-borrar-nombre');
        const id = await createCourt(club, 'Cancha Uno');
        const admin = await loginAdmin(club);
        await call('DELETE', `/api/club/courts/${id}`, admin);
        const res = await call('POST', '/api/club/courts', admin, { name: 'cancha uno', sport: 'Fútbol 5', price: 1000 });
        expect(res.statusCode).toBe(201);
      });

      it('las borradas no cuentan para el tope de 50', async () => {
        const club = await createClub('test-borrar-tope');
        await env.db.query(
          `INSERT INTO courts (id, club_id, name, sport, price)
           SELECT 'bt-' || g, $1, 'Cancha ' || g, 'Fútbol 5', 1000 FROM generate_series(1, 50) g`,
          [club],
        );
        const admin = await loginAdmin(club);
        const payload = { name: 'Cancha 51', sport: 'Fútbol 5', price: 1000 };
        expect((await call('POST', '/api/club/courts', admin, payload)).statusCode).toBe(409);
        await call('DELETE', '/api/club/courts/bt-1', admin);
        expect((await call('POST', '/api/club/courts', admin, payload)).statusCode).toBe(201);
      });

      it('no se puede cargar ni cambiar la imagen desde la API de admin', async () => {
        const club = await createClub('test-sin-imagen');
        const admin = await loginAdmin(club);
        const created = await call('POST', '/api/club/courts', admin, { name: 'Cancha', sport: 'Fútbol 5', price: 1000, imageUrl: '/x.jpg', image_url: '/x.jpg' });
        expect(created.statusCode).toBe(201);
        const id = body(created).court.id;
        await call('PATCH', `/api/club/courts/${id}`, admin, { price: 2000, imageUrl: '/x.jpg', image_url: '/x.jpg' });
        const [row] = await env.db.query<{ image_url: string | null }>(`SELECT image_url FROM courts WHERE id = $1`, [id]);
        expect(row!.image_url).toBeNull();
        expect(body(created).court).not.toHaveProperty('imageUrl');
      });
    });

    describe('permisos', () => {
      it('una cancha de otro club responde 404 igual que una inexistente, y no se modifica', async () => {
        const a = await createClub('test-perm-a');
        const b = await createClub('test-perm-b');
        const ajena = await createCourt(b, 'Cancha de B', { price: 10000 });
        const adminA = await loginAdmin(a);

        const res = await call('PATCH', `/api/club/courts/${ajena}`, adminA, { price: 99999, active: false });
        const missing = await call('PATCH', '/api/club/courts/no-existe', adminA, { price: 99999 });
        expect((await call('DELETE', `/api/club/courts/${ajena}`, adminA)).statusCode).toBe(404);
        expect(await env.db.query(`SELECT 1 FROM courts WHERE id = $1 AND deleted_at IS NULL`, [ajena])).toHaveLength(1);
        expect(res.statusCode).toBe(404);
        expect(body(res)).toEqual(body(missing));
        const [row] = await env.db.query<{ price: number; active: boolean }>(`SELECT price, active FROM courts WHERE id = $1`, [ajena]);
        expect(row).toEqual({ price: 10000, active: true });
      });

      it('un admin no puede tocar las canchas iniciales de otro club', async () => {
        const club = await createClub('test-perm-iniciales');
        const admin = await loginAdmin(club);
        const res = await call('PATCH', '/api/club/courts/en-f5-1', admin, { price: 1 });
        expect(res.statusCode).toBe(404);
        const [row] = await env.db.query<{ price: number }>(`SELECT price FROM courts WHERE id = 'en-f5-1'`);
        expect(row!.price).toBe(28000);
      });

      it('un jugador recibe 403 y no modifica nada', async () => {
        const club = await createClub('test-perm-jugador');
        const id = await createCourt(club, 'Cancha 1');
        const player = await loginPlayer();
        expect((await call('GET', '/api/club/courts', player)).statusCode).toBe(403);
        expect((await call('POST', '/api/club/courts', player, { name: 'X', sport: 'Fútbol 5', price: 1000 })).statusCode).toBe(403);
        expect((await call('PATCH', `/api/club/courts/${id}`, player, { price: 1 })).statusCode).toBe(403);
        expect((await call('DELETE', `/api/club/courts/${id}`, player)).statusCode).toBe(403);
        expect(await env.db.query(`SELECT 1 FROM courts WHERE club_id = $1 AND deleted_at IS NULL`, [club])).toHaveLength(1);
      });

      it('sin sesión responde 401 y no modifica nada', async () => {
        const club = await createClub('test-perm-anonimo');
        const id = await createCourt(club, 'Cancha 1', { price: 5000 });
        expect((await call('GET', '/api/club/courts')).statusCode).toBe(401);
        expect((await call('POST', '/api/club/courts', undefined, { name: 'X', sport: 'Fútbol 5', price: 1000 })).statusCode).toBe(401);
        expect((await call('PATCH', `/api/club/courts/${id}`, undefined, { price: 1 })).statusCode).toBe(401);
        expect((await call('DELETE', `/api/club/courts/${id}`)).statusCode).toBe(401);
        const [row] = await env.db.query<{ price: number }>(`SELECT price FROM courts WHERE id = $1`, [id]);
        expect(row!.price).toBe(5000);
      });

      it('no hay una forma de editar los datos del club', async () => {
        const club = await createClub('test-datos-club', 'Nombre Original');
        const admin = await loginAdmin(club);
        for (const [method, url] of [
          ['PATCH', '/api/club'],
          ['PUT', '/api/club'],
          ['PATCH', `/api/clubs/${club}`],
          ['PUT', `/api/clubs/${club}`],
        ] as const) {
          const res = await env.app.inject({ method, url, cookies: { [SESSION_COOKIE]: admin }, payload: { name: 'Hackeado' } });
          expect(res.statusCode, `${method} ${url}`).toBe(404);
        }
        const [row] = await env.db.query<{ name: string }>(`SELECT name FROM clubs WHERE id = $1`, [club]);
        expect(row!.name).toBe('Nombre Original');
      });
    });
  });
});
