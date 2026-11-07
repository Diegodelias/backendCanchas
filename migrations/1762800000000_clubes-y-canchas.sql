-- Up Migration

-- Clubes: existen en el backend con un identificador legible. Se dan de alta por comando (crear-club).
CREATE TABLE clubs (
  id text PRIMARY KEY CHECK (id ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(id) BETWEEN 3 AND 60),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  zone text NOT NULL CHECK (char_length(zone) >= 1),
  city text NOT NULL CHECK (char_length(city) >= 1),
  address text NOT NULL CHECK (char_length(address) >= 1),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Canchas de un club. No se borran: se desactivan (active = false) y se pueden reactivar.
CREATE TABLE courts (
  id text PRIMARY KEY,
  club_id text NOT NULL REFERENCES clubs (id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  sport text NOT NULL CHECK (sport IN ('Fútbol 5', 'Fútbol 7', 'Fútbol 8', 'Fútbol 11')),
  price integer NOT NULL CHECK (price > 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- El nombre es único dentro del club, sin distinguir mayúsculas.
CREATE UNIQUE INDEX courts_club_name_key ON courts (club_id, lower(name));
CREATE INDEX courts_club_order_idx ON courts (club_id, created_at, id);

-- Datos iniciales: los clubes y canchas de ejemplo, con los mismos ids que usan los partidos, las cámaras
-- y los carteles QR de ejemplo. El precio es el del turno más barato de los datos de ejemplo.
-- El orden del listado es el de alta: se fija con un desfasaje de milisegundos (now() es fijo en la transacción).
INSERT INTO clubs (id, name, zone, city, address, created_at) VALUES
  ('estacion-norte', 'Estación Norte Club', 'Palermo', 'buenos-aires', 'Av. Dorrego 1840, Palermo', now() + 0 * interval '1 millisecond'),
  ('la-cantera-crespo', 'La Cantera Villa Crespo', 'Villa Crespo', 'buenos-aires', 'Camargo 620, Villa Crespo', now() + 1 * interval '1 millisecond'),
  ('polideportivo-belgrano', 'Polideportivo Belgrano', 'Belgrano', 'buenos-aires', 'Juramento 2910, Belgrano', now() + 2 * interval '1 millisecond'),
  ('parque-sur-caballito', 'Complejo Parque Sur', 'Caballito', 'buenos-aires', 'Av. Pedro Goyena 1420, Caballito', now() + 3 * interval '1 millisecond'),
  ('arena-nunez', 'Arena Núñez Deportivo', 'Núñez', 'buenos-aires', 'Campos Salles 2150, Núñez', now() + 4 * interval '1 millisecond'),
  ('terraza-colegiales', 'Terraza Fútbol Colegiales', 'Colegiales', 'buenos-aires', 'Conde 1180, Colegiales', now() + 5 * interval '1 millisecond')
ON CONFLICT (id) DO NOTHING;

INSERT INTO courts (id, club_id, name, sport, price, created_at) VALUES
  ('en-f5-1', 'estacion-norte', 'Cancha 1 · Fútbol 5', 'Fútbol 5', 28000, now() + 1 * interval '1 millisecond'),
  ('en-f7-1', 'estacion-norte', 'Cancha Central · Fútbol 7', 'Fútbol 7', 36000, now() + 2 * interval '1 millisecond'),
  ('lc-f5-a', 'la-cantera-crespo', 'Cancha A · Fútbol 5 Techada', 'Fútbol 5', 26000, now() + 3 * interval '1 millisecond'),
  ('lc-f7-b', 'la-cantera-crespo', 'Cancha B · Fútbol 7 Descubierta', 'Fútbol 7', 38000, now() + 4 * interval '1 millisecond'),
  ('pb-f5-1', 'polideportivo-belgrano', 'Cancha 1 · Fútbol 5 Cubierta', 'Fútbol 5', 31000, now() + 5 * interval '1 millisecond'),
  ('pb-f8-2', 'polideportivo-belgrano', 'Cancha 2 · Fútbol 8', 'Fútbol 8', 44000, now() + 6 * interval '1 millisecond'),
  ('ps-f5-1', 'parque-sur-caballito', 'Cancha 1 · Fútbol 5', 'Fútbol 5', 27000, now() + 7 * interval '1 millisecond'),
  ('ps-f7-1', 'parque-sur-caballito', 'Cancha 2 · Fútbol 7', 'Fútbol 7', 37000, now() + 8 * interval '1 millisecond'),
  ('an-f5', 'arena-nunez', 'Cancha 1 · Fútbol 5', 'Fútbol 5', 30000, now() + 9 * interval '1 millisecond'),
  ('an-f8', 'arena-nunez', 'Cancha 2 · Fútbol 8', 'Fútbol 8', 46000, now() + 10 * interval '1 millisecond'),
  ('an-f11', 'arena-nunez', 'Estadio Principal · Fútbol 11', 'Fútbol 11', 68000, now() + 11 * interval '1 millisecond'),
  ('tc-f5-1', 'terraza-colegiales', 'Cancha 1 · Fútbol 5 Terraza', 'Fútbol 5', 29000, now() + 12 * interval '1 millisecond')
ON CONFLICT (id) DO NOTHING;

-- Un admin solo puede pertenecer a un club que existe. Va después de cargar los clubes iniciales,
-- para que los admins ya creados (con ids de ejemplo) cumplan la restricción.
ALTER TABLE users ADD CONSTRAINT users_club_id_fkey FOREIGN KEY (club_id) REFERENCES clubs (id);

-- Down Migration

ALTER TABLE users DROP CONSTRAINT users_club_id_fkey;
DROP TABLE courts;
DROP TABLE clubs;
