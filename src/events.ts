import { asEffort, resolveContextWindow } from './models';
import type { EventBase, RadioEvent, SessionState, ToolFamily } from './types';

/**
 * Claude Code's transcript, read as a score.
 *
 * The hooks fire once per tool call, a median 13.5s apart in real sessions —
 * too coarse to play along with. The transcript itself is written a content
 * block at a time: the prompt the instant it is sent, each thinking block,
 * each text block, each tool call and each tool result, sub-second. Tailing it
 * gives the radio a live feed with no hooks installed at all.
 *
 * {@link TranscriptReader} turns one file's lines into {@link RadioEvent}s and
 * keeps a running {@link SessionState}. It takes strings, not paths, so the
 * tailer, the replay endpoint and the tests all drive it the same way.
 *
 * **Nothing here carries conversation text.** Events carry sizes, kinds and
 * counts; the one exception is the session title, which the page shows on each
 * session's card.
 */

export type { RadioEvent, RadioEventType, SessionState, ToolFamily } from './types';

/** Tool name → family. */
export function toolFamily(name: string): ToolFamily {
  if (/^(Read|Grep|Glob|LS|NotebookRead)$/.test(name)) return 'read';
  if (/^(WebFetch|WebSearch)$/.test(name)) return 'web';
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(name)) return 'write';
  if (/^(Bash|BashOutput|KillShell|KillBash|Monitor)$/.test(name)) return 'exec';
  if (/^(Task|Agent|Skill|SendMessage)$/.test(name)) return 'agent';
  if (name.startsWith('mcp__')) return 'mcp';
  return 'other';
}

/** Rough token count for a string: four characters a token. */
const estimate = (chars: number): number => Math.max(1, Math.round(chars / 4));

const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

function timeOf(line: Record<string, unknown>, fallback: number): number {
  const ts = line.timestamp;
  if (typeof ts === 'string') {
    const ms = Date.parse(ts);
    if (Number.isFinite(ms)) return ms;
  }
  return fallback;
}

/** User text that isn't a prompt someone typed. */
function isNoise(text: string): boolean {
  return /^\s*<(local-command-stdout|local-command-stderr|local-command-caveat|system-reminder|bash-stdout|bash-stderr)/.test(
    text,
  );
}

