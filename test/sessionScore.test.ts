import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreSession, type TurnSignals, type Shape } from '../src/sessionScore';
import { parseTranscriptSignals } from '../src/transcriptSignals';
import { renderMoments, buildStems } from '../src/renderSession';
import { Mixer } from '../src/audio/mixer';

/** A turn with sensible defaults; override only what the test is about. */
function turn(over: Partial<TurnSignals> = {}): TurnSignals {
  return {
    tokens: 500,
    contextPct: 10,
    model: 'claude-opus-5',
    effort: 'high',
    shape: 'tool',
    tool: 'exec',
    endsTurn: false,
    ...over,
  };
}

/** `n` turns whose token counts ramp linearly between `from` and `to`. */
function ramp(n: number, from: number, to: number, over: Partial<TurnSignals> = {}): TurnSignals[] {
  return Array.from({ length: n }, (_, i) =>
    turn({ tokens: from + ((to - from) * i) / Math.max(1, n - 1), ...over }),
  );
}

// --- the core claim: relative, not absolute --------------------------------

test('the full ensemble ladder is used regardless of the session\'s absolute size', () => {
  // A quiet session and a heavy one, three orders of magnitude apart.
  const quiet = scoreSession(ramp(60, 10, 300), { moments: 12 });
  const heavy = scoreSession(ramp(60, 5_000, 400_000), { moments: 12 });

  for (const [name, moments] of [['quiet', quiet], ['heavy', heavy]] as const) {
    const sizes = moments.map((m) => m.tier.ensembleSize);
    assert.equal(Math.min(...sizes), 0, `${name}: should reach the bottom of the ladder`);
    assert.equal(Math.max(...sizes), 5, `${name}: should reach the top of the ladder`);
    assert.ok(new Set(sizes).size >= 5, `${name}: should use most of the ladder, got ${[...new Set(sizes)].join(',')}`);
  }
});

test('a flat session does not collapse to a single tier', () => {
  // Every turn identical: percentile ties share their midpoint rather than 0.
  const moments = scoreSession(Array.from({ length: 24 }, () => turn()), { moments: 8 });
  assert.equal(moments.length, 8);
  for (const m of moments) {
    assert.ok(m.tier.ensembleSize > 0 && m.tier.ensembleSize < 5, 'ties should land mid-ladder, not at an extreme');
  }
});

test('richness arcs across the session\'s own context span, not absolute occupancy', () => {
  // Occupancy never exceeds 4% — far below every absolute richness threshold.
  const shallow = scoreSession(
    Array.from({ length: 30 }, (_, i) => turn({ contextPct: 1 + i * 0.1 })),
    { moments: 10 },
  );
  const richness = shallow.map((m) => m.tier.richness);
  assert.equal(richness[0], 0, 'opens at the bottom');
  assert.equal(richness[richness.length - 1], 2, 'closes at the top');
});

// --- articulation: blend, don't vote ---------------------------------------

test('span articulation blends the work mix instead of taking a majority', () => {
  const mixed = (thinkShare: number): number => {
    const n = 20;
    const turns = Array.from({ length: n }, (_, i) =>
      turn({ shape: (i < n * thinkShare ? 'think' : 'tool') as Shape }),
    );
    return scoreSession(turns, { moments: 1 })[0]!.crossfadeMs;
  };

  const allTool = mixed(0);
  const mostlyTool = mixed(0.4);
  const allThink = mixed(1);

  assert.ok(allTool < mostlyTool, 'a 40% thinking span should breathe more than a pure tool span');
  assert.ok(mostlyTool < allThink, 'and less than a pure thinking span');
  // The regression this guards: majority-vote would make 40% thinking identical to 0%.
  assert.notEqual(mostlyTool, allTool);
});

test('crossfade never outruns the span it belongs to', () => {
  const moments = scoreSession(ramp(40, 100, 900, { shape: 'think' }), { moments: 20, totalMs: 4_000 });
  for (const m of moments) {
    assert.ok(m.crossfadeMs <= m.durationMs * 0.8 + 1e-6, 'a crossfade longer than its span would never complete');
  }
});

// --- shape of the piece -----------------------------------------------------

test('total duration is honoured whatever the session length', () => {
  for (const n of [1, 7, 500]) {
    const moments = scoreSession(ramp(n, 100, 5_000), { moments: 36, totalMs: 60_000 });
    const total = moments.reduce((a, m) => a + m.durationMs, 0);
    assert.ok(Math.abs(total - 60_000) < 1, `${n} turns → ${total}ms, expected 60000`);
  }
});

test('effort opens the harmony, and only the most demanding span in a bucket counts', () => {
  const plain = scoreSession(Array.from({ length: 10 }, () => turn({ effort: 'high' })), { moments: 1 })[0]!;
  assert.deepEqual(plain.extensions, [0, 0, 0], 'high effort stays on the triad');

  // One xhigh turn among nine — the interesting thing about the span, not an outlier to average away.
  const withXhigh = scoreSession(
    [...Array.from({ length: 9 }, () => turn({ effort: 'high' })), turn({ effort: 'xhigh' })],
    { moments: 1 },
  )[0]!;
  assert.ok(withXhigh.extensions[1]! > 0, 'the ♯11 should sound when any turn in the span is xhigh');
});

