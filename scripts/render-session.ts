#!/usr/bin/env node
/**
 * CC-10 — render a finished Claude Code session as a piece of music.
 *
 *   npx tsx scripts/render-session.ts <session-id|transcript.jsonl> [options]
 *
 * Options:
 *   --out <file>       output path (default ./renders/<session>.wav)
 *   --seconds <n>      piece length regardless of session length (default 90)
 *   --moments <n>      spans the session is resampled to (default 36)
 *   --project <dir>    project the session belongs to (default cwd)
 *
 * Unlike the daemon, this knows the whole session before it plays a note, so
 * every axis is scaled to the session's own range. See `src/sessionScore.ts`.
 */
import { writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { encodeWav } from '../src/audio/wav';
import { readTranscriptSignals } from '../src/transcriptSignals';
import { scoreSession, type TurnSignals } from '../src/sessionScore';
import { renderMoments } from '../src/renderSession';
import { transcriptDirFor } from '../src/sessionTitle';
import { readRecording, recordingPath, recordingSignals } from '../src/recorder';
import { resolvePaths, userRuntimeDir } from '../src/hook/paths';

function flag(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1]! : null;
}

const target = process.argv[2];
if (!target || target.startsWith('--')) {
  console.error('usage: render-session <session-id|transcript.jsonl> [--out f] [--seconds n] [--moments n]');
  process.exit(1);
}

const projectDir = resolve(flag('project') ?? process.cwd());
const transcriptDir = transcriptDirFor(projectDir);

/** Accept a path, a full session id, or a unique id prefix. */
function resolveTranscript(id: string): string | null {
  if (id.endsWith('.jsonl')) return existsSync(id) ? resolve(id) : null;

  const exact = join(transcriptDir, `${id}.jsonl`);
  if (existsSync(exact)) return exact;

  if (!existsSync(transcriptDir)) return null;
  const matches = readdirSync(transcriptDir).filter(
    (f) => f.endsWith('.jsonl') && f.startsWith(id),
  );
  if (matches.length === 1) return join(transcriptDir, matches[0]!);
  if (matches.length > 1) {
    console.error(`ambiguous session prefix "${id}" — ${matches.length} matches`);
    process.exit(1);
  }
  return null;
}

/**
 * Signals for a session id, from its own recording when the recording is v2
 * (CC-12) and from Claude Code's transcript otherwise.
 *
 * The recording is preferred because it is the file we control: transcripts get
 * cleaned up, and a v2 recording already holds every axis the scorer wants. The
 * transcript path stays because sessions recorded before v2 — and sessions never
 * recorded at all — are still worth rendering.
 */
function loadSignals(id: string): { turns: TurnSignals[]; source: string; name: string } | null {
  const dirs = [
    resolvePaths(projectDir).recordingsDir,
    join(userRuntimeDir(projectDir), 'recordings'),
  ];
  for (const dir of dirs) {
    const path = recordingPath(dir, id);
    if (!existsSync(path)) continue;
    const turns = recordingSignals(readRecording(path));
    if (turns && turns.length > 0) return { turns, source: 'recording', name: id };
  }

  const transcriptPath = resolveTranscript(id);
  if (!transcriptPath) return null;
  return {
    turns: readTranscriptSignals(transcriptPath),
    source: 'transcript',
    name: basename(transcriptPath, '.jsonl'),
  };
}

const loaded = loadSignals(target);
if (!loaded) {
  console.error(`no recording or transcript for "${target}" under ${transcriptDir}`);
  process.exit(1);
}

const { turns, source, name } = loaded;
if (turns.length === 0) {
  console.error(`no assistant turns found for ${name} (${source})`);
  process.exit(1);
}

const totalMs = Number(flag('seconds') ?? 90) * 1000;
const moments = Number(flag('moments') ?? 36);

const scored = scoreSession(turns, { totalMs, moments });
const piece = renderMoments(scored, { totalMs, moments });

const outPath = resolve(flag('out') ?? join('renders', `${name}.wav`));
mkdirSync(join(outPath, '..'), { recursive: true });
writeFileSync(outPath, encodeWav(piece.pcm, piece.sampleRate, 2));

// A quick profile of the piece — enough to see the shape without opening it.
const ladder = scored.map((m) => m.tier.ensembleSize);
const histogram = [0, 1, 2, 3, 4, 5].map((n) => ladder.filter((e) => e === n).length);
const fades = scored.map((m) => Math.round(m.crossfadeMs));
const spans = scored.map((m) => Math.round(m.durationMs));
const turnShapes = turns.reduce<Record<string, number>>((acc, t) => {
  acc[t.shape] = (acc[t.shape] ?? 0) + 1;
  return acc;
}, {});
const efforts = turns.reduce<Record<string, number>>((acc, t) => {
  const k = t.effort ?? 'none';
  acc[k] = (acc[k] ?? 0) + 1;
  return acc;
}, {});

console.log(`session   ${name}`);
console.log(`source    ${source}`);
console.log(`turns     ${turns.length} → ${scored.length} spans`);
console.log(`length    ${(piece.durationMs / 1000).toFixed(1)}s`);
console.log(`ensemble  ${ladder.join(' ')}`);
console.log(`spread    ${histogram.map((n, i) => `E${i}:${n}`).join('  ')}`);
console.log(`turn mix  ${Object.entries(turnShapes).map(([k, v]) => `${k}:${v}`).join('  ')}`);
console.log(`effort    ${Object.entries(efforts).map(([k, v]) => `${k}:${v}`).join('  ')}`);
console.log(`crossfade ${Math.min(...fades)}–${Math.max(...fades)}ms (articulation range)`);
console.log(`span len  ${Math.min(...spans)}–${Math.max(...spans)}ms`);
console.log(`cadences  ${scored.filter((m) => m.cadence).length}`);
console.log(`wrote     ${outPath}`);
