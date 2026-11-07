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

/** SMTP si hay `SMTP_URL`; si no, la consola. */
export function createMailer(config: Config, log: MailLogger): Mailer {
  return config.SMTP_URL ? new SmtpMailer(nodemailer.createTransport(config.SMTP_URL), config.MAIL_FROM) : new ConsoleMailer(log);
}
