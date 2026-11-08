-- Up Migration

-- Horario semanal de cada cancha: un rango por día (weekday 1 = lunes ... 7 = domingo), en horas enteras.
-- Un día sin fila es un día cerrado; una cancha sin filas no tiene turnos.
CREATE TABLE court_schedules (
  court_id text NOT NULL REFERENCES courts (id) ON DELETE CASCADE,
  weekday smallint NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  start_hour smallint NOT NULL CHECK (start_hour BETWEEN 0 AND 23),
  end_hour smallint NOT NULL CHECK (end_hour BETWEEN 1 AND 24),
  PRIMARY KEY (court_id, weekday),
  CONSTRAINT court_schedules_range_check CHECK (end_hour - start_hour >= 1)
);

-- Reservas de turnos de 60 minutos que empiezan en hora en punto. Son un historial: la fila se conserva.
-- Un jugador con sesión queda asociado (player_id); un invitado solo guarda los datos que dio.
CREATE TABLE bookings (
  id text PRIMARY KEY,
  court_id text NOT NULL REFERENCES courts (id) ON DELETE CASCADE,
  starts_at timestamptz NOT NULL,
  price integer NOT NULL CHECK (price > 0),
  player_id uuid REFERENCES users (id) ON DELETE SET NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  email text NOT NULL CHECK (char_length(email) BETWEEN 3 AND 254),
  phone text CHECK (phone IS NULL OR char_length(phone) BETWEEN 6 AND 30),
  created_ip text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Todos los turnos duran lo mismo y empiezan en hora en punto: dos reservas que se solapan tienen el mismo inicio.
  CONSTRAINT bookings_starts_on_the_hour_check CHECK (
    date_part('minute', starts_at AT TIME ZONE 'UTC') = 0 AND date_part('second', starts_at AT TIME ZONE 'UTC') = 0
  )
);
-- Es lo que impide la doble reserva, también entre dos pedidos simultáneos.
CREATE UNIQUE INDEX bookings_court_slot_key ON bookings (court_id, starts_at);
CREATE INDEX bookings_court_starts_idx ON bookings (court_id, starts_at);
CREATE INDEX bookings_ip_created_idx ON bookings (created_ip, created_at);

-- Down Migration

DROP TABLE bookings;
DROP TABLE court_schedules;
