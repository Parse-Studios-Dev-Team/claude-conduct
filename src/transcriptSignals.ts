import { readFileSync } from 'node:fs';
import { resolveContextWindow } from './extractUsage';
import { asEffort, classifyBlocks, type ContentBlock } from './turnSignals';
import type { ExtractOptions } from './types';
import type { TurnSignals } from './sessionScore';

/**
 * CC-10 — read the *whole* signal set for every turn of a finished session.
 *
 * `extractUsage` answers "what is happening right now" for one turn, because
 * that is all a live hook needs. Rendering a session needs the opposite: every
 * turn at once, including the three signals the recorder never stored —
 * reasoning effort, the shape of the work, and which tools ran.
 *
 * All three are already in Claude Code's own transcript and cost nothing to
 * read, so a session recorded before this existed can still be rendered. Once
 * the recording format is widened (CC-12) this becomes the fallback rather than
 * the only path.
 */

interface AssistantLine {
  type?: string;
  isSidechain?: boolean;
  effort?: unknown;
  message?: {
    model?: string;
    stop_reason?: string;
    content?: ContentBlock[];
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const clamp = (n: number, lo: number, hi: number): number => (n < lo ? lo : n > hi ? hi : n);

/**
 * Parse every main-thread assistant turn of a transcript into {@link TurnSignals}.
 *
 * Sidechain (sub-agent) turns are excluded, matching `extractUsage` — they are a
 * different conversation and would double-count the session's arc.
 *
 * `tokens` is **output tokens only**, deliberately. The live mapping sums input
 * and output, but input is 97–100% cache reads in a real session, so that total
 * mostly measures how long the conversation has been going rather than how much
 * work the turn did. Output alone spans 172 → 22,848 across measured sessions.
 *
 * Never throws: an unreadable or partial transcript yields `[]`, and a
 * half-written final line is skipped, so a session can be rendered while it is
 * still being appended to.
 */
export function readTranscriptSignals(
  transcriptPath: string,
  options?: ExtractOptions,
): TurnSignals[] {
  let text: string;
  try {
    text = readFileSync(transcriptPath, 'utf8');
  } catch {
    return [];
  }
  return parseTranscriptSignals(text, options);
}

/** {@link readTranscriptSignals} against an in-memory transcript — pure, for tests. */
export function parseTranscriptSignals(
  content: string,
  options?: ExtractOptions,
): TurnSignals[] {
  const out: TurnSignals[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;

    let parsed: AssistantLine;
    try {
      parsed = JSON.parse(line) as AssistantLine;
    } catch {
      continue; // partial trailing line, or a record we don't care about
    }
    if (parsed.type !== 'assistant' || parsed.isSidechain === true) continue;

    const message = parsed.message ?? {};
    const usage = message.usage ?? {};
    const model = typeof message.model === 'string' ? message.model : null;

    const { shape, tool } = classifyBlocks(Array.isArray(message.content) ? message.content : []);

    // The standing context being re-read is what occupancy means here.
    const totalInput =
      num(usage.input_tokens) +
      num(usage.cache_read_input_tokens) +
      num(usage.cache_creation_input_tokens);
    const window = resolveContextWindow(model, options);

    out.push({
      tokens: num(usage.output_tokens),
      contextPct: window > 0 ? clamp((totalInput / window) * 100, 0, 100) : 0,
      model,
      effort: asEffort(parsed.effort),
      shape,
      tool,
      endsTurn: message.stop_reason === 'end_turn',
    });
  }

  return out;
}
