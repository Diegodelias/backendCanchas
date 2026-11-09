import { z } from 'zod';
import type { Database } from '../../db/client.js';

/** Nombre del sitio mientras el superadmin no lo cambie (y respaldo si la fila faltara). */
export const DEFAULT_SITE_NAME = 'Canchas3';
export const MAX_SITE_NAME_LENGTH = 40;

/** Cuerpo de «cambiar el nombre»: sin espacios al borde, de 1 a 40 caracteres y sin saltos de línea. */
export const siteNameBody = z.object({
  name: z
    .string({ error: 'Poné el nombre del sitio.' })
    .trim()
    .min(1, 'Poné el nombre del sitio.')
    .max(MAX_SITE_NAME_LENGTH, `El nombre puede tener hasta ${MAX_SITE_NAME_LENGTH} caracteres.`)
    .refine((value) => !/[\r\n]/.test(value), 'El nombre no puede tener saltos de línea.'),
});

/** El nombre vigente del sitio. */
export async function getSiteName(db: Database): Promise<string> {
  const [row] = await db.query<{ name: string }>(`SELECT name FROM site_settings`);
  return row?.name ?? DEFAULT_SITE_NAME;
}

/** Guarda el nombre (ya validado) y lo devuelve. */
export async function setSiteName(db: Database, name: string): Promise<string> {
  await db.query(
    `INSERT INTO site_settings (id, name, updated_at) VALUES (true, $1, now())
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, updated_at = now()`,
    [name],
  );
  return name;
}
