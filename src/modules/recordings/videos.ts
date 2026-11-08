import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../../app.js';
import { notFound } from '../../lib/errors.js';

/** Mismo formato que el check de `recordings.video_file`: un nombre simple de mp4, sin rutas. */
export const VIDEO_FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\.mp4$/;
const MAX_FILE_NAME = 120;

const fileParam = z.object({ file: z.string().max(MAX_FILE_NAME) });

export type ByteRange = { start: number; end: number } | 'unsatisfiable' | null;

/**
 * Interpreta un encabezado `Range` de un solo tramo (`bytes=a-b`, `bytes=a-` o `bytes=-n`) sobre un archivo de `size` bytes.
 * Devuelve null si no hay rango (o no se entiende, o pide varios tramos: se responde el archivo entero) y
 * 'unsatisfiable' si el tramo cae fuera del archivo.
 */
export function parseRange(header: string | undefined, size: number): ByteRange {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return null;

  let start: number;
  let end: number;
  if (rawStart === '') {
    // Los últimos n bytes.
    const suffix = Number(rawEnd);
    if (suffix === 0) return 'unsatisfiable';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  }
  if (start >= size || start > end) return 'unsatisfiable';
  return { start, end };
}

/** Ruta pública de los videos de las grabaciones (`GET /api/videos/:file`), servidos desde `VIDEOS_DIR`. */
export async function videosRoutes(app: FastifyInstance, deps: AppDeps) {
  const root = path.resolve(deps.config.VIDEOS_DIR);

  // Sin sesión: las grabaciones son públicas. Acepta pedidos por rango para poder avanzar y retroceder en el video.
  app.get('/videos/:file', async (req, reply) => {
    const { file } = fileParam.parse(req.params);
    if (!VIDEO_FILE_PATTERN.test(file)) throw notFound('No encontramos ese video.');

    // Nunca se lee fuera de la carpeta configurada.
    const fullPath = path.resolve(root, file);
    if (path.dirname(fullPath) !== root) throw notFound('No encontramos ese video.');

    const info = await stat(fullPath).catch(() => null);
    if (!info?.isFile()) throw notFound('No encontramos ese video.');

    const size = info.size;
    const range = parseRange(req.headers.range, size);

    if (range === 'unsatisfiable') {
      return reply
        .status(416)
        .header('Content-Range', `bytes */${size}`)
        .send({ error: { code: 'range_not_satisfiable', message: 'El tramo pedido no existe en el video.' } });
    }
    reply.header('Accept-Ranges', 'bytes').header('Content-Type', 'video/mp4').header('Cache-Control', 'public, max-age=3600');
    if (range) {
      return reply
        .status(206)
        .header('Content-Range', `bytes ${range.start}-${range.end}/${size}`)
        .header('Content-Length', range.end - range.start + 1)
        .send(createReadStream(fullPath, { start: range.start, end: range.end }));
    }
    return reply.status(200).header('Content-Length', size).send(createReadStream(fullPath));
  });
}
