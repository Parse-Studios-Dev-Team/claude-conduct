#!/usr/bin/env tsx
/**
 * Export the synth placeholder stems as WAV files, plus a `stems.json` manifest.
 *
 *   npm run export-stems [outDir]   # default: ./stems-preview
 *
 * Useful for (a) previewing how the layers stack, and (b) as a concrete format
 * template for the real stems (see docs/stems.md). Point CONDUCT_STEMS_DIR at the
 * output to hear the daemon load them through the real path.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { synthesizeStems } from '../src/audio/synth';
import { stemCount, DEFAULT_LAYOUT } from '../src/audio/tierGains';
import { encodeWav } from '../src/audio/wav';

const outDir = process.argv[2] ?? 'stems-preview';
const sampleRate = 44_100;
const names = ['01-piano', '02-strings', '03-woodwinds', '04-brass', '05-percussion', '06-pad', '07-signature'];

mkdirSync(outDir, { recursive: true });

const stems = synthesizeStems(stemCount(DEFAULT_LAYOUT), { sampleRate });
const files = stems.map((samples, i) => {
  const file = `${names[i] ?? `stem-${i}`}.wav`;
  writeFileSync(join(outDir, file), encodeWav(samples, sampleRate));
  return file;
});

writeFileSync(join(outDir, 'stems.json'), `${JSON.stringify({ files }, null, 2)}\n`);

console.log(`Wrote ${files.length} placeholder stems + stems.json to ${outDir}/`);
console.log(`Hear them via the real loader:  CONDUCT_STEMS_DIR="${outDir}" npm run daemon`);
