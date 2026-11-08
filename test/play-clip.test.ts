import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SpawnLauncher } from '../src/modules/live/launcher.js';
import { clipFileName } from '../src/modules/plays/routes.js';
import { SESSION_COOKIE } from '../src/modules/auth/sessions.js';
import { bookingTestKit } from './booking-helpers.js';
import { createDbTestEnv, FakeLauncher, listen, sleep, waitFor, type DbTestEnv } from './helpers.js';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\//, ''));
const FAKE_MP4 = Buffer.from('un mp4 que cortó ffmpeg');
const leftovers = () => readdirSync(tmpdir()).filter((f) => f.startsWith('canchas3-clip-'));
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;

/** Entorno con la base real, una carpeta de videos de prueba y un club con una grabación. */
async function setup(overrides: Record<string, string> = {}, extra: { launcher?: SpawnLauncher } = {}) {
  const base = mkdtempSync(path.join(tmpdir(), 'canchas3-playclip-'));
  const videos = path.join(base, 'videos');
  mkdirSync(videos);
  writeFileSync(path.join(videos, 'demo-partido.mp4'), 'video de demostración');
  const env = await createDbTestEnv({ VIDEOS_DIR: videos, ...overrides }, undefined, extra);
  const kit = bookingTestKit(env);
  return { env, kit, videos, base };
}

type Setup = Awaited<ReturnType<typeof setup>>;

