import type { MailMessage } from './mailer.js';

export const ACCESS_EMAIL_SUBJECT = 'Tu acceso a Canchas3';

const escapeHtml = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Mail de acceso: el código de 6 dígitos bien visible arriba del botón y el link como alternativa.
 * El código no va en el asunto: se vería en las notificaciones del teléfono bloqueado.
 */
export function accessEmail(to: string, link: string, code: string): MailMessage {
  const text = [
    'Hola:',
    '',
    'Si estás en el celular, escribí este código en la pantalla de Canchas3:',
    `Tu código: ${code}`,
    '',
    'O usá este link para ingresar a Canchas3 y ver tus jugadas:',
    link,
    '',
    'El código y el link vencen en 15 minutos y se pueden usar una sola vez (usar uno invalida el otro).',
    'Si no lo pediste vos, ignorá este mensaje: nadie va a entrar a tu cuenta.',
  ].join('\n');

  const safeLink = escapeHtml(link);
  const safeCode = escapeHtml(code);
  const html = `<!doctype html>
<html lang="es"><body style="margin:0;padding:24px;background:#f4f5f2;font-family:Arial,Helvetica,sans-serif;color:#101510">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
    <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:12px;padding:28px">
      <tr><td>
        <h1 style="margin:0 0 12px;font-size:22px">Tu acceso a Canchas3</h1>
        <p style="margin:0 0 8px;line-height:1.5">Si estás en el celular, escribí este código en la pantalla de Canchas3:</p>
        <p style="margin:0 0 20px;font-size:32px;font-weight:bold;letter-spacing:8px;font-family:'Courier New',monospace">${safeCode}</p>
        <p style="margin:0 0 12px;line-height:1.5">O tocá el botón para ingresar y ver tus jugadas.</p>
        <p style="margin:0 0 20px"><a href="${safeLink}" style="display:inline-block;background:#c8f03a;color:#101510;text-decoration:none;font-weight:bold;padding:12px 22px;border-radius:10px">Ingresar a Canchas3</a></p>
        <p style="margin:0 0 6px;font-size:13px;color:#555">Si el botón no funciona, copiá este link en tu navegador:</p>
        <p style="margin:0 0 20px;font-size:13px;word-break:break-all"><a href="${safeLink}" style="color:#1a5c2e">${safeLink}</a></p>
        <p style="margin:0;font-size:13px;color:#555;line-height:1.5">El código y el link vencen en 15 minutos y se pueden usar una sola vez (usar uno invalida el otro). Si no lo pediste vos, ignorá este mensaje: nadie va a entrar a tu cuenta.</p>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;

  return { to, subject: ACCESS_EMAIL_SUBJECT, text, html };
}
