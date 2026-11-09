-- Up Migration

-- Configuración del sitio. Hoy es un solo dato (el nombre) y siempre una sola fila: el CHECK (id) con la clave
-- primaria impide una segunda. Las reglas del nombre las repite la base (1 a 40 caracteres, sin espacios al borde
-- ni saltos de línea), además de la validación de la API.
CREATE TABLE site_settings (
  id boolean PRIMARY KEY DEFAULT true CONSTRAINT site_settings_single_row CHECK (id),
  name text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT site_settings_name_check CHECK (
    char_length(name) BETWEEN 1 AND 40 AND name = btrim(name) AND name !~ '[\r\n]'
  )
);

INSERT INTO site_settings (name) VALUES ('Canchas3');

-- Down Migration

DROP TABLE site_settings;
