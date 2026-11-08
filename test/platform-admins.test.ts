import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAdmin, createSuperadmin } from '../src/modules/auth/admins.js';
import { SESSION_COOKIE } from '../src/modules/auth/sessions.js';
import { createDbTestEnv, sleep, waitFor, type DbTestEnv } from './helpers.js';

const PASSWORD = 'clave-de-prueba-123';
const SUPER = { email: 'root@canchas3.example', name: 'Root', password: 'clave-de-super-123' };
const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

describe('plataforma: invitar admins de club', () => {
  let env: DbTestEnv;
  let sa: string;
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
    await createSuperadmin(env.db, SUPER);
    const res = await env.app.inject({ method: 'POST', url: '/api/auth/admin/login', payload: { email: SUPER.email, password: SUPER.password } });
    sa = res.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
  });

  const body = (res: LightMyRequestResponse) => res.json();
  const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, cookie?: string, payload?: object) =>
    env.app.inject({ method, url, cookies: cookie ? { [SESSION_COOKIE]: cookie } : {}, ...(payload ? { payload } : {}) });
  const invite = (clubId: string, email: string, name = 'Ana Pérez', cookie: string | undefined = sa) =>
    call('POST', `/api/platform/clubs/${clubId}/admins`, cookie, { email, name });
  /** El superadmin vuelve a ingresar (su sesión vence a las 8 horas, y algunos tests adelantan el reloj días). */
  async function relogin() {
    const res = await env.app.inject({ method: 'POST', url: '/api/auth/admin/login', payload: { email: SUPER.email, password: SUPER.password } });
    sa = res.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
  }
  const userByEmail = async (email: string) =>
    (await env.db.query<{ id: string; role: string; club_id: string | null; name: string | null; password_hash: string | null; deactivated_at: Date | null }>(
      `SELECT id, role, club_id, name, password_hash, deactivated_at FROM users WHERE lower(email) = lower($1)`, [email]))[0];
  const countUsers = async () => (await env.db.query(`SELECT 1 FROM users`)).length;

  async function createClub(id: string) {
    await env.db.query(`INSERT INTO clubs (id, name, zone, city, address) VALUES ($1, $2, 'Zona', 'buenos-aires', 'Calle 123')`, [id, `Club ${id}`]);
    return id;
  }
  async function loginPlayer(email = 'jugador@mail.example'): Promise<string> {
    await env.app.inject({ method: 'POST', url: '/api/auth/player/request-link', payload: { email } });
    await waitFor(() => env.mailer.lastLinkTo(email) !== null);
    const token = new URL(env.mailer.lastLinkTo(email)!).searchParams.get('token')!;
    const res = await env.app.inject({ method: 'POST', url: '/api/auth/player/confirm', payload: { token } });
    return res.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
  }

  describe('invitar', () => {
    it('crea la cuenta del club sin contraseña (Invitado) y le manda el mail de invitación', async () => {
      const club = await createClub('test-invita');
      const res = await invite(club, 'ana@club.example');
      expect(res.statusCode).toBe(201);
      expect(body(res).emailSent).toBe(true);
      expect(body(res).admin).toMatchObject({ email: 'ana@club.example', name: 'Ana Pérez', status: 'invited', invitationExpired: false });
      expect(JSON.stringify(body(res))).not.toMatch(/password|hash|token/i);

      expect(await userByEmail('ana@club.example')).toMatchObject({ role: 'club_admin', club_id: club, name: 'Ana Pérez', password_hash: null, deactivated_at: null });
      expect(env.mailer.sent).toHaveLength(1);
      expect(env.mailer.sent[0]!.to).toBe('ana@club.example');
      expect(env.mailer.sent[0]!.subject).toBe('Te invitaron a administrar Club test-invita en Canchas3');
      expect(env.mailer.lastLinkTo('ana@club.example')).toMatch(/^http:\/\/localhost:3000\/invitacion\?token=[\w-]{20,}$/);
    });

    it('guarda solo el hash del link y vence a las 72 horas', async () => {
      const club = await createClub('test-link');
      await invite(club, 'ana@club.example');
      const token = new URL(env.mailer.lastLinkTo('ana@club.example')!).searchParams.get('token')!;
      const [row] = await env.db.query<{ token_hash: string; purpose: string; expires_at: Date; created_at: Date }>(
        `SELECT token_hash, purpose, expires_at, created_at FROM login_tokens WHERE email = 'ana@club.example'`,
      );
      expect(row!.purpose).toBe('admin_invite');
      expect(row!.token_hash).not.toBe(token);
      expect(new Date(row!.expires_at).getTime() - new Date(row!.created_at).getTime()).toBe(72 * HOUR);
    });

    it('un club puede tener varios admins', async () => {
      const club = await createClub('test-varios');
      expect((await invite(club, 'uno@club.example', 'Uno')).statusCode).toBe(201);
      expect((await invite(club, 'dos@club.example', 'Dos')).statusCode).toBe(201);
      expect(await env.db.query(`SELECT 1 FROM users WHERE club_id = $1`, [club])).toHaveLength(2);
    });

    it('el mail no distingue mayúsculas y se guarda en minúsculas', async () => {
      const club = await createClub('test-mayus');
      await invite(club, 'ANA@Club.Example');
      expect(await userByEmail('ana@club.example')).toBeDefined();
      expect((await invite(club, 'ana@club.example')).statusCode).toBe(409);
    });

    it.each([
      ['un texto que no es un mail', { email: 'no-es-un-mail', name: 'Ana' }],
      ['un nombre vacío', { email: 'ana@club.example', name: '   ' }],
      ['un pedido sin nombre', { email: 'ana@club.example' }],
      ['un nombre de más de 120 caracteres', { email: 'ana@club.example', name: 'x'.repeat(121) }],
    ])('rechaza %s y no crea ninguna cuenta ni manda mail', async (_label, payload) => {
      const club = await createClub('test-invalida');
      const res = await call('POST', `/api/platform/clubs/${club}/admins`, sa, payload);
      expect(res.statusCode).toBe(400);
      expect(body(res).error.code).toBe('validation_error');
      expect(await countUsers()).toBe(1); // solo el superadmin
      expect(env.mailer.sent).toHaveLength(0);
    });

    it('un club que no existe responde 404 y no crea nada', async () => {
      const res = await invite('test-no-existe', 'ana@club.example');
      expect(res.statusCode).toBe(404);
      expect(await countUsers()).toBe(1);
      expect(env.mailer.sent).toHaveLength(0);
    });

    it('invitar a un club desactivado también funciona', async () => {
      const club = await createClub('test-club-off');
      await env.db.query(`UPDATE clubs SET active = false WHERE id = $1`, [club]);
      expect((await invite(club, 'ana@club.example')).statusCode).toBe(201);
    });
  });

  describe('mails que no se pueden invitar', () => {
    it('el de un admin activo o invitado, de este club o de otro, se rechaza sin enviar nada', async () => {
      const a = await createClub('test-a');
      const b = await createClub('test-b');
      await createAdmin(env.db, { email: 'activo@club.example', name: 'Activo', clubId: a, password: PASSWORD });
      await invite(a, 'invitado@club.example');
      env.mailer.sent.length = 0;
      const users = await countUsers();

      for (const [club, email] of [[a, 'activo@club.example'], [b, 'activo@club.example'], [a, 'invitado@club.example'], [b, 'invitado@club.example']] as const) {
        const res = await invite(club, email);
        expect(res.statusCode, `${club} ${email}`).toBe(409);
        expect(body(res).error.code).toBe('email_is_admin');
        expect(body(res).error.message).toContain('ya es de un administrador');
      }
      expect(env.mailer.sent).toHaveLength(0);
      expect(await countUsers()).toBe(users);
    });

    it('el de un jugador se rechaza, la cuenta del jugador no cambia y no se envía nada', async () => {
      const club = await createClub('test-jugador');
      await loginPlayer('jugador@mail.example');
      env.mailer.sent.length = 0;

      const res = await invite(club, 'jugador@mail.example');
      expect(res.statusCode).toBe(409);
      expect(body(res).error.code).toBe('email_is_player');
      expect(body(res).error.message).toContain('cuenta de jugador');
      expect(await userByEmail('jugador@mail.example')).toMatchObject({ role: 'player', club_id: null });
      expect(env.mailer.sent).toHaveLength(0);
    });

    it('el del propio superadmin se rechaza', async () => {
      const club = await createClub('test-super');
      const res = await invite(club, SUPER.email);
      expect(res.statusCode).toBe(409);
      expect(await userByEmail(SUPER.email)).toMatchObject({ role: 'superadmin' });
    });

    it('el de un admin dado de baja de otro club se rechaza y no se toca la cuenta', async () => {
      const a = await createClub('test-baja-a');
      const b = await createClub('test-baja-b');
      await createAdmin(env.db, { email: 'baja@club.example', name: 'Baja', clubId: a, password: PASSWORD });
      await env.db.query(`UPDATE users SET deactivated_at = now() WHERE email = 'baja@club.example'`);
      env.mailer.sent.length = 0;

      const res = await invite(b, 'baja@club.example');
      expect(res.statusCode).toBe(409);
      expect(body(res).error.code).toBe('email_other_club');
      expect(body(res).error.message).toContain('otro club');
      expect(await userByEmail('baja@club.example')).toMatchObject({ club_id: a });
      expect((await userByEmail('baja@club.example'))!.deactivated_at).not.toBeNull();
      expect(env.mailer.sent).toHaveLength(0);
    });
  });

  describe('reinvitar a un admin dado de baja del mismo club', () => {
    it('lo reactiva sin contraseña, con el nombre nuevo y una invitación nueva', async () => {
      const club = await createClub('test-reinvita');
      await createAdmin(env.db, { email: 'vuelve@club.example', name: 'Nombre Viejo', clubId: club, password: PASSWORD });
      const before = await userByEmail('vuelve@club.example');
      await env.db.query(`UPDATE users SET deactivated_at = now() WHERE email = 'vuelve@club.example'`);

      const res = await invite(club, 'VUELVE@club.example', 'Nombre Nuevo');
      expect(res.statusCode).toBe(201);
      expect(body(res).admin).toMatchObject({ id: before!.id, name: 'Nombre Nuevo', status: 'invited' });
      expect(await userByEmail('vuelve@club.example')).toMatchObject({ id: before!.id, club_id: club, name: 'Nombre Nuevo', password_hash: null, deactivated_at: null });
      expect(env.mailer.sent).toHaveLength(1);
      expect(env.mailer.lastLinkTo('vuelve@club.example')).toContain('/invitacion?token=');

      // La contraseña vieja ya no sirve: la cuenta vuelve a estar invitada.
      const login = await env.app.inject({ method: 'POST', url: '/api/auth/admin/login', payload: { email: 'vuelve@club.example', password: PASSWORD } });
      expect(login.statusCode).toBe(401);
    });
  });

  describe('si falla el envío del mail', () => {
    it('la cuenta queda creada como Invitado, la respuesta avisa y el link no va al log', async () => {
      const club = await createClub('test-falla-mail');
      env.mailer.failWith = Object.assign(new Error('SMTP caído'), { code: 'ECONNREFUSED' });

      const res = await invite(club, 'ana@club.example');
      expect(res.statusCode).toBe(201);
      expect(body(res).emailSent).toBe(false);
      expect(body(res).admin).toMatchObject({ status: 'invited' });
      expect(await userByEmail('ana@club.example')).toMatchObject({ password_hash: null, club_id: club });

      const logText = logs.join('\n');
      expect(logText).toContain('No se pudo enviar el mail de invitación');
      expect(logText).toContain('ECONNREFUSED');
      expect(logText).not.toMatch(/invitacion\?token=/);
      expect(logText).not.toContain('ana@club.example');
      env.mailer.failWith = null;
    });

    it('la respuesta no muestra el link ni datos del servidor de mail', async () => {
      const club = await createClub('test-falla-mail-2');
      env.mailer.failWith = new Error('535 credenciales inválidas del servidor smtp.secreto.example');
      const text = (await invite(club, 'ana@club.example')).body;
      expect(text).not.toContain('smtp.secreto');
      expect(text).not.toContain('invitacion?token');
      env.mailer.failWith = null;
    });
  });

  describe('límite de envíos', () => {
    it('rechaza el 4.º envío al mismo mail en 15 minutos sin crear la cuenta ni mandar mail', async () => {
      const club = await createClub('test-limite');
      const at = env.clock.now();
      for (let i = 0; i < 3; i++) {
        await env.db.query(`INSERT INTO link_requests (purpose, email, ip, requested_at) VALUES ('admin_invite', 'ana@club.example', '1.1.1.1', $1)`, [at]);
      }
      const res = await invite(club, 'ana@club.example');
      expect(res.statusCode).toBe(429);
      expect(body(res).error.code).toBe('too_many_requests');
      expect(await userByEmail('ana@club.example')).toBeUndefined();
      expect(env.mailer.sent).toHaveLength(0);

      // Otro mail no se ve afectado, y a los 15 minutos el mismo mail vuelve a poder.
      expect((await invite(club, 'otro@club.example')).statusCode).toBe(201);
      env.clock.advance(15 * MINUTE + 1000);
      expect((await invite(club, 'ana@club.example')).statusCode).toBe(201);
    });

    it('el límite es independiente del de los links de acceso y de recuperación', async () => {
      const club = await createClub('test-limite-indep');
      const at = env.clock.now();
      for (const purpose of ['access', 'password_reset']) {
        for (let i = 0; i < 3; i++) {
          await env.db.query(`INSERT INTO link_requests (purpose, email, ip, requested_at) VALUES ($1, 'ana@club.example', '1.1.1.1', $2)`, [purpose, at]);
        }
      }
      expect((await invite(club, 'ana@club.example')).statusCode).toBe(201);
    });
  });

  describe('permisos', () => {
    it('un admin de club o un jugador reciben 403, sin sesión 401, y no se crea nada', async () => {
      const club = await createClub('test-perm');
      await createAdmin(env.db, { email: 'admin@club.example', name: 'Admin', clubId: club, password: PASSWORD });
      const adminRes = await env.app.inject({ method: 'POST', url: '/api/auth/admin/login', payload: { email: 'admin@club.example', password: PASSWORD } });
      const admin = adminRes.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
      const player = await loginPlayer();
      env.mailer.sent.length = 0;
      const users = await countUsers();

      expect((await invite(club, 'nuevo@club.example', 'N', admin)).statusCode).toBe(403);
      expect((await invite(club, 'nuevo@club.example', 'N', player)).statusCode).toBe(403);
      expect((await call('POST', `/api/platform/clubs/${club}/admins`, undefined, { email: 'nuevo@club.example', name: 'N' })).statusCode).toBe(401);
      await sleep(100);
      expect(await countUsers()).toBe(users);
      expect(env.mailer.sent).toHaveLength(0);
    });
  });

  describe('lista de admins y estados', () => {
    const list = async (clubId: string, cookie: string | undefined = sa) => call('GET', `/api/platform/clubs/${clubId}/admins`, cookie);
    const adminId = async (email: string) => (await userByEmail(email))!.id;

    it('muestra a cada admin con su estado: Activo, Invitado (con aviso si venció) y Dado de baja', async () => {
      const club = await createClub('test-estados');
      await createAdmin(env.db, { email: 'activo@club.example', name: 'Activo', clubId: club, password: PASSWORD });
      await invite(club, 'vigente@club.example', 'Vigente');
      await createAdmin(env.db, { email: 'baja@club.example', name: 'Baja', clubId: club, password: PASSWORD });
      await env.db.query(`UPDATE users SET deactivated_at = now() WHERE email = 'baja@club.example'`);
      await invite(club, 'vencida@club.example', 'Vencida');
      // La invitación de «vencida» venció; la de «vigente» se renueva para que siga viva.
      env.clock.advance(73 * HOUR);
      await relogin();
      await env.db.query(`UPDATE login_tokens SET expires_at = $1 WHERE lower(email) = 'vigente@club.example'`, [new Date(env.clock.now().getTime() + HOUR)]);

      const res = await list(club);
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(body(res).club).toEqual({ id: club, name: `Club ${club}` });
      const byEmail = Object.fromEntries(body(res).admins.map((a: { email: string }) => [a.email, a]));
      expect(byEmail['activo@club.example']).toMatchObject({ name: 'Activo', status: 'active', invitationExpired: false });
      expect(byEmail['vigente@club.example']).toMatchObject({ status: 'invited', invitationExpired: false });
      expect(byEmail['vencida@club.example']).toMatchObject({ status: 'invited', invitationExpired: true });
      expect(byEmail['baja@club.example']).toMatchObject({ status: 'deactivated', invitationExpired: false });
    });

    it('no incluye admins de otros clubes ni expone contraseñas, hashes o links', async () => {
      const a = await createClub('test-lista-a');
      const b = await createClub('test-lista-b');
      await createAdmin(env.db, { email: 'a@club.example', name: 'A', clubId: a, password: PASSWORD });
      await createAdmin(env.db, { email: 'b@club.example', name: 'B', clubId: b, password: PASSWORD });
      await invite(a, 'inv@club.example');

      const res = await list(a);
      expect(body(res).admins.map((x: { email: string }) => x.email)).toEqual(['a@club.example', 'inv@club.example']);
      expect(res.body).not.toMatch(/password|hash|token|argon2/i);
    });

    it('un club sin admins devuelve la lista vacía; uno inexistente, 404', async () => {
      const club = await createClub('test-sin-admins');
      expect(body(await list(club)).admins).toEqual([]);
      expect((await list('test-no-existe')).statusCode).toBe(404);
    });

    it('cuando un admin elige su contraseña la lista lo pasa a Activo', async () => {
      const club = await createClub('test-pasa-activo');
      await invite(club, 'ana@club.example');
      const token = new URL(env.mailer.lastLinkTo('ana@club.example')!).searchParams.get('token')!;
      await env.app.inject({ method: 'POST', url: '/api/auth/admin/accept-invite', payload: { token, password: 'contraseña-nueva-456' } });
      expect(body(await list(club)).admins[0]).toMatchObject({ email: 'ana@club.example', status: 'active', invitationExpired: false });
    });

    it('un admin o un jugador reciben 403 y sin sesión 401', async () => {
      const club = await createClub('test-lista-perm');
      await createAdmin(env.db, { email: 'admin@club.example', name: 'A', clubId: club, password: PASSWORD });
      const admin = (await env.app.inject({ method: 'POST', url: '/api/auth/admin/login', payload: { email: 'admin@club.example', password: PASSWORD } })).cookies.find((c) => c.name === SESSION_COOKIE)!.value;
      expect((await list(club, admin)).statusCode).toBe(403);
      expect((await list(club, await loginPlayer())).statusCode).toBe(403);
      expect((await call('GET', `/api/platform/clubs/${club}/admins`)).statusCode).toBe(401);
    });

    it('el id del admin que devuelve sirve para reenviar y dar de baja', async () => {
      const club = await createClub('test-ids');
      await invite(club, 'ana@club.example');
      expect(body(await list(club)).admins[0].id).toBe(await adminId('ana@club.example'));
    });
  });

  describe('reenviar la invitación', () => {
    const resend = (clubId: string, id: string, cookie: string | undefined = sa) =>
      call('POST', `/api/platform/clubs/${clubId}/admins/${id}/invitation`, cookie);
    const linkOf = (email: string) => new URL(env.mailer.lastLinkTo(email)!).searchParams.get('token')!;
    const accept = (token: string) =>
      env.app.inject({ method: 'POST', url: '/api/auth/admin/accept-invite', payload: { token, password: 'contraseña-nueva-456' } });

    it('a un Invitado le llega un mail con un link nuevo, y el link viejo deja de servir', async () => {
      const club = await createClub('test-reenvio');
      await invite(club, 'ana@club.example');
      const old = linkOf('ana@club.example');

      const res = await resend(club, (await userByEmail('ana@club.example'))!.id);
      expect(res.statusCode).toBe(200);
      expect(body(res)).toMatchObject({ emailSent: true, admin: { email: 'ana@club.example', status: 'invited', invitationExpired: false } });
      expect(env.mailer.sent).toHaveLength(2);
      const fresh = linkOf('ana@club.example');
      expect(fresh).not.toBe(old);

      expect((await accept(old)).statusCode).toBe(410);
      expect((await accept(fresh)).statusCode).toBe(200);
    });

    it('si la invitación venció, el reenvío genera una de 72 horas desde ahora', async () => {
      const club = await createClub('test-reenvio-vencida');
      await invite(club, 'ana@club.example');
      env.clock.advance(80 * HOUR);
      await relogin();
      const id = (await userByEmail('ana@club.example'))!.id;
      expect(body(await call('GET', `/api/platform/clubs/${club}/admins`, sa)).admins[0].invitationExpired).toBe(true);

      expect((await resend(club, id)).statusCode).toBe(200);
      expect(body(await call('GET', `/api/platform/clubs/${club}/admins`, sa)).admins[0].invitationExpired).toBe(false);
      expect((await accept(linkOf('ana@club.example'))).statusCode).toBe(200);
    });

    it('a un admin Activo o dado de baja se rechaza con 409 y no se envía nada', async () => {
      const club = await createClub('test-reenvio-no');
      await createAdmin(env.db, { email: 'activo@club.example', name: 'A', clubId: club, password: PASSWORD });
      await createAdmin(env.db, { email: 'baja@club.example', name: 'B', clubId: club, password: PASSWORD });
      await env.db.query(`UPDATE users SET deactivated_at = now() WHERE email = 'baja@club.example'`);

      for (const email of ['activo@club.example', 'baja@club.example']) {
        const res = await resend(club, (await userByEmail(email))!.id);
        expect(res.statusCode, email).toBe(409);
        expect(body(res).error.code).toBe('admin_not_invited');
      }
      expect(env.mailer.sent).toHaveLength(0);
    });

    it('un admin de otro club, un id inexistente o inválido y un club inexistente responden 404', async () => {
      const a = await createClub('test-reenvio-a');
      const b = await createClub('test-reenvio-b');
      await invite(b, 'ana@club.example');
      env.mailer.sent.length = 0;
      const id = (await userByEmail('ana@club.example'))!.id;

      expect((await resend(a, id)).statusCode).toBe(404);
      expect((await resend(a, '00000000-0000-0000-0000-000000000000')).statusCode).toBe(404);
      expect((await resend(a, 'no-es-un-uuid')).statusCode).toBe(404);
      expect((await resend('test-no-existe', id)).statusCode).toBe(404);
      expect(env.mailer.sent).toHaveLength(0);
    });

    it('el 4.º envío al mismo mail en 15 minutos se rechaza (la invitación cuenta como el primero)', async () => {
      const club = await createClub('test-reenvio-limite');
      await invite(club, 'ana@club.example'); // 1
      const id = (await userByEmail('ana@club.example'))!.id;
      expect((await resend(club, id)).statusCode).toBe(200); // 2
      expect((await resend(club, id)).statusCode).toBe(200); // 3
      env.mailer.sent.length = 0;

      const blocked = await resend(club, id); // 4
      expect(blocked.statusCode).toBe(429);
      expect(body(blocked).error.code).toBe('too_many_requests');
      expect(env.mailer.sent).toHaveLength(0);

      env.clock.advance(15 * MINUTE + 1000);
      expect((await resend(club, id)).statusCode).toBe(200);
    });

    it('si falla el envío, avisa y se puede reintentar', async () => {
      const club = await createClub('test-reenvio-falla');
      await invite(club, 'ana@club.example');
      const id = (await userByEmail('ana@club.example'))!.id;

      env.mailer.failWith = new Error('SMTP caído');
      const failed = await resend(club, id);
      expect(failed.statusCode).toBe(200);
      expect(body(failed).emailSent).toBe(false);
      env.mailer.failWith = null;

      const retry = await resend(club, id);
      expect(body(retry).emailSent).toBe(true);
    });

    it('un admin o un jugador reciben 403 y sin sesión 401', async () => {
      const club = await createClub('test-reenvio-perm');
      await invite(club, 'ana@club.example');
      env.mailer.sent.length = 0;
      const id = (await userByEmail('ana@club.example'))!.id;
      expect((await resend(club, id, await loginPlayer())).statusCode).toBe(403);
      expect((await call('POST', `/api/platform/clubs/${club}/admins/${id}/invitation`)).statusCode).toBe(401);
      expect(env.mailer.sent).toHaveLength(1); // solo el mail del login del jugador
    });
  });

  describe('dar de baja a un admin', () => {
    const remove = (clubId: string, id: string, cookie: string | undefined = sa) =>
      call('DELETE', `/api/platform/clubs/${clubId}/admins/${id}`, cookie);
    const adminLogin = (email: string, password = PASSWORD) =>
      env.app.inject({ method: 'POST', url: '/api/auth/admin/login', payload: { email, password } });
    const sessionCount = async (email: string) =>
      (await env.db.query(`SELECT 1 FROM sessions s JOIN users u ON u.id = s.user_id WHERE lower(u.email) = lower($1)`, [email])).length;

    it('marca la baja, cierra todas sus sesiones y no lo deja ingresar, pero conserva la cuenta', async () => {
      const club = await createClub('test-baja');
      await createAdmin(env.db, { email: 'baja@club.example', name: 'Baja', clubId: club, password: PASSWORD });
      const s1 = (await adminLogin('baja@club.example')).cookies.find((c) => c.name === SESSION_COOKIE)!.value;
      const s2 = (await adminLogin('baja@club.example')).cookies.find((c) => c.name === SESSION_COOKIE)!.value;
      expect(await sessionCount('baja@club.example')).toBe(2);
      const id = (await userByEmail('baja@club.example'))!.id;

      expect((await remove(club, id)).statusCode).toBe(204);

      expect(await sessionCount('baja@club.example')).toBe(0);
      for (const cookie of [s1, s2]) {
        const me = await call('GET', '/api/auth/me', cookie);
        expect(me.json()).toEqual({ user: null });
      }
      const login = await adminLogin('baja@club.example');
      expect(login.statusCode).toBe(401);
      expect(login.json().error.code).toBe('invalid_credentials');
      const row = (await userByEmail('baja@club.example'))!;
      expect(row.deactivated_at).not.toBeNull();
      expect(row.club_id).toBe(club);
      expect(row.password_hash).not.toBeNull();
      expect(body(await call('GET', `/api/platform/clubs/${club}/admins`, sa)).admins[0]).toMatchObject({ status: 'deactivated' });
    });

    it('un admin con sesión abierta deja de poder usar su panel al instante', async () => {
      const club = await createClub('test-baja-panel');
      await createAdmin(env.db, { email: 'baja@club.example', name: 'Baja', clubId: club, password: PASSWORD });
      const cookie = (await adminLogin('baja@club.example')).cookies.find((c) => c.name === SESSION_COOKIE)!.value;
      expect((await call('GET', '/api/club/courts', cookie)).statusCode).toBe(200);
      await remove(club, (await userByEmail('baja@club.example'))!.id);
      expect((await call('GET', '/api/club/courts', cookie)).statusCode).toBe(401);
    });

    it('la recuperación de contraseña deja de enviarse y responde igual que para cualquier mail', async () => {
      const club = await createClub('test-baja-recuperar');
      await createAdmin(env.db, { email: 'baja@club.example', name: 'Baja', clubId: club, password: PASSWORD });
      await remove(club, (await userByEmail('baja@club.example'))!.id);
      env.mailer.sent.length = 0;

      const baja = await env.app.inject({ method: 'POST', url: '/api/auth/admin/request-reset', payload: { email: 'baja@club.example' } });
      const nobody = await env.app.inject({ method: 'POST', url: '/api/auth/admin/request-reset', payload: { email: 'nadie@club.example' } });
      expect(baja.statusCode).toBe(202);
      expect(baja.json()).toEqual(nobody.json());
      await sleep(150);
      expect(env.mailer.sent).toHaveLength(0);
    });

    it('a un Invitado lo da de baja y su link de invitación deja de existir', async () => {
      const club = await createClub('test-baja-invitado');
      await invite(club, 'ana@club.example');
      const token = new URL(env.mailer.lastLinkTo('ana@club.example')!).searchParams.get('token')!;

      expect((await remove(club, (await userByEmail('ana@club.example'))!.id)).statusCode).toBe(204);
      expect(await env.db.query(`SELECT 1 FROM login_tokens WHERE lower(email) = 'ana@club.example'`)).toHaveLength(0);
      const accept = await env.app.inject({ method: 'POST', url: '/api/auth/admin/accept-invite', payload: { token, password: 'contraseña-nueva-456' } });
      expect(accept.statusCode).toBe(410);
    });

    it('después se lo puede reinvitar a este club, pero no a otro', async () => {
      const a = await createClub('test-baja-a');
      const b = await createClub('test-baja-b');
      await createAdmin(env.db, { email: 'baja@club.example', name: 'Baja', clubId: a, password: PASSWORD });
      await remove(a, (await userByEmail('baja@club.example'))!.id);

      expect((await invite(b, 'baja@club.example')).statusCode).toBe(409);
      const again = await invite(a, 'baja@club.example', 'Vuelve');
      expect(again.statusCode).toBe(201);
      expect(body(again).admin.status).toBe('invited');
    });

    it('dar de baja dos veces, a un admin de otro club o a un id inexistente responde 404', async () => {
      const a = await createClub('test-baja-404-a');
      const b = await createClub('test-baja-404-b');
      await createAdmin(env.db, { email: 'uno@club.example', name: 'Uno', clubId: a, password: PASSWORD });
      await createAdmin(env.db, { email: 'dos@club.example', name: 'Dos', clubId: b, password: PASSWORD });
      const uno = (await userByEmail('uno@club.example'))!.id;
      const dos = (await userByEmail('dos@club.example'))!.id;

      expect((await remove(a, uno)).statusCode).toBe(204);
      expect((await remove(a, uno)).statusCode).toBe(404);
      expect((await remove(a, dos)).statusCode).toBe(404);
      expect((await remove(a, '00000000-0000-0000-0000-000000000000')).statusCode).toBe(404);
      expect((await remove(a, 'no-es-un-uuid')).statusCode).toBe(404);
      expect((await userByEmail('dos@club.example'))!.deactivated_at).toBeNull();
    });

    it('no se puede dar de baja a un jugador ni al superadmin por esta ruta', async () => {
      const club = await createClub('test-baja-roles');
      await loginPlayer('jugador@mail.example');
      for (const email of ['jugador@mail.example', SUPER.email]) {
        const id = (await userByEmail(email))!.id;
        expect((await remove(club, id)).statusCode, email).toBe(404);
        expect((await userByEmail(email))!.deactivated_at).toBeNull();
      }
    });

    it('la baja no cambia el conteo de otros admins y la cantidad de admins del club baja', async () => {
      const club = await createClub('test-baja-conteo');
      await createAdmin(env.db, { email: 'uno@club.example', name: 'Uno', clubId: club, password: PASSWORD });
      await createAdmin(env.db, { email: 'dos@club.example', name: 'Dos', clubId: club, password: PASSWORD });
      const summary = async () => (body(await call('GET', '/api/platform/clubs?q=test-baja-conteo', sa)).clubs[0] as { admins: number }).admins;
      // El nombre del club es «Club test-baja-conteo», así que la búsqueda por ese texto lo encuentra.
      expect(await summary()).toBe(2);
      await remove(club, (await userByEmail('uno@club.example'))!.id);
      expect(await summary()).toBe(1);
    });

    it('un admin o un jugador reciben 403 y sin sesión 401, y no se modifica nada', async () => {
      const club = await createClub('test-baja-perm');
      await createAdmin(env.db, { email: 'objetivo@club.example', name: 'O', clubId: club, password: PASSWORD });
      await createAdmin(env.db, { email: 'otro@club.example', name: 'Otro', clubId: club, password: PASSWORD });
      const id = (await userByEmail('objetivo@club.example'))!.id;
      const otroCookie = (await adminLogin('otro@club.example')).cookies.find((c) => c.name === SESSION_COOKIE)!.value;

      expect((await remove(club, id, otroCookie)).statusCode).toBe(403);
      expect((await remove(club, id, await loginPlayer())).statusCode).toBe(403);
      expect((await call('DELETE', `/api/platform/clubs/${club}/admins/${id}`)).statusCode).toBe(401);
      expect((await userByEmail('objetivo@club.example'))!.deactivated_at).toBeNull();
    });
  });
});
