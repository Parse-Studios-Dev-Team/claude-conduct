# Conduct and token usage

Two separate questions get conflated here, so this document answers them in order:

1. **What does Conduct cost?** Essentially nothing, and specifically zero tokens.
2. **What does Conduct tell you about what *you're* spending?** Quite a lot — it's the
   only ambient read on context consumption you don't have to go looking for.

---

## 1. Conduct adds no tokens to your session

The hook runs **out of band**. It reads the session transcript (`.jsonl`) from
disk, computes two numbers, and writes a small JSON file that the audio daemon
watches. It never adds a system prompt, never injects a tool result, never
appends a message. Nothing it does enters the conversation, so it cannot change
what you are billed for inference.

What it *does* cost:

| Cost | Measured |
| --- | --- |
| One short-lived Node process per `PostToolUse` / `Stop` hook | ~50–80ms, off the critical path |
| The audio daemon, while playing | ~1.3% CPU, ~73MB RSS |
| Disk | Three small files per project under `~/.claude/conduct/<project>/` |

**The one real token cost is `/conduct` itself.** A slash command is a turn: the
command definition and its output both land in the conversation. A `status` block
is on the order of a few dozen tokens. Checking status once is noise; checking it
every turn is not free. The music exists so you don't have to ask.

---

## 2. The two numbers, in billing terms

Every turn, `extractUsage` reduces the latest assistant turn to two values.

### `tokens` — work billed *this turn*

```
tokens = input_tokens + output_tokens + cache_creation_input_tokens
```

`cache_creation_input_tokens` is included deliberately, and it is the interesting
part. Once prompt caching is warm, `input_tokens` collapses to 1–2 and nearly all
real input arrives as cache creation. Measured on a live session:

```
in=1  out=606  cache_creation=385   cache_read=55759
```

Counting only `input + output` reads that turn as 607 tokens of work when the
turn actually wrote 385 tokens of fresh context on top of a 56k prefix. Worse,
it makes the axis a measure of **reply length** rather than work.

`cache_read_input_tokens` is deliberately **excluded**. It's the standing context
being re-read — real money, but it isn't work *this* turn, and it's what
`contextPct` already tracks. Counting it in both places would double-count the
same tokens.

There's a pricing reason the split falls this way. Cache **reads** cost about
0.1× the base input rate. Cache **writes** cost *more* than base input — 1.25×
with the default 5-minute TTL, 2× with the 1-hour TTL. So `cache_creation` is the
premium-rate number and `cache_read` is the discount-rate number. Putting the
expensive one on the "how much just happened" axis is the right call: when the
ensemble jumps, something costly happened.

### `contextPct` — how full the window is

```
contextPct = (input_tokens + cache_creation + cache_read) / window × 100
```

**The window is 1,000,000 tokens** for every current frontier model — Opus 5,
Opus 4.6/4.7/4.8, Sonnet 5, Sonnet 4.6, Fable 5. Haiku 4.5 is the exception at
200,000. See `KNOWN_CONTEXT_WINDOWS` in `src/extractUsage.ts`; override per model
with `contextWindows` in `conduct.config.json`.

> This was wrong until recently. A blanket 200k default meant `contextPct` was
> inflated 5× on every frontier model, which is why sessions reported `ctx=100%`
> and the ensemble pinned at its ceiling for most of their length. If you tuned
> `contextThresholds` before that fix, retune them — the numbers they were
> calibrated against were fiction.

Measured over one long real session on a 1M window, occupancy ran **4.6% → 49.9%,
median 14%**. That shape is why the default `contextThresholds` sit low
(`[5, 12, 20, 30, 45]`): a session realistically never approaches the ceiling, so
thresholds spaced for "percent full" have to be compressed to use the whole
ladder.

---

## 3. Reading the music

