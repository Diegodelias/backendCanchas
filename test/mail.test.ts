import nodemailer from 'nodemailer';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { accessEmail, ACCESS_EMAIL_SUBJECT } from '../src/modules/mail/accessEmail.js';
import { inviteEmail, inviteEmailSubject } from '../src/modules/mail/inviteEmail.js';
import { ConsoleMailer, createMailer, SmtpMailer } from '../src/modules/mail/mailer.js';

const LINK = 'http://localhost:3000/acceso?token=abc123';
const base = { DATABASE_URL: 'postgres://x/y' };

describe('contenido del mail de invitación de un admin', () => {
  const INVITE_LINK = 'http://localhost:3000/invitacion?token=abc123';
  const mail = inviteEmail('ana@club.example', INVITE_LINK, 'Estación Norte Club', 'Ana Pérez');

  it('el asunto nombra al club y el mensaje trae el link como texto y un botón', () => {
    expect(mail.to).toBe('ana@club.example');
    expect(mail.subject).toBe('Te invitaron a administrar Estación Norte Club en Canchas3');
    expect(inviteEmailSubject('Otro Club')).toBe('Te invitaron a administrar Otro Club en Canchas3');
    expect(mail.text).toContain(INVITE_LINK);
    expect(mail.text).toContain('Estación Norte Club');
    expect(mail.html).toContain(`href="${INVITE_LINK}"`);
    expect(mail.html).toContain('Elegir mi contraseña');
  });

  it('avisa que vence en 72 horas, que se usa una sola vez y que se puede ignorar', () => {
    for (const body of [mail.text, mail.html]) {
      expect(body).toContain('72 horas');
      expect(body).toContain('una sola vez');
      expect(body).toContain('ignorá este mensaje');
    }
    expect(mail.text).not.toContain('15 minutos');
  });

  it('saluda por el nombre si lo tiene, y sin nombre saluda igual', () => {
    expect(mail.text.startsWith('Hola Ana Pérez:')).toBe(true);
    expect(inviteEmail('a@b.example', INVITE_LINK, 'Club', null).text.startsWith('Hola:')).toBe(true);
  });

  it('escapa el HTML del nombre del club, del nombre del admin y de la dirección', () => {
    const risky = inviteEmail('a@b.example', 'http://x.example/i?a=1&b="2"<3', '<b>Club</b>', '<script>x</script>');
    expect(risky.html).not.toContain('<b>Club</b>');
    expect(risky.html).not.toContain('<script>');
    expect(risky.html).not.toContain('"2"<3');
    expect(risky.html).toContain('&lt;b&gt;Club&lt;/b&gt;');
  });

  it('la dirección del link parte de la dirección pública configurada', () => {
    const config = loadConfig({ ...base, PUBLIC_APP_URL: 'https://canchas3.example' });
    const link = `${config.PUBLIC_APP_URL}/invitacion?token=t`;
    expect(inviteEmail('a@b.example', link, 'Club', null).text).toContain('https://canchas3.example/invitacion?token=t');
  });
});

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

  it('el transporte SMTP tiene tiempos máximos y conserva el usuario, la clave y el puerto de la URL', () => {
    const config = loadConfig({ ...base, SMTP_URL: 'smtps://ana%40club.example:cl%2Ave@mail.club.example:465' });
    const mailer = createMailer(config, noLog) as unknown as { transport: { options: Record<string, unknown> } };
    const options = mailer.transport.options as { host: string; port: number; secure: boolean; auth: { user: string; pass: string } };
    expect(options).toMatchObject({ host: 'mail.club.example', port: 465, secure: true });
    expect(options.auth).toEqual({ user: 'ana@club.example', pass: 'cl*ve' });
    expect(options).toMatchObject({ connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000 });
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
