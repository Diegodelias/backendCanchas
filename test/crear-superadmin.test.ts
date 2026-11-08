import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AdminInputError, createAdmin, createSuperadmin } from '../src/modules/auth/admins.js';
import { createDbTestEnv, type DbTestEnv } from './helpers.js';

const backendDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const SUPER = {
  email: 'root@canchas3.example',
  name: 'Operación Canchas3',
  password: 'clave-super-larga-789',
};

describe('crear superadmin', () => {
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

  const count = async () => (await env.db.query('SELECT 1 FROM users')).length;

  const runCommand = (args: string[], password: string | undefined = SUPER.password) =>
    spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/crear-superadmin.ts', ...args], {
      cwd: backendDir,
      env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL, ...(password ? { ADMIN_PASSWORD: password } : {}) },
      input: '',
      encoding: 'utf8',
    });

  it('crea el superadmin sin club y luego puede ingresar', async () => {
    const created = await createSuperadmin(env.db, SUPER);
    expect(created).toMatchObject({ email: SUPER.email, name: SUPER.name, role: 'superadmin', clubId: null });

    const res = await env.app.inject({
      method: 'POST',
      url: '/api/auth/admin/login',
      payload: { email: SUPER.email, password: SUPER.password },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toMatchObject({ role: 'superadmin', clubId: null });
  });

  it('guarda solo el hash de la contraseña', async () => {
    await createSuperadmin(env.db, SUPER);
    const [row] = await env.db.query<{ password_hash: string }>('SELECT password_hash FROM users');
    expect(row!.password_hash.startsWith('$argon2id$')).toBe(true);
    expect(row!.password_hash).not.toContain(SUPER.password);
  });

  it('rechaza un mail repetido, sin importar mayúsculas ni el rol de la cuenta existente', async () => {
    await createAdmin(env.db, { email: 'ana@club.example', name: 'Ana', clubId: 'estacion-norte', password: 'clave-de-prueba-123' });
    await env.db.query(`INSERT INTO users (email, role) VALUES ('jugador@mail.example', 'player')`);
    await createSuperadmin(env.db, SUPER);
    const before = await count();

    for (const email of ['ANA@club.example', 'jugador@mail.example', SUPER.email.toUpperCase()]) {
      await expect(createSuperadmin(env.db, { ...SUPER, email })).rejects.toThrow(AdminInputError);
    }
    expect(await count()).toBe(before);
    // La cuenta existente no se convierte en superadmin.
    const [admin] = await env.db.query<{ role: string }>(`SELECT role FROM users WHERE email = 'ana@club.example'`);
    expect(admin!.role).toBe('club_admin');
  });

  it('rechaza un mail con formato inválido, un nombre vacío y una contraseña de menos de 10 caracteres', async () => {
    await expect(createSuperadmin(env.db, { ...SUPER, email: 'no-es-un-mail' })).rejects.toThrow(AdminInputError);
    await expect(createSuperadmin(env.db, { ...SUPER, name: '   ' })).rejects.toThrow(/nombre/);
    await expect(createSuperadmin(env.db, { ...SUPER, password: 'corta123' })).rejects.toThrow(/10 caracteres/);
    expect(await count()).toBe(0);
  });

  it('el comando crea el superadmin leyendo la contraseña de ADMIN_PASSWORD', async () => {
    const result = runCommand(['--email', SUPER.email, '--nombre', SUPER.name]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Superadmin creado');
    expect(result.stdout).not.toContain(SUPER.password);
    const [row] = await env.db.query<{ role: string; club_id: string | null }>('SELECT role, club_id FROM users');
    expect(row).toEqual({ role: 'superadmin', club_id: null });
  });

  it('el comando termina con código distinto de 0 ante una contraseña corta y no crea nada', async () => {
    const result = runCommand(['--email', SUPER.email, '--nombre', SUPER.name], 'corta');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('10 caracteres');
    expect(await count()).toBe(0);
  });

  it('el comando termina con código distinto de 0 ante un mail repetido y no modifica la cuenta', async () => {
    await createSuperadmin(env.db, SUPER);
    const result = runCommand(['--email', SUPER.email, '--nombre', 'Otro Nombre']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Ya existe');
    const [row] = await env.db.query<{ name: string }>('SELECT name FROM users');
    expect(row!.name).toBe(SUPER.name);
  });

  it('el comando sin los datos obligatorios muestra el uso', () => {
    const result = runCommand(['--email', SUPER.email]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Uso: crear-superadmin');
  });

  it('no hay forma de crear un superadmin desde la API: ningún login ni alta lo promueve', async () => {
    await env.db.query(`INSERT INTO users (email, role) VALUES ('jugador@mail.example', 'player')`);
    for (const payload of [{ role: 'superadmin' }, { email: 'x@mail.example', role: 'superadmin' }]) {
      for (const url of ['/api/auth/player/request-link', '/api/auth/admin/request-reset', '/api/club/courts']) {
        await env.app.inject({ method: 'POST', url, payload });
      }
    }
    expect(await env.db.query(`SELECT 1 FROM users WHERE role = 'superadmin'`)).toHaveLength(0);
  });
});
