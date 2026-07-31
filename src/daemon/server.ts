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
import { heartbeatAgeMs } from '../hook/heartbeat';
import type { Sink } from '../audio/sink';

export interface DaemonOptions extends ConductorOptions {
  /** Watched command file the hook writes tier changes to. */
  commandPath: string;
  /** Optional pidfile written on start and removed on stop. */
  pidPath?: string;
  /** Drive rendering on an internal timer. Default `true`; tests pass `false` and call {@link ConductDaemon.renderBlock}. */
  autoRender?: boolean;
  /** Liveness marker the hook touches each turn. Required for the idle watchdog. */
  heartbeatPath?: string;
  /** Exit after this long with no heartbeat. `0`/unset disables the watchdog. */
  idleTimeoutMs?: number;
  /** Called when the watchdog expires — the entrypoint shuts the process down. */
  onIdle?: () => void;
  /** Poll the watchdog on a timer. Default `true`; tests pass `false` and call {@link ConductDaemon.isIdle}. */
  autoWatchdog?: boolean;
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
  private idleTimer: ReturnType<typeof setInterval> | undefined;
  private startedAt = 0;
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
    this.startedAt = Date.now();

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
    if (this.opts.autoWatchdog !== false) this.startWatchdog();
  }

  /**
   * Poll the heartbeat and fire `onIdle` once it goes stale. The check period is
   * a quarter of the timeout (clamped to 1–30s) so expiry is detected promptly
   * without spinning: the watchdog exists to bound how long an orphaned daemon
   * can play, not to stop it on the exact second.
   */
  private startWatchdog(): void {
    const timeout = this.opts.idleTimeoutMs ?? 0;
    if (timeout <= 0 || !this.opts.heartbeatPath) return;

    const period = Math.max(1_000, Math.min(30_000, Math.floor(timeout / 4)));
    this.idleTimer = setInterval(() => {
      if (this.isIdle()) this.opts.onIdle?.();
    }, period);
    // Don't hold the event loop open on the watchdog alone — the render pump is
    // what should keep this process alive.
    this.idleTimer.unref?.();
  }

  /**
   * Has the owning session stopped heartbeating for longer than the timeout?
   *
   * A missing heartbeat falls back to the daemon's own start time rather than
   * counting as infinitely old, and a heartbeat older than our start time is
   * treated as our start time. Both cases are the same situation — a daemon
   * launched by `/conduct start` before the session's next hook fires — and both
   * must give it a full timeout window to see a fresh stamp.
   */
  isIdle(now: number = Date.now()): boolean {
    const timeout = this.opts.idleTimeoutMs ?? 0;
    if (timeout <= 0 || !this.opts.heartbeatPath) return false;

    const age = heartbeatAgeMs(this.opts.heartbeatPath, now);
    const lastSeen = age === null ? this.startedAt : Math.max(now - age, this.startedAt);
    return now - lastSeen >= timeout;
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

    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = undefined;
    }

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
