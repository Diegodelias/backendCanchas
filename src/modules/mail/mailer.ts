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
  ) {}

  async send(message: MailMessage): Promise<void> {
    await this.transport.sendMail({
      from: this.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
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
    ? new SmtpMailer(nodemailer.createTransport({ url: config.SMTP_URL, ...SMTP_TIMEOUTS }), config.MAIL_FROM)
    : new ConsoleMailer(log);
}
