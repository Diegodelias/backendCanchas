import { copyFileSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createPgDatabase, type Database } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { DEMO_RECORDINGS, DEMO_VIDEO_FILE, DemoLoadError, loadDemoRecordings } from '../src/modules/recordings/demo.js';
import { requireTestDatabaseUrl } from './helpers.js';

interface Row {
  id: string;
  court_id: string;
  starts_at: Date;
  status: string;
  video_file: string | null;
  duration_seconds: number;
}

// 2026-03-10 09:00 en Argentina: hoy es el 10 de marzo.
const NOW = new Date('2026-03-10T12:00:00Z');

describe('comando de grabaciones de demostración', () => {
  let db: Database;
  let base: string;
  let videos: string;

  beforeAll(async () => {
    const url = requireTestDatabaseUrl();
    await runMigrations(url);
    db = createPgDatabase(url);
    base = mkdtempSync(path.join(tmpdir(), 'canchas3-demo-'));
    videos = path.join(base, 'videos');
    mkdirSync(videos);
    writeFileSync(path.join(videos, DEMO_VIDEO_FILE), 'video de prueba');
  });
  afterAll(async () => {
    await db?.close();
    rmSync(base, { recursive: true, force: true });
  });
  afterEach(async () => {
    await db.query(`DELETE FROM recordings`);
    await db.query(`UPDATE courts SET deleted_at = NULL WHERE id = 'an-f5'`);
  });

  const rows = () => db.query<Row>(`SELECT id, court_id, starts_at, status, video_file, duration_seconds FROM recordings ORDER BY id`);
  const byId = async () => new Map((await rows()).map((r) => [r.id, r]));

  it('carga las 7 grabaciones de ejemplo en los 3 días anteriores a hoy, con los ids de siempre para ayer', async () => {
    const result = await loadDemoRecordings(db, videos, NOW);
    expect(result).toEqual({ loaded: 21, missingCourts: [], skippedExisting: 0 });

    const all = await byId();
    expect(all.size).toBe(21);
    for (const demo of DEMO_RECORDINGS) {
      expect(all.has(demo.id), demo.id).toBe(true);
      expect(all.has(`${demo.id}-d2`)).toBe(true);
      expect(all.has(`${demo.id}-d3`)).toBe(true);
    }
    // Ayer (9 de marzo), anteayer y un día más: hora de Argentina, también la de media hora.
    expect(all.get('match-en-f5-1900')!.starts_at.toISOString()).toBe('2026-03-09T22:00:00.000Z');
    expect(all.get('match-en-f5-1900-d2')!.starts_at.toISOString()).toBe('2026-03-08T22:00:00.000Z');
    expect(all.get('match-en-f5-1900-d3')!.starts_at.toISOString()).toBe('2026-03-07T22:00:00.000Z');
    expect(all.get('match-pb-f5-1730')!.starts_at.toISOString()).toBe('2026-03-09T20:30:00.000Z');
    expect([...all.values()].every((r) => r.starts_at < NOW)).toBe(true); // ninguna empieza en el futuro
  });

  it('respeta los estados de ejemplo: disponibles con video, una en proceso y una sin cámara sin video', async () => {
    await loadDemoRecordings(db, videos, NOW);
    const all = await byId();
    expect(all.get('match-en-f5-1900')).toMatchObject({ status: 'available', video_file: DEMO_VIDEO_FILE, duration_seconds: 60 });
    expect(all.get('match-en-f7-2000')).toMatchObject({ status: 'processing', video_file: null });
    expect(all.get('match-an-f5-1900')).toMatchObject({ status: 'unavailable', video_file: null });
    const statuses = (await rows()).filter((r) => !r.id.includes('-d')).map((r) => r.status).sort();
    expect(statuses).toEqual(['available', 'available', 'available', 'available', 'available', 'processing', 'unavailable']);
  });

  it('volver a correrlo renueva las fechas sin duplicar nada', async () => {
    await loadDemoRecordings(db, videos, NOW);
    const idsBefore = (await rows()).map((r) => r.id);

    const later = new Date(NOW.getTime() + 2 * 24 * 60 * 60 * 1000); // dos días después
    const result = await loadDemoRecordings(db, videos, later);
    expect(result.loaded).toBe(21);
    expect((await rows()).map((r) => r.id)).toEqual(idsBefore);
    expect((await byId()).get('match-en-f5-1900')!.starts_at.toISOString()).toBe('2026-03-11T22:00:00.000Z');
  });

  it('sin el archivo de demostración avisa qué falta y no carga nada', async () => {
    const empty = path.join(base, 'vacia');
    mkdirSync(empty);
    await expect(loadDemoRecordings(db, empty, NOW)).rejects.toThrow(DemoLoadError);
    await expect(loadDemoRecordings(db, empty, NOW)).rejects.toThrow(/demo-partido\.mp4/);
    expect(await rows()).toHaveLength(0);
  });

  it('omite con aviso una cancha de demostración que no existe', async () => {
    await db.query(`UPDATE courts SET deleted_at = now() WHERE id = 'an-f5'`);
    const result = await loadDemoRecordings(db, videos, NOW);
    expect(result).toEqual({ loaded: 18, missingCourts: ['an-f5'], skippedExisting: 0 });
    expect((await byId()).has('match-an-f5-1900')).toBe(false);
  });

  it('no pisa una grabación real que ya ocupa el turno', async () => {
    await db.query(
      `INSERT INTO recordings (id, court_id, starts_at, status, video_file, duration_seconds)
       VALUES ('real-1', 'en-f5-1', '2026-03-09T19:00:00-03:00', 'available', 'otro.mp4', 1800)`,
    );
    const result = await loadDemoRecordings(db, videos, NOW);
    expect(result).toMatchObject({ loaded: 20, skippedExisting: 1 });
    const all = await byId();
    expect(all.get('real-1')).toMatchObject({ video_file: 'otro.mp4', duration_seconds: 1800 });
    expect(all.has('match-en-f5-1900')).toBe(false);
  });

  it('el archivo de demostración del repositorio existe', () => {
    const repoVideo = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '../videos', DEMO_VIDEO_FILE);
    expect(() => copyFileSync(repoVideo, path.join(base, 'copia.mp4'))).not.toThrow();
  });
});
