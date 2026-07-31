import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Recover a human label for a recorded session.
 *
 * A recording ([`recorder.ts`](./recorder.ts)) is deliberately numbers-only — it
 * exists to re-score a timeline, and copying conversation text into it would
 * duplicate the transcript and age badly. But that leaves the playground picker
 * listing raw UUIDs, which tells you nothing about which session you're about to
 * replay. Claude Code already keeps the transcript on disk under the same
 * session id, so the label can be recovered on demand instead of stored.
 *
 * Read-only, best-effort, and never throws: a session whose transcript has been
 * pruned simply keeps its id.
 */

/**
 * Claude Code's own project-directory naming: every run of non-alphanumerics
 * becomes a dash, and unlike {@link projectSlug} the leading dash is **kept**
 * (`/Users/me/dev` → `-Users-me-dev`). Matching it exactly is what lets us find
 * the transcript directory for a project.
 */
export function transcriptDirFor(baseDir: string, home: string = homedir()): string {
  return join(home, '.claude', 'projects', baseDir.replace(/[^a-zA-Z0-9]+/g, '-'));
}

/** Blocks Claude Code injects into the user turn that aren't the user talking. */
const WRAPPERS = [
  /<command-message>[\s\S]*?<\/command-message>/g,
  /<command-name>([\s\S]*?)<\/command-name>/g,
  /<command-args>[\s\S]*?<\/command-args>/g,
  /<system-reminder>[\s\S]*?<\/system-reminder>/g,
  /<local-command-[\s\S]*?<\/local-command-[a-z-]*>/g,
];

/** Text that is transcript plumbing rather than something the user typed. */
function isPlumbing(text: string): boolean {
  return (
    text.startsWith('(Re-invocation') ||
    text.startsWith('Caveat:') ||
    text.startsWith('<') ||
    /^\[Request interrupted/.test(text)
  );
}

/** Pull the plain text out of a message's content, which may be a string or blocks. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b): b is { type: string; text: string } =>
      typeof b === 'object' && b !== null && (b as { type?: unknown }).type === 'text',
    )
    .map((b) => b.text)
    .join(' ');
}

/**
 * How many user turns to scan before giving up. Transcripts run to megabytes and
 * this is called once per recording; a session that opens with a long run of
 * slash commands isn't worth reading to the end of.
 */
const SCAN_LIMIT = 400;

/**
 * The first thing the user actually said, cleaned up for display.
 *
 * "Actually said" is doing real work here: a transcript's `user` entries also
 * carry tool results and the output of slash commands, which would otherwise win
 * the race to be the title.
 *
 * Natural language is preferred over a slash command even when the command came
 * first, because sessions routinely open with `/conduct start` — a title of
 * "/conduct start" would be accurate and useless, while the question the user
 * asked two turns later is what they'll recognise the session by. A command is
 * still returned when the session never contains anything else.
 */
export function firstPrompt(transcriptPath: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(transcriptPath, 'utf8');
  } catch {
    return null;
  }

  let firstCommand: string | null = null;
  let scanned = 0;

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (entry.type !== 'user') continue;
    // Claude Code replays a lot of machinery through the user role. Three
    // markers separate it from something a person typed, and all three are
    // needed: `isMeta` on injected notes, `sourceToolUseID` on the output of a
    // slash command, and `toolUseResult` on a tool's return value. Without the
    // second, a `/conduct status` dump reads as prose and wins the title.
    if (entry.isMeta === true || 'sourceToolUseID' in entry || 'toolUseResult' in entry) continue;
    if (++scanned > SCAN_LIMIT) break;

    const message = entry.message as { content?: unknown } | undefined;
    let text = textOf(message?.content);
    if (!text) continue;

    // Keep the slash command itself when the turn was one, then drop the rest of
    // the wrapper noise.
    const command = /<command-name>([\s\S]*?)<\/command-name>/.exec(text)?.[1]?.trim();
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim();
    for (const pattern of WRAPPERS) text = text.replace(pattern, ' ');
    text = text.replace(/\s+/g, ' ').trim();

    if (command) {
      if (!firstCommand) {
        const firstArg = args?.split('\n')[0]?.trim();
        firstCommand = firstArg ? `${command} ${firstArg}` : command;
      }
      continue; // keep looking for something the user typed in prose
    }
    if (!text || isPlumbing(text)) continue;
    return text;
  }
  return firstCommand;
}

/** Trim a prompt to a single short line for a dropdown. */
export function toTitle(prompt: string, max = 72): string {
  const line = prompt.replace(/\s+/g, ' ').trim();
  if (line.length <= max) return line;
  // Prefer breaking at a word so the ellipsis doesn't land mid-word.
  const cut = line.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export interface SessionLabel {
  /** Short single-line label for a picker. */
  title: string;
  /** The full opening prompt, for a tooltip or detail line. */
  prompt: string | null;
}

/**
 * Label for one session id, looked up in `projectDir`'s transcripts.
 *
 * Falls back to a shortened id rather than an empty string — a picker entry with
 * no text at all is worse than a UUID.
 */
export function labelFor(sessionId: string, transcriptDir: string): SessionLabel {
  const path = join(transcriptDir, `${sessionId}.jsonl`);
  const prompt = existsSync(path) ? firstPrompt(path) : null;
  return { title: prompt ? toTitle(prompt) : fallbackTitle(sessionId), prompt };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Label for a session with no transcript. A UUID is shortened because its first
 * block is enough to identify it, but a hand-named recording like
 * `demo-full-session` already reads well — truncating it to `demo-ful` just
 * looks like a bug.
 */
function fallbackTitle(sessionId: string): string {
  return UUID.test(sessionId) ? `session ${sessionId.slice(0, 8)}` : sessionId;
}

/**
 * Every session id that has a transcript in `transcriptDir`. Used to spot
 * recordings whose transcript is gone, without stat-ing each one separately.
 */
export function transcriptIds(transcriptDir: string): Set<string> {
  try {
    return new Set(
      readdirSync(transcriptDir)
        .filter((name) => name.endsWith('.jsonl'))
        .map((name) => name.slice(0, -'.jsonl'.length)),
    );
  } catch {
    return new Set();
  }
}
