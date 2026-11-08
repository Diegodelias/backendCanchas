import { rm, stat } from 'node:fs/promises';
import { AppError } from '../../lib/errors.js';
import type { FfmpegLauncher } from '../live/launcher.js';

/**
 * Corta el fragmento de una jugada del video de su grabación con ffmpeg y lo deja en un archivo temporal.
 * El corte usa CPU del servidor, así que está acotado: pocos cortes a la vez, tiempo máximo y borrado del temporal
 * en todos los casos de falla (el que recibe el archivo es dueño de borrarlo cuando termina de enviarlo).
 */

/** Alto máximo del fragmento, en píxeles. */
export const MAX_CLIP_HEIGHT = 720;

export interface ClipRequest {
  /** Video de la grabación (ya resuelto dentro de VIDEOS_DIR). */
  inputPath: string;
  /** Inicio del fragmento en segundos del video. */
  start: number;
  /** Fin del fragmento en segundos del video. */
  end: number;
  /** Archivo temporal donde se escribe el mp4. */
  outputPath: string;
}

/**
 * Argumentos de ffmpeg. El inicio va antes de `-i` y se recodifica (no `-c copy`): así el corte arranca en el cuadro exacto.
 * Sale con H.264 y AAC, hasta 720 de alto (con alto y ancho pares, como pide el formato), y con `+faststart` para que
 * se pueda reproducir desde el celular apenas se descarga. Solo se mapean el primer video y el primer audio, si hay.
 */
export function buildClipArgs({ inputPath, start, end, outputPath }: ClipRequest): string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'warning',
    '-ss',
    String(start),
    '-i',
    inputPath,
    '-t',
    String(end - start),
    '-map',
    '0:v:0',
    '-map',
    '0:a:0?',
    '-vf',
    `scale=-2:'min(${MAX_CLIP_HEIGHT},trunc(ih/2)*2)'`,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '23',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-movflags',
    '+faststart',
    '-y',
    outputPath,
  ];
}

/**
 * Lo que dice ffmpeg cuando el fragmento empieza después del final del video: sale con código 0 y deja un mp4 de unos
 * pocos cientos de bytes sin ningún cuadro. Se trata como un corte fallido en vez de entregar ese archivo.
 */
export const EMPTY_OUTPUT_MESSAGE = 'Output file is empty';

/** Ya hay el máximo de cortes en marcha: no se lanza otro ni se encola. */
export const clipBusy = () =>
  new AppError(503, 'clip_busy', 'Estamos preparando otros fragmentos. Probá de nuevo en unos segundos.');
/** El corte superó el tiempo máximo y se detuvo. */
export const clipTimeout = () =>
  new AppError(504, 'clip_timeout', 'No pudimos preparar el fragmento a tiempo. Probá con uno más corto.');
/** El proceso de corte terminó con error o sin dejar un archivo. */
export const clipFailed = () =>
  new AppError(502, 'clip_failed', 'No pudimos preparar el fragmento. Probá de nuevo en un momento.');

/** El jugador cortó la descarga antes de que terminara el corte. */
export class ClipAbortedError extends Error {
  constructor() {
    super('Se canceló el corte del fragmento.');
    this.name = 'ClipAbortedError';
  }
}

export interface ClipCutterOptions {
  launcher: FfmpegLauncher;
  /** Cortes que pueden estar en marcha a la vez. */
  maxConcurrent: number;
  /** Tiempo máximo de trabajo de cada corte, en milisegundos. */
  timeoutMs: number;
  /** Registro de problemas del proceso (nunca lleva rutas ni datos del jugador). */
  log?: (message: string, detail?: object) => void;
}

export interface ClipCutter {
  /** Cortes en marcha ahora. */
  readonly active: number;
  /**
   * Corta el fragmento y escribe `outputPath`. Rechaza con `clip_busy` (sin lanzar nada) si ya hay el máximo en marcha,
   * `clip_timeout` si pasa del tiempo, `clip_failed` si el proceso falla o no deja archivo, o `ClipAbortedError` si
   * `signal` se cancela. Si rechaza, el temporal ya está borrado.
   */
  cut(request: ClipRequest, signal?: AbortSignal): Promise<void>;
}

const removeQuietly = (file: string) => rm(file, { force: true }).catch(() => {});

export function createClipCutter({ launcher, maxConcurrent, timeoutMs, log = () => {} }: ClipCutterOptions): ClipCutter {
  let active = 0;

  async function cut(request: ClipRequest, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new ClipAbortedError();
    if (active >= maxConcurrent) throw clipBusy();

    active += 1;
    try {
      let proc: ReturnType<FfmpegLauncher['launch']>;
      try {
        proc = launcher.launch(buildClipArgs(request));
      } catch (err) {
        log('No se pudo lanzar ffmpeg para el fragmento', { errorName: (err as Error).name });
        throw clipFailed();
      }
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        let stderrTail = '';
        let emptyOutput = false;
        const settle = (error?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          if (error) reject(error);
          else resolve();
        };
        const stop = (error: Error) => {
          proc.kill();
          settle(error);
        };
        const onAbort = () => stop(new ClipAbortedError());
        const timer = setTimeout(() => stop(clipTimeout()), timeoutMs);
        signal?.addEventListener('abort', onAbort, { once: true });

        proc.stderr.on('data', (chunk: Buffer) => {
          const text = stderrTail + chunk.toString();
          if (text.includes(EMPTY_OUTPUT_MESSAGE)) emptyOutput = true;
          stderrTail = text.slice(-500);
        });
        proc.onError((err) => {
          log('No se pudo lanzar ffmpeg para el fragmento', { errorName: err.name });
          settle(clipFailed());
        });
        proc.onClose((code) => {
          if (settled) {
            // Ya se había detenido (tiempo o cancelación): ffmpeg pudo escribir algo antes de morir.
            void removeQuietly(request.outputPath);
            return;
          }
          if (code !== 0 || emptyOutput) {
            log('ffmpeg no pudo cortar el fragmento', { code, emptyOutput, stderr: stderrTail.trim() });
            return settle(clipFailed());
          }
          settle();
        });
      });

      // El proceso terminó bien: tiene que haber dejado un archivo con contenido.
      const info = await stat(request.outputPath).catch(() => null);
      if (!info?.isFile() || info.size === 0) {
        log('ffmpeg no dejó un fragmento con contenido', {});
        throw clipFailed();
      }
    } catch (err) {
      await removeQuietly(request.outputPath);
      throw err;
    } finally {
      active -= 1;
    }
  }

  return {
    get active() {
      return active;
    },
    cut,
  };
}
