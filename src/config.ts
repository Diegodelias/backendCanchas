import { z } from 'zod';

const emptyToUndefined = (v: unknown) => (v === '' ? undefined : v);
const optionalString = z.preprocess(emptyToUndefined, z.string().optional());

/** Canales válidos de la cámara (los del PoC). Solo el 201 está verificado como H.264. */
export const LIVE_CHANNELS = ['101', '102', '201', '202'] as const;

const CAMERA_FIELDS = ['CAM_USER', 'CAM_PASS', 'CAM_HOST', 'LIVE_CAMERA_ID'] as const;

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3100),
    HOST: z.string().default('0.0.0.0'),
    DATABASE_URL: z
      .string({ error: 'Falta DATABASE_URL (conexión a PostgreSQL).' })
      .min(1, 'Falta DATABASE_URL (conexión a PostgreSQL).'),

    // Cámara en vivo (todas opcionales; ver validación de conjunto más abajo).
    CAM_USER: optionalString,
    CAM_PASS: optionalString,
    CAM_HOST: optionalString,
    LIVE_CAMERA_ID: optionalString,
    LIVE_CAMERA_CHANNEL: z.preprocess(emptyToUndefined, z.enum(LIVE_CHANNELS).default('201')),
    LIVE_MAX_VIEWERS: z.coerce.number().int().positive().default(3),
    LIVE_FIRST_BYTE_TIMEOUT_MS: z.coerce.number().int().positive().default(20000),
    FFMPEG: z.preprocess(emptyToUndefined, z.string().default('ffmpeg')),

    // Cookie de sesión con `Secure` (solo viaja por HTTPS). Vacía: sí en production, no en el resto.
    SESSION_COOKIE_SECURE: z.preprocess(emptyToUndefined, z.enum(['true', 'false']).optional()),
  })
  .superRefine((cfg, ctx) => {
    // La cámara es todo o nada: sin ninguna variable no hay cámara; con algunas, es un error.
    const present = CAMERA_FIELDS.filter((f) => cfg[f] !== undefined);
    if (present.length > 0 && present.length < CAMERA_FIELDS.length) {
      const missing = CAMERA_FIELDS.filter((f) => cfg[f] === undefined);
      ctx.addIssue({
        code: 'custom',
        path: [missing[0]!],
        message: `Configuración de cámara incompleta: faltan ${missing.join(', ')}.`,
      });
    }
  })
  .transform((cfg) => ({
    ...cfg,
    SESSION_COOKIE_SECURE:
      cfg.SESSION_COOKIE_SECURE === undefined
        ? cfg.NODE_ENV === 'production'
        : cfg.SESSION_COOKIE_SECURE === 'true',
  }));

export type Config = z.infer<typeof schema>;

export interface LiveCameraConfig {
  id: string;
  host: string;
  user: string;
  pass: string;
  channel: string;
}

/** Devuelve la cámara configurada o null si no hay ninguna. */
export function getLiveCamera(config: Config): LiveCameraConfig | null {
  if (!config.CAM_USER || !config.CAM_PASS || !config.CAM_HOST || !config.LIVE_CAMERA_ID) return null;
  return {
    id: config.LIVE_CAMERA_ID,
    host: config.CAM_HOST,
    user: config.CAM_USER,
    pass: config.CAM_PASS,
    channel: config.LIVE_CAMERA_CHANNEL,
  };
}

/**
 * Valida las variables de entorno. Lanza un Error con un mensaje claro
 * (una línea por variable inválida) si falta alguna obligatoria.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(config)'}: ${i.message}`);
    throw new Error(`Configuración inválida:\n${lines.join('\n')}`);
  }
  return parsed.data;
}
