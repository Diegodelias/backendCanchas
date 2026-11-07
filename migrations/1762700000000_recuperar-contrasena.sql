-- Up Migration

-- Los links de acceso del jugador y los de recuperación de contraseña del admin comparten tablas:
-- el comportamiento es el mismo (hash, vencimiento, un solo uso). El propósito los mantiene separados,
-- de modo que un link de un tipo no sirva para el otro y los límites de pedidos sean independientes.
ALTER TABLE login_tokens
  ADD COLUMN purpose text NOT NULL DEFAULT 'access'
  CONSTRAINT login_tokens_purpose_check CHECK (purpose IN ('access', 'password_reset'));

ALTER TABLE link_requests
  ADD COLUMN purpose text NOT NULL DEFAULT 'access'
  CONSTRAINT link_requests_purpose_check CHECK (purpose IN ('access', 'password_reset'));

-- Down Migration

ALTER TABLE link_requests DROP COLUMN purpose;
ALTER TABLE login_tokens DROP COLUMN purpose;
