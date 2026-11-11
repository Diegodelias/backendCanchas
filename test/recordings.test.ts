import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bookingTestKit } from './booking-helpers.js';
import { createDbTestEnv, type DbTestEnv } from './helpers.js';

interface Rec {
  id: string;
  startsAt: string;
  date: string;
  time: string;
  status: string;
  videoUrl: string | null;
  club: { id: string };
  court: { id: string; name: string };
  durationSeconds: number;
}

describe('grabaciones: lectura', () => {
  let env: DbTestEnv;
  let kit: ReturnType<typeof bookingTestKit>;
  let club: string;
  let court: string;
  let court2: string;
  let seq = 0;

  beforeAll(async () => {
    env = await createDbTestEnv();
    kit = bookingTestKit(env);
  });
  afterAll(async () => {
    await env?.close();
  });
  beforeEach(async () => {
    await env.reset();
    seq = 0;
    club = await kit.createClub('test-grabaciones');
    court = await kit.createCourt(club, 'Cancha 1');
    court2 = await kit.createCourt(club, 'Cancha 2');
  });

  async function addRecording(
    courtId: string,
    startsAt: string,
    status = 'available',
    file: string | null = status === 'available' ? 'demo-partido.mp4' : null,
    id = `test-rec-${++seq}`,
  ) {
    await env.db.query(
      `INSERT INTO recordings (id, court_id, starts_at, status, video_file, duration_seconds) VALUES ($1, $2, $3, $4, $5, 60)`,
      [id, courtId, startsAt, status, file],
    );
    return id;
  }
  const list = async (query = '') => {
    const res = await kit.call('GET', `/api/recordings${query}`);
    return { res, items: res.statusCode === 200 ? (kit.body(res).recordings as Rec[]) : [] };
  };

  describe('GET /api/recordings', () => {
    it('devuelve las reproducibles con club, cancha, fecha y hora de Argentina, de la más reciente a la más antigua', async () => {
      const a = await addRecording(court, '2026-03-01T17:30:00-03:00');
      const b = await addRecording(court, '2026-03-02T19:00:00-03:00');
      const { res, items } = await list();
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(items.map((r) => r.id)).toEqual([b, a]);
      expect(items[1]).toMatchObject({
        id: a,
        club: { id: club, name: `Club ${club}` },
        court: { id: court, name: 'Cancha 1' },
        startsAt: '2026-03-01T20:30:00.000Z',
        date: '2026-03-01',
        time: '17:30',
        status: 'available',
        durationSeconds: 60,
        videoUrl: '/api/videos/demo-partido.mp4',
      });
    });

    it('solo incluye las disponibles: ni en proceso, ni sin cámara, ni con error', async () => {
      const ok = await addRecording(court, '2026-03-01T17:00:00-03:00');
      await addRecording(court, '2026-03-01T18:00:00-03:00', 'processing');
      await addRecording(court, '2026-03-01T19:00:00-03:00', 'unavailable');
      await addRecording(court, '2026-03-01T20:00:00-03:00', 'error');
      expect((await list()).items.map((r) => r.id)).toEqual([ok]);
    });

    it('filtra por club, cancha y fecha (día de Argentina, no de UTC)', async () => {
      const otherClub = await kit.createClub('test-grabaciones-otro');
      const otherCourt = await kit.createCourt(otherClub, 'Ajena');
      const a = await addRecording(court, '2026-03-01T23:30:00-03:00'); // ya es 2 de marzo en UTC
      const b = await addRecording(court2, '2026-03-02T10:00:00-03:00');
      const c = await addRecording(otherCourt, '2026-03-01T12:00:00-03:00');

      expect((await list(`?clubId=${club}`)).items.map((r) => r.id).sort()).toEqual([a, b].sort());
      expect((await list(`?courtId=${court2}`)).items.map((r) => r.id)).toEqual([b]);
      expect((await list(`?clubId=${club}&date=2026-03-01`)).items.map((r) => r.id)).toEqual([a]);
      expect((await list('?date=2026-03-01')).items.map((r) => r.id).sort()).toEqual([a, c].sort());
      expect((await list(`?clubId=${club}&courtId=${court}&date=2026-03-02`)).items).toEqual([]);
    });

    it('sin grabaciones devuelve una lista vacía', async () => {
      const { res, items } = await list(`?clubId=${club}`);
      expect(res.statusCode).toBe(200);
      expect(items).toEqual([]);
    });

    it('rechaza una fecha inválida', async () => {
      for (const date of ['hoy', '2026-02-30', '01-03-2026', '']) {
        const res = await kit.call('GET', `/api/recordings?date=${date}`);
        expect(res.statusCode, date).toBe(400);
        expect(kit.body(res).error.code).toBe('validation_error');
      }
    });

    it('no incluye las de un club desactivado ni las de una cancha borrada, pero sí las de una cancha desactivada', async () => {
      const visible = await addRecording(court, '2026-03-01T17:00:00-03:00');
      await addRecording(court2, '2026-03-01T18:00:00-03:00');
      await env.db.query(`UPDATE courts SET deleted_at = now() WHERE id = $1`, [court2]);
      expect((await list()).items.map((r) => r.id)).toEqual([visible]);

      await env.db.query(`UPDATE courts SET active = false WHERE id = $1`, [court]);
      expect((await list()).items.map((r) => r.id)).toEqual([visible]); // desactivada: el historial sigue

      await env.db.query(`UPDATE clubs SET active = false WHERE id = $1`, [club]);
      expect((await list()).items).toEqual([]);
    });
  });

  describe('GET /api/recordings/:id', () => {
    it('devuelve una disponible con su video', async () => {
      const id = await addRecording(court, '2026-03-01T17:30:00-03:00');
      const res = await kit.call('GET', `/api/recordings/${id}`);
      expect(res.statusCode).toBe(200);
      expect(kit.body(res).recording).toMatchObject({ id, status: 'available', videoUrl: '/api/videos/demo-partido.mp4', time: '17:30' });
    });

    it.each(['processing', 'unavailable', 'error'])('devuelve una grabación %s sin dirección de video', async (status) => {
      const id = await addRecording(court, '2026-03-01T17:00:00-03:00', status);
      const res = await kit.call('GET', `/api/recordings/${id}`);
      expect(res.statusCode).toBe(200);
      expect(kit.body(res).recording).toMatchObject({ id, status, videoUrl: null });
    });

    it('responde 404 si no existe, el club está desactivado o la cancha está borrada', async () => {
      expect((await kit.call('GET', '/api/recordings/no-existe')).statusCode).toBe(404);
      const id = await addRecording(court, '2026-03-01T17:00:00-03:00');
      await env.db.query(`UPDATE courts SET deleted_at = now() WHERE id = $1`, [court]);
      expect((await kit.call('GET', `/api/recordings/${id}`)).statusCode).toBe(404);
      await env.db.query(`UPDATE courts SET deleted_at = NULL WHERE id = $1`, [court]);
      await env.db.query(`UPDATE clubs SET active = false WHERE id = $1`, [club]);
      expect((await kit.call('GET', `/api/recordings/${id}`)).statusCode).toBe(404);
    });
  });

  describe('GET /api/club/recordings', () => {
    it('el admin ve todas las de su club en cualquier estado, y no las de otro club', async () => {
      const a = await addRecording(court, '2026-03-01T17:00:00-03:00');
      const b = await addRecording(court2, '2026-03-02T18:00:00-03:00', 'processing');
      const otherClub = await kit.createClub('test-grabaciones-otro');
      const otherCourt = await kit.createCourt(otherClub, 'Ajena');
      await addRecording(otherCourt, '2026-03-01T12:00:00-03:00');

      const admin = await kit.loginAdmin(club);
      const res = await kit.call('GET', '/api/club/recordings', admin);
      expect(res.statusCode).toBe(200);
      expect((kit.body(res).recordings as Rec[]).map((r) => [r.id, r.status])).toEqual([
        [b, 'processing'],
        [a, 'available'],
      ]);
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('el admin no ve las grabaciones de demostración de su club, pero el público sí las sigue viendo', async () => {
      const real = await addRecording(court, '2026-03-01T17:00:00-03:00');
      const demo = await addRecording(court, '2026-03-02T17:00:00-03:00');
      const demoNoVideo = await addRecording(court2, '2026-03-03T18:00:00-03:00', 'processing');
      await env.db.query(`UPDATE recordings SET is_demo = true WHERE id = ANY($1::text[])`, [[demo, demoNoVideo]]);

      const admin = await kit.loginAdmin(club);
      const res = await kit.call('GET', '/api/club/recordings', admin);
      const recordings = kit.body(res).recordings as Rec[];
      expect(recordings.map((r) => r.id)).toEqual([real]);
      expect(recordings[0]).not.toHaveProperty('is_demo');
      expect(recordings[0]).not.toHaveProperty('isDemo');

      // El resto del sitio no cambia: la lista pública y la consulta por identificador siguen incluyendo la de demostración.
      expect((await list()).items.map((r) => r.id)).toEqual([demo, real]);
      expect((await kit.call('GET', `/api/recordings/${demo}`)).statusCode).toBe(200);
    });

    it('un club con solo grabaciones de demostración devuelve la lista vacía', async () => {
      const demo = await addRecording(court, '2026-03-02T17:00:00-03:00');
      await env.db.query(`UPDATE recordings SET is_demo = true WHERE id = $1`, [demo]);
      const admin = await kit.loginAdmin(club);
      expect(kit.body(await kit.call('GET', '/api/club/recordings', admin))).toEqual({ recordings: [] });
    });

    it('un club sin grabaciones devuelve la lista vacía', async () => {
      const admin = await kit.loginAdmin(club);
      expect(kit.body(await kit.call('GET', '/api/club/recordings', admin))).toEqual({ recordings: [] });
    });

    it('sin sesión es 401 y un jugador o un superadmin es 403', async () => {
      const player = await kit.loginPlayer();
      const sa = await kit.loginSuperadmin();
      expect((await kit.call('GET', '/api/club/recordings')).statusCode).toBe(401);
      expect((await kit.call('GET', '/api/club/recordings', player)).statusCode).toBe(403);
      expect((await kit.call('GET', '/api/club/recordings', sa)).statusCode).toBe(403);
    });
  });
});
