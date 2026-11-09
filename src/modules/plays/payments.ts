import type { Database } from '../../db/client.js';
import { DEFAULT_PLAY_SETTINGS } from './quota.js';

/** Proveedor de los pagos de hoy: una demostración, no se cobra nada. Un proveedor real se enchufa con otro valor. */
export const SIMULATED_PROVIDER = 'simulated';

export type PaymentStatus = 'pending' | 'approved' | 'rejected';

/** Un intento de compra del paquete, tal como lo ve el jugador. */
export interface PlayPayment {
  id: string;
  /** Jugadas del paquete al iniciar el intento: no cambia si después cambia el paquete. */
  plays: number;
  /** Precio en pesos argentinos enteros, también al iniciar el intento. */
  price: number;
  status: PaymentStatus;
  provider: string;
  createdAt: string;
  resolvedAt: string | null;
}

interface PaymentRow {
  id: string;
  plays: number;
  price: number;
  status: PaymentStatus;
  provider: string;
  created_at: Date;
  resolved_at: Date | null;
}

const COLUMNS = 'id, plays, price, status, provider, created_at, resolved_at';

function toPayment(row: PaymentRow): PlayPayment {
  return {
    id: row.id,
    plays: row.plays,
    price: row.price,
    status: row.status,
    provider: row.provider,
    createdAt: row.created_at.toISOString(),
    resolvedAt: row.resolved_at ? row.resolved_at.toISOString() : null,
  };
}

/** Crea un intento pendiente con la foto del paquete vigente (cantidad y precio) y proveedor «simulated». */
export async function createPackPurchase(db: Database, userId: string, now: Date): Promise<PlayPayment> {
  const [row] = await db.query<PaymentRow>(
    `INSERT INTO play_payments (user_id, plays, price, provider, created_at)
     SELECT $1::uuid,
            COALESCE((SELECT pack_plays FROM play_settings), $3::int),
            COALESCE((SELECT pack_price FROM play_settings), $4::int),
            $5::text,
            $2::timestamptz
     RETURNING ${COLUMNS}`,
    [userId, now, DEFAULT_PLAY_SETTINGS.packPlays, DEFAULT_PLAY_SETTINGS.packPrice, SIMULATED_PROVIDER],
  );
  return toPayment(row!);
}

export type ResolveResult =
  /** Se resolvió ahora (y, si se aprobó, se sumaron las jugadas). */
  | { kind: 'resolved'; payment: PlayPayment }
  /** Ya estaba resuelto con el mismo resultado: no se suma nada de nuevo. */
  | { kind: 'already'; payment: PlayPayment }
  /** Ya estaba resuelto con otro resultado: no se puede cambiar. */
  | { kind: 'conflict'; payment: PlayPayment }
  /** No existe, o es de otro jugador. */
  | { kind: 'not_found' };

/**
 * Aprueba o rechaza un intento del jugador, **una sola vez**. Es una sola sentencia porque no hay transacciones: el
 * `status = 'pending'` del `WHERE` hace que solo un pedido lo resuelva, y las jugadas se suman en la misma sentencia
 * únicamente si ese pedido ganó. Un intento de otro jugador no se encuentra por el filtro de `user_id`.
 */
export async function resolvePackPurchase(
  db: Database,
  userId: string,
  paymentId: string,
  outcome: 'approved' | 'rejected',
  now: Date,
): Promise<ResolveResult> {
  const [won] = await db.query<PaymentRow>(
    `WITH resolved AS (
       UPDATE play_payments SET status = $3::text, resolved_at = $4::timestamptz
        WHERE id = $1::uuid AND user_id = $2::uuid AND status = 'pending'
        RETURNING ${COLUMNS}
     ), credit AS (
       UPDATE users SET extra_plays = extra_plays + (SELECT plays FROM resolved)
        WHERE id = $2::uuid AND $3::text = 'approved' AND EXISTS (SELECT 1 FROM resolved)
        RETURNING id
     )
     SELECT ${COLUMNS} FROM resolved`,
    [paymentId, userId, outcome, now],
  );
  if (won) return { kind: 'resolved', payment: toPayment(won) };

  const [existing] = await db.query<PaymentRow>(
    `SELECT ${COLUMNS} FROM play_payments WHERE id = $1::uuid AND user_id = $2::uuid`,
    [paymentId, userId],
  );
  if (!existing) return { kind: 'not_found' };
  return { kind: existing.status === outcome ? 'already' : 'conflict', payment: toPayment(existing) };
}
