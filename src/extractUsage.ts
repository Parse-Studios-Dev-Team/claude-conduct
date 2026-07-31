import { readFileSync } from 'node:fs';
import { asEffort, classifyBlocks, type ContentBlock } from './turnSignals';
import type { ExtractOptions, TurnFacts, Usage } from './types';

/**
 * Fallback context window (tokens) for a model we don't recognize. Deliberately
 * conservative: guessing small overstates `contextPct`, which pushes the music
 * *up* a tier rather than leaving it silent.
 */
export const DEFAULT_CONTEXT_WINDOW = 200_000;

/**
 * Known context-window sizes, matched by model-id prefix (longest wins).
 *
 * The original 200k blanket default is wrong for every current frontier model —
 * they are 1M — which inflated `contextPct` by 5× and pinned the ensemble at its
 * ceiling for most of a session. Haiku is the one current model still at 200k.
 *
 * Config `contextWindows` overrides anything here.
 */
export const KNOWN_CONTEXT_WINDOWS: Record<string, number> = {
  'claude-fable': 1_000_000,
  'claude-mythos': 1_000_000,
  'claude-opus-4-6': 1_000_000,
  'claude-opus-4-7': 1_000_000,
  'claude-opus-4-8': 1_000_000,
  'claude-opus-5': 1_000_000,
  'claude-sonnet-4-6': 1_000_000,
  'claude-sonnet-5': 1_000_000,
  'claude-haiku-4-5': 200_000,
};

const EMPTY: TurnFacts = {
  tokens: 0,
  contextPct: 0,
  model: null,
  outputTokens: 0,
  effort: null,
  shape: 'text',
  tool: null,
  endsTurn: false,
};

/** Coerce an unknown JSON value to a finite, non-negative number; otherwise 0. */
function toCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function clamp(n: number, min: number, max: number): number {
  return n < min ? min : n > max ? max : n;
}

/** Longest-prefix (or exact) lookup of `model` in a window table. */
function lookupWindow(model: string, table: Record<string, number>): number | null {
  const exact = table[model];
  if (typeof exact === 'number') return exact;

  let best: number | null = null;
  let bestLen = -1;
  for (const key of Object.keys(table)) {
    const value = table[key];
    if (typeof value === 'number' && key.length > bestLen && model.startsWith(key)) {
      best = value;
      bestLen = key.length;
    }
  }
  return best;
}

/**
 * Resolve the context-window size (tokens) for a model. Config overrides win,
 * then {@link KNOWN_CONTEXT_WINDOWS}, then the caller's default, then
 * {@link DEFAULT_CONTEXT_WINDOW}.
 */
export function resolveContextWindow(model: string | null, options?: ExtractOptions): number {
  if (model) {
    const configured = options?.contextWindows ? lookupWindow(model, options.contextWindows) : null;
    if (configured !== null) return configured;

    const known = lookupWindow(model, KNOWN_CONTEXT_WINDOWS);
    if (known !== null) return known;
  }
  return options?.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW;
}

/** Shape of the transcript fields we read off an `assistant` line. */
interface AssistantLine {
  type: 'assistant';
  isSidechain?: boolean;
  effort?: unknown;
  message?: {
    model?: unknown;
    stop_reason?: unknown;
    content?: unknown;
    usage?: {
      input_tokens?: unknown;
      output_tokens?: unknown;
      cache_creation_input_tokens?: unknown;
      cache_read_input_tokens?: unknown;
    } | null;
  };
}

/**
 * Find the most recent *main-thread* assistant turn that carries a `usage`
 * block. Scans lines newest-first and skips, in order:
 *
 * - blank lines,
 * - lines that don't parse as JSON (partial writes, corruption),
 * - non-`assistant` lines (the file frequently ends on `ai-title`, `user`, …),
 * - sub-agent turns (`isSidechain === true`), so a subagent's big turn can't
 *   hijack the reading of the main session, and
 * - assistant lines with no `usage` (e.g. an interrupted/streaming remnant).
 */
function findLatestAssistantLine(content: string): AssistantLine | null {
  const lines = content.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = lines[i]?.trim();
    if (!raw) continue;

    let obj: unknown;
    try {
      obj = JSON.parse(raw);
    } catch {
      continue;
    }

    if (typeof obj !== 'object' || obj === null) continue;
    const line = obj as Partial<AssistantLine> & Record<string, unknown>;
    if (line.type !== 'assistant') continue;
    if (line.isSidechain === true) continue;
    if (!line.message || line.message.usage == null) continue;

    return line as AssistantLine;
  }
  return null;
}

