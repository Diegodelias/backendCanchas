import { describe, expect, it } from 'vitest';
import { getLiveCamera, loadConfig } from '../src/config.js';

const base = { DATABASE_URL: 'postgres://x/y' };
const camera = {
  CAM_USER: 'camaras',
  CAM_PASS: 'clave-de-prueba',
  CAM_HOST: 'camara.example.com:554',
  LIVE_CAMERA_ID: 'estacion-norte-c1',
};

describe('loadConfig', () => {
  it('falla con un mensaje claro si falta DATABASE_URL', () => {
    expect(() => loadConfig({})).toThrowError(/Configuración inválida[\s\S]*DATABASE_URL/);
  });

  it('aplica los valores por defecto', () => {
    const config = loadConfig(base);
    expect(config.PORT).toBe(3100);
    expect(config.HOST).toBe('0.0.0.0');
    expect(config.NODE_ENV).toBe('development');
    expect(config.LIVE_CAMERA_CHANNEL).toBe('201');
    expect(config.LIVE_MAX_VIEWERS).toBe(3);
    expect(config.FFMPEG).toBe('ffmpeg');
  });

  it('rechaza valores numéricos inválidos', () => {
    expect(() => loadConfig({ ...base, PORT: 'abc' })).toThrowError(/PORT/);
  });

  it('rechaza un NODE_ENV desconocido', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'otro' })).toThrowError(/NODE_ENV/);
  });
});

describe('configuración de la cámara', () => {
  it('sin ninguna variable de cámara arranca y no hay cámara configurada', () => {
    const config = loadConfig(base);
    expect(getLiveCamera(config)).toBeNull();
  });

  it('trata las variables vacías como ausentes', () => {
    const config = loadConfig({ ...base, CAM_USER: '', CAM_PASS: '', CAM_HOST: '', LIVE_CAMERA_ID: '' });
    expect(getLiveCamera(config)).toBeNull();
  });

  it('con todas las variables la cámara queda configurada con el canal 201 por defecto', () => {
    const config = loadConfig({ ...base, ...camera });
    expect(getLiveCamera(config)).toEqual({
      id: 'estacion-norte-c1',
      host: 'camara.example.com:554',
      user: 'camaras',
      pass: 'clave-de-prueba',
      channel: '201',
    });
  });

  it('con algunas variables falla nombrando las que faltan', () => {
    expect(() => loadConfig({ ...base, CAM_USER: 'camaras', CAM_HOST: 'camara.example.com:554' })).toThrowError(
      /faltan CAM_PASS, LIVE_CAMERA_ID/,
    );
  });

  it('el mensaje de configuración incompleta no incluye la contraseña', () => {
    try {
      loadConfig({ ...base, CAM_USER: 'camaras', CAM_PASS: 'clave-de-prueba' });
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).not.toContain('clave-de-prueba');
    }
  });

  it('acepta un canal válido y rechaza uno inválido', () => {
    expect(loadConfig({ ...base, ...camera, LIVE_CAMERA_CHANNEL: '202' }).LIVE_CAMERA_CHANNEL).toBe('202');
    expect(() => loadConfig({ ...base, ...camera, LIVE_CAMERA_CHANNEL: '999' })).toThrowError(
      /LIVE_CAMERA_CHANNEL/,
    );
  });

  it('permite configurar el tope de espectadores', () => {
    expect(loadConfig({ ...base, LIVE_MAX_VIEWERS: '5' }).LIVE_MAX_VIEWERS).toBe(5);
    expect(() => loadConfig({ ...base, LIVE_MAX_VIEWERS: '0' })).toThrowError(/LIVE_MAX_VIEWERS/);
  });
});
