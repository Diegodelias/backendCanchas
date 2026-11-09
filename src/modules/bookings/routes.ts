import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../../app.js';
import { badRequest } from '../../lib/errors.js';
import { resolveSession, SESSION_COOKIE } from '../auth/sessions.js';
import { bookingEmail } from '../mail/bookingEmail.js';
import {
  assertBookingRateLimit,
  assertSlotOffered,
  guestBookingBody,
  insertBooking,
  playerBookingBody,
  type BookingGuest,
} from './bookings.js';
import { daySlots, requireBookableCourt } from './slots.js';
import { bookingWindow, formatHour, MAX_DAYS_AHEAD, parseDate, toArgentina } from './time.js';

const courtParam = z.object({ courtId: z.string().min(1).max(100) });
const slotsQuery = z.object({ date: z.string({ error: 'Indicá el día con el formato AAAA-MM-DD.' }) });

/** Rutas públicas de turnos y reservas (`/api/courts/...`). */
export async function bookingsRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db } = deps;
  const mailer = deps.mailer;
  if (!mailer) throw new Error('bookingsRoutes necesita un mailer (lo arma buildApp).');
  const now = deps.now ?? (() => new Date());

  // GET /api/courts/:courtId/slots?date=YYYY-MM-DD -> { court, date, slots, booked }: los turnos libres de ese día (en hora
  // de Argentina) y, aparte, los que ya están reservados (solo el horario, sin datos de quien reservó).
  // Público; sin copia guardada, porque un turno se ocupa y se libera en cualquier momento.
  app.get('/courts/:courtId/slots', async (req, reply) => {
    const { courtId } = courtParam.parse(req.params);
    const { date } = slotsQuery.parse(req.query);
    const { from, to } = bookingWindow(now());
    if (!parseDate(date)) throw badRequest('La fecha no es válida. Usá el formato AAAA-MM-DD.', 'validation_error');
    if (date < from || date > to) {
      throw badRequest(`Podés reservar desde hoy (${from}) hasta ${MAX_DAYS_AHEAD} días después (${to}).`, 'validation_error');
    }
    const court = await requireBookableCourt(db, courtId);
    reply.header('Cache-Control', 'no-store');
    const { slots, booked } = await daySlots(db, courtId, date, now());
    return { court: { id: court.id, name: court.name, price: court.price }, date, slots, booked };
  });

  // POST /api/courts/:courtId/bookings -> 201 { booking, emailSent }. Sin sesión (invitado: nombre y mail) o con sesión
  // de jugador (su cuenta). 404 si la cancha no se puede reservar, 409 si el turno ya fue tomado, 429 por IP.
  app.post('/courts/:courtId/bookings', async (req, reply) => {
    const { courtId } = courtParam.parse(req.params);
    const at = now();
    const user = await resolveSession(db, req.cookies[SESSION_COOKIE], at);
    const player = user?.role === 'player' ? user : null;
    // Una sesión de admin o de superadmin no cuenta como jugador: reserva como invitado.
    let startsAt: string;
    let who: BookingGuest;
    if (player) {
      startsAt = playerBookingBody.parse(req.body).startsAt;
      who = { name: player.name ?? player.email.split('@')[0]!, email: player.email };
    } else {
      const guest = guestBookingBody.parse(req.body);
      startsAt = guest.startsAt;
      who = { name: guest.name, email: guest.email, phone: guest.phone };
    }

    const court = await requireBookableCourt(db, courtId);
    await assertBookingRateLimit(db, req.ip, at);
    const start = new Date(startsAt);
    await assertSlotOffered(db, court.id, start, at);
    const booking = await insertBooking(db, court, start, { ...who, playerId: player?.id ?? null }, req.ip, at);

    // La reserva ya está guardada: el mail es un extra y su fallo no la deshace.
    let emailSent = true;
    try {
      await mailer.send(
        bookingEmail(booking.email, { clubName: court.clubName, courtName: court.name, startsAt: start, price: court.price, name: booking.name }),
      );
    } catch (err) {
      emailSent = false;
      // Solo el tipo de error y el id de la reserva: ni el destinatario ni el cuerpo del mail van al log.
      app.log.error({ errorName: (err as Error).name, code: (err as { code?: string }).code, bookingId: booking.id }, 'No se pudo enviar el mail de la reserva');
    }

    const { date, hour } = toArgentina(start);
    return reply.status(201).send({
      booking: {
        id: booking.id,
        club: { id: court.clubId, name: court.clubName },
        court: { id: court.id, name: court.name },
        startsAt: start.toISOString(),
        date,
        time: formatHour(hour),
        price: booking.price,
        name: booking.name,
        email: booking.email,
      },
      emailSent,
    });
  });
}
