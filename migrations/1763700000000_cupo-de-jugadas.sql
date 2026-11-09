-- Up Migration

-- Reglas comerciales de las jugadas guardadas. Siempre una sola fila (igual que site_settings): el CHECK (id) con la
-- clave primaria impide una segunda. Los rangos los repite la base, además de la validación de la API.
--   free_quota: jugadas guardadas que cada jugador puede tener gratis (200 = el tope fijo de antes).
--   pack_plays / pack_price: el paquete de jugadas extra que se puede comprar al llegar al cupo, con su precio en
--   pesos argentinos enteros (sin centavos).
CREATE TABLE play_settings (
  id boolean PRIMARY KEY DEFAULT true CONSTRAINT play_settings_single_row CHECK (id),
  free_quota integer NOT NULL DEFAULT 200 CONSTRAINT play_settings_free_quota_check CHECK (free_quota BETWEEN 0 AND 10000),
  pack_plays integer NOT NULL DEFAULT 5 CONSTRAINT play_settings_pack_plays_check CHECK (pack_plays BETWEEN 1 AND 1000),
  pack_price integer NOT NULL DEFAULT 2000 CONSTRAINT play_settings_pack_price_check CHECK (pack_price BETWEEN 1 AND 1000000),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO play_settings DEFAULT VALUES;

-- Jugadas extra de cada jugador, sumadas a su cupo gratuito: las otorga el superadmin y las suman las compras.
ALTER TABLE users
  ADD COLUMN extra_plays integer NOT NULL DEFAULT 0 CONSTRAINT users_extra_plays_check CHECK (extra_plays >= 0);

-- Intentos de compra del paquete. Guardan la foto del paquete (cantidad y precio) al iniciar el intento, para que un
-- cambio posterior del precio no los modifique. Hoy el proveedor es siempre 'simulated' (pago de demostración, no se
-- cobra nada); un proveedor real se enchufa cambiando este valor. Un intento se resuelve una sola vez.
CREATE TABLE play_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  plays integer NOT NULL CONSTRAINT play_payments_plays_check CHECK (plays > 0),
  price integer NOT NULL CONSTRAINT play_payments_price_check CHECK (price > 0),
  status text NOT NULL DEFAULT 'pending' CONSTRAINT play_payments_status_check CHECK (status IN ('pending', 'approved', 'rejected')),
  provider text NOT NULL DEFAULT 'simulated' CONSTRAINT play_payments_provider_check CHECK (char_length(provider) BETWEEN 1 AND 40),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  -- Un intento pendiente no tiene fecha de resolución y uno resuelto sí.
  CONSTRAINT play_payments_resolved_check CHECK ((status = 'pending') = (resolved_at IS NULL))
);
CREATE INDEX play_payments_user_created_idx ON play_payments (user_id, created_at DESC);

-- El cupo se garantiza en la base. Un INSERT ... WHERE count < cupo cuenta con la instantánea con la que empezó la
-- sentencia, así que dos altas simultáneas ven el mismo conteo y ambas entran (se pasaba del cupo por una jugada).
-- Acá, un candado por jugador hace que las altas se turnen, y las consultas de una función plpgsql toman una instantánea
-- nueva cada una, de modo que la segunda cuenta lo que dejó la primera. El cupo es el gratuito más las jugadas extra.
CREATE FUNCTION enforce_play_quota() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  quota integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.user_id::text, 0));
  SELECT COALESCE((SELECT free_quota FROM play_settings), 200) + u.extra_plays INTO quota
    FROM users u WHERE u.id = NEW.user_id;
  IF (SELECT count(*) FROM plays WHERE user_id = NEW.user_id) >= quota THEN
    RAISE EXCEPTION 'El jugador ya tiene % jugadas guardadas, su cupo.', quota
      USING ERRCODE = 'check_violation', CONSTRAINT = 'plays_quota_check';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER plays_quota_trigger BEFORE INSERT ON plays FOR EACH ROW EXECUTE FUNCTION enforce_play_quota();

-- Down Migration

DROP TRIGGER plays_quota_trigger ON plays;
DROP FUNCTION enforce_play_quota();
DROP TABLE play_payments;
ALTER TABLE users DROP CONSTRAINT users_extra_plays_check, DROP COLUMN extra_plays;
DROP TABLE play_settings;
