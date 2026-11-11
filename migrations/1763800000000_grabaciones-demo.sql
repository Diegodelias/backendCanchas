-- Up Migration

-- Marca de las grabaciones de demostración: las que carga el comando `cargar-grabaciones-demo`. El panel del admin de
-- club solo muestra las reales; el resto del sitio (búsqueda, reproductor, jugadas) sigue usando las dos clases.
ALTER TABLE recordings ADD COLUMN is_demo boolean NOT NULL DEFAULT false;

-- Hasta hoy el comando de demostración es el único que crea grabaciones, así que todas las existentes son de demostración.
-- Se actualiza después de agregar la columna para que las filas futuras que no vengan del comando queden en `false`.
UPDATE recordings SET is_demo = true;

-- Down Migration

ALTER TABLE recordings DROP COLUMN is_demo;
