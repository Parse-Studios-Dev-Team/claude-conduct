/**
 * The radio's vocabulary, shared by the server (which reads transcripts into
 * events) and the browser (which plays them). Types only, and Node-free, so the
 * browser bundle can import it without dragging in the filesystem.
 */

/** Reasoning effort, as a transcript's top-level `.effort` records it. */
export type Effort = 'high' | 'max' | 'xhigh';

/** Tool families that get their own instrument. */
export type ToolFamily = 'read' | 'web' | 'write' | 'exec' | 'agent' | 'mcp' | 'other';

export interface EventBase {
  /** Session this belongs to. Subagent events carry their *parent's* id. */
  session: string;
  /** Epoch ms, from the transcript line. */
  at: number;
  /** Came from a subagent's transcript rather than the main thread. */
  sub?: boolean;
}

export type RadioEvent = EventBase &
  (
    | { type: 'prompt' }
    | { type: 'think'; tokens: number }
    | { type: 'text'; tokens: number }
    | { type: 'tool'; family: ToolFamily; name: string; tokens: number }
    | { type: 'result'; error: boolean; size: number }
    | {
        type: 'usage';
        model: string | null;
        effort: Effort | null;
        out: number;
        /** Input plus cache writes: context this turn had to pay full price for. */
        fresh: number;
        /** Cache reads: context re-read at a tenth of the price. */
        cached: number;
        contextPct: number;
      }
    | { type: 'end'; interrupted?: boolean }
    | { type: 'compact'; preTokens: number }
    | { type: 'title'; title: string }
  );

export type RadioEventType = RadioEvent['type'];

/** What the radio knows about one session at any moment. */
export interface SessionState {
  session: string;
  /** Basename of the working directory. */
  project: string;
  title: string | null;
  model: string | null;
  effort: Effort | null;
  contextPct: number;
  /** Output tokens across the whole session, main thread and subagents. */
  outTotal: number;
  /** `model` = waiting on Claude, `tool` = a tool is running, `idle` = your turn. */
  activity: 'model' | 'tool' | 'idle';
  /** Name of the tool running, when `activity` is `tool`. */
  tool: string | null;
  /** Epoch ms of the last line seen. */
  lastAt: number;
  compactions: number;
}

