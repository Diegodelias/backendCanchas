import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bookingTestKit } from './booking-helpers.js';
import { createDbTestEnv, waitFor, type DbTestEnv } from './helpers.js';

describe('nombre del sitio', () => {
  let env: DbTestEnv;
  let kit: ReturnType<typeof bookingTestKit>;

  beforeAll(async () => {
    env = await createDbTestEnv();
    kit = bookingTestKit(env);
  });
  afterAll(async () => {
    await env?.close();
  });
  beforeEach(async () => {
    await env.reset();
  });

  const get = () => env.app.inject({ method: 'GET', url: '/api/site' });
  const rename = (name: string) => env.db.query(`UPDATE site_settings SET name = $1`, [name]);

  describe('lectura pública (GET /api/site)', () => {
    it('sin configurar devuelve «Canchas3», sin sesión y sin copia guardada', async () => {
      const res = await get();
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ name: 'Canchas3', logoColor: null });
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('devuelve el nombre guardado', async () => {
      await rename('Club Central');
      expect((await get()).json()).toEqual({ name: 'Club Central', logoColor: null });
    });

    it('si la fila faltara, responde el nombre por defecto en lugar de fallar', async () => {
      await env.db.query(`DELETE FROM site_settings`);
      try {
        const res = await get();
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ name: 'Canchas3', logoColor: null });
      } finally {
        await env.db.query(`INSERT INTO site_settings (name) VALUES ('Canchas3')`);
      }
    });
  });

  describe('edición del superadmin (PUT /api/platform/site)', () => {
    const put = (payload: unknown, cookie?: string) => kit.call('PUT', '/api/platform/site', cookie, payload as object);
    const stored = async () => (await env.db.query<{ name: string }>(`SELECT name FROM site_settings`))[0]!.name;

    it('cambia el nombre, recorta los espacios y lo devuelve; GET /api/site lo refleja', async () => {
      const sa = await kit.loginSuperadmin();
      const res = await put({ name: '  Club Central  ' }, sa);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ name: 'Club Central', logoColor: null });
      expect(await stored()).toBe('Club Central');
      expect((await get()).json()).toEqual({ name: 'Club Central', logoColor: null });
    });

    it('se puede volver a cambiar, también al nombre por defecto', async () => {
      const sa = await kit.loginSuperadmin();
      await put({ name: 'Club Central' }, sa);
      expect((await put({ name: 'Canchas3' }, sa)).statusCode).toBe(200);
      expect((await get()).json()).toEqual({ name: 'Canchas3', logoColor: null });
    });

    it('acepta el largo máximo y rechaza uno más', async () => {
      const sa = await kit.loginSuperadmin();
      expect((await put({ name: 'x'.repeat(40) }, sa)).statusCode).toBe(200);
      const long = await put({ name: 'x'.repeat(41) }, sa);
      expect(long.statusCode).toBe(400);
      expect(long.json().error.code).toBe('validation_error');
      expect(await stored()).toBe('x'.repeat(40));
    });

    it('rechaza un nombre vacío, de solo espacios, con salto de línea o ausente, sin cambiar nada', async () => {
      const sa = await kit.loginSuperadmin();
      const bads = [{ name: '' }, { name: '   ' }, { name: 'Club\nCentral' }, { name: 'Club\r\nCentral' }, {}, { name: 42 }];
      for (const bad of bads) {
        const res = await put(bad, sa);
        expect(res.statusCode, JSON.stringify(bad)).toBe(400);
        expect(res.json().error.code).toBe('validation_error');
      }
      expect(await stored()).toBe('Canchas3');
    });

    it('explica el motivo del rechazo', async () => {
      const sa = await kit.loginSuperadmin();
      expect(JSON.stringify((await put({ name: '' }, sa)).json())).toContain('Poné el nombre del sitio');
      expect(JSON.stringify((await put({ name: 'x'.repeat(41) }, sa)).json())).toContain('hasta 40 caracteres');
    });

    it('sin sesión da 401 y un admin de club o un jugador dan 403, sin cambiar nada', async () => {
      const club = await kit.createClub('test-sitio');
      const admin = await kit.loginAdmin(club);
      const player = await kit.loginPlayer();
      expect((await put({ name: 'Hackeado' })).statusCode).toBe(401);
      expect((await put({ name: 'Hackeado' }, admin)).statusCode).toBe(403);
      expect((await put({ name: 'Hackeado' }, player)).statusCode).toBe(403);
      expect(await stored()).toBe('Canchas3');
    });

    it('guarda el color con el nombre y GET /api/site lo refleja', async () => {
      const sa = await kit.loginSuperadmin();
      const res = await put({ name: 'Club Central', logoColor: 'violeta' }, sa);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ name: 'Club Central', logoColor: 'violeta' });
      expect((await get()).json()).toEqual({ name: 'Club Central', logoColor: 'violeta' });
    });

    it('acepta cada color de la paleta', async () => {
      const sa = await kit.loginSuperadmin();
      for (const logoColor of ['verde', 'azul', 'rojo', 'naranja', 'violeta', 'tinta']) {
        expect((await put({ name: 'Club', logoColor }, sa)).json()).toEqual({ name: 'Club', logoColor });
      }
    });

    it('sin color en el pedido conserva el que había; null vuelve al predeterminado', async () => {
      const sa = await kit.loginSuperadmin();
      await put({ name: 'Club Central', logoColor: 'rojo' }, sa);
      expect((await put({ name: 'Club Norte' }, sa)).json()).toEqual({ name: 'Club Norte', logoColor: 'rojo' });
      expect((await put({ name: 'Club Norte', logoColor: null }, sa)).json()).toEqual({ name: 'Club Norte', logoColor: null });
      expect((await get()).json()).toEqual({ name: 'Club Norte', logoColor: null });
    });

    it('rechaza un color fuera de la paleta sin cambiar nada', async () => {
      const sa = await kit.loginSuperadmin();
      await put({ name: 'Club Central', logoColor: 'azul' }, sa);
      for (const bad of ['#ff0000', 'amarillo', '', 7, 'AZUL']) {
        const res = await put({ name: 'Otro', logoColor: bad }, sa);
        expect(res.statusCode, JSON.stringify(bad)).toBe(400);
        expect(res.json().error.code).toBe('validation_error');
      }
      expect((await get()).json()).toEqual({ name: 'Club Central', logoColor: 'azul' });
    });

    it('un color inválido con un nombre válido no cambia el nombre', async () => {
      const sa = await kit.loginSuperadmin();
      await put({ name: 'Club Central' }, sa);
      expect((await put({ name: 'Otro', logoColor: 'verde-lima' }, sa)).statusCode).toBe(400);
      expect(await stored()).toBe('Club Central');
    });

    it('otros roles no pueden cambiar el color', async () => {
      const club = await kit.createClub('test-sitio-color');
      const admin = await kit.loginAdmin(club);
      expect((await put({ name: 'Canchas3', logoColor: 'rojo' })).statusCode).toBe(401);
      expect((await put({ name: 'Canchas3', logoColor: 'rojo' }, admin)).statusCode).toBe(403);
      expect((await get()).json()).toEqual({ name: 'Canchas3', logoColor: null });
    });

    it('un nombre con símbolos se guarda tal cual, sin interpretarse', async () => {
      const sa = await kit.loginSuperadmin();
      await put({ name: '<b>Club</b> & Co' }, sa);
      expect((await get()).json()).toEqual({ name: '<b>Club</b> & Co', logoColor: null });
    });
  });

  describe('los mails salen con el nombre vigente', () => {
    const post = (url: string, payload: object, cookie?: string) => kit.call('POST', url, cookie, payload);
    const lastMail = async () => {
      await waitFor(() => env.mailer.sent.length > 0);
      return env.mailer.sent[env.mailer.sent.length - 1]!;
    };
    const rename = (name: string) => env.db.query(`UPDATE site_settings SET name = $1`, [name]);

    beforeEach(() => {
      env.mailer.sent.length = 0;
    });

    it('el link de acceso de un jugador: asunto, texto y remitente', async () => {
      await rename('Club Central');
      expect((await post('/api/auth/player/request-link', { email: 'ana@mail.example' })).statusCode).toBe(202);
      const mail = await lastMail();
      expect(mail).toMatchObject({ to: 'ana@mail.example', subject: 'Tu acceso a Club Central', fromName: 'Club Central' });
      expect(mail.text).toContain('Club Central');
      expect(mail.text).not.toContain('Canchas3');
    });

    it('la recuperación de contraseña de un admin', async () => {
      const club = await kit.createClub('test-sitio-mails');
      await kit.loginAdmin(club);
      await rename('Club Central');
      await post('/api/auth/admin/request-reset', { email: `admin@${club}.example` });
      const mail = await lastMail();
      expect(mail).toMatchObject({ subject: 'Restablecé tu contraseña de Club Central', fromName: 'Club Central' });
      expect(mail.text).toContain('administrador de Club Central');
    });

    it('la invitación de un admin de club', async () => {
      const club = await kit.createClub('test-sitio-mails');
      const sa = await kit.loginSuperadmin();
      await rename('Club Central');
      const res = await post(`/api/platform/clubs/${club}/admins`, { email: 'nuevo@club.example', name: 'Ana Pérez' }, sa);
      expect(res.statusCode).toBe(201);
      const mail = await lastMail();
      expect(mail).toMatchObject({ to: 'nuevo@club.example', subject: `Te invitaron a administrar Club ${club} en Club Central`, fromName: 'Club Central' });
      expect(mail.text).toContain('en Club Central.');
    });

    it('el acceso de un jugador creado por un admin, cuando se pide el mail', async () => {
      const sa = await kit.loginSuperadmin();
      await rename('Club Central');
      const res = await post('/api/platform/players', { email: 'demo@mail.example', sendEmail: true }, sa);
      expect(res.statusCode).toBe(201);
      expect(await lastMail()).toMatchObject({ subject: 'Tu acceso a Club Central', fromName: 'Club Central' });
    });

    it('un cambio entre dos envíos se refleja en el segundo, y sin cambiar sale «Canchas3»', async () => {
      await post('/api/auth/player/request-link', { email: 'uno@mail.example' });
      expect(await lastMail()).toMatchObject({ subject: 'Tu acceso a Canchas3', fromName: 'Canchas3' });

      env.mailer.sent.length = 0;
      const sa = await kit.loginSuperadmin();
      expect((await kit.call('PUT', '/api/platform/site', sa, { name: 'Club Central' })).statusCode).toBe(200);
      await post('/api/auth/player/request-link', { email: 'dos@mail.example' });
      expect(await lastMail()).toMatchObject({ to: 'dos@mail.example', subject: 'Tu acceso a Club Central' });
    });

    it('un nombre con símbolos no se interpreta como código en el HTML del mail', async () => {
      await rename('<b>Club</b> & Co');
      await post('/api/auth/player/request-link', { email: 'ana@mail.example' });
      const mail = await lastMail();
      expect(mail.html).not.toContain('<b>Club</b>');
      expect(mail.html).toContain('&lt;b&gt;Club&lt;/b&gt; &amp; Co');
    });
  });

  describe('restricciones de la base', () => {
    it('hay una sola fila y no admite una segunda', async () => {
      expect(await env.db.query(`SELECT 1 FROM site_settings`)).toHaveLength(1);
      await expect(env.db.query(`INSERT INTO site_settings (name) VALUES ('Otro')`)).rejects.toThrow(/site_settings_pkey|duplicate key/);
      await expect(env.db.query(`INSERT INTO site_settings (id, name) VALUES (false, 'Otro')`)).rejects.toThrow(/site_settings_single_row/);
    });

    it('rechaza un nombre vacío, de más de 40 caracteres, con espacios al borde o con salto de línea', async () => {
      for (const bad of ['', 'x'.repeat(41), ' Club', 'Club ', 'Club\nCentral', 'Club\rCentral']) {
        await expect(rename(bad), JSON.stringify(bad)).rejects.toThrow(/site_settings_name_check/);
      }
      expect((await get()).json()).toEqual({ name: 'Canchas3', logoColor: null });
    });

    it('rechaza una clave de color fuera de la paleta y acepta nulo', async () => {
      const setColor = (value: string | null) => env.db.query(`UPDATE site_settings SET logo_color = $1`, [value]);
      for (const bad of ['', 'amarillo', 'AZUL', '#fff']) {
        await expect(setColor(bad), bad).rejects.toThrow(/site_settings_logo_color_check/);
      }
      await setColor('azul');
      await setColor(null);
      expect((await get()).json()).toEqual({ name: 'Canchas3', logoColor: null });
    });

    it('acepta el largo máximo y los números, tildes y símbolos del nombre', async () => {
      for (const ok of ['x'.repeat(40), 'Cancha7', 'Canchas del Sur & Co.', 'Ñandú Fútbol']) {
        await rename(ok);
        expect((await get()).json()).toEqual({ name: ok, logoColor: null });
      }
    });
  });
});