| What you hear | What it means | What to do |
| --- | --- | --- |
| Ensemble jumps a level or two on one turn | That turn wrote a lot of fresh cache — a whole-file read, a wide grep, a large tool output | Nothing, if you meant it. If it surprised you, look at what the last tool call pulled in |
| Pad fades in (`R1`, ~12% context) | The window is filling at a normal rate | Nothing |
| Pad reaches full (`R2`, ~30%) | Well into the session's arc | Good moment to finish the current thread rather than start a new one |
| Full ensemble held for a long stretch | Sustained heavy turns, or the window is genuinely full | Check `/conduct status` for which axis is driving it |
| Bell (`✦`) | You're on a high-end model | Nothing — it's a signature, not a warning |
| Silence with the daemon running | `ensembleSize 0` — a fresh session below the first threshold | Nothing |

The useful skill is noticing **the jump**, not the level. A level tells you where
you are; a jump tells you the last thing you did was expensive.

---

## 4. Conducting for fewer tokens

Conduct is a gauge, not a governor — it won't reduce anything on its own. What
the gauge is good for is making these habits audible:

**Fresh cache writes are the premium. Cache reads are the bargain.** A stable
prefix that gets re-read is cheap; a prefix that keeps changing is not. Prompt
caching is a prefix match — any byte change invalidates everything after it. In
practice that means:

- **Reading a whole file when a targeted search would do** writes cache you'll
  never reuse. The ensemble jumping on a `Read` you didn't need is the signal.
- **Re-reading a file you already have** is usually free (cache read). Re-reading
  it *after editing it* is not — the edit invalidated the prefix.
- **Large tool outputs** land in context permanently. A wide `grep` with hundreds
  of hits costs the same on every subsequent turn.

**Caching pays off from the second request.** With the default 5-minute TTL, a
write costs 1.25× and a read costs 0.1×, so two turns against the same prefix
(1.25 + 0.1 = 1.35×) already beat two uncached ones (2×). Anything that keeps you
working against a stable prefix is winning.

**A fresh session resets `contextPct` but throws away the warm cache.** The first
turn of a new session pays full write cost for everything you re-establish. Worth
it when the old context is genuinely dead weight; not worth it to make the music
quieter.

---

## 5. What Conduct can't tell you

Be clear about the limits before trusting it as an instrument:

- **It reads only the latest assistant turn.** It's an instantaneous gauge, not a
  running total. There is no session-cumulative token count anywhere in Conduct.
- **It doesn't know prices.** No rates, no dollar figures, no bill. Everything
  above about cost multipliers is context for *you*; the tool only sees counts.
- **Sub-agent turns are excluded** (`isSidechain`), so a subagent doing heavy work
  is invisible to the music. That's deliberate — otherwise a subagent's big turn
  would hijack the main session's reading — but it does mean the ensemble can
  understate what a session is really spending.
- **`contextPct` only ever climbs** within a session. It's a ratchet, which has a
  consequence worth knowing: `ensembleSize` is
  `max(tokenLevel, contextLevel) + modelBump`, so once context has ratcheted past
  the token axis, per-turn work stops being audible. Late in a long session a
  242-token turn and a 148,000-token turn can render the same tier. Capping the
  context contribution (`max(tokenLevel, min(contextLevel, 2))`) fixes it, at the
  cost of the written CC-2 criterion that a near-full window should sound full
  regardless of turn size.

---

## 6. Tuning

Everything above is threshold-driven, and every threshold lives in
`conduct.config.json` — no rebuild, read fresh every turn:

```json
{
  "tier": {
    "tokenThresholds": [250, 750, 2000, 4500, 9000],
    "contextThresholds": [5, 12, 20, 30, 45],
    "richnessThresholds": [12, 30]
  },
  "contextWindows": {}
}
```

A threshold list reads as *"how many of these do you clear"*, so lower numbers
mean the level is reached sooner and the music reacts to less.

What to tune for is **movement**, not level. A tier line that steps up and down
reads as responsive; one pinned flat at the ceiling reads as broken, even though
both are working exactly as configured. Three numbers make that objective:
percentage of turns where the tier changes, how many of the six levels get used,
and percentage of turns spent at the ceiling.

See `src/mapToTier.ts` for the mapping itself and `docs/stems.md` for how tiers
become audio.
