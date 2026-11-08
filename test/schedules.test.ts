import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bookingTestKit } from './booking-helpers.js';
import { createDbTestEnv, type DbTestEnv } from './helpers.js';

const WEEK = [
  ...[1, 2, 3, 4, 5].map((weekday) => ({ weekday, startHour: 16, endHour: 23 })),
  { weekday: 6, startHour: 10, endHour: 24 },
];

describe('horarios semanales de las canchas', () => {
  let env: DbTestEnv;
  let kit: ReturnType<typeof bookingTestKit>;
  let club: string;
  let court: string;
  let admin: string;
  let sa: string;

  beforeAll(async () => {
    env = await createDbTestEnv();
    kit = bookingTestKit(env);
  });
  afterAll(async () => {
    await env?.close();
  });
  beforeEach(async () => {
    await env.reset();
    club = await kit.createClub('test-horarios');
    court = await kit.createCourt(club, 'Cancha 1');
    admin = await kit.loginAdmin(club);
    sa = await kit.loginSuperadmin();
  });

  const url = (c = court) => `/api/club/courts/${c}/schedule`;
  const platformUrl = (c = court, k = club) => `/api/platform/clubs/${k}/courts/${c}/schedule`;

  it('una cancha nueva no tiene horarios y el listado la marca', async () => {
    const res = await kit.call('GET', url(), admin);
    expect(res.statusCode).toBe(200);
    expect(kit.body(res)).toEqual({ days: [] });

    const list = await kit.call('GET', '/api/club/courts', admin);
    expect(kit.body(list).courts[0]).toMatchObject({ id: court, hasSchedule: false });
  });

  it('guarda un horario válido, con 24 horas, y lo devuelve ordenado', async () => {
    const res = await kit.call('PUT', url(), admin, { days: [...WEEK].reverse().concat({ weekday: 7, startHour: 0, endHour: 24 }) });
    expect(res.statusCode).toBe(200);
    expect(kit.body(res).days).toEqual([...WEEK, { weekday: 7, startHour: 0, endHour: 24 }]);

    const again = await kit.call('GET', url(), admin);
    expect(kit.body(again).days).toHaveLength(7);
    const list = await kit.call('GET', '/api/club/courts', admin);
    expect(kit.body(list).courts[0].hasSchedule).toBe(true);
  });

  it('reemplazar el horario borra los días que ya no están, y vaciarlo cierra la cancha', async () => {
    await kit.call('PUT', url(), admin, { days: WEEK });
    const res = await kit.call('PUT', url(), admin, { days: [{ weekday: 2, startHour: 9, endHour: 12 }] });
    expect(kit.body(res).days).toEqual([{ weekday: 2, startHour: 9, endHour: 12 }]);

    const empty = await kit.call('PUT', url(), admin, { days: [] });
    expect(empty.statusCode).toBe(200);
    expect(kit.body(empty).days).toEqual([]);
  });

  it.each([
    ['el cierre no es posterior a la apertura', { weekday: 1, startHour: 18, endHour: 18 }, /lunes/],
    ['el cierre es anterior a la apertura', { weekday: 3, startHour: 20, endHour: 10 }, /miércoles/],
    ['sale del día', { weekday: 5, startHour: 10, endHour: 25 }, /viernes/],
    ['la apertura es negativa', { weekday: 6, startHour: -1, endHour: 10 }, /sábado/],
    ['las horas no son en punto', { weekday: 2, startHour: 10.5, endHour: 14 }, /en punto/],
  ])('rechaza un rango inválido (%s) sin cambiar el horario', async (_name, day, message) => {
    await kit.call('PUT', url(), admin, { days: [{ weekday: 4, startHour: 9, endHour: 11 }] });
    const res = await kit.call('PUT', url(), admin, { days: [day] });
    expect(res.statusCode).toBe(400);
    expect(kit.body(res).error.code).toBe('validation_error');
    expect(kit.body(res).error.message).toMatch(message);
    expect(kit.body(await kit.call('GET', url(), admin)).days).toEqual([{ weekday: 4, startHour: 9, endHour: 11 }]);
  });

  it('rechaza un día repetido y un día que no existe', async () => {
    const twice = await kit.call('PUT', url(), admin, { days: [{ weekday: 1, startHour: 9, endHour: 11 }, { weekday: 1, startHour: 12, endHour: 14 }] });
    expect(twice.statusCode).toBe(400);
    expect(kit.body(twice).error.message).toMatch(/repetido/);
    const nonexistent = await kit.call('PUT', url(), admin, { days: [{ weekday: 8, startHour: 9, endHour: 11 }] });
    expect(nonexistent.statusCode).toBe(400);
  });

  it('cambiar el horario no toca las reservas ya hechas', async () => {
    await kit.call('PUT', url(), admin, { days: WEEK });
    await env.db.query(
      `INSERT INTO bookings (id, court_id, starts_at, price, name, email, created_ip)
       VALUES ('b1', $1, '2030-01-07T20:00:00-03:00', 30000, 'Ana', 'ana@mail.example', '1.1.1.1')`,
      [court],
    );
    await kit.call('PUT', url(), admin, { days: [] });
    const [row] = await env.db.query<{ n: string }>(`SELECT count(*) AS n FROM bookings WHERE court_id = $1`, [court]);
    expect(row!.n).toBe('1');
  });

  it('un admin no ve ni cambia el horario de una cancha de otro club ni de una borrada', async () => {
    const otherClub = await kit.createClub('test-horarios-otro');
    const otherCourt = await kit.createCourt(otherClub, 'Ajena');
    expect((await kit.call('GET', url(otherCourt), admin)).statusCode).toBe(404);
    expect((await kit.call('PUT', url(otherCourt), admin, { days: WEEK })).statusCode).toBe(404);
    expect((await env.db.query(`SELECT 1 FROM court_schedules WHERE court_id = $1`, [otherCourt]))).toHaveLength(0);

    await env.db.query(`UPDATE courts SET deleted_at = now() WHERE id = $1`, [court]);
    expect((await kit.call('GET', url(), admin)).statusCode).toBe(404);
    expect((await kit.call('PUT', url(), admin, { days: WEEK })).statusCode).toBe(404);
  });

  it('sin sesión es 401 y un jugador es 403, y no cambian nada', async () => {
    const player = await kit.loginPlayer();
    for (const method of ['GET', 'PUT'] as const) {
      expect((await kit.call(method, url(), undefined, { days: WEEK })).statusCode).toBe(401);
      expect((await kit.call(method, url(), player, { days: WEEK })).statusCode).toBe(403);
      expect((await kit.call(method, platformUrl(), undefined, { days: WEEK })).statusCode).toBe(401);
      expect((await kit.call(method, platformUrl(), player, { days: WEEK })).statusCode).toBe(403);
      expect((await kit.call(method, platformUrl(), admin, { days: WEEK })).statusCode).toBe(403);
    }
    expect(await env.db.query(`SELECT 1 FROM court_schedules WHERE court_id = $1`, [court])).toHaveLength(0);
  });

  it('el superadmin edita el horario de cualquier club, con las mismas reglas', async () => {
    const put = await kit.call('PUT', platformUrl(), sa, { days: WEEK });
    expect(put.statusCode).toBe(200);
    expect(kit.body(await kit.call('GET', platformUrl(), sa)).days).toEqual(WEEK);
    expect(kit.body(await kit.call('GET', url(), admin)).days).toEqual(WEEK);

    const bad = await kit.call('PUT', platformUrl(), sa, { days: [{ weekday: 1, startHour: 9, endHour: 9 }] });
    expect(bad.statusCode).toBe(400);

    const otherClub = await kit.createClub('test-horarios-otro');
    expect((await kit.call('GET', platformUrl(court, otherClub), sa)).statusCode).toBe(404); // cancha de otro club
    expect((await kit.call('GET', platformUrl(court, 'no-existe'), sa)).statusCode).toBe(404);
  });
});
