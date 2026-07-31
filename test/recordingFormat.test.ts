import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RECORDING_VERSION,
  encodeTurn,
  hasSignals,
  parseRecording,
  recordingSignals,
  summarize,
  turnSignals,
  type RecordedTurn,
} from '../src/recordingFormat';
import { recordTurn, readRecording, recordingPath } from '../src/recorder';
import { extractTurnFactsFromString, extractUsageFromString } from '../src/extractUsage';
import { parseTranscriptSignals } from '../src/transcriptSignals';
import type { Tier } from '../src/types';

/**
 * CC-12 — the widened recording format.
 *
 * The load-bearing property here is backwards compatibility: recordings on disk
 * predate this change, and the tests that matter most are the ones proving a v1
 * line still parses and is recognizably *not* scorable.
 */

function withTmpDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'conduct-rec-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const assistantLine = (fields: Record<string, unknown>, message: Record<string, unknown>): string =>
  JSON.stringify({
    type: 'assistant',
    ...fields,
    message: {
      model: 'claude-opus-5',
      usage: { input_tokens: 10, output_tokens: 500, cache_read_input_tokens: 1000 },
      ...message,
    },
  });

const tier = (e: number, r: number, s = 0): Tier => ({ ensembleSize: e, richness: r, timbre: s });

// --- extraction -------------------------------------------------------------

test('extractTurnFacts reads the axes off the same line as the usage', () => {
  const line = assistantLine(
    { effort: 'max' },
    {
      stop_reason: 'end_turn',
      content: [{ type: 'tool_use', name: 'Bash' }, { type: 'tool_use', name: 'Read' }],
    },
  );

  const facts = extractTurnFactsFromString(line);
  assert.equal(facts.effort, 'max');
  assert.equal(facts.shape, 'tool');
  assert.equal(facts.tool, 'exec', 'the *first* tool decides the family');
  assert.equal(facts.endsTurn, true);
  assert.equal(facts.outputTokens, 500);
  assert.equal(facts.tokens, 510, 'tok still sums input + output + cache creation');
});

test('extractUsage is unchanged by the widening', () => {
  const line = assistantLine({ effort: 'xhigh' }, { content: [{ type: 'thinking' }] });
  assert.deepEqual(Object.keys(extractUsageFromString(line)).sort(), [
    'contextPct',
    'model',
    'tokens',
  ]);
});

test('an unrecognized effort is dropped rather than recorded', () => {
  const facts = extractTurnFactsFromString(assistantLine({ effort: 'medium' }, {}));
  assert.equal(facts.effort, null);
});

test('a transcript with no assistant turns yields the empty facts', () => {
  const facts = extractTurnFactsFromString('{"type":"user"}\nnot json\n');
  assert.deepEqual(facts, {
    tokens: 0,
    contextPct: 0,
    model: null,
    outputTokens: 0,
    effort: null,
    shape: 'text',
    tool: null,
    endsTurn: false,
  });
});

test('the live extractor and the playback reader classify a turn identically', () => {
  // The whole reason `turnSignals.ts` exists: these two read the same field off
  // the same line for different purposes, and must never disagree.
  for (const content of [
    [{ type: 'thinking' }, { type: 'text' }],
    [{ type: 'tool_use', name: 'Edit' }],
    [{ type: 'tool_use', name: 'mcp__linear__save_issue' }],
    [{ type: 'text' }],
    [],
  ]) {
    const line = assistantLine({ effort: 'high' }, { content, stop_reason: 'end_turn' });
    const live = extractTurnFactsFromString(line);
    const playback = parseTranscriptSignals(line)[0]!;

    assert.deepEqual(
      { e: live.effort, s: live.shape, t: live.tool, x: live.endsTurn },
      { e: playback.effort, s: playback.shape, t: playback.tool, x: playback.endsTurn },
      `disagreement on ${JSON.stringify(content)}`,
    );
  }
});

// --- encoding ---------------------------------------------------------------

test('absent axes are omitted from the line, not written as null', () => {
  const line = JSON.parse(
    encodeTurn({ t: 1, tok: 5, ctx: 1.23, model: null, tier: { e: 1, r: 0, s: 0 } }),
  );
  assert.deepEqual(Object.keys(line).sort(), ['ctx', 'model', 't', 'tier', 'tok']);
  assert.equal(line.ctx, 1.2, 'ctx is still rounded to one decimal');
});

