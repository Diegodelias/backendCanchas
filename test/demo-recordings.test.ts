import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createPgDatabase, type Database } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { DEMO_CLIPS, DEMO_RECORDINGS, DemoLoadError, loadDemoRecordings } from '../src/modules/recordings/demo.js';
import { VIDEO_FILE_PATTERN } from '../src/modules/recordings/videos.js';
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
    for (const clip of Object.values(DEMO_CLIPS)) writeFileSync(path.join(videos, clip.file), 'video de prueba');
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

  it('respeta los estados de ejemplo: disponibles con su clip, una en proceso y una sin cámara sin video', async () => {
    await loadDemoRecordings(db, videos, NOW);
    const all = await byId();
    expect(all.get('match-en-f5-1900')).toMatchObject({ status: 'available', video_file: DEMO_CLIPS['exterior-1'].file });
    expect(all.get('match-en-f7-2000')).toMatchObject({ status: 'processing', video_file: null, duration_seconds: 0 });
    expect(all.get('match-an-f5-1900')).toMatchObject({ status: 'unavailable', video_file: null, duration_seconds: 0 });
    const statuses = (await rows()).filter((r) => !r.id.includes('-d')).map((r) => r.status).sort();
    expect(statuses).toEqual(['available', 'available', 'available', 'available', 'available', 'processing', 'unavailable']);
  });

  it('cada cancha usa su clip, siempre el mismo en los 3 días, y las dos cubiertas comparten el de cancha cubierta', async () => {
    await loadDemoRecordings(db, videos, NOW);
    const available = (await rows()).filter((r) => r.status === 'available');
    expect(available).toHaveLength(15);

    const clipByCourt = new Map<string, Set<string | null>>();
    for (const r of available) clipByCourt.set(r.court_id, (clipByCourt.get(r.court_id) ?? new Set()).add(r.video_file));
    // Un solo clip por cancha, en todos sus horarios y días.
    for (const [court, clips] of clipByCourt) expect(clips.size, court).toBe(1);

    const clipOf = (court: string) => [...clipByCourt.get(court)!][0];
    expect(clipOf('en-f5-1')).toBe('demo-exterior-1.mp4');
    expect(clipOf('tc-f5-1')).toBe('demo-exterior-2.mp4');
    expect(clipOf('lc-f5-a')).toBe('demo-cubierta.mp4');
    expect(clipOf('pb-f5-1')).toBe('demo-cubierta.mp4');
  });

  it('guarda la duración real de cada clip y no un valor fijo', async () => {
    await loadDemoRecordings(db, videos, NOW);
    const all = await byId();
    expect(all.get('match-en-f5-1900')!.duration_seconds).toBe(643);
    expect(all.get('match-en-f5-1800-d3')!.duration_seconds).toBe(643);
    expect(all.get('match-tc-f5-1800-d2')!.duration_seconds).toBe(792);
    expect(all.get('match-lc-f5-1900')!.duration_seconds).toBe(813);
    expect(all.get('match-pb-f5-1730-d3')!.duration_seconds).toBe(813);
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

  it('si falta algún clip avisa cuáles faltan, todos juntos, y no carga ni borra nada', async () => {
    const empty = path.join(base, 'vacia');
    mkdirSync(empty);
    await expect(loadDemoRecordings(db, empty, NOW)).rejects.toThrow(DemoLoadError);
    const error = await loadDemoRecordings(db, empty, NOW).catch((e: Error) => e);
    for (const clip of Object.values(DEMO_CLIPS)) expect((error as Error).message).toContain(clip.file);
    expect(await rows()).toHaveLength(0);

    // Con uno solo de los tres faltando, avisa solo ese y deja intactas las grabaciones ya cargadas.
    await loadDemoRecordings(db, videos, NOW);
    const partial = path.join(base, 'parcial');
    mkdirSync(partial);
    for (const clip of [DEMO_CLIPS['exterior-1'], DEMO_CLIPS['exterior-2']]) writeFileSync(path.join(partial, clip.file), 'x');
    const before = (await rows()).length;
    const err = await loadDemoRecordings(db, partial, NOW).catch((e: Error) => e);
    expect((err as Error).message).toContain('demo-cubierta.mp4');
    expect((err as Error).message).not.toContain('demo-exterior');
    expect(await rows()).toHaveLength(before);
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

  it('los nombres de los clips cumplen el formato que exige la base y son distintos entre sí', () => {
    const files = Object.values(DEMO_CLIPS).map((clip) => clip.file);
    for (const file of files) expect(VIDEO_FILE_PATTERN.test(file), file).toBe(true);
    expect(new Set(files).size).toBe(files.length);
  });
});
