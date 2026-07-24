# Claude Conduct

Ambient background music that scales with Claude Code **session complexity** — a
small ensemble for light turns, fuller orchestration as token/context usage and
model tier climb. Peripheral audio feedback so you don't have to watch a
statusline.

> Personal Claude Code plugin. v1 uses fixed-key, layered **stems** (not live
> generative composition) — more buildable, and it sounds better at this scope.

## How it works

```
PostToolUse / Stop hooks
  → extractUsage(transcript)     usage snapshot from the session JSONL   [CC-1 ✓]
  → mapToTier(usage)             {ensembleSize 0–5, richness 0–2}         [CC-2 ✓]
  → state check                  emit only when the tier actually changes [CC-3 ✓]
  → playback daemon              crossfades pre-made stems                [CC-5 ✓, CC-4]
```

See [`docs/roadmap.md`](docs/roadmap.md) for the ticket breakdown and
[`docs/transcript-schema.md`](docs/transcript-schema.md) for the transcript
format the extractor relies on.

## Status

| Ticket | What | State |
| ------ | ---- | ----- |
| **CC-1** | Session usage extractor (`extractUsage`) | ✅ done — pure module + tests, validated on a live session |
| **CC-2** | Tier mapping function (`mapToTier`) | ✅ done — pure, configurable thresholds, unit-tested |
| **CC-3** | State persistence (`recordTier`) | ✅ done — per-session dedupe, atomic writes, hook-safe |
| CC-4 | Stem asset pipeline (prep, not code) | pending — commission vs. license decision |
| **CC-5** | Playback daemon (crossfade engine) | ✅ done — pure click-free mixer, watched-file transport, runs on synth stems |
| CC-6 | Hook wiring + config | next (ties CC-1→3 + CC-5 together) |
| CC-7 | CLI controls (`/conduct …`) | fast-follow |
| CC-8 | Model-tier timbre mapping | future / P2 |

## Development

```bash
npm install
npm test         # node:test suite via tsx
npm run typecheck
```

Inspect the usage snapshot for any transcript (defaults to the newest live
session under `~/.claude/projects`):

```bash
npx tsx scripts/inspect.ts [path/to/transcript.jsonl]
```

### `extractUsage(transcriptPath, options?)`

Returns a `Usage` snapshot for the session's most recent main-thread turn:

```ts
import { extractUsage } from './src/extractUsage';

const usage = extractUsage(process.env.TRANSCRIPT_PATH!);
// → { tokens: 412, contextPct: 50.88, model: 'claude-opus-4-8' }
```

| field | meaning |
| ----- | ------- |
| `tokens` | fresh tokens in the latest turn (`input + output`); momentary "how much happened" |
| `contextPct` | context-window occupancy `0–100`; rises over the session |
| `model` | raw model id, or `null` when there are no assistant turns |

Never throws on a missing/unreadable/partial transcript — it returns
`{ tokens: 0, contextPct: 0, model: null }` so a hook can call it unguarded.

### `mapToTier(usage, config?)`

Pure function mapping a `Usage` snapshot to the musical `Tier` the daemon
renders. No I/O, fully deterministic, every threshold configurable:

```ts
import { extractUsage } from './src/extractUsage';
import { mapToTier } from './src/mapToTier';

mapToTier(extractUsage(process.env.TRANSCRIPT_PATH!));
// → { ensembleSize: 3, richness: 1 }
```

| field | range | driven by |
| ----- | ----- | --------- |
| `ensembleSize` | `0–5` | the stronger of latest-turn `tokens` and `contextPct`, plus a per-model bump |
| `richness` | `0–2` | `contextPct` (session depth) |

Defaults (all overridable via `config`, see `DEFAULT_TIER_CONFIG`) place the
CC-2 example inputs at: 600 tokens → `ensembleSize 1` (Haiku) / `2` (Opus);
3000 tokens → `3` / `4`; near the context limit → `{ ensembleSize: 5, richness: 2 }`.

### `recordTier(statePath, sessionId, tier, options?)`

Decides whether a tier change is worth triggering the daemon, so the same tier
never fires twice. Last-emitted tier is persisted per `session_id` at
`.claude/conduct-state.json` (atomic temp-file + rename; git-ignored).

```ts
import { recordTier, clearSession } from './src/state';

const { emit } = recordTier('.claude/conduct-state.json', sessionId, tier);
if (emit) { /* send the tier to the playback daemon */ }

// on SessionEnd:
clearSession('.claude/conduct-state.json', sessionId);
```

First call for a new session always emits; a repeat at the same tier emits
nothing and doesn't rewrite the file. Never throws — a failed persist still
returns the correct `emit` so a hook is never blocked.

## Playback daemon (CC-5)

A persistent process that loads the stems once, holds them looping, and
**crossfades** between tiers. Crossfading (rather than starting/stopping a
player per stem) is what keeps changes free of pops and clicks.

```bash
npm run daemon            # real audio if the optional `speaker` package is installed
npm run daemon -- --silent   # headless (no audio device)
```

Then drive it — this is exactly what the CC-6 hook will do, gated by `recordTier`:

```ts
import { sendTier } from './src/daemon/client';
sendTier('.claude/conduct-command.json', { ensembleSize: 3, richness: 1 });
```

**Architecture** (each piece is pure/testable in isolation):

| module | role |
| ------ | ---- |
| `audio/mixer.ts` | the crossfade engine — per-stem gains chase targets by a bounded step each frame (click-free by construction) |
| `audio/tierGains.ts` | `Tier → per-stem target gains` |
| `audio/synth.ts` | seamless placeholder stems until CC-4 delivers real ones |
| `audio/sink.ts` | output abstraction — `NullSink` (headless) or a lazily-loaded `speaker` sink |
| `daemon/conductor.ts` | mixer + sink glue; renders blocks |
| `daemon/server.ts` | the process: watches the command file, paces rendering, owns start/stop lifecycle |
| `daemon/client.ts` | `sendTier()` — atomic write of the watched command file |

Transport is a **watched JSON file** (`.claude/conduct-command.json`), consistent
with the state file and free of socket-path limits; rapid writes coalesce
harmlessly since the daemon always crossfades to the latest tier. Real audio
output is optional — `npm i speaker` to hear it; without it the daemon runs
silent. End-to-end audible tuning waits on real stems (CC-4).
