import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../../app.js';
import { platformAdminsRoutes } from './admins.js';
import { platformClubsRoutes } from './clubs.js';
import { platformCourtsRoutes } from './courts.js';
import { platformPlayersRoutes } from './players.js';

/** Rutas de la plataforma (`/api/platform/...`): solo las atiende un superadmin con sesión válida. */
export async function platformRoutes(app: FastifyInstance, deps: AppDeps) {
  await platformClubsRoutes(app, deps);
  await platformCourtsRoutes(app, deps);
  await platformAdminsRoutes(app, deps);
  await platformPlayersRoutes(app, deps);
}
