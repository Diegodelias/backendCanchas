import { EventEmitter } from 'node:events';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import type { Database } from '../src/db/client.js';
import type { FfmpegLauncher, FfmpegProcess } from '../src/modules/live/launcher.js';

export interface FakeDatabase extends Database {
  /** Permite simular que la base deja de responder. */
  failing: boolean;
}

export function createFakeDatabase(): FakeDatabase {
  const fake: FakeDatabase = {
    failing: false,
    async ping() {
      if (fake.failing) throw new Error('sin conexión');
    },
    async close() {},
  };
  return fake;
}

/** Proceso de ffmpeg falso: el test decide qué bytes emite y cuándo termina. */
export class FakeProcess implements FfmpegProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;
  private readonly events = new EventEmitter();

  onClose(listener: (code: number | null) => void) {
    this.events.on('close', listener);
  }
  onError(listener: (error: Error) => void) {
    this.events.on('error', listener);
  }
  kill() {
    if (this.killed) return;
    this.killed = true;
    this.finish(null);
  }
  /** Simula que ffmpeg termina por su cuenta. */
  finish(code: number | null) {
    this.stdout.end();
    this.stderr.end();
    setImmediate(() => this.events.emit('close', code));
  }
  emitBytes(data: string | Buffer) {
    this.stdout.write(data);
  }
  emitStderr(text: string) {
    this.stderr.write(text);
  }
}

export class FakeLauncher implements FfmpegLauncher {
  readonly launched: { args: string[]; proc: FakeProcess }[] = [];
  throwOnLaunch: Error | null = null;
  /** Se ejecuta apenas se lanza un proceso, para programar su comportamiento. */
  onLaunch: (proc: FakeProcess, args: string[]) => void = () => {};

  launch(args: string[]): FfmpegProcess {
    if (this.throwOnLaunch) throw this.throwOnLaunch;
    const proc = new FakeProcess();
    this.launched.push({ args, proc });
    this.onLaunch(proc, args);
    return proc;
  }
}

export const TEST_CAMERA = {
  CAM_USER: 'camaras',
  CAM_PASS: 'Cl@ve/Secreta:1!',
  CAM_HOST: 'camara.example.com:554',
  LIVE_CAMERA_ID: 'estacion-norte-c1',
};

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://test/test',
    ...overrides,
  });
}

export interface TestEnv {
  app: FastifyInstance;
  db: FakeDatabase;
  config: Config;
  launcher: FakeLauncher;
  close: () => Promise<void>;
}

export async function createTestEnv(overrides: Record<string, string> = {}): Promise<TestEnv> {
  const config = testConfig(overrides);
  const db = createFakeDatabase();
  const launcher = new FakeLauncher();
  const app = await buildApp({ config, db, launcher });
  return {
    app,
    db,
    config,
    launcher,
    close: async () => {
      await app.close();
      await db.close();
    },
  };
}

/** Levanta el servidor en un puerto libre y devuelve la dirección base. */
export async function listen(app: FastifyInstance): Promise<string> {
  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

export interface OpenedRequest {
  req: http.ClientRequest;
  res: http.IncomingMessage;
  /** Cuerpo recibido hasta ahora. */
  body: () => Buffer;
  /** Se resuelve cuando la respuesta termina (o se corta). */
  ended: Promise<void>;
}

/** Abre una conexión real y espera las cabeceras de la respuesta. */
export function open(url: string): Promise<OpenedRequest> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      const ended = new Promise<void>((done) => {
        res.on('end', () => done());
        res.on('close', () => done());
        res.on('error', () => done());
      });
      resolve({ req, res, body: () => Buffer.concat(chunks), ended });
    });
    req.on('error', reject);
  });
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Espera hasta que se cumpla la condición (o falla por tiempo). */
export async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: se agotó el tiempo');
    await sleep(10);
  }
}
