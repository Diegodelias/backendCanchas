import { z } from 'zod';
import type { Database } from '../../db/client.js';
import { notFound } from '../../lib/errors.js';

/** Horario semanal de una cancha: un rango por día (en horas enteras, dentro del mismo día). Sin rango = cerrado. */

export const WEEKDAY_NAMES = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'] as const;

const day = z.object({
  weekday: z
    .number({ error: 'El día debe ser un número del 1 (lunes) al 7 (domingo).' })
    .int('El día debe ser un número del 1 (lunes) al 7 (domingo).')
    .min(1, 'El día debe ser un número del 1 (lunes) al 7 (domingo).')
    .max(7, 'El día debe ser un número del 1 (lunes) al 7 (domingo).'),
  startHour: z.number({ error: 'La hora de apertura debe ser un número.' }).int('Las horas deben ser en punto.'),
  endHour: z.number({ error: 'La hora de cierre debe ser un número.' }).int('Las horas deben ser en punto.'),
});

export const scheduleBody = z
  .object({ days: z.array(day, { error: 'Mandá la lista de días con horario.' }).max(7, 'Hay solo 7 días en la semana.') })
  .superRefine((body, ctx) => {
    const seen = new Set<number>();
    body.days.forEach((d, index) => {
      const name = WEEKDAY_NAMES[d.weekday - 1];
      const fail = (message: string) => ctx.addIssue({ code: 'custom', path: ['days', index], message: `${name}: ${message}` });
      if (seen.has(d.weekday)) return fail('el día está repetido.');
      seen.add(d.weekday);
      if (d.startHour < 0 || d.startHour > 23) return fail('la apertura debe ser entre las 00:00 y las 23:00.');
      if (d.endHour < 1 || d.endHour > 24) return fail('el cierre debe ser entre la 01:00 y las 24:00.');
      if (d.endHour <= d.startHour) return fail('el cierre debe ser posterior a la apertura.');
      if (d.endHour - d.startHour < 1) return fail('el rango debe durar al menos 60 minutos.');
    });
  });

export type ScheduleDay = z.infer<typeof day>;

/** La cancha existe, es del club, no está borrada; si no, 404 (las tres se responden igual). */
export async function requireCourt(db: Database, clubId: string, courtId: string) {
  const [court] = await db.query<{ id: string; name: string }>(
    `SELECT id, name FROM courts WHERE id = $1 AND club_id = $2 AND deleted_at IS NULL`,
    [courtId, clubId],
  );
  if (!court) throw notFound('No encontramos esa cancha.');
  return court;
}

/** El horario de la cancha, ordenado por día. */
export async function getSchedule(db: Database, courtId: string): Promise<ScheduleDay[]> {
  const rows = await db.query<{ weekday: number; start_hour: number; end_hour: number }>(
    `SELECT weekday, start_hour, end_hour FROM court_schedules WHERE court_id = $1 ORDER BY weekday`,
    [courtId],
  );
  return rows.map((r) => ({ weekday: r.weekday, startHour: r.start_hour, endHour: r.end_hour }));
}

/**
 * Reemplaza todo el horario en una sola sentencia (todo o nada): inserta o actualiza los días nuevos y borra
 * el resto. No toca las reservas.
 */
export async function replaceSchedule(db: Database, courtId: string, days: ScheduleDay[]): Promise<ScheduleDay[]> {
  await db.query(
    `WITH upserted AS (
       INSERT INTO court_schedules (court_id, weekday, start_hour, end_hour)
       SELECT $1::text, d.weekday, d.start_hour, d.end_hour
         FROM unnest($2::int[], $3::int[], $4::int[]) AS d(weekday, start_hour, end_hour)
       ON CONFLICT (court_id, weekday) DO UPDATE SET start_hour = EXCLUDED.start_hour, end_hour = EXCLUDED.end_hour
       RETURNING weekday
     )
     DELETE FROM court_schedules WHERE court_id = $1::text AND weekday <> ALL($2::int[])`,
    [courtId, days.map((d) => d.weekday), days.map((d) => d.startHour), days.map((d) => d.endHour)],
  );
  return getSchedule(db, courtId);
}