test('a false endsTurn costs no bytes', () => {
  const line = JSON.parse(
    encodeTurn({ t: 1, tok: 5, ctx: 0, model: null, tier: { e: 0, r: 0, s: 0 }, end: false }),
  );
  assert.equal('end' in line, false);
});

test('present axes round-trip through encode → parse', () => {
  const turn: RecordedTurn = {
    t: 7,
    tok: 900,
    ctx: 12.5,
    model: 'claude-opus-5',
    tier: { e: 4, r: 1, s: 1 },
    out: 640,
    ef: 'xhigh',
    sh: 'think',
    tl: 'read',
    end: true,
  };
  const { turns } = parseRecording(`${encodeTurn(turn)}\n`);
  assert.deepEqual(turns[0], turn);
});

// --- backwards compatibility ------------------------------------------------

const V1_LINE = '{"t":1,"tok":100,"ctx":2.5,"model":"claude-opus-5","tier":{"e":2,"r":0,"s":1}}';

test('a v1 line still parses, and is recognizably not scorable', () => {
  const { turns } = parseRecording(`${V1_LINE}\n`);
  assert.equal(turns.length, 1);
  assert.equal(turns[0]!.tok, 100);
  assert.equal(hasSignals(turns[0]!), false);
});

test('a wholly v1 recording reports null so the caller falls back to the transcript', () => {
  assert.equal(recordingSignals(parseRecording(`${V1_LINE}\n${V1_LINE}\n`)), null);
});

test('a recording spanning the upgrade scores from its v2 turns', () => {
  const v2 = encodeTurn({
    t: 2,
    tok: 200,
    ctx: 5,
    model: 'claude-opus-5',
    tier: { e: 3, r: 1, s: 1 },
    out: 150,
    sh: 'tool',
    tl: 'exec',
  });
  const signals = recordingSignals(parseRecording(`${V1_LINE}\n${v2}\n`));
  assert.equal(signals?.length, 1, 'the v1 turn is skipped, not scored as silence');
  assert.equal(signals?.[0]!.shape, 'tool');
});

test('turnSignals prefers output tokens and falls back to the summed total', () => {
  const base = { t: 1, ctx: 1, model: null, tier: { e: 0, r: 0, s: 0 }, sh: 'text' as const };
  assert.equal(turnSignals({ ...base, tok: 900, out: 640 }).tokens, 640);
  assert.equal(turnSignals({ ...base, tok: 900 }).tokens, 900);
});

test('the version is stamped on the summary', () => {
  assert.equal(RECORDING_VERSION, 2);
  assert.equal(summarize(parseRecording(`${V1_LINE}\n`).turns).version, 2);
});

// --- recorder wiring --------------------------------------------------------

test('recordTurn writes the axes when it is handed the full facts', () => {
  withTmpDir((dir) => {
    recordTurn(
      dir,
      'sess',
      {
        tokens: 1200,
        contextPct: 8.25,
        model: 'claude-opus-5',
        outputTokens: 900,
        effort: 'max',
        shape: 'think',
        tool: null,
        endsTurn: true,
      },
      tier(4, 1, 1),
      1000,
    );

    const [turn] = readRecording(recordingPath(dir, 'sess')).turns;
    assert.deepEqual(turn, {
      t: 1000,
      tok: 1200,
      ctx: 8.3,
      model: 'claude-opus-5',
      tier: { e: 4, r: 1, s: 1 },
      out: 900,
      ef: 'max',
      sh: 'think',
      end: true,
    });
    assert.equal('tl' in turn!, false, 'a turn that ran no tool records no tool');
  });
});

test('recordTurn still accepts a bare Usage and writes a valid line', () => {
  withTmpDir((dir) => {
    recordTurn(dir, 'sess', { tokens: 10, contextPct: 1, model: null }, tier(1, 0), 5);
    const { turns } = readRecording(recordingPath(dir, 'sess'));
    assert.equal(turns.length, 1);
    assert.equal(hasSignals(turns[0]!), false);
  });
});

test('a recording stays one line per turn', () => {
  withTmpDir((dir) => {
    const facts = extractTurnFactsFromString(
      assistantLine({ effort: 'high' }, { content: [{ type: 'tool_use', name: 'Grep' }] }),
    );
    recordTurn(dir, 'sess', facts, tier(2, 0), 1);
    recordTurn(dir, 'sess', facts, tier(2, 0), 2);

    const text = readFileSync(recordingPath(dir, 'sess'), 'utf8');
    assert.equal(text.trimEnd().split('\n').length, 2);
    assert.equal(recordingSignals(parseRecording(text))?.length, 2);
  });
});
