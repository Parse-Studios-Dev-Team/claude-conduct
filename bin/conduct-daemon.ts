#!/usr/bin/env node
/**
 * Claude Conduct playback daemon (CC-5).
 *
 *   tsx bin/conduct-daemon.ts [--silent]        # or: node dist/conduct-daemon.mjs
 *
 * Loads the stems once, watches the command file, and crossfades toward each
 * tier written to it. Real audio needs the optional `speaker` package; without
 * it (or with `--silent`) the daemon runs headless. CC-6's SessionStart hook
 * launches this and passes config through the environment.
 *
 * Env: CONDUCT_COMMAND, CONDUCT_PID, CONDUCT_SAMPLE_RATE, CONDUCT_VOLUME (0..1),
 * CONDUCT_CROSSFADE_MS, CONDUCT_SILENT=1, CONDUCT_HEARTBEAT,
 * CONDUCT_IDLE_TIMEOUT_MS (0 disables the idle watchdog).
 */
import { synthesizeStems } from '../src/audio/synth';
import { loadStems } from '../src/audio/loadStems';
import { stemCount, DEFAULT_LAYOUT } from '../src/audio/tierGains';
import { NullSink, createSpeakerSink, type Sink } from '../src/audio/sink';
import { ConductDaemon } from '../src/daemon/server';

function num(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function volume(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback;
}

/** Like {@link num} but accepts `0`, which disables the idle watchdog. */
function duration(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

async function main(): Promise<void> {
  const commandPath = process.env.CONDUCT_COMMAND ?? '.claude/conduct-command.json';
  const pidPath = process.env.CONDUCT_PID ?? '.claude/conduct.pid';
  const sampleRate = num(process.env.CONDUCT_SAMPLE_RATE, 44_100);
  const masterGain = volume(process.env.CONDUCT_VOLUME, 0.8);
  const crossfadeMs = num(process.env.CONDUCT_CROSSFADE_MS, 1_500);
  const silent = process.argv.includes('--silent') || process.env.CONDUCT_SILENT === '1';
  const heartbeatPath = process.env.CONDUCT_HEARTBEAT;
  const idleTimeoutMs = duration(process.env.CONDUCT_IDLE_TIMEOUT_MS, 15 * 60 * 1_000);

  // Real stems from CONDUCT_STEMS_DIR if present and loadable; else synth placeholders.
  const count = stemCount(DEFAULT_LAYOUT);
  const stemsDir = process.env.CONDUCT_STEMS_DIR;
  let stems: Float32Array[];
  let stemSource: string;
  if (stemsDir) {
    try {
      stems = loadStems(stemsDir, { count, sampleRate });
      stemSource = `stems: ${stemsDir}`;
    } catch (error) {
      console.warn(`[conduct] could not load stems from ${stemsDir}: ${(error as Error).message} — using synth.`);
      stems = synthesizeStems(count, { sampleRate });
      stemSource = 'synth (stem load failed)';
    }
  } else {
    stems = synthesizeStems(count, { sampleRate });
    stemSource = 'synth';
  }

  let sink: Sink;
  if (silent) {
    sink = new NullSink(sampleRate);
  } else {
    try {
      sink = await createSpeakerSink(sampleRate);
    } catch (error) {
      console.warn(`[conduct] ${(error as Error).message} — running silent.`);
      sink = new NullSink(sampleRate);
    }
  }

  let daemon: ConductDaemon | undefined;
  let stopping = false;
  const shutdown = (reason: string): void => {
    if (stopping) return;
    stopping = true;
    daemon?.stop();
    console.log(`[conduct] daemon stopped (${reason}).`);
    process.exit(0);
  };

  daemon = new ConductDaemon(stems, sink, {
    commandPath,
    pidPath,
    masterGain,
    crossfadeMs,
    heartbeatPath,
    idleTimeoutMs,
    onIdle: () => shutdown('idle'),
  });
  daemon.start();

  const mode = sink instanceof NullSink ? 'silent' : 'audio';
  const watchdog = heartbeatPath && idleTimeoutMs > 0 ? `idle ${Math.round(idleTimeoutMs / 1000)}s` : 'no watchdog';
  console.log(
    `[conduct] daemon up (${mode}, vol ${masterGain}, ${stemSource}, ${watchdog}); watching ${commandPath}`,
  );

  process.on('SIGINT', () => shutdown('signal'));
  process.on('SIGTERM', () => shutdown('signal'));
}

void main();
