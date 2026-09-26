import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { TranscriptReader } from './events';
import type { RadioEvent, SessionState } from './types';

/**
 * Follows every Claude Code transcript on the machine as it is written.
 *
 * `~/.claude/projects/<project>/<session>.jsonl` is the main thread;
 * `<session>/subagents/agent-*.jsonl` holds each subagent. Both are appended a
 * content block at a time, so tailing them is a sub-second feed of everything
 * every session is doing — no hooks, no install, works for sessions that were
 * already running when the radio started.
 *
 * Polls rather than `fs.watch`, which macOS coalesces and drops under load. A
 * poll of a handful of hot files every 300ms is cheap and cannot miss anything.
 */

export interface WatcherOptions {
  /** Usually `~/.claude/projects`. */
  root: string;
  onEvent: (event: RadioEvent) => void;
  /** A main-thread session became active (started, or woke up). */
  onSession?: (state: SessionState) => void;
  /** Files written within this window are followed. Default 30 minutes. */
  hotMs?: number;
  /** How often to look for new files. Default 3s. */
  scanMs?: number;
  /** How often to read hot files. Default 300ms. */
  pollMs?: number;
  /** Largest amount of an existing file read to learn its state. Default 24 MB. */
  primeBytes?: number;
  contextWindows?: Record<string, number>;
  now?: () => number;
}

interface Followed {
  path: string;
  session: string;
  sub: boolean;
  reader: TranscriptReader;
  /** Bytes consumed so far. */
  offset: number;
  /** Bytes of an unfinished last line. */
  partial: Buffer;
  mtime: number;
  /** Existing content has been read for state (silently). */
  primed: boolean;
  /** Has been announced through `onSession`. */
  announced: boolean;
}

const SESSION_FILE = /^[A-Za-z0-9._-]+\.jsonl$/;

/** Every transcript under `root`, with the session it belongs to. */
export function findTranscripts(root: string): Array<{ path: string; session: string; sub: boolean; project: string }> {
  const out: Array<{ path: string; session: string; sub: boolean; project: string }> = [];
  let projects: string[];
  try {
    projects = readdirSync(root);
  } catch {
    return out;
  }
  for (const project of projects) {
    const dir = join(root, project);
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (SESSION_FILE.test(entry)) {
        out.push({ path: join(dir, entry), session: entry.slice(0, -'.jsonl'.length), sub: false, project });
        continue;
      }
      const subDir = join(dir, entry, 'subagents');
      if (!existsSync(subDir)) continue;
      try {
        for (const agent of readdirSync(subDir)) {
          if (SESSION_FILE.test(agent)) out.push({ path: join(subDir, agent), session: entry, sub: true, project });
        }
      } catch {
        /* unreadable subagent dir */
      }
    }
  }
  return out;
}

/** Claude Code's directory name for a project, as a readable fallback name. */
function projectLabel(dirName: string): string {
  const parts = dirName.split('-').filter(Boolean);
  return parts[parts.length - 1] ?? dirName;
}

export class TranscriptWatcher {
  private readonly opts: Required<Omit<WatcherOptions, 'onSession' | 'contextWindows'>> &
    Pick<WatcherOptions, 'onSession' | 'contextWindows'>;
  private readonly files = new Map<string, Followed>();
  private scanTimer: ReturnType<typeof setInterval> | undefined;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private started = false;

  constructor(options: WatcherOptions) {
    this.opts = {
      hotMs: 30 * 60_000,
      scanMs: 3_000,
      pollMs: 300,
      primeBytes: 24 * 1024 * 1024,
      now: Date.now,
      ...options,
    };
  }

