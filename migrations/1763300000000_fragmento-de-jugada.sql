-- Up Migration

-- El fragmento de una jugada: inicio y fin en segundos del video. Nulo en las jugadas en vivo (no hay grabación).
ALTER TABLE plays ADD COLUMN clip_start_seconds integer;
ALTER TABLE plays ADD COLUMN clip_end_seconds integer;

-- Las jugadas que ya existen (no en vivo) quedan con el fragmento por defecto: 15 s antes y 5 s después del momento marcado.
UPDATE plays
   SET clip_start_seconds = greatest(0, timestamp_seconds - 15),
       clip_end_seconds = timestamp_seconds + 5
 WHERE NOT is_live_moment;

ALTER TABLE plays ADD CONSTRAINT plays_clip_pair_check
  CHECK ((clip_start_seconds IS NULL) = (clip_end_seconds IS NULL));
ALTER TABLE plays ADD CONSTRAINT plays_clip_range_check
  CHECK (clip_start_seconds IS NULL OR (clip_start_seconds >= 0 AND clip_end_seconds - clip_start_seconds BETWEEN 3 AND 120));
ALTER TABLE plays ADD CONSTRAINT plays_clip_contains_mark_check
  CHECK (clip_start_seconds IS NULL OR timestamp_seconds BETWEEN clip_start_seconds AND clip_end_seconds);

-- Down Migration

ALTER TABLE plays DROP CONSTRAINT plays_clip_contains_mark_check;
ALTER TABLE plays DROP CONSTRAINT plays_clip_range_check;
ALTER TABLE plays DROP CONSTRAINT plays_clip_pair_check;
ALTER TABLE plays DROP COLUMN clip_end_seconds;
ALTER TABLE plays DROP COLUMN clip_start_seconds;
