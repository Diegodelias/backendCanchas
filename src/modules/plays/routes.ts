import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../../app.js';
import { AppError, forbidden, notFound, unauthorized } from '../../lib/errors.js';
import { resolveSession, SESSION_COOKIE } from '../auth/sessions.js';
import type { SessionUser } from '../auth/types.js';
import { SpawnLauncher } from '../live/launcher.js';
import { getPlayableVideoFile, getVisibleRecordings, type RecordingItem } from '../recordings/recordings.js';
import { ClipAbortedError, createClipCutter } from './clip.js';

/** Jugadas que puede tener cada jugador. */
export const MAX_PLAYS_PER_PLAYER = 200;

export const PLAY_CATEGORIES = ['Gol', 'Caño / Galleta', 'Atajada', 'Buena jugada', 'Bloopers', 'Otro'] as const;

/** Fragmento por defecto de una jugada: 15 segundos antes del momento marcado y 5 después (el inicio nunca baja de 0). */
export const DEFAULT_CLIP_BEFORE_SECONDS = 15;
export const DEFAULT_CLIP_AFTER_SECONDS = 5;
export const MIN_CLIP_SECONDS = 3;
export const MAX_CLIP_SECONDS = 120;

const clipSecond = z
  .number({ error: 'El inicio y el fin del fragmento deben ser números.' })
  .int('El inicio y el fin del fragmento deben ser segundos enteros.');