  /**
   * Begin following. Files that already exist are *primed* — read silently for
   * their state — so the radio knows where every session is without replaying
   * its history through the speakers.
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.scan(true);
    this.poll();
    this.scanTimer = setInterval(() => this.scan(false), this.opts.scanMs);
    this.pollTimer = setInterval(() => this.poll(), this.opts.pollMs);
    this.scanTimer.unref?.();
    this.pollTimer.unref?.();
  }

  stop(): void {
    if (this.scanTimer) clearInterval(this.scanTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.scanTimer = undefined;
    this.pollTimer = undefined;
    this.started = false;
  }

  /** Main-thread sessions active within the hot window. */
  sessions(): SessionState[] {
    const now = this.opts.now();
    const out: SessionState[] = [];
    for (const f of this.files.values()) {
      if (f.sub || !f.primed) continue;
      if (now - f.reader.state.lastAt <= this.opts.hotMs) out.push({ ...f.reader.state });
    }
    return out.sort((a, b) => b.lastAt - a.lastAt);
  }

  /**
   * Look for transcripts. On the first scan everything is existing history; a
   * file that appears later is a brand-new session and is played from its
   * first line.
   */
  scan(initial = false): void {
    for (const found of findTranscripts(this.opts.root)) {
      if (this.files.has(found.path)) continue;
      let size = 0;
      let mtime = 0;
      try {
        const st = statSync(found.path);
        size = st.size;
        mtime = st.mtimeMs;
      } catch {
        continue;
      }
      this.files.set(found.path, {
        path: found.path,
        session: found.session,
        sub: found.sub,
        reader: new TranscriptReader({
          session: found.session,
          sub: found.sub,
          project: projectLabel(found.project),
          contextWindows: this.opts.contextWindows,
          now: this.opts.now,
        }),
        offset: initial ? size : 0,
        partial: Buffer.alloc(0),
        mtime,
        primed: !initial,
        announced: false,
      });
    }
  }

  /** Read whatever hot files have gained since the last poll. */
  poll(): void {
    const now = this.opts.now();
    for (const f of this.files.values()) {
      let size: number;
      try {
        const st = statSync(f.path);
        size = st.size;
        f.mtime = st.mtimeMs;
      } catch {
        this.files.delete(f.path);
        continue;
      }
      if (now - f.mtime > this.opts.hotMs) continue;

      if (!f.primed) this.prime(f);
      if (size < f.offset) {
        // Rewritten from scratch: start over, quietly.
        f.offset = 0;
        f.partial = Buffer.alloc(0);
        f.primed = false;
        this.prime(f);
        continue;
      }

      const events = size > f.offset ? this.read(f, size) : [];
      if (!f.sub && !f.announced && (events.length > 0 || f.reader.state.lastAt > 0)) {
        f.announced = true;
        this.opts.onSession?.({ ...f.reader.state });
      }
      for (const event of events) this.opts.onEvent(event);
    }
  }

  /** Read existing content for state, discarding the events. */
  private prime(f: Followed): void {
    f.primed = true;
    const end = f.offset;
    const start = Math.max(0, end - this.opts.primeBytes);
    if (end <= start) return;
    const text = this.slice(f.path, start, end).toString('utf8');
    const lines = text.split('\n');
    if (start > 0) lines.shift(); // began mid-line
    for (const line of lines) f.reader.push(line);
  }

  private read(f: Followed, size: number): RadioEvent[] {
    const chunk = this.slice(f.path, f.offset, size);
    f.offset = size;
    const data = f.partial.length > 0 ? Buffer.concat([f.partial, chunk]) : chunk;
    const events: RadioEvent[] = [];
    let from = 0;
    for (let i = 0; i < data.length; i++) {
      if (data[i] !== 0x0a) continue;
      events.push(...f.reader.push(data.subarray(from, i).toString('utf8')));
      from = i + 1;
    }
    f.partial = Buffer.from(data.subarray(from));
    return events;
  }

  private slice(path: string, start: number, end: number): Buffer {
    const buffer = Buffer.alloc(end - start);
    let fd: number | undefined;
    try {
      fd = openSync(path, 'r');
      let read = 0;
      while (read < buffer.length) {
        const n = readSync(fd, buffer, read, buffer.length - read, start + read);
        if (n <= 0) break;
        read += n;
      }
      return buffer.subarray(0, read);
    } catch {
      return Buffer.alloc(0);
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
}

