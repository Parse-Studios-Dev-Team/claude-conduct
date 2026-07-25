#!/usr/bin/env tsx
/**
 * Audible demo — the fastest way to hear Conduct working.
 *
 *   npm run demo            # plays a tier sweep through the speakers
 *   npm run demo -- --silent   # sequence only, no audio (for CI / a quiet room)
 *
 * Spins up a real daemon in a temp dir and walks it from silence up to the full
 * ensemble and back, so you hear the crossfades. No hooks or Claude Code session
 * needed. Uses the synth placeholder stems (or real ones via CONDUCT_STEMS_DIR).
 */
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { synthesizeStems } from '../src/audio/synth';
import { loadStems } from '../src/audio/loadStems';
import { stemCount, DEFAULT_LAYOUT } from '../src/audio/tierGains';
import { NullSink, createSpeakerSink, type Sink } from '../src/audio/sink';
import { ConductDaemon } from '../src/daemon/server';
import { sendTier } from '../src/daemon/client';

const sampleRate = 44_100;
const holdMs = Number(process.env.CONDUCT_DEMO_HOLD_MS) || 2500;
const silent = process.argv.includes('--silent') || process.env.CONDUCT_SILENT === '1';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const sweep: Array<{ ensembleSize: number; richness: number; timbre?: number; label: string }> = [
  { ensembleSize: 1, richness: 0, label: 'solo piano' },
  { ensembleSize: 2, richness: 0, label: '+ strings' },
  { ensembleSize: 3, richness: 0, label: '+ woodwinds' },
  { ensembleSize: 4, richness: 1, label: '+ brass, pad fades in' },
  { ensembleSize: 5, richness: 2, label: 'full ensemble' },
  { ensembleSize: 5, richness: 2, timbre: 1, label: 'full + Opus signature ✦' },
  { ensembleSize: 3, richness: 1, label: 'ease back (standard model)' },
  { ensembleSize: 1, richness: 0, label: 'solo piano' },
  { ensembleSize: 0, richness: 0, label: 'silence' },
];

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'conduct-demo-'));
  mkdirSync(join(dir, '.claude'), { recursive: true });
  const commandPath = join(dir, '.claude', 'conduct-command.json');
  const pidPath = join(dir, '.claude', 'conduct.pid');

  let sink: Sink;
  if (silent) {
    sink = new NullSink(sampleRate);
  } else {
    try {
      sink = await createSpeakerSink(sampleRate);
    } catch (error) {
      console.warn(`No audio: ${(error as Error).message}\nInstall it with \`npm i speaker\`, then re-run. Continuing silently.\n`);
      sink = new NullSink(sampleRate);
    }
  }

  const count = stemCount(DEFAULT_LAYOUT);
  const stemsDir = process.env.CONDUCT_STEMS_DIR;
  let stems: Float32Array[];
  try {
    stems = stemsDir ? loadStems(stemsDir, { count, sampleRate }) : synthesizeStems(count, { sampleRate });
  } catch (error) {
    console.warn(`Could not load stems (${(error as Error).message}); using synth.`);
    stems = synthesizeStems(count, { sampleRate });
  }

  const daemon = new ConductDaemon(stems, sink, { commandPath, pidPath, crossfadeMs: 1500 });
  daemon.start();

  const audio = sink instanceof NullSink ? '(silent)' : '(audio on — turn it up)';
  console.log(`\n♪  Conduct demo ${audio} — the ensemble builds, then fades:\n`);

  for (const step of sweep) {
    sendTier(commandPath, { ensembleSize: step.ensembleSize, richness: step.richness });
    console.log(`   E${step.ensembleSize} R${step.richness}  ${step.label}`);
    await sleep(holdMs);
  }

  await sleep(400);
  daemon.stop();
  rmSync(dir, { recursive: true, force: true });
  console.log('\nDone. Wire it into real sessions with `npm run setup`.');
  process.exit(0);
}

void main();
