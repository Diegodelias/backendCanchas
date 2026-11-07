import type { MailMessage } from './mailer.js';

export const ACCESS_EMAIL_SUBJECT = 'Tu acceso a Canchas3';

const escapeHtml = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Mail con el link de acceso: botón, dirección visible y aviso de vencimiento. */
export function accessEmail(to: string, link: string): MailMessage {
  const text = [
    'Hola:',
    '',
    'Usá este link para ingresar a Canchas3 y ver tus jugadas:',
    link,
    '',
    'El link vence en 15 minutos y se puede usar una sola vez.',
    'Si no lo pediste vos, ignorá este mensaje: nadie va a entrar a tu cuenta.',
  ].join('\n');

  const safeLink = escapeHtml(link);
  const html = `<!doctype html>
<html lang="es"><body style="margin:0;padding:24px;background:#f4f5f2;font-family:Arial,Helvetica,sans-serif;color:#101510">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
    <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:12px;padding:28px">
      <tr><td>
        <h1 style="margin:0 0 12px;font-size:22px">Tu acceso a Canchas3</h1>
        <p style="margin:0 0 20px;line-height:1.5">Tocá el botón para ingresar y ver tus jugadas.</p>
        <p style="margin:0 0 20px"><a href="${safeLink}" style="display:inline-block;background:#c8f03a;color:#101510;text-decoration:none;font-weight:bold;padding:12px 22px;border-radius:10px">Ingresar a Canchas3</a></p>
        <p style="margin:0 0 6px;font-size:13px;color:#555">Si el botón no funciona, copiá este link en tu navegador:</p>
        <p style="margin:0 0 20px;font-size:13px;word-break:break-all"><a href="${safeLink}" style="color:#1a5c2e">${safeLink}</a></p>
        <p style="margin:0;font-size:13px;color:#555;line-height:1.5">El link vence en 15 minutos y se puede usar una sola vez. Si no lo pediste vos, ignorá este mensaje: nadie va a entrar a tu cuenta.</p>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;

  return { to, subject: ACCESS_EMAIL_SUBJECT, text, html };
}
