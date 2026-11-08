import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bookingTestKit } from './booking-helpers.js';
import { createDbTestEnv, type DbTestEnv } from './helpers.js';
import { MAX_BOOKINGS_PER_IP } from '../src/modules/bookings/bookings.js';

// El reloj de los tests arranca el lunes 2026-03-02 a las 09:00 de Argentina.
// Los turnos de los tests son del martes 2026-03-03; las 17:00 de Argentina son las 20:00 UTC.
const at = (hour: number, day = '2026-03-03') => `${day}T${String(hour).padStart(2, '0')}:00:00-03:00`;
const GUEST = { name: 'Ana Pérez', email: 'ana@mail.example' };

describe('reservas de turnos', () => {
  let env: DbTestEnv;
  let kit: ReturnType<typeof bookingTestKit>;
  let club: string;
  let court: string;
  const logs: string[] = [];

  beforeAll(async () => {
    env = await createDbTestEnv({}, { write: (line) => void logs.push(line) });
    kit = bookingTestKit(env);
  });
  afterAll(async () => {
    await env?.close();
  });
  beforeEach(async () => {
    await env.reset();
    logs.length = 0;
    club = await kit.createClub('test-reservas-api');
    court = await kit.createCourt(club, 'Cancha 1', { price: 31000 });
    await kit.setSchedule(court, [{ weekday: 2, startHour: 16, endHour: 19 }]);
  });

  const book = (startsAt: string, payload: object = GUEST, cookie?: string, c = court, ip?: string) =>
    kit.call('POST', `/api/courts/${c}/bookings`, cookie, { startsAt, ...payload }, ip);
  const rows = () => env.db.query<Record<string, unknown>>(`SELECT * FROM bookings WHERE court_id = $1 ORDER BY starts_at`, [court]);
  const freeTimes = async () =>
    (kit.body(await kit.call('GET', `/api/courts/${court}/slots?date=2026-03-03`)).slots as { time: string }[]).map((s) => s.time);

  describe('un invitado reserva', () => {
    it('crea la reserva, ocupa el turno, confirma los datos y manda el mail', async () => {
      const res = await book(at(17), { ...GUEST, phone: ' 11 5555-1234 ' });
      expect(res.statusCode).toBe(201);
      expect(kit.body(res)).toMatchObject({
        emailSent: true,
        booking: {
          club: { id: club, name: `Club ${club}` },
          court: { id: court, name: 'Cancha 1' },
          startsAt: '2026-03-03T20:00:00.000Z',
          date: '2026-03-03',
          time: '17:00',
          price: 31000,
          name: 'Ana Pérez',
          email: 'ana@mail.example',
        },
      });
      expect(await freeTimes()).toEqual(['16:00', '18:00']);

      const [row] = await rows();
      expect(row).toMatchObject({ player_id: null, name: 'Ana Pérez', email: 'ana@mail.example', phone: '11 5555-1234', price: 31000 });

      expect(env.mailer.sent).toHaveLength(1);
      const mail = env.mailer.sent[0]!;
      expect(mail.to).toBe('ana@mail.example');
      expect(mail.subject).toContain(`Club ${club}`);
      for (const part of ['Cancha 1', '17:00', '31.000', 'martes']) expect(mail.text).toContain(part);
    });

    it('el precio queda como era al reservar aunque la cancha cambie', async () => {
      await book(at(17));
      await env.db.query(`UPDATE courts SET price = 99000 WHERE id = $1`, [court]);
      const [row] = await rows();
      expect(row!.price).toBe(31000);
    });

    it('el teléfono es opcional', async () => {
      expect((await book(at(17), GUEST)).statusCode).toBe(201);
      expect((await rows())[0]!.phone).toBeNull();
    });

    it.each([
      ['sin nombre', { email: 'ana@mail.example' }],
      ['nombre vacío', { name: '   ', email: 'ana@mail.example' }],
      ['sin mail', { name: 'Ana' }],
      ['mail inválido', { name: 'Ana', email: 'no-es-un-mail' }],
      ['teléfono demasiado corto', { name: 'Ana', email: 'ana@mail.example', phone: '123' }],
    ])('rechaza datos inválidos (%s) y no crea nada', async (_name, payload) => {
      const res = await book(at(17), payload);
      expect(res.statusCode).toBe(400);
      expect(kit.body(res).error.code).toBe('validation_error');
      expect(await rows()).toHaveLength(0);
      expect(env.mailer.sent).toHaveLength(0);
    });

    it('rechaza un turno que no es un instante válido', async () => {
      for (const startsAt of ['mañana', '', '2026-03-03']) {
        expect((await book(startsAt)).statusCode).toBe(400);
      }
      expect((await kit.call('POST', `/api/courts/${court}/bookings`, undefined, GUEST)).statusCode).toBe(400);
      expect(await rows()).toHaveLength(0);
    });
  });

  describe('un jugador con sesión reserva', () => {
    it('queda asociada a su cuenta y toma su mail sin pedir datos', async () => {
      const player = await kit.loginPlayer('jugadora@mail.example');
      const res = await kit.call('POST', `/api/courts/${court}/bookings`, player, { startsAt: at(18), name: 'Otro', email: 'otro@mail.example' });
      expect(res.statusCode).toBe(201);
      expect(kit.body(res).booking).toMatchObject({ email: 'jugadora@mail.example', name: 'jugadora' });
      const [row] = await rows();
      const [user] = await env.db.query<{ id: string }>(`SELECT id FROM users WHERE email = 'jugadora@mail.example'`);
      expect(row).toMatchObject({ player_id: user!.id, email: 'jugadora@mail.example' });
      expect(env.mailer.sent.map((m) => m.to)).toEqual(['jugadora@mail.example']);
    });

    it('usa el nombre de su cuenta si lo tiene', async () => {
      const player = await kit.loginPlayer('jugadora@mail.example');
      await env.db.query(`UPDATE users SET name = 'Laura Gómez' WHERE email = 'jugadora@mail.example'`);
      const res = await kit.call('POST', `/api/courts/${court}/bookings`, player, { startsAt: at(18) });
      expect(kit.body(res).booking.name).toBe('Laura Gómez');
    });

    it('una sesión de admin no cuenta como jugador: reserva como invitado y necesita sus datos', async () => {
      const admin = await kit.loginAdmin(club);
      const res = await kit.call('POST', `/api/courts/${court}/bookings`, admin, { startsAt: at(18) });
      expect(res.statusCode).toBe(400);
      const ok = await kit.call('POST', `/api/courts/${court}/bookings`, admin, { startsAt: at(18), ...GUEST });
      expect(ok.statusCode).toBe(201);
      expect((await rows())[0]!.player_id).toBeNull();
    });
  });

  describe('qué turnos se aceptan', () => {
    it('rechaza un turno fuera del horario, a media hora, de un día cerrado, pasado o más allá de 14 días', async () => {
      const cases: [string, string][] = [
        ['fuera del horario (las 20)', at(20)],
        ['antes de abrir (las 15)', at(15)],
        ['justo al cierre (las 19)', at(19)],
        ['a media hora', '2026-03-03T17:30:00-03:00'],
        ['un día cerrado (miércoles)', at(17, '2026-03-04')],
        ['pasado', at(17, '2026-03-01')],
        ['más allá de los 14 días', at(17, '2026-03-24')],
      ];
      for (const [label, startsAt] of cases) {
        const res = await book(startsAt);
        expect(res.statusCode, label).toBe(400);
        expect(kit.body(res).error.code, label).toBe('validation_error');
      }
      expect(await rows()).toHaveLength(0);
    });

    it('rechaza el turno que empieza en menos de 1 hora y acepta el que cumple justo la hora', async () => {
      await kit.setSchedule(court, [{ weekday: 1, startHour: 16, endHour: 21 }]);
      env.clock.current = new Date('2026-03-02T20:30:00Z'); // 17:30 en Argentina
      expect((await book(at(18, '2026-03-02'))).statusCode).toBe(400);
      env.clock.current = new Date('2026-03-02T20:00:00Z'); // 17:00
      expect((await book(at(18, '2026-03-02'))).statusCode).toBe(201);
    });

    it('acepta el turno de hoy + 14 días', async () => {
      await kit.setSchedule(court, [{ weekday: 1, startHour: 16, endHour: 21 }]); // el 2026-03-16 es lunes
      expect((await book(at(17, '2026-03-16'))).statusCode).toBe(201);
    });
  });

  it.each([
    ['desactivada', `UPDATE courts SET active = false WHERE id = $1`],
    ['borrada', `UPDATE courts SET deleted_at = now() WHERE id = $1`],
    ['sin horarios', `DELETE FROM court_schedules WHERE court_id = $1`],
  ])('una cancha %s no se puede reservar', async (_name, sql) => {
    await env.db.query(sql, [court]);
    const res = await book(at(17));
    expect(res.statusCode).toBe(404);
    expect(await rows()).toHaveLength(0);
    expect(env.mailer.sent).toHaveLength(0);
  });

  it('una cancha de un club desactivado, o inexistente, no se puede reservar', async () => {
    expect((await book(at(17), GUEST, undefined, 'no-existe')).statusCode).toBe(404);
    await env.db.query(`UPDATE clubs SET active = false WHERE id = $1`, [club]);
    expect((await book(at(17))).statusCode).toBe(404);
    expect(await rows()).toHaveLength(0);
  });

  describe('doble reserva', () => {
    it('un turno ya tomado responde conflicto y no crea nada ni manda mail', async () => {
      expect((await book(at(17))).statusCode).toBe(201);
      env.mailer.sent.length = 0;
      const second = await book(at(17), { name: 'Beto', email: 'beto@mail.example' });
      expect(second.statusCode).toBe(409);
      expect(kit.body(second).error).toMatchObject({ code: 'slot_taken' });
      expect(kit.body(second).error.message).toMatch(/ya fue tomado/);
      expect(await rows()).toHaveLength(1);
      expect(env.mailer.sent).toHaveLength(0);
    });

    it('dos reservas simultáneas del mismo turno: una gana y la otra recibe el aviso', async () => {
      const results = await Promise.all([
        book(at(17), { name: 'Ana', email: 'ana@mail.example' }),
        book(at(17), { name: 'Beto', email: 'beto@mail.example' }),
        book(at(17), { name: 'Carla', email: 'carla@mail.example' }),
      ]);
      expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409, 409]);
      expect(await rows()).toHaveLength(1);
      expect(env.mailer.sent).toHaveLength(1);
    });

    it('el mismo horario de otra cancha sí se puede reservar', async () => {
      const other = await kit.createCourt(club, 'Cancha 2');
      await kit.setSchedule(other, [{ weekday: 2, startHour: 16, endHour: 19 }]);
      expect((await book(at(17))).statusCode).toBe(201);
      expect((await book(at(17), GUEST, undefined, other)).statusCode).toBe(201);
    });
  });

  describe('mail de confirmación', () => {
    it('si el mail falla, la reserva queda guardada, se avisa y se registra sin datos personales', async () => {
      env.mailer.failWith = new Error('SMTP caído');
      const res = await book(at(17));
      expect(res.statusCode).toBe(201);
      expect(kit.body(res).emailSent).toBe(false);
      expect(env.mailer.attempts).toBe(1); // la confirmación se espera en la respuesta: no se reintenta
      expect(await rows()).toHaveLength(1);
      expect(await freeTimes()).toEqual(['16:00', '18:00']);

      const line = logs.find((l) => l.includes('No se pudo enviar el mail de la reserva'));
      expect(line).toBeDefined();
      expect(line).toContain((kit.body(res).booking as { id: string }).id);
      expect(logs.join('\n')).not.toContain('ana@mail.example');
    });
  });

  describe('límite por IP', () => {
    const slotHours = Array.from({ length: 24 }, (_, i) => i);

    beforeEach(async () => {
      await env.db.query(`DELETE FROM court_schedules WHERE court_id = $1`, [court]);
      await kit.setSchedule(court, [{ weekday: 2, startHour: 0, endHour: 24 }]);
    });

    it('rechaza la reserva número 11 de una IP en 15 minutos, sin afectar a otra IP, y se libera con el tiempo', async () => {
      for (const hour of slotHours.slice(0, MAX_BOOKINGS_PER_IP)) {
        expect((await book(at(hour), GUEST, undefined, court, '8.8.8.8')).statusCode).toBe(201);
      }
      const blocked = await book(at(12), GUEST, undefined, court, '8.8.8.8');
      expect(blocked.statusCode).toBe(429);
      expect(kit.body(blocked).error.code).toBe('too_many_bookings');
      expect(await rows()).toHaveLength(MAX_BOOKINGS_PER_IP);

      expect((await book(at(12), GUEST, undefined, court, '7.7.7.7')).statusCode).toBe(201); // otra IP

      env.clock.advance(16 * 60 * 1000);
      expect((await book(at(13), GUEST, undefined, court, '8.8.8.8')).statusCode).toBe(201);
    });

    it('también vale para los jugadores con sesión', async () => {
      const player = await kit.loginPlayer();
      for (const hour of slotHours.slice(0, MAX_BOOKINGS_PER_IP)) {
        expect((await kit.call('POST', `/api/courts/${court}/bookings`, player, { startsAt: at(hour) }, '8.8.4.4')).statusCode).toBe(201);
      }
      const blocked = await kit.call('POST', `/api/courts/${court}/bookings`, player, { startsAt: at(12) }, '8.8.4.4');
      expect(blocked.statusCode).toBe(429);
    });

    it('un pedido inválido no cuenta para el límite', async () => {
      for (let i = 0; i < MAX_BOOKINGS_PER_IP + 2; i++) {
        expect((await book(at(1), { name: '' }, undefined, court, '6.6.6.6')).statusCode).toBe(400);
      }
      expect((await book(at(1), GUEST, undefined, court, '6.6.6.6')).statusCode).toBe(201);
    });
  });

  describe('lista de reservas del club', () => {
    beforeEach(async () => {
      await kit.setSchedule(court, [{ weekday: 3, startHour: 10, endHour: 12 }]);
    });

    it('el admin ve las de su club, de la más lejana a la más cercana, y no las de otro club', async () => {
      await book(at(17));
      await book(at(10, '2026-03-04'), { name: 'Beto', email: 'beto@mail.example', phone: '11 4444-0000' });
      const otherClub = await kit.createClub('test-reservas-otro');
      const otherCourt = await kit.createCourt(otherClub, 'Ajena');
      await kit.setSchedule(otherCourt, [{ weekday: 2, startHour: 16, endHour: 19 }]);
      await book(at(16), GUEST, undefined, otherCourt);

      const admin = await kit.loginAdmin(club);
      const res = await kit.call('GET', '/api/club/bookings', admin);
      expect(res.statusCode).toBe(200);
      const list = kit.body(res).bookings as { date: string; time: string; name: string; email: string; court: { name: string }; phone: string | null }[];
      expect(list.map((b) => `${b.date} ${b.time}`)).toEqual(['2026-03-04 10:00', '2026-03-03 17:00']);
      expect(list[0]).toMatchObject({ name: 'Beto', email: 'beto@mail.example', phone: '11 4444-0000', court: { name: 'Cancha 1' }, fromPlayer: false });
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('un club sin reservas devuelve la lista vacía', async () => {
      const admin = await kit.loginAdmin(club);
      expect(kit.body(await kit.call('GET', '/api/club/bookings', admin))).toEqual({ bookings: [] });
    });

    it('sin sesión es 401 y un jugador o un superadmin es 403 en la ruta del club', async () => {
      const player = await kit.loginPlayer();
      const sa = await kit.loginSuperadmin();
      expect((await kit.call('GET', '/api/club/bookings')).statusCode).toBe(401);
      expect((await kit.call('GET', '/api/club/bookings', player)).statusCode).toBe(403);
      expect((await kit.call('GET', '/api/club/bookings', sa)).statusCode).toBe(403);
    });

    it('el superadmin ve las de cualquier club y los demás roles no', async () => {
      await book(at(17));
      const sa = await kit.loginSuperadmin();
      const admin = await kit.loginAdmin(club);
      const player = await kit.loginPlayer();
      const url = `/api/platform/clubs/${club}/bookings`;

      const res = await kit.call('GET', url, sa);
      expect(res.statusCode).toBe(200);
      expect(kit.body(res).club).toMatchObject({ id: club });
      expect(kit.body(res).bookings).toHaveLength(1);

      expect((await kit.call('GET', url)).statusCode).toBe(401);
      expect((await kit.call('GET', url, player)).statusCode).toBe(403);
      expect((await kit.call('GET', url, admin)).statusCode).toBe(403);
      expect((await kit.call('GET', '/api/platform/clubs/no-existe/bookings', sa)).statusCode).toBe(404);
    });
  });
});
