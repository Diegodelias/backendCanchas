import type { MailMessage, Mailer } from './mailer.js';

/** Esperas entre intentos: hasta 3 intentos en total (el primero sin espera). */
export const RETRY_DELAYS_MS = [2_000, 10_000] as const;

export interface RetryLogger {
  error(obj: object, msg: string): void;
}

/**
 * Envía en segundo plano y reintenta si el servidor de mail falla (hasta 3 intentos, esperando 2 y 10 s).
 * Devuelve enseguida: quien lo llama no espera ni se entera del resultado. Si se agotan los intentos registra un
 * solo error con el tipo de falla y los intentos, sin destinatario, link ni código. No hay cola: si el proceso
 * se reinicia entre intentos, el jugador usa «Reenviar».
 */
export function sendWithRetries(
  mailer: Mailer,
  message: MailMessage,
  log: RetryLogger,
  errorMessage: string,
  delaysMs: readonly number[] = RETRY_DELAYS_MS,
): void {
  const attempt = async (n: number): Promise<void> => {
    try {
      await mailer.send(message);
    } catch (err) {
      const delay = delaysMs[n - 1];
      if (delay === undefined) {
        const code = (err as { code?: string }).code;
        log.error({ errorName: (err as Error).name, code, attempts: n }, errorMessage);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
      return attempt(n + 1);
    }
  };
  void attempt(1);
}
