import test from 'node:test';
import assert from 'node:assert/strict';
import { TranscriptReader, readTranscript, toolFamily } from '../src/events';
import type { RadioEvent } from '../src/types';

/**
 * Transcript lines → radio events. The fixtures below copy the shapes Claude
 * Code actually writes, including the ones that caught the first draft out.
 */

const T0 = Date.parse('2026-09-26T19:00:00.000Z');
const ts = (s: number): string => new Date(T0 + s * 1000).toISOString();

const user = (s: number, content: unknown, extra: object = {}): string =>
  JSON.stringify({ type: 'user', timestamp: ts(s), cwd: '/work/claude_conduct', message: { role: 'user', content }, ...extra });

const assistant = (
  s: number,
  id: string,
  block: object,
  stop: string,
  usage = { input_tokens: 2, output_tokens: 400, cache_creation_input_tokens: 6_000, cache_read_input_tokens: 94_000 },
): string =>
  JSON.stringify({
    type: 'assistant',
    timestamp: ts(s),
    effort: 'xhigh',
    message: { id, model: 'claude-opus-5-5', stop_reason: stop, usage, content: [block] },
  });

const types = (events: RadioEvent[]): string[] => events.map((e) => e.type);

function read(lines: string[]): { events: RadioEvent[]; reader: TranscriptReader } {
  const reader = new TranscriptReader({ session: 's1' });
  const events: RadioEvent[] = [];
  for (const line of lines) events.push(...reader.push(line));
  return { events, reader };
}

test('a whole turn reads as prompt → usage → blocks → results → end', () => {
  const { events, reader } = read([
    user(0, 'Rethink this entire experience'),
    assistant(20, 'm1', { type: 'thinking', thinking: '' }, 'tool_use'),
    assistant(21, 'm1', { type: 'text', text: 'Let me look.' }, 'tool_use'),
    assistant(22, 'm1', { type: 'tool_use', name: 'Read', input: { file_path: '/x' } }, 'tool_use'),
    user(23, [{ type: 'tool_result', content: 'file body', is_error: false }]),
    assistant(30, 'm2', { type: 'thinking', thinking: '' }, 'end_turn'),
    assistant(36, 'm2', { type: 'text', text: 'Done.' }, 'end_turn'),
  ]);
  assert.deepEqual(types(events), [
    'prompt',
    'title',
    'usage',
    'think',
    'text',
    'tool',
    'result',
    'usage',
    'think',
    'text',
    'end',
  ]);
  assert.equal(reader.state.activity, 'idle');
  assert.equal(reader.state.project, 'claude_conduct');
  assert.equal(reader.state.title, 'Rethink this entire experience');
});

test('usage repeated on every block line is counted once per message', () => {
  const { events, reader } = read([
    assistant(1, 'm1', { type: 'thinking', thinking: '' }, 'tool_use'),
    assistant(2, 'm1', { type: 'text', text: 'hi' }, 'tool_use'),
    assistant(3, 'm1', { type: 'tool_use', name: 'Bash', input: {} }, 'tool_use'),
  ]);
  assert.equal(events.filter((e) => e.type === 'usage').length, 1);
  assert.equal(reader.state.outTotal, 400);
});

test('end_turn on the thinking line does not end the turn — the reply has not landed yet', () => {
  // Claude Code stamps the final stop_reason on every line of the message,
  // including a thinking line written seconds before the text.
  const reader = new TranscriptReader({ session: 's1' });
  const early = reader.push(assistant(10, 'm9', { type: 'thinking', thinking: '' }, 'end_turn'));
  assert.ok(!types(early).includes('end'));
  assert.equal(reader.state.activity, 'model');
  const late = reader.push(assistant(21, 'm9', { type: 'text', text: 'Here it is.' }, 'end_turn'));
  assert.deepEqual(types(late), ['text', 'end']);
});

test('context comes from the full prompt size against the model window', () => {
  const { events, reader } = read([
    assistant(1, 'm1', { type: 'text', text: 'x' }, 'tool_use', {
      input_tokens: 0,
      output_tokens: 10,
      cache_creation_input_tokens: 20_000,
      cache_read_input_tokens: 80_000,
    }),
  ]);
  const usage = events.find((e) => e.type === 'usage');
  assert.ok(usage && usage.type === 'usage');
  assert.equal(usage.contextPct, 10); // 100k of a 1M window
  assert.equal(usage.fresh, 20_000);
  assert.equal(usage.cached, 80_000);
  assert.equal(reader.state.contextPct, 10);
});

