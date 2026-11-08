export type Role = 'player' | 'club_admin' | 'superadmin';

/** Lo que la API devuelve del usuario con sesión. */
export interface SessionUser {
  id: string;
  email: string;
  /** null en los jugadores, que se crean solo con el mail. */
  name: string | null;
  role: Role;
  clubId: string | null;
}

export interface UserRow {
  id: string;
  email: string;
  name: string | null;
  role: Role;
  club_id: string | null;
  password_hash: string | null;
}

export function toSessionUser(row: UserRow): SessionUser {
  return { id: row.id, email: row.email, name: row.name, role: row.role, clubId: row.club_id };
}
