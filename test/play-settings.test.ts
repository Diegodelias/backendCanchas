import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bookingTestKit } from './booking-helpers.js';
import { createDbTestEnv, type DbTestEnv } from './helpers.js';

const PLAYER = 'ana@mail.example';
const PLAY = { matchId: 'match-en-f5-1800', title: 'Gol', captureMode: 'video', timestamp: 19, isLiveMoment: false };

describe('cupo de jugadas: configuración del superadmin', () => {
  let env: DbTestEnv;
  let kit: ReturnType<typeof bookingTestKit>;

  beforeAll(async () => {
    env = await createDbTestEnv();
    kit = bookingTestKit(env);
  });
  afterAll(async () => {
    await env?.close();
  });
  beforeEach(async () => {
    await env.reset();
  });

  const stored = async () =>
    (await env.db.query<{ free_quota: number; pack_plays: number; pack_price: number }>(
      `SELECT free_quota, pack_plays, pack_price FROM play_settings`,
    ))[0]!;
  const VALID = { freeQuota: 3, packPlays: 5, packPrice: 1500 };

  describe('GET y PUT /api/platform/play-settings', () => {
    const get = (cookie?: string) => kit.call('GET', '/api/platform/play-settings', cookie);
    const put = (payload: unknown, cookie?: string) => kit.call('PUT', '/api/platform/play-settings', cookie, payload as object);

    it('sin configurar devuelve 200 jugadas gratis y un paquete de 5 por $2.000, sin guardar copia', async () => {
      const sa = await kit.loginSuperadmin();
      const res = await get(sa);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ freeQuota: 200, packPlays: 5, packPrice: 2000 });
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('cambia los tres valores, los devuelve y GET los refleja', async () => {
      const sa = await kit.loginSuperadmin();
      const res = await put(VALID, sa);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(VALID);
      expect(await stored()).toEqual({ free_quota: 3, pack_plays: 5, pack_price: 1500 });
      expect((await get(sa)).json()).toEqual(VALID);
    });

    it('acepta los extremos de cada rango', async () => {
      const sa = await kit.loginSuperadmin();
      for (const ok of [
        { freeQuota: 0, packPlays: 1, packPrice: 1 },
        { freeQuota: 10000, packPlays: 1000, packPrice: 1000000 },
      ]) {
        expect((await put(ok, sa)).statusCode, JSON.stringify(ok)).toBe(200);
        expect((await get(sa)).json()).toEqual(ok);
      }
    });

    it('rechaza valores fuera de rango, con decimales, de otro tipo o ausentes, sin cambiar nada', async () => {
      const sa = await kit.loginSuperadmin();
      await put(VALID, sa);
      const bads: unknown[] = [
        { ...VALID, freeQuota: -1 },
        { ...VALID, freeQuota: 10001 },
        { ...VALID, freeQuota: 2.5 },
        { ...VALID, freeQuota: '3' },
        { ...VALID, packPlays: 0 },
        { ...VALID, packPlays: 1001 },
        { ...VALID, packPlays: 2.5 },
        { ...VALID, packPrice: 0 },
        { ...VALID, packPrice: 1000001 },
        { ...VALID, packPrice: 1500.5 },
        { ...VALID, packPrice: null },
        { packPlays: 5, packPrice: 1500 },
        {},
      ];
      for (const bad of bads) {
        const res = await put(bad, sa);
        expect(res.statusCode, JSON.stringify(bad)).toBe(400);
        expect(res.json().error.code).toBe('validation_error');
      }
      expect(await stored()).toEqual({ free_quota: 3, pack_plays: 5, pack_price: 1500 });
    });

    it('explica el motivo del rechazo', async () => {
      const sa = await kit.loginSuperadmin();
      expect(JSON.stringify((await put({ ...VALID, freeQuota: -1 }, sa)).json())).toContain('no puede ser negativo');
      expect(JSON.stringify((await put({ ...VALID, packPrice: 15.5 }, sa)).json())).toContain('sin centavos');
      expect(JSON.stringify((await put({ ...VALID, packPlays: 0 }, sa)).json())).toContain('al menos 1 jugada');
    });

    it('sin sesión da 401 y un admin de club o un jugador dan 403, en GET y en PUT, sin cambiar nada', async () => {
      const club = await kit.createClub('test-cupo');
      const admin = await kit.loginAdmin(club);
      const player = await kit.loginPlayer(PLAYER);
      expect((await get()).statusCode).toBe(401);
      expect((await get(admin)).statusCode).toBe(403);
      expect((await get(player)).statusCode).toBe(403);
      expect((await put(VALID)).statusCode).toBe(401);
      expect((await put(VALID, admin)).statusCode).toBe(403);
      expect((await put(VALID, player)).statusCode).toBe(403);
      expect(await stored()).toEqual({ free_quota: 200, pack_plays: 5, pack_price: 2000 });
    });

    it('si la fila faltara, GET responde los valores por defecto y PUT la crea', async () => {
      const sa = await kit.loginSuperadmin();
      await env.db.query(`DELETE FROM play_settings`);
      try {
        expect((await get(sa)).json()).toEqual({ freeQuota: 200, packPlays: 5, packPrice: 2000 });
        expect((await put(VALID, sa)).json()).toEqual(VALID);
        expect(await stored()).toEqual({ free_quota: 3, pack_plays: 5, pack_price: 1500 });
      } finally {
        await env.db.query(`DELETE FROM play_settings`);
        await env.db.query(`INSERT INTO play_settings DEFAULT VALUES`);
      }
    });

    it('el cupo nuevo rige para guardar jugadas', async () => {
      const sa = await kit.loginSuperadmin();
      const player = await kit.loginPlayer(PLAYER);
      await put({ ...VALID, freeQuota: 1 }, sa);
      expect((await kit.call('POST', '/api/plays', player, PLAY)).statusCode).toBe(201);
      const res = await kit.call('POST', '/api/plays', player, PLAY);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('plays_limit_reached');
      expect(res.json().error.message).toContain('1');
    });
  });

  describe('POST /api/platform/players/extra-plays', () => {
    const grant = (payload: unknown, cookie?: string) =>
      kit.call('POST', '/api/platform/players/extra-plays', cookie, payload as object);
    const extra = async (email: string) =>
      (await env.db.query<{ extra_plays: number }>(`SELECT extra_plays FROM users WHERE lower(email) = lower($1)`, [email]))[0]!.extra_plays;

    it('suma jugadas extra al jugador y devuelve su cupo total', async () => {
      const sa = await kit.loginSuperadmin();
      await kit.loginPlayer(PLAYER);
      await env.db.query(`UPDATE users SET extra_plays = 2 WHERE email = $1`, [PLAYER]);

      const res = await grant({ email: PLAYER, plays: 5 }, sa);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        player: { email: PLAYER },
        quota: { used: 0, freeQuota: 200, extraPlays: 7, total: 207 },
      });
      expect(await extra(PLAYER)).toBe(7);
    });

    it('las jugadas extra son del jugador indicado y no cambian a los demás', async () => {
      const sa = await kit.loginSuperadmin();
      await kit.loginPlayer(PLAYER);
      await kit.loginPlayer('bruno@mail.example');
      await grant({ email: PLAYER, plays: 3 }, sa);
      expect(await extra(PLAYER)).toBe(3);
      expect(await extra('bruno@mail.example')).toBe(0);
    });

    it('no distingue mayúsculas en el mail', async () => {
      const sa = await kit.loginSuperadmin();
      await kit.loginPlayer(PLAYER);
      expect((await grant({ email: 'ANA@Mail.Example', plays: 4 }, sa)).statusCode).toBe(200);
      expect(await extra(PLAYER)).toBe(4);
    });

    it('con las jugadas extra el jugador puede guardar más allá del cupo gratuito', async () => {
      const sa = await kit.loginSuperadmin();
      const player = await kit.loginPlayer(PLAYER);
      await env.db.query(`UPDATE play_settings SET free_quota = 1`);
      expect((await kit.call('POST', '/api/plays', player, PLAY)).statusCode).toBe(201);
      expect((await kit.call('POST', '/api/plays', player, PLAY)).statusCode).toBe(409);

      await grant({ email: PLAYER, plays: 2 }, sa);
      expect((await kit.call('POST', '/api/plays', player, PLAY)).statusCode).toBe(201);
      expect((await kit.call('POST', '/api/plays', player, PLAY)).statusCode).toBe(201);
      expect((await kit.call('POST', '/api/plays', player, PLAY)).statusCode).toBe(409);
    });

    it('un mail sin cuenta de jugador responde 404 con un mensaje claro y no crea nada', async () => {
      const sa = await kit.loginSuperadmin();
      const res = await grant({ email: 'nadie@mail.example', plays: 5 }, sa);
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('player_not_found');
      expect(res.json().error.message).toContain('No hay un jugador');
      expect(await env.db.query(`SELECT 1 FROM users WHERE email = 'nadie@mail.example'`)).toHaveLength(0);
    });

    it('el mail de un admin de club o del superadmin se rechaza igual y no cambia su cuenta', async () => {
      const sa = await kit.loginSuperadmin();
      const club = await kit.createClub('test-cupo-admin');
      await kit.loginAdmin(club);
      for (const email of [`admin@${club}.example`, 'root@canchas3.example']) {
        const res = await grant({ email, plays: 5 }, sa);
        expect(res.statusCode, email).toBe(404);
        expect(await extra(email)).toBe(0);
      }
    });

    it('rechaza una cantidad inválida o un mail inválido, sin cambiar nada', async () => {
      const sa = await kit.loginSuperadmin();
      await kit.loginPlayer(PLAYER);
      const bads: unknown[] = [
        { email: PLAYER, plays: 0 },
        { email: PLAYER, plays: -1 },
        { email: PLAYER, plays: 1.5 },
        { email: PLAYER, plays: 1001 },
        { email: PLAYER, plays: '5' },
        { email: PLAYER },
        { plays: 5 },
        { email: 'no-es-un-mail', plays: 5 },
      ];
      for (const bad of bads) {
        const res = await grant(bad, sa);
        expect(res.statusCode, JSON.stringify(bad)).toBe(400);
        expect(res.json().error.code).toBe('validation_error');
      }
      expect(await extra(PLAYER)).toBe(0);
      expect((await grant({ email: PLAYER, plays: 1000 }, sa)).statusCode).toBe(200);
    });

    it('sin sesión da 401 y un admin de club o un jugador dan 403, sin cambiar nada', async () => {
      const club = await kit.createClub('test-cupo-roles');
      const admin = await kit.loginAdmin(club);
      const player = await kit.loginPlayer(PLAYER);
      expect((await grant({ email: PLAYER, plays: 5 })).statusCode).toBe(401);
      expect((await grant({ email: PLAYER, plays: 5 }, admin)).statusCode).toBe(403);
      expect((await grant({ email: PLAYER, plays: 5 }, player)).statusCode).toBe(403);
      expect(await extra(PLAYER)).toBe(0);
    });
  });
});
