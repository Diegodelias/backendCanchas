import { z } from 'zod';
import type { Database } from '../../db/client.js';

/** Rangos de la configuración (la base los repite con `CHECK`). */
export const MAX_FREE_QUOTA = 10000;
export const MAX_PACK_PLAYS = 1000;
export const MAX_PACK_PRICE = 1000000;
/** Jugadas extra que el superadmin puede sumar a un jugador en un solo pedido. */
export const MAX_GRANT_PLAYS = 1000;

/**
 * Cuerpo de «cambiar el cupo y el paquete»: los tres valores juntos, enteros. El precio es en pesos argentinos
 * enteros (sin centavos).
 */
export const playSettingsBody = z.object({
  freeQuota: z
    .number({ error: 'El cupo gratuito tiene que ser un número.' })
    .int('El cupo gratuito tiene que ser un número entero.')
    .min(0, 'El cupo gratuito no puede ser negativo.')
    .max(MAX_FREE_QUOTA, `El cupo gratuito puede ser de hasta ${MAX_FREE_QUOTA} jugadas.`),
  packPlays: z
    .number({ error: 'La cantidad de jugadas del paquete tiene que ser un número.' })
    .int('La cantidad de jugadas del paquete tiene que ser un número entero.')
    .min(1, 'El paquete tiene que incluir al menos 1 jugada.')
    .max(MAX_PACK_PLAYS, `El paquete puede incluir hasta ${MAX_PACK_PLAYS} jugadas.`),
  packPrice: z
    .number({ error: 'El precio del paquete tiene que ser un número.' })
    .int('El precio del paquete tiene que ser un número entero de pesos, sin centavos.')
    .min(1, 'El precio del paquete tiene que ser de al menos $1.')
    .max(MAX_PACK_PRICE, `El precio del paquete puede ser de hasta $${MAX_PACK_PRICE}.`),
});

/** Cuerpo de «sumar jugadas extra a un jugador»: su mail y cuántas jugadas. */
export const grantExtraPlaysBody = z.object({
  email: z.email({ error: 'Ingresá un correo electrónico válido (ej. nombre@gmail.com).' }).max(254, 'El mail es demasiado largo.'),
  plays: z
    .number({ error: 'La cantidad de jugadas tiene que ser un número.' })
    .int('La cantidad de jugadas tiene que ser un número entero.')
    .min(1, 'Sumá al menos 1 jugada.')
    .max(MAX_GRANT_PLAYS, `Podés sumar hasta ${MAX_GRANT_PLAYS} jugadas por vez.`),
});

/** Reglas comerciales de las jugadas guardadas (la fila única de `play_settings`). */
export interface PlaySettings {
  /** Jugadas guardadas que cada jugador puede tener gratis. */
  freeQuota: number;
  /** Jugadas que trae el paquete extra. */
  packPlays: number;
  /** Precio del paquete, en pesos argentinos enteros. */
  packPrice: number;
}

/** Valores de respaldo (y los iniciales de la migración) si la fila de configuración faltara. */
export const DEFAULT_PLAY_SETTINGS: PlaySettings = { freeQuota: 200, packPlays: 5, packPrice: 2000 };

export async function getPlaySettings(db: Database): Promise<PlaySettings> {
  const [row] = await db.query<{ free_quota: number; pack_plays: number; pack_price: number }>(
    `SELECT free_quota, pack_plays, pack_price FROM play_settings`,
  );
  return row
    ? { freeQuota: row.free_quota, packPlays: row.pack_plays, packPrice: row.pack_price }
    : DEFAULT_PLAY_SETTINGS;
}

/** El uso y el cupo de un jugador: el cupo total es el gratuito más sus jugadas extra. */
export interface PlayerQuota {
  /** Jugadas guardadas ahora (borrar una libera cupo). */
  used: number;
  freeQuota: number;
  extraPlays: number;
  total: number;
}

export async function getPlayerQuota(db: Database, userId: string): Promise<PlayerQuota> {
  const [row] = await db.query<{ used: number; free_quota: number | null; extra_plays: number }>(
    `SELECT (SELECT count(*)::int FROM plays WHERE user_id = $1::uuid) AS used,
            (SELECT free_quota FROM play_settings) AS free_quota,
            u.extra_plays
       FROM users u WHERE u.id = $1::uuid`,
    [userId],
  );
  const freeQuota = row?.free_quota ?? DEFAULT_PLAY_SETTINGS.freeQuota;
  const extraPlays = row?.extra_plays ?? 0;
  return { used: row?.used ?? 0, freeQuota, extraPlays, total: freeQuota + extraPlays };
}

/** Mensaje al llegar al cupo: dice cuántas jugadas son y qué se puede hacer. */
export function quotaReachedMessage(total: number): string {
  return `Llegaste al máximo de ${total} jugadas guardadas. Borrá alguna para guardar otra.`;
}

/** Guarda el cupo y el paquete (ya validados) y devuelve lo vigente. */
export async function setPlaySettings(db: Database, input: PlaySettings): Promise<PlaySettings> {
  await db.query(
    `INSERT INTO play_settings (id, free_quota, pack_plays, pack_price, updated_at) VALUES (true, $1, $2, $3, now())
     ON CONFLICT (id) DO UPDATE SET
       free_quota = EXCLUDED.free_quota,
       pack_plays = EXCLUDED.pack_plays,
       pack_price = EXCLUDED.pack_price,
       updated_at = now()`,
    [input.freeQuota, input.packPlays, input.packPrice],
  );
  return getPlaySettings(db);
}

/**
 * Suma jugadas extra al jugador con ese mail (sin distinguir mayúsculas). Devuelve su id y mail, o null si no hay un
 * jugador con ese mail: un admin o el superadmin no cuentan, y la respuesta es la misma que para un mail sin cuenta.
 */
export async function grantExtraPlays(
  db: Database,
  email: string,
  plays: number,
): Promise<{ id: string; email: string } | null> {
  const [row] = await db.query<{ id: string; email: string }>(
    `UPDATE users SET extra_plays = extra_plays + $2::int
      WHERE lower(email) = lower($1) AND role = 'player'
      RETURNING id, email`,
    [email, plays],
  );
  return row ?? null;
}