describe('descarga del fragmento de una jugada', () => {
  let ctx: Setup;
  let env: DbTestEnv;
  let kit: Setup['kit'];
  let court: string;
  let before: string[];

  beforeAll(async () => {
    ctx = await setup();
    env = ctx.env;
    kit = ctx.kit;
  });
  afterAll(async () => {
    await env?.close();
    rmSync(ctx.base, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await env.reset();
    const club = await kit.createClub('test-playclip');
    court = await kit.createCourt(club, 'Cancha 1');
    before = leftovers();
  });

  const launcher = () => env.launcher as FakeLauncher;
  const outputOf = (args: string[]) => args[args.length - 1]!;
  /** El ffmpeg falso escribe el temporal y termina bien. */
  const cutsFine = () => {
    launcher().launched.length = 0;
    launcher().onLaunch = (proc, args) => {
      writeFileSync(outputOf(args), FAKE_MP4);
      proc.finish(0);
    };
  };
  const recording = (id: string, status = 'available', file: string | null = 'demo-partido.mp4') =>
    env.db.query(
      `INSERT INTO recordings (id, court_id, starts_at, status, video_file, duration_seconds) VALUES ($1, $2, '2026-03-01T17:30:00-03:00', $3, $4, 60)`,
      [id, court, status, status === 'available' ? file : null],
    );
  const savePlay = async (cookie: string, matchId: string, extra: object = {}) => {
    const res = await kit.call('POST', '/api/plays', cookie, { matchId, title: 'Gol de chilena', timestamp: 19, ...extra });
    expect(res.statusCode).toBe(201);
    return kit.body(res).play.id as string;
  };
  const clip = (id: string, cookie?: string, query = '') => kit.call('GET', `/api/plays/${id}/clip${query}`, cookie);
  const noTempLeft = () => expect(leftovers().filter((f) => !before.includes(f))).toEqual([]);

  describe('con el corte funcionando', () => {
    beforeEach(cutsFine);

    it('el dueño descarga el mp4 del fragmento, con un nombre que lleva el título, y no queda ningún temporal', async () => {
      await recording('test-clip-rec');
      const ana = await kit.loginPlayer();
      const id = await savePlay(ana, 'test-clip-rec', { clipStart: 10, clipEnd: 40, timestamp: 30 });

      const res = await clip(id, ana);
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('video/mp4');
      expect(res.headers['content-disposition']).toBe('attachment; filename="jugada-gol-de-chilena.mp4"');
      expect(res.headers['content-length']).toBe(String(FAKE_MP4.length));
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.rawPayload.equals(FAKE_MP4)).toBe(true);

      expect(launcher().launched).toHaveLength(1);
      const args = launcher().launched[0]!.args;
      expect(args[args.indexOf('-ss') + 1]).toBe('10');
      expect(args[args.indexOf('-t') + 1]).toBe('30');
      expect(args[args.indexOf('-i') + 1]).toBe(path.join(ctx.videos, 'demo-partido.mp4'));
      await waitFor(() => leftovers().filter((f) => !before.includes(f)).length === 0);
      noTempLeft();
    });

    it('usa el fragmento por defecto de una jugada sin ajustes', async () => {
      await recording('test-clip-rec');
      const ana = await kit.loginPlayer();
      const id = await savePlay(ana, 'test-clip-rec'); // marca en 19: de 4 a 24
      await clip(id, ana);
      const args = launcher().launched[0]!.args;
      expect([args[args.indexOf('-ss') + 1], args[args.indexOf('-t') + 1]]).toEqual(['4', '20']);
    });

    it('ignora cualquier archivo o dirección que venga en el pedido: corta solo el video de la grabación', async () => {
      await recording('test-clip-rec');
      const ana = await kit.loginPlayer();
      const id = await savePlay(ana, 'test-clip-rec');
      const res = await clip(id, ana, '?file=../../etc/passwd&url=http://127.0.0.1/secreto.mp4&input=/etc/hosts&videoFile=otro.mp4');
      expect(res.statusCode).toBe(200);
      expect(launcher().launched).toHaveLength(1);
      const args = launcher().launched[0]!.args;
      expect(args[args.indexOf('-i') + 1]).toBe(path.join(ctx.videos, 'demo-partido.mp4'));
      expect(args.join(' ')).not.toMatch(/passwd|secreto|hosts|otro\.mp4/);
    });

    it('sin sesión es 401, un admin es 403 y la jugada de otro o inexistente es 404, sin cortar nada', async () => {
      await recording('test-clip-rec');
      const ana = await kit.loginPlayer('ana@mail.example');
      const bruno = await kit.loginPlayer('bruno@mail.example');
      const admin = await kit.loginAdmin('test-playclip');
      const id = await savePlay(ana, 'test-clip-rec');

      expect((await clip(id)).statusCode).toBe(401);
      expect((await clip(id, admin)).statusCode).toBe(403);
      expect((await clip(id, bruno)).statusCode).toBe(404);
      expect((await clip('11111111-1111-1111-1111-111111111111', ana)).statusCode).toBe(404);
      expect((await clip('no-es-un-uuid', ana)).statusCode).toBe(404);
      expect(launcher().launched).toHaveLength(0);
    });

    it('una jugada en vivo no se descarga: no hay grabación', async () => {
      const ana = await kit.loginPlayer();
      const id = await savePlay(ana, 'estacion-norte-c1', { isLiveMoment: true });
      const res = await clip(id, ana);
      expect(res.statusCode).toBe(404);
      expect(kit.body(res).error.message).toMatch(/en vivo no se pueden descargar/);
      expect(launcher().launched).toHaveLength(0);
    });

    it.each([
      ['la grabación ya no existe', async () => 'match-que-no-existe'],
      ['la grabación está en proceso', async () => (await recording('test-clip-proc', 'processing'), 'test-clip-proc')],
      ['el club se desactivó', async () => (await recording('test-clip-off'), await env.db.query(`UPDATE clubs SET active = false WHERE id = 'test-playclip'`), 'test-clip-off')],
      ['el archivo ya no está en la carpeta de videos', async () => (await recording('test-clip-gone', 'available', 'borrado.mp4'), 'test-clip-gone')],
    ])('cuando %s responde que la grabación no está disponible, sin cortar', async (_name, prepare) => {
      const ana = await kit.loginPlayer();
      const matchId = await prepare();
      const id = await savePlay(ana, matchId);
      const res = await clip(id, ana);
      expect(res.statusCode).toBe(404);
      expect(kit.body(res).error).toMatchObject({ code: 'clip_unavailable' });
      expect(kit.body(res).error.message).toMatch(/grabación de esta jugada no está disponible/);
      expect(launcher().launched).toHaveLength(0);
    });

    it('si ffmpeg falla responde un error claro, sin entregar un archivo a medias', async () => {
      await recording('test-clip-rec');
      const ana = await kit.loginPlayer();
      const id = await savePlay(ana, 'test-clip-rec');
      launcher().onLaunch = (proc, args) => {
        writeFileSync(outputOf(args), 'a medias');
        proc.finish(1);
      };
      const res = await clip(id, ana);
      expect(res.statusCode).toBe(502);
      expect(kit.body(res).error.code).toBe('clip_failed');
      expect(res.headers['content-type']).toMatch(/json/);
      noTempLeft();
    });

    it('si el jugador corta la conexión mientras se prepara, se detiene el corte y no queda el temporal', async () => {
      await recording('test-clip-rec');
      const ana = await kit.loginPlayer();
      const id = await savePlay(ana, 'test-clip-rec');
      launcher().onLaunch = (_proc, args) => writeFileSync(outputOf(args), 'a medias'); // nunca termina
      const baseUrl = await listen(env.app);
      const session = ana;

      const req = http.get(`${baseUrl}/api/plays/${id}/clip`, { headers: { cookie: `${SESSION_COOKIE}=${session}` } });
      req.on('error', () => {});
      await waitFor(() => launcher().launched.length === 1);
      req.destroy();
      await waitFor(() => launcher().launched[0]!.proc.killed);
      await sleep(50);
      noTempLeft();
    });
  });

  describe.skipIf(!hasFfmpeg)('con ffmpeg real', () => {
    it('corta el video de demostración: un mp4 H.264 con audio, de la duración esperada y de hasta 720 de alto', async () => {
      const real = await setup({}, { launcher: new SpawnLauncher('ffmpeg') });
      try {
        copyFileSync(path.join(here, '../videos/demo-partido.mp4'), path.join(real.videos, 'demo-partido.mp4'));
        const club = await real.kit.createClub('test-playclip-real');
        const realCourt = await real.kit.createCourt(club, 'Cancha 1');
        await real.env.db.query(
          `INSERT INTO recordings (id, court_id, starts_at, status, video_file, duration_seconds)
           VALUES ('test-clip-real', $1, '2026-03-01T17:30:00-03:00', 'available', 'demo-partido.mp4', 60)`,
          [realCourt],
        );
        const ana = await real.kit.loginPlayer();
        const make = async (extra: object) => {
          const res = await real.kit.call('POST', '/api/plays', ana, { matchId: 'test-clip-real', title: 'Real', timestamp: 6, ...extra });
          return real.kit.body(res).play.id as string;
        };

        // De 2 a 8 s del video de 10 s: 6 segundos exactos.
        const id = await make({ clipStart: 2, clipEnd: 8 });
        const res = await real.kit.call('GET', `/api/plays/${id}/clip`, ana);
        expect(res.statusCode).toBe(200);
        const out = path.join(real.base, 'descargado.mp4');
        writeFileSync(out, res.rawPayload);
        const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,height', '-show_entries', 'format=duration', '-of', 'json', out]);
        const info = JSON.parse(probe.stdout.toString()) as { streams: { codec_type: string; codec_name: string; height?: number }[]; format: { duration: string } };
        expect(Number(info.format.duration)).toBeGreaterThan(5.4);
        expect(Number(info.format.duration)).toBeLessThan(6.6);
        expect(info.streams.find((s) => s.codec_type === 'video')).toMatchObject({ codec_name: 'h264' });
        expect(info.streams.find((s) => s.codec_type === 'video')!.height!).toBeLessThanOrEqual(720);
        expect(info.streams.some((s) => s.codec_type === 'audio')).toBe(true);

        // Un fragmento que pasa del final del video sale hasta donde hay video (el demo dura 10 s).
        const long = await make({ clipStart: 4, clipEnd: 40, timestamp: 6 });
        const tail = await real.kit.call('GET', `/api/plays/${long}/clip`, ana);
        expect(tail.statusCode).toBe(200);
        writeFileSync(out, tail.rawPayload);
        const tailProbe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out]);
        expect(Number(tailProbe.stdout.toString())).toBeLessThan(6.8);

        // Un fragmento que empieza después del final del video no deja nada que entregar.
        const beyond = await make({ clipStart: 50, clipEnd: 70, timestamp: 60 });
        const empty = await real.kit.call('GET', `/api/plays/${beyond}/clip`, ana);
        expect(empty.statusCode).toBe(502);
        expect(real.kit.body(empty).error.code).toBe('clip_failed');
        expect(existsSync(out)).toBe(true);
      } finally {
        await real.env.close();
        rmSync(real.base, { recursive: true, force: true });
      }
    }, 60_000);
  });
});

