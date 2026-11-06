import Fastify, { type FastifyInstance } from 'fastify';
import { z, ZodError } from 'zod';
import type { Config } from './config.js';
import type { Database } from './db/client.js';
import { AppError } from './lib/errors.js';
import type { FfmpegLauncher } from './modules/live/launcher.js';
import { liveRoutes } from './modules/live/routes.js';

export interface AppDeps {
  config: Config;
  db: Database;
  /** Lanzador de ffmpeg; por defecto usa el binario real. Se reemplaza en las pruebas. */
  launcher?: FfmpegLauncher;
  /** Destino de los logs; por defecto la salida estándar (y ninguno en pruebas). Permite verificar qué se registra. */
  logStream?: { write(message: string): void };
}

export interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

const healthQuery = z.object({
  db: z.enum(['true', 'false']).default('false'),
});

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: deps.logStream
      ? { level: 'info', stream: deps.logStream }
      : deps.config.NODE_ENV === 'test'
        ? false
        : { level: 'info' },
    trustProxy: true,
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) {
      const body: ErrorBody = { error: { code: err.code, message: err.message } };
      return reply.status(err.status).send(body);
    }
    if (err instanceof ZodError) {
      const first = err.issues[0];
      const where = first?.path.length ? `${first.path.join('.')}: ` : '';
      const body: ErrorBody = {
        error: {
          code: 'validation_error',
          message: `${where}${first?.message ?? 'Datos inválidos.'}`,
          details: err.issues.map((i) => ({ path: i.path, message: i.message })),
        },
      };
      return reply.status(400).send(body);
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      const body: ErrorBody = {
        error: { code: (err as { code?: string }).code ?? 'bad_request', message: (err as Error).message },
      };
      return reply.status(status).send(body);
    }
    app.log.error(err);
    const body: ErrorBody = {
      error: { code: 'internal_error', message: 'Algo salió mal de nuestro lado. Probá de nuevo.' },
    };
    return reply.status(500).send(body);
  });

  app.setNotFoundHandler((_req, reply) => {
    const body: ErrorBody = { error: { code: 'not_found', message: 'No encontramos esa ruta.' } };
    return reply.status(404).send(body);
  });

  await app.register(
    async (api) => {
      // GET /api/health            -> el proceso está vivo.
      // GET /api/health?db=true    -> además comprueba la conexión a la base.
      api.get('/health', async (req, reply) => {
        const { db } = healthQuery.parse(req.query);
        if (db === 'true') {
          try {
            await deps.db.ping();
          } catch {
            const body: ErrorBody = {
              error: { code: 'db_unavailable', message: 'La base de datos no responde.' },
            };
            return reply.status(503).send(body);
          }
          return { status: 'ok', db: 'ok' };
        }
        return { status: 'ok' };
      });

      await api.register(liveRoutes, deps);
    },
    { prefix: '/api' },
  );

  return app;
}
