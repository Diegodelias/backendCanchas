-- Up Migration

-- Usuarios: admins de club (con contraseña y club) y, desde el change 2, jugadores.
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  name text NOT NULL,
  role text NOT NULL CHECK (role IN ('player', 'club_admin')),
  club_id text NULL,
  password_hash text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_club_admin_needs_club_and_password
    CHECK (role <> 'club_admin' OR (club_id IS NOT NULL AND password_hash IS NOT NULL))
);
CREATE UNIQUE INDEX users_email_lower_key ON users (lower(email));

-- Sesiones: se guarda el SHA-256 del token, nunca el token.
CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_user_id_idx ON sessions (user_id);

-- Intentos de ingreso fallidos, para el límite por cuenta y por IP.
CREATE TABLE login_attempts (
  id bigserial PRIMARY KEY,
  email text NOT NULL,
  ip text NOT NULL,
  attempted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_attempts_email_idx ON login_attempts (lower(email), attempted_at);
CREATE INDEX login_attempts_ip_idx ON login_attempts (ip, attempted_at);

-- Down Migration

DROP TABLE login_attempts;
DROP TABLE sessions;
DROP TABLE users;
