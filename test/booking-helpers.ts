import type { LightMyRequestResponse } from 'fastify';
import { createAdmin, createSuperadmin } from '../src/modules/auth/admins.js';
import { SESSION_COOKIE } from '../src/modules/auth/sessions.js';
import { waitFor, type DbTestEnv } from './helpers.js';

export const PASSWORD = 'clave-de-prueba-123';
export const SUPER = { email: 'root@canchas3.example', name: 'Root', password: 'clave-de-super-123' };

/** Ayudas compartidas por los tests de horarios, turnos y reservas: clubes, canchas y sesiones de prueba. */
export function bookingTestKit(env: DbTestEnv) {
  const body = (res: LightMyRequestResponse) => res.json();

  const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, cookie?: string, payload?: object, ip?: string) =>
    env.app.inject({
      method,
      url,
      cookies: cookie ? { [SESSION_COOKIE]: cookie } : {},
      ...(payload ? { payload } : {}),
      ...(ip ? { remoteAddress: ip } : {}),
    });

  async function createClub(id: string, active = true) {
    await env.db.query(
      `INSERT INTO clubs (id, name, zone, city, address, active) VALUES ($1, $2, 'Zona', 'buenos-aires', 'Calle 123', $3)`,
      [id, `Club ${id}`, active],
    );
    return id;
  }

  async function createCourt(clubId: string, name: string, opts: { active?: boolean; price?: number } = {}) {
    const rows = await env.db.query<{ id: string }>(
      `INSERT INTO courts (id, club_id, name, sport, price, active)
       VALUES (gen_random_uuid()::text, $1, $2, 'Fútbol 5', $3, $4) RETURNING id`,
      [clubId, name, opts.price ?? 30000, opts.active ?? true],
    );
    return rows[0]!.id;
  }

  /** Carga el horario directo en la base (lo que ya probaron los tests de horarios). */
  async function setSchedule(courtId: string, days: { weekday: number; startHour: number; endHour: number }[]) {
    for (const d of days) {
      await env.db.query(
        `INSERT INTO court_schedules (court_id, weekday, start_hour, end_hour) VALUES ($1, $2, $3, $4)`,
        [courtId, d.weekday, d.startHour, d.endHour],
      );
    }
  }

  async function loginSuperadmin(): Promise<string> {
    await createSuperadmin(env.db, SUPER);
    const res = await env.app.inject({ method: 'POST', url: '/api/auth/admin/login', payload: { email: SUPER.email, password: SUPER.password } });
    return res.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
  }

  async function loginAdmin(clubId: string): Promise<string> {
    const email = `admin@${clubId}.example`;
    await createAdmin(env.db, { email, name: 'Admin', clubId, password: PASSWORD });
    const res = await env.app.inject({ method: 'POST', url: '/api/auth/admin/login', payload: { email, password: PASSWORD } });
    return res.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
  }

  async function loginPlayer(email = 'jugador@mail.example'): Promise<string> {
    env.mailer.sent.length = 0;
    await env.app.inject({ method: 'POST', url: '/api/auth/player/request-link', payload: { email } });
    await waitFor(() => env.mailer.lastLinkTo(email) !== null);
    const token = new URL(env.mailer.lastLinkTo(email)!).searchParams.get('token')!;
    const res = await env.app.inject({ method: 'POST', url: '/api/auth/player/confirm', payload: { token } });
    env.mailer.sent.length = 0;
    return res.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
  }

  return { body, call, createClub, createCourt, setSchedule, loginSuperadmin, loginAdmin, loginPlayer };
}
