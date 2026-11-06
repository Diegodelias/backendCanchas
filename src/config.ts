import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z
    .string({ error: 'Falta DATABASE_URL (conexión a PostgreSQL).' })
    .min(1, 'Falta DATABASE_URL (conexión a PostgreSQL).'),
});

export type Config = z.infer<typeof schema>;

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
