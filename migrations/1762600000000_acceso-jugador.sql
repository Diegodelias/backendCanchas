-- Up Migration

-- El jugador se crea solo con el mail: el nombre pasa a ser opcional.
-- (El check de club_admin no lo exige; los admins lo cargan por el comando.)
ALTER TABLE users ALTER COLUMN name DROP NOT NULL;

-- Links de acceso: se guarda el SHA-256 del identificador, nunca el identificador.
-- Guardan el mail y no un user_id porque la cuenta de un mail nuevo se crea al confirmar.
CREATE TABLE login_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz NULL
);

-- Pedidos de link (se envíe o no un link) para el límite de 3 cada 15 minutos.
CREATE TABLE link_requests (
  id bigserial PRIMARY KEY,
  email text NOT NULL,
  ip text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX link_requests_email_idx ON link_requests (lower(email), requested_at);

-- Jugadas del jugador. El club, la cancha, el horario y el video salen del match_id en el frontend.
CREATE TABLE plays (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  match_id text NOT NULL CHECK (char_length(match_id) BETWEEN 1 AND 100),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  category text NULL CHECK (category IN ('Gol', 'Caño / Galleta', 'Atajada', 'Buena jugada', 'Bloopers', 'Otro')),
  capture_mode text NOT NULL CHECK (capture_mode IN ('video', 'voice_commentary')),
  timestamp_seconds integer NOT NULL CHECK (timestamp_seconds >= 0),
  is_live_moment boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX plays_user_created_idx ON plays (user_id, created_at DESC);

-- Down Migration

DROP TABLE plays;
DROP TABLE link_requests;
DROP TABLE login_tokens;
ALTER TABLE users ALTER COLUMN name SET NOT NULL;