test('cadence marks spans where a turn handed control back', () => {
  const none = scoreSession(Array.from({ length: 6 }, () => turn()), { moments: 2 });
  assert.ok(none.every((m) => !m.cadence));

  const ends = scoreSession(
    [turn(), turn(), turn({ endsTurn: true }), turn(), turn(), turn()],
    { moments: 2 },
  );
  assert.ok(ends.some((m) => m.cadence), 'an end_turn in the span resolves it');
});

test('an empty session scores to nothing rather than throwing', () => {
  assert.deepEqual(scoreSession([]), []);
});

// --- transcript signals -----------------------------------------------------

const line = (o: unknown): string => JSON.stringify(o);
const assistant = (content: unknown[], over: Record<string, unknown> = {}): string =>
  line({
    type: 'assistant',
    effort: 'max',
    message: {
      model: 'claude-opus-5',
      stop_reason: 'tool_use',
      content,
      usage: { output_tokens: 300, input_tokens: 5, cache_read_input_tokens: 1000 },
    },
    ...over,
  });

test('turn shape follows the dominant content block', () => {
  const content = [
    assistant([{ type: 'thinking', thinking: 'hm' }]),
    assistant([{ type: 'tool_use', name: 'Bash' }]),
    assistant([{ type: 'text', text: 'done' }]),
  ].join('\n');

  const signals = parseTranscriptSignals(content);
  assert.deepEqual(signals.map((s) => s.shape), ['think', 'tool', 'text']);
});

test('tools are classified into the three families that sound different', () => {
  const content = [
    assistant([{ type: 'tool_use', name: 'Read' }]),
    assistant([{ type: 'tool_use', name: 'Edit' }]),
    assistant([{ type: 'tool_use', name: 'Bash' }]),
    assistant([{ type: 'tool_use', name: 'mcp__linear__save_issue' }]),
  ].join('\n');

  assert.deepEqual(parseTranscriptSignals(content).map((s) => s.tool), [
    'read',
    'write',
    'exec',
    'exec',
  ]);
});

test('effort, end_turn and output tokens are read off the transcript', () => {
  const signals = parseTranscriptSignals(
    assistant([{ type: 'text', text: 'hi' }], { message: {
      model: 'claude-opus-5',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'hi' }],
      usage: { output_tokens: 1234, input_tokens: 2, cache_read_input_tokens: 500 },
    } }),
  );
  assert.equal(signals.length, 1);
  assert.equal(signals[0]!.effort, 'max');
  assert.equal(signals[0]!.endsTurn, true);
  assert.equal(signals[0]!.tokens, 1234, 'output tokens only — input is ~all cache reads');
});

test('sidechain turns are excluded and malformed lines are skipped', () => {
  const content = [
    assistant([{ type: 'tool_use', name: 'Bash' }]),
    assistant([{ type: 'tool_use', name: 'Bash' }], { isSidechain: true }),
    '{"type":"assistant","message":{ truncated…',
    line({ type: 'user', message: { content: 'hello' } }),
    assistant([{ type: 'text', text: 'ok' }]),
  ].join('\n');

  const signals = parseTranscriptSignals(content);
  assert.equal(signals.length, 2, 'only the two main-thread assistant turns');
});

test('an unreadable transcript yields no signals rather than throwing', () => {
  assert.deepEqual(parseTranscriptSignals(''), []);
  assert.deepEqual(parseTranscriptSignals('not json at all\n{}'), []);
});

// --- render -----------------------------------------------------------------

test('rendering produces interleaved stereo of the scored length, silent at both edges', () => {
  const moments = scoreSession(ramp(20, 100, 4_000), { moments: 4, totalMs: 2_000 });
  const piece = renderMoments(moments, { totalMs: 2_000, sampleRate: 8_000, edgeFadeMs: 100 });

  assert.equal(piece.sampleRate, 8_000);
  assert.equal(piece.pcm.length % 2, 0, 'interleaved stereo');
  assert.ok(Math.abs(piece.durationMs - 2_000) < 20);
  // `Math.abs` because fading a negative sample to nothing yields -0, which is
  // silence but not `strictEqual` to 0.
  assert.equal(Math.abs(piece.pcm[0]!), 0, 'opens from silence');
  assert.equal(Math.abs(piece.pcm[piece.pcm.length - 1]!), 0, 'closes to silence');

  assert.ok(piece.pcm.some((s) => Math.abs(s) > 0.001), 'and is not silent in between');
  for (const s of piece.pcm) assert.ok(Math.abs(s) <= 1, 'stays inside full scale');
});

test('the stem bank is the daemon\'s seven plus three harmonic extensions', () => {
  const stems = buildStems(8_000);
  assert.equal(stems.length, 10);
  for (const s of stems) assert.ok(s.length > 0);
});

test('setCrossfadeMs retunes the ramp rate without disturbing current gains', () => {
  const mixer = new Mixer([new Float32Array(64).fill(0.5)], { sampleRate: 1_000, crossfadeMs: 1_000 });
  mixer.setTargets([1]);
  mixer.render(100); // part-way up
  const midGain = mixer.getGains()[0]!;

  mixer.setCrossfadeMs(100);
  assert.equal(mixer.getGains()[0], midGain, 'the gain itself must not jump — that would click');
  assert.ok(mixer.gainStepPerFrame > 1 / 1_000, 'but the ramp is now faster');
});
