import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MailMessage, Mailer } from '../src/modules/mail/mailer.js';
import { RETRY_DELAYS_MS, sendWithRetries } from '../src/modules/mail/retries.js';

const message: MailMessage = {
  to: 'secreto@mail.example',
  subject: 'Tu acceso a Canchas3',
  text: 'Tu código: 123456 http://x.example/acceso?token=SECRETO',
  html: '<p>x</p>',
};

/** Mailer que falla las primeras `failures` veces con un error que menciona el destinatario. */
function scripted(failures: number) {
  const calls: number[] = [];
  const mailer: Mailer = {
    async send() {
      calls.push(Date.now());
      if (calls.length <= failures) {
        throw Object.assign(new Error(`rechazado: ${message.to}`), { code: 'ECONNECTION' });
      }
    },
  };
  return { mailer, calls };
}

describe('sendWithRetries', () => {
  const errors: Array<{ obj: Record<string, unknown>; msg: string }> = [];
  const log = { error: (obj: object, msg: string) => void errors.push({ obj: obj as Record<string, unknown>, msg }) };

  beforeEach(() => {
    vi.useFakeTimers();
    errors.length = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('las esperas por defecto son 2 y 10 segundos', () => {
    expect(RETRY_DELAYS_MS).toEqual([2_000, 10_000]);
  });

  it('si el primer intento sale bien, no reintenta ni registra nada', async () => {
    const { mailer, calls } = scripted(0);
    sendWithRetries(mailer, message, log, 'falló');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  it('devuelve de inmediato aunque el envío tarde o falle', () => {
    const mailer: Mailer = { send: () => new Promise(() => {}) };
    expect(sendWithRetries(mailer, message, log, 'falló')).toBeUndefined();
  });

  it('una falla pasajera se entrega en el segundo intento, 2 s después, sin error', async () => {
    const { mailer, calls } = scripted(1);
    sendWithRetries(mailer, message, log, 'falló');
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(2);
    expect(errors).toEqual([]);
  });

  it('dos fallas seguidas se entregan en el tercer intento, 10 s después del segundo', async () => {
    const { mailer, calls } = scripted(2);
    sendWithRetries(mailer, message, log, 'falló');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(3);
    expect(errors).toEqual([]);
  });

  it('una falla definitiva registra un solo error, con el tipo y los 3 intentos, sin datos personales', async () => {
    const { mailer, calls } = scripted(99);
    sendWithRetries(mailer, message, log, 'No se pudo enviar el mail de acceso');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(3);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.msg).toBe('No se pudo enviar el mail de acceso');
    expect(errors[0]!.obj).toEqual({ errorName: 'Error', code: 'ECONNECTION', attempts: 3 });
    const all = JSON.stringify(errors);
    expect(all).not.toContain('secreto@mail.example');
    expect(all).not.toContain('SECRETO');
    expect(all).not.toContain('123456');
  });
});
