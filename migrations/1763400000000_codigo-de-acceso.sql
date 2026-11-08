-- Up Migration

-- El código de 6 dígitos del mail de acceso vive en la misma fila que el link: usar uno gasta los dos.
-- Los links que ya existen quedan sin código (siguen valiendo con su link).
ALTER TABLE login_tokens ADD COLUMN code_hash text;
ALTER TABLE login_tokens ADD COLUMN code_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE login_tokens ADD CONSTRAINT login_tokens_code_attempts_check CHECK (code_attempts >= 0);

-- Down Migration

ALTER TABLE login_tokens DROP CONSTRAINT login_tokens_code_attempts_check;
ALTER TABLE login_tokens DROP COLUMN code_attempts;
ALTER TABLE login_tokens DROP COLUMN code_hash;
