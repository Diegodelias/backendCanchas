import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { Database } from '../../db/client.js';
import { addDays, slotStart, todayInArgentina } from '../bookings/time.js';
import type { RecordingStatus } from './recordings.js';

/**
 * Grabaciones de demostración: los mismos partidos de ejemplo que antes vivían en el frontend, ahora como registros
 * reales de la base. El video es siempre el mismo archivo de demostración. Las fechas son relativas a hoy.
 */

/** Archivo de demostración dentro de `VIDEOS_DIR`. */
export const DEMO_VIDEO_FILE = 'demo-partido.mp4';
/** Días anteriores a hoy que se cargan: ayer, anteayer y un día más atrás. Hoy no, porque un turno de hoy puede no haber empezado. */
export const DEMO_DAYS_BACK = 3;
const DEMO_DURATION_SECONDS = 60;

interface DemoRecording {
  /** Identificador de ayer (el de siempre); los otros días llevan el sufijo `-d2` y `-d3`. */
  id: string;
  courtId: string;
  hour: number;
  minute: number;
  status: RecordingStatus;
}

export const DEMO_RECORDINGS: DemoRecording[] = [
  { id: 'match-en-f5-1900', courtId: 'en-f5-1', hour: 19, minute: 0, status: 'available' },
  { id: 'match-en-f5-1800', courtId: 'en-f5-1', hour: 18, minute: 0, status: 'available' },
  { id: 'match-en-f7-2000', courtId: 'en-f7-1', hour: 20, minute: 0, status: 'processing' },
  { id: 'match-lc-f5-1900', courtId: 'lc-f5-a', hour: 19, minute: 0, status: 'available' },
  { id: 'match-pb-f5-1730', courtId: 'pb-f5-1', hour: 17, minute: 30, status: 'available' },
  { id: 'match-an-f5-1900', courtId: 'an-f5', hour: 19, minute: 0, status: 'unavailable' },
  { id: 'match-tc-f5-1800', courtId: 'tc-f5-1', hour: 18, minute: 0, status: 'available' },
];

/** Falta algo para cargar la demostración (el archivo de video). No se cambió nada. */
export class DemoLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DemoLoadError';
  }
}

export interface DemoLoadResult {
  /** Grabaciones guardadas. */
  loaded: number;
  /** Canchas de demostración que no existen (o están borradas) y se omitieron. */
  missingCourts: string[];
  /** Grabaciones omitidas porque la cancha ya tenía otra grabación con ese inicio. */
  skippedExisting: number;
}

const idForDay = (id: string, daysBack: number) => (daysBack === 1 ? id : `${id}-d${daysBack}`);

/**
 * Crea o renueva las grabaciones de demostración con fechas de los 3 días anteriores a hoy (hora de Argentina).
 * Es idempotente: borra las filas de demostración y las vuelve a escribir, así que correrlo de nuevo renueva las fechas
 * sin duplicar. Nunca pisa una grabación que no sea de demostración. Si falla a la mitad, se vuelve a correr.
 */
export async function loadDemoRecordings(db: Database, videosDir: string, now: Date): Promise<DemoLoadResult> {
  const videoPath = path.join(path.resolve(videosDir), DEMO_VIDEO_FILE);
  const info = await stat(videoPath).catch(() => null);
  if (!info?.isFile()) {
    throw new DemoLoadError(`Falta el archivo de demostración ${DEMO_VIDEO_FILE} en ${path.resolve(videosDir)}.`);
  }

  const courtIds = [...new Set(DEMO_RECORDINGS.map((r) => r.courtId))];
  const existing = await db.query<{ id: string }>(
    `SELECT id FROM courts WHERE id = ANY($1::text[]) AND deleted_at IS NULL`,
    [courtIds],
  );
  const present = new Set(existing.map((c) => c.id));
  const missingCourts = courtIds.filter((id) => !present.has(id));

  const days = Array.from({ length: DEMO_DAYS_BACK }, (_, i) => i + 1);
  const allIds = DEMO_RECORDINGS.flatMap((r) => days.map((d) => idForDay(r.id, d)));
  await db.query(`DELETE FROM recordings WHERE id = ANY($1::text[])`, [allIds]);

  const today = todayInArgentina(now);
  let loaded = 0;
  let skippedExisting = 0;
  for (const demo of DEMO_RECORDINGS) {
    if (!present.has(demo.courtId)) continue;
    for (const daysBack of days) {
      const startsAt = new Date(slotStart(addDays(today, -daysBack), demo.hour).getTime() + demo.minute * 60 * 1000);
      const available = demo.status === 'available';
      const rows = await db.query<{ id: string }>(
        `INSERT INTO recordings (id, court_id, starts_at, status, video_file, duration_seconds, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (court_id, starts_at) DO NOTHING
         RETURNING id`,
        [
          idForDay(demo.id, daysBack),
          demo.courtId,
          startsAt,
          demo.status,
          available ? DEMO_VIDEO_FILE : null,
          available ? DEMO_DURATION_SECONDS : 0,
          now,
        ],
      );
      if (rows.length > 0) loaded += 1;
      else skippedExisting += 1;
    }
  }
  return { loaded, missingCourts, skippedExisting };
}
