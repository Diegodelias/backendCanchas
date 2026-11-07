import { z } from 'zod';
import type { Database } from '../../db/client.js';
import { hashPassword, MIN_PASSWORD_LENGTH } from './passwords.js';
import { toSessionUser, type SessionUser, type UserRow } from './types.js';

/** Error de datos al crear un admin: no se creó nada. */
export class AdminInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdminInputError';
  }
}

export interface NewAdmin {
  email: string;
  name: string;
  clubId: string;
  password: string;
}

const emailSchema = z.email();

async function clubExists(db: Database, clubId: string): Promise<boolean> {
  const rows = await db.query(`SELECT 1 FROM clubs WHERE id = $1`, [clubId]);
  return rows.length > 0;
}

/** Error de club inexistente, con los ids de los clubes que sí existen. */
async function unknownClub(db: Database, clubId: string): Promise<AdminInputError> {
  const valid = await db.query<{ id: string }>(`SELECT id FROM clubs ORDER BY created_at, id`);
  const list = valid.length > 0 ? valid.map((c) => c.id).join(', ') : '(todavía no hay clubes: creá uno con crear-club)';
  return new AdminInputError(`El club «${clubId}» no existe. Clubes válidos: ${list}.`);
}

export async function createAdmin(db: Database, input: NewAdmin): Promise<SessionUser> {
  const email = input.email.trim();
  const name = input.name.trim();
  const clubId = input.clubId.trim();

  if (!emailSchema.safeParse(email).success) {
    throw new AdminInputError(`El mail «${email}» no tiene un formato válido.`);
  }
  if (!name) throw new AdminInputError('Falta el nombre del admin.');
  if (!(await clubExists(db, clubId))) throw await unknownClub(db, clubId);
  if (input.password.length < MIN_PASSWORD_LENGTH) {
    throw new AdminInputError(`La contraseña debe tener ${MIN_PASSWORD_LENGTH} caracteres o más.`);
  }

  const existing = await db.query(`SELECT 1 FROM users WHERE lower(email) = lower($1)`, [email]);
  if (existing.length > 0) throw new AdminInputError(`Ya existe un usuario con el mail ${email}.`);

  const passwordHash = await hashPassword(input.password);
  try {
    const [row] = await db.query<UserRow>(
      `INSERT INTO users (email, name, role, club_id, password_hash)
       VALUES ($1, $2, 'club_admin', $3, $4)
       RETURNING id, email, name, role, club_id, password_hash`,
      [email, name, clubId, passwordHash],
    );
    return toSessionUser(row!);
  } catch (err) {
    const code = (err as { code?: string }).code;
    // Otro alta con el mismo mail pudo entrar entre la consulta y el insert.
    if (code === '23505') throw new AdminInputError(`Ya existe un usuario con el mail ${email}.`);
    // La clave foránea es la red de seguridad: el club dejó de existir entre la consulta y el insert.
    if (code === '23503') throw await unknownClub(db, clubId);
    throw err;
  }
}
