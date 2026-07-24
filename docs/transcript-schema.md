# Claude Code transcript schema (CC-1 spike findings)

Resolves the CC-1 open question: *"Exact JSONL schema at `transcript_path`."*
Confirmed empirically against a live `claude-opus-4-8` session on
`2026-07-24` (Claude Code transcript format — **verify again if it drifts**,
don't assume from memory).

## Location

```
~/.claude/projects/<url-encoded-project-dir>/<session_id>.jsonl
```

The project-dir slug is the absolute project path with `/` → `-`
(e.g. `-Users-brandonmcghee-Documents-Development-scratch-claude-conduct`).
Hooks also receive the path directly as `transcript_path`, so we don't have to
reconstruct it — but the layout above is how `scripts/inspect.ts` finds the
newest live session.

## Line format

One JSON object per line (JSONL). The file is **append-only and grows live**
during a session. Top-level `.type` values observed:

| `.type`           | carries usage? | notes                                   |
| ----------------- | -------------- | --------------------------------------- |
| `assistant`       | **yes**        | `.message.usage`, `.message.model`      |
| `user`            | no             | user turns                              |
| `attachment`      | no             | pasted/attached content                 |
| `ai-title`        | no             | auto-generated title                    |
| `custom-title`    | no             | user-set title                          |
| `last-prompt`     | no             |                                         |
| `queue-operation` | no             |                                         |

Other top-level keys seen: `uuid`, `parentUuid`, `sessionId`, `timestamp`,
`cwd`, `gitBranch`, `version`, `isSidechain`, `requestId`, `userType`,
`permissionMode`, `promptId`, `toolUseResult`, …

## The `assistant` line (what we read)

```jsonc
{
  "type": "assistant",
  "isSidechain": false,          // true ⇒ a sub-agent turn — EXCLUDE from session state
  "message": {
    "role": "assistant",
    "model": "claude-opus-4-8",  // raw model id
    "usage": {
      "input_tokens": 2,                    // fresh (uncached) input this turn
      "output_tokens": 410,                 // generated this turn
      "cache_creation_input_tokens": 1175,  // written to cache this turn
      "cache_read_input_tokens": 100584,    // read from cache this turn
      "server_tool_use": { "web_search_requests": 0, "web_fetch_requests": 0 },
      "service_tier": "standard",
      "cache_creation": { "ephemeral_1h_input_tokens": 1175, "ephemeral_5m_input_tokens": 0 },
      "iterations": [ /* per-iteration copies; top-level is authoritative */ ]
    }
  }
}
```

## Gotchas the extractor must handle (all covered by tests)

1. **The file usually ends on a non-`assistant` line** (`ai-title`, `user`, …).
   → Scan **newest-first** for the last `assistant` line, don't read the tail.
2. **Sidechain / sub-agent turns** (`isSidechain: true`) appear inline and can be
   large. → Exclude them so a subagent can't hijack the session reading.
3. **Partial / usage-less assistant remnants** can appear. → Skip assistant lines
   with no `.message.usage`.
4. **Corrupt / half-written lines** (the file is written live). → `JSON.parse`
   per line inside try/catch; skip failures.
5. **Zero assistant turns** (fresh session). → Return `{tokens:0, contextPct:0, model:null}`.

## Derived signals (see `src/extractUsage.ts`)

- `tokens = input_tokens + output_tokens` — the *latest* turn's fresh work.
  Cache read/creation excluded so a big file read doesn't look like a big turn.
- `contextPct = (input_tokens + cache_creation_input_tokens + cache_read_input_tokens) / contextWindow * 100`,
  clamped to `[0,100]` — current context-window occupancy (`contextWindow`
  defaults to 200k, overridable per model).
- `model` — raw `.message.model`.
