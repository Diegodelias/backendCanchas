import type { MailMessage } from './mailer.js';

const escapeHtml = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const bookingEmailSubject = (clubName: string) => `Confirmamos tu reserva en ${clubName}`;

export interface BookingEmailData {
  clubName: string;
  courtName: string;
  /** Inicio del turno como instante. */
  startsAt: Date;
  price: number;
  name: string;
}

const dayFormat = new Intl.DateTimeFormat('es-AR', {
  timeZone: 'America/Argentina/Buenos_Aires',
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});
const hourFormat = new Intl.DateTimeFormat('es-AR', {
  timeZone: 'America/Argentina/Buenos_Aires',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** Mail de confirmación de una reserva: club, cancha, día, hora y precio. El turno se paga en el club. */
export function bookingEmail(to: string, data: BookingEmailData): MailMessage {
  const day = dayFormat.format(data.startsAt);
  const hour = hourFormat.format(data.startsAt);
  const price = `$ ${data.price.toLocaleString('es-AR')}`;
  const greeting = `Hola ${data.name}:`;

  const text = [
    greeting,
    '',
    `Tu reserva está confirmada.`,
    '',
    `Club: ${data.clubName}`,
    `Cancha: ${data.courtName}`,
    `Día: ${day}`,
    `Hora: ${hour} hs (dura 1 hora)`,
    `Precio: ${price}`,
    '',
    'El pago se hace en el club. Guardá este mail como comprobante.',
  ].join('\n');

  const row = (label: string, value: string) =>
    `<tr><td style="padding:4px 12px 4px 0;color:#555">${label}</td><td style="padding:4px 0"><strong>${escapeHtml(value)}</strong></td></tr>`;
  const html = `<!doctype html>
<html lang="es"><body style="margin:0;padding:24px;background:#f4f5f2;font-family:Arial,Helvetica,sans-serif;color:#101510">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
    <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:12px;padding:28px">
      <tr><td>
        <h1 style="margin:0 0 12px;font-size:22px">Tu reserva está confirmada</h1>
        <p style="margin:0 0 16px;line-height:1.5">${escapeHtml(greeting)}</p>
        <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px;font-size:15px">
          ${row('Club', data.clubName)}${row('Cancha', data.courtName)}${row('Día', day)}${row('Hora', `${hour} hs (dura 1 hora)`)}${row('Precio', price)}
        </table>
        <p style="margin:0;font-size:13px;color:#555;line-height:1.5">El pago se hace en el club. Guardá este mail como comprobante.</p>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;

  return { to, subject: bookingEmailSubject(data.clubName), text, html };
}
