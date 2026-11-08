-- Up Migration

-- Grabaciones de partidos: un registro por turno grabado (cancha + inicio). Guardan el NOMBRE del archivo de video,
-- no una dirección: la API lo sirve desde la carpeta configurada (VIDEOS_DIR). No llevan título, marcador ni torneo.
-- El inicio no tiene que ser en punto: la grabación empieza cuando arranca la cámara.
CREATE TABLE recordings (
  id text PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 100),
  court_id text NOT NULL REFERENCES courts (id) ON DELETE CASCADE,
  starts_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('available', 'processing', 'unavailable', 'error')),
  video_file text CHECK (video_file ~ '^[A-Za-z0-9][A-Za-z0-9._-]*\.mp4$' AND char_length(video_file) <= 120),
  duration_seconds integer NOT NULL DEFAULT 0 CHECK (duration_seconds >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Una grabación disponible siempre tiene video.
  CONSTRAINT recordings_available_needs_video_check CHECK (status <> 'available' OR video_file IS NOT NULL)
);
-- Una cancha no tiene dos grabaciones con el mismo inicio.
CREATE UNIQUE INDEX recordings_court_start_key ON recordings (court_id, starts_at);
CREATE INDEX recordings_starts_idx ON recordings (starts_at DESC);

-- Down Migration

DROP TABLE recordings;
