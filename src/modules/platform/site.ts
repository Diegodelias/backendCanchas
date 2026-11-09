import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../../app.js';
import { setSiteName, siteNameBody } from '../site/settings.js';
import { requireSuperadmin } from './guard.js';

export async function platformSiteRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());

  // PUT /api/platform/site { name } -> 200 { name }. Solo el superadmin; el nombre se valida (1 a 40 caracteres, sin
  // saltos de línea) y se guarda sin espacios al borde. Lo lee todo el sitio por GET /api/site.
  app.put('/platform/site', async (req) => {
    await requireSuperadmin(db, req, now());
    const { name } = siteNameBody.parse(req.body);
    return { name: await setSiteName(db, name) };
  });
}
