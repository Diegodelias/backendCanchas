import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AdminInputError, createAdmin } from '../src/modules/auth/admins.js';
import { createDbTestEnv, type DbTestEnv } from './helpers.js';

const backendDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const ADMIN = {
  email: 'bruno@cantera.example',
  name: 'Bruno Díaz',
  clubId: 'la-cantera-crespo',
  password: 'clave-larga-456',
};

describe('crear admin', () => {
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

  it('crea el admin y luego puede ingresar', async () => {
    const admin = await createAdmin(env.db, ADMIN);
    expect(admin).toMatchObject({ email: ADMIN.email, role: 'club_admin', clubId: 'la-cantera-crespo' });

    const res = await env.app.inject({
      method: 'POST',
      url: '/api/auth/admin/login',
      payload: { email: ADMIN.email, password: ADMIN.password },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.clubId).toBe('la-cantera-crespo');
  });

  it('rechaza un club inexistente y lista los válidos', async () => {
    const err = await createAdmin(env.db, { ...ADMIN, clubId: 'club-trucho' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdminInputError);
    expect((err as Error).message).toContain('club-trucho');
    expect((err as Error).message).toContain('estacion-norte');
    expect((err as Error).message).toContain('terraza-colegiales');
    expect(await count()).toBe(0);
  });

  it('rechaza un mail repetido, sin importar mayúsculas', async () => {
    await createAdmin(env.db, ADMIN);
    await expect(createAdmin(env.db, { ...ADMIN, email: ADMIN.email.toUpperCase() })).rejects.toThrow(
      AdminInputError,
    );
    expect(await count()).toBe(1);
  });

  it('rechaza un mail con formato inválido', async () => {
    await expect(createAdmin(env.db, { ...ADMIN, email: 'no-es-un-mail' })).rejects.toThrow(AdminInputError);
    expect(await count()).toBe(0);
  });

  it('rechaza una contraseña de menos de 10 caracteres', async () => {
    await expect(createAdmin(env.db, { ...ADMIN, password: 'corta123' })).rejects.toThrow(/10 caracteres/);
    expect(await count()).toBe(0);
  });

  it('el comando termina con código distinto de 0 ante un club inexistente', () => {
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'src/cli/crear-admin.ts', '--email', ADMIN.email, '--nombre', ADMIN.name, '--club', 'club-trucho'],
      {
        cwd: backendDir,
        env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL, ADMIN_PASSWORD: ADMIN.password },
        input: '',
        encoding: 'utf8',
      },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Clubes válidos');
  });

  it('el comando crea el admin leyendo la contraseña de ADMIN_PASSWORD', async () => {
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'src/cli/crear-admin.ts', '--email', ADMIN.email, '--nombre', ADMIN.name, '--club', ADMIN.clubId],
      {
        cwd: backendDir,
        env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL, ADMIN_PASSWORD: ADMIN.password },
        input: '',
        encoding: 'utf8',
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Admin creado');
    expect(await count()).toBe(1);
  });
});
