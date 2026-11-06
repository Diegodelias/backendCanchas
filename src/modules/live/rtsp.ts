import type { LiveCameraConfig } from '../../config.js';

/** URL RTSP de la cámara. El usuario y la contraseña se codifican para que sean válidos en la URL. */
export function buildRtspUrl(cam: LiveCameraConfig): string {
  const auth = `${encodeURIComponent(cam.user)}:${encodeURIComponent(cam.pass)}`;
  return `rtsp://${auth}@${cam.host}/Streaming/Channels/${cam.channel}`;
}

/**
 * Argumentos de ffmpeg: lee RTSP por TCP y entrega MP4 fragmentado por la salida estándar,
 * sin transcodificar el video (`-c:v copy`).
 */
export function buildFfmpegArgs(rtspUrl: string): string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-rtsp_transport',
    'tcp',
    '-timeout',
    '15000000',
    '-i',
    rtspUrl,
    '-c:v',
    'copy',
    '-c:a',
    'aac',
    '-f',
    'mp4',
    '-movflags',
    'frag_keyframe+empty_moov+default_base_moof',
    'pipe:1',
  ];
}

/**
 * Reemplaza en un texto cualquier aparición de la URL RTSP, del usuario y de la contraseña
 * (en su forma original y codificada) para poder registrarlo sin filtrar credenciales.
 */
export function sanitize(text: string, cam: LiveCameraConfig): string {
  const secrets = [
    buildRtspUrl(cam),
    `${cam.user}:${cam.pass}`,
    `${encodeURIComponent(cam.user)}:${encodeURIComponent(cam.pass)}`,
    cam.pass,
    encodeURIComponent(cam.pass),
    cam.user,
    encodeURIComponent(cam.user),
  ]
    .filter((s) => s.length > 0)
    // Los más largos primero, para no dejar restos de una URL ya parcialmente reemplazada.
    .sort((a, b) => b.length - a.length);

  let out = text;
  for (const secret of secrets) out = out.split(secret).join('***');
  return out;
}

/** Datos de la cámara que se pueden registrar: solo identificador y canal. */
export function liveCameraLogInfo(cam: LiveCameraConfig): { cameraId: string; channel: string } {
  return { cameraId: cam.id, channel: cam.channel };
}
