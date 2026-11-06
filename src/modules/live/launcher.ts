import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';

/** Lo mínimo que la API necesita de un proceso de ffmpeg; permite reemplazarlo en las pruebas. */
export interface FfmpegProcess {
  stdout: Readable;
  stderr: Readable;
  onClose(listener: (code: number | null) => void): void;
  onError(listener: (error: Error) => void): void;
  kill(): void;
}

export interface FfmpegLauncher {
  launch(args: string[]): FfmpegProcess;
}

export class SpawnLauncher implements FfmpegLauncher {
  constructor(private readonly ffmpegPath: string) {}

  launch(args: string[]): FfmpegProcess {
    const child = spawn(this.ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    return {
      stdout: child.stdout,
      stderr: child.stderr,
      onClose: (listener) => child.on('close', listener),
      onError: (listener) => child.on('error', listener),
      kill: () => {
        if (!child.killed) child.kill('SIGKILL');
      },
    };
  }
}
