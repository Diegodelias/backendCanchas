import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getLiveCamera, loadConfig } from '../src/config.js';

const here = path.dirname(fileURLToPath(import.meta.url));

function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]!] = m[2]!;
  }
  return env;
}

describe('.env.example', () => {
  const env = parseEnv(readFileSync(path.join(here, '../.env.example'), 'utf8'));

  it('es una configuración válida tal cual (se puede copiar a .env y arrancar)', () => {
    expect(() => loadConfig(env)).not.toThrow();
  });

  it('deja la cámara sin configurar y sin credenciales', () => {
    expect(getLiveCamera(loadConfig(env))).toBeNull();
    expect(env.CAM_USER).toBe('');
    expect(env.CAM_PASS).toBe('');
    expect(env.CAM_HOST).toBe('');
  });
});
