import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanTitle } from '../src/shelf';
import { readSession, safeName } from '../src/tail';
import { cut, isTape, lastTurn, makeTape, tapeFileName } from '../src/tape';
import type { RadioEvent } from '../src/types';

/**
 * Tapes: a stretch of a session, saved to be played back. What matters: a tape
 * is the turn you asked for (subagents included), and it carries no text.
 */

const T0 = Date.parse('2026-09-27T01:00:00.000Z');
const at = (s: number): number => T0 + s * 1000;
const ev = (s: number, e: { type: RadioEvent['type']; sub?: boolean; [field: string]: unknown }): RadioEvent =>
  ({ session: 's1', at: at(s), ...e }) as RadioEvent;
const usage = (s: number, out: number, sub = false): RadioEvent =>
  ev(s, { type: 'usage', model: 'claude-opus-5-5', effort: null, out, fresh: 0, cached: 0, contextPct: 20, sub });

const TWO_TURNS: RadioEvent[] = [
  ev(0, { type: 'prompt' }),
  usage(5, 400),
  ev(10, { type: 'end' }),
  ev(60, { type: 'prompt' }),
  usage(65, 900),
  usage(70, 300, true),
  ev(71, { type: 'prompt', sub: true }),
  ev(80, { type: 'end', sub: true }),
  usage(90, 1_200),
  ev(95, { type: 'end' }),
];

test('the last turn runs from your last prompt to where Claude handed back', () => {
  assert.deepEqual(lastTurn(TWO_TURNS), { from: at(60), to: at(95) });
  // A subagent's prompts and ends are not yours.
  assert.deepEqual(lastTurn(TWO_TURNS.slice(0, 8)), { from: at(60), to: at(80) });
  assert.equal(lastTurn([usage(1, 10)]), null);
});

test('a turn still going runs to its latest event', () => {
  assert.deepEqual(lastTurn(TWO_TURNS.slice(0, 6)), { from: at(60), to: at(70) });
});

test('a tape is the stretch asked for, subagents included, with its output counted', () => {
  const tape = makeTape(TWO_TURNS, { title: 'Second', project: 'app', session: 's1', from: at(60), to: at(95) }, at(100));
  assert.equal(tape.events.length, 7);
  assert.equal(tape.out, 900 + 300 + 1_200);
  assert.ok(isTape(tape));
  assert.deepEqual(cut(TWO_TURNS, at(0), at(10)).map((e) => e.type), ['prompt', 'usage', 'end']);
});

test('tape files are named by date and title', () => {
  assert.equal(tapeFileName({ title: 'Smooth sky, & tapes!', recordedAt: at(0) }), '2026-09-27-smooth-sky-tapes.json');
  assert.equal(tapeFileName({ title: '???', recordedAt: at(0) }), '2026-09-27-tape.json');
  assert.equal(isTape({ app: 'conduct-radio', tape: 2, title: 'x', events: [] }), false);
});

test('session and file names can’t climb out of their folder', () => {
  assert.ok(safeName('-Users-me-app'));
  assert.ok(safeName('2026-09-27-smooth-sky.json'));
  assert.equal(safeName('..'), false);
  assert.equal(safeName('.'), false);
  assert.equal(safeName('a/b'), false);
});

test('npm run tape: cuts the last turn of the latest session onto the shelf', () => {
  const dir = mkdtempSync(join(tmpdir(), 'conduct-tape-'));
  try {
    const root = join(dir, 'projects');
    const shelf = join(dir, 'tapes');
    const project = join(root, '-work-app');
    mkdirSync(join(project, 's1', 'subagents'), { recursive: true });
    const line = (s: number, obj: object): string =>
      JSON.stringify({ timestamp: new Date(at(s)).toISOString(), cwd: '/work/app', ...obj });
    const reply = (s: number, id: string, out: number): string =>
      line(s, {
        type: 'assistant',
        message: {
          id,
          model: 'claude-opus-5-5',
          stop_reason: 'end_turn',
          usage: { input_tokens: 0, output_tokens: out, cache_creation_input_tokens: 0, cache_read_input_tokens: 50_000 },
          content: [{ type: 'text', text: 'secret reply text' }],
        },
      });
    writeFileSync(
      join(project, 's1.jsonl'),
      [
        line(0, { type: 'user', message: { role: 'user', content: 'first, secret prompt' } }),
        reply(5, 'm1', 300),
        line(60, { type: 'user', message: { role: 'user', content: 'second, secret prompt' } }),
        reply(90, 'm2', 1_500),
      ].join('\n') + '\n',
    );
    writeFileSync(join(project, 's1', 'subagents', 'agent-a.jsonl'), reply(70, 'a1', 200) + '\n');

    const output = execFileSync(
      process.execPath,
      [join('node_modules', 'tsx', 'dist', 'cli.mjs'), join('scripts', 'tape.ts'), '--root', root, '--tapes', shelf, '--title', 'Second turn'],
      { encoding: 'utf8' },
    );
    assert.match(output, /Saved “Second turn”/);

    const [file] = readdirSync(shelf);
    const raw = readFileSync(join(shelf, file!), 'utf8');
    const tape: unknown = JSON.parse(raw);
    assert.ok(isTape(tape));
    assert.equal(tape.out, 1_500 + 200, 'the second turn and its subagent, not the first turn');
    assert.equal(tape.project, 'app');
    assert.doesNotMatch(raw, /secret/, 'no conversation text on a tape');

    const whole = readSession(root, '-work-app', 's1');
    assert.equal(whole?.events.filter((e) => e.sub && e.type === 'usage').length, 1, 'the subagent is read too');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('tape titles are one bounded line', () => {
  assert.equal(cleanTitle('  Smooth\n\nsky\u0007  '), 'Smooth sky');
  assert.equal(cleanTitle('x'.repeat(200)).length, 80);
  assert.equal(cleanTitle(null), '');
});

