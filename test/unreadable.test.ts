import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isReadable, extractTurnFactsFromString } from '../src/extractUsage';
import { noteUnreadable, unreadableCount, clearSession, recordTier, readState } from '../src/state';
import { finalizeRecording, readRecording, recordingPath, recordTurn } from '../src/recorder';
import { handleEvent, realDeps, type HandlerDeps, type HookInput } from '../src/hook/handler';
import { DEFAULT_CONFIG } from '../src/hook/config';
import { resolvePaths } from '../src/hook/paths';

/**
 * CC-15 — a turn we could not read is not a quiet turn.
 *
 * The regression these guard against recorded 25,470 turns of silence across two
 * sessions, which was 96% of all recorded history on the machine, because a host
 * (Claude Code inside Cursor) writes transcripts with no `usage`, `model` or
 * `stop_reason` and the extractor's safe fallback looked exactly like tier 0.
 */

function withTmpDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'conduct-unread-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A line in the shape Cursor writes: content, and nothing else we need. */
const CURSOR_LINE = JSON.stringify({
  role: 'assistant',
  message: { content: [{ type: 'text' }, { type: 'tool_use', name: 'Bash' }] },
});

test('a Cursor-shaped transcript yields nothing readable', () => {
  const facts = extractTurnFactsFromString(`${CURSOR_LINE}\n{"type":"turn_ended","status":"ok"}\n`);
  assert.equal(facts.model, null);
  assert.equal(facts.tokens, 0);
  assert.equal(isReadable(facts), false);
});

test('isReadable separates "failed to read" from "genuinely quiet"', () => {
  assert.equal(isReadable({ tokens: 0, contextPct: 0, model: null }), false);
  // A real turn that happened to be tiny still has a model — that is readable.
  assert.equal(isReadable({ tokens: 0, contextPct: 0, model: 'claude-opus-5' }), true);
  // And a model-less line that still carried token counts is worth keeping.
  assert.equal(isReadable({ tokens: 12, contextPct: 0, model: null }), true);
});

test('an unreadable turn is counted, not recorded, and does not move the music', () => {
  withTmpDir((dir) => {
    const paths = resolvePaths(dir);
    const calls = { recordTurn: 0, sendTier: 0 };
    const deps: HandlerDeps = {
      ...realDeps,
      extractTurnFacts: () => extractTurnFactsFromString(CURSOR_LINE),
      recordTurn: () => {
        calls.recordTurn++;
      },
      sendTier: () => {
        calls.sendTier++;
      },
      startDaemon: () => {},
      stopDaemon: () => {},
    };

    const input: HookInput = {
      hook_event_name: 'PostToolUse',
      session_id: 'cursor-sess',
      transcript_path: '/does-not-matter',
    };

    for (let i = 0; i < 5; i++) {
      assert.equal(handleEvent(input, DEFAULT_CONFIG, paths, deps).action, 'unreadable');
    }

    assert.equal(calls.recordTurn, 0, 'nothing is recorded');
    assert.equal(calls.sendTier, 0, 'and playback is left alone rather than silenced');
    assert.equal(unreadableCount(paths.statePath, 'cursor-sess'), 5);
    assert.equal(existsSync(recordingPath(paths.recordingsDir, 'cursor-sess')), false);
  });
});

test('a readable turn is unaffected', () => {
  withTmpDir((dir) => {
    const paths = resolvePaths(dir);
    let recorded = 0;
    const deps: HandlerDeps = {
      ...realDeps,
      extractTurnFacts: () => ({
        tokens: 900,
        contextPct: 10,
        model: 'claude-opus-5',
        outputTokens: 600,
        effort: 'high',
        shape: 'tool',
        tool: 'exec',
        endsTurn: false,
      }),
      recordTurn: () => {
        recorded++;
      },
      sendTier: () => {},
      startDaemon: () => {},
      stopDaemon: () => {},
    };

    const result = handleEvent(
      { hook_event_name: 'PostToolUse', session_id: 's', transcript_path: '/t' },
      DEFAULT_CONFIG,
      paths,
      deps,
    );
    assert.equal(result.action, 'update');
    assert.equal(recorded, 1);
    assert.equal(unreadableCount(paths.statePath, 's'), 0);
  });
});

// --- surfacing --------------------------------------------------------------

test('a session that recorded nothing still leaves a summary saying why', () => {
  withTmpDir((dir) => {
    finalizeRecording(dir, 'all-silent', 812);
    const { turns, summary } = readRecording(recordingPath(dir, 'all-silent'));
    assert.equal(turns.length, 0);
    assert.equal(summary?.turns, 0);
    assert.equal(summary?.unreadable, 812, 'the failure leaves a trace instead of no file');
  });
});

test('a healthy session gets no unreadable field at all', () => {
  withTmpDir((dir) => {
    recordTurn(dir, 'ok', { tokens: 10, contextPct: 1, model: 'claude-opus-5' }, { ensembleSize: 1, richness: 0 });
    finalizeRecording(dir, 'ok', 0);
    const { summary } = readRecording(recordingPath(dir, 'ok'));
    assert.equal(summary?.unreadable, undefined);
  });
});

test('a partly-readable session reports both halves', () => {
  withTmpDir((dir) => {
    recordTurn(dir, 'mixed', { tokens: 10, contextPct: 1, model: 'claude-opus-5' }, { ensembleSize: 1, richness: 0 });
    finalizeRecording(dir, 'mixed', 3);
    const { summary } = readRecording(recordingPath(dir, 'mixed'));
    assert.equal(summary?.turns, 1);
    assert.equal(summary?.unreadable, 3);
  });
});

test('finalizing twice does not append a second summary', () => {
  withTmpDir((dir) => {
    finalizeRecording(dir, 'once', 5);
    finalizeRecording(dir, 'once', 5);
    const { summary } = readRecording(recordingPath(dir, 'once'));
    assert.equal(summary?.unreadable, 5);
  });
});

// --- state ------------------------------------------------------------------

test('the tally is per-session and is cleared with the session', () => {
  withTmpDir((dir) => {
    const path = join(dir, 'state.json');
    noteUnreadable(path, 'a');
    noteUnreadable(path, 'a');
    noteUnreadable(path, 'b');
    assert.equal(unreadableCount(path, 'a'), 2);
    assert.equal(unreadableCount(path, 'b'), 1);

    clearSession(path, 'a');
    assert.equal(unreadableCount(path, 'a'), 0);
    assert.equal(unreadableCount(path, 'b'), 1, "one session's cleanup leaves the other alone");
  });
});

test('the tally survives alongside normal tier state', () => {
  withTmpDir((dir) => {
    const path = join(dir, 'state.json');
    recordTier(path, 's', { ensembleSize: 3, richness: 1 });
    noteUnreadable(path, 's');
    const state = readState(path);
    assert.equal(state.sessions.s?.tier.ensembleSize, 3);
    assert.equal(state.unreadable.s, 1);
  });
});

test('a state file from before the counter existed is discarded, not crashed on', () => {
  withTmpDir((dir) => {
    const path = join(dir, 'state.json');
    writeFileSync(path, JSON.stringify({ version: 1, sessions: { s: {} } }), 'utf8');
    assert.deepEqual(readState(path).unreadable, {});
    assert.equal(unreadableCount(path, 's'), 0);
  });
});
