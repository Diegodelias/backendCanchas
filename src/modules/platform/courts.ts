import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../../app.js';
import { notFound } from '../../lib/errors.js';
import {
  createCourt,
  createCourtBody,
  deleteCourt,
  listCourts,
  patchCourtBody,
  updateCourt,
} from '../clubs/courts.js';
import { requireSuperadmin } from './guard.js';

const clubParam = z.object({ clubId: z.string().min(1).max(100) });
const courtParams = z.object({ clubId: z.string().min(1).max(100), courtId: z.string().min(1).max(100) });

/**
 * Las canchas de cualquier club, con exactamente las mismas reglas que la gestión del admin de club
 * (la lógica es la misma: `clubs/courts.ts`). La diferencia es solo quién elige el club.
 */
export async function platformCourtsRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());

  /** El club existe (activo o no); si no, 404. */
  async function requireClub(clubId: string) {
    const [club] = await db.query<{ id: string; name: string; active: boolean }>(
      `SELECT id, name, active FROM clubs WHERE id = $1`,
      [clubId],
    );
    if (!club) throw notFound('No encontramos ese club.');
    return club;
  }

  // GET /api/platform/clubs/:clubId/courts -> el club y todas sus canchas (activas o no, sin las borradas).
  app.get('/platform/clubs/:clubId/courts', async (req, reply) => {
    await requireSuperadmin(db, req, now());
    const { clubId } = clubParam.parse(req.params);
    const club = await requireClub(clubId);
    reply.header('Cache-Control', 'no-store');
    return { club, courts: await listCourts(db, clubId) };
  });

  // POST /api/platform/clubs/:clubId/courts -> 201 { court }; 409 si el nombre se repite o se llegó al tope.
  app.post('/platform/clubs/:clubId/courts', async (req, reply) => {
    await requireSuperadmin(db, req, now());
    const { clubId } = clubParam.parse(req.params);
    const body = createCourtBody.parse(req.body);
    await requireClub(clubId);
    return reply.status(201).send({ court: await createCourt(db, clubId, body) });
  });

  // PATCH /api/platform/clubs/:clubId/courts/:courtId -> 200 { court }; 404 si la cancha no es de ese club.
  app.patch('/platform/clubs/:clubId/courts/:courtId', async (req) => {
    await requireSuperadmin(db, req, now());
    const { clubId, courtId } = courtParams.parse(req.params);
    const body = patchCourtBody.parse(req.body);
    await requireClub(clubId);
    return { court: await updateCourt(db, clubId, courtId, body) };
  });

  // DELETE /api/platform/clubs/:clubId/courts/:courtId -> 204 (borrado lógico); 404 si no es de ese club.
  app.delete('/platform/clubs/:clubId/courts/:courtId', async (req, reply) => {
    await requireSuperadmin(db, req, now());
    const { clubId, courtId } = courtParams.parse(req.params);
    await requireClub(clubId);
    await deleteCourt(db, clubId, courtId);
    return reply.status(204).send();
  });
}
