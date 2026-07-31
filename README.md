# Claude Conduct

Ambient background music that scales with Claude Code **session complexity** — a
small ensemble for light turns, fuller orchestration as token/context usage and
model tier climb. Peripheral audio feedback so you don't have to watch a
statusline.

> Personal Claude Code plugin. v1 uses fixed-key, layered **stems** (not live
> generative composition) — more buildable, and it sounds better at this scope.

## Try it

**Hear it in two commands** — no hooks, no Claude Code session needed:

```bash
npm install
npm run demo
```

That walks the ensemble from solo piano up to the full orchestra and back through
your speakers, so you can hear the crossfades. (Audio uses the `speaker` package,
installed automatically; add `-- --silent` to just watch the sequence.)

**Score your real sessions:**

```bash
npm run setup   # build + register the hooks in .claude/settings.json
```

Then run Claude Code in this repo and check `/hooks`. The music thickens as
token/context usage climbs, and fades on quiet turns. It plays **synth
placeholder tones** until you add real stems — see [`docs/stems.md`](docs/stems.md).
Set `"mute": true` in `conduct.config.json` (or remove the hooks) to stop it.

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
| **CC-6** | Hook wiring + config | ✅ done — hooks → pipeline → daemon, config (mute/volume/thresholds), fast bundled entrypoint |
| **CC-7** | CLI controls (`/conduct …`) | ✅ done — status/mute/unmute/volume, live via the daemon |
| **CC-8** | Model-tier timbre mapping | ✅ done — high-end (Opus) signature layer, independent of tokens |

## Install & activate (CC-6)

```bash
npm install
npm run setup          # = build (bundle entrypoints) + install-hooks (idempotent)
```

Then verify with **`/hooks`** in Claude Code. The single entrypoint
`dist/conduct-hook.mjs` handles all four events (dispatching on
`hook_event_name`):

- **SessionStart** → launches the playback daemon (detached)
- **PostToolUse / Stop** → `extractUsage → mapToTier → recordTier → sendTier`
- **SessionEnd** → stops the daemon and clears the session's state

It runs as compiled JS (~40ms), not `tsx`, because it fires on every tool use.
If the daemon isn't running, the hook still exits 0 — **it never blocks a turn.**

### Configuration

Copy `conduct.config.example.json` to `conduct.config.json` (git-ignored) and
edit. `$CONDUCT_CONFIG` overrides the path.

| key | effect |
| --- | ------ |
| `mute` | drive every turn to silence |
| `volume` | daemon master gain `0..1` |
| `silent` | force headless output (no `speaker`) |
| `crossfadeMs` | tier crossfade time |
| `idleTimeoutMs` | stop the daemon after this long with no hook activity (default 15min; `0` = never) |
| `tier` | threshold overrides for `mapToTier` |
| `contextWindows` | per-model context sizes for `extractUsage` |
| `stemsDir` | directory of real WAV stems to play (else synth placeholders) |

> **Orphaned daemons:** the daemon is detached, so it survives Claude Code
> exiting. `SessionEnd` normally stops it, but that hook doesn't run when the
> window is closed, the process is `kill -9`'d, or it crashes — which used to
> leave music looping with no session behind it. The hook now stamps
> `conduct.heartbeat` every turn and the daemon exits once that goes stale
> (`idleTimeoutMs`). `/conduct stop` still stops it immediately.

> **Audio:** the daemon plays synth placeholder tones out of the box. To use real
> audio, drop a directory of 6 WAV stems in and set `stemsDir` — see
> [`docs/stems.md`](docs/stems.md) for the spec, or run `npm run export-stems` to
> get a template you can preview. Tuned stems land with CC-4.

### Controls — `/conduct` (CC-7)

Once hooks are installed, control playback from within Claude Code:

| command | effect |
| ------- | ------ |
| `/conduct status` | daemon state, mute/volume, current session usage + tier |
| `/conduct mute` | silence output — **persists** (in config) until unmuted |
| `/conduct unmute` | resume; restores volume and the current tier |
| `/conduct volume <n>` | set volume live — `0–1` or a percent like `80` |

`mute` and `volume` apply to the running daemon immediately (and persist in
`conduct.config.json`). Same commands work from a shell: `npm run conduct -- status`.

## Modes (CC-13)

`mode` decides what a session is for. Live and playback are not two settings on
one engine — they want opposite things. Live has to be ignorable and legible;
playback has to be interesting and has no legibility requirement at all.

| `mode` | while you work | when the session ends |
| --- | --- | --- |
| `live` (default) | presence + cadence | — |
| `playback` | silent | renders a piece |
| `both` | presence + cadence | renders a piece |
| `off` | silent | — |

Every mode still **records**, because the recording is what playback is made of.

```jsonc
{
  "mode": "playback",
  "playback": {
    "seconds": 90,      // target length regardless of how long the session ran
    "sweepStale": true, // also render sessions whose SessionEnd never fired
    "keep": 20          // renders are ~15 MB each — this is the real disk cost
  }
}
```

