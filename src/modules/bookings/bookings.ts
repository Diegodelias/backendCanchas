import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Database } from '../../db/client.js';
import { AppError, badRequest } from '../../lib/errors.js';
import { ATTEMPT_WINDOW_MS } from '../auth/attempts.js';
import type { BookableCourt } from './slots.js';
import { formatHour, isBookableStart, isoWeekday, MAX_DAYS_AHEAD, SLOT_MS, toArgentina } from './time.js';

/** Reservas que puede hacer una misma IP dentro de la ventana de 15 minutos (la misma que usa el acceso). */
export const MAX_BOOKINGS_PER_IP = 10;

const startsAt = z.iso.datetime({ offset: true, error: 'Elegí un turno válido.' });

const name = z
  .string({ error: 'Poné tu nombre.' })
  .trim()
  .min(1, 'Poné tu nombre.')
  .max(80, 'El nombre puede tener hasta 80 caracteres.');

const email = z
  .string({ error: 'Poné tu mail.' })
  .trim()
  .max(254, 'El mail es demasiado largo.')
  .pipe(z.email('El mail no es válido.'));

const phone = z
  .string()
  .trim()
  .max(30, 'El teléfono puede tener hasta 30 caracteres.')
  .optional()
  .transform((value) => (value ? value : undefined))
  .refine((value) => value === undefined || value.length >= 6, 'El teléfono es demasiado corto.');

/** Lo que manda un jugador con sesión: solo el turno (el nombre y el mail salen de su cuenta). */
export const playerBookingBody = z.object({ startsAt });
/** Lo que manda un invitado: el turno, su nombre y su mail, y opcionalmente un teléfono. */
export const guestBookingBody = z.object({ startsAt, name, email, phone });

export interface BookingGuest {
  name: string;
  email: string;
  phone?: string;
}

export interface CreatedBooking {
  id: string;
  startsAt: Date;
  price: number;
  name: string;
  email: string;
}

export const slotTaken = () => new AppError(409, 'slot_taken', 'Ese turno ya fue tomado. Elegí otro horario.');

/** Rechaza si la IP ya hizo el máximo de reservas en los últimos 15 minutos. */
export async function assertBookingRateLimit(db: Database, ip: string, now: Date): Promise<void> {
  const [row] = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM bookings WHERE created_ip = $1 AND created_at > $2`,
    [ip, new Date(now.getTime() - ATTEMPT_WINDOW_MS)],
  );
  if ((row?.n ?? 0) >= MAX_BOOKINGS_PER_IP) {
    throw new AppError(
      429,
      'too_many_bookings',
      'Hiciste demasiadas reservas seguidas desde esta conexión. Esperá 15 minutos y probá de nuevo.',
    );
  }
}

/**
 * Valida que el turno sea uno que la cancha ofrece (en punto, en la ventana y dentro del horario de ese día).
 * Una cancha sin ningún horario no es reservable: se responde como si no existiera.
 */
export async function assertSlotOffered(db: Database, courtId: string, start: Date, now: Date): Promise<void> {
  const [hasSchedule] = await db.query<{ ok: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM court_schedules WHERE court_id = $1) AS ok`,
    [courtId],
  );
  if (!hasSchedule?.ok) throw new AppError(404, 'not_found', 'No encontramos esa cancha.');

  if (start.getTime() % SLOT_MS !== 0) {
    throw badRequest('El turno tiene que empezar en una hora en punto.', 'validation_error');
  }
  if (!isBookableStart(start, now)) {
    throw badRequest(
      `Ese turno ya no se puede reservar. Se reserva con al menos 1 hora de anticipación y hasta ${MAX_DAYS_AHEAD} días adelante.`,
      'validation_error',
    );
  }
  const { date, hour } = toArgentina(start);
  const [range] = await db.query<{ start_hour: number; end_hour: number }>(
    `SELECT start_hour, end_hour FROM court_schedules WHERE court_id = $1 AND weekday = $2`,
    [courtId, isoWeekday(date)],
  );
  if (!range || hour < range.start_hour || hour >= range.end_hour) {
    throw badRequest(`La cancha no abre a las ${formatHour(hour)} ese día.`, 'validation_error');
  }
}

/** Guarda la reserva. El índice único (cancha, inicio) decide quién gana si dos piden el mismo turno a la vez. */
export async function insertBooking(
  db: Database,
  court: BookableCourt,
  start: Date,
  who: BookingGuest & { playerId: string | null },
  ip: string,
  now: Date,
): Promise<CreatedBooking> {
  try {
    const rows = await db.query<{ id: string }>(
      `INSERT INTO bookings (id, court_id, starts_at, price, player_id, name, email, phone, created_ip, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [`b-${randomUUID()}`, court.id, start, court.price, who.playerId, who.name, who.email, who.phone ?? null, ip, now],
    );
    return { id: rows[0]!.id, startsAt: start, price: court.price, name: who.name, email: who.email };
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw slotTaken();
    throw err;
  }
}

export interface BookingListItem {
  id: string;
  startsAt: string;
  date: string;
  time: string;
  court: { id: string; name: string };
  name: string;
  email: string;
  phone: string | null;
  price: number;
  /** true si la reserva la hizo un jugador con cuenta. */
  fromPlayer: boolean;
}

/** Las reservas de las canchas de un club, de la fecha de turno más lejana a la más cercana. Solo lectura. */
export async function listClubBookings(db: Database, clubId: string): Promise<BookingListItem[]> {
  const rows = await db.query<{
    id: string;
    starts_at: Date;
    court_id: string;
    court_name: string;
    name: string;
    email: string;
    phone: string | null;
    price: number;
    player_id: string | null;
  }>(
    `SELECT b.id, b.starts_at, b.court_id, k.name AS court_name, b.name, b.email, b.phone, b.price, b.player_id
       FROM bookings b JOIN courts k ON k.id = b.court_id
      WHERE k.club_id = $1
      ORDER BY b.starts_at DESC, b.id`,
    [clubId],
  );
  return rows.map((row) => {
    const { date, hour } = toArgentina(new Date(row.starts_at));
    return {
      id: row.id,
      startsAt: new Date(row.starts_at).toISOString(),
      date,
      time: formatHour(hour),
      court: { id: row.court_id, name: row.court_name },
      name: row.name,
      email: row.email,
      phone: row.phone,
      price: row.price,
      fromPlayer: row.player_id !== null,
    };
  });
}
