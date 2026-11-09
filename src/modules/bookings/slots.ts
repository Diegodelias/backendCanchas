import type { Database } from '../../db/client.js';
import { notFound } from '../../lib/errors.js';
import { formatHour, isBookableStart, isoWeekday, slotStart, toArgentina } from './time.js';

export interface BookableCourt {
  id: string;
  name: string;
  price: number;
  clubId: string;
  clubName: string;
}

/** Una cancha que se puede consultar y reservar: activa, no borrada y de un club activo. Si no, 404. */
export async function requireBookableCourt(db: Database, courtId: string): Promise<BookableCourt> {
  const [court] = await db.query<BookableCourt>(
    `SELECT k.id, k.name, k.price, c.id AS "clubId", c.name AS "clubName"
       FROM courts k JOIN clubs c ON c.id = k.club_id
      WHERE k.id = $1 AND k.active AND k.deleted_at IS NULL AND c.active`,
    [courtId],
  );
  if (!court) throw notFound('No encontramos esa cancha.');
  return court;
}

export interface Slot {
  /** Inicio del turno como instante (ISO 8601); es lo que se manda para reservar. */
  startsAt: string;
  /** Hora de inicio en Argentina, `HH:00`. */
  time: string;
}

export interface DaySlots {
  /** Turnos que se pueden reservar. */
  slots: Slot[];
  /** Turnos que se ofrecerían pero ya están reservados. Solo el horario: nunca datos de quien reservó. */
  booked: Slot[];
}

/**
 * Turnos de un día (`YYYY-MM-DD` ya validado y dentro de la ventana): las horas del rango de ese día de la semana que
 * cumplen la anticipación mínima, repartidas en libres y reservadas. Un turno que no cumple la anticipación mínima no
 * aparece en ninguna de las dos listas. Se calculan al consultar.
 */
export async function daySlots(db: Database, courtId: string, date: string, now: Date): Promise<DaySlots> {
  const [range] = await db.query<{ start_hour: number; end_hour: number }>(
    `SELECT start_hour, end_hour FROM court_schedules WHERE court_id = $1 AND weekday = $2`,
    [courtId, isoWeekday(date)],
  );
  if (!range) return { slots: [], booked: [] };

  const dayStart = slotStart(date, 0);
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
  const reserved = await db.query<{ starts_at: Date }>(
    `SELECT starts_at FROM bookings WHERE court_id = $1 AND starts_at >= $2 AND starts_at < $3`,
    [courtId, dayStart, dayEnd],
  );
  const taken = new Set(reserved.map((b) => toArgentina(b.starts_at).hour));

  const slots: Slot[] = [];
  const booked: Slot[] = [];
  for (let hour = range.start_hour; hour < range.end_hour; hour++) {
    const start = slotStart(date, hour);
    if (!isBookableStart(start, now)) continue;
    (taken.has(hour) ? booked : slots).push({ startsAt: start.toISOString(), time: formatHour(hour) });
  }
  return { slots, booked };
}
