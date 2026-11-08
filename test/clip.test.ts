import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../src/lib/errors.js';
import { buildClipArgs, ClipAbortedError, createClipCutter, EMPTY_OUTPUT_MESSAGE } from '../src/modules/plays/clip.js';
import { FakeLauncher, type FakeProcess, sleep } from './helpers.js';

describe('buildClipArgs', () => {
  it('arma los argumentos exactos: inicio antes de -i, duración, 720 como máximo, H.264 + AAC y faststart', () => {
    expect(buildClipArgs({ inputPath: '/data/videos/demo-partido.mp4', start: 4, end: 24, outputPath: '/tmp/out.mp4' })).toEqual([
      '-hide_banner',
      '-loglevel',
      'warning',
      '-ss',
      '4',
      '-i',
      '/data/videos/demo-partido.mp4',
      '-t',
      '20',
      '-map',
      '0:v:0',
      '-map',
      '0:a:0?',
      '-vf',
      "scale=-2:'min(720,trunc(ih/2)*2)'",
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
      '/tmp/out.mp4',
    ]);
  });

  it('el inicio va antes de la entrada (corte exacto recodificando) y la duración es fin menos inicio', () => {
    const args = buildClipArgs({ inputPath: 'a.mp4', start: 0, end: 120, outputPath: 'o.mp4' });
    expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'));
    expect(args[args.indexOf('-t') + 1]).toBe('120');
    expect(args).not.toContain('copy');
  });
});

