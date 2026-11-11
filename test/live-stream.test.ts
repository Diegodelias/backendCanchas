import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { STOP_GRACE_MS } from '../src/modules/live/launcher.js';
import {
  createFakeDatabase,
  createTestEnv,
  FakeLauncher,
  type FakeProcess,
  listen,
  open,
  sleep,
  TEST_CAMERA,
  testConfig,
  waitFor,
  type TestEnv,
} from './helpers.js';

const STREAM = '/api/live/estacion-norte-c1/stream';

let current: TestEnv | null = null;
afterEach(async () => {
  await current?.close();
  current = null;
});

async function setup(overrides: Record<string, string> = {}, withCamera = true) {
  const env = await createTestEnv({ ...(withCamera ? TEST_CAMERA : {}), ...overrides });
  current = env;
  const base = await listen(env.app);
  return { env, base };
}

describe('respuestas previas al video', () => {
  it('un identificador de cámara desconocido responde 404 y no lanza ffmpeg', async () => {
    const { env, base } = await setup();
    const { res, body } = await open(`${base}/api/live/otra-camara/stream`);
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(body().toString()).error.code).toBe('not_found');
    expect(env.launcher.launched).toHaveLength(0);
  });

  it('sin cámara configurada informa que no está configurada y no lanza ffmpeg', async () => {
    const { env, base } = await setup({}, false);
    const { res, body } = await open(`${base}${STREAM}`);
    expect(res.statusCode).toBe(503);
    const json = JSON.parse(body().toString());
    expect(json.error.code).toBe('camera_not_configured');
    expect(json.error.message).toContain('no está configurada');
    expect(env.launcher.launched).toHaveLength(0);
  });

  it('si ffmpeg termina antes del primer byte responde 502 legible, sin credenciales', async () => {
    const { env, base } = await setup();
    env.launcher.onLaunch = (proc, args) => {
      const url = args[args.indexOf('-i') + 1]!;
      proc.emitStderr(`${url}: Connection refused (user camaras, pass ${TEST_CAMERA.CAM_PASS})`);
      proc.finish(1);
    };
    const { res, body } = await open(`${base}${STREAM}`);
    expect(res.statusCode).toBe(502);
    const text = body().toString();
    expect(JSON.parse(text).error.code).toBe('camera_unreachable');
    expect(JSON.parse(text).error.message).toMatch(/No pudimos conectar con la cámara/);
    for (const secret of [TEST_CAMERA.CAM_PASS, encodeURIComponent(TEST_CAMERA.CAM_PASS), 'rtsp://', TEST_CAMERA.CAM_HOST]) {
      expect(text).not.toContain(secret);
    }
    expect(res.headers['content-type']).not.toContain('video');
  });

  it('si no llega el primer byte a tiempo responde 502 y mata el proceso', async () => {
    const { env, base } = await setup({ LIVE_FIRST_BYTE_TIMEOUT_MS: '60' });
    const { res } = await open(`${base}${STREAM}`);
    expect(res.statusCode).toBe(502);
    expect(env.launcher.launched[0]!.proc.killed).toBe(true);
  });

  it('si no se puede lanzar ffmpeg responde 502 legible', async () => {
    const { env, base } = await setup();
    env.launcher.throwOnLaunch = new Error('spawn ffmpeg ENOENT');
    const { res, body } = await open(`${base}${STREAM}`);
    expect(res.statusCode).toBe(502);
    expect(body().toString()).not.toContain('ENOENT');
  });

  it('ignora un canal o fechas en el pedido y usa solo la configuración', async () => {
    const { env, base } = await setup();
    env.launcher.onLaunch = (proc) => proc.emitBytes('x');
    const { req } = await open(`${base}${STREAM}?channel=101&start=20260101T000000Z&host=evil.example.com`);
    const url = env.launcher.launched[0]!.args[env.launcher.launched[0]!.args.indexOf('-i') + 1]!;
    expect(url).toMatch(/\/Channels\/201$/);
    expect(url).toContain(TEST_CAMERA.CAM_HOST);
    expect(url).not.toContain('evil.example.com');
    req.destroy();
  });
});

