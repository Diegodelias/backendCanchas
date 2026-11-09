import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bookingTestKit } from './booking-helpers.js';
import { createDbTestEnv, type DbTestEnv } from './helpers.js';

const ANA = 'ana@mail.example';
const BRUNO = 'bruno@mail.example';
const PLAY = { matchId: 'match-en-f5-1800', title: 'Gol', captureMode: 'video', timestamp: 19, isLiveMoment: false };

describe('cupo de jugadas y compra simulada del paquete', () => {
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

  const quota = (cookie?: string) => kit.call('GET', '/api/plays/quota', cookie);
  const save = (cookie?: string) => kit.call('POST', '/api/plays', cookie, PLAY);
  const buy = (cookie?: string) => kit.call('POST', '/api/plays/pack-purchases', cookie);
  const approve = (id: string, cookie?: string) => kit.call('POST', `/api/plays/pack-purchases/${id}/approve`, cookie);
  const reject = (id: string, cookie?: string) => kit.call('POST', `/api/plays/pack-purchases/${id}/reject`, cookie);
  const setSettings = (freeQuota: number, packPlays = 5, packPrice = 2000) =>
    env.db.query(`UPDATE play_settings SET free_quota = $1, pack_plays = $2, pack_price = $3`, [freeQuota, packPlays, packPrice]);
  const extra = async (email: string) =>
    (await env.db.query<{ extra_plays: number }>(`SELECT extra_plays FROM users WHERE email = $1`, [email]))[0]!.extra_plays;
  const payments = () =>
    env.db.query<{ status: string; provider: string; plays: number; price: number; resolved_at: Date | null }>(
      `SELECT status, provider, plays, price, resolved_at FROM play_payments ORDER BY created_at, id`,
    );

  describe('GET /api/plays/quota', () => {
    it('devuelve el uso, el cupo y el paquete vigente', async () => {
      const ana = await kit.loginPlayer(ANA);
      const res = await quota(ana);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        used: 0,
        freeQuota: 200,
        extraPlays: 0,
        total: 200,
        pack: { plays: 5, price: 2000 },
      });
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('el uso cambia al guardar y al borrar una jugada', async () => {
      const ana = await kit.loginPlayer(ANA);
      const first = (await save(ana)).json().play;
      await save(ana);
      expect((await quota(ana)).json().used).toBe(2);

      await kit.call('DELETE', `/api/plays/${first.id}`, ana);
      expect((await quota(ana)).json().used).toBe(1);
    });

    it('refleja el cupo, las jugadas extra y el paquete configurados', async () => {
      const ana = await kit.loginPlayer(ANA);
      await setSettings(10, 8, 3500);
      await env.db.query(`UPDATE users SET extra_plays = 4 WHERE email = $1`, [ANA]);
      expect((await quota(ana)).json()).toEqual({
        used: 0,
        freeQuota: 10,
        extraPlays: 4,
        total: 14,
        pack: { plays: 8, price: 3500 },
      });
    });

    it('no revela el cupo ni el uso de otros jugadores', async () => {
      const ana = await kit.loginPlayer(ANA);
      const bruno = await kit.loginPlayer(BRUNO);
      await save(ana);
      await env.db.query(`UPDATE users SET extra_plays = 7 WHERE email = $1`, [ANA]);
      const res = await quota(bruno);
      expect(res.json()).toMatchObject({ used: 0, extraPlays: 0, total: 200 });
    });

    it('sin sesión da 401 y un admin de club da 403, sin devolver ningún dato', async () => {
      const club = await kit.createClub('test-cupo-jugador');
      const admin = await kit.loginAdmin(club);
      const noSession = await quota();
      expect(noSession.statusCode).toBe(401);
      expect(noSession.json().error.code).toBe('unauthorized');
      expect(noSession.json().freeQuota).toBeUndefined();
      expect((await quota(admin)).statusCode).toBe(403);
    });
  });

  describe('compra simulada del paquete', () => {
    it('iniciar la compra crea un intento pendiente con el paquete vigente y proveedor «simulated»', async () => {
      const ana = await kit.loginPlayer(ANA);
      const res = await buy(ana);
      expect(res.statusCode).toBe(201);
      expect(res.json().payment).toMatchObject({ plays: 5, price: 2000, status: 'pending', provider: 'simulated', resolvedAt: null });
      expect(res.json().payment.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(await payments()).toMatchObject([{ status: 'pending', provider: 'simulated', plays: 5, price: 2000, resolved_at: null }]);
      // Iniciar no suma nada.
      expect(await extra(ANA)).toBe(0);
    });

    it('aprobar suma las jugadas del paquete al cupo y permite guardar de nuevo', async () => {
      await setSettings(3);
      const ana = await kit.loginPlayer(ANA);
      for (let i = 0; i < 3; i++) expect((await save(ana)).statusCode).toBe(201);
      expect((await save(ana)).statusCode).toBe(409);

      const { payment } = (await buy(ana)).json();
      const res = await approve(payment.id, ana);
      expect(res.statusCode).toBe(200);
      expect(res.json().payment).toMatchObject({ id: payment.id, status: 'approved', provider: 'simulated' });
      expect(res.json().payment.resolvedAt).not.toBeNull();
      expect(res.json().quota).toEqual({ used: 3, freeQuota: 3, extraPlays: 5, total: 8 });

      for (let i = 0; i < 5; i++) expect((await save(ana)).statusCode).toBe(201);
      expect((await save(ana)).statusCode).toBe(409);
    });

    it('rechazar no suma nada y deja el intento registrado como rechazado', async () => {
      await setSettings(1);
      const ana = await kit.loginPlayer(ANA);
      await save(ana);
      const { payment } = (await buy(ana)).json();

      const res = await reject(payment.id, ana);
      expect(res.statusCode).toBe(200);
      expect(res.json().payment.status).toBe('rejected');
      expect(res.json().quota).toMatchObject({ extraPlays: 0, total: 1 });
      expect(await extra(ANA)).toBe(0);
      expect((await save(ana)).statusCode).toBe(409);
      expect(await payments()).toMatchObject([{ status: 'rejected', provider: 'simulated' }]);
    });

    it('cada intento queda registrado con su proveedor, su estado y su fecha de resolución', async () => {
      const ana = await kit.loginPlayer(ANA);
      const ok = (await buy(ana)).json().payment;
      const no = (await buy(ana)).json().payment;
      await buy(ana); // queda pendiente
      await approve(ok.id, ana);
      await reject(no.id, ana);
      const rows = await payments();
      expect(rows.map((r) => r.status).sort()).toEqual(['approved', 'pending', 'rejected']);
      expect(rows.every((r) => r.provider === 'simulated')).toBe(true);
      expect(rows.filter((r) => r.status !== 'pending').every((r) => r.resolved_at !== null)).toBe(true);
      expect(rows.find((r) => r.status === 'pending')!.resolved_at).toBeNull();
      expect(await extra(ANA)).toBe(5);
    });

    it('el pago conserva la cantidad y el precio con los que se inició aunque el paquete cambie', async () => {
      const ana = await kit.loginPlayer(ANA);
      const { payment } = (await buy(ana)).json();
      await setSettings(200, 12, 9999);

      const res = await approve(payment.id, ana);
      expect(res.json().payment).toMatchObject({ plays: 5, price: 2000 });
      expect(res.json().quota.extraPlays).toBe(5);
      expect(await payments()).toMatchObject([{ plays: 5, price: 2000, status: 'approved' }]);

      // El siguiente intento ya toma el paquete nuevo.
      expect((await buy(ana)).json().payment).toMatchObject({ plays: 12, price: 9999 });
    });

    it('aprobar dos veces suma las jugadas una sola vez', async () => {
      const ana = await kit.loginPlayer(ANA);
      const { payment } = (await buy(ana)).json();
      expect((await approve(payment.id, ana)).statusCode).toBe(200);
      const again = await approve(payment.id, ana);
      expect(again.statusCode).toBe(200);
      expect(again.json().payment.status).toBe('approved');
      expect(again.json().quota.extraPlays).toBe(5);
      expect(await extra(ANA)).toBe(5);
    });

    it('varias aprobaciones simultáneas del mismo pago suman las jugadas una sola vez', async () => {
      const ana = await kit.loginPlayer(ANA);
      for (let round = 0; round < 3; round++) {
        const { payment } = (await buy(ana)).json();
        const results = await Promise.all(Array.from({ length: 12 }, () => approve(payment.id, ana)));
        expect(results.every((r) => r.statusCode === 200)).toBe(true);
        expect(await extra(ANA)).toBe(5 * (round + 1));
      }
    });

    it('un pago ya resuelto no se puede resolver de la forma contraria', async () => {
      const ana = await kit.loginPlayer(ANA);
      const a = (await buy(ana)).json().payment;
      await approve(a.id, ana);
      const rejectAfter = await reject(a.id, ana);
      expect(rejectAfter.statusCode).toBe(409);
      expect(rejectAfter.json().error.code).toBe('payment_already_resolved');

      const b = (await buy(ana)).json().payment;
      await reject(b.id, ana);
      expect((await approve(b.id, ana)).statusCode).toBe(409);
      expect(await extra(ANA)).toBe(5);
    });

    it('el pago de otro jugador responde que no existe y no cambia nada', async () => {
      const ana = await kit.loginPlayer(ANA);
      const bruno = await kit.loginPlayer(BRUNO);
      const { payment } = (await buy(ana)).json();

      for (const call of [approve, reject]) {
        const res = await call(payment.id, bruno);
        expect(res.statusCode).toBe(404);
        expect(res.json().error.code).toBe('not_found');
      }
      expect(await extra(ANA)).toBe(0);
      expect(await extra(BRUNO)).toBe(0);
      expect(await payments()).toMatchObject([{ status: 'pending' }]);
    });

    it('un pago inexistente o con un identificador inválido responde 404', async () => {
      const ana = await kit.loginPlayer(ANA);
      expect((await approve('11111111-1111-4111-8111-111111111111', ana)).statusCode).toBe(404);
      expect((await reject('no-es-un-uuid', ana)).statusCode).toBe(404);
    });

    it('sin sesión da 401 y un admin de club da 403, sin crear ni resolver nada', async () => {
      const club = await kit.createClub('test-cupo-pagos');
      const admin = await kit.loginAdmin(club);
      const ana = await kit.loginPlayer(ANA);
      const { payment } = (await buy(ana)).json();

      expect((await buy()).statusCode).toBe(401);
      expect((await buy(admin)).statusCode).toBe(403);
      expect((await approve(payment.id)).statusCode).toBe(401);
      expect((await approve(payment.id, admin)).statusCode).toBe(403);
      expect((await reject(payment.id, admin)).statusCode).toBe(403);
      expect(await payments()).toHaveLength(1);
      expect(await extra(ANA)).toBe(0);
    });

    it('borrar al jugador borra sus pagos', async () => {
      const ana = await kit.loginPlayer(ANA);
      await buy(ana);
      await env.db.query(`DELETE FROM users WHERE email = $1`, [ANA]);
      expect(await payments()).toHaveLength(0);
    });
  });

  it('recorrido de la demostración: llegar al límite, comprar, aprobar y guardar de nuevo', async () => {
    const sa = await kit.loginSuperadmin();
    const set = await kit.call('PUT', '/api/platform/play-settings', sa, { freeQuota: 3, packPlays: 5, packPrice: 2000 });
    expect(set.statusCode).toBe(200);

    const ana = await kit.loginPlayer(ANA);
    for (let i = 0; i < 3; i++) expect((await save(ana)).statusCode).toBe(201);
    expect((await quota(ana)).json()).toMatchObject({ used: 3, total: 3, pack: { plays: 5, price: 2000 } });

    const blocked = await save(ana);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe('plays_limit_reached');

    const { payment } = (await buy(ana)).json();
    await reject(payment.id, ana);
    expect((await save(ana)).statusCode).toBe(409);

    const second = (await buy(ana)).json().payment;
    await approve(second.id, ana);
    expect((await save(ana)).statusCode).toBe(201);
    expect((await quota(ana)).json()).toMatchObject({ used: 4, extraPlays: 5, total: 8 });
    expect((await payments()).map((p) => p.status).sort()).toEqual(['approved', 'rejected']);

    // Volver el cupo a 200 restablece el comportamiento inicial.
    await kit.call('PUT', '/api/platform/play-settings', sa, { freeQuota: 200, packPlays: 5, packPrice: 2000 });
    expect((await quota(ana)).json()).toMatchObject({ freeQuota: 200, total: 205 });
  });
});