describe('límites del corte', () => {
  let ctx: Setup;
  let env: DbTestEnv;
  let kit: Setup['kit'];
  let before: string[];

  beforeAll(async () => {
    ctx = await setup({ CLIP_MAX_CONCURRENT: '1', CLIP_TIMEOUT_MS: '150' });
    env = ctx.env;
    kit = ctx.kit;
  });
  afterAll(async () => {
    await env?.close();
    rmSync(ctx.base, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await env.reset();
    const club = await kit.createClub('test-playclip-lim');
    const court = await kit.createCourt(club, 'Cancha 1');
    await env.db.query(
      `INSERT INTO recordings (id, court_id, starts_at, status, video_file, duration_seconds)
       VALUES ('test-clip-lim', $1, '2026-03-01T17:30:00-03:00', 'available', 'demo-partido.mp4', 60)`,
      [court],
    );
    (env.launcher as FakeLauncher).launched.length = 0;
    before = leftovers();
  });

  const launcher = () => env.launcher as FakeLauncher;
  const outputOf = (args: string[]) => args[args.length - 1]!;
  const savePlay = async (cookie: string) => {
    const res = await kit.call('POST', '/api/plays', cookie, { matchId: 'test-clip-lim', title: 'Jugada', timestamp: 19 });
    return kit.body(res).play.id as string;
  };

  it('con el máximo de cortes en marcha, el siguiente responde 503 con un aviso, sin lanzar ffmpeg ni encolar', async () => {
    const ana = await kit.loginPlayer();
    const id = await savePlay(ana);
    // Un corte que tarda: nunca termina por su cuenta, el test lo termina.
    launcher().onLaunch = (_proc, args) => writeFileSync(outputOf(args), FAKE_MP4);
    const slowCtx = { timeout: 5000 };
    expect(slowCtx.timeout).toBeGreaterThan(0);

    const first = kit.call('GET', `/api/plays/${id}/clip`, ana);
    await waitFor(() => launcher().launched.length === 1);

    const second = await kit.call('GET', `/api/plays/${id}/clip`, ana);
    expect(second.statusCode).toBe(503);
    expect(kit.body(second).error.code).toBe('clip_busy');
    expect(kit.body(second).error.message).toMatch(/unos segundos/);
    expect(launcher().launched).toHaveLength(1);

    launcher().launched[0]!.proc.finish(0);
    expect((await first).statusCode).toBe(200);

    // Cuando uno termina, vuelve a haber lugar.
    launcher().onLaunch = (proc, args) => {
      writeFileSync(outputOf(args), FAKE_MP4);
      proc.finish(0);
    };
    expect((await kit.call('GET', `/api/plays/${id}/clip`, ana)).statusCode).toBe(200);
  });

  it('un corte que pasa del tiempo máximo se detiene, responde 504 con un aviso y no deja el temporal', async () => {
    const ana = await kit.loginPlayer();
    const id = await savePlay(ana);
    launcher().onLaunch = (_proc, args) => writeFileSync(outputOf(args), 'a medias'); // nunca termina
    const res = await kit.call('GET', `/api/plays/${id}/clip`, ana);
    expect(res.statusCode).toBe(504);
    expect(kit.body(res).error.code).toBe('clip_timeout');
    expect(kit.body(res).error.message).toMatch(/más corto/);
    expect(launcher().launched[0]!.proc.killed).toBe(true);
    await sleep(50);
    expect(leftovers().filter((f) => !before.includes(f))).toEqual([]);
  });
});

describe('clipFileName', () => {
  it('arma el nombre con el título sin tildes ni símbolos', () => {
    expect(clipFileName('Gol de chilena')).toBe('jugada-gol-de-chilena.mp4');
    expect(clipFileName('¡Caño al arquero! (Atajadón)')).toBe('jugada-cano-al-arquero-atajadon.mp4');
    expect(clipFileName('Fútbol 5 · Cancha 1')).toBe('jugada-futbol-5-cancha-1.mp4');
    expect(clipFileName('Jugada de 00:08')).toBe('jugada-de-00-08.mp4'); // no repite la palabra
  });

  it('sin letras ni números queda un nombre genérico, y un título larguísimo se acorta', () => {
    expect(clipFileName('¡¡¡???')).toBe('jugada.mp4');
    expect(clipFileName('x'.repeat(300)).length).toBeLessThanOrEqual('jugada-.mp4'.length + 60);
    expect(clipFileName('../../etc/passwd')).toBe('jugada-etc-passwd.mp4');
  });
});
