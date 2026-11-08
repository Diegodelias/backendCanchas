import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAdmin, createSuperadmin } from '../src/modules/auth/admins.js';
import { SESSION_COOKIE } from '../src/modules/auth/sessions.js';
import { PASSWORD_RESET_EMAIL_SUBJECT, passwordResetEmail } from '../src/modules/mail/passwordResetEmail.js';
import { createDbTestEnv, sleep, waitFor, type DbTestEnv } from './helpers.js';

const MINUTE = 60 * 1000;
const PLAYER = 'jugador@mail.example';
const NEW_PASSWORD = 'contraseña-nueva-456';
const ADMIN = {
  email: 'ana@estacion-norte.example',
  name: 'Ana Pérez',
  clubId: 'estacion-norte',
  password: 'clave-de-prueba-123',
};

describe('recuperación de contraseña del admin', () => {
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
    await createAdmin(env.db, ADMIN);
  });

  const post = (url: string, payload: object, cookie?: string) =>
    env.app.inject({ method: 'POST', url, cookies: cookie ? { [SESSION_COOKIE]: cookie } : {}, payload });

  const requestReset = (email: string) => post('/api/auth/admin/request-reset', { email });
  const reset = (token: string, password: string) => post('/api/auth/admin/reset-password', { token, password });
  const loginAdmin = (password: string, email = ADMIN.email) =>
    post('/api/auth/admin/login', { email, password });
  const me = (cookie: string) =>
    env.app.inject({ method: 'GET', url: '/api/auth/me', cookies: { [SESSION_COOKIE]: cookie } });
  const sessionCookie = (res: LightMyRequestResponse) => res.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
  const count = async (table: string) => (await env.db.query(`SELECT 1 FROM ${table}`)).length;

  const tokenFrom = (link: string) => new URL(link).searchParams.get('token')!;

  /** Pide la recuperación del admin, espera el mail y devuelve el identificador del link. */
  async function issueResetToken(email = ADMIN.email): Promise<string> {
    const before = env.mailer.sent.length;
    expect((await requestReset(email)).statusCode).toBe(202);
    await waitFor(() => env.mailer.sent.length > before);
    return tokenFrom(env.mailer.lastLinkTo(email)!);
  }

  /** Pide un link de acceso de jugador y devuelve su identificador. */
  async function issueAccessToken(email: string): Promise<string> {
    const before = env.mailer.sent.length;
    expect((await post('/api/auth/player/request-link', { email })).statusCode).toBe(202);
    await waitFor(() => env.mailer.sent.length > before);
    return tokenFrom(env.mailer.lastLinkTo(email)!);
  }

  describe('superadmin, admins dados de baja y admins invitados', () => {
    const SUPER = { email: 'root@canchas3.example', name: 'Root', password: 'clave-de-super-123' };

    it('un superadmin recibe el link, elige una contraseña nueva y se cierran sus sesiones', async () => {
      await createSuperadmin(env.db, SUPER);
      const session = sessionCookie(await loginAdmin(SUPER.password, SUPER.email))!;
      expect((await me(session)).json().user).toMatchObject({ role: 'superadmin' });

      const token = await issueResetToken(SUPER.email);
      expect((await reset(token, NEW_PASSWORD)).statusCode).toBe(204);

      expect((await me(session)).json()).toEqual({ user: null });
      expect((await loginAdmin(SUPER.password, SUPER.email)).statusCode).toBe(401);
      const ok = await loginAdmin(NEW_PASSWORD, SUPER.email);
      expect(ok.statusCode).toBe(200);
      expect(ok.json().user).toMatchObject({ role: 'superadmin', clubId: null });
    });

    it('para un admin dado de baja responde lo mismo, no envía ningún mail y no crea links', async () => {
      await env.db.query(`UPDATE users SET deactivated_at = now() WHERE lower(email) = lower($1)`, [ADMIN.email]);
      env.mailer.sent.length = 0;
      const tokensBefore = await count('login_tokens');

      const baja = await requestReset(ADMIN.email);
      const nobody = await requestReset('nadie@mail.example');
      expect(baja.statusCode).toBe(202);
      expect(baja.json()).toEqual(nobody.json());
      await sleep(150);

      expect(env.mailer.sent).toHaveLength(0);
      expect(await count('login_tokens')).toBe(tokensBefore);
    });

    it('un link de recuperación pedido antes de la baja no cambia la contraseña de la cuenta dada de baja', async () => {
      const token = await issueResetToken();
      await env.db.query(`UPDATE users SET deactivated_at = now() WHERE lower(email) = lower($1)`, [ADMIN.email]);

      const res = await reset(token, NEW_PASSWORD);
      expect(res.statusCode).toBe(410);
      const [row] = await env.db.query<{ password_hash: string }>(`SELECT password_hash FROM users WHERE lower(email) = lower($1)`, [ADMIN.email]);
      expect(row!.password_hash).not.toBeNull();
      expect((await loginAdmin(ADMIN.password)).statusCode).toBe(401); // baja: no ingresa
    });

    it('un admin invitado sin contraseña recupera, elige una y la cuenta queda activa, sin abrir sesión', async () => {
      await env.db.query(
        `INSERT INTO users (email, name, role, club_id) VALUES ('invitado@club.example', 'Inv', 'club_admin', 'estacion-norte')`,
      );
      const token = await issueResetToken('invitado@club.example');
      const res = await reset(token, NEW_PASSWORD);
      expect(res.statusCode).toBe(204);
      expect(sessionCookie(res)).toBeUndefined();

      const [row] = await env.db.query<{ password_hash: string | null }>(
        `SELECT password_hash FROM users WHERE email = 'invitado@club.example'`,
      );
      expect(row!.password_hash).not.toBeNull();
      expect((await loginAdmin(NEW_PASSWORD, 'invitado@club.example')).statusCode).toBe(200);
    });
  });

  describe('pedir la recuperación', () => {
    it('responde lo mismo para un admin, un jugador y un mail sin cuenta', async () => {
      await issueAccessToken(PLAYER).then((t) => post('/api/auth/player/confirm', { token: t }));
      env.mailer.sent.length = 0;

      const admin = await requestReset(ADMIN.email);
      const player = await requestReset(PLAYER);
      const nobody = await requestReset('nadie@mail.example');

      expect([admin.statusCode, player.statusCode, nobody.statusCode]).toEqual([202, 202, 202]);
      expect(player.json()).toEqual(admin.json());
      expect(nobody.json()).toEqual(admin.json());
      expect(admin.json().message).toContain('15 minutos');
    });

    it('envía el mail solo al admin, con el link a /recuperar', async () => {
      await issueAccessToken(PLAYER).then((t) => post('/api/auth/player/confirm', { token: t }));
      env.mailer.sent.length = 0;

      await requestReset(PLAYER);
      await requestReset('nadie@mail.example');
      await requestReset(ADMIN.email);
      await waitFor(() => env.mailer.sent.length === 1);
      await sleep(150);

      expect(env.mailer.sent).toHaveLength(1);
      expect(env.mailer.sent[0]!.to).toBe(ADMIN.email);
      expect(env.mailer.sent[0]!.subject).toBe('Restablecé tu contraseña de Canchas3');
      expect(env.mailer.lastLinkTo(ADMIN.email)).toMatch(/^http:\/\/localhost:3000\/recuperar\?token=[\w-]{20,}$/);
    });

    it('para un jugador o un mail sin cuenta no crea cuentas, links ni cambia nada', async () => {
      await issueAccessToken(PLAYER).then((t) => post('/api/auth/player/confirm', { token: t }));
      const usersBefore = await count('users');
      const tokensBefore = await count('login_tokens');

      await requestReset(PLAYER);
      await requestReset('nadie@mail.example');

      expect(await count('users')).toBe(usersBefore);
      expect(await count('login_tokens')).toBe(tokensBefore);
    });

    it('un mail con formato inválido responde 400 sin tocar nada', async () => {
      const res = await requestReset('no-es-un-mail');
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('validation_error');
      expect(await count('link_requests')).toBe(0);
    });

    it('el 4.º pedido en 15 minutos responde 429 y no envía mail, tenga o no cuenta el mail', async () => {
      for (let i = 0; i < 3; i++) expect((await requestReset(ADMIN.email)).statusCode).toBe(202);
      await waitFor(() => env.mailer.sent.length === 3);
      const fourth = await requestReset(ADMIN.email);
      expect(fourth.statusCode).toBe(429);
      expect(fourth.json().error.code).toBe('too_many_requests');

      for (let i = 0; i < 3; i++) expect((await requestReset('nadie@mail.example')).statusCode).toBe(202);
      expect((await requestReset('nadie@mail.example')).statusCode).toBe(429);
      await sleep(100);
      expect(env.mailer.sent).toHaveLength(3);
    });

    it('pasados 15 minutos se puede volver a pedir', async () => {
      for (let i = 0; i < 3; i++) await requestReset(ADMIN.email);
      expect((await requestReset(ADMIN.email)).statusCode).toBe(429);
      env.clock.advance(15 * MINUTE + 1000);
      expect((await requestReset(ADMIN.email)).statusCode).toBe(202);
    });

    it('el límite es independiente del de los links de acceso de jugador', async () => {
      // El mail del admin agota los pedidos de acceso (no se envía nada, pero se cuentan)...
      for (let i = 0; i < 3; i++) await post('/api/auth/player/request-link', { email: ADMIN.email });
      expect((await post('/api/auth/player/request-link', { email: ADMIN.email })).statusCode).toBe(429);
      // ...y la recuperación sigue disponible.
      expect((await requestReset(ADMIN.email)).statusCode).toBe(202);
      await waitFor(() => env.mailer.sent.length === 1);

      // Y al revés: agotar la recuperación no bloquea el acceso.
      for (let i = 0; i < 2; i++) await requestReset(ADMIN.email);
      expect((await requestReset(ADMIN.email)).statusCode).toBe(429);
      expect((await post('/api/auth/player/request-link', { email: 'otro@mail.example' })).statusCode).toBe(202);
    });

    it('si el envío falla, responde igual y registra el error sin el link ni el mail', async () => {
      env.mailer.failWith = Object.assign(new Error(`rechazado: ${ADMIN.email}`), { code: 'EENVELOPE' });
      expect((await requestReset(ADMIN.email)).statusCode).toBe(202);
      await waitFor(() => logs.some((l) => l.includes('No se pudo enviar el mail de recuperación')));
      const all = logs.join('\n');
      expect(all).toContain('EENVELOPE');
      expect(all).not.toContain(ADMIN.email);
      expect(all).not.toContain('/recuperar?token=');
    });
  });

  describe('contenido del mail', () => {
    it('tiene el asunto, el link como texto, un botón y el aviso de vencimiento', () => {
      const link = 'http://localhost:3000/recuperar?token=abc';
      const mail = passwordResetEmail('ana@club.example', link);
      expect(mail.subject).toBe(PASSWORD_RESET_EMAIL_SUBJECT);
      expect(mail.text).toContain(link);
      expect(mail.text).toContain('15 minutos');
      expect(mail.text).toContain('ignorá este mensaje');
      expect(mail.html).toContain(`href="${link}"`);
      expect(mail.html).toContain('15 minutos');
    });
  });

  describe('cambiar la contraseña', () => {
    it('una contraseña corta responde 400 sin consumir el link, y el mismo link sirve después', async () => {
      const token = await issueResetToken();
      const short = await reset(token, 'corta123');
      expect(short.statusCode).toBe(400);
      expect(short.json().error.code).toBe('validation_error');
      expect(await env.db.query('SELECT 1 FROM login_tokens WHERE used_at IS NULL')).toHaveLength(1);
      expect((await loginAdmin(ADMIN.password)).statusCode).toBe(200);

      expect((await reset(token, NEW_PASSWORD)).statusCode).toBe(204);
    });

    it('cambia la contraseña: la nueva ingresa y la vieja ya no sirve', async () => {
      const token = await issueResetToken();
      const res = await reset(token, NEW_PASSWORD);
      expect(res.statusCode).toBe(204);

      expect((await loginAdmin(NEW_PASSWORD)).statusCode).toBe(200);
      const old = await loginAdmin(ADMIN.password);
      expect(old.statusCode).toBe(401);
      expect(old.json().error.code).toBe('invalid_credentials');
    });

    it('no abre ninguna sesión', async () => {
      const token = await issueResetToken();
      const res = await reset(token, NEW_PASSWORD);
      expect(sessionCookie(res)).toBeUndefined();
      expect(res.headers['set-cookie']).toBeUndefined();
      expect(await count('sessions')).toBe(0);
    });

    it('cierra todas las sesiones abiertas del admin', async () => {
      const phone = sessionCookie(await loginAdmin(ADMIN.password))!;
      const laptop = sessionCookie(await loginAdmin(ADMIN.password))!;
      expect((await me(phone)).json().user).not.toBeNull();
      expect((await me(laptop)).json().user).not.toBeNull();

      await reset(await issueResetToken(), NEW_PASSWORD);

      expect((await me(phone)).json()).toEqual({ user: null });
      expect((await me(laptop)).json()).toEqual({ user: null });
    });

    it('no toca las sesiones de otras cuentas', async () => {
      const otherAdmin = { ...ADMIN, email: 'bruno@cantera.example', clubId: 'la-cantera-crespo' };
      await createAdmin(env.db, otherAdmin);
      const bruno = sessionCookie(await loginAdmin(otherAdmin.password, otherAdmin.email))!;
      const player = await issueAccessToken(PLAYER).then(async (t) =>
        sessionCookie(await post('/api/auth/player/confirm', { token: t }))!,
      );

      await reset(await issueResetToken(), NEW_PASSWORD);

      expect((await me(bruno)).json().user).not.toBeNull();
      expect((await me(player)).json().user.role).toBe('player');
    });

    it('guarda la contraseña nueva con argon2id', async () => {
      await reset(await issueResetToken(), NEW_PASSWORD);
      const [row] = await env.db.query<{ password_hash: string }>('SELECT password_hash FROM users WHERE role = $1', [
        'club_admin',
      ]);
      expect(row!.password_hash.startsWith('$argon2id$')).toBe(true);
      expect(row!.password_hash).not.toContain(NEW_PASSWORD);
    });

    it('un link ya usado responde 410 link_used y no cambia nada', async () => {
      const token = await issueResetToken();
      expect((await reset(token, NEW_PASSWORD)).statusCode).toBe(204);
      const again = await reset(token, 'otra-contraseña-789');
      expect(again.statusCode).toBe(410);
      expect(again.json().error.code).toBe('link_used');
      expect((await loginAdmin(NEW_PASSWORD)).statusCode).toBe(200);
    });

    it('un link vencido o inexistente responde 410 con el mismo mensaje y no cambia nada', async () => {
      const token = await issueResetToken();
      env.clock.advance(15 * MINUTE + 1000);
      const expired = await reset(token, NEW_PASSWORD);
      const unknown = await reset('identificador-que-no-existe', NEW_PASSWORD);
      expect(expired.statusCode).toBe(410);
      expect(expired.json().error.code).toBe('link_expired');
      expect(unknown.json()).toEqual(expired.json());
      expect((await loginAdmin(ADMIN.password)).statusCode).toBe(200);
    });

    it('pedir un link nuevo no invalida el anterior', async () => {
      const first = await issueResetToken();
      const second = await issueResetToken();
      expect((await reset(first, NEW_PASSWORD)).statusCode).toBe(204);
      expect((await reset(second, 'otra-contraseña-789')).statusCode).toBe(204);
    });

    it('sin identificador responde 400', async () => {
      expect((await post('/api/auth/admin/reset-password', { password: NEW_PASSWORD })).statusCode).toBe(400);
    });

    it('un link de acceso de jugador no sirve para cambiar una contraseña y no se consume', async () => {
      const accessToken = await issueAccessToken(PLAYER);
      const res = await reset(accessToken, NEW_PASSWORD);
      expect(res.statusCode).toBe(410);
      expect(res.json().error.code).toBe('link_expired');
      expect((await loginAdmin(ADMIN.password)).statusCode).toBe(200);
      // El link de acceso sigue vigente para ingresar.
      expect((await post('/api/auth/player/confirm', { token: accessToken })).statusCode).toBe(200);
    });

    it('un link de recuperación no sirve para ingresar como jugador y no se consume', async () => {
      const resetToken = await issueResetToken();
      const res = await post('/api/auth/player/confirm', { token: resetToken });
      expect(res.statusCode).toBe(410);
      expect(sessionCookie(res)).toBeUndefined();
      // El link de recuperación sigue vigente para cambiar la contraseña.
      expect((await reset(resetToken, NEW_PASSWORD)).statusCode).toBe(204);
    });

    it('dos cambios simultáneos con el mismo link cambian la contraseña una sola vez', async () => {
      const token = await issueResetToken();
      const results = await Promise.all([reset(token, 'contraseña-uno-111'), reset(token, 'contraseña-dos-222')]);
      expect(results.map((r) => r.statusCode).sort()).toEqual([204, 410]);

      const works = [
        (await loginAdmin('contraseña-uno-111')).statusCode,
        (await loginAdmin('contraseña-dos-222')).statusCode,
      ].filter((s) => s === 200);
      expect(works).toHaveLength(1);
    });

    it('no levanta el bloqueo por intentos fallidos', async () => {
      for (let i = 0; i < 5; i++) expect((await loginAdmin('mala-clave-000')).statusCode).toBe(401);
      expect((await loginAdmin(ADMIN.password)).statusCode).toBe(429);

      await reset(await issueResetToken(), NEW_PASSWORD);

      expect(await count('login_attempts')).toBe(5);
      expect((await loginAdmin(NEW_PASSWORD)).statusCode).toBe(429);
      env.clock.advance(15 * MINUTE + 1000);
      expect((await loginAdmin(NEW_PASSWORD)).statusCode).toBe(200);
    });

    it('si el mail dejó de ser de un admin, el link se consume pero no cambia nada', async () => {
      const token = await issueResetToken();
      await env.db.query(`DELETE FROM users WHERE lower(email) = lower($1)`, [ADMIN.email]);
      const res = await reset(token, NEW_PASSWORD);
      expect(res.statusCode).toBe(410);
      expect(await count('users')).toBe(0);
    });
  });
});