Renders land in `<runtime>/renders/<session_id>.wav`, beside the recordings.
`SessionEnd` triggers them, spawned detached so the hook returns immediately.

`SessionEnd` doesn't always fire — closing the window or killing the process
skips it, which is the same gap the idle watchdog exists for. So playback mode
also sweeps for recordings that have settled without producing a render, rather
than trusting one event. Render anything on demand with:

```bash
npm run conduct -- render          # newest recording
```

## Live mode (CC-11)

By default live playback is **presence + cadence**, not a continuous gradient:

- **Silence means it's your turn.** Music plays while Claude is working and stops
  when it hands back. That inversion is the point — when the drone is always on,
  starting and stopping says nothing; this way every transition carries a bit.
- **A cadence marks the end of a turn.** The ensemble resolves to root-and-fifth,
  holds `cadenceHoldMs`, then fades out. Deliberately small: an ending that
  swells is a fanfare, and a fanfare every turn is something you mute.
- **Three coarse intensity steps**, not six, so a long grind still sounds unlike
  a quick answer without the music becoming a second statusline for context you
  can already see.

The useful case is when you're *not* looking: you alt-tab away, and the music
tells you whether it's still going. It also has to coexist with whatever you're
already listening to, which a drone competing with Spotify never could.

Set `live.mode` to `gradient` for the original always-on mapping:

```json
{ "live": { "mode": "gradient" } }
```

Recording is unaffected by either choice — it always stores the full gradient, so
CC-10 has the whole arc to render from.

## Recording & playground (CC-9)

Every session writes a timeline — one line per turn — to
`<runtime>/recordings/<session_id>.jsonl`, finalized with a summary at
`SessionEnd`:

```jsonl
{"t":1785088448966,"tok":1783,"ctx":60.4,"model":"claude-opus-5","tier":{"e":5,"r":2,"s":1},"out":1153,"ef":"high","sh":"tool","tl":"exec","end":true}
{"type":"summary","version":2,"turns":4,"durationMs":150,"peakTier":{"e":5,"r":2,"s":1}, ...}
```

Recording is independent of playback — a muted session still records the tier it
*would* have played, so muting never flattens the timeline. Turn it off or change
retention under `recordings` in the config.

**Format v2 (CC-12)** adds the axes that make turns sound different from each
other, so playback never has to go back to Claude Code's own transcript:
`out` (output tokens alone), `ef` (reasoning effort), `sh` (`think`/`tool`/`text`),
`tl` (`read`/`write`/`exec`) and `end` (`stop_reason: end_turn`). Absent axes are
omitted rather than written as `null`. v1 recordings still load — they just carry
no axes, and `render-session` falls back to the transcript for them.

Then replay and tune it by ear:

```bash
npm run playground
```

This bundles a local static app and serves it on `:5273`. Load a session, hear it
played back through the same voices the daemon uses, and move the thresholds
*while it plays* — the timeline re-scores instantly, because `mapToTier` is
imported from `src/`, not reimplemented. Export writes a `conduct.config.json`
the live engine loads unchanged.

### The score panel

Under the transport, a live readout of **what the engine is playing right now**:
the chord the sustained layers spell, every voice with its current pitch, and the
bell's position in its figure.

| shows | meaning |
| ----- | ------- |
| `Dmaj7` | the chord the *sustained* layers spell — struck voices are melody, not harmony |
| `D major` | the drones are mid-drift and the stack has no chord name; it says the key instead |
| `F♯4 → E4` | that voice is crossfading between two drift pitches |
| bell figure | the eight strikes, with the one currently sounding lit |

It's derived from `driftWeight` and the voice table in `src/audio/synth.ts`, not
tracked separately — so it can't disagree with what you hear. Gains come off the
mixer, so meters show the mix *mid-crossfade*, not the tier that was requested.

### Session labels

The picker lists sessions by date and opening prompt rather than by UUID:

```
Jul 26, 05:46 PM — Ok so lets enable it and test it with our current chat.
```

Recordings stay numbers-only ([`recorder.ts`](src/recorder.ts)) — copying
conversation text into them would duplicate the transcript and age badly. Instead
[`sessionTitle.ts`](src/sessionTitle.ts) looks the session id up in Claude Code's
own transcripts (`~/.claude/projects/<project>/<session-id>.jsonl`) and reads the
first real user prompt, so labels work retroactively for recordings you already
have. Nothing leaves the machine; the excerpt is served only to the local page.

Prose is preferred over a slash command even when the command came first — a
session that opens with `/conduct start` is better identified by the question
asked two turns later. Sessions whose transcript has been deleted keep their id.

Recordings are found automatically: the playground checks the project-local
`.claude/recordings` and the user-scope `~/.claude/conduct/<project>/recordings`,
preferring whichever actually has sessions. Override with `--recordings <dir>`.

Flags: `--port <n>` (or `$PORT`), `--no-open`, `--recordings <dir>`.

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
| `timbre` | `0–1` | `1` for high-end models (Opus) — a distinct signature layer, independent of token count (CC-8) |

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
