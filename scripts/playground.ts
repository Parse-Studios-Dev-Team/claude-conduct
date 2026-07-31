#!/usr/bin/env tsx
/**
 * Build and serve the CC-9 playground.
 *
 *   npm run playground            # bundle, serve on :5273, open a browser
 *   npm run playground -- --port 8080 --no-open
 *   npm run playground -- --recordings ~/.claude/conduct/<project>/recordings
 *
 * Static-only: the server bundles the app, exposes this project's recordings
 * directory read-only, and gets out of the way. The playground itself imports
 * the real `src/` modules, so what it plays is the engine, not a copy of it.
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import { resolvePaths, userRuntimeDir } from '../src/hook/paths';
import { listRecordings } from '../src/recorder';
import { transcriptDirFor, labelFor } from '../src/sessionTitle';

const repoDir = resolve(fileURLToPath(new URL('..', import.meta.url)));
const playgroundDir = join(repoDir, 'playground');

const args = process.argv.slice(2);
const flag = (name: string): string | null => {
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] ?? null) : null;
};
// `PORT` lets a supervisor assign one when 5273 is taken — a second playground
// on the same machine would otherwise fail to bind.
const port = Number(flag('--port') ?? process.env.PORT ?? 5273);
const shouldOpen = !args.includes('--no-open');

/**
 * Find the recordings directory, in priority order:
 *
 *   1. an explicit `--recordings` flag;
 *   2. wherever `CONDUCT_STATE_DIR` points, when it's set in this shell;
 *   3. the project-local `.claude/recordings`;
 *   4. the user-scope `~/.claude/conduct/<project>/recordings`.
 *
 * 3 and 4 both have to be checked because the hooks set `CONDUCT_STATE_DIR`
 * *in the hook's own environment*, from `settings.json` — a shell running
 * `npm run playground` never sees it. Resolving from `cwd` alone therefore
 * pointed at a project-local directory that a user-scope install never creates,
 * and the playground came up with an empty session list and no explanation.
 *
 * Preferring the candidate that actually holds recordings (rather than the
 * first that merely exists) is what makes this work without the user knowing
 * which install layout they have.
 */
function resolveRecordingsDir(): { dir: string; tried: string[] } {
  const explicit = flag('--recordings');
  if (explicit) return { dir: resolve(explicit), tried: [] };

  const candidates = [
    resolvePaths(process.cwd()).recordingsDir,
    join(userRuntimeDir(process.cwd()), 'recordings'),
  ].filter((dir, i, all) => all.indexOf(dir) === i);

  const populated = candidates.find((dir) => existsSync(dir) && listRecordings(dir).length > 0);
  return { dir: populated ?? candidates[0]!, tried: candidates };
}

const { dir: recordingsDir, tried: recordingCandidates } = resolveRecordingsDir();

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jsonl': 'application/x-ndjson; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

const result = await build({
  entryPoints: [join(playgroundDir, 'main.ts')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  write: false,
  sourcemap: 'inline',
});
const bundle = result.outputFiles[0]!.text;
console.log(`Bundled playground (${(bundle.length / 1024).toFixed(0)}kb)`);

/** Serve a file only if it really sits inside `root` — the recordings dir is user data. */
function safeJoin(root: string, requested: string): string | null {
  const target = resolve(root, '.' + requested);
  return target === root || target.startsWith(root + sep) ? target : null;
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${port}`);
  const path = decodeURIComponent(url.pathname);

  if (path === '/' || path === '/index.html') {
    res.writeHead(200, { 'content-type': MIME['.html']! });
    res.end(readFileSync(join(playgroundDir, 'index.html')));
    return;
  }

  if (path === '/bundle.js') {
    res.writeHead(200, { 'content-type': MIME['.js']! });
    res.end(bundle);
    return;
  }

  if (path === '/recordings.json') {
    // Titles come from Claude Code's own transcripts, looked up by session id.
    // Resolved per request rather than cached so a session recorded while the
    // playground is open still gets a label on reload.
    const transcripts = transcriptDirFor(process.cwd());
    const list = listRecordings(recordingsDir).map((item) => {
      const label = labelFor(item.sessionId, transcripts);
      return {
        sessionId: item.sessionId,
        file: `/recordings/${encodeURIComponent(item.sessionId)}.jsonl`,
        mtime: item.mtime,
        title: label.title,
        prompt: label.prompt,
      };
    });
    res.writeHead(200, { 'content-type': MIME['.json']! });
    res.end(JSON.stringify(list));
    return;
  }

  if (path.startsWith('/recordings/')) {
    const target = safeJoin(recordingsDir, path.slice('/recordings'.length));
    if (target && existsSync(target)) {
      res.writeHead(200, { 'content-type': MIME['.jsonl']! });
      res.end(readFileSync(target));
      return;
    }
  }

  const asset = safeJoin(playgroundDir, path);
  if (asset && existsSync(asset) && extname(asset)) {
    res.writeHead(200, { 'content-type': MIME[extname(asset)] ?? 'application/octet-stream' });
    res.end(readFileSync(asset));
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('Not found');
});

server.listen(port, () => {
  const url = `http://localhost:${port}`;
  const found = listRecordings(recordingsDir).length;
  console.log(`\n♪  Conduct playground → ${url}`);
  console.log(`   recordings: ${recordingsDir}`);
  console.log(`   found ${found} session${found === 1 ? '' : 's'}\n`);
  if (found === 0) {
    console.log('   No recordings yet — they appear after a session runs with recording enabled.');
    // Say where we looked: an empty list is otherwise indistinguishable from
    // "looked in the wrong place", which is exactly the failure this hunts for.
    for (const dir of recordingCandidates) {
      console.log(`     · checked ${dir}${existsSync(dir) ? '' : '  (does not exist)'}`);
    }
    console.log('   Point it somewhere else with --recordings <dir>, or drag a .jsonl onto the page.\n');
  }
  if (shouldOpen) {
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    spawn(opener, [url], { stdio: 'ignore', detached: true }).unref();
  }
});
