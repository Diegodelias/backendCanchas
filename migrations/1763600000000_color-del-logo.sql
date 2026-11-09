-- Up Migration

-- Color del logo: la clave de una paleta cerrada que vive en el frontend (no un valor hex). NULL es «Predeterminado».
ALTER TABLE site_settings
  ADD COLUMN logo_color text,
  ADD CONSTRAINT site_settings_logo_color_check CHECK (
    logo_color IS NULL OR logo_color IN ('verde', 'azul', 'rojo', 'naranja', 'violeta', 'tinta')
  );

-- Down Migration

ALTER TABLE site_settings
  DROP CONSTRAINT site_settings_logo_color_check,
  DROP COLUMN logo_color;
