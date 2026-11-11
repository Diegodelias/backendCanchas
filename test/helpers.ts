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
import type { MailMessage, Mailer } from '../src/modules/mail/mailer.js';

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
  private resolveClosed: () => void = () => {};
  /** Se resuelve cuando el proceso cierra, igual que en el lanzador real. */
  readonly closed = new Promise<void>((resolve) => {
    this.resolveClosed = resolve;
  });

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
    setImmediate(() => {
      this.events.emit('close', code);
      this.resolveClosed();
    });
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

/** Mailer falso: guarda lo "enviado" para que los tests lo lean. */
export class FakeMailer implements Mailer {
  readonly sent: MailMessage[] = [];
  /** Si no es null, `send` falla con este error (simula un SMTP caído). */
  failWith: Error | null = null;
  /** Cuántas veces se llamó a `send` (con éxito o no). */
  attempts = 0;
  /** Si es mayor que 0, las próximas `failTimes` llamadas fallan y después se entrega (falla pasajera). */
  failTimes = 0;

  async send(message: MailMessage): Promise<void> {
    this.attempts++;
    if (this.failTimes > 0) {
      this.failTimes--;
      throw Object.assign(new Error('SMTP caído por un momento'), { code: 'ECONNRESET' });
    }
    if (this.failWith) throw this.failWith;
    this.sent.push(message);
  }

  /** Código de 6 dígitos del último mail de acceso enviado a ese destinatario, o null. */
  lastCodeTo(email: string): string | null {
    const mail = [...this.sent].reverse().find((m) => m.to.toLowerCase() === email.toLowerCase());
    return mail?.text.match(/Tu código: (\d{6})/)?.[1] ?? null;
  }

  /** Link de acceso del último mail enviado a ese destinatario, o null. */
  lastLinkTo(email: string): string | null {
    const mail = [...this.sent].reverse().find((m) => m.to.toLowerCase() === email.toLowerCase());
    return mail?.text.match(/https?:\/\/\S+/)?.[0] ?? null;
  }
}

export interface DbTestEnv {
  app: FastifyInstance;
  db: Database;
  /** Lanzador de ffmpeg de la app: el falso, salvo que se inyecte otro. */
  launcher: FfmpegLauncher;
  clock: TestClock;
  mailer: FakeMailer;
  /** Vacía las tablas de auth (se llama antes de cada caso). */
  reset: () => Promise<void>;
  close: () => Promise<void>;
}

/** App contra la base real de prueba: aplica migraciones y devuelve un entorno con reloj manual. */
export async function createDbTestEnv(
  overrides: Record<string, string> = {},
  logStream?: { write(message: string): void },
  extra: { launcher?: FfmpegLauncher } = {},
): Promise<DbTestEnv> {
  const url = requireTestDatabaseUrl();
  await runMigrations(url);
  const db = createPgDatabase(url);
  const clock = new TestClock();
  const mailer = new FakeMailer();
  const config = testConfig({ DATABASE_URL: url, ...overrides });
  const launcher = extra.launcher ?? new FakeLauncher();
  const app = await buildApp({ config, db, launcher, now: clock.now, mailer, mailRetryDelaysMs: [5, 5], logStream });
  return {
    app,
    db,
    launcher,
    clock,
    mailer,
    reset: async () => {
      await truncateAuthTables(db);
      await deleteTestClubs(db);
      // El nombre del sitio no se vacía con las demás tablas: vuelve al valor por defecto.
      await db.query(`UPDATE site_settings SET name = 'Canchas3', logo_color = NULL`);
      // Lo mismo con el cupo de jugadas y el paquete: vuelven a 200 jugadas gratis y a 5 jugadas por $2.000.
      await db.query(`UPDATE play_settings SET free_quota = 200, pack_plays = 5, pack_price = 2000`);
      mailer.sent.length = 0;
      mailer.failWith = null;
      mailer.attempts = 0;
      mailer.failTimes = 0;
      clock.current = new TestClock().current;
    },
    close: async () => {
      await app.close();
      await db.close();
    },
  };
}

/**
 * Borra los clubes que crean los tests (id con prefijo `test-`); sus canchas caen por cascada.
 * Los clubes y canchas iniciales (datos de ejemplo) nunca se tocan.
 */
export async function deleteTestClubs(db: Database): Promise<void> {
  await db.query(`DELETE FROM clubs WHERE id LIKE 'test-%'`);
}

export async function truncateAuthTables(db: Database): Promise<void> {
  await db.query('TRUNCATE plays, link_requests, login_tokens, login_attempts, sessions, users RESTART IDENTITY CASCADE');
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
