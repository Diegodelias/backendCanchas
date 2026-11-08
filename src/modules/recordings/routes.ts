import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../../app.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { parseDate } from '../bookings/time.js';
import { getVisibleRecording, listPlayableRecordings } from './recordings.js';
import { videosRoutes } from './videos.js';

const listQuery = z.object({
  clubId: z.string().min(1).max(100).optional(),
  courtId: z.string().min(1).max(100).optional(),
  date: z.string().optional(),
});
const idParam = z.object({ id: z.string().min(1).max(100) });

/** Rutas públicas de grabaciones (`/api/recordings`). */
export async function recordingsRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db } = deps;
  await videosRoutes(app, deps);

  // GET /api/recordings?clubId=&courtId=&date=AAAA-MM-DD -> { recordings } reproducibles, de la más reciente a la más antigua.
  // Público; sin copia guardada, porque una grabación pasa de «en proceso» a disponible.
  app.get('/recordings', async (req, reply) => {
    const { clubId, courtId, date } = listQuery.parse(req.query);
    if (date !== undefined && !parseDate(date)) {
      throw badRequest('La fecha no es válida. Usá el formato AAAA-MM-DD.', 'validation_error');
    }
    reply.header('Cache-Control', 'no-store');
    return { recordings: await listPlayableRecordings(db, { clubId, courtId, date }) };
  });

  // GET /api/recordings/:id -> { recording } en cualquier estado (el reproductor explica por qué no se puede ver);
  // 404 si no existe, el club está desactivado o la cancha está borrada.
  app.get('/recordings/:id', async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const recording = await getVisibleRecording(db, id);
    if (!recording) throw notFound('No encontramos esa grabación.');
    reply.header('Cache-Control', 'no-store');
    return { recording };
  });
}
