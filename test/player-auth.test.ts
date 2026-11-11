import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAdmin } from '../src/modules/auth/admins.js';
import { SESSION_COOKIE } from '../src/modules/auth/sessions.js';
import { createDbTestEnv, sleep, waitFor, type DbTestEnv } from './helpers.js';

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

const PLAYER = 'matias.rossi@mail.example';
const ADMIN = {
  email: 'ana@estacion-norte.example',
  name: 'Ana Pérez',
  clubId: 'estacion-norte',
  password: 'clave-de-prueba-123',
};

describe('ingreso del jugador por link', () => {
  let env: DbTestEnv;
  const logs: string[] = [];

  beforeAll(async () => {
    env = await createDbTestEnv({}, { write: (m) => void logs.push(m) });
  });
  afterAll(async () => {
    await env?.close();
  });
  beforeEach(async () => {
    await env.reset();
    logs.length = 0;
  });

  const requestLink = (email: string, ip = '203.0.113.10') =>
    env.app.inject({
      method: 'POST',
      url: '/api/auth/player/request-link',
      headers: { 'x-forwarded-for': ip },
      payload: { email },
    });

  const confirm = (token: string, cookie?: string) =>
    env.app.inject({
      method: 'POST',
      url: '/api/auth/player/confirm',
      cookies: cookie ? { [SESSION_COOKIE]: cookie } : {},
      payload: { token },
    });

  const me = (cookie?: string) =>
    env.app.inject({ method: 'GET', url: '/api/auth/me', cookies: cookie ? { [SESSION_COOKIE]: cookie } : {} });

  const sessionCookie = (res: LightMyRequestResponse) => res.cookies.find((c) => c.name === SESSION_COOKIE)?.value;

  /** Pide un link, espera el mail y devuelve el identificador del link. */
  async function issueToken(email: string): Promise<string> {
    const before = env.mailer.sent.length;
    expect((await requestLink(email)).statusCode).toBe(202);
    await waitFor(() => env.mailer.sent.length > before);
    const link = env.mailer.lastLinkTo(email)!;
    return new URL(link).searchParams.get('token')!;
  }

  /** Ingresa como jugador y devuelve la cookie. */
  async function loginPlayer(email = PLAYER): Promise<string> {
    return sessionCookie(await confirm(await issueToken(email)))!;
  }

  const count = async (table: string) => (await env.db.query(`SELECT 1 FROM ${table}`)).length;

  describe('pedir el link', () => {
    it('responde lo mismo para un jugador existente, un mail nuevo y un mail de admin', async () => {
      await loginPlayer('existente@mail.example');
      await createAdmin(env.db, ADMIN);
      env.mailer.sent.length = 0;

      const existing = await requestLink('existente@mail.example');
      const fresh = await requestLink('nuevo@mail.example');
      const admin = await requestLink(ADMIN.email);

      expect(existing.statusCode).toBe(202);
      expect(fresh.statusCode).toBe(202);
      expect(admin.statusCode).toBe(202);
      expect(fresh.json()).toEqual(existing.json());
      expect(admin.json()).toEqual(existing.json());
      expect(existing.json().message).toContain('15 minutos');
    });

    it('envía el mail a jugadores existentes y nuevos, con el link a /acceso', async () => {
      await requestLink(PLAYER);
      await waitFor(() => env.mailer.sent.length === 1);
      const mail = env.mailer.sent[0]!;
      expect(mail.to).toBe(PLAYER);
      expect(mail.subject).toBe('Tu acceso a Canchas3');
      expect(env.mailer.lastLinkTo(PLAYER)).toMatch(/^http:\/\/localhost:3000\/acceso\?token=[\w-]{20,}$/);
    });

    it('con el mail de un admin no envía nada ni crea cuentas ni links', async () => {
      await createAdmin(env.db, ADMIN);
      const usersBefore = await count('users');
      expect((await requestLink(ADMIN.email)).statusCode).toBe(202);
      await sleep(150);
      expect(env.mailer.sent).toHaveLength(0);
      expect(await count('login_tokens')).toBe(0);
      expect(await count('users')).toBe(usersBefore);
    });

    it('un pedido no crea la cuenta: se crea al confirmar', async () => {
      await requestLink('nuevo@mail.example');
      expect(await count('users')).toBe(0);
    });

    it('un mail con formato inválido responde 400 sin tocar nada', async () => {
      const res = await requestLink('no-es-un-mail');
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('validation_error');
      expect(await count('link_requests')).toBe(0);
      expect(env.mailer.sent).toHaveLength(0);
    });

    it('el 4.º pedido en 15 minutos responde 429 y no envía mail', async () => {
      for (let i = 0; i < 3; i++) expect((await requestLink(PLAYER)).statusCode).toBe(202);
      await waitFor(() => env.mailer.sent.length === 3);

      const res = await requestLink(PLAYER);
      expect(res.statusCode).toBe(429);
      expect(res.json().error.code).toBe('too_many_requests');
      await sleep(100);
      expect(env.mailer.sent).toHaveLength(3);
    });

    it('el tope vale también para un mail de admin, para no delatarlo', async () => {
      await createAdmin(env.db, ADMIN);
      for (let i = 0; i < 3; i++) expect((await requestLink(ADMIN.email)).statusCode).toBe(202);
      expect((await requestLink(ADMIN.email)).statusCode).toBe(429);
    });

    it('el tope es por mail, sin distinguir mayúsculas', async () => {
      for (let i = 0; i < 3; i++) await requestLink(PLAYER);
      expect((await requestLink(PLAYER.toUpperCase())).statusCode).toBe(429);
      expect((await requestLink('otro@mail.example')).statusCode).toBe(202);
    });

    it('pasados 15 minutos se puede volver a pedir', async () => {
      for (let i = 0; i < 3; i++) await requestLink(PLAYER);
      expect((await requestLink(PLAYER)).statusCode).toBe(429);
      env.clock.advance(15 * MINUTE + 1000);
      expect((await requestLink(PLAYER)).statusCode).toBe(202);
    });

    it('si el envío falla, responde igual y registra el error sin el link ni el mail', async () => {
      env.mailer.failWith = Object.assign(new Error(`rechazado: ${PLAYER}`), { code: 'EENVELOPE' });
      const res = await requestLink(PLAYER);
      expect(res.statusCode).toBe(202);
      await waitFor(() => logs.some((l) => l.includes('No se pudo enviar el mail de acceso')));
      const all = logs.join('\n');
      expect(all).toContain('EENVELOPE');
      expect(all).not.toContain(PLAYER);
      expect(all).not.toContain('/acceso?token=');
    });

    it('guarda solo el hash del link', async () => {
      const token = await issueToken(PLAYER);
      const rows = await env.db.query<{ token_hash: string }>('SELECT token_hash FROM login_tokens');
      expect(rows).toHaveLength(1);
      expect(rows[0]!.token_hash).not.toBe(token);
      expect(rows[0]!.token_hash).not.toContain(token);
    });
  });

  describe('confirmar el link', () => {
    it('el primer ingreso crea la cuenta sin nombre y abre la sesión', async () => {
      const res = await confirm(await issueToken(PLAYER));
      expect(res.statusCode).toBe(200);
      expect(res.json().user).toMatchObject({ email: PLAYER, name: null, role: 'player', clubId: null });
      const cookie = res.cookies.find((c) => c.name === SESSION_COOKIE)!;
      expect(cookie.httpOnly).toBe(true);
      expect(String(cookie.sameSite).toLowerCase()).toBe('lax');
      expect(await count('users')).toBe(1);
    });

    it('el mismo mail con otras mayúsculas usa la cuenta existente', async () => {
      await loginPlayer(PLAYER);
      const res = await confirm(await issueToken(PLAYER.toUpperCase()));
      expect(res.statusCode).toBe(200);
      expect(await count('users')).toBe(1);
    });

    it('un link ya usado responde 410 link_used y no abre sesión', async () => {
      const token = await issueToken(PLAYER);
      expect((await confirm(token)).statusCode).toBe(200);
      const again = await confirm(token);
      expect(again.statusCode).toBe(410);
      expect(again.json().error.code).toBe('link_used');
      expect(sessionCookie(again)).toBeUndefined();
    });

    it('un link vencido responde 410 link_expired y no abre sesión', async () => {
      const token = await issueToken(PLAYER);
      env.clock.advance(15 * MINUTE + 1000);
      const res = await confirm(token);
      expect(res.statusCode).toBe(410);
      expect(res.json().error.code).toBe('link_expired');
      expect(sessionCookie(res)).toBeUndefined();
      expect(await count('users')).toBe(0);
    });

    it('un link inexistente se informa igual que uno vencido', async () => {
      const token = await issueToken(PLAYER);
      env.clock.advance(16 * MINUTE);
      const expired = await confirm(token);
      const unknown = await confirm('identificador-que-no-existe');
      expect(unknown.statusCode).toBe(410);
      expect(unknown.json()).toEqual(expired.json());
    });

    it('sin identificador responde 400', async () => {
      const res = await env.app.inject({ method: 'POST', url: '/api/auth/player/confirm', payload: {} });
      expect(res.statusCode).toBe(400);
    });

    it('pedir un link nuevo no invalida el anterior', async () => {
      const first = await issueToken(PLAYER);
      const second = await issueToken(PLAYER);
      expect((await confirm(first)).statusCode).toBe(200);
      expect((await confirm(second)).statusCode).toBe(200);
    });

    it('dos confirmaciones simultáneas del mismo link abren una sola sesión', async () => {
      const token = await issueToken(PLAYER);
      const results = await Promise.all([confirm(token), confirm(token)]);
      expect(results.map((r) => r.statusCode).sort()).toEqual([200, 410]);
      expect(await count('sessions')).toBe(1);
      expect(await count('users')).toBe(1);
    });

    it('si el mail pasó a ser de un admin después de pedir el link, no abre sesión de jugador', async () => {
      const token = await issueToken('futuro-admin@club.example');
      await createAdmin(env.db, { ...ADMIN, email: 'futuro-admin@club.example' });
      const res = await confirm(token);
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('admin_account');
      expect(sessionCookie(res)).toBeUndefined();
      const users = await env.db.query<{ role: string }>('SELECT role FROM users');
      expect(users).toEqual([{ role: 'club_admin' }]);
      expect(await count('sessions')).toBe(0);
    });
  });

  describe('sesión del jugador', () => {
    it('me devuelve al jugador con su mail y sin nombre', async () => {
      const cookie = await loginPlayer();
      const res = await me(cookie);
      expect(res.statusCode).toBe(200);
      expect(res.json().user).toMatchObject({ email: PLAYER, name: null, role: 'player' });
    });

    it('vence a los 30 días sin uso', async () => {
      const cookie = await loginPlayer();
      env.clock.advance(30 * DAY + MINUTE);
      expect((await me(cookie)).json()).toEqual({ user: null });
    });

    it('se renueva con el uso', async () => {
      const cookie = await loginPlayer();
      for (let i = 0; i < 3; i++) {
        env.clock.advance(20 * DAY);
        expect((await me(cookie)).json().user).not.toBeNull();
      }
    });

    it('permite varias sesiones a la vez y cerrar una deja la otra abierta', async () => {
      const phone = await loginPlayer();
      const laptop = await loginPlayer();
      expect(phone).not.toBe(laptop);
      expect((await me(phone)).json().user).not.toBeNull();
      expect((await me(laptop)).json().user).not.toBeNull();

      const out = await env.app.inject({ method: 'POST', url: '/api/auth/logout', cookies: { [SESSION_COOKIE]: phone } });
      expect(out.statusCode).toBe(204);
      expect((await me(phone)).json()).toEqual({ user: null });
      expect((await me(laptop)).json().user).not.toBeNull();
    });

    it('confirmar un link en un navegador con otra sesión la cierra', async () => {
      await createAdmin(env.db, ADMIN);
      const adminLogin = await env.app.inject({
        method: 'POST',
        url: '/api/auth/admin/login',
        payload: { email: ADMIN.email, password: ADMIN.password },
      });
      const adminCookie = sessionCookie(adminLogin)!;

      const playerCookie = sessionCookie(await confirm(await issueToken(PLAYER), adminCookie))!;
      expect((await me(adminCookie)).json()).toEqual({ user: null });
      expect((await me(playerCookie)).json().user.role).toBe('player');
      expect(await count('sessions')).toBe(1);
    });

    it('el ingreso de un admin en un navegador con sesión de jugador la cierra', async () => {
      await createAdmin(env.db, ADMIN);
      const playerCookie = await loginPlayer();
      const adminLogin = await env.app.inject({
        method: 'POST',
        url: '/api/auth/admin/login',
        cookies: { [SESSION_COOKIE]: playerCookie },
        payload: { email: ADMIN.email, password: ADMIN.password },
      });
      expect(adminLogin.statusCode).toBe(200);
      expect((await me(playerCookie)).json()).toEqual({ user: null });
      expect((await me(sessionCookie(adminLogin))).json().user.role).toBe('club_admin');
      expect(await count('sessions')).toBe(1);
    });
  });
});
