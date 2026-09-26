#!/usr/bin/env tsx
/**
 * Conduct Radio — lo-fi that levels up as Claude works. By Parse Studios.
 *
 *   npm run radio                 # bundle, serve on :5274, open a browser
 *   npm run radio -- --port 8080 --no-open
 *   npm run radio -- --root <dir> # a different ~/.claude/projects
 *
 * Installed as a plugin, the same server runs prebuilt (see
 * `scripts/build-plugin.ts`) and is managed by `radio-ctl`:
 *
 *   --app <dir>        serve a prebuilt index.html + bundle.js instead of bundling
 *   --state <file>     publish {pid, port, url} there once listening; removed on exit
 *   --idle-exit <min>  exit after this long with no page connected
 *
 * Follows every transcript under `~/.claude/projects` and streams what each
 * session is doing to the page over server-sent events. Needs no hooks: it reads
 * what Claude Code already writes.
 *
 * Listens on 127.0.0.1 only. Events carry kinds, sizes and token counts — never
 * conversation text — and the only text that reaches the page is each session's
 * title.
 */
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { TranscriptWatcher, findTranscripts } from '../src/tail';
import { readTranscript } from '../src/events';
import type { RadioEvent } from '../src/types';

const repoDir = resolve(fileURLToPath(new URL('..', import.meta.url)));

const args = process.argv.slice(2);
const flag = (name: string): string | null => {
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] ?? null) : null;
};
const port = Number(flag('--port') ?? process.env.PORT ?? 5274);
const shouldOpen = !args.includes('--no-open');
const root = resolve(flag('--root') ?? join(homedir(), '.claude', 'projects'));
const stateFile = flag('--state');
const idleExitMs = Number(flag('--idle-exit') ?? 0) * 60_000;

/**
 * The page and its script. A plugin install has no `node_modules`, so it ships
 * them prebuilt and passes `--app`; in the repo, they're bundled on the fly —
 * which is why esbuild is imported lazily, and only here.
 */
async function loadApp(): Promise<{ html: () => Buffer; bundle: string }> {
  const prebuilt = flag('--app');
  if (prebuilt) {
    const dir = resolve(prebuilt);
    const bundle = readFileSync(join(dir, 'bundle.js'), 'utf8');
    return { html: () => readFileSync(join(dir, 'index.html')), bundle };
  }
  const { build } = await import('esbuild');
  const appDir = join(repoDir, 'app');
  const result = await build({
    entryPoints: [join(appDir, 'main.ts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
    sourcemap: 'inline',
  });
  const bundle = result.outputFiles[0]!.text;
  console.log(`Bundled radio (${(bundle.length / 1024).toFixed(0)}kb)`);
  return { html: () => readFileSync(join(appDir, 'index.html')), bundle };
}

const app = await loadApp();

// ── live feed ──────────────────────────────────────────────────────────────

const clients = new Set<ServerResponse>();
/** When a page was last connected — for `--idle-exit`. Starts now, as a grace period. */
let lastClientAt = Date.now();

function send(res: ServerResponse, event: string | null, data: unknown): void {
  res.write(`${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`);
}

function broadcast(event: string | null, data: unknown): void {
  for (const res of clients) send(res, event, data);
}

const watcher = new TranscriptWatcher({
  root,
  onEvent: (event) => broadcast(null, event),
  onSession: (state) => broadcast('session', state),
});
watcher.start();

setInterval(() => {
  for (const res of clients) res.write(': ping\n\n');
}, 15_000).unref();

// ── replays ────────────────────────────────────────────────────────────────

const SAFE = /^[A-Za-z0-9._-]+$/;

/** Read at most `length` bytes of `path` starting at `start`. */
function readRange(path: string, start: number, length: number): string {
  const buffer = Buffer.alloc(length);
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const n = readSync(fd, buffer, 0, length, start);
    return buffer.subarray(0, n).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * The project's real name, from the working directory recorded in the
 * transcript. The directory Claude Code files it under can't be reversed:
 * `claude-conduct` and `claude/conduct` both become `-claude-conduct`.
 */
function quickProject(path: string, size: number, fallback: string): string {
  const m = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(readRange(path, 0, Math.min(size, 64 * 1024)));
  const cwd = m?.[1];
  return cwd ? (cwd.split(/[\\/]/).filter(Boolean).pop() ?? fallback) : fallback;
}

/**
 * A title without parsing a multi-megabyte transcript: the last name Claude Code
 * gave the session sits near the end, and the first prompt near the start.
 */
function quickTitle(path: string, size: number): string | null {
  const tail = readRange(path, Math.max(0, size - 256 * 1024), Math.min(size, 256 * 1024)).split('\n').reverse();
  for (const line of tail) {
    const m = /"type":"(custom-title|ai-title)".*?"(customTitle|aiTitle)":"((?:[^"\\]|\\.)*)"/.exec(line);
    if (m) {
      try {
        return JSON.parse(`"${m[3]}"`) as string;
      } catch {
        return m[3] ?? null;
      }
    }
  }
  const { state } = readTranscript(readRange(path, 0, Math.min(size, 128 * 1024)), { session: 'x' });
  return state.title;
}

