import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../../app.js';
import { getSiteSettings } from './settings.js';

/** Ruta pública del sitio (`/api/site`): el nombre del sitio y el color de su logo, que el frontend muestra en el logo y en los textos. */
export async function siteRoutes(app: FastifyInstance, deps: AppDeps) {
  // GET /api/site -> { name, logoColor }. Sin sesión; sin copia guardada, para que el cambio se vea al recargar.
  app.get('/site', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return getSiteSettings(deps.db);
  });
}
