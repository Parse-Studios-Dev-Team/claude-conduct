import { readFileSync } from 'node:fs';
import type { ExtractOptions, Usage } from './types';

/**
 * Default Claude context window (tokens) used when a model-specific size isn't
 * configured via {@link ExtractOptions.contextWindows}. All current Claude
 * models are 200k; per-model overrides exist mainly for the 1M-token beta and
 * for future tuning (see CC-8).
 */
export const DEFAULT_CONTEXT_WINDOW = 200_000;

const EMPTY: Usage = { tokens: 0, contextPct: 0, model: null };

/** Coerce an unknown JSON value to a finite, non-negative number; otherwise 0. */
function toCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function clamp(n: number, min: number, max: number): number {
  return n < min ? min : n > max ? max : n;
}

/** Resolve the context-window size (tokens) for a model, honoring overrides. */
function resolveContextWindow(model: string | null, options?: ExtractOptions): number {
  const table = options?.contextWindows;
  if (model && table) {
    const exact = table[model];
    if (typeof exact === 'number') return exact;
    for (const key of Object.keys(table)) {
      const value = table[key];
      if (typeof value === 'number' && model.startsWith(key)) return value;
    }
  }
  return options?.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW;
}

/** Shape of the transcript fields we read off an `assistant` line. */
interface AssistantLine {
  type: 'assistant';
  isSidechain?: boolean;
  message?: {
    model?: unknown;
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
 * Pure core: derive a {@link Usage} snapshot from raw JSONL transcript text.
 *
 * No I/O, so it is safe (and cheap) to unit-test with inline strings. Prefer
 * {@link extractUsage} when you have a path on disk.
 */
export function extractUsageFromString(content: string, options?: ExtractOptions): Usage {
  const line = findLatestAssistantLine(content);
  if (!line) return { ...EMPTY };

  const message = line.message ?? {};
  const model = typeof message.model === 'string' ? message.model : null;
  const usage = message.usage ?? {};

  const input = toCount(usage.input_tokens);
  const output = toCount(usage.output_tokens);
  const cacheCreation = toCount(usage.cache_creation_input_tokens);
  const cacheRead = toCount(usage.cache_read_input_tokens);

  const tokens = input + output;
  const totalInput = input + cacheCreation + cacheRead;
  const window = resolveContextWindow(model, options);
  const contextPct = window > 0 ? clamp((totalInput / window) * 100, 0, 100) : 0;

  return { tokens, contextPct, model };
}

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
  let content: string;
  try {
    content = readFileSync(transcriptPath, 'utf8');
  } catch {
    return { ...EMPTY };
  }
  return extractUsageFromString(content, options);
}
