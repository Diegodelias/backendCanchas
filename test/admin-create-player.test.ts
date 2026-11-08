import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAdmin, createSuperadmin } from '../src/modules/auth/admins.js';
import { SESSION_COOKIE } from '../src/modules/auth/sessions.js';
import { createDbTestEnv, type DbTestEnv } from './helpers.js';

const SUPER = { email: 'root@canchas3.example', name: 'Root', password: 'clave-de-super-123' };
const CLUB_ADMIN = { email: 'admin@club.example', name: 'Ana Admin', clubId: 'test-ply', password: 'clave-del-admin-123' };
const PLAYER = 'demo@jugador.example';
const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

describe('crear jugador desde el panel de admin y de la plataforma', () => {
  let env: DbTestEnv;
  const logs: string[] = [];
  let sa: string;
  let ca: string;

  beforeAll(async () => {
    env = await createDbTestEnv({}, { write: (m) => void logs.push(m) });
  });
  afterAll(async () => {
    await env?.close();
  });
  beforeEach(async () => {
    await env.reset();
    logs.length = 0;
    await env.db.query(
      `INSERT INTO clubs (id, name, zone, city, address) VALUES ('test-ply', 'Club Jugadores', 'Zona', 'buenos-aires', 'Calle 123')`,
    );
    await createSuperadmin(env.db, SUPER);
    await createAdmin(env.db, CLUB_ADMIN);
    sa = await login(SUPER.email, SUPER.password);
    ca = await login(CLUB_ADMIN.email, CLUB_ADMIN.password);
  });

  const body = (res: LightMyRequestResponse) => res.json();
  const post = (url: string, payload: object, cookie?: string) =>
    env.app.inject({ method: 'POST', url, cookies: cookie ? { [SESSION_COOKIE]: cookie } : {}, payload });
  const platform = (payload: object, cookie?: string) => post('/api/platform/players', payload, cookie);
  const club = (payload: object, cookie?: string) => post('/api/club/players', payload, cookie);
  const tokenFrom = (link: string) => new URL(link).searchParams.get('token')!;
  const sessionOf = (res: LightMyRequestResponse) => res.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
  const confirm = (token: string) => post('/api/auth/player/confirm', { token });
  const usersWith = async (email: string) =>
    env.db.query<{ role: string; name: string | null; email: string }>(
      `SELECT role, name, email FROM users WHERE lower(email) = lower($1)`, [email]);

  async function login(email: string, password: string): Promise<string> {
    const res = await post('/api/auth/admin/login', { email, password });
    expect(res.statusCode).toBe(200);
    return sessionOf(res)!;
  }
  async function playerSession(email = 'otro@jugador.example'): Promise<string> {
    const created = await platform({ email }, sa);
    return sessionOf(await confirm(tokenFrom(body(created).link)))!;
  }

  for (const [label, create] of [
    ['superadmin (plataforma)', (p: object) => platform(p, sa)],
    ['admin de club', (p: object) => club(p, ca)],
  ] as const) {
    describe(label, () => {
      it('crea el jugador sin nombre, con el mail en minúsculas, y devuelve el link sin enviar mail', async () => {
        const res = await create({ email: 'DEMO@Jugador.Example' });
        expect(res.statusCode).toBe(201);
        const data = body(res);
        expect(data.created).toBe(true);
        expect(data.emailSent).toBeNull();
        expect(data.player.email).toBe(PLAYER);
        expect(data.link).toMatch(/\/acceso\?token=/);
        expect(await usersWith(PLAYER)).toEqual([{ role: 'player', name: null, email: PLAYER }]);
        expect(env.mailer.sent).toHaveLength(0);
        expect(res.headers['cache-control']).toBe('no-store');
      });

      it('rechaza un mail con formato inválido sin crear nada', async () => {
        const res = await create({ email: 'no-es-un-mail' });
        expect(res.statusCode).toBe(400);
        expect(await usersWith('no-es-un-mail')).toHaveLength(0);
        expect(await env.db.query('SELECT 1 FROM login_tokens')).toHaveLength(0);
      });

      it('con sendEmail envía el mail con el link y los 72 horas, sin código', async () => {
        const res = await create({ email: PLAYER, sendEmail: true });
        expect(res.statusCode).toBe(201);
        expect(body(res).emailSent).toBe(true);
        expect(env.mailer.sent).toHaveLength(1);
        const mail = env.mailer.sent[0]!;
        expect(mail.to).toBe(PLAYER);
        expect(mail.text).toContain(body(res).link);
        expect(mail.text).toContain('72 horas');
        expect(env.mailer.lastCodeTo(PLAYER)).toBeNull();
      });

      it('si el envío falla, la cuenta y el link quedan y el log no trae mail ni link', async () => {
        env.mailer.failWith = Object.assign(new Error('SMTP caído'), { code: 'ECONNREFUSED' });
        const res = await create({ email: PLAYER, sendEmail: true });
        expect(res.statusCode).toBe(201);
        const data = body(res);
        expect(data.emailSent).toBe(false);
        expect(await usersWith(PLAYER)).toHaveLength(1);
        env.mailer.failWith = null;
        expect((await confirm(tokenFrom(data.link))).statusCode).toBe(200);

        const line = logs.find((l) => l.includes('No se pudo enviar el mail de acceso del jugador'));
        expect(line).toBeDefined();
        expect(line).toContain('ECONNREFUSED');
        for (const text of logs) {
          expect(text).not.toContain(PLAYER);
          expect(text).not.toContain(tokenFrom(data.link));
        }
      });

      it('rechaza el mail de un admin, de club o superadmin, sin modificar la cuenta ni crear un link', async () => {
        for (const email of [CLUB_ADMIN.email, SUPER.email.toUpperCase()]) {
          const res = await create({ email });
          expect(res.statusCode).toBe(409);
          expect(body(res).error.code).toBe('email_is_admin');
        }
        expect(await env.db.query('SELECT 1 FROM login_tokens')).toHaveLength(0);
        expect((await usersWith(CLUB_ADMIN.email))[0]!.role).toBe('club_admin');
        expect(env.mailer.sent).toHaveLength(0);
      });

      it('el cuarto pedido para el mismo mail en 15 minutos se rechaza con espera y no crea ni envía', async () => {
        await env.db.query(
          `INSERT INTO link_requests (purpose, email, ip, requested_at) VALUES ('access', $1, '1.1.1.1', $2), ('access', $1, '1.1.1.1', $2), ('access', $1, '1.1.1.1', $2)`,
          [PLAYER, env.clock.now()],
        );
        const res = await create({ email: PLAYER, sendEmail: true });
        expect(res.statusCode).toBe(429);
        expect(body(res).error.code).toBe('too_many_requests');
        expect(await usersWith(PLAYER)).toHaveLength(0);
        expect(env.mailer.sent).toHaveLength(0);

        env.clock.advance(16 * MINUTE);
        expect((await create({ email: PLAYER })).statusCode).toBe(201);
      });
    });
  }

  describe('permisos', () => {
    it('sin sesión: 401 en las dos rutas y no crea nada', async () => {
      expect((await platform({ email: PLAYER })).statusCode).toBe(401);
      expect((await club({ email: PLAYER })).statusCode).toBe(401);
      expect(await usersWith(PLAYER)).toHaveLength(0);
    });

    it('un jugador con sesión: 403 en las dos rutas y no crea nada', async () => {
      const player = await playerSession();
      expect((await platform({ email: PLAYER }, player)).statusCode).toBe(403);
      expect((await club({ email: PLAYER }, player)).statusCode).toBe(403);
      expect(await usersWith(PLAYER)).toHaveLength(0);
    });

    it('un admin de club no puede usar la ruta de la plataforma, ni el superadmin la del club', async () => {
      expect((await platform({ email: PLAYER }, ca)).statusCode).toBe(403);
      expect((await club({ email: PLAYER }, sa)).statusCode).toBe(403);
      expect(await usersWith(PLAYER)).toHaveLength(0);
    });
  });

  describe('jugador que ya existe', () => {
    it('el admin de club recibe 409 email_is_player y no se crea ningún link', async () => {
      await platform({ email: PLAYER }, sa);
      const before = (await env.db.query('SELECT 1 FROM login_tokens')).length;
      const res = await club({ email: PLAYER }, ca);
      expect(res.statusCode).toBe(409);
      expect(body(res).error.code).toBe('email_is_player');
      expect(await env.db.query('SELECT 1 FROM login_tokens')).toHaveLength(before);
    });

    it('el superadmin obtiene un link nuevo con created: false y la cuenta no cambia', async () => {
      const first = await platform({ email: PLAYER }, sa);
      const [account] = await usersWith(PLAYER);
      const second = await platform({ email: PLAYER }, sa);
      expect(second.statusCode).toBe(201);
      expect(body(second).created).toBe(false);
      expect(body(second).player.id).toBe(body(first).player.id);
      expect(body(second).link).not.toBe(body(first).link);
      expect(await usersWith(PLAYER)).toEqual([account]);
    });
  });

  describe('el link entregado entra por confirm', () => {
    it('abre sesión de jugador sobre la cuenta creada, una sola vez, sin duplicarla', async () => {
      const res = await club({ email: PLAYER }, ca);
      const token = tokenFrom(body(res).link);

      const ok = await confirm(token);
      expect(ok.statusCode).toBe(200);
      expect(body(ok).user).toMatchObject({ id: body(res).player.id, email: PLAYER, role: 'player' });
      expect(await usersWith(PLAYER)).toHaveLength(1);

      const me = await env.app.inject({ method: 'GET', url: '/api/auth/me', cookies: { [SESSION_COOKIE]: sessionOf(ok)! } });
      expect(body(me).user.role).toBe('player');

      const again = await confirm(token);
      expect(again.statusCode).toBe(410);
      expect(body(again).error.code).toBe('link_used');
    });

    it('vale 72 horas: sirve a las 71 y vence pasadas las 72', async () => {
      const early = tokenFrom(body(await platform({ email: PLAYER }, sa)).link);
      const late = tokenFrom(body(await platform({ email: PLAYER }, sa)).link);

      env.clock.advance(71 * HOUR);
      expect((await confirm(early)).statusCode).toBe(200);
      env.clock.advance(2 * HOUR);
      const expired = await confirm(late);
      expect(expired.statusCode).toBe(410);
      expect(body(expired).error.code).toBe('link_expired');
    });

    it('abrir la dirección del link sin confirmar no lo gasta', async () => {
      const link = body(await platform({ email: PLAYER }, sa)).link;
      const page = await env.app.inject({ method: 'GET', url: new URL(link).pathname + new URL(link).search });
      expect(page.statusCode).toBeLessThan(500);
      expect((await confirm(tokenFrom(link))).statusCode).toBe(200);
    });

    it('el pedido público de link sigue venciendo a los 15 minutos', async () => {
      await post('/api/auth/player/request-link', { email: 'publico@jugador.example' });
      const link = env.mailer.lastLinkTo('publico@jugador.example')!;
      env.clock.advance(16 * MINUTE);
      expect((await confirm(tokenFrom(link))).statusCode).toBe(410);
    });
  });
});
