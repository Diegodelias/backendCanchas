import nodemailer from 'nodemailer';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createFakeDatabase, FakeMailer, testConfig } from './helpers.js';
import { accessEmail, ACCESS_EMAIL_SUBJECT } from '../src/modules/mail/accessEmail.js';
import { inviteEmail, inviteEmailSubject } from '../src/modules/mail/inviteEmail.js';
import { ConsoleMailer, createMailer, describeMailDelivery, SmtpMailer } from '../src/modules/mail/mailer.js';

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
  const mail = accessEmail('ana@mail.example', LINK, '048213');

  it('tiene el asunto, el link como texto y un botón', () => {
    expect(mail.to).toBe('ana@mail.example');
    expect(mail.subject).toBe(ACCESS_EMAIL_SUBJECT);
    expect(mail.subject).toBe('Tu acceso a Canchas3');
    expect(mail.text).toContain(LINK);
    expect(mail.html).toContain(`href="${LINK}"`);
    expect(mail.html).toContain('Ingresar a Canchas3');
  });

  it('muestra el código de 6 dígitos sin ponerlo en el asunto', () => {
    expect(mail.text).toContain('Tu código: 048213');
    expect(mail.html).toContain('048213');
    expect(mail.subject).not.toMatch(/\d{6}/);
  });

  it('avisa que vence en 15 minutos y que se puede ignorar', () => {
    expect(mail.text).toContain('15 minutos');
    expect(mail.text).toContain('ignorá este mensaje');
    expect(mail.html).toContain('15 minutos');
  });

  it('escapa el HTML de la dirección', () => {
    const risky = accessEmail('a@b.example', 'http://x.example/acceso?a=1&b="2"<3', '048213');
    expect(risky.html).not.toContain('"2"<3');
    expect(risky.html).toContain('&amp;b=&quot;2&quot;&lt;3');
  });
});

describe('contenido del mail de acceso sin código (link entregado por un admin)', () => {
  const mail = accessEmail('ana@mail.example', LINK);

  it('lleva el link y el botón pero ningún bloque de código', () => {
    expect(mail.subject).toBe(ACCESS_EMAIL_SUBJECT);
    expect(mail.text).toContain(LINK);
    expect(mail.html).toContain(`href="${LINK}"`);
    expect(mail.text).not.toContain('Tu código');
    expect(mail.text).not.toMatch(/\d{6}/);
    expect(mail.html).not.toContain('escribí este código');
  });

  it('avisa que vence en 72 horas y no en 15 minutos', () => {
    expect(mail.text).toContain('72 horas');
    expect(mail.html).toContain('72 horas');
    expect(mail.text).not.toContain('15 minutos');
    expect(mail.html).not.toContain('15 minutos');
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
    await mailer.send(accessEmail('ana@mail.example', LINK, '048213'));
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

    await mailer.send(accessEmail('ana@mail.example', LINK, '048213'));

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
    await expect(mailer.send(accessEmail('ana@mail.example', LINK, '048213'))).rejects.toThrow();
  });
});

