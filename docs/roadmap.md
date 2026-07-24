# Roadmap

Source of truth: Linear project **Claude Conduct** (team `PAR`).
Tickets 1–6 are MVP; 7–8 are fast-follows/future.

## Dependency order

```
CC-1  usage extractor  ── blocking spike; everything sits behind it
  │
  ├─► CC-2  tier mapping (pure)
  │        │
  ├─► CC-3  state persistence (dedupe per session_id)
  │        │
  ▼        ▼
CC-6  hook wiring + config  ◄── CC-5 playback daemon ◄── CC-4 stem assets (prep)
  │
  ├─► CC-7  CLI controls (fast-follow)
  └─► CC-8  model-tier timbre (future / P2)
```

CC-4 (compose/license stems) and CC-5 (daemon) are a parallel track to the
CC-1→2→3 data pipeline; CC-6 wires the two tracks together.

## Tickets

| ID | Ticket | Pri | Summary |
| -- | ------ | --- | ------- |
| **CC-1** (PAR-68) | Session usage extractor | High | ✅ `extractUsage(path)` → `{tokens, contextPct, model}`. Pure module, unit-tested, validated live. |
| CC-2 (PAR-69) | Tier mapping function | Med | ✅ Pure `mapToTier({tokens, contextPct, model})` → `{ensembleSize: 0–5, richness: 0–2}`. Configurable thresholds, unit-tested. |
| CC-3 (PAR-70) | State persistence | Med | ✅ `recordTier` / `clearSession` — last-emitted tier per `session_id`, emit only on change, atomic writes, hook-safe. `.claude/conduct-state.json`. |
| CC-4 (PAR-71) | Stem asset pipeline | Med | Prep — 5–6 loopable stems, same key/tempo/bars, any subset consonant. **Loader + format now built** (`loadStems`, `CONDUCT_STEMS_DIR`/`stemsDir`, `docs/stems.md`, `export-stems`); only the audio (commission vs. license) remains. |
| CC-5 (PAR-72) | Playback daemon | Med | ✅ Persistent process; loads stems once, crossfades on tier-change command (~1–2s, no pops). Pure click-free mixer, watched-file transport, synth placeholder stems, optional `speaker` output. |
| CC-6 (PAR-73) | Hook wiring + config | Med | ✅ Wire `PostToolUse`/`Stop`/`SessionStart`/`SessionEnd` → extractor → mapper → state → daemon. Config (mute/volume/thresholds), fast bundled entrypoint, `install-hooks`. Fails silently if daemon down. |
| CC-7 (PAR-74) | CLI controls | Low | ✅ `/conduct status\|mute\|unmute\|volume <n>` (CLI + slash command). Mute/volume persist in config and apply live via an extended command protocol. |
| CC-8 (PAR-75) | Model-tier timbre | Low | Distinct voicing when Opus is active. Future / P2. |

## CC-1 → CC-2 contract

`extractUsage` hands the tier mapper exactly:

```ts
interface Usage {
  tokens: number;      // fresh input+output tokens of the latest turn (momentary activity)
  contextPct: number;  // 0–100 context-window occupancy (rises over the session)
  model: string | null;
}
```

`DEFAULT_CONTEXT_WINDOW` (200k) is exported from `src/extractUsage.ts` for CC-2
to reuse. The two signals are intentionally orthogonal: `tokens` drives
momentary ensemble size, `contextPct` drives sustained richness.
