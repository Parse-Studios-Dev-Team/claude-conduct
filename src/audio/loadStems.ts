import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { decodeWav, resample } from './wav';

export interface LoadStemsOptions {
  /** How many stems the layout expects (extra files ignored, too few → throws). */
  count: number;
  /** Target sample rate; stems recorded at another rate are resampled to it. */
  sampleRate: number;
}

/**
 * Determine stem file order. An optional `stems.json` (`{ "files": [...] }` or a
 * bare array) gives explicit ordering; otherwise `.wav` files are taken in
 * lexical order — so prefix them `01-…`, `02-…` to control the layer sequence
 * (see `docs/stems.md`).
 */
function orderedStemFiles(dir: string): string[] {
  const manifest = join(dir, 'stems.json');
  if (existsSync(manifest)) {
    const parsed: unknown = JSON.parse(readFileSync(manifest, 'utf8'));
    const files = Array.isArray(parsed) ? parsed : (parsed as { files?: unknown }).files;
    if (Array.isArray(files) && files.every((f) => typeof f === 'string')) {
      return files as string[];
    }
    throw new Error(`${manifest} must be an array of filenames or { "files": [...] }`);
  }
  return readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.wav'))
    .sort();
}

/**
 * Load a directory of WAV stems into mono `Float32Array`s at `sampleRate`,
 * ordered as the layout expects. Throws if the directory is missing or has
 * fewer than `count` stems — the daemon catches that and falls back to synth.
 */
export function loadStems(dir: string, options: LoadStemsOptions): Float32Array[] {
  const files = orderedStemFiles(dir);
  if (files.length < options.count) {
    throw new Error(`expected ${options.count} stems in ${dir}, found ${files.length}`);
  }

  const stems: Float32Array[] = [];
  for (const file of files.slice(0, options.count)) {
    const decoded = decodeWav(readFileSync(join(dir, file)));
    stems.push(resample(decoded.samples, decoded.sampleRate, options.sampleRate));
  }
  return stems;
}