test('failed tools are flagged', () => {
  const { events } = read([user(1, [{ type: 'tool_result', content: 'boom', is_error: true }])]);
  assert.deepEqual(events, [{ session: 's1', at: T0 + 1000, type: 'result', error: true, size: 6 }]);
});

test('an interrupt ends the turn quietly', () => {
  const { events } = read([
    user(0, 'go'),
    user(4, [{ type: 'text', text: '[Request interrupted by user for tool use]' }]),
  ]);
  const end = events.find((e) => e.type === 'end');
  assert.ok(end && end.type === 'end' && end.interrupted === true);
});

test('meta lines, command output and compact summaries are not prompts', () => {
  const { events } = read([
    user(0, 'Caveat: internal', { isMeta: true }),
    user(1, '<local-command-stdout>ok</local-command-stdout>'),
    user(2, 'This session is being continued from a previous conversation.', { isCompactSummary: true }),
  ]);
  assert.deepEqual(events, []);
});

test('compaction is a sunrise: context resets and the event carries the old size', () => {
  const { events, reader } = read([
    assistant(1, 'm1', { type: 'text', text: 'x' }, 'end_turn', {
      input_tokens: 0,
      output_tokens: 10,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 700_000,
    }),
    JSON.stringify({ type: 'system', subtype: 'compact_boundary', timestamp: ts(5), compactMetadata: { preTokens: 700_010 } }),
  ]);
  assert.equal(events.at(-1)?.type, 'compact');
  assert.equal(reader.state.contextPct, 0);
  assert.equal(reader.state.compactions, 1);
});

test('a chosen title outranks a generated one, which outranks the first prompt', () => {
  const reader = new TranscriptReader({ session: 's1' });
  reader.push(user(0, 'first prompt text'));
  assert.equal(reader.state.title, 'first prompt text');
  reader.push(JSON.stringify({ type: 'ai-title', aiTitle: 'Generated name' }));
  assert.equal(reader.state.title, 'Generated name');
  reader.push(JSON.stringify({ type: 'custom-title', customTitle: 'My name' }));
  reader.push(JSON.stringify({ type: 'ai-title', aiTitle: 'Another generated name' }));
  assert.equal(reader.state.title, 'My name');
});

test('the Stop hook summary ends a turn that never said end_turn', () => {
  const { events } = read([
    user(0, 'go'),
    assistant(2, 'm1', { type: 'tool_use', name: 'Bash', input: {} }, 'tool_use'),
    JSON.stringify({ type: 'system', subtype: 'stop_hook_summary', timestamp: ts(3) }),
  ]);
  assert.equal(events.at(-1)?.type, 'end');
});

test('subagent events are attributed to the parent and never move its context', () => {
  const reader = new TranscriptReader({ session: 'parent', sub: true });
  const events = [
    ...reader.push(user(0, 'Find the cash-flow code')),
    ...reader.push(assistant(1, 'a1', { type: 'tool_use', name: 'Grep', input: {} }, 'tool_use')),
  ];
  assert.ok(events.every((e) => e.session === 'parent' && e.sub === true));
  assert.equal(reader.state.contextPct, 0);
  assert.equal(reader.state.title, null);
});

test('malformed and irrelevant lines are ignored', () => {
  const { events } = read(['', 'not json', '{"type":"queue-operation"}', '[1,2]', 'null']);
  assert.deepEqual(events, []);
});

test('tool names map to families', () => {
  assert.equal(toolFamily('Read'), 'read');
  assert.equal(toolFamily('Grep'), 'read');
  assert.equal(toolFamily('WebFetch'), 'web');
  assert.equal(toolFamily('Edit'), 'write');
  assert.equal(toolFamily('Bash'), 'exec');
  assert.equal(toolFamily('Agent'), 'agent');
  assert.equal(toolFamily('mcp__linear__get_issue'), 'mcp');
  assert.equal(toolFamily('TodoWrite'), 'other');
});

test('events carry sizes and kinds, never conversation text', () => {
  const { events } = read([
    user(0, 'secret plans'),
    assistant(1, 'm1', { type: 'text', text: 'secret reply' }, 'end_turn'),
    user(2, [{ type: 'tool_result', content: 'secret output' }]),
  ]);
  const payload = JSON.stringify(events.filter((e) => e.type !== 'title'));
  assert.ok(!payload.includes('secret'), payload);
});

test('readTranscript parses a whole file', () => {
  const text = [user(0, 'go'), assistant(1, 'm1', { type: 'text', text: 'ok' }, 'end_turn')].join('\n');
  const { events, state } = readTranscript(text, { session: 's1' });
  assert.equal(events.at(-1)?.type, 'end');
  assert.equal(state.model, 'claude-opus-5-5');
});
