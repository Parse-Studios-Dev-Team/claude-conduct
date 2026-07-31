#!/usr/bin/env node
/**
 * CC-13 — background render entrypoint.
 *
 *   conduct-render <session-id> [<session-id> …]
 *
 * Spawned detached by the hook on `SessionEnd` when playback mode is on. Takes
 * every path from the environment, exactly like the daemon, so it never has to
 * guess where it is running from. Exits 0 whatever happens: nobody is waiting on
 * it, and a failed render must not turn into a visible error somewhere else.
 */
import { renderSessionToFile, pruneRenders } from '../src/renderStore';

const recordingsDir = process.env.CONDUCT_RECORDINGS_DIR;
const rendersDir = process.env.CONDUCT_RENDERS_DIR;

if (!recordingsDir || !rendersDir) {
  console.error('conduct-render: CONDUCT_RECORDINGS_DIR and CONDUCT_RENDERS_DIR are required');
  process.exit(0);
}

const seconds = Number(process.env.CONDUCT_RENDER_SECONDS ?? 90);
const keep = Number(process.env.CONDUCT_RENDER_KEEP ?? 20);
const projectDir = process.env.CONDUCT_PROJECT_DIR;

for (const sessionId of process.argv.slice(2)) {
  try {
    const outcome = renderSessionToFile(recordingsDir, rendersDir, sessionId, {
      seconds: Number.isFinite(seconds) && seconds > 0 ? seconds : 90,
      projectDir,
    });
    if (outcome) {
      console.log(
        `conduct-render: ${sessionId} — ${outcome.turns} turns from ${outcome.source} → ${outcome.path}`,
      );
    } else {
      console.log(`conduct-render: ${sessionId} — nothing renderable, skipped`);
    }
  } catch (error) {
    console.error(`conduct-render: ${sessionId} failed —`, error);
  }
}

try {
  pruneRenders(rendersDir, Number.isFinite(keep) ? keep : 20);
} catch {
  /* best-effort */
}

process.exit(0);
