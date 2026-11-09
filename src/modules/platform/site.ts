import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../../app.js';
import { setSiteSettings, siteSettingsBody } from '../site/settings.js';
import { requireSuperadmin } from './guard.js';

export async function platformSiteRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());

  // PUT /api/platform/site { name, logoColor? } -> 200 { name, logoColor }. Solo el superadmin; el nombre se valida
  // (1 a 40 caracteres, sin saltos de línea) y se guarda sin espacios al borde. El color es una clave de la paleta:
  // ausente no cambia, null vuelve al predeterminado. Lo lee todo el sitio por GET /api/site.
  app.put('/platform/site', async (req) => {
    await requireSuperadmin(db, req, now());
    return setSiteSettings(db, siteSettingsBody.parse(req.body));
  });
}
