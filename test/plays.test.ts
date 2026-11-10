import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAdmin } from '../src/modules/auth/admins.js';
import { SESSION_COOKIE } from '../src/modules/auth/sessions.js';
import { createDbTestEnv, waitFor, type DbTestEnv } from './helpers.js';

const ANA = 'ana@mail.example';
const BRUNO = 'bruno@mail.example';
const ADMIN = {
  email: 'gonzalo@estacion-norte.example',
  name: 'Gonzalo',
  clubId: 'estacion-norte',
  password: 'clave-de-prueba-123',
};

const PLAY = {
  matchId: 'match-en-f5-1800',
  title: 'Gol de chilena',
  category: 'Gol',
  captureMode: 'video',
  timestamp: 19,
  isLiveMoment: false,
};

describe('jugadas del jugador', () => {
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

  async function loginPlayer(email: string): Promise<string> {
    await env.app.inject({ method: 'POST', url: '/api/auth/player/request-link', payload: { email } });
    await waitFor(() => env.mailer.lastLinkTo(email) !== null);
    const token = new URL(env.mailer.lastLinkTo(email)!).searchParams.get('token')!;
    const res = await env.app.inject({ method: 'POST', url: '/api/auth/player/confirm', payload: { token } });
    return res.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
  }

  const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, cookie?: string, payload?: object) =>
    env.app.inject({
      method,
      url,
      cookies: cookie ? { [SESSION_COOKIE]: cookie } : {},
      ...(payload ? { payload } : {}),
    });

  const create = (cookie: string, overrides: object = {}) => call('POST', '/api/plays', cookie, { ...PLAY, ...overrides });
  const countPlays = async () => (await env.db.query('SELECT 1 FROM plays')).length;
  const body = (res: LightMyRequestResponse) => res.json();

  it('guarda una jugada a nombre del jugador y la devuelve con su id y fecha', async () => {
    const ana = await loginPlayer(ANA);
    const res = await create(ana);
    expect(res.statusCode).toBe(201);
    expect(body(res).play).toMatchObject({
      matchId: 'match-en-f5-1800',
      title: 'Gol de chilena',
      category: 'Gol',
      captureMode: 'video',
      timestamp: 19,
      isLiveMoment: false,
    });
    expect(body(res).play.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Date(body(res).play.createdAt).toISOString()).toBe(env.clock.current.toISOString());
  });

  it('acepta una jugada sin categoría y valores por defecto', async () => {
    const ana = await loginPlayer(ANA);
    const res = await call('POST', '/api/plays', ana, { matchId: 'cam-1', title: 'Atajadón', timestamp: 3.7 });
    expect(res.statusCode).toBe(201);
    expect(body(res).play).toMatchObject({ category: null, captureMode: 'video', timestamp: 3, isLiveMoment: false });
  });

  it('lista solo las propias, de la más reciente a la más antigua', async () => {
    const ana = await loginPlayer(ANA);
    const bruno = await loginPlayer(BRUNO);
    await create(ana, { title: 'Primera' });
    env.clock.advance(60_000);
    await create(ana, { title: 'Segunda' });
    await create(bruno, { title: 'De Bruno' });

    const res = await call('GET', '/api/plays', ana);
    expect(res.statusCode).toBe(200);
    expect(body(res).plays.map((p: { title: string }) => p.title)).toEqual(['Segunda', 'Primera']);
  });

  it('un jugador nuevo ve su lista vacía', async () => {
    const ana = await loginPlayer(ANA);
    expect(body(await call('GET', '/api/plays', ana))).toEqual({ plays: [] });
  });

  it('cambia el título y la categoría', async () => {
    const ana = await loginPlayer(ANA);
    const { play } = body(await create(ana));

    const renamed = await call('PATCH', `/api/plays/${play.id}`, ana, { title: 'Golazo' });
    expect(renamed.statusCode).toBe(200);
    expect(body(renamed).play).toMatchObject({ title: 'Golazo', category: 'Gol' });

    const recategorized = await call('PATCH', `/api/plays/${play.id}`, ana, { category: 'Atajada' });
    expect(body(recategorized).play).toMatchObject({ title: 'Golazo', category: 'Atajada' });

    const cleared = await call('PATCH', `/api/plays/${play.id}`, ana, { category: null });
    expect(body(cleared).play.category).toBeNull();
  });

  it('rechaza un cambio vacío o una categoría inválida', async () => {
    const ana = await loginPlayer(ANA);
    const { play } = body(await create(ana));
    expect((await call('PATCH', `/api/plays/${play.id}`, ana, {})).statusCode).toBe(400);
    expect((await call('PATCH', `/api/plays/${play.id}`, ana, { category: 'Inventada' })).statusCode).toBe(400);
  });

  it('borra una jugada y deja de aparecer', async () => {
    const ana = await loginPlayer(ANA);
    const { play } = body(await create(ana));
    expect((await call('DELETE', `/api/plays/${play.id}`, ana)).statusCode).toBe(204);
    expect(body(await call('GET', '/api/plays', ana))).toEqual({ plays: [] });
  });

  describe('privacidad', () => {
    it('una jugada ajena responde 404 al pedirla, cambiarla o borrarla, y no se modifica', async () => {
      const ana = await loginPlayer(ANA);
      const bruno = await loginPlayer(BRUNO);
      const { play } = body(await create(ana));

      const patch = await call('PATCH', `/api/plays/${play.id}`, bruno, { title: 'Robada' });
      const del = await call('DELETE', `/api/plays/${play.id}`, bruno);
      const missing = await call('DELETE', '/api/plays/00000000-0000-4000-8000-000000000000', bruno);
      const clip = await call('GET', `/api/plays/${play.id}/clip`, bruno);

      expect(patch.statusCode).toBe(404);
      expect(del.statusCode).toBe(404);
      expect(clip.statusCode).toBe(404);
      expect(body(patch)).toEqual(body(missing));
      const mine = body(await call('GET', '/api/plays', ana)).plays;
      expect(mine).toHaveLength(1);
      expect(mine[0].title).toBe('Gol de chilena');
      expect(body(await call('GET', '/api/plays', bruno))).toEqual({ plays: [] });
    });

    it('un id que no es un uuid también responde 404', async () => {
      const ana = await loginPlayer(ANA);
      expect((await call('DELETE', '/api/plays/no-es-uuid', ana)).statusCode).toBe(404);
    });

    it('sin sesión responde 401 y no modifica nada', async () => {
      expect((await call('GET', '/api/plays')).statusCode).toBe(401);
      expect((await call('POST', '/api/plays', undefined, PLAY)).statusCode).toBe(401);
      expect((await call('PATCH', '/api/plays/00000000-0000-4000-8000-000000000000', undefined, { title: 'x' })).statusCode).toBe(401);
      expect((await call('DELETE', '/api/plays/00000000-0000-4000-8000-000000000000')).statusCode).toBe(401);
      expect(await countPlays()).toBe(0);
    });

    it('un admin de club responde 403 y no recibe jugadas', async () => {
      const ana = await loginPlayer(ANA);
      await create(ana);
      await createAdmin(env.db, ADMIN);
      const login = await env.app.inject({
        method: 'POST',
        url: '/api/auth/admin/login',
        payload: { email: ADMIN.email, password: ADMIN.password },
      });
      const admin = login.cookies.find((c) => c.name === SESSION_COOKIE)!.value;

      const list = await call('GET', '/api/plays', admin);
      expect(list.statusCode).toBe(403);
      expect(JSON.stringify(body(list))).not.toContain('Gol de chilena');
      expect((await create(admin)).statusCode).toBe(403);
    });
  });

  describe('ver una jugada con su link', () => {
    it('sin sesión devuelve la jugada con su grabación y sin datos del dueño', async () => {
      const ana = await loginPlayer(ANA);
      const { play } = body(await create(ana));
      const [owner] = await env.db.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [ANA]);

      const res = await call('GET', `/api/plays/${play.id}`);

      expect(res.statusCode).toBe(200);
      expect(body(res).play).toMatchObject({ id: play.id, title: 'Gol de chilena', timestamp: 19 });
      expect(body(res).play).toHaveProperty('recording');
      expect(res.body).not.toContain(ANA);
      expect(res.body).not.toContain(owner.id);
    });

    it('otro jugador la ve, pero no puede cambiarla ni borrarla', async () => {
      const ana = await loginPlayer(ANA);
      const bruno = await loginPlayer(BRUNO);
      const { play } = body(await create(ana));

      expect((await call('GET', `/api/plays/${play.id}`, bruno)).statusCode).toBe(200);
      expect((await call('PATCH', `/api/plays/${play.id}`, bruno, { title: 'Robada' })).statusCode).toBe(404);
      expect((await call('DELETE', `/api/plays/${play.id}`, bruno)).statusCode).toBe(404);
      expect(body(await call('GET', '/api/plays', bruno))).toEqual({ plays: [] });
    });

    it('una jugada inexistente, borrada o con un id mal formado responde 404', async () => {
      const ana = await loginPlayer(ANA);
      const { play } = body(await create(ana));
      await call('DELETE', `/api/plays/${play.id}`, ana);

      expect((await call('GET', `/api/plays/${play.id}`)).statusCode).toBe(404);
      expect((await call('GET', '/api/plays/00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
      expect((await call('GET', '/api/plays/no-es-uuid')).statusCode).toBe(404);
    });
  });

  describe('límites', () => {
    it('al llegar a 200 jugadas responde 409 con el tope y no crea otra', async () => {
      const ana = await loginPlayer(ANA);
      const [user] = await env.db.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [ANA]);
      await env.db.query(
        `INSERT INTO plays (user_id, match_id, title, capture_mode, timestamp_seconds)
         SELECT $1, 'm-' || g, 'Jugada ' || g, 'video', g FROM generate_series(1, 200) g`,
        [user!.id],
      );

      const res = await create(ana);
      expect(res.statusCode).toBe(409);
      expect(body(res).error.code).toBe('plays_limit_reached');
      expect(body(res).error.message).toContain('200');
      expect(await countPlays()).toBe(200);

      // Borrando una, vuelve a poder guardar.
      const { plays } = body(await call('GET', '/api/plays', ana));
      await call('DELETE', `/api/plays/${plays[0].id}`, ana);
      expect((await create(ana)).statusCode).toBe(201);
    });

    it('el tope es por jugador', async () => {
      const ana = await loginPlayer(ANA);
      const bruno = await loginPlayer(BRUNO);
      const [user] = await env.db.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [ANA]);
      await env.db.query(
        `INSERT INTO plays (user_id, match_id, title, capture_mode, timestamp_seconds)
         SELECT $1, 'm-' || g, 'Jugada ' || g, 'video', g FROM generate_series(1, 200) g`,
        [user!.id],
      );
      expect((await create(ana)).statusCode).toBe(409);
      expect((await create(bruno)).statusCode).toBe(201);
    });

    describe('cupo configurable', () => {
      const setQuota = (freeQuota: number) => env.db.query(`UPDATE play_settings SET free_quota = ${freeQuota}`);
      const giveExtra = (email: string, extra: number) =>
        env.db.query(`UPDATE users SET extra_plays = ${extra} WHERE email = $1`, [email]);

      it('con el valor inicial, 199 jugadas dejan guardar una más y 200 no', async () => {
        const ana = await loginPlayer(ANA);
        const [user] = await env.db.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [ANA]);
        await env.db.query(
          `INSERT INTO plays (user_id, match_id, title, capture_mode, timestamp_seconds)
           SELECT $1, 'm-' || g, 'Jugada ' || g, 'video', g FROM generate_series(1, 199) g`,
          [user!.id],
        );
        expect((await create(ana)).statusCode).toBe(201);
        expect((await create(ana)).statusCode).toBe(409);
      });

      it('con el cupo en 3, el cuarto guardado responde 409 con ese cupo', async () => {
        await setQuota(3);
        const ana = await loginPlayer(ANA);
        for (let i = 0; i < 3; i++) expect((await create(ana)).statusCode).toBe(201);

        const res = await create(ana);
        expect(res.statusCode).toBe(409);
        expect(body(res).error.code).toBe('plays_limit_reached');
        expect(body(res).error.message).toContain('3');
        expect(await countPlays()).toBe(3);
      });

      it('con el cupo en 0 no se puede guardar ninguna', async () => {
        await setQuota(0);
        const ana = await loginPlayer(ANA);
        expect((await create(ana)).statusCode).toBe(409);
        expect(await countPlays()).toBe(0);
      });

      it('las jugadas extra se suman al cupo gratuito y el mensaje dice el total', async () => {
        await setQuota(1);
        const ana = await loginPlayer(ANA);
        await giveExtra(ANA, 2);
        for (let i = 0; i < 3; i++) expect((await create(ana)).statusCode).toBe(201);

        const res = await create(ana);
        expect(res.statusCode).toBe(409);
        expect(body(res).error.message).toContain('3');
      });

      it('las jugadas extra son de cada jugador', async () => {
        await setQuota(1);
        const ana = await loginPlayer(ANA);
        const bruno = await loginPlayer(BRUNO);
        await giveExtra(ANA, 1);
        expect((await create(ana)).statusCode).toBe(201);
        expect((await create(ana)).statusCode).toBe(201);
        expect((await create(bruno)).statusCode).toBe(201);
        expect((await create(bruno)).statusCode).toBe(409);
      });

      it('borrar una jugada libera un lugar', async () => {
        await setQuota(2);
        const ana = await loginPlayer(ANA);
        const first = body(await create(ana)).play;
        await create(ana);
        expect((await create(ana)).statusCode).toBe(409);

        await call('DELETE', `/api/plays/${first.id}`, ana);
        expect((await create(ana)).statusCode).toBe(201);
      });

      it('bajar el cupo por debajo de lo guardado conserva las jugadas y solo impide guardar más', async () => {
        const ana = await loginPlayer(ANA);
        for (let i = 0; i < 5; i++) expect((await create(ana)).statusCode).toBe(201);

        await setQuota(3);
        const { plays } = body(await call('GET', '/api/plays', ana));
        expect(plays).toHaveLength(5);
        expect((await create(ana)).statusCode).toBe(409);
        expect(await countPlays()).toBe(5);

        // Con menos jugadas que el cupo vuelve a poder guardar, hasta completarlo.
        for (const p of plays.slice(0, 3)) await call('DELETE', `/api/plays/${p.id}`, ana);
        expect((await create(ana)).statusCode).toBe(201);
        expect((await create(ana)).statusCode).toBe(409);
      });

      // Sin el trigger de la base, con 40 pedidos simultáneos el tope se superaba por 1 (el `INSERT … WHERE count < cupo`
      // ve la misma instantánea). Se repite en varias rondas porque la carrera no se da siempre.
      it('varios guardados simultáneos al borde del cupo no lo superan', async () => {
        const ana = await loginPlayer(ANA);
        for (let round = 0; round < 5; round++) {
          await env.db.query('DELETE FROM plays');
          await setQuota(5);
          const results = await Promise.all(Array.from({ length: 40 }, () => create(ana)));
          expect(results.filter((r) => r.statusCode === 201)).toHaveLength(5);
          expect(results.filter((r) => r.statusCode === 409)).toHaveLength(35);
          expect(await countPlays()).toBe(5);
        }
      });

      it('el mensaje del 409 de un alta simultánea dice el cupo total', async () => {
        await setQuota(2);
        const ana = await loginPlayer(ANA);
        await giveExtra(ANA, 1);
        const results = await Promise.all(Array.from({ length: 10 }, () => create(ana)));
        const rejected = results.find((r) => r.statusCode === 409)!;
        expect(body(rejected).error.code).toBe('plays_limit_reached');
        expect(body(rejected).error.message).toContain('3');
        expect(await countPlays()).toBe(3);
      });
    });

    it('rechaza un identificador de partido de más de 100 caracteres', async () => {
      const ana = await loginPlayer(ANA);
      expect((await create(ana, { matchId: 'x'.repeat(101) })).statusCode).toBe(400);
      expect((await create(ana, { matchId: 'x'.repeat(100) })).statusCode).toBe(201);
    });

    it('rechaza título vacío, categoría inválida y momento negativo', async () => {
      const ana = await loginPlayer(ANA);
      expect((await create(ana, { title: '   ' })).statusCode).toBe(400);
      expect((await create(ana, { category: 'Inventada' })).statusCode).toBe(400);
      expect((await create(ana, { timestamp: -1 })).statusCode).toBe(400);
      expect(await countPlays()).toBe(0);
    });
  });

  it('al borrar el usuario se borran sus jugadas', async () => {
    const ana = await loginPlayer(ANA);
    await create(ana);
    await env.db.query(`DELETE FROM users WHERE email = $1`, [ANA]);
    expect(await countPlays()).toBe(0);
  });
  describe('con los datos de su grabación', () => {
    async function recordingFor(id: string, opts: { status?: string; clubActive?: boolean } = {}) {
      await env.db.query(
        `INSERT INTO clubs (id, name, zone, city, address, active) VALUES ('test-plays-rec', 'Club Demo', 'Zona', 'buenos-aires', 'Calle 1', $1)
         ON CONFLICT (id) DO UPDATE SET active = EXCLUDED.active`,
        [opts.clubActive ?? true],
      );
      await env.db.query(
        `INSERT INTO courts (id, club_id, name, sport, price) VALUES ('test-plays-rec-c1', 'test-plays-rec', 'Cancha 1', 'Fútbol 5', 1000)
         ON CONFLICT (id) DO NOTHING`,
      );
      const status = opts.status ?? 'available';
      await env.db.query(
        `INSERT INTO recordings (id, court_id, starts_at, status, video_file, duration_seconds)
         VALUES ($1, 'test-plays-rec-c1', '2026-03-01T17:30:00-03:00', $2, $3, 60)`,
        [id, status, status === 'available' ? 'demo-partido.mp4' : null],
      );
    }

    it('una jugada de una grabación llega con club, cancha, turno, estado y video, al listar, crear y editar', async () => {
      await recordingFor('test-play-rec-1');
      const ana = await loginPlayer(ANA);
      const created = await create(ana, { matchId: 'test-play-rec-1' });
      const expected = {
        id: 'test-play-rec-1',
        club: { id: 'test-plays-rec', name: 'Club Demo' },
        court: { id: 'test-plays-rec-c1', name: 'Cancha 1' },
        date: '2026-03-01',
        time: '17:30',
        status: 'available',
        videoUrl: '/api/videos/demo-partido.mp4',
      };
      expect(body(created).play.recording).toMatchObject(expected);

      const list = await call('GET', '/api/plays', ana);
      expect(body(list).plays[0].recording).toMatchObject(expected);

      const edited = await call('PATCH', `/api/plays/${body(created).play.id}`, ana, { title: 'Otro título' });
      expect(body(edited).play.recording).toMatchObject(expected);
    });

    it('una jugada en vivo, con el id de una cámara, se guarda y llega sin grabación', async () => {
      const ana = await loginPlayer(ANA);
      const res = await create(ana, { matchId: 'estacion-norte-c1', isLiveMoment: true });
      expect(res.statusCode).toBe(201);
      expect(body(res).play.recording).toBeNull();
    });

    it('una jugada huérfana se conserva y llega con recording null, también si el club se desactiva', async () => {
      await recordingFor('test-play-rec-2');
      const ana = await loginPlayer(ANA);
      await create(ana, { matchId: 'test-play-rec-2' });
      await create(ana, { matchId: 'match-que-ya-no-existe', title: 'Huérfana' });

      let plays = body(await call('GET', '/api/plays', ana)).plays as { title: string; recording: unknown }[];
      expect(plays.find((p) => p.title === 'Huérfana')!.recording).toBeNull();
      expect(plays.find((p) => p.title === 'Gol de chilena')!.recording).not.toBeNull();

      await env.db.query(`UPDATE clubs SET active = false WHERE id = 'test-plays-rec'`);
      plays = body(await call('GET', '/api/plays', ana)).plays;
      expect(plays).toHaveLength(2);
      expect(plays.every((p) => p.recording === null)).toBe(true);
    });

    it('una grabación en proceso llega con su estado y sin video', async () => {
      await recordingFor('test-play-rec-3', { status: 'processing' });
      const ana = await loginPlayer(ANA);
      const res = await create(ana, { matchId: 'test-play-rec-3' });
      expect(body(res).play.recording).toMatchObject({ status: 'processing', videoUrl: null });
    });

    it('varias jugadas de la misma grabación se resuelven juntas', async () => {
      await recordingFor('test-play-rec-4');
      const ana = await loginPlayer(ANA);
      await create(ana, { matchId: 'test-play-rec-4', title: 'Una' });
      await create(ana, { matchId: 'test-play-rec-4', title: 'Otra' });
      const plays = body(await call('GET', '/api/plays', ana)).plays as { recording: { id: string } }[];
      expect(plays.map((p) => p.recording.id)).toEqual(['test-play-rec-4', 'test-play-rec-4']);
    });
  });
  describe('con su fragmento', () => {
    it('sin indicarlo, el fragmento es de 15 s antes a 5 s después del momento marcado', async () => {
      const ana = await loginPlayer(ANA);
      const res = await create(ana, { timestamp: 19 });
      expect(res.statusCode).toBe(201);
      expect(body(res).play).toMatchObject({ timestamp: 19, clipStart: 4, clipEnd: 24 });
    });

    it('el inicio por defecto no baja de 0', async () => {
      const ana = await loginPlayer(ANA);
      const res = await create(ana, { timestamp: 6 });
      expect(body(res).play).toMatchObject({ clipStart: 0, clipEnd: 11 });
    });

    it('guarda el fragmento que ajustó el jugador y lo devuelve al listar y al editar', async () => {
      const ana = await loginPlayer(ANA);
      const created = await create(ana, { timestamp: 30, clipStart: 20, clipEnd: 45 });
      expect(created.statusCode).toBe(201);
      expect(body(created).play).toMatchObject({ clipStart: 20, clipEnd: 45 });

      const list = await call('GET', '/api/plays', ana);
      expect(body(list).plays[0]).toMatchObject({ clipStart: 20, clipEnd: 45 });
      const edited = await call('PATCH', `/api/plays/${body(created).play.id}`, ana, { title: 'Otro' });
      expect(body(edited).play).toMatchObject({ clipStart: 20, clipEnd: 45 });
    });

    it('acepta un fragmento de justo 3 y de justo 120 segundos, y uno que empieza o termina en el momento marcado', async () => {
      const ana = await loginPlayer(ANA);
      expect((await create(ana, { timestamp: 30, clipStart: 29, clipEnd: 32 })).statusCode).toBe(201);
      expect((await create(ana, { timestamp: 100, clipStart: 0, clipEnd: 120 })).statusCode).toBe(201);
      expect((await create(ana, { timestamp: 30, clipStart: 30, clipEnd: 40 })).statusCode).toBe(201);
      expect((await create(ana, { timestamp: 30, clipStart: 20, clipEnd: 30 })).statusCode).toBe(201);
    });

    it.each([
      ['dura menos de 3 segundos', { clipStart: 29, clipEnd: 31 }, /al menos 3 segundos/],
      ['dura más de 120 segundos', { clipStart: 0, clipEnd: 121 }, /hasta 120 segundos/],
      ['el fin es anterior al inicio', { clipStart: 40, clipEnd: 30 }, /posterior al inicio/],
      ['el fin es igual al inicio', { clipStart: 30, clipEnd: 30 }, /posterior al inicio/],
      ['el inicio es negativo', { clipStart: -2, clipEnd: 30 }, /no puede ser negativo/],
      ['no incluye el momento marcado (antes)', { clipStart: 10, clipEnd: 20 }, /incluir el momento marcado/],
      ['no incluye el momento marcado (después)', { clipStart: 31, clipEnd: 45 }, /incluir el momento marcado/],
      ['trae solo el inicio', { clipStart: 20 }, /inicio y el fin/],
      ['trae solo el fin', { clipEnd: 40 }, /inicio y el fin/],
      ['no son segundos enteros', { clipStart: 20.5, clipEnd: 40 }, /segundos enteros/],
    ])('rechaza un fragmento que %s, sin guardar la jugada', async (_name, clip, message) => {
      const ana = await loginPlayer(ANA);
      const res = await create(ana, { timestamp: 30, ...clip });
      expect(res.statusCode).toBe(400);
      expect(body(res).error.code).toBe('validation_error');
      expect(body(res).error.message).toMatch(message);
      expect(await countPlays()).toBe(0);
    });

    it('una jugada en vivo no guarda fragmento, aunque el pedido traiga uno', async () => {
      const ana = await loginPlayer(ANA);
      const res = await create(ana, { matchId: 'estacion-norte-c1', isLiveMoment: true, timestamp: 12 });
      expect(body(res).play).toMatchObject({ clipStart: null, clipEnd: null });
      const withClip = await create(ana, { matchId: 'estacion-norte-c1', isLiveMoment: true, timestamp: 12, clipStart: 1, clipEnd: 2 });
      expect(withClip.statusCode).toBe(201);
      expect(body(withClip).play).toMatchObject({ clipStart: null, clipEnd: null });
    });
  });
});
