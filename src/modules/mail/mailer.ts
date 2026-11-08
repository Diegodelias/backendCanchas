import nodemailer, { type Transporter } from 'nodemailer';
import type { Config } from '../../config.js';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** Cómo el backend envía mails. Cambiar de implementación es cambiar la configuración. */
export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

export interface MailLogger {
  info(obj: object, msg: string): void;
  warn?(obj: object, msg: string): void;
}

/** Desarrollo y pruebas: escribe el mensaje (con su link) en el log y no envía nada. */
export class ConsoleMailer implements Mailer {
  constructor(private readonly log: MailLogger) {}

  async send(message: MailMessage): Promise<void> {
    this.log.info(
      { to: message.to, subject: message.subject },
      `Mail (consola, no se envía):\n${message.text}`,
    );
  }
}

/** Envía por SMTP (el transporte se arma con la dirección smtp://usuario:clave@host:puerto). */
export class SmtpMailer implements Mailer {
  constructor(
    private readonly transport: Transporter,
    private readonly from: string,
    private readonly log?: MailLogger,
  ) {}

  async send(message: MailMessage): Promise<void> {
    try {
      const info = (await this.transport.sendMail({
        from: this.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
      })) as { accepted?: unknown[]; rejected?: unknown[]; response?: string };
      // Qué dijo el servidor, sin direcciones: sirve para saber si el mail salió o se perdió en el camino.
      this.log?.info(
        {
          accepted: info.accepted?.length ?? 0,
          rejected: info.rejected?.length ?? 0,
          responseCode: info.response?.match(/^\d{3}/)?.[0],
        },
        'Mail entregado al servidor SMTP',
      );
    } catch (err) {
      this.log?.warn?.(
        { errorName: (err as Error).name, code: (err as { code?: string }).code },
        'El servidor SMTP no aceptó el mail',
      );
      throw err;
    }
  }
}

/**
 * Tiempos máximos del transporte SMTP. Sin ellos `nodemailer` espera hasta 2 minutos por un servidor caído, y la
 * invitación de un admin (que espera el resultado del envío) dejaría la pantalla del superadmin colgada.
 */
export const SMTP_TIMEOUTS = {
  connectionTimeout: 10_000,
  greetingTimeout: 10_000,
  socketTimeout: 20_000,
} as const;

/** SMTP si hay `SMTP_URL`; si no, la consola. */
export function createMailer(config: Config, log: MailLogger): Mailer {
  return config.SMTP_URL
    ? new SmtpMailer(nodemailer.createTransport({ url: config.SMTP_URL, ...SMTP_TIMEOUTS }), config.MAIL_FROM, log)
    : new ConsoleMailer(log);
}

export interface MailDeliverySummary {
  /** Por qué medio salen los mails (nunca el usuario ni la clave). */
  info: string;
  /** Presente cuando los mails no llegan a ninguna casilla real. */
  warning?: string;
}

/** Resume cómo salen los mails según `SMTP_URL`, para registrarlo al arrancar. */
export function describeMailDelivery(smtpUrl: string | undefined): MailDeliverySummary {
  if (!smtpUrl) {
    return {
      info: 'Mails: se imprimen en este log (no hay SMTP_URL).',
      warning:
        'ATENCIÓN: los mails NO llegan a ninguna casilla real: se imprimen en este log. Configurá SMTP_URL para enviarlos.',
    };
  }
  let host = '';
  let port = '';
  try {
    const url = new URL(smtpUrl);
    host = url.hostname;
    port = url.port || (url.protocol === 'smtps:' ? '465' : '25');
  } catch {
    return { info: 'Mails: por SMTP, pero SMTP_URL no es una dirección válida.' };
  }
  const info = `Mails: se envían por SMTP a ${host}:${port}.`;
  if (host === 'mailpit' || port === '1025') {
    return {
      info,
      warning: `ATENCIÓN: ${host}:${port} es el buzón de pruebas: los mails NO llegan a ninguna casilla real. Se ven en el buzón de pruebas (http://localhost:8025).`,
    };
  }
  return { info };
}
