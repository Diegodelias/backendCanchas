import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../../app.js';
import { getLiveCamera } from '../../config.js';
import { AppError, notFound } from '../../lib/errors.js';
import { SpawnLauncher, type FfmpegLauncher, type FfmpegProcess } from './launcher.js';
import { buildFfmpegArgs, buildRtspUrl, liveCameraLogInfo, sanitize } from './rtsp.js';
import { ViewerCounter } from './viewers.js';

const paramsSchema = z.object({ cameraId: z.string().min(1) });

const CONNECTION_FAILED = () =>
  new AppError(502, 'camera_unreachable', 'No pudimos conectar con la cámara. Probá de nuevo en un momento.');

/** Por qué terminó un pedido de stream en vivo (va en la línea de métricas). */
export type StreamOutcome =
  | 'client_closed'
  | 'client_closed_before_video'
  | 'stream_ended'
  | 'first_byte_timeout'
  | 'spawn_failed'
  | 'ffmpeg_failed_before_video'
  | 'too_many_viewers'
  | 'server_shutdown';

/** Cierres normales; el resto son fallas y se registran como `warn`. */
const NORMAL_OUTCOMES: ReadonlySet<StreamOutcome> = new Set(['client_closed', 'client_closed_before_video', 'server_shutdown']);

interface MetricsLog {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

/**
 * Medición de un pedido de stream: deja UNA línea «stream en vivo terminado» con el primer byte, la duración, los bytes
 * enviados, los Mbps promedio y los espectadores al empezar. Solo lleva el identificador de la cámara: nunca su
 * dirección ni sus credenciales. `finish` solo escribe la primera vez, aunque varias salidas lo llamen.
 */
function startStreamMetrics(log: MetricsLog, cameraId: string, viewersAtStart: number, now: () => number = Date.now) {
  const startedAt = now();
  let firstByteAt: number | null = null;
  let bytes = 0;
  let finished = false;
  return {
    firstByte() {
      if (firstByteAt === null) firstByteAt = now();
    },
    addBytes(count: number) {
      bytes += count;
    },
    finish(outcome: StreamOutcome) {
      if (finished) return;
      finished = true;
      const end = now();
      // Los Mbps se miden sobre el tramo con video: el tiempo de conexión no es velocidad.
      const videoMs = firstByteAt === null ? 0 : end - firstByteAt;
      const avgMbps = videoMs > 0 ? Math.round(((bytes * 8) / (videoMs / 1000) / 1e6) * 100) / 100 : null;
      const line = {
        cameraId,
        outcome,
        ttfbMs: firstByteAt === null ? null : firstByteAt - startedAt,
        durationMs: end - startedAt,
        bytes,
        avgMbps,
        viewersAtStart,
      };
      if (NORMAL_OUTCOMES.has(outcome)) log.info(line, 'stream en vivo terminado');
      else log.warn(line, 'stream en vivo terminado');
    },
  };
}

export async function liveRoutes(app: FastifyInstance, deps: AppDeps) {
  const { config } = deps;
  const camera = getLiveCamera(config);
  const launcher: FfmpegLauncher = deps.launcher ?? new SpawnLauncher(config.FFMPEG);
  const viewers = new ViewerCounter(config.LIVE_MAX_VIEWERS);
  // Cada ffmpeg activo con la medición de su pedido, para registrar el apagado del servidor como tal.
  const active = new Map<FfmpegProcess, ReturnType<typeof startStreamMetrics>>();

  if (camera) {
    // Solo identificador y canal: nunca la dirección ni las credenciales.
    app.log.info(liveCameraLogInfo(camera), 'cámara en vivo configurada');
  }

  // Al apagar el servidor no puede quedar ningún ffmpeg corriendo. Se usa `preClose` (y no `onClose`)
  // porque el cierre espera a que terminen las conexiones, y un flujo de video no termina solo.
  app.addHook('preClose', async () => {
    for (const [proc, metrics] of active) {
      metrics.finish('server_shutdown');
      proc.kill();
    }
    active.clear();
  });

  app.get('/live/:cameraId/stream', async (req, reply) => {
    const { cameraId } = paramsSchema.parse(req.params);

    if (!camera) {
      throw new AppError(503, 'camera_not_configured', 'La cámara en vivo no está configurada.');
    }
    // Cualquier otro identificador (o parámetro de canal/fecha) se ignora: solo existe la cámara registrada.
    if (cameraId !== camera.id) throw notFound('No encontramos esa cámara.');

    const release = viewers.acquire();
    if (!release) {
      startStreamMetrics(app.log, camera.id, viewers.count).finish('too_many_viewers');
      throw new AppError(
        503,
        'too_many_viewers',
        'Hay muchos espectadores viendo esta cámara. Probá de nuevo en unos minutos.',
      );
    }

    const metrics = startStreamMetrics(app.log, camera.id, viewers.count);

    return new Promise<void>((resolve, reject) => {
      let proc: FfmpegProcess;
      try {
        proc = launcher.launch(buildFfmpegArgs(buildRtspUrl(camera)));
      } catch (err) {
        release();
        app.log.warn({ cameraId: camera.id }, sanitize(String((err as Error).message), camera));
        metrics.finish('spawn_failed');
        reject(CONNECTION_FAILED());
        return;
      }

      active.set(proc, metrics);
      let started = false;
      let settled = false;
      let stderrText = '';

      const cleanup = () => {
        clearTimeout(firstByteTimer);
        active.delete(proc);
        release();
      };

      const failBeforeVideo = (outcome: 'first_byte_timeout' | 'ffmpeg_failed_before_video') => {
        if (settled) return;
        settled = true;
        cleanup();
        metrics.finish(outcome);
        proc.kill();
        if (stderrText) {
          // El detalle de ffmpeg solo se registra, ya sin credenciales; al cliente nunca se envía.
          app.log.warn({ cameraId: camera.id }, sanitize(stderrText.slice(0, 2000), camera));
        }
        reject(CONNECTION_FAILED());
      };

      const firstByteTimer = setTimeout(() => failBeforeVideo('first_byte_timeout'), config.LIVE_FIRST_BYTE_TIMEOUT_MS);

      proc.stderr.on('data', (chunk: Buffer) => {
        if (stderrText.length < 4000) stderrText += chunk.toString('utf8');
      });

      proc.onError(() => failBeforeVideo('ffmpeg_failed_before_video'));

      proc.onClose(() => {
        if (!started) {
          failBeforeVideo('ffmpeg_failed_before_video');
          return;
        }
        // Ya se había empezado: terminar la respuesta (el reproductor mostrará su estado de error).
        // Si fue el cliente el que se fue, su cierre ya quedó registrado y esto no escribe nada.
        metrics.finish('stream_ended');
        cleanup();
        if (!reply.raw.writableEnded) reply.raw.end();
      });

      // El cliente se fue (cerró la pestaña o cortó la conexión): detener ffmpeg.
      reply.raw.on('close', () => {
        // Si la respuesta ya terminó de enviarse, la cerró el `pipe` porque ffmpeg dejó de entregar video: es un corte del
        // lado de la cámara, no del cliente (este evento llega antes que el cierre del proceso). Si no, se fue el cliente,
        // y se registra antes de matar a ffmpeg para que su cierre no se cuente como un corte.
        if (started && reply.raw.writableFinished) metrics.finish('stream_ended');
        else metrics.finish(started ? 'client_closed' : 'client_closed_before_video');
        proc.kill();
        if (!started && !settled) {
          settled = true;
          cleanup();
          resolve();
        }
      });

      proc.stdout.on('data', (chunk: Buffer) => metrics.addBytes(chunk.length));

      proc.stdout.once('data', (first: Buffer) => {
        if (settled) return;
        started = true;
        settled = true;
        metrics.firstByte();
        clearTimeout(firstByteTimer);
        reply.hijack();
        reply.raw.writeHead(200, {
          'Content-Type': 'video/mp4',
          'Cache-Control': 'no-store',
          'X-Accel-Buffering': 'no',
          Connection: 'keep-alive',
        });
        reply.raw.write(first);
        proc.stdout.pipe(reply.raw);
        resolve();
      });
    });
  });
}
