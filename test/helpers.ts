import { EventEmitter } from 'node:events';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { createPgDatabase, type Database } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
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
    async query() {
      // Las pruebas con FakeDatabase (health, live) no consultan la base; las de auth usan una real.
      throw new Error('FakeDatabase no ejecuta consultas: usá createDbTestEnv() con TEST_DATABASE_URL.');
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

const MISSING_TEST_DB = `Falta TEST_DATABASE_URL: los tests de auth necesitan un PostgreSQL de prueba.
Con el compose del backend:
  docker compose up -d db
  docker compose exec db psql -U canchas3 -d canchas3 -c "CREATE DATABASE canchas3_test"
y luego, por ejemplo:
  TEST_DATABASE_URL=postgres://canchas3:canchas3@localhost:5432/canchas3_test npm test
(ver README.md, «Tests contra la base»).`;

/** URL de la base de prueba; lanza un error que explica cómo levantarla si no está definida. */
export function requireTestDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error(MISSING_TEST_DB);
  return url;
}

/** Reloj manual: arranca en una fecha fija y solo avanza cuando el test lo pide. */
export class TestClock {
  current = new Date('2026-03-02T12:00:00Z');
  now = () => new Date(this.current);
  advance(ms: number) {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export interface DbTestEnv {
  app: FastifyInstance;
  db: Database;
  clock: TestClock;
  /** Vacía las tablas de auth (se llama antes de cada caso). */
  reset: () => Promise<void>;
  close: () => Promise<void>;
}

/** App contra la base real de prueba: aplica migraciones y devuelve un entorno con reloj manual. */
export async function createDbTestEnv(overrides: Record<string, string> = {}): Promise<DbTestEnv> {
  const url = requireTestDatabaseUrl();
  await runMigrations(url);
  const db = createPgDatabase(url);
  const clock = new TestClock();
  const config = testConfig({ DATABASE_URL: url, ...overrides });
  const app = await buildApp({ config, db, launcher: new FakeLauncher(), now: clock.now });
  return {
    app,
    db,
    clock,
    reset: async () => {
      await truncateAuthTables(db);
      clock.current = new TestClock().current;
    },
    close: async () => {
      await app.close();
      await db.close();
    },
  };
}

export async function truncateAuthTables(db: Database): Promise<void> {
  await db.query('TRUNCATE login_attempts, sessions, users RESTART IDENTITY CASCADE');
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