describe('createClipCutter', () => {
  let dir: string;
  let seq = 0;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'canchas3-clip-test-'));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const request = () => ({
    inputPath: path.join(dir, 'entrada.mp4'),
    start: 4,
    end: 24,
    outputPath: path.join(dir, `salida-${++seq}.mp4`),
  });
  const outputOf = (args: string[]) => args[args.length - 1]!;
  const cutter = (launcher: FakeLauncher, opts: { maxConcurrent?: number; timeoutMs?: number } = {}) =>
    createClipCutter({ launcher, maxConcurrent: opts.maxConcurrent ?? 2, timeoutMs: opts.timeoutMs ?? 1000 });

  /** Hace que el proceso falso escriba el temporal y termine con ese código. */
  const completes = (launcher: FakeLauncher, code = 0, content = 'mp4 falso') => {
    launcher.onLaunch = (proc, args) => {
      writeFileSync(outputOf(args), content);
      proc.finish(code);
    };
  };

  it('corta: lanza ffmpeg con los argumentos del pedido y deja el archivo', async () => {
    const launcher = new FakeLauncher();
    completes(launcher);
    const c = cutter(launcher);
    const req = request();
    await c.cut(req);
    expect(launcher.launched).toHaveLength(1);
    expect(launcher.launched[0]!.args).toContain(req.inputPath);
    expect(launcher.launched[0]!.args[launcher.launched[0]!.args.indexOf('-ss') + 1]).toBe('4');
    expect(existsSync(req.outputPath)).toBe(true);
    expect(c.active).toBe(0);
  });

  it('rechaza el corte que pasa el máximo, sin lanzar nada, y vuelve a aceptar cuando uno termina', async () => {
    const launcher = new FakeLauncher();
    const running: FakeProcess[] = [];
    launcher.onLaunch = (proc) => void running.push(proc);
    const c = cutter(launcher, { maxConcurrent: 2, timeoutMs: 5000 });

    const first = request();
    const second = request();
    const p1 = c.cut(first);
    const p2 = c.cut(second);
    expect(c.active).toBe(2);

    await expect(c.cut(request())).rejects.toMatchObject({ status: 503, code: 'clip_busy' });
    expect(launcher.launched).toHaveLength(2); // el tercero no lanzó ffmpeg

    writeFileSync(first.outputPath, 'x');
    running[0]!.finish(0);
    await p1;
    expect(c.active).toBe(1);

    const third = request();
    launcher.onLaunch = (proc, args) => {
      writeFileSync(outputOf(args), 'x');
      proc.finish(0);
    };
    await c.cut(third); // ahora sí hay lugar
    expect(launcher.launched).toHaveLength(3);

    writeFileSync(second.outputPath, 'x');
    running[1]!.finish(0);
    await p2;
    expect(c.active).toBe(0);
  });

  it('detiene el corte que pasa del tiempo máximo, responde clip_timeout y borra el temporal', async () => {
    const launcher = new FakeLauncher();
    launcher.onLaunch = (_proc, args) => writeFileSync(outputOf(args), 'a medias');
    const c = cutter(launcher, { timeoutMs: 40 });
    const req = request();
    const error = await c.cut(req).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ status: 504, code: 'clip_timeout' });
    expect(launcher.launched[0]!.proc.killed).toBe(true);
    await sleep(20);
    expect(existsSync(req.outputPath)).toBe(false);
    expect(c.active).toBe(0);
  });

  it('si el proceso termina con error responde clip_failed y borra el temporal', async () => {
    const launcher = new FakeLauncher();
    completes(launcher, 1, 'basura');
    const c = cutter(launcher);
    const req = request();
    await expect(c.cut(req)).rejects.toMatchObject({ status: 502, code: 'clip_failed' });
    expect(existsSync(req.outputPath)).toBe(false);
    expect(c.active).toBe(0);
  });

  it('si el proceso termina bien pero no deja archivo, o lo deja vacío, responde clip_failed', async () => {
    const launcher = new FakeLauncher();
    launcher.onLaunch = (proc) => proc.finish(0); // sin escribir nada
    const c = cutter(launcher);
    await expect(c.cut(request())).rejects.toMatchObject({ code: 'clip_failed' });

    completes(launcher, 0, '');
    const empty = request();
    await expect(c.cut(empty)).rejects.toMatchObject({ code: 'clip_failed' });
    expect(existsSync(empty.outputPath)).toBe(false);
  });

  it('si ffmpeg avisa que el fragmento quedó vacío (empieza después del final del video), responde clip_failed aunque salga con código 0', async () => {
    const launcher = new FakeLauncher();
    launcher.onLaunch = (proc, args) => {
      writeFileSync(outputOf(args), 'solo la cabecera del mp4');
      proc.emitStderr(`[out#0/mp4 @ 0000] ${EMPTY_OUTPUT_MESSAGE}, nothing was encoded(check -ss / -t / -frames parameters if used)
`);
      proc.finish(0);
    };
    const c = cutter(launcher);
    const req = request();
    await expect(c.cut(req)).rejects.toMatchObject({ status: 502, code: 'clip_failed' });
    expect(existsSync(req.outputPath)).toBe(false);
    expect(c.active).toBe(0);
  });

  it('si no se puede lanzar ffmpeg responde clip_failed y libera el lugar', async () => {
    const launcher = new FakeLauncher();
    launcher.throwOnLaunch = new Error('spawn ffmpeg ENOENT');
    const c = cutter(launcher);
    await expect(c.cut(request())).rejects.toMatchObject({ status: 502, code: 'clip_failed' });
    expect(c.active).toBe(0);
  });

  it('un corte cancelado detiene el proceso y borra el temporal', async () => {
    const launcher = new FakeLauncher();
    launcher.onLaunch = (_proc, args) => writeFileSync(outputOf(args), 'a medias');
    const c = cutter(launcher, { timeoutMs: 5000 });
    const req = request();
    const controller = new AbortController();
    const pending = c.cut(req, controller.signal);
    await sleep(10);
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(ClipAbortedError);
    expect(launcher.launched[0]!.proc.killed).toBe(true);
    await sleep(20);
    expect(existsSync(req.outputPath)).toBe(false);
    expect(c.active).toBe(0);
  });

  it('una señal ya cancelada no lanza nada', async () => {
    const launcher = new FakeLauncher();
    const c = cutter(launcher);
    const controller = new AbortController();
    controller.abort();
    await expect(c.cut(request(), controller.signal)).rejects.toBeInstanceOf(ClipAbortedError);
    expect(launcher.launched).toHaveLength(0);
    expect(c.active).toBe(0);
  });
});
