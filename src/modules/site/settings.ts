import { z } from 'zod';
import type { Database } from '../../db/client.js';

/** Nombre del sitio mientras el superadmin no lo cambie (y respaldo si la fila faltara). */
export const DEFAULT_SITE_NAME = 'Canchas3';
export const MAX_SITE_NAME_LENGTH = 40;

/** Claves de la paleta cerrada del logo. Los colores en sí viven en el frontend; la base solo guarda la clave. */
export const LOGO_COLORS = ['verde', 'azul', 'rojo', 'naranja', 'violeta', 'tinta'] as const;
export type LogoColor = (typeof LOGO_COLORS)[number];

/**
 * Cuerpo de «cambiar el sitio»: el nombre sin espacios al borde, de 1 a 40 caracteres y sin saltos de línea, y el
 * color del logo opcional (ausente = no cambia, null = predeterminado, otra clave de la paleta = ese color).
 */
export const siteSettingsBody = z.object({
  name: z
    .string({ error: 'Poné el nombre del sitio.' })
    .trim()
    .min(1, 'Poné el nombre del sitio.')
    .max(MAX_SITE_NAME_LENGTH, `El nombre puede tener hasta ${MAX_SITE_NAME_LENGTH} caracteres.`)
    .refine((value) => !/[\r\n]/.test(value), 'El nombre no puede tener saltos de línea.'),
  logoColor: z
    .enum(LOGO_COLORS, { error: `Elegí un color de la paleta: ${LOGO_COLORS.join(', ')}.` })
    .nullable()
    .optional(),
});

export interface SiteSettings {
  name: string;
  /** La clave del color del logo, o null si es el predeterminado. */
  logoColor: LogoColor | null;
}

/** El nombre y el color del logo vigentes. */
export async function getSiteSettings(db: Database): Promise<SiteSettings> {
  const [row] = await db.query<{ name: string; logo_color: LogoColor | null }>(
    `SELECT name, logo_color FROM site_settings`,
  );
  return { name: row?.name ?? DEFAULT_SITE_NAME, logoColor: row?.logo_color ?? null };
}

/** El nombre vigente del sitio. */
export async function getSiteName(db: Database): Promise<string> {
  return (await getSiteSettings(db)).name;
}

/** Guarda el nombre y, si viene, el color (ya validados) y devuelve lo vigente. Sin color, conserva el que había. */
export async function setSiteSettings(
  db: Database,
  input: { name: string; logoColor?: LogoColor | null },
): Promise<SiteSettings> {
  const changeColor = input.logoColor !== undefined;
  await db.query(
    `INSERT INTO site_settings (id, name, logo_color, updated_at) VALUES (true, $1, $2, now())
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name,
       logo_color = CASE WHEN $3::boolean THEN EXCLUDED.logo_color ELSE site_settings.logo_color END,
       updated_at = now()`,
    [input.name, input.logoColor ?? null, changeColor],
  );
  return getSiteSettings(db);
}
