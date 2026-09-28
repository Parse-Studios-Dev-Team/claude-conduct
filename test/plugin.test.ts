import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { COPIED, buildPlugin, pluginDir, repoDir } from '../scripts/build-plugin';

/**
 * The Conduct Radio plugin, as it ships: the files a marketplace install
 * copies, run the way the skill runs them. No `node_modules`, no tsx.
 */

const run = promisify(execFile);
const ctl = join(pluginDir, 'server', 'radio-ctl.mjs');

const readJson = (path: string): Record<string, unknown> => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;

test('the marketplace lists the plugin under the same name as its manifest', () => {
  const market = readJson(join(repoDir, '.claude-plugin', 'marketplace.json'));
  const manifest = readJson(join(pluginDir, '.claude-plugin', 'plugin.json'));
  const entries = market.plugins as Array<{ name: string; source: string }>;
  const entry = entries.find((p) => p.name === manifest.name);
  assert.ok(entry, `marketplace has an entry named ${String(manifest.name)}`);
  assert.ok(entry.source.startsWith('./') && !entry.source.includes('..'));
  assert.ok(existsSync(join(repoDir, entry.source, '.claude-plugin', 'plugin.json')));
  assert.match(String(manifest.name), /^[a-z0-9-]+$/, 'kebab-case');
  assert.ok(typeof manifest.version === 'string');
  assert.deepEqual(manifest.author, { name: 'Parse Studios', url: 'https://parsestudios.com' });
  assert.equal(manifest.license, 'MIT');
  assert.equal((market.owner as { name: string }).name, 'Parse Studios');
});

const skill = (): string => readFileSync(join(pluginDir, 'skills', 'radio', 'SKILL.md'), 'utf8');

/** The skill's shell command, pulled out the way Claude Code does it: a ```! block, trimmed. */
function skillCommand(text: string): string {
  const blocks = [...text.matchAll(/```!\s*\n?([\s\S]*?)\n?```/g)].map((m) => m[1]!.trim());
  assert.equal(blocks.length, 1, 'one shell block');
  return blocks[0]!;
}

test('the skill runs the launcher that ships with the plugin, with what you typed on stdin', () => {
  const text = skill();
  assert.match(text, /^---\nname: radio\n/);
  assert.match(text, /disable-model-invocation: true/, 'only you start the music');
  assert.equal(
    skillCommand(text),
    [
      `node "\${CLAUDE_PLUGIN_ROOT}/server/radio-ctl.mjs" --data "\${CLAUDE_PLUGIN_DATA}" --session "\${CLAUDE_SESSION_ID}" --args-stdin <<'CONDUCT_RADIO_ARGS'`,
      '$ARGUMENTS',
      'CONDUCT_RADIO_ARGS',
    ].join('\n'),
  );
  // Claude Code doesn't escape `$ARGUMENTS`: anywhere but inside the quoted heredoc, the shell would parse it.
  assert.doesNotMatch(text.replace(/```!\s*\n?[\s\S]*?\n?```/g, ''), /\$ARGUMENTS|!`/);
  for (const file of ['server/radio-ctl.mjs', 'server/radio.mjs', 'app/bundle.js', 'app/index.html']) {
    assert.ok(existsSync(join(pluginDir, file)), file);
  }
});

test('the committed build is up to date with the sources', async () => {
  for (const [path, text] of await buildPlugin()) {
    const shipped = readFileSync(join(pluginDir, path), 'utf8');
    assert.ok(shipped === text, `${path} is stale — run npm run build`);
  }
  for (const [from, to] of COPIED) {
    assert.equal(
      readFileSync(join(pluginDir, to), 'utf8'),
      readFileSync(join(repoDir, from), 'utf8'),
      `${to} is stale — run npm run build`,
    );
  }
});

test('the shipped server needs nothing but Node', () => {
  for (const file of ['server/radio.mjs', 'server/radio-ctl.mjs']) {
    const text = readFileSync(join(pluginDir, file), 'utf8');
    assert.ok(text.startsWith('#!/usr/bin/env node\n'), `${file} starts with a node shebang`);
    const imports = [...text.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]!);
    for (const spec of imports) assert.ok(spec.startsWith('node:'), `${file} imports ${spec}`);
  }
});

function sandbox(): { flags: string[]; data: string; projects: string; tapes: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'conduct-plugin-'));
  const data = join(dir, 'data');
  const projects = join(dir, 'projects');
  const tapes = join(dir, 'tapes');
  return {
    data,
    projects,
    tapes,
    flags: ['--data', data, '--root', projects, '--tapes', tapes, '--port', '0', '--no-open'],
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const say = async (args: string[]): Promise<string> => (await run(process.execPath, [ctl, ...args])).stdout.trim();

test('start, reuse, status, stop — reporting only what it verified', async () => {
  const box = sandbox();
  try {
    assert.match(await say(['status', ...box.flags]), /not running/);

    const started = await say(['start', ...box.flags]);
    assert.match(started, /^Conduct Radio is running at http:\/\/localhost:\d+\. Press Tune in/);
    assert.doesNotMatch(started, /opened/, '--no-open means it says nothing about a browser');
    const state = readJson(join(box.data, 'server.json')) as { pid: number; port: number };

    const health = await fetch(`http://127.0.0.1:${state.port}/healthz`).then((r) => r.json());
    assert.deepEqual(health, { app: 'conduct-radio', pid: state.pid, clients: 0 });
    const page = await fetch(`http://127.0.0.1:${state.port}/`).then((r) => r.text());
    assert.match(page, /<title>Conduct Radio<\/title>/);
    assert.equal((await fetch(`http://127.0.0.1:${state.port}/bundle.js`)).status, 200);

    assert.match(await say(['start', ...box.flags]), /already running/);
    assert.match(await say(['status', ...box.flags]), new RegExp(`pid ${state.pid}`));

    assert.equal(await say(['stop', ...box.flags]), 'Conduct Radio stopped.');
    assert.ok(!existsSync(join(box.data, 'server.json')), 'state removed on exit');
    assert.match(await say(['stop', ...box.flags]), /not running/);
  } finally {
    await say(['stop', ...box.flags]).catch(() => undefined);
    box.cleanup();
  }
});

