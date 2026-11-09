import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../../app.js';
import { AppError } from '../../lib/errors.js';
import {
  getPlayerQuota,
  getPlaySettings,
  grantExtraPlaysBody,
  grantExtraPlays,
  playSettingsBody,
  setPlaySettings,
} from '../plays/quota.js';
import { requireSuperadmin } from './guard.js';

/** Rutas del superadmin para el cupo de jugadas, el paquete extra y las jugadas extra de un jugador. */
export async function platformPlaySettingsRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());

  // GET /api/platform/play-settings -> 200 { freeQuota, packPlays, packPrice }. Solo el superadmin.
  app.get('/platform/play-settings', async (req, reply) => {
    await requireSuperadmin(db, req, now());
    reply.header('Cache-Control', 'no-store');
    return getPlaySettings(db);
  });

  // PUT /api/platform/play-settings { freeQuota, packPlays, packPrice } -> 200 con lo guardado. Solo el superadmin; los tres
  // valores son enteros (cupo 0 a 10 000, paquete 1 a 1 000 jugadas, precio 1 a 1 000 000 de pesos). Bajar el cupo no borra
  // jugadas: quien ya tiene más conserva las suyas y solo no puede guardar más.
  app.put('/platform/play-settings', async (req) => {
    await requireSuperadmin(db, req, now());
    return setPlaySettings(db, playSettingsBody.parse(req.body));
  });

  // POST /api/platform/players/extra-plays { email, plays } -> 200 { player: { email }, quota }. Suma jugadas extra al
  // cupo de un jugador (de 1 a 1 000 por vez). Un mail sin cuenta de jugador (o de un admin) responde 404 sin cambiar nada.
  app.post('/platform/players/extra-plays', async (req) => {
    await requireSuperadmin(db, req, now());
    const { email, plays } = grantExtraPlaysBody.parse(req.body);
    const player = await grantExtraPlays(db, email, plays);
    if (!player) {
      throw new AppError(404, 'player_not_found', 'No hay un jugador con ese mail.');
    }
    return { player: { email: player.email }, quota: await getPlayerQuota(db, player.id) };
  });
}
