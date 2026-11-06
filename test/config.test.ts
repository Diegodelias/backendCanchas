import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('falla con un mensaje claro si falta DATABASE_URL', () => {
    expect(() => loadConfig({})).toThrowError(/Configuración inválida[\s\S]*DATABASE_URL/);
  });

  it('aplica los valores por defecto', () => {
    const config = loadConfig({ DATABASE_URL: 'postgres://x/y' });
    expect(config.PORT).toBe(3001);
    expect(config.HOST).toBe('0.0.0.0');
    expect(config.NODE_ENV).toBe('development');
  });

  it('rechaza valores numéricos inválidos', () => {
    expect(() => loadConfig({ DATABASE_URL: 'postgres://x/y', PORT: 'abc' })).toThrowError(/PORT/);
  });

  it('rechaza un NODE_ENV desconocido', () => {
    expect(() => loadConfig({ DATABASE_URL: 'postgres://x/y', NODE_ENV: 'otro' })).toThrowError(/NODE_ENV/);
  });
});
