import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TranscriptWatcher, findTranscripts } from '../src/tail';
import type { RadioEvent, SessionState } from '../src/types';

/**
 * Following transcripts as they are written. The watcher is driven by hand here
 * (`scan` / `poll`) rather than its timers.
 */

const line = (obj: object): string => `${JSON.stringify({ timestamp: new Date().toISOString(), cwd: '/work/app', ...obj })}\n`;
const prompt = (text: string): string => line({ type: 'user', message: { role: 'user', content: text } });
const reply = (id: string, text: string, stop = 'end_turn'): string =>
  line({
    type: 'assistant',
    message: {
      id,
      model: 'claude-opus-5-5',
      stop_reason: stop,
      usage: { input_tokens: 0, output_tokens: 50, cache_creation_input_tokens: 1_000, cache_read_input_tokens: 99_000 },
      content: [{ type: 'text', text }],
    },
  });

function withRoot(fn: (root: string, project: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'conduct-radio-'));
  const project = join(root, '-work-app');
  mkdirSync(project);
  try {
    fn(root, project);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function watcher(root: string): { w: TranscriptWatcher; events: RadioEvent[]; sessions: SessionState[] } {
  const events: RadioEvent[] = [];
  const sessions: SessionState[] = [];
  const w = new TranscriptWatcher({ root, onEvent: (e) => events.push(e), onSession: (s) => sessions.push(s) });
  return { w, events, sessions };
}

test('history already on disk is read for state, not played', () => {
  withRoot((root, project) => {
    writeFileSync(join(project, 's1.jsonl'), prompt('first') + reply('m1', 'hello'));
    const { w, events } = watcher(root);
    w.scan(true);
    w.poll();
    assert.deepEqual(events, []);
    const [state] = w.sessions();
    assert.equal(state?.session, 's1');
    assert.equal(state?.project, 'app');
    assert.equal(state?.title, 'first');
    assert.equal(state?.contextPct, 10);
  });
});

test('lines appended after start are played, once', () => {
  withRoot((root, project) => {
    const file = join(project, 's1.jsonl');
    writeFileSync(file, prompt('first'));
    const { w, events } = watcher(root);
    w.scan(true);
    w.poll();
    appendFileSync(file, reply('m1', 'hello'));
    w.poll();
    w.poll();
    assert.deepEqual(
      events.map((e) => e.type),
      ['usage', 'text', 'end'],
    );
  });
});

test('a half-written line waits for its newline', () => {
  withRoot((root, project) => {
    const file = join(project, 's1.jsonl');
    writeFileSync(file, '');
    const { w, events } = watcher(root);
    w.scan(true);
    const full = prompt('go');
    appendFileSync(file, full.slice(0, 20));
    w.poll();
    assert.equal(events.length, 0);
    appendFileSync(file, full.slice(20));
    w.poll();
    assert.deepEqual(
      events.map((e) => e.type),
      ['prompt', 'title'],
    );
  });
});

test('a session that starts after the radio is played from its first line', () => {
  withRoot((root, project) => {
    const { w, events, sessions } = watcher(root);
    w.scan(true);
    writeFileSync(join(project, 'fresh.jsonl'), prompt('new work'));
    w.scan(false);
    w.poll();
    assert.equal(events[0]?.type, 'prompt');
    assert.equal(events[0]?.session, 'fresh');
    assert.equal(sessions[0]?.session, 'fresh', 'announced');
  });
});

test('subagent transcripts are found and attributed to their session', () => {
  withRoot((root, project) => {
    writeFileSync(join(project, 's1.jsonl'), prompt('parent'));
    const subDir = join(project, 's1', 'subagents');
    mkdirSync(subDir, { recursive: true });
    const agent = join(subDir, 'agent-abc.jsonl');
    writeFileSync(agent, '');

    const found = findTranscripts(root);
    assert.deepEqual(
      found.map((f) => [f.session, f.sub]).sort(),
      [
        ['s1', false],
        ['s1', true],
      ],
    );

    const { w, events } = watcher(root);
    w.scan(true);
    w.poll();
    appendFileSync(agent, reply('a1', 'found it', 'tool_use'));
    w.poll();
    assert.ok(events.length > 0);
    assert.ok(events.every((e) => e.session === 's1' && e.sub === true));
  });
});

test('a missing root is quiet, not an error', () => {
  const { w, events } = watcher(join(tmpdir(), 'conduct-radio-does-not-exist'));
  w.scan(true);
  w.poll();
  assert.deepEqual(events, []);
  assert.deepEqual(w.sessions(), []);
});
