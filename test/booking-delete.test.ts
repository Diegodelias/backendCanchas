import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bookingTestKit } from './booking-helpers.js';
import { createDbTestEnv, type DbTestEnv } from './helpers.js';

// El reloj de los tests arranca el lunes 2026-03-02 a las 09:00 de Argentina; los turnos son del martes 2026-03-03.
const at = (hour: number) => `2026-03-03T${String(hour).padStart(2, '0')}:00:00-03:00`;
const GUEST = { name: 'Ana Pérez', email: 'ana@mail.example' };

describe('eliminar reservas', () => {
  let env: DbTestEnv;
  let kit: ReturnType<typeof bookingTestKit>;
  let clubA: string;
  let clubB: string;
  let courtA: string;
  let courtB: string;
  let adminA: string;
  let adminB: string;
  let superadmin: string;
  let player: string;

  beforeAll(async () => {
    env = await createDbTestEnv();
    kit = bookingTestKit(env);
  });
  afterAll(async () => {
    await env?.close();
  });
  beforeEach(async () => {
    await env.reset();
    clubA = await kit.createClub('test-elim-a');
    clubB = await kit.createClub('test-elim-b');
    courtA = await kit.createCourt(clubA, 'Cancha A', { price: 31000 });
    courtB = await kit.createCourt(clubB, 'Cancha B', { price: 32000 });
    await kit.setSchedule(courtA, [{ weekday: 2, startHour: 16, endHour: 19 }]);
    await kit.setSchedule(courtB, [{ weekday: 2, startHour: 16, endHour: 19 }]);
    adminA = await kit.loginAdmin(clubA);
    adminB = await kit.loginAdmin(clubB);
    superadmin = await kit.loginSuperadmin();
    player = await kit.loginPlayer();
  });

  /** Crea una reserva por la API y devuelve su id. */
  async function book(court: string, hour: number): Promise<string> {
    const res = await kit.call('POST', `/api/courts/${court}/bookings`, undefined, { startsAt: at(hour), ...GUEST });
    expect(res.statusCode).toBe(201);
    return kit.body(res).booking.id as string;
  }
  const exists = async (id: string) => (await env.db.query(`SELECT 1 FROM bookings WHERE id = $1`, [id])).length === 1;
  const total = async () => (await env.db.query(`SELECT 1 FROM bookings`)).length;
  const slots = async (court: string) => {
    const body = kit.body(await kit.call('GET', `/api/courts/${court}/slots?date=2026-03-03`));
    return { free: (body.slots as { time: string }[]).map((s) => s.time), booked: (body.booked as { time: string }[]).map((s) => s.time) };
  };
  const delOwn = (id: string, cookie?: string) => kit.call('DELETE', `/api/club/bookings/${id}`, cookie);
  const delPlatform = (clubId: string, id: string, cookie?: string) =>
    kit.call('DELETE', `/api/platform/clubs/${clubId}/bookings/${id}`, cookie);

  describe('el admin de club (DELETE /api/club/bookings/:id)', () => {
    it('elimina una reserva de su club: 204, la fila desaparece y el turno vuelve a estar libre', async () => {
      const id = await book(courtA, 17);
      expect(await slots(courtA)).toEqual({ free: ['16:00', '18:00'], booked: ['17:00'] });
      env.mailer.sent.length = 0;

      const res = await delOwn(id, adminA);
      expect(res.statusCode).toBe(204);
      expect(res.body).toBe('');
      expect(await exists(id)).toBe(false);
      expect(await slots(courtA)).toEqual({ free: ['16:00', '17:00', '18:00'], booked: [] });
      expect(env.mailer.sent).toHaveLength(0); // no se avisa a nadie
    });

    it('el turno liberado se puede reservar de nuevo', async () => {
      const id = await book(courtA, 17);
      await delOwn(id, adminA);
      const again = await kit.call('POST', `/api/courts/${courtA}/bookings`, undefined, { startsAt: at(17), ...GUEST });
      expect(again.statusCode).toBe(201);
    });

    it('solo borra la reserva indicada y no toca las demás', async () => {
      const a = await book(courtA, 16);
      const b = await book(courtA, 17);
      const other = await book(courtB, 17);
      await delOwn(a, adminA);
      expect(await exists(a)).toBe(false);
      expect(await exists(b)).toBe(true);
      expect(await exists(other)).toBe(true);
    });

    it('una reserva de otro club da 404 y no se borra', async () => {
      const other = await book(courtB, 17);
      const res = await delOwn(other, adminA);
      expect(res.statusCode).toBe(404);
      expect(await exists(other)).toBe(true);
    });

    it('una reserva inexistente da 404 con el mismo mensaje que una de otro club', async () => {
      const other = await book(courtB, 17);
      const ajena = await delOwn(other, adminA);
      const missing = await delOwn('b-no-existe', adminA);
      expect(missing.statusCode).toBe(404);
      expect(kit.body(missing)).toEqual(kit.body(ajena));
    });

    it('un jugador recibe 403, el superadmin 403 y sin sesión 401, y no se borra nada', async () => {
      const id = await book(courtA, 17);
      expect((await delOwn(id, player)).statusCode).toBe(403);
      expect((await delOwn(id, superadmin)).statusCode).toBe(403);
      expect((await delOwn(id)).statusCode).toBe(401);
      expect(await exists(id)).toBe(true);
    });
  });

  describe('el superadmin (DELETE /api/platform/clubs/:clubId/bookings/:bookingId)', () => {
    it('elimina una reserva de cualquier club: 204 y el turno vuelve a estar libre', async () => {
      const idA = await book(courtA, 17);
      const idB = await book(courtB, 18);
      env.mailer.sent.length = 0;

      expect((await delPlatform(clubA, idA, superadmin)).statusCode).toBe(204);
      expect((await delPlatform(clubB, idB, superadmin)).statusCode).toBe(204);
      expect(await total()).toBe(0);
      expect((await slots(courtA)).free).toContain('17:00');
      expect((await slots(courtB)).free).toContain('18:00');
      expect(env.mailer.sent).toHaveLength(0);
    });

    it('una reserva que no es de ese club da 404 y no se borra', async () => {
      const id = await book(courtB, 17);
      const res = await delPlatform(clubA, id, superadmin);
      expect(res.statusCode).toBe(404);
      expect(await exists(id)).toBe(true);
    });

    it('un club inexistente o una reserva inexistente dan 404', async () => {
      const id = await book(courtA, 17);
      expect((await delPlatform('test-no-existe', id, superadmin)).statusCode).toBe(404);
      expect((await delPlatform(clubA, 'b-no-existe', superadmin)).statusCode).toBe(404);
      expect(await exists(id)).toBe(true);
    });

    it('un admin de club y un jugador reciben 403, sin sesión 401, y no se borra nada', async () => {
      const id = await book(courtA, 17);
      expect((await delPlatform(clubA, id, adminA)).statusCode).toBe(403);
      expect((await delPlatform(clubB, id, adminB)).statusCode).toBe(403);
      expect((await delPlatform(clubA, id, player)).statusCode).toBe(403);
      expect((await delPlatform(clubA, id)).statusCode).toBe(401);
      expect(await exists(id)).toBe(true);
    });
  });
});