test('a server nobody is listening to exits on its own', async () => {
  const box = sandbox();
  try {
    await say(['start', ...box.flags, '--idle-exit', '0.02']); // 1.2 seconds
    assert.ok(existsSync(join(box.data, 'server.json')));
    const deadline = Date.now() + 8_000;
    while (existsSync(join(box.data, 'server.json')) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.ok(!existsSync(join(box.data, 'server.json')), 'exited and cleaned up');
  } finally {
    await say(['stop', ...box.flags]).catch(() => undefined);
    box.cleanup();
  }
});

test('an unknown command says so and fails', async () => {
  const box = sandbox();
  try {
    await assert.rejects(run(process.execPath, [ctl, 'dance', ...box.flags]), (error: { stdout?: string }) =>
      /Unknown command "dance"/.test(error.stdout ?? ''),
    );
  } finally {
    box.cleanup();
  }
});

test('tape: the skill saves the last finished turn, and the radio plays it', async () => {
  const box = sandbox();
  try {
    const at = (s: number): string => new Date(Date.parse('2026-09-27T01:00:00Z') + s * 1000).toISOString();
    const prompt = (s: number, text: string): string =>
      JSON.stringify({ type: 'user', timestamp: at(s), cwd: '/work/app', message: { role: 'user', content: text } });
    const reply = (s: number, id: string, out: number): string =>
      JSON.stringify({
        type: 'assistant',
        timestamp: at(s),
        message: {
          id,
          model: 'claude-opus-5-5',
          stop_reason: 'end_turn',
          usage: { input_tokens: 0, output_tokens: out, cache_creation_input_tokens: 0, cache_read_input_tokens: 40_000 },
          content: [{ type: 'text', text: 'done' }],
        },
      });
    mkdirSync(join(box.projects, '-work-app'), { recursive: true });
    writeFileSync(
      join(box.projects, '-work-app', 'abc123.jsonl'),
      // A finished turn, then the slash command that's running now.
      [prompt(0, 'fix the sky'), reply(60, 'm1', 2_400), prompt(90, '<command-name>/conduct-radio:radio</command-name>')].join('\n'),
    );

    // As the skill runs it: a title, and a session id that wasn't substituted.
    const saved = await say(['tape', 'Smooth', 'sky', ...box.flags, '--session', '${CLAUDE_SESSION_ID}']);
    assert.match(saved, /^Saved the tape “Smooth sky” \(1 min, 2\.4k output tokens\)\. Play it on the radio under Replay → Tapes\.$/);

    await say(['start', ...box.flags]);
    const { port } = readJson(join(box.data, 'server.json')) as { port: number };
    const listed = (await fetch(`http://127.0.0.1:${port}/api/tapes`).then((r) => r.json())) as Array<{ id: string; out: number }>;
    assert.equal(listed.length, 1);
    assert.equal(listed[0]!.out, 2_400);
    const played = (await fetch(`http://127.0.0.1:${port}/api/replay?id=${encodeURIComponent(listed[0]!.id)}`).then((r) =>
      r.json(),
    )) as { title: string; events: Array<{ type: string }> };
    assert.equal(played.title, 'Smooth sky');
    assert.ok(played.events.some((e) => e.type === 'usage'));
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/replay?id=tape:..`)).status, 404);
  } finally {
    await say(['stop', ...box.flags]).catch(() => undefined);
    box.cleanup();
  }
});

/** A GET with whatever `Host` header we like — `fetch` won't send a made-up one. */
function getAs(port: number, host: string, path: string): Promise<{ status: number; headers: Record<string, unknown> }> {
  return new Promise((done, fail) => {
    const req = request({ host: '127.0.0.1', port, path, headers: { host } }, (res) => {
      res.resume();
      res.on('end', () => done({ status: res.statusCode ?? 0, headers: res.headers }));
    });
    req.on('error', fail);
    req.end();
  });
}

test('the server answers its own page only: other hosts are refused, and the page is locked down', async () => {
  const box = sandbox();
  try {
    await say(['start', ...box.flags]);
    const { port } = readJson(join(box.data, 'server.json')) as { port: number };
    // DNS rebinding: a hostile domain resolved to 127.0.0.1.
    assert.equal((await getAs(port, `evil.example:${port}`, '/api/sessions')).status, 403);
    assert.equal((await getAs(port, 'evil.example', '/events')).status, 403);
    const page = await getAs(port, `localhost:${port}`, '/');
    assert.equal(page.status, 200);
    assert.match(String(page.headers['content-security-policy']), /default-src 'self'.*frame-ancestors 'none'/);
    assert.equal(page.headers['x-content-type-options'], 'nosniff');
    assert.equal((await getAs(port, `127.0.0.1:${port}`, '/healthz')).status, 200);
  } finally {
    await say(['stop', ...box.flags]).catch(() => undefined);
    box.cleanup();
  }
});

test('stop never signals a process that isn’t the radio', async () => {
  const box = sandbox();
  // Something else now owns the pid in a state file a crashed radio left behind.
  const bystander = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30_000)'], { stdio: 'ignore' });
  try {
    mkdirSync(box.data, { recursive: true });
    writeFileSync(
      join(box.data, 'server.json'),
      JSON.stringify({ app: 'conduct-radio', pid: bystander.pid, port: 9, url: 'http://localhost:9', startedAt: Date.now() }),
    );
    assert.match(await say(['stop', ...box.flags]), /not running/);
    assert.equal(bystander.exitCode, null, 'the bystander is still running');
    assert.doesNotThrow(() => process.kill(bystander.pid!, 0));
    assert.ok(!existsSync(join(box.data, 'server.json')), 'the stale state file is cleared');
  } finally {
    bystander.kill();
    box.cleanup();
  }
});

test('whatever you type after the command reaches the launcher as text, and nothing in it runs', async () => {
  const box = sandbox();
  const root = join(box.data, '..');
  const home = join(root, 'home');
  try {
    // A finished turn in session abc123, under the $HOME the skill will see.
    const at = (s: number): string => new Date(Date.parse('2026-09-27T01:00:00Z') + s * 1000).toISOString();
    const project = join(home, '.claude', 'projects', '-work-app');
    mkdirSync(project, { recursive: true });
    writeFileSync(
      join(project, 'abc123.jsonl'),
      [
        JSON.stringify({ type: 'user', timestamp: at(0), cwd: '/work/app', message: { role: 'user', content: 'fix it' } }),
        JSON.stringify({
          type: 'assistant',
          timestamp: at(60),
          message: {
            id: 'm1',
            model: 'claude-opus-5-5',
            stop_reason: 'end_turn',
            usage: { input_tokens: 0, output_tokens: 900, cache_creation_input_tokens: 0, cache_read_input_tokens: 40_000 },
            content: [{ type: 'text', text: 'done' }],
          },
        }),
      ].join('\n'),
    );

    // As Claude Code runs the skill, `$ARGUMENTS` pasted in unescaped. The
    // `${CLAUDE_…}` placeholders are also shell variables, so the paths go in
    // through the environment rather than into the command's text; only what
    // was typed — the thing under test — is spliced in.
    const shellFor = (typed: string): string => skillCommand(skill()).replaceAll('$ARGUMENTS', () => typed);
    const env = {
      ...process.env,
      HOME: home,
      CLAUDE_PLUGIN_ROOT: pluginDir,
      CLAUDE_PLUGIN_DATA: box.data,
      CLAUDE_SESSION_ID: 'abc123',
    };

    const hostile = `Brandon's "fix" $(touch pwned-1) \`touch pwned-2\`; touch pwned-3 | cat && echo hi`;
    for (const shell of ['bash', 'sh']) {
      const { stdout } = await run(shell, ['-c', shellFor(`tape ${hostile}`)], { cwd: root, env });
      assert.equal(
        stdout.trim(),
        `Saved the tape “${hostile}” (1 min, 900 output tokens). Play it on the radio under Replay → Tapes.`,
        shell,
      );
    }
    assert.deepEqual(readdirSync(root).filter((f) => f.startsWith('pwned')), [], 'nothing typed was run');
    const shelf = join(home, '.claude', 'conduct-radio', 'tapes');
    const titles = readdirSync(shelf).map((f) => (readJson(join(shelf, f)) as { title: string }).title);
    assert.deepEqual(titles, [hostile, hostile]);

    const { stdout: quoted } = await run('bash', ['-c', shellFor('tape "Smooth sky"')], { cwd: root, env });
    assert.match(quoted, /^Saved the tape “Smooth sky” /, 'quotes around a title are dropped');
    const { stdout: status } = await run('bash', ['-c', shellFor('status')], { cwd: root, env });
    assert.match(status, /not running/);
  } finally {
    box.cleanup();
  }
});

