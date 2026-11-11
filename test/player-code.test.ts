import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAdmin, createSuperadmin } from '../src/modules/auth/admins.js';
import { hashCode } from '../src/modules/auth/links.js';
import { SESSION_COOKIE } from '../src/modules/auth/sessions.js';
import { createDbTestEnv, waitFor, type DbTestEnv } from './helpers.js';

const MINUTE = 60 * 1000;
const PLAYER = 'matias.rossi@mail.example';
const ADMIN = {
  email: 'ana@estacion-norte.example',
  name: 'Ana Pérez',
  clubId: 'estacion-norte',
  password: 'clave-de-prueba-123',
};

describe('ingreso del jugador con el código del mail', () => {
  let env: DbTestEnv;

  beforeAll(async () => {
    env = await createDbTestEnv();
  });
  afterAll(async () => {
    await env?.close();
  });
  beforeEach(async () => {
    await env.reset();
  });

  const requestLink = (email: string, ip = '203.0.113.10') =>
    env.app.inject({
      method: 'POST',
      url: '/api/auth/player/request-link',
      headers: { 'x-forwarded-for': ip },
      payload: { email },
    });

  const confirmCode = (email: string, code: string, cookie?: string) =>
    env.app.inject({
      method: 'POST',
      url: '/api/auth/player/confirm-code',
      cookies: cookie ? { [SESSION_COOKIE]: cookie } : {},
      payload: { email, code },
    });

  const confirmLink = (token: string) =>
    env.app.inject({ method: 'POST', url: '/api/auth/player/confirm', payload: { token } });

  const me = (cookie?: string) =>
    env.app.inject({ method: 'GET', url: '/api/auth/me', cookies: cookie ? { [SESSION_COOKIE]: cookie } : {} });

  const sessionCookie = (res: LightMyRequestResponse) => res.cookies.find((c) => c.name === SESSION_COOKIE)?.value;

  /** Pide el ingreso, espera el mail y devuelve el código y el identificador del link. */
  async function issue(email: string): Promise<{ code: string; token: string }> {
    const before = env.mailer.sent.length;
    expect((await requestLink(email)).statusCode).toBe(202);
    await waitFor(() => env.mailer.sent.length > before);
    return {
      code: env.mailer.lastCodeTo(email)!,
      token: new URL(env.mailer.lastLinkTo(email)!).searchParams.get('token')!,
    };
  }

  const wrongCode = (code: string) => (code === '000000' ? '000001' : '000000');
  const count = async (table: string) => (await env.db.query(`SELECT 1 FROM ${table}`)).length;

  describe('el mail y lo que se guarda', () => {
    it('trae el link y un código de 6 dígitos, y la base guarda solo hashes', async () => {
      const { code, token } = await issue(PLAYER);
      expect(code).toMatch(/^\d{6}$/);
      expect(token).toMatch(/^[\w-]{20,}$/);

      const mail = env.mailer.sent[0]!;
      expect(mail.subject).toBe('Tu acceso a Canchas3');
      expect(mail.html).toContain(code);

      const [row] = await env.db.query<{ code_hash: string; token_hash: string; code_attempts: number }>(
        `SELECT code_hash, token_hash, code_attempts FROM login_tokens`,
      );
      expect(row!.code_hash).toBe(hashCode(PLAYER, code));
      expect(row!.code_hash).not.toContain(code);
      expect(row!.code_attempts).toBe(0);
    });

    it('el mismo código en dos mails distintos no da el mismo hash', () => {
      expect(hashCode('a@mail.example', '123456')).not.toBe(hashCode('b@mail.example', '123456'));
      expect(hashCode('A@Mail.example', '123456')).toBe(hashCode('a@mail.example', '123456'));
    });

    it('la recuperación de contraseña y la invitación no llevan código', async () => {
      await createAdmin(env.db, ADMIN);
      await env.app.inject({ method: 'POST', url: '/api/auth/admin/request-reset', payload: { email: ADMIN.email } });
      await waitFor(() => env.mailer.sent.length === 1);
      const rows = await env.db.query<{ code_hash: string | null }>(`SELECT code_hash FROM login_tokens`);
      expect(rows).toEqual([{ code_hash: null }]);
      expect(env.mailer.lastCodeTo(ADMIN.email)).toBeNull();
    });

    it('un admin no recibe nada y la respuesta es la misma que para cualquier mail', async () => {
      await createAdmin(env.db, ADMIN);
      const admin = await requestLink(ADMIN.email);
      const other = await requestLink('otro@mail.example');
      expect(admin.statusCode).toBe(202);
      expect(admin.json()).toEqual(other.json());
      await waitFor(() => env.mailer.sent.length === 1);
      expect(env.mailer.sent[0]!.to).toBe('otro@mail.example');
      expect(await count('login_tokens')).toBe(1);
    });
  });

  describe('ingresar con el código', () => {
    it('un código correcto abre la sesión de un jugador existente', async () => {
      await confirmLink((await issue(PLAYER)).token);
      const { code } = await issue(PLAYER);

      const res = await confirmCode(PLAYER, code);
      expect(res.statusCode).toBe(200);
      expect(res.json().user).toMatchObject({ email: PLAYER, role: 'player' });
      expect(sessionCookie(res)).toBeTruthy();
      expect((await me(sessionCookie(res))).json().user.email).toBe(PLAYER);
    });

    it('en el primer ingreso crea la cuenta', async () => {
      const { code } = await issue('nuevo@mail.example');
      expect(await count('users')).toBe(0);
      const res = await confirmCode('nuevo@mail.example', code);
      expect(res.statusCode).toBe(200);
      expect(await count('users')).toBe(1);
    });

    it('acepta el mail con mayúsculas y el código pegado con espacios', async () => {
      const { code } = await issue(PLAYER);
      const res = await confirmCode(PLAYER.toUpperCase(), `${code.slice(0, 3)} ${code.slice(3)}`);
      expect(res.statusCode).toBe(200);
    });

    it('cierra la sesión que el navegador tuviera antes', async () => {
      const first = await confirmCode(PLAYER, (await issue(PLAYER)).code);
      const second = await confirmCode('otro@mail.example', (await issue('otro@mail.example')).code, sessionCookie(first));
      expect(second.statusCode).toBe(200);
      expect((await me(sessionCookie(first))).json()).toEqual({ user: null });
      expect(await count('sessions')).toBe(1);
    });

    it('usar el código invalida el link y usar el link invalida el código', async () => {
      const a = await issue(PLAYER);
      expect((await confirmCode(PLAYER, a.code)).statusCode).toBe(200);
      const viaLink = await confirmLink(a.token);
      expect(viaLink.statusCode).toBe(410);
      expect(viaLink.json().error.code).toBe('link_used');

      const b = await issue(PLAYER);
      expect((await confirmLink(b.token)).statusCode).toBe(200);
      const again = await confirmCode(PLAYER, b.code);
      expect(again.statusCode).toBe(400);
      expect(again.json().error.code).toBe('invalid_code');
    });

    it('el código no se puede usar dos veces', async () => {
      const { code } = await issue(PLAYER);
      expect((await confirmCode(PLAYER, code)).statusCode).toBe(200);
      expect((await confirmCode(PLAYER, code)).statusCode).toBe(400);
    });

    it('con dos pedidos vigentes sirve el código de cualquiera de los dos', async () => {
      const a = await issue(PLAYER);
      const b = await issue(PLAYER);
      expect((await confirmCode(PLAYER, a.code)).statusCode).toBe(200);
      expect((await confirmCode(PLAYER, b.code)).statusCode).toBe(200);
    });

    it('dos ingresos simultáneos con el mismo código: gana uno', async () => {
      const { code } = await issue(PLAYER);
      const results = await Promise.all([confirmCode(PLAYER, code), confirmCode(PLAYER, code)]);
      expect(results.map((r) => r.statusCode).sort()).toEqual([200, 400]);
    });

    it('un código vencido no sirve', async () => {
      const { code } = await issue(PLAYER);
      env.clock.advance(15 * MINUTE + 1000);
      const res = await confirmCode(PLAYER, code);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('invalid_code');
    });

    it('el mismo error para un código incorrecto, un mail sin pedidos y un mail de admin', async () => {
      await createAdmin(env.db, ADMIN);
      const { code } = await issue(PLAYER);
      const wrong = await confirmCode(PLAYER, wrongCode(code));
      const nobody = await confirmCode('nadie@mail.example', '123456');
      const admin = await confirmCode(ADMIN.email, '123456');
      for (const res of [wrong, nobody, admin]) {
        expect(res.statusCode).toBe(400);
        expect(res.json().error.code).toBe('invalid_code');
        expect(res.json().error.message).toBe(wrong.json().error.message);
      }
    });

    it('un formato inválido responde 400 invalid_code sin sumar intentos', async () => {
      const { code } = await issue(PLAYER);
      for (const bad of ['12345', '1234567', 'abcdef', '12 34']) {
        const res = await confirmCode(PLAYER, bad);
        expect(res.statusCode).toBe(400);
        expect(res.json().error.code).toBe('invalid_code');
      }
      const [row] = await env.db.query<{ code_attempts: number }>(`SELECT code_attempts FROM login_tokens`);
      expect(row!.code_attempts).toBe(0);
      expect((await confirmCode(PLAYER, code)).statusCode).toBe(200);
    });

    it('si el mail se volvió de un admin después de pedir el código, no abre sesión y lo dice explícitamente', async () => {
      const { code } = await issue(PLAYER);
      await createAdmin(env.db, { ...ADMIN, email: PLAYER });
      const res = await confirmCode(PLAYER, code);
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('admin_account');
      expect(res.json().error.message).toContain('administrador');
      expect(sessionCookie(res)).toBeUndefined();
    });

    it('un superadmin que recibió el código y lo escribe bien recibe el mensaje explícito, no el genérico', async () => {
      await createSuperadmin(env.db, { email: 'super@mail.example', name: 'Super', password: 'clave-de-prueba-123' });
      const { code } = await issue('super@mail.example');
      const res = await confirmCode('super@mail.example', code);
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('admin_account');
      expect(sessionCookie(res)).toBeUndefined();
    });

    it('un código equivocado con el mail de un admin con pedido vigente sigue dando el error genérico', async () => {
      await createSuperadmin(env.db, { email: 'super@mail.example', name: 'Super', password: 'clave-de-prueba-123' });
      const { code } = await issue('super@mail.example');
      const res = await confirmCode('super@mail.example', wrongCode(code));
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('invalid_code');
    });
  });

  describe('intentos fallidos', () => {
    it('cada error suma un intento y al quinto responde 429', async () => {
      const { code } = await issue(PLAYER);
      const bad = wrongCode(code);
      for (let i = 0; i < 4; i++) {
        const res = await confirmCode(PLAYER, bad);
        expect(res.statusCode).toBe(400);
      }
      const fifth = await confirmCode(PLAYER, bad);
      expect(fifth.statusCode).toBe(429);
      expect(fifth.json().error.code).toBe('too_many_code_attempts');
    });

    it('después del quinto error ni el código correcto sirve, pero el link sí', async () => {
      const { code, token } = await issue(PLAYER);
      for (let i = 0; i < 5; i++) await confirmCode(PLAYER, wrongCode(code));
      const res = await confirmCode(PLAYER, code);
      expect(res.statusCode).toBe(429);
      expect(sessionCookie(res)).toBeUndefined();
      expect((await confirmLink(token)).statusCode).toBe(200);
    });

    it('los intentos se cuentan en todos los pedidos vigentes del mail: pedir otro no da 5 más', async () => {
      const a = await issue(PLAYER);
      const b = await issue(PLAYER);
      const bad = [a.code, b.code].includes('000000') ? '000001' : '000000';
      for (let i = 0; i < 4; i++) await confirmCode(PLAYER, bad);
      const rows = await env.db.query<{ code_attempts: number }>(`SELECT code_attempts FROM login_tokens`);
      expect(rows.map((r) => r.code_attempts)).toEqual([4, 4]);
      expect((await confirmCode(PLAYER, bad)).statusCode).toBe(429);
      expect((await confirmCode(PLAYER, b.code)).statusCode).toBe(429);
    });

    it('un pedido nuevo después de agotar los intentos trae un código que sí sirve', async () => {
      const a = await issue(PLAYER);
      for (let i = 0; i < 5; i++) await confirmCode(PLAYER, wrongCode(a.code));
      const b = await issue(PLAYER);
      expect((await confirmCode(PLAYER, b.code)).statusCode).toBe(200);
    });

    it('los errores de un mail no afectan a otro', async () => {
      const a = await issue(PLAYER);
      const other = await issue('otro@mail.example');
      for (let i = 0; i < 5; i++) await confirmCode(PLAYER, wrongCode(a.code));
      expect((await confirmCode('otro@mail.example', other.code)).statusCode).toBe(200);
    });
  });

  describe('entrega del mail', () => {
    it('una falla pasajera del servidor se reintenta y el mail llega; la respuesta es la de siempre', async () => {
      env.mailer.failTimes = 1;
      const res = await requestLink(PLAYER);
      expect(res.statusCode).toBe(202);
      await waitFor(() => env.mailer.sent.length === 1);
      expect(env.mailer.attempts).toBe(2);
      expect(env.mailer.lastCodeTo(PLAYER)).toMatch(/^\d{6}$/);
    });

    it('la recuperación de contraseña de un admin también se reintenta', async () => {
      await createAdmin(env.db, ADMIN);
      env.mailer.failTimes = 2;
      await env.app.inject({ method: 'POST', url: '/api/auth/admin/request-reset', payload: { email: ADMIN.email } });
      await waitFor(() => env.mailer.sent.length === 1);
      expect(env.mailer.attempts).toBe(3);
    });
  });
});
