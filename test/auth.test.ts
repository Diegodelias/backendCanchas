import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAdmin, createSuperadmin } from '../src/modules/auth/admins.js';
import { createSession, SESSION_COOKIE } from '../src/modules/auth/sessions.js';
import { createDbTestEnv, type DbTestEnv } from './helpers.js';

const ADMIN = {
  email: 'ana@estacion-norte.example',
  name: 'Ana Pérez',
  clubId: 'estacion-norte',
  password: 'clave-de-prueba-123',
};

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

describe('auth de admin', () => {
  let env: DbTestEnv;

  beforeAll(async () => {
    env = await createDbTestEnv();
  });
  afterAll(async () => {
    await env?.close();
  });
  beforeEach(async () => {
    await env.reset();
    await createAdmin(env.db, ADMIN);
  });

  const login = (email: string, password: string, ip = '203.0.113.10') =>
    env.app.inject({
      method: 'POST',
      url: '/api/auth/admin/login',
      headers: { 'x-forwarded-for': ip },
      payload: { email, password },
    });

  const sessionToken = (res: LightMyRequestResponse) =>
    res.cookies.find((c) => c.name === SESSION_COOKIE)?.value;

  const me = (token?: string) =>
    env.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      cookies: token ? { [SESSION_COOKIE]: token } : {},
    });

  it('login correcto devuelve el admin y una cookie httpOnly y SameSite=Lax', async () => {
    const res = await login(ADMIN.email, ADMIN.password);
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toMatchObject({
      email: ADMIN.email,
      name: ADMIN.name,
      role: 'club_admin',
      clubId: 'estacion-norte',
    });
    const cookie = res.cookies.find((c) => c.name === SESSION_COOKIE);
    expect(cookie).toBeDefined();
    expect(cookie!.httpOnly).toBe(true);
    expect(String(cookie!.sameSite).toLowerCase()).toBe('lax');
    expect(cookie!.path).toBe('/');
    expect(cookie!.maxAge).toBeUndefined();
    // En test (no production) la cookie no es Secure.
    expect(cookie!.secure).toBeFalsy();
  });

  it('el mail no distingue mayúsculas', async () => {
    const res = await login(ADMIN.email.toUpperCase(), ADMIN.password);
    expect(res.statusCode).toBe(200);
  });

  it('contraseña incorrecta y mail inexistente dan el mismo error', async () => {
    const wrongPass = await login(ADMIN.email, 'otra-clave-cualquiera');
    const noUser = await login('nadie@club.example', ADMIN.password);
    expect(wrongPass.statusCode).toBe(401);
    expect(noUser.statusCode).toBe(401);
    expect(wrongPass.json()).toEqual(noUser.json());
    expect(wrongPass.json().error.code).toBe('invalid_credentials');
    expect(sessionToken(wrongPass)).toBeUndefined();
  });

  describe('superadmin, cuenta dada de baja y admin invitado', () => {
    const SUPER = { email: 'root@canchas3.example', name: 'Root', password: 'clave-de-super-123' };

    it('un superadmin ingresa por el mismo login y recibe rol de superadmin sin club', async () => {
      await createSuperadmin(env.db, SUPER);
      const res = await login(SUPER.email, SUPER.password);
      expect(res.statusCode).toBe(200);
      expect(res.json().user).toMatchObject({ email: SUPER.email, name: SUPER.name, role: 'superadmin', clubId: null });
      expect(sessionToken(res)).toBeDefined();
      expect((await me(sessionToken(res))).json().user).toMatchObject({ role: 'superadmin' });
    });

    it('con contraseña incorrecta, un superadmin recibe el mismo error que cualquier admin', async () => {
      await createSuperadmin(env.db, SUPER);
      const wrongSuper = await login(SUPER.email, 'otra-clave-cualquiera');
      const wrongAdmin = await login(ADMIN.email, 'otra-clave-cualquiera');
      expect(wrongSuper.statusCode).toBe(401);
      expect(wrongSuper.json()).toEqual(wrongAdmin.json());
    });

    it('el límite de 5 intentos fallidos también vale para la cuenta de un superadmin', async () => {
      await createSuperadmin(env.db, SUPER);
      for (let i = 0; i < 5; i++) {
        expect((await login(SUPER.email, 'mala-clave-000', `198.51.100.${i}`)).statusCode).toBe(401);
      }
      const res = await login(SUPER.email, SUPER.password, '198.51.100.99');
      expect(res.statusCode).toBe(429);
      expect(res.json().error.code).toBe('too_many_attempts');
    });

    it('un admin dado de baja no ingresa, ni con su contraseña correcta, y recibe el mismo error genérico', async () => {
      await env.db.query(`UPDATE users SET deactivated_at = now() WHERE lower(email) = lower($1)`, [ADMIN.email]);
      const baja = await login(ADMIN.email, ADMIN.password);
      const wrong = await login('nadie@club.example', ADMIN.password);
      expect(baja.statusCode).toBe(401);
      expect(baja.json()).toEqual(wrong.json());
      expect(sessionToken(baja)).toBeUndefined();
      // Cuenta como intento fallido, igual que cualquier credencial inválida.
      expect(await env.db.query(`SELECT 1 FROM login_attempts WHERE lower(email) = lower($1)`, [ADMIN.email])).toHaveLength(1);
    });

    it('un admin invitado que todavía no eligió contraseña no ingresa y no se distingue de un mail inexistente', async () => {
      await env.db.query(
        `INSERT INTO users (email, name, role, club_id) VALUES ('invitado@club.example', 'Inv', 'club_admin', 'estacion-norte')`,
      );
      const attempts = ['x', 'cualquier-clave-1', ADMIN.password];
      for (const [i, attempt] of attempts.entries()) {
        const res = await login('invitado@club.example', attempt, `198.51.100.${i * 2}`);
        const missing = await login('inexistente@club.example', attempt, `198.51.100.${i * 2 + 1}`);
        expect(res.statusCode).toBe(401);
        expect(res.json()).toEqual(missing.json());
        expect(sessionToken(res)).toBeUndefined();
      }
    });
  });

  it('cuerpo inválido responde 400', async () => {
    const res = await env.app.inject({ method: 'POST', url: '/api/auth/admin/login', payload: { email: '' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_error');
  });

  it('el 6.º intento sobre la cuenta responde 429 aunque la clave sea correcta, también desde otra IP', async () => {
    for (let i = 0; i < 5; i++) {
      expect((await login(ADMIN.email, 'mala-clave-000', `198.51.100.${i}`)).statusCode).toBe(401);
    }
    const res = await login(ADMIN.email, ADMIN.password, '198.51.100.99');
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('too_many_attempts');
    expect(sessionToken(res)).toBeUndefined();
  });

  it('el 6.º intento desde la misma IP responde 429 aunque cambie la cuenta', async () => {
    for (let i = 0; i < 5; i++) {
      expect((await login(`nadie${i}@club.example`, 'mala-clave-000')).statusCode).toBe(401);
    }
    const res = await login(ADMIN.email, ADMIN.password);
    expect(res.statusCode).toBe(429);
  });

  it('el bloqueo termina pasados 15 minutos', async () => {
    for (let i = 0; i < 5; i++) await login(ADMIN.email, 'mala-clave-000');
    expect((await login(ADMIN.email, ADMIN.password)).statusCode).toBe(429);
    env.clock.advance(15 * MINUTE + 1000);
    expect((await login(ADMIN.email, ADMIN.password)).statusCode).toBe(200);
  });

  it('me devuelve el admin con sesión y null sin sesión', async () => {
    const token = sessionToken(await login(ADMIN.email, ADMIN.password));
    const withSession = await me(token);
    expect(withSession.statusCode).toBe(200);
    expect(withSession.json().user).toMatchObject({ email: ADMIN.email, clubId: 'estacion-norte' });

    const without = await me();
    expect(without.statusCode).toBe(200);
    expect(without.json()).toEqual({ user: null });

    const bogus = await me('token-inventado');
    expect(bogus.json()).toEqual({ user: null });
  });

  it('la sesión vence a las 8 horas sin uso', async () => {
    const token = sessionToken(await login(ADMIN.email, ADMIN.password));
    env.clock.advance(8 * HOUR + 1000);
    expect((await me(token)).json()).toEqual({ user: null });
  });

  it('la sesión se renueva con el uso', async () => {
    const token = sessionToken(await login(ADMIN.email, ADMIN.password));
    // Uso cada 6 horas: sin renovación habría vencido a las 8.
    for (let i = 0; i < 3; i++) {
      env.clock.advance(6 * HOUR);
      expect((await me(token)).json().user).not.toBeNull();
    }
  });

  it('logout invalida la sesión en la base y borra la cookie', async () => {
    const token = sessionToken(await login(ADMIN.email, ADMIN.password));
    const res = await env.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      cookies: { [SESSION_COOKIE]: token! },
    });
    expect(res.statusCode).toBe(204);
    const cleared = res.cookies.find((c) => c.name === SESSION_COOKIE);
    expect(cleared?.value).toBe('');
    expect((await me(token)).json()).toEqual({ user: null });
    expect(await env.db.query('SELECT 1 FROM sessions')).toHaveLength(0);
  });

  it('logout sin sesión responde 204', async () => {
    const res = await env.app.inject({ method: 'POST', url: '/api/auth/logout' });
    expect(res.statusCode).toBe(204);
  });

  it('la sesión de un superadmin también vence a las 8 horas sin uso y se renueva con el uso', async () => {
    const sa = await createSuperadmin(env.db, { email: 'root@canchas3.example', name: 'Root', password: 'otra-clave-123' });
    const token = await createSession(env.db, sa.id, 'superadmin', env.clock.now());
    const user = (await me(token)).json().user;
    expect(user).toMatchObject({ role: 'superadmin', clubId: null });

    for (let i = 0; i < 2; i++) {
      env.clock.advance(6 * HOUR);
      expect((await me(token)).json().user).not.toBeNull();
    }
    env.clock.advance(8 * HOUR + 1000);
    expect((await me(token)).json()).toEqual({ user: null });
  });

  it('una sesión abierta de un admin dado de baja deja de resolver aunque no se haya borrado', async () => {
    const token = sessionToken(await login(ADMIN.email, ADMIN.password))!;
    expect((await me(token)).json().user).not.toBeNull();
    await env.db.query(`UPDATE users SET deactivated_at = now() WHERE lower(email) = lower($1)`, [ADMIN.email]);
    expect((await me(token)).json()).toEqual({ user: null });
    expect(await env.db.query('SELECT 1 FROM sessions')).toHaveLength(1);
  });

  it('la base no guarda la contraseña ni el token en texto plano', async () => {
    const token = sessionToken(await login(ADMIN.email, ADMIN.password))!;
    const [user] = await env.db.query<{ password_hash: string }>('SELECT password_hash FROM users');
    expect(user!.password_hash).not.toContain(ADMIN.password);
    expect(user!.password_hash.startsWith('$argon2id$')).toBe(true);
    const [session] = await env.db.query<{ token_hash: string }>('SELECT token_hash FROM sessions');
    expect(session!.token_hash).not.toBe(token);
  });
});

describe('cookie Secure', () => {
  let env: DbTestEnv;
  beforeAll(async () => {
    env = await createDbTestEnv({ SESSION_COOKIE_SECURE: 'true' });
  });
  afterAll(async () => {
    await env?.close();
  });

  it('con SESSION_COOKIE_SECURE=true la cookie es Secure', async () => {
    await env.reset();
    await createAdmin(env.db, ADMIN);
    const res = await env.app.inject({
      method: 'POST',
      url: '/api/auth/admin/login',
      payload: { email: ADMIN.email, password: ADMIN.password },
    });
    expect(res.cookies.find((c) => c.name === SESSION_COOKIE)?.secure).toBe(true);
  });
});