/**
 * Pure core: derive the full {@link TurnFacts} for the latest turn from raw
 * JSONL transcript text.
 *
 * No I/O, so it is safe (and cheap) to unit-test with inline strings. Prefer
 * {@link extractTurnFacts} when you have a path on disk, or
 * {@link extractUsageFromString} when the three usage fields are all you want.
 *
 * One pass over one line: the hook runs this on every tool use, so reading the
 * axes for the recorder (CC-12) must not cost a second parse.
 */
export function extractTurnFactsFromString(
  content: string,
  options?: ExtractOptions,
): TurnFacts {
  const line = findLatestAssistantLine(content);
  if (!line) return { ...EMPTY };

  const message = line.message ?? {};
  const model = typeof message.model === 'string' ? message.model : null;
  const usage = message.usage ?? {};

  const input = toCount(usage.input_tokens);
  const output = toCount(usage.output_tokens);
  const cacheCreation = toCount(usage.cache_creation_input_tokens);
  const cacheRead = toCount(usage.cache_read_input_tokens);

  // Work done *this turn*. `cache_creation_input_tokens` counts freshly-written
  // context, which is real work and is where nearly all input lands once prompt
  // caching is warm (`input_tokens` drops to 1–2). Leaving it out made this axis
  // a measure of reply length alone. `cache_read_input_tokens` is deliberately
  // excluded: it is the standing context being re-read, which `contextPct`
  // already tracks.
  const tokens = input + output + cacheCreation;
  const totalInput = input + cacheCreation + cacheRead;
  const window = resolveContextWindow(model, options);
  const contextPct = window > 0 ? clamp((totalInput / window) * 100, 0, 100) : 0;

  const blocks: ContentBlock[] = Array.isArray(message.content)
    ? (message.content as ContentBlock[])
    : [];
  const { shape, tool } = classifyBlocks(blocks);

  return {
    tokens,
    contextPct,
    model,
    outputTokens: output,
    effort: asEffort(line.effort),
    shape,
    tool,
    endsTurn: message.stop_reason === 'end_turn',
  };
}

/**
 * Pure core: derive a {@link Usage} snapshot from raw JSONL transcript text.
 *
 * The narrow view of {@link extractTurnFactsFromString}, kept because the tier
 * mapper (CC-2) reads exactly these three fields and nothing else.
 */
export function extractUsageFromString(content: string, options?: ExtractOptions): Usage {
  const { tokens, contextPct, model } = extractTurnFactsFromString(content, options);
  return { tokens, contextPct, model };
}

/**
 * Read a transcript file and return the full {@link TurnFacts} for the latest
 * main-thread assistant turn.
 *
 * Like {@link extractUsage}, a missing or unreadable file yields the empty
 * snapshot rather than throwing.
 */
export function extractTurnFacts(transcriptPath: string, options?: ExtractOptions): TurnFacts {
  let content: string;
  try {
    content = readFileSync(transcriptPath, 'utf8');
  } catch {
    return { ...EMPTY };
  }
  return extractTurnFactsFromString(content, options);
}

/**
 * Whether a turn carried any usable signal at all (CC-15).
 *
 * `extractUsage` returns its empty snapshot for two very different situations:
 * a transcript we simply haven't caught up with yet, and a transcript whose
 * *format we cannot read*. Claude Code hosted inside another editor is the real
 * case — Cursor writes `{role, message:{content}}` with no `usage`, no `model`
 * and no `stop_reason`, so there is nothing to extract no matter how the parser
 * is written.
 *
 * Treating that as "tier 0" recorded 25,470 turns of pure silence across two
 * sessions — 96% of all recorded history on one machine — and drove playback to
 * silence rather than leaving it alone. A turn with no model *and* no tokens is
 * not a quiet turn; it is a turn we failed to read, and the two must not be
 * confused.
 */
export const isReadable = (usage: Usage): boolean =>
  usage.model !== null || usage.tokens > 0;

/**
 * Read a Claude Code transcript JSONL file and return the current {@link Usage}
 * snapshot for the session.
 *
 * A missing or unreadable file yields the empty snapshot
 * (`{ tokens: 0, contextPct: 0, model: null }`) rather than throwing — a hook
 * on the Claude Code turn must never fail just because the transcript isn't
 * where we expected it.
 *
 * @param transcriptPath Absolute path to the session `.jsonl` (Claude Code
 *   passes this to hooks as `transcript_path`).
 */
export function extractUsage(transcriptPath: string, options?: ExtractOptions): Usage {
  const { tokens, contextPct, model } = extractTurnFacts(transcriptPath, options);
  return { tokens, contextPct, model };
}
