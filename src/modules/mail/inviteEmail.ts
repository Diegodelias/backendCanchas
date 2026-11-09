import { DEFAULT_SITE_NAME } from '../site/settings.js';
import type { MailMessage } from './mailer.js';

/** Cuánto vive una invitación, para el aviso del mail (la vigencia real está en `auth/links.ts`). */
export const INVITE_VALID_HOURS = 72;

const escapeHtml = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const inviteEmailSubject = (clubName: string, siteName: string = DEFAULT_SITE_NAME) =>
  `Te invitaron a administrar ${clubName} en ${siteName}`;

/** Mail con el link para elegir la contraseña y entrar al panel del club: botón, dirección visible y aviso de vencimiento. */
export function inviteEmail(
  to: string,
  link: string,
  clubName: string,
  adminName: string | null,
  siteName: string = DEFAULT_SITE_NAME,
): MailMessage {
  const greeting = adminName ? `Hola ${adminName}:` : 'Hola:';
  const text = [
    greeting,
    '',
    `Te invitaron a administrar «${clubName}» en ${siteName}. Usá este link para elegir tu contraseña y entrar a tu panel:`,
    link,
    '',
    `El link vence en ${INVITE_VALID_HOURS} horas y se puede usar una sola vez.`,
    'Si no esperabas esta invitación, ignorá este mensaje: no pasa nada hasta que uses el link.',
  ].join('\n');

  const safeLink = escapeHtml(link);
  const safeClub = escapeHtml(clubName);
  const safeSite = escapeHtml(siteName);
  const safeGreeting = escapeHtml(greeting);
  const html = `<!doctype html>
<html lang="es"><body style="margin:0;padding:24px;background:#f4f5f2;font-family:Arial,Helvetica,sans-serif;color:#101510">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
    <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:12px;padding:28px">
      <tr><td>
        <h1 style="margin:0 0 12px;font-size:22px">Te invitaron a administrar ${safeClub}</h1>
        <p style="margin:0 0 12px;line-height:1.5">${safeGreeting}</p>
        <p style="margin:0 0 20px;line-height:1.5">Te sumaron como administrador de <strong>${safeClub}</strong> en ${safeSite}. Tocá el botón para elegir tu contraseña y entrar a tu panel.</p>
        <p style="margin:0 0 20px"><a href="${safeLink}" style="display:inline-block;background:#c8f03a;color:#101510;text-decoration:none;font-weight:bold;padding:12px 22px;border-radius:10px">Elegir mi contraseña</a></p>
        <p style="margin:0 0 6px;font-size:13px;color:#555">Si el botón no funciona, copiá este link en tu navegador:</p>
        <p style="margin:0 0 20px;font-size:13px;word-break:break-all"><a href="${safeLink}" style="color:#1a5c2e">${safeLink}</a></p>
        <p style="margin:0;font-size:13px;color:#555;line-height:1.5">El link vence en ${INVITE_VALID_HOURS} horas y se puede usar una sola vez. Si no esperabas esta invitación, ignorá este mensaje: no pasa nada hasta que uses el link.</p>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;

  return { to, subject: inviteEmailSubject(clubName, siteName), text, html, fromName: siteName };
}
