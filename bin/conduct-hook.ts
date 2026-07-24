#!/usr/bin/env node
/**
 * Claude Conduct hook entrypoint (CC-6). Registered in `settings.json` for
 * `SessionStart`, `PostToolUse`, `Stop`, and `SessionEnd` — one command handles
 * all four, dispatching on `hook_event_name` from the JSON on stdin.
 *
 * Contract: **never block the turn.** Everything is wrapped so the process
 * always exits 0, fast, whatever happens (bad input, missing daemon, I/O error).
 */
import { handleEvent, realDeps, type HookInput } from '../src/hook/handler';
import { loadConfig } from '../src/hook/config';
import { resolvePaths } from '../src/hook/paths';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  let raw = '';
  try {
    raw = await readStdin();
  } catch {
    return;
  }

  try {
    const input = (raw.trim() ? JSON.parse(raw) : {}) as HookInput;
    const baseDir = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const paths = resolvePaths(baseDir);
    const config = loadConfig(paths.configPath);
    handleEvent(input, config, paths, realDeps);
  } catch {
    /* swallow — the turn must never be blocked by the audio hook */
  }
}

void main().finally(() => process.exit(0));