const createBody = z
  .object({
    // Texto libre: una jugada puede apuntar a una grabación, a una cámara en vivo o a algo que ya no existe.
    matchId: z.string().min(1, 'Falta el partido.').max(100, 'El identificador del partido es demasiado largo.'),
    title: z.string().trim().min(1, 'Poné un título para la jugada.').max(120, 'El título es demasiado largo.'),
    category: z.enum(PLAY_CATEGORIES).nullish(),
    captureMode: z.enum(['video', 'voice_commentary']).default('video'),
    timestamp: z.number().min(0, 'El momento marcado no puede ser negativo.').max(86400),
    isLiveMoment: z.boolean().default(false),
    // El fragmento: inicio y fin en segundos del video. Una jugada en vivo no tiene (no hay grabación).
    clipStart: clipSecond.optional(),
    clipEnd: clipSecond.optional(),
  })
  .superRefine((body, ctx) => {
    if (body.isLiveMoment) return;
    const fail = (path: 'clipStart' | 'clipEnd', message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
    if ((body.clipStart === undefined) !== (body.clipEnd === undefined)) {
      return fail(body.clipStart === undefined ? 'clipStart' : 'clipEnd', 'Indicá el inicio y el fin del fragmento, o ninguno.');
    }
    if (body.clipStart === undefined || body.clipEnd === undefined) return;
    const mark = Math.floor(body.timestamp);
    const length = body.clipEnd - body.clipStart;
    if (body.clipStart < 0) return fail('clipStart', 'El inicio del fragmento no puede ser negativo.');
    if (length <= 0) return fail('clipEnd', 'El fin del fragmento tiene que ser posterior al inicio.');
    if (length < MIN_CLIP_SECONDS) return fail('clipEnd', `El fragmento tiene que durar al menos ${MIN_CLIP_SECONDS} segundos.`);
    if (length > MAX_CLIP_SECONDS) return fail('clipEnd', `El fragmento puede durar hasta ${MAX_CLIP_SECONDS} segundos.`);
    if (mark < body.clipStart || mark > body.clipEnd) fail('clipStart', 'El fragmento tiene que incluir el momento marcado.');
  });

const patchBody = z
  .object({
    title: z.string().trim().min(1, 'Poné un título para la jugada.').max(120, 'El título es demasiado largo.').optional(),
    category: z.enum(PLAY_CATEGORIES).nullable().optional(),
  })
  .refine((b) => b.title !== undefined || b.category !== undefined, { message: 'No hay nada para cambiar.' });

const idParam = z.object({ id: z.uuid() });

/** Nombre del archivo que se descarga: `jugada-<título sin tildes ni símbolos>.mp4`. */
export function clipFileName(title: string): string {
  const slug = title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  if (!slug) return 'jugada.mp4';
  // «Jugada de 00:08» ya empieza con la palabra: no se repite.
  return slug.startsWith('jugada') ? `${slug}.mp4` : `jugada-${slug}.mp4`;
}

const clipUnavailable = (message: string) => new AppError(404, 'clip_unavailable', message);

interface PlayRow {
  id: string;
  match_id: string;
  title: string;
  category: string | null;
  capture_mode: 'video' | 'voice_commentary';
  timestamp_seconds: number;
  is_live_moment: boolean;
  clip_start_seconds: number | null;
  clip_end_seconds: number | null;
  created_at: Date;
}

const COLUMNS =
  'id, match_id, title, category, capture_mode, timestamp_seconds, is_live_moment, clip_start_seconds, clip_end_seconds, created_at';

/**
 * La jugada con los datos de su grabación (`recording`), o `null` si el partido no corresponde a una grabación visible:
 * una jugada en vivo, o una cuya grabación ya no existe. La jugada se guarda igual con cualquier identificador.
 */
function toPlay(row: PlayRow, recording: RecordingItem | null) {
  return {
    id: row.id,
    matchId: row.match_id,
    title: row.title,
    category: row.category,
    captureMode: row.capture_mode,
    timestamp: row.timestamp_seconds,
    isLiveMoment: row.is_live_moment,
    // El fragmento (inicio y fin en segundos del video); null en una jugada en vivo.
    clipStart: row.clip_start_seconds,
    clipEnd: row.clip_end_seconds,
    createdAt: row.created_at,
    recording,
  };
}

/** Un id que no es un uuid es una jugada que no existe, no un error de formato. */
function parseId(params: unknown): string {
  const parsed = idParam.safeParse(params);
  if (!parsed.success) throw notFound('No encontramos esa jugada.');
  return parsed.data.id;
}

export async function playsRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db } = deps;

  // Un solo cortador por app: el tope de cortes a la vez vale para todos los jugadores.
  const cutter = createClipCutter({
    launcher: deps.launcher ?? new SpawnLauncher(deps.config.FFMPEG),
    maxConcurrent: deps.config.CLIP_MAX_CONCURRENT,
    timeoutMs: deps.config.CLIP_TIMEOUT_MS,
    log: (message, detail) => app.log.warn(detail ?? {}, message),
  });
  const videosRoot = path.resolve(deps.config.VIDEOS_DIR);

  /** Arma las jugadas con su grabación, pidiendo todas las grabaciones juntas. */
  async function withRecordings(rows: PlayRow[]) {
    const recordings = await getVisibleRecordings(db, [...new Set(rows.map((row) => row.match_id))]);
    return rows.map((row) => toPlay(row, recordings.get(row.match_id) ?? null));
  }
  const now = deps.now ?? (() => new Date());

  /** Sesión de jugador: 401 sin sesión y 403 para un admin (los admins no ven jugadas de jugadores). */
  async function requirePlayer(req: FastifyRequest): Promise<SessionUser> {
    const user = await resolveSession(db, req.cookies[SESSION_COOKIE], now());
    if (!user) throw unauthorized('Iniciá sesión para ver y guardar tus jugadas.');
    if (user.role !== 'player') throw forbidden('Las jugadas son de los jugadores.');
    return user;
  }

  // GET /api/plays -> las del jugador, de la más reciente a la más antigua.
  app.get('/plays', async (req) => {
    const user = await requirePlayer(req);
    const rows = await db.query<PlayRow>(
      `SELECT ${COLUMNS} FROM plays WHERE user_id = $1 ORDER BY created_at DESC, id`,
      [user.id],
    );
    return { plays: await withRecordings(rows) };
  });

  // POST /api/plays -> 201 { play }; 409 si ya tiene 200.
  app.post('/plays', async (req, reply) => {
    const user = await requirePlayer(req);
    const body = createBody.parse(req.body);

    // Un solo INSERT condicional: no hay transacciones en `Database`, y así el tope y el alta van juntos.
    // Fragmento: el que mandó el jugador o, por defecto, 15 s antes y 5 s después del momento marcado. Una jugada en vivo no lo tiene.
    const mark = Math.floor(body.timestamp);
    const clipStart = body.isLiveMoment ? null : (body.clipStart ?? Math.max(0, mark - DEFAULT_CLIP_BEFORE_SECONDS));
    const clipEnd = body.isLiveMoment ? null : (body.clipEnd ?? mark + DEFAULT_CLIP_AFTER_SECONDS);

    const rows = await db.query<PlayRow>(
      `INSERT INTO plays (user_id, match_id, title, category, capture_mode, timestamp_seconds, is_live_moment, clip_start_seconds, clip_end_seconds, created_at)
       SELECT $1::uuid, $2::text, $3::text, $4::text, $5::text, $6::int, $7::boolean, $8::int, $9::int, $10::timestamptz
        WHERE (SELECT count(*) FROM plays WHERE user_id = $1::uuid) < $11::int
       RETURNING ${COLUMNS}`,
      [
        user.id,
        body.matchId,
        body.title,
        body.category ?? null,
        body.captureMode,
        mark,
        body.isLiveMoment,
        clipStart,
        clipEnd,
        now(),
        MAX_PLAYS_PER_PLAYER,
      ],
    );
    const row = rows[0];
    if (!row) {
      throw new AppError(
        409,
        'plays_limit_reached',
        `Llegaste al máximo de ${MAX_PLAYS_PER_PLAYER} jugadas guardadas. Borrá alguna para guardar otra.`,
      );
    }
    const [play] = await withRecordings([row]);
    return reply.status(201).send({ play });
  });

  // PATCH /api/plays/:id -> 200 { play }; 404 si no existe o es de otro jugador.
  app.patch('/plays/:id', async (req) => {
    const user = await requirePlayer(req);
    const id = parseId(req.params);
    const body = patchBody.parse(req.body);

    const sets: string[] = [];
    const params: unknown[] = [id, user.id];
    if (body.title !== undefined) {
      params.push(body.title);
      sets.push(`title = $${params.length}`);
    }
    if (body.category !== undefined) {
      params.push(body.category);
      sets.push(`category = $${params.length}`);
    }
    const rows = await db.query<PlayRow>(
      `UPDATE plays SET ${sets.join(', ')} WHERE id = $1 AND user_id = $2 RETURNING ${COLUMNS}`,
      params,
    );
    if (!rows[0]) throw notFound('No encontramos esa jugada.');
    const [play] = await withRecordings([rows[0]]);
    return { play };
  });

  // GET /api/plays/:id/clip -> el mp4 del fragmento de la jugada, cortado del video de su grabación.
  // Solo el dueño. El video sale de la grabación guardada en la base: el pedido no puede indicar ningún archivo ni dirección.
  // 404 si la jugada es en vivo o su grabación no está disponible; 503 si hay demasiados cortes; 504 si el corte tarda de más.
  app.get('/plays/:id/clip', async (req, reply) => {
    const user = await requirePlayer(req);
    const id = parseId(req.params);
    const [row] = await db.query<PlayRow>(`SELECT ${COLUMNS} FROM plays WHERE id = $1 AND user_id = $2`, [id, user.id]);
    if (!row) throw notFound('No encontramos esa jugada.');

    if (row.is_live_moment || row.clip_start_seconds === null || row.clip_end_seconds === null) {
      throw clipUnavailable('Las jugadas en vivo no se pueden descargar: no hay una grabación.');
    }
    const file = await getPlayableVideoFile(db, row.match_id);
    const inputPath = file ? path.resolve(videosRoot, file) : null;
    // Nunca se lee fuera de la carpeta de videos.
    const inputInfo = inputPath && path.dirname(inputPath) === videosRoot ? await stat(inputPath).catch(() => null) : null;
    if (!inputPath || !inputInfo?.isFile()) throw clipUnavailable('La grabación de esta jugada no está disponible.');

    const outputPath = path.join(tmpdir(), `canchas3-clip-${randomUUID()}.mp4`);
    // Si el jugador corta la conexión mientras se prepara el fragmento, se detiene el corte.
    const controller = new AbortController();
    const onClose = () => {
      if (!reply.raw.writableFinished) controller.abort();
    };
    reply.raw.on('close', onClose);

    try {
      await cutter.cut(
        { inputPath, start: row.clip_start_seconds, end: row.clip_end_seconds, outputPath },
        controller.signal,
      );
    } catch (err) {
      reply.raw.off('close', onClose);
      if (err instanceof ClipAbortedError) return reply.status(204).send();
      throw err;
    }

    // El temporal se borra al cerrarse la respuesta (se envió entera o el jugador cortó).
    reply.raw.off('close', onClose);
    reply.raw.once('close', () => void rm(outputPath, { force: true }).catch(() => {}));
    const info = await stat(outputPath).catch(() => null);
    if (!info) throw new AppError(502, 'clip_failed', 'No pudimos preparar el fragmento. Probá de nuevo en un momento.');

    return reply
      .status(200)
      .header('Content-Type', 'video/mp4')
      .header('Content-Length', info.size)
      .header('Content-Disposition', `attachment; filename="${clipFileName(row.title)}"`)
      .header('Cache-Control', 'no-store')
      .send(createReadStream(outputPath));
  });

  // DELETE /api/plays/:id -> 204; 404 si no existe o es de otro jugador.
  app.delete('/plays/:id', async (req, reply) => {
    const user = await requirePlayer(req);
    const id = parseId(req.params);
    const rows = await db.query(`DELETE FROM plays WHERE id = $1 AND user_id = $2 RETURNING id`, [id, user.id]);
    if (rows.length === 0) throw notFound('No encontramos esa jugada.');
    return reply.status(204).send();
  });
}
