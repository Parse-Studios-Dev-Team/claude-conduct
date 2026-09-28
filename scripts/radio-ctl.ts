#!/usr/bin/env node
/**
 * radio-ctl — start, stop and check the Conduct Radio server, and cut tapes.
 * This is what the plugin's `/conduct-radio:radio` skill runs.
 *
 *   radio-ctl [start|stop|status] [--data <dir>] [--no-open] [--port <n>] [--root <dir>]
 *   radio-ctl tape [title…] [--session <id>] [--root <dir>] [--tapes <dir>]
 *   … --args-stdin    read the command and title from stdin (how the skill passes them)
 *
 * `start` reuses a running server when there is one, otherwise launches one in
 * the background, and opens the page either way. It only ever reports what it
 * verified: a server counts as running once it has published its state file
 * *and* answered `/healthz` as Conduct Radio. A pid alone proves nothing: `spawn`
 * returns one even for a process that dies a millisecond later.
 *
 * `tape` saves the session's last finished turn to the tape shelf — run from the
 * skill, the turn in progress is the command itself.
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
import { DEFAULT_SHELF, cutTape, tapeMinutes } from '../src/shelf';

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
const VALUE_FLAGS = new Set(['--data', '--port', '--root', '--idle-exit', '--session', '--tapes']);

/**
 * The words you typed after the command: a command, then (for `tape`) a title.
 *
 * The skill hands them over on stdin (`--args-stdin`), in a quoted heredoc,
 * rather than on the command line. Claude Code pastes `$ARGUMENTS` into the
 * shell unescaped, so `tape Brandon's fix` on the command line breaks the
 * command, and a `$(…)` in it would run. Typed words are never flags.
 */
function typedWords(): string[] {
  if (!args.includes('--args-stdin')) {
    return args.filter((a, i) => !a.startsWith('--') && !(i > 0 && VALUE_FLAGS.has(args[i - 1]!)));
  }
  let text = '';
  try {
    text = readFileSync(0, 'utf8').trim();
  } catch {
    /* nothing on stdin */
  }
  // Left unsubstituted, outside Claude Code: nothing was typed.
  if (text === '$ARGUMENTS') text = '';
  return text ? text.split(/\s+/) : [];
}

const positional = typedWords();
const command = (positional[0] ?? 'start').toLowerCase();

// `${CLAUDE_PLUGIN_DATA}` and `${CLAUDE_SESSION_ID}` are substituted by Claude
// Code; a literal placeholder means we're running outside it.
const substituted = (value: string | null): string | null => (value && !value.includes('${') ? value : null);
const dataDir = resolve(substituted(flag('--data')) ?? join(homedir(), '.claude', 'conduct-radio'));
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
  const tapes = flag('--tapes');
  if (tapes) serverArgs.push('--tapes', tapes);
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
  // Only a process that answers as this radio. After a crash the state file
  // outlives the server, and its pid may since belong to something else.
  const state = await running();
  if (!state) {
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

/** Save the last finished turn to the shelf, named by whatever follows `tape`. */
async function tape(): Promise<number> {
  const result = cutTape({
    root: resolve(flag('--root') ?? join(homedir(), '.claude', 'projects')),
    shelf: resolve(flag('--tapes') ?? DEFAULT_SHELF),
    // `${CLAUDE_SESSION_ID}` from the skill; without it, the latest session.
    session: substituted(flag('--session')),
    // `tape "Smooth sky"` means the title, not the quotes.
    title: positional.slice(1).join(' ').replace(/^(["'“‘])(.*)(["'”’])$/s, '$2') || null,
    finished: true,
  });
  if ('error' in result) {
    console.log(`Couldn't cut a tape: ${result.error}`);
    return 1;
  }
  const { tape: saved } = result;
  const out = saved.out >= 1000 ? `${(saved.out / 1000).toFixed(1)}k` : String(saved.out);
  // This line goes to the model. A title you typed is safe to repeat; a session
  // title is written from the conversation, so it stays out.
  const named = positional.length > 1 ? `the tape “${saved.title}”` : 'the last turn as a tape';
  console.log(`Saved ${named} (${tapeMinutes(saved)} min, ${out} output tokens). Play it on the radio under Replay → Tapes.`);
  return 0;
}

const commands: Record<string, () => Promise<number>> = { start, open: start, stop, status, tape };
const run = commands[command];
if (!run) {
  console.log(`Unknown command "${command}". Use start, stop, status or tape.`);
  process.exit(1);
}
process.exit(await run());
