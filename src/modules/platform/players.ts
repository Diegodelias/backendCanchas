import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../../app.js';
import { createPlayer, createPlayerBody } from '../auth/players.js';
import { requireSuperadmin } from './guard.js';

export async function platformPlayersRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db, config } = deps;
  const now = deps.now ?? (() => new Date());
  const mailer = deps.mailer;
  if (!mailer) throw new Error('platformPlayersRoutes necesita un mailer (lo arma buildApp).');

  // POST /api/platform/players -> 201 { player, link, created, emailSent }.
  // Crea un jugador por mail y devuelve un link de acceso de 72 horas para entregarle. Sobre un jugador que ya
  // existe, el superadmin obtiene un link nuevo (created: false) sin modificar la cuenta.
  app.post('/platform/players', async (req, reply) => {
    await requireSuperadmin(db, req, now());
    const { email, sendEmail } = createPlayerBody.parse(req.body);
    const result = await createPlayer(
      { db, mailer, publicAppUrl: config.PUBLIC_APP_URL, log: app.log },
      { email, sendEmail, allowExisting: true, ip: req.ip, now: now() },
    );
    reply.header('Cache-Control', 'no-store');
    return reply.status(201).send(result);
  });
}
