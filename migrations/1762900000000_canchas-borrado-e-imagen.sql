-- Up Migration

-- Borrado lógico de canchas: una cancha borrada no se ve ni se edita, pero su fila se conserva
-- para no perder el historial cuando existan las reservas. Distinto de `active` (desactivada, reactivable).
ALTER TABLE courts ADD COLUMN deleted_at timestamptz;

-- Imagen opcional de clubes y canchas. Nadie la carga desde la aplicación; si es nula, el sitio usa la imagen por defecto.
ALTER TABLE clubs ADD COLUMN image_url text CHECK (image_url IS NULL OR char_length(image_url) BETWEEN 1 AND 500);
ALTER TABLE courts ADD COLUMN image_url text CHECK (image_url IS NULL OR char_length(image_url) BETWEEN 1 AND 500);

-- El nombre es único dentro del club solo entre canchas no borradas: así se puede reutilizar el de una borrada.
DROP INDEX courts_club_name_key;
CREATE UNIQUE INDEX courts_club_name_key ON courts (club_id, lower(name)) WHERE deleted_at IS NULL;

-- Down Migration

-- Restaura el índice único completo. Falla si hay dos canchas del mismo club con el mismo nombre
-- porque una está borrada: en ese caso hay que renombrar o eliminar la borrada antes de volver atrás.
DROP INDEX courts_club_name_key;
CREATE UNIQUE INDEX courts_club_name_key ON courts (club_id, lower(name));
ALTER TABLE courts DROP COLUMN image_url;
ALTER TABLE clubs DROP COLUMN image_url;
ALTER TABLE courts DROP COLUMN deleted_at;
