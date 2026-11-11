import { describe, expect, it } from 'vitest';
import { SpawnLauncher, STOP_GRACE_MS, type FfmpegProcess } from '../src/modules/live/launcher.js';
import { sleep, waitFor } from './helpers.js';

// En Windows `SIGTERM` termina el proceso a la fuerza y no se puede atender ni ignorar: los casos que dependen de eso
// solo corren en Linux (donde corre el backend, en Docker).
const onlyLinux = process.platform === 'win32';

/** Un "ffmpeg" de prueba: node ejecutando un script que avisa cuando ya está listo para recibir señales. */
function launch(script: string, graceMs: number): { proc: FfmpegProcess; out: () => string; code: () => number | null | undefined } {
  const launcher = new SpawnLauncher(process.execPath, graceMs);
  const proc = launcher.launch(['-e', script]);
  let out = '';
  let code: number | null | undefined;
  proc.stdout.on('data', (c: Buffer) => (out += c.toString()));
  proc.onClose((c) => (code = c));
  proc.onError(() => {});
  return { proc, out: () => out, code: () => code };
}

const READY = `process.stdout.write('ready\\n'); setInterval(() => {}, 1000);`;
const COOPERATIVE = `process.on('SIGTERM', () => { process.stdout.write('term\\n'); process.exit(0); }); ${READY}`;
const STUBBORN = `process.on('SIGTERM', () => { process.stdout.write('term\\n'); }); ${READY}`;

describe('SpawnLauncher: cierre ordenado', () => {
  it('el plazo del respaldo es de 3 segundos', () => {
    expect(STOP_GRACE_MS).toBe(3000);
  });

  it.skipIf(onlyLinux)('un proceso que atiende la señal termina por sí mismo, mucho antes del respaldo', async () => {
    const p = launch(COOPERATIVE, 5000);
    await waitFor(() => p.out().includes('ready'));
    const start = Date.now();
    p.proc.kill();
    await p.proc.closed;
    expect(Date.now() - start).toBeLessThan(2000); // no esperó al respaldo de 5 s
    expect(p.out()).toContain('term'); // atendió SIGTERM
    expect(p.code()).toBe(0);
  });

  it.skipIf(onlyLinux)('un proceso que ignora la señal sigue vivo hasta que el respaldo lo termina a la fuerza', async () => {
    const p = launch(STUBBORN, 700);
    await waitFor(() => p.out().includes('ready'));
    const start = Date.now();
    p.proc.kill();

    let closed = false;
    void p.proc.closed.then(() => (closed = true));
    await sleep(300);
    expect(closed).toBe(false); // ignoró SIGTERM y todavía no venció el plazo
    expect(p.out()).toContain('term');

    await p.proc.closed;
    expect(Date.now() - start).toBeGreaterThanOrEqual(600); // terminó por el respaldo
    expect(p.code()).toBeNull(); // muerto por señal
  });

  it.skipIf(onlyLinux)('detener dos veces no envía otra señal', async () => {
    const p = launch(STUBBORN, 700);
    await waitFor(() => p.out().includes('ready'));
    p.proc.kill();
    p.proc.kill();
    await sleep(200);
    p.proc.kill();
    await p.proc.closed;
    expect(p.out().match(/term/g)).toHaveLength(1); // una sola SIGTERM
  });

  it('detener dos veces y después del cierre no falla, y `closed` se resuelve', async () => {
    const p = launch(COOPERATIVE, 500);
    await waitFor(() => p.out().includes('ready'));
    p.proc.kill();
    p.proc.kill();
    await p.proc.closed;
    p.proc.kill(); // ya cerró: no hace nada
    await expect(p.proc.closed).resolves.toBeUndefined();
  });

  it('si el proceso no puede arrancar, `closed` se resuelve igual', async () => {
    const proc = new SpawnLauncher('canchas3-no-existe-xyz', 500).launch([]);
    proc.onError(() => {});
    await expect(proc.closed).resolves.toBeUndefined();
    proc.kill(); // no falla
  });
});
