import {
  watch,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  existsSync,
  type FSWatcher,
} from 'node:fs';
import { dirname, basename } from 'node:path';
import { Conductor, type ConductorOptions } from './conductor';
import { parseCommand } from './command';
import type { Sink } from '../audio/sink';

export interface DaemonOptions extends ConductorOptions {
  /** Watched command file the hook writes tier changes to. */
  commandPath: string;
  /** Optional pidfile written on start and removed on stop. */
  pidPath?: string;
  /** Drive rendering on an internal timer. Default `true`; tests pass `false` and call {@link ConductDaemon.renderBlock}. */
  autoRender?: boolean;
}

/**
 * The persistent process (CC-5): loads stems once, watches the command file, and
 * crossfades toward each new tier. `start()`/`stop()` are what CC-6 will wire to
 * `SessionStart`/`SessionEnd`. Every filesystem touch is best-effort so the
 * daemon never throws into the process that started it.
 */
export class ConductDaemon {
  private readonly conductor: Conductor;
  private readonly opts: DaemonOptions;
  private watcher: FSWatcher | undefined;
  private pumping = false;
  private running = false;

  constructor(stems: Float32Array[], sink: Sink, opts: DaemonOptions) {
    this.opts = opts;
    this.conductor = new Conductor(stems, sink, opts);
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Current mixer target gains — for introspection and tests. */
  get targets(): number[] {
    return this.conductor.mixer.getTargets();
  }

  /** Current master volume `0..1` — for introspection and tests. */
  get volume(): number {
    return this.conductor.mixer.getMasterGain();
  }

  /** Idempotent start: apply any existing command, begin watching, write the pidfile, start rendering. */
  start(): void {
    if (this.running) return;
    this.running = true;

    try {
      mkdirSync(dirname(this.opts.commandPath), { recursive: true });
    } catch {
      /* best-effort */
    }

    this.refresh(); // honor a tier that was already written before we started

    try {
      const targetName = basename(this.opts.commandPath);
      this.watcher = watch(dirname(this.opts.commandPath), (_event, filename) => {
        // Watch the directory (not the file) so atomic rename-based writes are seen.
        if (!filename || filename.toString() === targetName) this.refresh();
      });
    } catch {
      /* watching is best-effort; SessionStart can still push an initial tier */
    }

    if (this.opts.pidPath) {
      try {
        writeFileSync(this.opts.pidPath, `${process.pid}\n`);
      } catch {
        /* best-effort */
      }
    }

    if (this.opts.autoRender !== false) this.startPump();
  }

  /**
   * Continuously feed the sink using backpressure: write blocks until the sink
   * says it's full, then wait for `drain`. This keeps the audio device buffer
   * topped up so event-loop jitter can't starve it (the cause of underrun
   * clicks) — no fixed-interval timer. A write-ahead cap bounds how far ahead we
   * render if a sink applies weak/no backpressure.
   */
  private startPump(): void {
    if (this.pumping) return;
    this.pumping = true;

    const blockMs = (this.conductor.blockFrames / this.conductor.mixer.sampleRate) * 1000;
    const maxAhead = Math.max(4, Math.ceil(1000 / Math.max(1, blockMs))); // ~1s of blocks

    const loop = async (): Promise<void> => {
      while (this.running && this.pumping) {
        let more = true;
        let wrote = 0;
        while (this.running && this.pumping && more && wrote < maxAhead) {
          try {
            more = this.conductor.writeBlock();
          } catch {
            more = false; // a bad render must not kill the daemon
          }
          wrote += 1;
        }
        if (!this.running || !this.pumping) break;
        if (!more) {
          try {
            await this.conductor.drain();
          } catch {
            break;
          }
        } else {
          // Sink took everything without backpressure — pace so we don't run away.
          await new Promise<void>((resolve) => setTimeout(resolve, Math.max(1, Math.round(blockMs))));
        }
      }
    };

    void loop();
  }

  /** Render one block manually (used when `autoRender` is disabled). */
  renderBlock(): void {
    this.conductor.renderBlock();
  }

  /** Re-read the command file and apply its tier and/or volume, if valid. */
  refresh(): void {
    try {
      const command = parseCommand(readFileSync(this.opts.commandPath, 'utf8'));
      if (!command) return;
      if (command.tier) this.conductor.setTier(command.tier);
      if (command.volume !== undefined) this.conductor.setVolume(command.volume);
    } catch {
      /* file may not exist yet */
    }
  }

  /** Idempotent clean shutdown: stop rendering/watching, release the sink, remove the pidfile. */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.pumping = false; // the pump loop checks these flags and exits

    if (this.watcher) {
      try {
        this.watcher.close();
      } catch {
        /* best-effort */
      }
      this.watcher = undefined;
    }

    this.conductor.close();

    if (this.opts.pidPath && existsSync(this.opts.pidPath)) {
      try {
        unlinkSync(this.opts.pidPath);
      } catch {
        /* best-effort */
      }
    }
  }
}
