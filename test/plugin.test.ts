import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

test('the skill runs the launcher that ships with the plugin', () => {
  const skill = readFileSync(join(pluginDir, 'skills', 'radio', 'SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: radio\n/);
  assert.match(skill, /disable-model-invocation: true/, 'only you start the music');
  assert.match(skill, /^!`node "\$\{CLAUDE_PLUGIN_ROOT\}\/server\/radio-ctl\.mjs" \$ARGUMENTS --data "\$\{CLAUDE_PLUGIN_DATA\}"`$/m);
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

function sandbox(): { flags: string[]; data: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'conduct-plugin-'));
  const data = join(dir, 'data');
  const projects = join(dir, 'projects');
  return {
    data,
    flags: ['--data', data, '--root', projects, '--port', '0', '--no-open'],
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