function listSessions(): unknown[] {
  const found = findTranscripts(root)
    .filter((t) => !t.sub)
    .map((t) => {
      try {
        const st = statSync(t.path);
        return { ...t, size: st.size, mtime: st.mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((t): t is NonNullable<typeof t> => t !== null && t.size > 2_000)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 40);

  return found.map((t) => ({
    id: `${t.project}/${t.session}`,
    session: t.session,
    title: quickTitle(t.path, t.size),
    project: quickProject(t.path, t.size, t.project.split('-').filter(Boolean).pop() ?? t.project),
    mtime: t.mtime,
    size: t.size,
  }));
}

function replay(id: string): { events: RadioEvent[]; project: string; title: string | null } | null {
  const [project, session] = id.split('/');
  if (!project || !session || !SAFE.test(project) || !SAFE.test(session)) return null;
  const main = join(root, project, `${session}.jsonl`);
  if (!existsSync(main)) return null;

  const { events, state } = readTranscript(readFileSync(main, 'utf8'), { session });
  const subDir = join(root, project, session, 'subagents');
  if (existsSync(subDir)) {
    for (const file of readdirSync(subDir)) {
      if (!file.endsWith('.jsonl') || !SAFE.test(file)) continue;
      events.push(...readTranscript(readFileSync(join(subDir, file), 'utf8'), { session, sub: true }).events);
    }
  }
  events.sort((a, b) => a.at - b.at);
  return { events, project: state.project, title: state.title };
}

// ── server ─────────────────────────────────────────────────────────────────

const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');

  switch (url.pathname) {
    case '/':
    case '/index.html':
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(app.html());
      return;

    case '/bundle.js':
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
      res.end(app.bundle);
      return;

    // How `radio-ctl` tells this server from anything else on the port.
    case '/healthz':
      json(res, 200, { app: 'conduct-radio', pid: process.pid, clients: clients.size });
      return;

    case '/events':
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write('retry: 2000\n\n');
      send(res, 'snapshot', { sessions: watcher.sessions(), now: Date.now() });
      clients.add(res);
      req.on('close', () => {
        clients.delete(res);
        lastClientAt = Date.now();
      });
      return;

    case '/api/sessions':
      json(res, 200, listSessions());
      return;

    case '/api/replay': {
      const found = replay(url.searchParams.get('id') ?? '');
      if (!found) json(res, 404, { error: 'no such session' });
      else json(res, 200, found);
      return;
    }
  }

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('Not found');
});

/**
 * Listen, moving up a port if one is taken — a second radio, or anything else
 * on 5274, shouldn't be a failure. `--port 0` asks the OS for any free port.
 */
function listen(at: number, attempts: number): Promise<number> {
  return new Promise((done, fail) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      server.off('listening', onListening);
      if (error.code === 'EADDRINUSE' && at !== 0 && attempts > 0) done(listen(at + 1, attempts - 1));
      else fail(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      done((server.address() as AddressInfo).port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(at, '127.0.0.1');
  });
}

const actualPort = await listen(port, 20);
const url = `http://localhost:${actualPort}`;

// Published only now that the socket is listening: whoever launched us can
// report "running" on the strength of this file, not on a spawn returning a pid.
if (stateFile) {
  const temp = `${stateFile}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify({ app: 'conduct-radio', pid: process.pid, port: actualPort, url, startedAt: Date.now() }));
  renameSync(temp, stateFile);
}

function shutdown(): void {
  watcher.stop();
  server.close();
  for (const res of clients) res.end();
  if (stateFile) {
    try {
      const state = JSON.parse(readFileSync(stateFile, 'utf8')) as { pid?: number };
      if (state.pid === process.pid) unlinkSync(stateFile);
    } catch {
      /* already gone */
    }
  }
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// A background server nobody is listening to shouldn't live forever: close the
// tab, forget the radio, and it goes away on its own.
if (idleExitMs > 0) {
  setInterval(() => {
    if (clients.size > 0) lastClientAt = Date.now();
    else if (Date.now() - lastClientAt >= idleExitMs) shutdown();
  }, Math.min(30_000, idleExitMs)).unref();
}

const live = watcher.sessions();
console.log(`\n♪  Conduct Radio by Parse Studios → ${url}`);
console.log(`   following ${root}`);
console.log(
  live.length === 0
    ? '   no sessions active in the last 30 minutes — start one, or play the demo\n'
    : `   ${live.length} active session${live.length === 1 ? '' : 's'}: ${live
        .map((s) => s.title ?? s.session.slice(0, 8))
        .join(' · ')}\n`,
);
if (shouldOpen) {
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  spawn(opener, [url], { stdio: 'ignore', detached: true }).unref();
}
