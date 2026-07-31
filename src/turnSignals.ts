import type { Effort, Shape, ToolKind } from './types';

/**
 * CC-12 — how a raw assistant line becomes the three musical axes.
 *
 * Two callers read the same signals off the same JSONL shape for different
 * reasons: the hook reads the *latest* line every turn (`extractUsage`), and
 * playback reads *every* line of a finished session (`transcriptSignals`). The
 * classification has to agree between them or a session sounds different live
 * than it does rendered, so it lives here rather than in either one.
 *
 * No Node imports — the browser playground shares this.
 */

export type { Effort, Shape, ToolKind } from './types';

/** One content block of an assistant message, as far as we care about it. */
export interface ContentBlock {
  type?: string;
  name?: string;
}

/** Tool names → the three families that actually sound different. */
export function classifyTool(name: string): ToolKind | null {
  if (/^(Read|NotebookRead|Glob|Grep|WebFetch|WebSearch)$/.test(name)) return 'read';
  if (/^(Edit|Write|NotebookEdit|MultiEdit)$/.test(name)) return 'write';
  if (/^(Bash|BashOutput|KillShell|Task|Agent|Skill)$/.test(name)) return 'exec';
  // MCP tools are namespaced `mcp__server__method`; treat them as execution.
  if (name.startsWith('mcp__')) return 'exec';
  return null;
}

const EFFORTS = new Set<string>(['high', 'max', 'xhigh']);

/** Read the transcript's top-level `.effort`, rejecting anything unrecognized. */
export const asEffort = (value: unknown): Effort | null =>
  typeof value === 'string' && EFFORTS.has(value) ? (value as Effort) : null;

/**
 * Reduce a turn's content blocks to the shape of the work and the tool family.
 *
 * Whichever kind of block dominated decides how the turn is played. Measured
 * against a real transcript, thinking and `tool_use` never appear in the same
 * assistant turn (0 of 367), so in practice this is a clean signal rather than a
 * close vote — but the tie-break order (tool > think > text) is fixed so the two
 * callers can never disagree on a turn that does mix them.
 *
 * `text` is the fallback: a turn with no blocks at all is prose by default.
 */
export function classifyBlocks(blocks: readonly ContentBlock[]): {
  shape: Shape;
  tool: ToolKind | null;
} {
  let think = 0;
  let tool = 0;
  let text = 0;
  const tools: ToolKind[] = [];

  for (const block of blocks) {
    if (block?.type === 'thinking') think++;
    else if (block?.type === 'tool_use') {
      tool++;
      const kind = typeof block.name === 'string' ? classifyTool(block.name) : null;
      if (kind) tools.push(kind);
    } else if (block?.type === 'text') text++;
  }

  let shape: Shape = 'text';
  if (tool >= think && tool >= text && tool > 0) shape = 'tool';
  else if (think >= text && think > 0) shape = 'think';

  return { shape, tool: tools[0] ?? null };
}
