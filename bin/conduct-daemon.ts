#!/usr/bin/env tsx
/**
 * Claude Conduct playback daemon (CC-5).
 *
 *   tsx bin/conduct-daemon.ts [--silent]
 *
 * Loads the stems once, watches the command file, and crossfades toward each
 * tier written to it. Real audio needs the optional `speaker` package; without
 * it (or with `--silent`) the daemon runs headless. CC-6 will launch this on
 * SessionStart and stop it on SessionEnd; for now, run it by hand and drive it
 * with `sendTier(...)`.
 *
 * Env: CONDUCT_COMMAND, CONDUCT_PID, CONDUCT_SAMPLE_RATE, CONDUCT_SILENT=1.
 */
import { synthesizeStems } from '../src/audio/synth';
import { stemCount, DEFAULT_LAYOUT } from '../src/audio/tierGains';
import { NullSink, createSpeakerSink, type Sink } from '../src/audio/sink';
import { ConductDaemon } from '../src/daemon/server';

const commandPath = process.env.CONDUCT_COMMAND ?? '.claude/conduct-command.json';
const pidPath = process.env.CONDUCT_PID ?? '.claude/conduct.pid';
const sampleRate = Number(process.env.CONDUCT_SAMPLE_RATE ?? 44_100) || 44_100;
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

const audible = !(sink instanceof NullSink);
const daemon = new ConductDaemon(stems, sink, { commandPath, pidPath });
daemon.start();
console.log(`[conduct] daemon up (${audible ? 'audio' : 'silent'}); watching ${commandPath}`);

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
