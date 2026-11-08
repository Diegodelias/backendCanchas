import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAdmin, createSuperadmin } from '../src/modules/auth/admins.js';
import { createLoginToken } from '../src/modules/auth/links.js';
import { SESSION_COOKIE } from '../src/modules/auth/sessions.js';
import { createDbTestEnv, waitFor, type DbTestEnv } from './helpers.js';

const SUPER = { email: 'root@canchas3.example', name: 'Root', password: 'clave-de-super-123' };
const GUEST = 'ana@club.example';
const NEW_PASSWORD = 'contraseña-nueva-456';
const HOUR = 60 * 60 * 1000;

describe('invitaciones de admins: aceptar y entrar', () => {
  let env: DbTestEnv;
  let sa: string;

  beforeAll(async () => {
    env = await createDbTestEnv();
  });
  afterAll(async () => {
    await env?.close();
  });
  beforeEach(async () => {
    await env.reset();
    await createSuperadmin(env.db, SUPER);
    const res = await env.app.inject({ method: 'POST', url: '/api/auth/admin/login', payload: { email: SUPER.email, password: SUPER.password } });
    sa = res.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
    await env.db.query(`INSERT INTO clubs (id, name, zone, city, address) VALUES ('test-inv', 'Club Invitación', 'Zona', 'buenos-aires', 'Calle 123')`);
  });

  const body = (res: LightMyRequestResponse) => res.json();
  const post = (url: string, payload: object, cookie?: string) =>
    env.app.inject({ method: 'POST', url, cookies: cookie ? { [SESSION_COOKIE]: cookie } : {}, payload });
  const accept = (token: string, password: string, cookie?: string) => post('/api/auth/admin/accept-invite', { token, password }, cookie);
  const invitation = (token: string) => env.app.inject({ method: 'GET', url: `/api/auth/admin/invitation?token=${encodeURIComponent(token)}` });
  const me = (cookie: string) => env.app.inject({ method: 'GET', url: '/api/auth/me', cookies: { [SESSION_COOKIE]: cookie } });
  const sessionOf = (res: LightMyRequestResponse) => res.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
  const tokenFrom = (link: string) => new URL(link).searchParams.get('token')!;
  const user = async (email = GUEST) =>
    (await env.db.query<{ password_hash: string | null; deactivated_at: Date | null }>(
      `SELECT password_hash, deactivated_at FROM users WHERE lower(email) = lower($1)`, [email]))[0];

  /** Invita desde la plataforma y devuelve el identificador del link del mail. */
  async function invite(email = GUEST, name = 'Ana Pérez'): Promise<string> {
    const res = await post('/api/platform/clubs/test-inv/admins', { email, name }, sa);
    expect(res.statusCode).toBe(201);
    return tokenFrom(env.mailer.lastLinkTo(email)!);
  }

  describe('ver la invitación', () => {
    it('devuelve el nombre del club y del admin sin consumir el link', async () => {
      const token = await invite();
      for (let i = 0; i < 2; i++) {
        const res = await invitation(token);
        expect(res.statusCode).toBe(200);
        expect(body(res)).toEqual({ clubName: 'Club Invitación', adminName: 'Ana Pérez' });
      }
      expect((await accept(token, NEW_PASSWORD)).statusCode).toBe(200);
    });

    it('un link inexistente o vencido responde 410 con el mismo código', async () => {
      const token = await invite();
      const missing = await invitation('token-que-no-existe');
      expect(missing.statusCode).toBe(410);
      expect(body(missing).error.code).toBe('link_expired');

      env.clock.advance(73 * HOUR);
      const expired = await invitation(token);
      expect(expired.statusCode).toBe(410);
      expect(body(expired)).toEqual(body(missing));
    });

    it('un link usado responde 410 link_used, y uno de otro tipo como si no existiera', async () => {
      const token = await invite();
      await accept(token, NEW_PASSWORD);
      expect(body(await invitation(token)).error.code).toBe('link_used');

      const reset = await createLoginToken(env.db, 'password_reset', GUEST, env.clock.now());
      const access = await createLoginToken(env.db, 'access', GUEST, env.clock.now());
      expect(body(await invitation(reset)).error.code).toBe('link_expired');
      expect(body(await invitation(access)).error.code).toBe('link_expired');
    });

    it('sin el parámetro responde 400', async () => {
      const res = await env.app.inject({ method: 'GET', url: '/api/auth/admin/invitation' });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('elegir la contraseña', () => {
    it('guarda la contraseña con hash, deja la cuenta Activa, abre la sesión y marca el link como usado', async () => {
      const token = await invite();
      const res = await accept(token, NEW_PASSWORD);

      expect(res.statusCode).toBe(200);
      expect(body(res).user).toMatchObject({ email: GUEST, name: 'Ana Pérez', role: 'club_admin', clubId: 'test-inv' });
      const cookie = res.cookies.find((c) => c.name === SESSION_COOKIE)!;
      expect(cookie.httpOnly).toBe(true);
      expect(String(cookie.sameSite).toLowerCase()).toBe('lax');

      const row = await user();
      expect(row!.password_hash!.startsWith('$argon2id$')).toBe(true);
      expect(row!.password_hash).not.toContain(NEW_PASSWORD);
      expect(JSON.stringify(body(res))).not.toContain('password');
      expect((await me(cookie.value)).json().user).toMatchObject({ email: GUEST, role: 'club_admin', clubId: 'test-inv' });
      const [used] = await env.db.query<{ used_at: Date | null }>(`SELECT used_at FROM login_tokens WHERE purpose = 'admin_invite'`);
      expect(used!.used_at).not.toBeNull();
    });

    it('después puede ingresar con su contraseña y gestionar las canchas de su club', async () => {
      const token = await invite();
      const accepted = await accept(token, NEW_PASSWORD);
      const cookie = sessionOf(accepted)!;

      const courts = await env.app.inject({ method: 'GET', url: '/api/club/courts', cookies: { [SESSION_COOKIE]: cookie } });
      expect(courts.statusCode).toBe(200);
      expect(body(courts).club.id).toBe('test-inv');

      const login = await post('/api/auth/admin/login', { email: GUEST, password: NEW_PASSWORD });
      expect(login.statusCode).toBe(200);
      expect(body(login).user.clubId).toBe('test-inv');
    });

    it('una contraseña corta responde 400, no gasta el link y se puede reintentar', async () => {
      const token = await invite();
      const short = await accept(token, 'corta123');
      expect(short.statusCode).toBe(400);
      expect(body(short).error.code).toBe('validation_error');
      expect(sessionOf(short)).toBeUndefined();
      expect((await user())!.password_hash).toBeNull();
      expect((await invitation(token)).statusCode).toBe(200);

      expect((await accept(token, NEW_PASSWORD)).statusCode).toBe(200);
    });

    it('cierra la sesión que ya tenía ese navegador', async () => {
      const token = await invite();
      await env.app.inject({ method: 'POST', url: '/api/auth/player/request-link', payload: { email: 'jugador@mail.example' } });
      await waitFor(() => env.mailer.lastLinkTo('jugador@mail.example') !== null);
      const playerToken = tokenFrom(env.mailer.lastLinkTo('jugador@mail.example')!);
      const playerCookie = sessionOf(await post('/api/auth/player/confirm', { token: playerToken }))!;
      expect((await me(playerCookie)).json().user).not.toBeNull();

      const res = await accept(token, NEW_PASSWORD, playerCookie);
      expect(res.statusCode).toBe(200);
      expect((await me(playerCookie)).json()).toEqual({ user: null });
      expect((await me(sessionOf(res)!)).json().user.role).toBe('club_admin');
    });
  });

  describe('links que no sirven', () => {
    it('un link vencido (73 horas) se rechaza, no abre sesión y no registra contraseña', async () => {
      const token = await invite();
      env.clock.advance(73 * HOUR);
      const res = await accept(token, NEW_PASSWORD);
      expect(res.statusCode).toBe(410);
      expect(body(res).error.code).toBe('link_expired');
      expect(sessionOf(res)).toBeUndefined();
      expect((await user())!.password_hash).toBeNull();
    });

    it('a las 71 horas el link todavía sirve', async () => {
      const token = await invite();
      env.clock.advance(71 * HOUR);
      expect((await accept(token, NEW_PASSWORD)).statusCode).toBe(200);
    });

    it('un link ya usado se rechaza indicando que ya se usó, y no cambia la contraseña', async () => {
      const token = await invite();
      await accept(token, NEW_PASSWORD);
      const hashBefore = (await user())!.password_hash;

      const again = await accept(token, 'otra-contraseña-789');
      expect(again.statusCode).toBe(410);
      expect(body(again).error.code).toBe('link_used');
      expect((await user())!.password_hash).toBe(hashBefore);
    });

    it('un link inexistente se informa igual que uno vencido', async () => {
      const res = await accept('token-inventado', NEW_PASSWORD);
      expect(res.statusCode).toBe(410);
      expect(body(res).error.code).toBe('link_expired');
    });

    it('un link de recuperación o de acceso no sirve para aceptar, y no se consume', async () => {
      await invite();
      const reset = await createLoginToken(env.db, 'password_reset', GUEST, env.clock.now());
      const access = await createLoginToken(env.db, 'access', GUEST, env.clock.now());
      for (const token of [reset, access]) {
        const res = await accept(token, NEW_PASSWORD);
        expect(res.statusCode).toBe(410);
        expect(sessionOf(res)).toBeUndefined();
      }
      expect((await user())!.password_hash).toBeNull();
      // Siguen sirviendo para lo suyo.
      expect((await post('/api/auth/admin/reset-password', { token: reset, password: NEW_PASSWORD })).statusCode).toBe(204);
    });

    it('un link de invitación no sirve para recuperar ni para entrar como jugador', async () => {
      const token = await invite();
      expect((await post('/api/auth/admin/reset-password', { token, password: NEW_PASSWORD })).statusCode).toBe(410);
      expect((await post('/api/auth/player/confirm', { token })).statusCode).toBe(410);
      expect((await accept(token, NEW_PASSWORD)).statusCode).toBe(200);
    });

    it('si dieron de baja al admin antes de aceptar, el link se rechaza como vencido y no abre sesión', async () => {
      const token = await invite();
      await env.db.query(`UPDATE users SET deactivated_at = now() WHERE email = $1`, [GUEST]);

      const res = await accept(token, NEW_PASSWORD);
      expect(res.statusCode).toBe(410);
      expect(body(res).error.code).toBe('link_expired');
      expect(sessionOf(res)).toBeUndefined();
      expect((await user())!.password_hash).toBeNull();
      expect((await invitation(token)).statusCode).toBe(410);
    });

    it('si el admin ya eligió su contraseña por recuperación, la invitación vieja ya no sirve', async () => {
      const token = await invite();
      const reset = await createLoginToken(env.db, 'password_reset', GUEST, env.clock.now());
      expect((await post('/api/auth/admin/reset-password', { token: reset, password: NEW_PASSWORD })).statusCode).toBe(204);
      const hashBefore = (await user())!.password_hash;

      const res = await accept(token, 'otra-contraseña-789');
      expect(res.statusCode).toBe(410);
      expect((await user())!.password_hash).toBe(hashBefore);
    });

    it('un jugador o un admin activo que comparte el mail de un link de invitación no se ve afectado', async () => {
      await createAdmin(env.db, { email: 'activa@club.example', name: 'Activa', clubId: 'test-inv', password: 'clave-de-prueba-123' });
      const token = await createLoginToken(env.db, 'admin_invite', 'activa@club.example', env.clock.now());
      const hashBefore = (await user('activa@club.example'))!.password_hash;

      expect((await accept(token, NEW_PASSWORD)).statusCode).toBe(410);
      expect((await user('activa@club.example'))!.password_hash).toBe(hashBefore);
    });

    it('dos pedidos simultáneos con el mismo link: uno pasa y el otro se rechaza', async () => {
      const token = await invite();
      const results = await Promise.all([accept(token, 'contraseña-uno-111'), accept(token, 'contraseña-dos-222')]);
      expect(results.map((r) => r.statusCode).sort()).toEqual([200, 410]);
      const winner = results.find((r) => r.statusCode === 200)!;
      const password = winner === results[0] ? 'contraseña-uno-111' : 'contraseña-dos-222';
      expect((await post('/api/auth/admin/login', { email: GUEST, password })).statusCode).toBe(200);
    });
  });
});