describe('tope de espectadores', () => {
  it('acepta hasta el tope, rechaza al excedente y libera el cupo al desconectarse', async () => {
    const { env, base } = await setup({ LIVE_MAX_VIEWERS: '1' });
    env.launcher.onLaunch = (proc) => proc.emitBytes('video');

    const first = await open(`${base}${STREAM}`);
    expect(first.res.statusCode).toBe(200);

    const second = await open(`${base}${STREAM}`);
    expect(second.res.statusCode).toBe(503);
    const json = JSON.parse(second.body().toString());
    expect(json.error.code).toBe('too_many_viewers');
    expect(json.error.message).toContain('muchos espectadores');
    expect(env.launcher.launched).toHaveLength(1);

    first.req.destroy();
    await waitFor(() => env.launcher.launched[0]!.proc.killed);
    await sleep(50);

    const third = await open(`${base}${STREAM}`);
    expect(third.res.statusCode).toBe(200);
    third.req.destroy();
  });

  it('libera el cupo cuando ffmpeg falla antes del video', async () => {
    const { env, base } = await setup({ LIVE_MAX_VIEWERS: '1' });
    env.launcher.onLaunch = (proc) => proc.finish(1);
    expect((await open(`${base}${STREAM}`)).res.statusCode).toBe(502);
    expect((await open(`${base}${STREAM}`)).res.statusCode).toBe(502);
    expect(env.launcher.launched).toHaveLength(2);
  });
});

