import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseRange } from '../src/modules/recordings/videos.js';
import { createTestEnv, type TestEnv } from './helpers.js';

const SIZE = 1000;
const CONTENT = Buffer.from(Array.from({ length: SIZE }, (_, i) => i % 251));

describe('videos de las grabaciones', () => {
  let env: TestEnv;
  let base: string;
  let videos: string;

  beforeAll(async () => {
    base = mkdtempSync(path.join(tmpdir(), 'canchas3-videos-'));
    videos = path.join(base, 'videos');
    mkdirSync(videos);
    writeFileSync(path.join(videos, 'demo-partido.mp4'), CONTENT);
    writeFileSync(path.join(base, 'secreto.mp4'), 'no se tiene que poder leer');
    writeFileSync(path.join(videos, 'video.avi'), 'otra extensión');
    env = await createTestEnv({ VIDEOS_DIR: videos });
  });
  afterAll(async () => {
    await env?.close();
    rmSync(base, { recursive: true, force: true });
  });

  const get = (file: string, range?: string) =>
    env.app.inject({ method: 'GET', url: `/api/videos/${file}`, ...(range ? { headers: { range } } : {}) });

  it('sirve el archivo entero con su tipo, su tamaño y la indicación de que acepta rangos', async () => {
    const res = await get('demo-partido.mp4');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('video/mp4');
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.headers['content-length']).toBe(String(SIZE));
    expect(res.rawPayload.equals(CONTENT)).toBe(true);
  });

  it('responde solo el tramo pedido con 206 y su Content-Range', async () => {
    const res = await get('demo-partido.mp4', 'bytes=100-199');
    expect(res.statusCode).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes 100-199/${SIZE}`);
    expect(res.headers['content-length']).toBe('100');
    expect(res.rawPayload.equals(CONTENT.subarray(100, 200))).toBe(true);
  });

  it('acepta un rango abierto, uno de los últimos bytes y uno que se pasa del final', async () => {
    const open = await get('demo-partido.mp4', 'bytes=900-');
    expect(open.statusCode).toBe(206);
    expect(open.headers['content-range']).toBe(`bytes 900-999/${SIZE}`);

    const suffix = await get('demo-partido.mp4', 'bytes=-50');
    expect(suffix.statusCode).toBe(206);
    expect(suffix.rawPayload.equals(CONTENT.subarray(950))).toBe(true);

    const past = await get('demo-partido.mp4', 'bytes=990-5000');
    expect(past.statusCode).toBe(206);
    expect(past.headers['content-range']).toBe(`bytes 990-999/${SIZE}`);
  });

  it('un rango fuera del tamaño del archivo es 416 con el tamaño real', async () => {
    for (const range of [`bytes=${SIZE}-`, 'bytes=5000-6000', 'bytes=-0', 'bytes=300-100']) {
      const res = await get('demo-partido.mp4', range);
      expect(res.statusCode, range).toBe(416);
      expect(res.headers['content-range']).toBe(`bytes */${SIZE}`);
    }
  });

  it('un encabezado de rango que no se entiende, o con varios tramos, devuelve el archivo entero', async () => {
    for (const range of ['bytes=a-b', 'items=0-10', 'bytes=0-10,20-30', 'bytes=-']) {
      const res = await get('demo-partido.mp4', range);
      expect(res.statusCode, range).toBe(200);
      expect(res.rawPayload.length).toBe(SIZE);
    }
  });

  it('no encuentra nombres con rutas, otra extensión, ocultos ni archivos inexistentes, y no lee fuera de la carpeta', async () => {
    const names = [
      '..%2Fsecreto.mp4',
      '%2e%2e%2fsecreto.mp4',
      '..%5Csecreto.mp4',
      'a%2Fb.mp4',
      '.oculto.mp4',
      'video.avi',
      'no-existe.mp4',
      'con%20espacio.mp4',
    ];
    for (const name of names) {
      const res = await get(name);
      expect(res.statusCode, name).toBe(404);
      expect(res.body).not.toContain('no se tiene que poder leer');
    }
  });

  it('rechaza un nombre larguísimo (Fastify lo corta antes de llegar a la ruta)', async () => {
    const res = await get(`${'x'.repeat(200)}.mp4`);
    expect([404, 414]).toContain(res.statusCode);
  });

  it('no sirve una carpeta aunque su nombre parezca un video', async () => {
    mkdirSync(path.join(videos, 'carpeta.mp4'));
    expect((await get('carpeta.mp4')).statusCode).toBe(404);
  });
});

describe('parseRange', () => {
  it('interpreta los formatos de un solo tramo', () => {
    expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-500', 100)).toEqual({ start: 0, end: 99 });
    expect(parseRange('bytes=10-5000', 100)).toEqual({ start: 10, end: 99 });
  });

  it('distingue lo que no se entiende de lo que no se puede satisfacer', () => {
    expect(parseRange(undefined, 100)).toBeNull();
    expect(parseRange('bytes=0-1,5-6', 100)).toBeNull();
    expect(parseRange('bytes=100-', 100)).toBe('unsatisfiable');
    expect(parseRange('bytes=50-10', 100)).toBe('unsatisfiable');
  });
});