describe('resultado de cada envío en el log', () => {
  const lines: { level: string; obj: Record<string, unknown>; msg: string }[] = [];
  const log = {
    info: (obj: object, msg: string) => void lines.push({ level: 'info', obj: obj as Record<string, unknown>, msg }),
    warn: (obj: object, msg: string) => void lines.push({ level: 'warn', obj: obj as Record<string, unknown>, msg }),
  };

  function mailerWith(sendMail: () => Promise<unknown>) {
    lines.length = 0;
    return new SmtpMailer({ sendMail } as never, 'Canchas3 <hola@canchas3.example>', log);
  }

  it('registra que el servidor aceptó el mail, con los aceptados, los rechazados y el código, sin direcciones', async () => {
    const mailer = mailerWith(async () => ({ accepted: ['ana@mail.example'], rejected: [], response: '250 2.0.0 Ok: queued' }));
    await mailer.send(accessEmail('ana@mail.example', LINK, '048213'));
    expect(lines).toEqual([
      { level: 'info', obj: { accepted: 1, rejected: 0, responseCode: '250' }, msg: 'Mail entregado al servidor SMTP' },
    ]);
    expect(JSON.stringify(lines)).not.toContain('ana@mail.example');
  });

  it('registra la cantidad de destinatarios rechazados, no la dirección', async () => {
    const mailer = mailerWith(async () => ({ accepted: [], rejected: ['ana@mail.example'], response: '250 Ok' }));
    await mailer.send(accessEmail('ana@mail.example', LINK, '048213'));
    expect(lines[0]!.obj).toMatchObject({ accepted: 0, rejected: 1 });
    expect(JSON.stringify(lines)).not.toContain('ana@mail.example');
  });

  it('si falla, registra el tipo de falla sin datos personales y propaga el error', async () => {
    const mailer = mailerWith(async () => {
      throw Object.assign(new Error('535 credenciales de ana@mail.example'), { code: 'EAUTH' });
    });
    await expect(mailer.send(accessEmail('ana@mail.example', LINK, '048213'))).rejects.toThrow();
    expect(lines).toEqual([
      { level: 'warn', obj: { errorName: 'Error', code: 'EAUTH' }, msg: 'El servidor SMTP no aceptó el mail' },
    ]);
    expect(JSON.stringify(lines)).not.toContain('ana@mail.example');
    expect(JSON.stringify(lines)).not.toContain(LINK);
  });
});

describe('medio de entrega al arrancar', () => {
  it('un SMTP real: dice servidor y puerto, sin credenciales y sin advertencia', () => {
    const d = describeMailDelivery('smtps://ana%40club.example:clave-secreta@mail.club.example:465');
    expect(d.info).toContain('mail.club.example:465');
    expect(d.warning).toBeUndefined();
    expect(JSON.stringify(d)).not.toContain('clave-secreta');
    expect(JSON.stringify(d)).not.toContain('ana');
  });

  it('usa el puerto por defecto cuando la dirección no lo trae', () => {
    expect(describeMailDelivery('smtp://mail.club.example').info).toContain('mail.club.example:25');
    expect(describeMailDelivery('smtps://mail.club.example').info).toContain('mail.club.example:465');
  });

  it('el buzón de pruebas (mailpit o puerto 1025) advierte que no llega a casillas reales', () => {
    for (const url of ['smtp://mailpit:1025', 'smtp://localhost:1025', 'smtp://mailpit:2525']) {
      const d = describeMailDelivery(url);
      expect(d.warning).toContain('NO llegan a ninguna casilla real');
      expect(d.warning).toContain('buzón de pruebas');
    }
  });

  it('sin SMTP_URL dice que los mails se imprimen en el log y advierte', () => {
    const d = describeMailDelivery(undefined);
    expect(d.info).toContain('se imprimen en este log');
    expect(d.warning).toContain('NO llegan a ninguna casilla real');
  });

  it('una dirección SMTP inválida no rompe ni muestra la dirección', () => {
    const d = describeMailDelivery('esto no es una url con clave-secreta');
    expect(d.info).not.toContain('clave-secreta');
  });
});

describe('registro de arranque', () => {
  async function startupLog(overrides: Record<string, string>) {
    const logs: string[] = [];
    const app = await buildApp({
      config: testConfig(overrides),
      db: createFakeDatabase(),
      mailer: new FakeMailer(),
      logStream: { write: (m) => void logs.push(m) },
    });
    await app.close();
    return logs.join('\n');
  }

  it('con un SMTP real registra el servidor y no advierte ni muestra credenciales', async () => {
    const text = await startupLog({ SMTP_URL: 'smtps://ana:clave-secreta@mail.club.example:465' });
    expect(text).toContain('mail.club.example:465');
    expect(text).not.toContain('ATENCIÓN');
    expect(text).not.toContain('clave-secreta');
  });

  it('con el buzón de pruebas registra una advertencia', async () => {
    expect(await startupLog({ SMTP_URL: 'smtp://mailpit:1025' })).toContain('ATENCIÓN');
  });

  it('sin SMTP registra la advertencia de consola', async () => {
    const text = await startupLog({});
    expect(text).toContain('se imprimen en este log');
    expect(text).toContain('ATENCIÓN');
  });
});
