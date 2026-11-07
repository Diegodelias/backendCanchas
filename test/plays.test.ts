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

      expect(patch.statusCode).toBe(404);
      expect(del.statusCode).toBe(404);
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
});
