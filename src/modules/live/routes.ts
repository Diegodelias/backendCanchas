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

export async function liveRoutes(app: FastifyInstance, deps: AppDeps) {
  const { config } = deps;
  const camera = getLiveCamera(config);
  const launcher: FfmpegLauncher = deps.launcher ?? new SpawnLauncher(config.FFMPEG);
  const viewers = new ViewerCounter(config.LIVE_MAX_VIEWERS);
  const active = new Set<FfmpegProcess>();

  if (camera) {
    // Solo identificador y canal: nunca la dirección ni las credenciales.
    app.log.info(liveCameraLogInfo(camera), 'cámara en vivo configurada');
  }

  // Al apagar el servidor no puede quedar ningún ffmpeg corriendo. Se usa `preClose` (y no `onClose`)
  // porque el cierre espera a que terminen las conexiones, y un flujo de video no termina solo.
  app.addHook('preClose', async () => {
    for (const proc of active) proc.kill();
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
      throw new AppError(
        503,
        'too_many_viewers',
        'Hay muchos espectadores viendo esta cámara. Probá de nuevo en unos minutos.',
      );
    }

    return new Promise<void>((resolve, reject) => {
      let proc: FfmpegProcess;
      try {
        proc = launcher.launch(buildFfmpegArgs(buildRtspUrl(camera)));
      } catch (err) {
        release();
        app.log.warn({ cameraId: camera.id }, sanitize(String((err as Error).message), camera));
        reject(CONNECTION_FAILED());
        return;
      }

      active.add(proc);
      let started = false;
      let settled = false;
      let stderrText = '';

      const cleanup = () => {
        clearTimeout(firstByteTimer);
        active.delete(proc);
        release();
      };

      const failBeforeVideo = () => {
        if (settled) return;
        settled = true;
        cleanup();
        proc.kill();
        if (stderrText) {
          // El detalle de ffmpeg solo se registra, ya sin credenciales; al cliente nunca se envía.
          app.log.warn({ cameraId: camera.id }, sanitize(stderrText.slice(0, 2000), camera));
        }
        reject(CONNECTION_FAILED());
      };

      const firstByteTimer = setTimeout(failBeforeVideo, config.LIVE_FIRST_BYTE_TIMEOUT_MS);

      proc.stderr.on('data', (chunk: Buffer) => {
        if (stderrText.length < 4000) stderrText += chunk.toString('utf8');
      });

      proc.onError(() => failBeforeVideo());

      proc.onClose(() => {
        if (!started) {
          failBeforeVideo();
          return;
        }
        // Ya se había empezado: terminar la respuesta (el reproductor mostrará su estado de error).
        cleanup();
        if (!reply.raw.writableEnded) reply.raw.end();
      });

      // El cliente se fue (cerró la pestaña o cortó la conexión): detener ffmpeg.
      reply.raw.on('close', () => {
        proc.kill();
        if (!started && !settled) {
          settled = true;
          cleanup();
          resolve();
        }
      });

      proc.stdout.once('data', (first: Buffer) => {
        if (settled) return;
        started = true;
        settled = true;
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
