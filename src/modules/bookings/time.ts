/**
 * Hora de Argentina (America/Argentina/Buenos_Aires). No tiene horario de verano: es siempre UTC-3,
 * así que alcanza con un desfasaje fijo, sin librería de zonas horarias.
 */
const ARGENTINA_OFFSET_HOURS = 3;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Turnos de 60 minutos, en hora en punto. */
export const SLOT_MS = HOUR_MS;
/** Un turno se ofrece si empieza al menos 1 hora después de ahora... */
export const MIN_ADVANCE_MS = HOUR_MS;
/** ...y dentro de los 14 días siguientes a hoy (hoy + 14 días). */
export const MAX_DAYS_AHEAD = 14;

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Una fecha `YYYY-MM-DD` válida del calendario, o null. */
export function parseDate(value: string): { y: number; m: number; d: number } | null {
  const match = DATE_PATTERN.exec(value);
  if (!match) return null;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return null;
  return { y, m, d };
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Hoy en Argentina, como `YYYY-MM-DD`. */
export function todayInArgentina(now: Date): string {
  return new Date(now.getTime() - ARGENTINA_OFFSET_HOURS * HOUR_MS).toISOString().slice(0, 10);
}

/** Suma días a una fecha `YYYY-MM-DD` ya válida. */
export function addDays(date: string, days: number): string {
  const { y, m, d } = parseDate(date)!;
  return new Date(Date.UTC(y, m - 1, d) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Día de la semana ISO de una fecha: 1 = lunes ... 7 = domingo. */
export function isoWeekday(date: string): number {
  const { y, m, d } = parseDate(date)!;
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return day === 0 ? 7 : day;
}

/** El instante en que empieza la hora `hour` (0..23) de ese día en Argentina. */
export function slotStart(date: string, hour: number): Date {
  const { y, m, d } = parseDate(date)!;
  return new Date(Date.UTC(y, m - 1, d, hour + ARGENTINA_OFFSET_HOURS));
}

/** Fecha y hora (en Argentina) de un instante. */
export function toArgentina(instant: Date): { date: string; hour: number } {
  const shifted = new Date(instant.getTime() - ARGENTINA_OFFSET_HOURS * HOUR_MS);
  return { date: shifted.toISOString().slice(0, 10), hour: shifted.getUTCHours() };
}

export const formatHour = (hour: number) => `${pad(hour)}:00`;

/** Primer y último día que se pueden reservar, desde el reloj `now`. */
export function bookingWindow(now: Date): { from: string; to: string } {
  const from = todayInArgentina(now);
  return { from, to: addDays(from, MAX_DAYS_AHEAD) };
}

/** true si el turno que empieza en `start` se puede reservar ahora (anticipación mínima y ventana de días). */
export function isBookableStart(start: Date, now: Date): boolean {
  if (start.getTime() < now.getTime() + MIN_ADVANCE_MS) return false;
  const { date } = toArgentina(start);
  const { from, to } = bookingWindow(now);
  return date >= from && date <= to;
}
