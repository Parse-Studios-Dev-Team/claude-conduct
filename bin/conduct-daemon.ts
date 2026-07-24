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
 * CONDUCT_CROSSFADE_MS, CONDUCT_SILENT=1.
 */
import { synthesizeStems } from '../src/audio/synth';
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

async function main(): Promise<void> {
  const commandPath = process.env.CONDUCT_COMMAND ?? '.claude/conduct-command.json';
  const pidPath = process.env.CONDUCT_PID ?? '.claude/conduct.pid';
  const sampleRate = num(process.env.CONDUCT_SAMPLE_RATE, 44_100);
  const masterGain = volume(process.env.CONDUCT_VOLUME, 0.8);
  const crossfadeMs = num(process.env.CONDUCT_CROSSFADE_MS, 1_500);
  const silent = process.argv.includes('--silent') || process.env.CONDUCT_SILENT === '1';

  // Placeholder stems until CC-4 delivers real ones.
  const stems = synthesizeStems(stemCount(DEFAULT_LAYOUT), { sampleRate });

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

  const daemon = new ConductDaemon(stems, sink, { commandPath, pidPath, masterGain, crossfadeMs });
  daemon.start();
  const mode = sink instanceof NullSink ? 'silent' : 'audio';
  console.log(`[conduct] daemon up (${mode}, vol ${masterGain}); watching ${commandPath}`);

  let stopping = false;
  const shutdown = (): void => {
    if (stopping) return;
    stopping = true;
    daemon.stop();
    console.log('[conduct] daemon stopped.');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

void main();
