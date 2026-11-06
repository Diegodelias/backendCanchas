import { describe, expect, it } from 'vitest';
import type { LiveCameraConfig } from '../src/config.js';
import { buildFfmpegArgs, buildRtspUrl, liveCameraLogInfo, sanitize } from '../src/modules/live/rtsp.js';

const cam: LiveCameraConfig = {
  id: 'estacion-norte-c1',
  host: 'camara.example.com:554',
  user: 'camaras',
  pass: 'Cl@ve/Secreta:1!',
  channel: '201',
};

describe('buildRtspUrl', () => {
  it('arma la URL con el canal configurado', () => {
    const url = buildRtspUrl({ ...cam, user: 'u', pass: 'p' });
    expect(url).toBe('rtsp://u:p@camara.example.com:554/Streaming/Channels/201');
  });

  it('codifica los caracteres especiales del usuario y la contraseña', () => {
    const url = buildRtspUrl(cam);
    expect(url).toContain(encodeURIComponent('Cl@ve/Secreta:1!'));
    // La única "@" es la que separa las credenciales del host.
    expect(url.split('@')).toHaveLength(2);
    expect(new URL(url).password).toBe(encodeURIComponent('Cl@ve/Secreta:1!'));
  });

  it('usa el canal pedido', () => {
    expect(buildRtspUrl({ ...cam, channel: '202' })).toMatch(/\/Channels\/202$/);
  });
});

describe('buildFfmpegArgs', () => {
  const args = buildFfmpegArgs('rtsp://x/y');

  it('copia el video sin transcodificar', () => {
    const i = args.indexOf('-c:v');
    expect(args[i + 1]).toBe('copy');
    expect(args).not.toContain('libx264');
  });

  it('entrega MP4 fragmentado por la salida estándar', () => {
    expect(args[args.indexOf('-f') + 1]).toBe('mp4');
    expect(args[args.indexOf('-movflags') + 1]).toBe('frag_keyframe+empty_moov+default_base_moof');
    expect(args[args.length - 1]).toBe('pipe:1');
  });

  it('lee por TCP y pasa la URL como entrada', () => {
    expect(args[args.indexOf('-rtsp_transport') + 1]).toBe('tcp');
    expect(args[args.indexOf('-i') + 1]).toBe('rtsp://x/y');
  });
});

describe('sanitize', () => {
  const url = buildRtspUrl(cam);

  it('reemplaza la URL completa', () => {
    expect(sanitize(`Error abriendo ${url}: Connection refused`, cam)).not.toContain(url);
  });

  it('reemplaza la contraseña suelta, en su forma original y codificada', () => {
    const out = sanitize(`pass=${cam.pass} enc=${encodeURIComponent(cam.pass)}`, cam);
    expect(out).not.toContain(cam.pass);
    expect(out).not.toContain(encodeURIComponent(cam.pass));
  });

  it('reemplaza el usuario suelto', () => {
    expect(sanitize('usuario camaras no autorizado', cam)).not.toContain('camaras');
  });

  it('no deja ninguno de los tres en un texto con todos mezclados', () => {
    const text = `ffmpeg: ${url} -> 401 (user=${cam.user}, pass=${cam.pass}) ${encodeURIComponent(cam.pass)}`;
    const out = sanitize(text, cam);
    for (const secret of [url, cam.user, cam.pass, encodeURIComponent(cam.pass)]) {
      expect(out).not.toContain(secret);
    }
  });

  it('deja intacto un texto sin secretos', () => {
    expect(sanitize('Connection timed out', cam)).toBe('Connection timed out');
  });
});

describe('liveCameraLogInfo', () => {
  it('expone solo el identificador y el canal', () => {
    const info = liveCameraLogInfo(cam);
    expect(info).toEqual({ cameraId: 'estacion-norte-c1', channel: '201' });
    const serialized = JSON.stringify(info);
    expect(serialized).not.toContain(cam.user);
    expect(serialized).not.toContain(cam.pass);
    expect(serialized).not.toContain(cam.host);
  });
});