const INTERRUPT = /^\[Request interrupted by user/;

export interface ReaderOptions {
  session: string;
  /** Set for a subagent transcript: events are attributed to the parent session. */
  sub?: boolean;
  /** Initial project name, before a line with `cwd` arrives. */
  project?: string;
  contextWindows?: Record<string, number>;
  /** Clock used for lines without a timestamp. */
  now?: () => number;
}

export class TranscriptReader {
  readonly state: SessionState;
  private readonly sub: boolean;
  private readonly contextWindows: Record<string, number> | undefined;
  private readonly now: () => number;
  private readonly seenUsage = new Set<string>();
  private readonly seenEnd = new Set<string>();
  private titleSource: 'custom' | 'ai' | 'prompt' | null = null;

  constructor(options: ReaderOptions) {
    this.sub = options.sub === true;
    this.contextWindows = options.contextWindows;
    this.now = options.now ?? Date.now;
    this.state = {
      session: options.session,
      project: options.project ?? '',
      title: null,
      model: null,
      effort: null,
      contextPct: 0,
      outTotal: 0,
      activity: 'idle',
      tool: null,
      lastAt: 0,
      compactions: 0,
    };
  }

  /** Feed one raw line. Malformed or irrelevant lines yield nothing. */
  push(raw: string): RadioEvent[] {
    const text = raw.trim();
    if (!text) return [];
    let line: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object') return [];
      line = parsed as Record<string, unknown>;
    } catch {
      return [];
    }
    return this.read(line);
  }

  private read(line: Record<string, unknown>): RadioEvent[] {
    const state = this.state;
    const at = timeOf(line, this.now());
    const base: EventBase = this.sub
      ? { session: state.session, at, sub: true }
      : { session: state.session, at };
    const out: RadioEvent[] = [];

    if (typeof line.cwd === 'string' && line.cwd) {
      const parts = line.cwd.split(/[\\/]/).filter(Boolean);
      state.project = parts[parts.length - 1] ?? state.project;
    }

    switch (line.type) {
      case 'custom-title':
        return this.retitle(line.customTitle, 'custom', base);
      case 'ai-title':
        return this.retitle(line.aiTitle ?? line.title, 'ai', base);

      case 'system': {
        if (line.subtype === 'compact_boundary') {
          const meta = line.compactMetadata as { preTokens?: unknown } | undefined;
          state.compactions += 1;
          state.contextPct = 0;
          out.push({ ...base, type: 'compact', preTokens: count(meta?.preTokens) });
        } else if (line.subtype === 'stop_hook_summary' && !this.sub && state.activity !== 'idle') {
          // The Stop hook ran: the turn is over even if no `end_turn` line said
          // so (a turn that ended on a tool call, or one we joined midway).
          state.activity = 'idle';
          state.tool = null;
          out.push({ ...base, type: 'end' });
        }
        break;
      }

      case 'user': {
        if (line.isMeta === true || line.isCompactSummary === true) break;
        const message = line.message as { content?: unknown } | undefined;
        const content = message?.content;

        if (typeof content === 'string') {
          if (isNoise(content)) break;
          out.push(...this.prompt(content, base));
          break;
        }
        if (!Array.isArray(content)) break;

        let prompted = false;
        for (const block of content as Array<Record<string, unknown>>) {
          if (block?.type === 'tool_result') {
            state.activity = 'model';
            state.tool = null;
            const size = JSON.stringify(block.content ?? '').length;
            out.push({ ...base, type: 'result', error: block.is_error === true, size });
          } else if (block?.type === 'text' && typeof block.text === 'string' && !prompted) {
            if (isNoise(block.text)) continue;
            prompted = true;
            out.push(...this.prompt(block.text, base));
          }
        }
        break;
      }

      case 'assistant': {
        const message = line.message as
          | {
              id?: unknown;
              model?: unknown;
              stop_reason?: unknown;
              usage?: Record<string, unknown>;
              content?: unknown;
            }
          | undefined;
        if (!message) break;
        const id = typeof message.id === 'string' ? message.id : `${at}`;
        const model = typeof message.model === 'string' && message.model !== '<synthetic>' ? message.model : null;

        // Claude Code repeats the whole message's usage on every block's line.
        // Count it once.
        if (message.usage && !this.seenUsage.has(id)) {
          this.seenUsage.add(id);
          const usage = message.usage;
          const input = count(usage.input_tokens);
          const created = count(usage.cache_creation_input_tokens);
          const cached = count(usage.cache_read_input_tokens);
          const outTokens = count(usage.output_tokens);
          const prompt = input + created + cached;
          const effort = asEffort(line.effort);

          state.outTotal += outTokens;
          if (!this.sub) {
            if (model) state.model = model;
            if (effort) state.effort = effort;
            if (prompt > 0) {
              const window = resolveContextWindow(model ?? state.model, this.contextWindows);
              state.contextPct = Math.min(100, (prompt / window) * 100);
            }
          }
          out.push({
            ...base,
            type: 'usage',
            model: model ?? state.model,
            effort,
            out: outTokens,
            fresh: input + created,
            cached,
            contextPct: state.contextPct,
          });
        }

        const blocks = Array.isArray(message.content) ? (message.content as Array<Record<string, unknown>>) : [];
        let visible = false;
        for (const block of blocks) {
          if (block?.type === 'thinking' || block?.type === 'redacted_thinking') {
            const chars = typeof block.thinking === 'string' ? block.thinking.length : 0;
            state.activity = 'model';
            out.push({ ...base, type: 'think', tokens: chars > 0 ? estimate(chars) : 0 });
          } else if (block?.type === 'text') {
            visible = true;
            const chars = typeof block.text === 'string' ? block.text.length : 0;
            state.activity = 'model';
            out.push({ ...base, type: 'text', tokens: estimate(chars) });
          } else if (block?.type === 'tool_use') {
            visible = true;
            const name = typeof block.name === 'string' ? block.name : 'tool';
            state.activity = 'tool';
            state.tool = name;
            out.push({
              ...base,
              type: 'tool',
              family: toolFamily(name),
              name,
              tokens: estimate(JSON.stringify(block.input ?? {}).length),
            });
          }
        }

        // `end_turn` is stamped on *every* line of the message, including the
        // thinking line written seconds before the reply. Ending there would
        // ring the "your turn" chime while Claude is still writing — so only a
        // visible block can end a turn.
        if (message.stop_reason === 'end_turn' && visible && !this.seenEnd.has(id)) {
          this.seenEnd.add(id);
          state.activity = 'idle';
          state.tool = null;
          out.push({ ...base, type: 'end' });
        }
        break;
      }
    }

    if (out.length > 0 || line.type === 'user' || line.type === 'assistant') {
      state.lastAt = Math.max(state.lastAt, at);
    }
    return out;
  }

  private prompt(text: string, base: EventBase): RadioEvent[] {
    const state = this.state;
    if (INTERRUPT.test(text)) {
      if (state.activity === 'idle') return [];
      state.activity = 'idle';
      state.tool = null;
      return [{ ...base, type: 'end', interrupted: true }];
    }
    state.activity = 'model';
    state.tool = null;
    const events: RadioEvent[] = [{ ...base, type: 'prompt' }];
    // A prompt is the fallback title, until Claude Code names the session.
    if (this.titleSource === null && !this.sub) {
      const title = text.replace(/\s+/g, ' ').trim().slice(0, 80);
      if (title && !title.startsWith('<')) {
        this.titleSource = 'prompt';
        state.title = title;
        events.push({ ...base, type: 'title', title });
      }
    }
    return events;
  }

  private retitle(value: unknown, source: 'custom' | 'ai', base: EventBase): RadioEvent[] {
    if (this.sub || typeof value !== 'string' || !value.trim()) return [];
    // A name the user chose outranks one Claude Code generated.
    if (this.titleSource === 'custom' && source === 'ai') return [];
    const title = value.trim().slice(0, 80);
    if (title === this.state.title) return [];
    this.titleSource = source;
    this.state.title = title;
    return [{ ...base, type: 'title', title }];
  }
}

/** Parse a whole transcript at once — for replays and snapshots. */
export function readTranscript(text: string, options: ReaderOptions): { events: RadioEvent[]; state: SessionState } {
  const reader = new TranscriptReader(options);
  const events: RadioEvent[] = [];
  for (const line of text.split('\n')) events.push(...reader.push(line));
  return { events, state: reader.state };
}
