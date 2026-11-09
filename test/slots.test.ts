import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bookingTestKit } from './booking-helpers.js';
import { createDbTestEnv, type DbTestEnv } from './helpers.js';

// El reloj de los tests arranca el lunes 2026-03-02 a las 09:00 de Argentina (12:00 UTC).
const MONDAY = '2026-03-02';
const TUESDAY = '2026-03-03';

describe('turnos libres', () => {
  let env: DbTestEnv;
  let kit: ReturnType<typeof bookingTestKit>;
  let court: string;

  beforeAll(async () => {
    env = await createDbTestEnv();
    kit = bookingTestKit(env);
  });
  afterAll(async () => {
    await env?.close();
  });
  beforeEach(async () => {
    await env.reset();
    const club = await kit.createClub('test-turnos');
    court = await kit.createCourt(club, 'Cancha 1', { price: 31000 });
  });

  const slots = async (date: string, c = court) => {
    const res = await kit.call('GET', `/api/courts/${c}/slots?date=${date}`);
    return { res, times: res.statusCode === 200 ? (kit.body(res).slots as { time: string }[]).map((s) => s.time) : [] };
  };
  const book = (startsAt: string) =>
    env.db.query(
      `INSERT INTO bookings (id, court_id, starts_at, price, name, email, created_ip)
       VALUES (gen_random_uuid()::text, $1, $2, 31000, 'Ana', 'ana@mail.example', '1.1.1.1')`,
      [court, startsAt],
    );

  it('un día con horario ofrece turnos de 60 minutos con su inicio como instante, sin guardar turnos', async () => {
    await kit.setSchedule(court, [{ weekday: 2, startHour: 16, endHour: 19 }]);
    const { res, times } = await slots(TUESDAY);
    expect(res.statusCode).toBe(200);
    expect(times).toEqual(['16:00', '17:00', '18:00']);
    expect(kit.body(res)).toMatchObject({ court: { id: court, price: 31000 }, date: TUESDAY });
    expect(kit.body(res).slots[0].startsAt).toBe('2026-03-03T19:00:00.000Z'); // 16:00 en Argentina (UTC-3)
    expect(res.headers['cache-control']).toBe('no-store');
    expect(await env.db.query(`SELECT 1 FROM bookings`)).toHaveLength(0);
  });

  it('un turno reservado no aparece como libre', async () => {
    await kit.setSchedule(court, [{ weekday: 2, startHour: 16, endHour: 19 }]);
    await book('2026-03-03T17:00:00-03:00');
    expect((await slots(TUESDAY)).times).toEqual(['16:00', '18:00']);
  });

  it('un turno reservado va en `booked`, con su horario y sin datos de quien reservó', async () => {
    await kit.setSchedule(court, [{ weekday: 2, startHour: 16, endHour: 19 }]);
    await book('2026-03-03T17:00:00-03:00');
    const { res, times } = await slots(TUESDAY);
    expect(times).toEqual(['16:00', '18:00']);
    expect(kit.body(res).booked).toEqual([{ startsAt: '2026-03-03T20:00:00.000Z', time: '17:00' }]);
    expect(JSON.stringify(kit.body(res))).not.toMatch(/ana@mail\.example|Ana/);
  });

  it('sin reservas `booked` viene vacío, y con todo reservado `slots` viene vacío', async () => {
    await kit.setSchedule(court, [{ weekday: 2, startHour: 16, endHour: 18 }]);
    expect(kit.body((await slots(TUESDAY)).res).booked).toEqual([]);
    await book('2026-03-03T16:00:00-03:00');
    await book('2026-03-03T17:00:00-03:00');
    const { res, times } = await slots(TUESDAY);
    expect(times).toEqual([]);
    expect(kit.body(res).booked.map((s: { time: string }) => s.time)).toEqual(['16:00', '17:00']);
  });

  it('un turno reservado que ya no cumple la anticipación mínima no aparece ni como libre ni como reservado', async () => {
    await kit.setSchedule(court, [{ weekday: 1, startHour: 16, endHour: 21 }]);
    await book('2026-03-02T18:00:00-03:00');
    await book('2026-03-02T20:00:00-03:00');
    env.clock.current = new Date('2026-03-02T20:30:00Z'); // 17:30: el de las 18:00 ya no se ofrece
    const { res, times } = await slots(MONDAY);
    expect(times).toEqual(['19:00']);
    expect(kit.body(res).booked.map((s: { time: string }) => s.time)).toEqual(['20:00']);
  });

  it('una reserva de otra cancha no afecta a esta', async () => {
    await kit.setSchedule(court, [{ weekday: 2, startHour: 16, endHour: 18 }]);
    const other = await kit.createCourt('test-turnos', 'Cancha 2');
    await env.db.query(
      `INSERT INTO bookings (id, court_id, starts_at, price, name, email, created_ip)
       VALUES ('x1', $1, '2026-03-03T16:00:00-03:00', 1000, 'Ana', 'ana@mail.example', '1.1.1.1')`,
      [other],
    );
    const mine = await slots(TUESDAY);
    expect(mine.times).toEqual(['16:00', '17:00']);
    expect(kit.body(mine.res).booked).toEqual([]);
  });

  it('abierta las 24 horas ofrece 24 turnos', async () => {
    await kit.setSchedule(court, [{ weekday: 2, startHour: 0, endHour: 24 }]);
    expect((await slots(TUESDAY)).times).toHaveLength(24);
  });

  it('una cancha sin horarios, o un día cerrado, no tiene turnos', async () => {
    expect((await slots(TUESDAY)).times).toEqual([]);
    await kit.setSchedule(court, [{ weekday: 3, startHour: 10, endHour: 12 }]);
    const { res, times } = await slots(TUESDAY);
    expect(res.statusCode).toBe(200);
    expect(times).toEqual([]);
  });

  it('hoy no se ofrecen los turnos que empiezan en menos de 1 hora', async () => {
    await kit.setSchedule(court, [{ weekday: 1, startHour: 16, endHour: 21 }]);
    env.clock.current = new Date('2026-03-02T20:30:00Z'); // 17:30 en Argentina
    expect((await slots(MONDAY)).times).toEqual(['19:00', '20:00']);
    env.clock.current = new Date('2026-03-02T20:00:00Z'); // 17:00: el turno de las 18:00 justo cumple la hora
    expect((await slots(MONDAY)).times).toEqual(['18:00', '19:00', '20:00']);
    env.clock.current = new Date(new Date('2026-03-02T20:00:00Z').getTime() + 1);
    expect((await slots(MONDAY)).times).toEqual(['19:00', '20:00']);
  });

  it('la ventana va de hoy hasta 14 días después, en hora de Argentina', async () => {
    await kit.setSchedule(court, [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, startHour: 10, endHour: 12 })));
    expect((await slots('2026-03-16')).res.statusCode).toBe(200); // hoy + 14 días
    expect((await slots('2026-03-17')).res.statusCode).toBe(400);
    expect((await slots('2026-03-01')).res.statusCode).toBe(400);
    // 01:00 UTC del 3 de marzo todavía es el 2 de marzo en Argentina: ayer no existe y "hoy" sigue siendo el 2.
    env.clock.current = new Date('2026-03-03T01:00:00Z');
    expect((await slots('2026-03-02')).res.statusCode).toBe(200);
    expect((await slots('2026-03-16')).res.statusCode).toBe(200);
    expect((await slots('2026-03-17')).res.statusCode).toBe(400); // seguiría siendo hoy + 15
    env.clock.current = new Date('2026-03-03T03:00:00Z'); // 00:00 del 3 en Argentina: recién ahí cambia el día
    expect((await slots('2026-03-17')).res.statusCode).toBe(200);
    expect((await slots('2026-03-02')).res.statusCode).toBe(400);
  });

  it('rechaza una fecha inválida, ausente o fuera de la ventana con un error que indica el rango', async () => {
    for (const bad of ['abc', '2026-02-30', '2026-13-01', '03-03-2026', '']) {
      const res = await kit.call('GET', `/api/courts/${court}/slots?date=${bad}`);
      expect(res.statusCode).toBe(400);
      expect(kit.body(res).error.code).toBe('validation_error');
    }
    expect((await kit.call('GET', `/api/courts/${court}/slots`)).statusCode).toBe(400);
    const outside = await kit.call('GET', `/api/courts/${court}/slots?date=2027-01-01`);
    expect(kit.body(outside).error.message).toContain('2026-03-02');
    expect(kit.body(outside).error.message).toContain('2026-03-16');
  });

  it('una cancha desactivada, borrada, de un club desactivado o inexistente no se encuentra', async () => {
    await kit.setSchedule(court, [{ weekday: 2, startHour: 16, endHour: 19 }]);
    expect((await slots(TUESDAY, 'no-existe')).res.statusCode).toBe(404);

    await env.db.query(`UPDATE courts SET active = false WHERE id = $1`, [court]);
    expect((await slots(TUESDAY)).res.statusCode).toBe(404);
    await env.db.query(`UPDATE courts SET active = true, deleted_at = now() WHERE id = $1`, [court]);
    expect((await slots(TUESDAY)).res.statusCode).toBe(404);
    await env.db.query(`UPDATE courts SET deleted_at = NULL WHERE id = $1`, [court]);
    expect((await slots(TUESDAY)).times).toHaveLength(3);
    await env.db.query(`UPDATE clubs SET active = false WHERE id = 'test-turnos'`);
    expect((await slots(TUESDAY)).res.statusCode).toBe(404);
  });

  it('los turnos de la noche cuentan en su día de Argentina, no en el de UTC', async () => {
    await kit.setSchedule(court, [{ weekday: 2, startHour: 22, endHour: 24 }]);
    const { res, times } = await slots(TUESDAY);
    expect(times).toEqual(['22:00', '23:00']);
    expect(kit.body(res).slots[1].startsAt).toBe('2026-03-04T02:00:00.000Z'); // ya es miércoles en UTC
    await book('2026-03-03T23:00:00-03:00');
    expect((await slots(TUESDAY)).times).toEqual(['22:00']);
  });
});
