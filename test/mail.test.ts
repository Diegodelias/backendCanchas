import nodemailer from 'nodemailer';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { accessEmail, ACCESS_EMAIL_SUBJECT } from '../src/modules/mail/accessEmail.js';
import { ConsoleMailer, createMailer, SmtpMailer } from '../src/modules/mail/mailer.js';

const LINK = 'http://localhost:3000/acceso?token=abc123';
const base = { DATABASE_URL: 'postgres://x/y' };

describe('contenido del mail de acceso', () => {
  const mail = accessEmail('ana@mail.example', LINK);

  it('tiene el asunto, el link como texto y un botón', () => {
    expect(mail.to).toBe('ana@mail.example');
    expect(mail.subject).toBe(ACCESS_EMAIL_SUBJECT);
    expect(mail.subject).toBe('Tu acceso a Canchas3');
    expect(mail.text).toContain(LINK);
    expect(mail.html).toContain(`href="${LINK}"`);
    expect(mail.html).toContain('Ingresar a Canchas3');
  });

  it('avisa que vence en 15 minutos y que se puede ignorar', () => {
    expect(mail.text).toContain('15 minutos');
    expect(mail.text).toContain('ignorá este mensaje');
    expect(mail.html).toContain('15 minutos');
  });

  it('escapa el HTML de la dirección', () => {
    const risky = accessEmail('a@b.example', 'http://x.example/acceso?a=1&b="2"<3');
    expect(risky.html).not.toContain('"2"<3');
    expect(risky.html).toContain('&amp;b=&quot;2&quot;&lt;3');
  });
});

describe('createMailer', () => {
  const noLog = { info() {} };

  it('sin SMTP_URL usa la consola', () => {
    expect(createMailer(loadConfig(base), noLog)).toBeInstanceOf(ConsoleMailer);
  });

  it('con SMTP_URL usa SMTP', () => {
    const config = loadConfig({ ...base, SMTP_URL: 'smtp://127.0.0.1:2525' });
    expect(createMailer(config, noLog)).toBeInstanceOf(SmtpMailer);
  });
});

describe('ConsoleMailer', () => {
  it('escribe el link en el log y no envía nada', async () => {
    const lines: { obj: object; msg: string }[] = [];
    const mailer = new ConsoleMailer({ info: (obj, msg) => lines.push({ obj, msg }) });
    await mailer.send(accessEmail('ana@mail.example', LINK));
    expect(lines).toHaveLength(1);
    expect(lines[0]!.msg).toContain(LINK);
    expect(lines[0]!.obj).toMatchObject({ to: 'ana@mail.example', subject: 'Tu acceso a Canchas3' });
  });
});

describe('SmtpMailer', () => {
  it('envía el mensaje con el remitente configurado', async () => {
    const transport = nodemailer.createTransport({ jsonTransport: true });
    const mailer = new SmtpMailer(transport, 'Canchas3 <hola@canchas3.example>');
    const sent: { envelope: { to: string[] }; message: string }[] = [];
    const original = transport.sendMail.bind(transport);
    transport.sendMail = (async (options: Parameters<typeof original>[0]) => {
      const info = (await original(options)) as unknown as { envelope: { to: string[] }; message: string };
      sent.push(info);
      return info;
    }) as typeof transport.sendMail;

    await mailer.send(accessEmail('ana@mail.example', LINK));

    expect(sent).toHaveLength(1);
    expect(sent[0]!.envelope.to).toEqual(['ana@mail.example']);
    const body = JSON.parse(sent[0]!.message) as { from: { address: string; name: string }; subject: string; text: string };
    expect(body.from.address).toBe('hola@canchas3.example');
    expect(body.subject).toBe('Tu acceso a Canchas3');
    expect(body.text).toContain(LINK);
  });

  it('propaga el error si el servidor SMTP falla', async () => {
    const transport = nodemailer.createTransport({ host: '127.0.0.1', port: 1, connectionTimeout: 1000 });
    const mailer = new SmtpMailer(transport, 'Canchas3 <hola@canchas3.example>');
    await expect(mailer.send(accessEmail('ana@mail.example', LINK))).rejects.toThrow();
  });
});
