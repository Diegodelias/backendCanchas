import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import type { Database } from '../src/db/client.js';

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
  close: () => Promise<void>;
}

export async function createTestEnv(): Promise<TestEnv> {
  const config = testConfig();
  const db = createFakeDatabase();
  const app = await buildApp({ config, db });
  return {
    app,
    db,
    config,
    close: async () => {
      await app.close();
      await db.close();
    },
  };
}
