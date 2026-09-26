#!/usr/bin/env node
/**
 * radio-ctl — start, stop and check the Conduct Radio server. This is what the
 * plugin's `/conduct-radio:radio` skill runs.
 *
 *   radio-ctl [start|stop|status] [--data <dir>] [--no-open] [--port <n>] [--root <dir>]
 *
 * `start` reuses a running server when there is one, otherwise launches one in
 * the background, and opens the page either way. It only ever reports what it
 * verified: a server counts as running once it has published its state file
 * *and* answered `/healthz` as Conduct Radio. A pid alone proves nothing: `spawn`
 * returns one even for a process that dies a millisecond later.
 *
 * Built to `plugins/conduct-radio/server/radio-ctl.mjs` next to `radio.mjs`,
 * with the page in `../app`. Node built-ins only: a plugin install has no
 * `node_modules`.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, unlinkSync } from 'node:fs';
import { get } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

interface State {
  app: string;
  pid: number;
  port: number;
  url: string;
  startedAt: number;
}

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name: string): string | null => {
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] ?? null) : null;
};
const VALUE_FLAGS = new Set(['--data', '--port', '--root', '--idle-exit']);
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && VALUE_FLAGS.has(args[i - 1]!)));
const command = (positional[0] ?? 'start').toLowerCase();

// `${CLAUDE_PLUGIN_DATA}` is substituted by Claude Code; a literal placeholder
// means we're running outside it.
const dataFlag = flag('--data');
const dataDir = resolve(dataFlag && !dataFlag.includes('${') ? dataFlag : join(homedir(), '.claude', 'conduct-radio'));
const stateFile = join(dataDir, 'server.json');
const logFile = join(dataDir, 'server.log');

function readState(): State | null {
  try {
    const state = JSON.parse(readFileSync(stateFile, 'utf8')) as State;
    return state.app === 'conduct-radio' && Number.isInteger(state.pid) ? state : null;
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Does the server at `port` answer as Conduct Radio, with this pid? */
function healthy(state: State): Promise<boolean> {
  return new Promise((done) => {
    const req = get({ host: '127.0.0.1', port: state.port, path: '/healthz', timeout: 800 }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        try {
          const reply = JSON.parse(body) as { app?: string; pid?: number };
          done(reply.app === 'conduct-radio' && reply.pid === state.pid);
        } catch {
          done(false);
        }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => done(false));
  });
}

async function running(): Promise<State | null> {
  const state = readState();
  if (!state) return null;
  if (alive(state.pid) && (await healthy(state))) return state;
  try {
    unlinkSync(stateFile); // stale: the process died without cleaning up
  } catch {
    /* already gone */
  }
  return null;
}

const noOpen = args.includes('--no-open');

/** Open the page, and say so only if we did. */
function openBrowser(url: string): string {
  if (noOpen) return '';
  const [cmd, cmdArgs] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  try {
    spawn(cmd, cmdArgs, { stdio: 'ignore', detached: true }).unref();
    return ' — opened it in your browser';
  } catch {
    return ''; // no opener — the URL is printed anyway
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function start(): Promise<number> {
  const existing = await running();
  if (existing) {
    console.log(`Conduct Radio is already running at ${existing.url}${openBrowser(existing.url)}.`);
    return 0;
  }

  const server = join(here, 'radio.mjs');
  const app = resolve(here, '..', 'app');
  if (!existsSync(server) || !existsSync(join(app, 'bundle.js'))) {
    console.log(`Conduct Radio isn't built: expected ${server} and ${app}/bundle.js.`);
    return 1;
  }

  mkdirSync(dataDir, { recursive: true });
  const log = openSync(logFile, 'a');
  const serverArgs = [server, '--app', app, '--state', stateFile, '--no-open', '--idle-exit', flag('--idle-exit') ?? '30'];
  serverArgs.push('--port', flag('--port') ?? '5274');
  const root = flag('--root');
  if (root) serverArgs.push('--root', root);
  const child = spawn(process.execPath, serverArgs, { detached: true, stdio: ['ignore', log, log] });
  child.unref();

  // Wait for the server to say it's listening, then check it answers.
  for (let waited = 0; waited < 6_000; waited += 100) {
    await sleep(100);
    const state = readState();
    if (state && state.pid === child.pid && (await healthy(state))) {
      const opened = openBrowser(state.url);
      console.log(`Conduct Radio is running at ${state.url}${opened}. Press Tune in to start the music.`);
      return 0;
    }
    if (child.exitCode !== null) break;
  }
  console.log(`Conduct Radio didn't start. Its output is in ${logFile}`);
  return 1;
}

async function stop(): Promise<number> {
  const state = readState();
  if (!state || !alive(state.pid)) {
    try {
      unlinkSync(stateFile);
    } catch {
      /* nothing to clean */
    }
    console.log('Conduct Radio is not running.');
    return 0;
  }
  process.kill(state.pid, 'SIGTERM');
  for (let waited = 0; waited < 3_000; waited += 100) {
    await sleep(100);
    if (!alive(state.pid)) {
      console.log('Conduct Radio stopped.');
      return 0;
    }
  }
  console.log(`Conduct Radio (pid ${state.pid}) didn't stop within 3s.`);
  return 1;
}

async function status(): Promise<number> {
  const state = await running();
  if (!state) {
    console.log('Conduct Radio is not running. Start it with /conduct-radio:radio');
    return 0;
  }
  const minutes = Math.round((Date.now() - state.startedAt) / 60_000);
  console.log(`Conduct Radio is running at ${state.url} (pid ${state.pid}, up ${minutes} min).`);
  return 0;
}

const commands: Record<string, () => Promise<number>> = { start, open: start, stop, status };
const run = commands[command];
if (!run) {
  console.log(`Unknown command "${command}". Use start, stop or status.`);
  process.exit(1);
}
process.exit(await run());
