import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildApp } from '../src/app.js';
import { createTestEnv, type TestEnv } from './helpers.js';

describe('servidor base', () => {
  let env: TestEnv;

  beforeAll(async () => {
    env = await createTestEnv();
  });
  afterAll(async () => {
    await env.close();
  });

  it('GET /api/health responde 200', async () => {
    const res = await env.app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('GET /api/health?db=true comprueba la base', async () => {
    const res = await env.app.inject({ method: 'GET', url: '/api/health?db=true' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', db: 'ok' });
  });

  it('GET /api/health?db=true responde 503 si la base no responde', async () => {
    env.db.failing = true;
    try {
      const res = await env.app.inject({ method: 'GET', url: '/api/health?db=true' });
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe('db_unavailable');
    } finally {
      env.db.failing = false;
    }
  });

  it('una ruta inexistente responde 404 con cuerpo uniforme', async () => {
    const res = await env.app.inject({ method: 'GET', url: '/api/nada' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
  });
});

describe('manejo de errores', () => {
  it('un error de validación devuelve un mensaje legible', async () => {
    const env = await createTestEnv();
    try {
      // Instancia nueva: las rutas se pueden agregar antes de que el servidor esté listo.
      const app = await buildApp({ config: env.config, db: env.db });
      app.get('/api/_validar', async (req) => z.object({ edad: z.coerce.number().int().min(1) }).parse(req.query));
      const res = await app.inject({ method: 'GET', url: '/api/_validar?edad=-3' });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error.code).toBe('validation_error');
      expect(body.error.message).toContain('edad');
      await app.close();
    } finally {
      await env.close();
    }
  });

  it('un error inesperado responde 500 sin filtrar detalles internos', async () => {
    const env = await createTestEnv();
    try {
      const app = await buildApp({ config: env.config, db: env.db });
      app.get('/api/_roto', async () => {
        throw new Error('secreto interno: contraseña=1234');
      });
      const res = await app.inject({ method: 'GET', url: '/api/_roto' });
      expect(res.statusCode).toBe(500);
      expect(res.json().error.code).toBe('internal_error');
      expect(res.body).not.toContain('secreto interno');
      await app.close();
    } finally {
      await env.close();
    }
  });
});