describe('entrega del video', () => {
  it('responde 200 con las cabeceras de video en vivo y los bytes de ffmpeg', async () => {
    const { env, base } = await setup();
    env.launcher.onLaunch = (proc) => proc.emitBytes('PRIMEROS-BYTES');
    const { res, req, body } = await open(`${base}${STREAM}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('video/mp4');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-accel-buffering']).toBe('no');

    env.launcher.launched[0]!.proc.emitBytes('-SEGUNDOS');
    await waitFor(() => body().toString().includes('-SEGUNDOS'));
    expect(body().toString()).toBe('PRIMEROS-BYTES-SEGUNDOS');
    req.destroy();
  });

  it('si el flujo se corta a mitad, la respuesta termina', async () => {
    const { env, base } = await setup();
    env.launcher.onLaunch = (proc) => proc.emitBytes('datos');
    const { res, ended } = await open(`${base}${STREAM}`);
    expect(res.statusCode).toBe(200);
    env.launcher.launched[0]!.proc.finish(1);
    await ended;
    expect(res.complete || res.destroyed || res.readableEnded).toBe(true);
  });

  it('si el cliente se desconecta, se mata el proceso', async () => {
    const { env, base } = await setup();
    env.launcher.onLaunch = (proc) => proc.emitBytes('datos');
    const { req } = await open(`${base}${STREAM}`);
    const proc = env.launcher.launched[0]!.proc;
    expect(proc.killed).toBe(false);
    req.destroy();
    await waitFor(() => proc.killed);
    expect(proc.killed).toBe(true);
  });
});

describe('apagado del servidor', () => {
  it('al cerrar la app se matan los procesos activos', async () => {
    const { env, base } = await setup();
    env.launcher.onLaunch = (proc) => proc.emitBytes('datos');
    const a = await open(`${base}${STREAM}`);
    const procs = env.launcher.launched.map((l) => l.proc);
    expect(procs.every((p) => !p.killed)).toBe(true);

    await env.app.close();
    expect(procs.every((p) => p.killed)).toBe(true);
    a.req.destroy();
    current = null; // ya se cerró
  });

  it('el apagado espera a que los procesos terminen de verdad, no solo a pedirles que se detengan', async () => {
    const { env, base } = await setup();
    let closedAt = 0;
    env.launcher.onLaunch = (proc) => {
      proc.emitBytes('datos');
      // Un ffmpeg que tarda en cerrar la sesión con la cámara antes de salir.
      proc.kill = () => {
        proc.killed = true;
        setTimeout(() => {
          closedAt = Date.now();
          proc.finish(null);
        }, 200);
      };
    };
    const a = await open(`${base}${STREAM}`);

    await env.app.close();
    const doneAt = Date.now();
    expect(closedAt).toBeGreaterThan(0); // el proceso terminó antes de que el apagado devolviera
    expect(doneAt).toBeGreaterThanOrEqual(closedAt);
    a.req.destroy();
    current = null;
  });

  it('un proceso que no cierra no cuelga el apagado más allá del tope', async () => {
    const { env, base } = await setup();
    env.launcher.onLaunch = (proc) => {
      proc.emitBytes('datos');
      proc.kill = () => {
        proc.killed = true; // pide detenerse pero nunca cierra
      };
    };
    const a = await open(`${base}${STREAM}`);

    const start = Date.now();
    const closing = env.app.close();
    let finished = false;
    void closing.then(() => (finished = true));

    // Dentro del plazo del respaldo el apagado sigue esperando al proceso.
    await sleep(STOP_GRACE_MS - 1000);
    expect(finished).toBe(false);

    // Pasado el tope el apagado ya no espera al proceso. Lo único que lo retiene es la respuesta de video abierta del
    // cliente (este proceso falso nunca cierra su salida; en producción lo termina el respaldo forzado del lanzador):
    // se la cierra y el apagado tiene que completarse. Si siguiera colgado del proceso, nunca terminaría.
    await sleep(2000 + 800);
    a.req.destroy();
    await closing;
    expect(Date.now() - start).toBeGreaterThanOrEqual(STOP_GRACE_MS);
    expect(Date.now() - start).toBeLessThan(STOP_GRACE_MS + 3000);
    current = null;
  }, 15000);
});

describe('registros (logs)', () => {
  it('no contienen usuario, contraseña ni dirección, ni al arrancar ni ante un fallo', async () => {
    const lines: string[] = [];
    const config = testConfig(TEST_CAMERA);
    const db = createFakeDatabase();
    const launcher = new FakeLauncher();
    launcher.onLaunch = (proc, args) => {
      const url = args[args.indexOf('-i') + 1]!;
      proc.emitStderr(`${url}: 401 Unauthorized (user ${TEST_CAMERA.CAM_USER}, pass ${TEST_CAMERA.CAM_PASS})`);
      proc.finish(1);
    };
    const app = await buildApp({ config, db, launcher, logStream: { write: (m) => void lines.push(m) } });
    const base = await listen(app);
    try {
      const { res } = await open(`${base}${STREAM}`);
      expect(res.statusCode).toBe(502);

      const all = lines.join('\n');
      // Se registra la cámara configurada y el fallo, pero sin secretos.
      expect(all).toContain('estacion-norte-c1');
      expect(all).toContain('201');
      for (const secret of [
        TEST_CAMERA.CAM_USER,
        TEST_CAMERA.CAM_PASS,
        encodeURIComponent(TEST_CAMERA.CAM_PASS),
        TEST_CAMERA.CAM_HOST,
        'rtsp://',
      ]) {
        expect(all).not.toContain(secret);
      }
    } finally {
      await app.close();
    }
  });
});

describe('health con la cámara sin configurar', () => {
  it('GET /api/health responde correctamente', async () => {
    const { base } = await setup({}, false);
    const { res, body } = await open(`${base}/api/health`);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(body().toString())).toEqual({ status: 'ok' });
  });
});

describe('métricas por stream', () => {
  interface MetricsLine {
    level: number;
    msg: string;
    cameraId: string;
    outcome: string;
    ttfbMs: number | null;
    durationMs: number;
    bytes: number;
    avgMbps: number | null;
    viewersAtStart: number;
  }

  let closeApp: (() => Promise<void>) | null = null;
  afterEach(async () => {
    await closeApp?.();
    closeApp = null;
  });

  /** Una app con el log capturado; `metrics()` devuelve solo las líneas «stream en vivo terminado». */
  async function setupWithLogs(overrides: Record<string, string> = {}) {
    const lines: string[] = [];
    const launcher = new FakeLauncher();
    const app = await buildApp({
      config: testConfig({ ...TEST_CAMERA, ...overrides }),
      db: createFakeDatabase(),
      launcher,
      logStream: { write: (m) => void lines.push(m) },
    });
    closeApp = () => app.close();
    const base = await listen(app);
    const metrics = () =>
      lines.map((l) => JSON.parse(l) as MetricsLine).filter((l) => l.msg === 'stream en vivo terminado');
    const waitForMetric = async () => {
      await waitFor(() => metrics().length > 0);
      await sleep(30); // por si una segunda salida intentara escribir otra línea
      return metrics();
    };
    return { app, base, launcher, metrics, waitForMetric };
  }

  it('el cliente que se va con el video andando deja una línea info con primer byte, bytes y Mbps', async () => {
    const { base, launcher, waitForMetric } = await setupWithLogs();
    launcher.onLaunch = (proc) => proc.emitBytes('PRIMEROS-BYTES');
    const { req, body } = await open(`${base}${STREAM}`);
    launcher.launched[0]!.proc.emitBytes('-SEGUNDOS');
    await waitFor(() => body().toString().includes('-SEGUNDOS'));
    await sleep(20);
    req.destroy();

    const lines = await waitForMetric();
    expect(lines).toHaveLength(1);
    const line = lines[0]!;
    expect(line).toMatchObject({ level: 30, cameraId: 'estacion-norte-c1', outcome: 'client_closed', viewersAtStart: 1 });
    expect(line.bytes).toBe('PRIMEROS-BYTES-SEGUNDOS'.length);
    expect(line.ttfbMs).toEqual(expect.any(Number));
    expect(line.durationMs).toBeGreaterThanOrEqual(line.ttfbMs!);
    expect(line.avgMbps).toEqual(expect.any(Number));
  });

  it('el corte del video ya empezado deja una línea warn de stream terminado', async () => {
    const { base, launcher, waitForMetric } = await setupWithLogs();
    launcher.onLaunch = (proc) => proc.emitBytes('datos');
    const { ended } = await open(`${base}${STREAM}`);
    launcher.launched[0]!.proc.finish(1);
    await ended;

    const lines = await waitForMetric();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 40, outcome: 'stream_ended', bytes: 5 });
    expect(lines[0]!.ttfbMs).toEqual(expect.any(Number));
  });

  it('sin primer byte a tiempo deja una línea warn sin primer byte, sin Mbps y con 0 bytes', async () => {
    const { base, waitForMetric } = await setupWithLogs({ LIVE_FIRST_BYTE_TIMEOUT_MS: '60' });
    expect((await open(`${base}${STREAM}`)).res.statusCode).toBe(502);

    const lines = await waitForMetric();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 40, outcome: 'first_byte_timeout', ttfbMs: null, avgMbps: null, bytes: 0 });
  });

  it('si ffmpeg falla antes del video la línea lo distingue', async () => {
    const { base, launcher, waitForMetric } = await setupWithLogs();
    launcher.onLaunch = (proc) => proc.finish(1);
    expect((await open(`${base}${STREAM}`)).res.statusCode).toBe(502);

    const lines = await waitForMetric();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 40, outcome: 'ffmpeg_failed_before_video', ttfbMs: null, bytes: 0 });
  });

  it('si no se puede lanzar ffmpeg la línea lo distingue', async () => {
    const { base, launcher, waitForMetric } = await setupWithLogs();
    launcher.throwOnLaunch = new Error('spawn ffmpeg ENOENT');
    expect((await open(`${base}${STREAM}`)).res.statusCode).toBe(502);

    const lines = await waitForMetric();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 40, outcome: 'spawn_failed', ttfbMs: null, bytes: 0, avgMbps: null });
  });

  it('el rechazo por tope de espectadores deja una línea warn con los espectadores de ese momento', async () => {
    const { base, launcher, metrics } = await setupWithLogs({ LIVE_MAX_VIEWERS: '1' });
    launcher.onLaunch = (proc) => proc.emitBytes('video');
    const first = await open(`${base}${STREAM}`);
    expect((await open(`${base}${STREAM}`)).res.statusCode).toBe(503);

    await waitFor(() => metrics().length > 0);
    expect(metrics()).toHaveLength(1);
    expect(metrics()[0]).toMatchObject({ level: 40, outcome: 'too_many_viewers', viewersAtStart: 1, bytes: 0, ttfbMs: null });
    first.req.destroy();
    await waitFor(() => metrics().length === 2);
    expect(metrics()[1]).toMatchObject({ outcome: 'client_closed' });
  });

  it('el cliente que se va antes del video deja una línea info distinta', async () => {
    const { base, launcher, waitForMetric } = await setupWithLogs();
    // ffmpeg arranca pero nunca entrega video: la respuesta no llega a empezar.
    const req = http.get(`${base}${STREAM}`);
    req.on('error', () => {});
    await waitFor(() => launcher.launched.length === 1);
    req.destroy();

    const lines = await waitForMetric();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 30, outcome: 'client_closed_before_video', ttfbMs: null, bytes: 0, avgMbps: null });
  });

  it('el apagado del servidor queda registrado como tal y no como un corte de la cámara', async () => {
    const { app, base, launcher, metrics } = await setupWithLogs();
    launcher.onLaunch = (proc) => proc.emitBytes('datos');
    const { req } = await open(`${base}${STREAM}`);
    await app.close();
    closeApp = null;
    req.destroy();

    expect(metrics()).toHaveLength(1);
    expect(metrics()[0]).toMatchObject({ level: 30, outcome: 'server_shutdown' });
  });

  it('las líneas de métricas no contienen usuario, contraseña, host ni dirección de la cámara', async () => {
    const { base, launcher, metrics } = await setupWithLogs({ LIVE_FIRST_BYTE_TIMEOUT_MS: '60' });
    launcher.onLaunch = (proc, args) => proc.emitStderr(`${args[args.indexOf('-i') + 1]}: timeout`);
    expect((await open(`${base}${STREAM}`)).res.statusCode).toBe(502);
    launcher.onLaunch = (proc) => proc.emitBytes('video');
    const { req } = await open(`${base}${STREAM}`);
    req.destroy();
    await waitFor(() => metrics().length === 2);

    const all = JSON.stringify(metrics());
    for (const secret of [
      TEST_CAMERA.CAM_USER,
      TEST_CAMERA.CAM_PASS,
      encodeURIComponent(TEST_CAMERA.CAM_PASS),
      TEST_CAMERA.CAM_HOST,
      'camara.example.com',
      'rtsp://',
    ]) {
      expect(all).not.toContain(secret);
    }
  });

  describe('lugar de espectador y tope de procesos', () => {
    /** Un ffmpeg falso que, al detenerlo, tarda `ms` en cerrarse (o nunca, con `null`). */
    function slowToClose(ms: number | null) {
      return (proc: FakeProcess) => {
        proc.emitBytes('video');
        proc.kill = () => {
          if (proc.killed) return;
          proc.killed = true;
          if (ms !== null) setTimeout(() => proc.finish(null), ms);
        };
      };
    }

    it('un cliente que se va y un pedido inmediato recibe video aunque el proceso anterior siga cerrándose', async () => {
      const { base, launcher } = await setupWithLogs({ LIVE_MAX_VIEWERS: '1' });
      launcher.onLaunch = slowToClose(500);

      const first = await open(`${base}${STREAM}`);
      expect(first.res.statusCode).toBe(200);
      first.req.destroy();
      await waitFor(() => launcher.launched[0]!.proc.killed);

      // El proceso anterior todavía se está cerrando (500 ms), pero su lugar ya está libre.
      const second = await open(`${base}${STREAM}`);
      expect(second.res.statusCode).toBe(200);
      expect(launcher.launched).toHaveLength(2);
      second.req.destroy();
      await launcher.launched[0]!.proc.closed;
      launcher.launched[1]!.proc.finish(null);
    });

    it('el lugar no se libera dos veces: al terminar de cerrarse el proceso anterior no se admiten más espectadores', async () => {
      const { base, launcher } = await setupWithLogs({ LIVE_MAX_VIEWERS: '1' });
      launcher.onLaunch = slowToClose(300);

      const first = await open(`${base}${STREAM}`);
      first.req.destroy();
      await waitFor(() => launcher.launched[0]!.proc.killed);
      const second = await open(`${base}${STREAM}`); // ocupa el único lugar
      expect(second.res.statusCode).toBe(200);

      await launcher.launched[0]!.proc.closed; // el primero termina de cerrarse: no debe liberar el lugar del segundo
      await sleep(30);
      const third = await open(`${base}${STREAM}`);
      expect(third.res.statusCode).toBe(503);
      expect(JSON.parse(third.body().toString()).error.code).toBe('too_many_viewers');
      expect(launcher.launched).toHaveLength(2);
      second.req.destroy();
      await launcher.launched[1]!.proc.closed;
    });

    it('con procesos que no cierran, al llegar al doble del tope rechaza sin lanzar ffmpeg y deja la línea de métricas', async () => {
      const { base, launcher, metrics } = await setupWithLogs({ LIVE_MAX_VIEWERS: '1' });
      launcher.onLaunch = slowToClose(null); // nunca terminan de cerrarse

      const first = await open(`${base}${STREAM}`);
      first.req.destroy(); // su lugar queda libre, su proceso sigue contando
      await waitFor(() => launcher.launched[0]!.proc.killed);
      const second = await open(`${base}${STREAM}`);
      expect(second.res.statusCode).toBe(200);

      const third = await open(`${base}${STREAM}`); // ya hay 2 procesos: el doble del tope
      expect(third.res.statusCode).toBe(503);
      expect(JSON.parse(third.body().toString()).error.code).toBe('too_many_viewers');
      expect(launcher.launched).toHaveLength(2); // no se lanzó ningún ffmpeg más
      await waitFor(() => metrics().some((m) => m.outcome === 'too_many_viewers'));
      expect(metrics().find((m) => m.outcome === 'too_many_viewers')).toMatchObject({ level: 40, bytes: 0, ttfbMs: null });

      second.req.destroy();
      for (const l of launcher.launched) l.proc.finish(null); // para que el apagado de la prueba no espere
    });

    it('un proceso que falló antes del video se sigue contando hasta que cierra, y al cerrar vuelve a admitir pedidos', async () => {
      const { base, launcher } = await setupWithLogs({ LIVE_MAX_VIEWERS: '1', LIVE_FIRST_BYTE_TIMEOUT_MS: '60' });
      // Nunca entregan video ni cierran: fallan por el tiempo del primer byte y quedan cerrándose.
      launcher.onLaunch = (proc) => {
        proc.kill = () => {
          proc.killed = true;
        };
      };
      expect((await open(`${base}${STREAM}`)).res.statusCode).toBe(502);
      expect((await open(`${base}${STREAM}`)).res.statusCode).toBe(502);
      expect(launcher.launched).toHaveLength(2);

      // Sus lugares ya están libres, pero los dos procesos siguen vivos: se alcanzó el doble del tope.
      const blocked = await open(`${base}${STREAM}`);
      expect(blocked.res.statusCode).toBe(503);
      expect(launcher.launched).toHaveLength(2);

      for (const l of launcher.launched) l.proc.finish(null);
      await Promise.all(launcher.launched.map((l) => l.proc.closed));
      await sleep(30);

      launcher.onLaunch = (proc) => proc.emitBytes('video');
      const again = await open(`${base}${STREAM}`);
      expect(again.res.statusCode).toBe(200);
      expect(launcher.launched).toHaveLength(3);
      again.req.destroy();
    });
  });
});
