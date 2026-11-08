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
    expect(config.VIDEOS_DIR).toBe('./videos');
    expect(config.CLIP_MAX_CONCURRENT).toBe(2);
    expect(config.CLIP_TIMEOUT_MS).toBe(60000);
  });

  it('toma los límites del corte del entorno, trata las vacías como no definidas y rechaza valores inválidos', () => {
    const config = loadConfig({ ...base, CLIP_MAX_CONCURRENT: '4', CLIP_TIMEOUT_MS: '90000' });
    expect(config.CLIP_MAX_CONCURRENT).toBe(4);
    expect(config.CLIP_TIMEOUT_MS).toBe(90000);
    const empty = loadConfig({ ...base, CLIP_MAX_CONCURRENT: '', CLIP_TIMEOUT_MS: '' });
    expect([empty.CLIP_MAX_CONCURRENT, empty.CLIP_TIMEOUT_MS]).toEqual([2, 60000]);
    expect(() => loadConfig({ ...base, CLIP_MAX_CONCURRENT: '0' })).toThrowError(/CLIP_MAX_CONCURRENT/);
    expect(() => loadConfig({ ...base, CLIP_TIMEOUT_MS: 'rápido' })).toThrowError(/CLIP_TIMEOUT_MS/);
  });

  it('toma VIDEOS_DIR del entorno y trata la vacía como no definida', () => {
    expect(loadConfig({ ...base, VIDEOS_DIR: '/data/videos' }).VIDEOS_DIR).toBe('/data/videos');
    expect(loadConfig({ ...base, VIDEOS_DIR: '' }).VIDEOS_DIR).toBe('./videos');
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

describe('configuración de mails de acceso', () => {
  const prod = { ...base, NODE_ENV: 'production' };

  it('fuera de producción usa valores por defecto y la consola', () => {
    const config = loadConfig(base);
    expect(config.PUBLIC_APP_URL).toBe('http://localhost:3000');
    expect(config.SMTP_URL).toBeUndefined();
    expect(config.MAIL_FROM).toBe('Canchas3 <no-reply@canchas3.example>');
  });

  it('en producción sin SMTP_URL falla nombrándola', () => {
    expect(() => loadConfig({ ...prod, PUBLIC_APP_URL: 'https://canchas3.example' })).toThrowError(/SMTP_URL/);
  });

  it('en producción sin PUBLIC_APP_URL falla nombrándola', () => {
    expect(() => loadConfig({ ...prod, SMTP_URL: 'smtp://smtp.example:587' })).toThrowError(/PUBLIC_APP_URL/);
  });

  it('en producción con las dos es válida y quita la barra final', () => {
    const config = loadConfig({
      ...prod,
      PUBLIC_APP_URL: 'https://canchas3.example/',
      SMTP_URL: 'smtp://smtp.example:587',
      MAIL_FROM: 'Canchas3 <hola@canchas3.example>',
    });
    expect(config.PUBLIC_APP_URL).toBe('https://canchas3.example');
    expect(config.MAIL_FROM).toBe('Canchas3 <hola@canchas3.example>');
  });

  it('rechaza una PUBLIC_APP_URL que no es una URL', () => {
    expect(() => loadConfig({ ...base, PUBLIC_APP_URL: 'no-es-url' })).toThrowError(/PUBLIC_APP_URL/);
  });
});
