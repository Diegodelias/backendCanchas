import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';

/**
 * Cuánto se espera a que ffmpeg termine por sí solo después de la señal de cierre ordenado. Pasado este plazo se lo
 * termina de forma forzada, para que ningún proceso quede colgado (por ejemplo uno bloqueado conectando con la cámara).
 */
export const STOP_GRACE_MS = 3000;

/** Lo mínimo que la API necesita de un proceso de ffmpeg; permite reemplazarlo en las pruebas. */
export interface FfmpegProcess {
  stdout: Readable;
  stderr: Readable;
  onClose(listener: (code: number | null) => void): void;
  onError(listener: (error: Error) => void): void;
  /**
   * Detiene el proceso: primero con una señal de cierre ordenado (que le permite cerrar la sesión con la cámara) y, si
   * sigue vivo pasado `STOP_GRACE_MS`, de forma forzada. Llamarlo más de una vez no envía señales de más.
   */
  kill(): void;
  /** Se resuelve cuando el proceso terminó (o no pudo arrancar). Nunca se rechaza. */
  readonly closed: Promise<void>;
}

export interface FfmpegLauncher {
  launch(args: string[]): FfmpegProcess;
}

export class SpawnLauncher implements FfmpegLauncher {
  constructor(
    private readonly ffmpegPath: string,
    private readonly graceMs: number = STOP_GRACE_MS,
  ) {}

  launch(args: string[]): FfmpegProcess {
    const child = spawn(this.ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stopRequested = false;
    let ended = false;
    let fallback: NodeJS.Timeout | null = null;

    const closed = new Promise<void>((resolve) => {
      const end = () => {
        ended = true;
        if (fallback) clearTimeout(fallback);
        resolve();
      };
      child.once('close', end);
      child.once('error', end); // si no pudo arrancar no hay `close`
    });

    return {
      stdout: child.stdout,
      stderr: child.stderr,
      onClose: (listener) => child.on('close', listener),
      onError: (listener) => child.on('error', listener),
      closed,
      kill: () => {
        if (stopRequested || ended) return;
        stopRequested = true;
        child.kill('SIGTERM');
        fallback = setTimeout(() => {
          if (!ended) child.kill('SIGKILL');
        }, this.graceMs);
      },
    };
  }
}
