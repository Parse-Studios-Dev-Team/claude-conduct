import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { firstPrompt, toTitle, labelFor, transcriptIds, transcriptDirFor } from '../src/sessionTitle';

function withTranscript(lines: unknown[], fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'conduct-title-'));
  try {
    const path = join(dir, 'sess.jsonl');
    writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n'), 'utf8');
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const userText = (text: string, extra: Record<string, unknown> = {}): unknown => ({
  type: 'user',
  message: { content: [{ type: 'text', text }] },
  ...extra,
});

test('picks the first thing the user actually typed', () => {
  withTranscript([userText('Refactor the mixer to use equal-power panning')], (path) => {
    assert.equal(firstPrompt(path), 'Refactor the mixer to use equal-power panning');
  });
});

test('a string content body works as well as text blocks', () => {
  withTranscript([{ type: 'user', message: { content: 'plain string body' } }], (path) => {
    assert.equal(firstPrompt(path), 'plain string body');
  });
});

test('tool results, meta entries and command output are not prompts', () => {
  // These three shapes are how real transcripts mark machinery replayed through
  // the user role — see docs/transcript-schema.md.
  withTranscript(
    [
      userText('tool output here', { toolUseResult: { stdout: 'x' } }),
      userText('some injected note', { isMeta: true }),
      userText('Claude Conduct\n  daemon: running', { isMeta: true, sourceToolUseID: 'toolu_1' }),
      userText('the real question'),
    ],
    (path) => {
      assert.equal(firstPrompt(path), 'the real question');
    },
  );
});

test('command output is skipped even when it is not flagged isMeta', () => {
  // `sourceToolUseID` alone is enough: it is only ever set on replayed output.
  withTranscript(
    [
      userText('Unmuted (volume 1).', { sourceToolUseID: 'toolu_2' }),
      userText('now the actual prompt'),
    ],
    (path) => {
      assert.equal(firstPrompt(path), 'now the actual prompt');
    },
  );
});

test('prose wins over a slash command even when the command came first', () => {
  // The case this exists for: sessions routinely open with /conduct start, and
  // "/conduct start" is an accurate but useless title.
  withTranscript(
    [
      userText('<command-message>conduct</command-message><command-name>/conduct</command-name><command-args>start</command-args>'),
      userText('(Re-invocation of /conduct — the arguments below are new.)'),
      userText('Why does the music never reach the top tier?'),
    ],
    (path) => {
      assert.equal(firstPrompt(path), 'Why does the music never reach the top tier?');
    },
  );
});

test('a command-only session still gets its command as the title', () => {
  withTranscript(
    [
      userText('<command-message>conduct</command-message><command-name>/conduct</command-name><command-args>status</command-args>'),
      userText('Playing — E3 R0 ✦.', { isMeta: true, sourceToolUseID: 'toolu_3' }),
    ],
    (path) => {
      // The second line is command *output*, which is why it must not win.
      assert.equal(firstPrompt(path), '/conduct status');
    },
  );
});

test('system-reminder blocks are stripped, not treated as the prompt', () => {
  withTranscript(
    [userText('<system-reminder>background context</system-reminder> the actual ask')],
    (path) => {
      assert.equal(firstPrompt(path), 'the actual ask');
    },
  );
});

test('malformed lines and blanks are skipped rather than fatal', () => {
  const dir = mkdtempSync(join(tmpdir(), 'conduct-title-'));
  try {
    const path = join(dir, 'sess.jsonl');
    writeFileSync(path, `not json\n\n{"broken":\n${JSON.stringify(userText('survived'))}\n`, 'utf8');
    assert.equal(firstPrompt(path), 'survived');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing transcript yields null, never a throw', () => {
  assert.equal(firstPrompt('/nope/does/not/exist.jsonl'), null);
});

test('toTitle trims to a word boundary and marks the cut', () => {
  assert.equal(toTitle('short one'), 'short one');
  const long = toTitle('the quick brown fox jumps over the lazy dog and keeps on running well past the limit', 40);
  assert.ok(long.length <= 41, `got ${long.length}`);
  assert.ok(long.endsWith('…'));
  assert.ok(!long.includes('  '));
  // A single unbroken token still has to be cut somewhere.
  assert.ok(toTitle('x'.repeat(80), 20).endsWith('…'));
});

test('labelFor falls back to a short id when there is no transcript', () => {
  const label = labelFor('3d8ed7f5-7d91-40c9-958e-b026fd97aed1', '/nowhere');
  assert.equal(label.title, 'session 3d8ed7f5');
  assert.equal(label.prompt, null);

  // A hand-named recording keeps its name — truncating it reads as a bug.
  assert.equal(labelFor('demo-full-session', '/nowhere').title, 'demo-full-session');
});

test('transcriptDirFor matches Claude Code\'s own project-directory naming', () => {
  // Leading dash preserved — unlike projectSlug, which strips it.
  assert.equal(
    transcriptDirFor('/Users/me/dev/my-proj', '/home'),
    '/home/.claude/projects/-Users-me-dev-my-proj',
  );
});

test('transcriptIds lists session ids and tolerates a missing directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'conduct-title-'));
  try {
    writeFileSync(join(dir, 'aaa-111.jsonl'), '');
    writeFileSync(join(dir, 'bbb-222.jsonl'), '');
    writeFileSync(join(dir, 'notes.txt'), '');
    assert.deepEqual([...transcriptIds(dir)].sort(), ['aaa-111', 'bbb-222']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(transcriptIds('/nowhere/at/all').size, 0);
});
