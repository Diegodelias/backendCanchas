import type { Database } from '../../db/client.js';
import { formatTimeOfDay, slotStart, toArgentina } from '../bookings/time.js';

/**
 * Grabaciones de partidos: un registro por turno grabado (cancha + inicio) con su estado, su duración y el NOMBRE del
 * archivo de video. La API lo sirve en `/api/videos/<archivo>` (ver `videos.ts`).
 */

export const RECORDING_STATUSES = ['available', 'processing', 'unavailable', 'error'] as const;
export type RecordingStatus = (typeof RECORDING_STATUSES)[number];

/** Ruta pública de un video: la grabación guarda solo el nombre del archivo. */
export const videoUrlFor = (file: string) => `/api/videos/${encodeURIComponent(file)}`;

export interface RecordingItem {
  id: string;
  club: { id: string; name: string };
  court: { id: string; name: string };
  /** Inicio del turno como instante (ISO 8601). */
  startsAt: string;
  /** Fecha del turno en Argentina, `AAAA-MM-DD`. */
  date: string;
  /** Hora de inicio en Argentina, `HH:MM`. */
  time: string;
  status: RecordingStatus;
  durationSeconds: number;
  /** Solo una grabación disponible ofrece su video. */
  videoUrl: string | null;
}

interface RecordingRow {
  id: string;
  starts_at: Date;
  status: RecordingStatus;
  video_file: string | null;
  duration_seconds: number;
  club_id: string;
  club_name: string;
  court_id: string;
  court_name: string;
}

const SELECT = `SELECT r.id, r.starts_at, r.status, r.video_file, r.duration_seconds,
                       c.id AS club_id, c.name AS club_name, k.id AS court_id, k.name AS court_name
                  FROM recordings r
                  JOIN courts k ON k.id = r.court_id
                  JOIN clubs c ON c.id = k.club_id`;

/** Lo que ve el público: clubes activos y canchas no borradas (una cancha desactivada conserva su historial). */
const PUBLIC_VISIBLE = `c.active AND k.deleted_at IS NULL`;

const ORDER = `ORDER BY r.starts_at DESC, r.id`;

export function toRecording(row: RecordingRow): RecordingItem {
  const startsAt = new Date(row.starts_at);
  return {
    id: row.id,
    club: { id: row.club_id, name: row.club_name },
    court: { id: row.court_id, name: row.court_name },
    startsAt: startsAt.toISOString(),
    date: toArgentina(startsAt).date,
    time: formatTimeOfDay(startsAt),
    status: row.status,
    durationSeconds: row.duration_seconds,
    videoUrl: row.status === 'available' && row.video_file ? videoUrlFor(row.video_file) : null,
  };
}

export interface PlayableFilter {
  clubId?: string;
  courtId?: string;
  /** `AAAA-MM-DD` ya validada, en hora de Argentina. */
  date?: string;
}

/** Grabaciones reproducibles (disponibles y con archivo) y visibles, de la más reciente a la más antigua. */
export async function listPlayableRecordings(db: Database, filter: PlayableFilter): Promise<RecordingItem[]> {
  const params: unknown[] = [];
  const where = [`r.status = 'available'`, `r.video_file IS NOT NULL`, PUBLIC_VISIBLE];
  if (filter.clubId) {
    params.push(filter.clubId);
    where.push(`c.id = $${params.length}`);
  }
  if (filter.courtId) {
    params.push(filter.courtId);
    where.push(`k.id = $${params.length}`);
  }
  if (filter.date) {
    const from = slotStart(filter.date, 0);
    params.push(from, new Date(from.getTime() + 24 * 60 * 60 * 1000));
    where.push(`r.starts_at >= $${params.length - 1} AND r.starts_at < $${params.length}`);
  }
  const rows = await db.query<RecordingRow>(`${SELECT} WHERE ${where.join(' AND ')} ${ORDER}`, params);
  return rows.map(toRecording);
}

/** Una grabación visible al público, en cualquier estado; null si no existe o no es visible. */
export async function getVisibleRecording(db: Database, id: string): Promise<RecordingItem | null> {
  const [row] = await db.query<RecordingRow>(`${SELECT} WHERE r.id = $1 AND ${PUBLIC_VISIBLE}`, [id]);
  return row ? toRecording(row) : null;
}

/** Las grabaciones visibles de esos identificadores, por id. Las inexistentes o no visibles no aparecen. */
export async function getVisibleRecordings(db: Database, ids: string[]): Promise<Map<string, RecordingItem>> {
  if (ids.length === 0) return new Map();
  const rows = await db.query<RecordingRow>(`${SELECT} WHERE r.id = ANY($1::text[]) AND ${PUBLIC_VISIBLE}`, [ids]);
  return new Map(rows.map((row) => [row.id, toRecording(row)]));
}

/** Todas las grabaciones de las canchas de un club (cualquier estado), de la más reciente a la más antigua. */
export async function listClubRecordings(db: Database, clubId: string): Promise<RecordingItem[]> {
  const rows = await db.query<RecordingRow>(
    `${SELECT} WHERE c.id = $1 AND k.deleted_at IS NULL ${ORDER}`,
    [clubId],
  );
  return rows.map(toRecording);
}

/**
 * El nombre del archivo de video de una grabación reproducible (disponible, con archivo) y visible; null si no hay.
 * Es lo que usa el corte de un fragmento: el archivo sale de la base, nunca del pedido.
 */
export async function getPlayableVideoFile(db: Database, id: string): Promise<string | null> {
  const [row] = await db.query<{ video_file: string }>(
    `SELECT r.video_file
       FROM recordings r
       JOIN courts k ON k.id = r.court_id
       JOIN clubs c ON c.id = k.club_id
      WHERE r.id = $1 AND r.status = 'available' AND r.video_file IS NOT NULL AND ${PUBLIC_VISIBLE}`,
    [id],
  );
  return row?.video_file ?? null;
}
