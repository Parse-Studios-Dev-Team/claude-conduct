# Stems (CC-4)

The daemon plays a set of **loopable audio stems** that stack from a light
ensemble to a full one. This doc is the spec for producing/obtaining them and
how to wire them in. The *loader* is built (`src/audio/loadStems.ts`); what
remains is the audio itself — a commission-vs-license decision.

## What the daemon expects

| requirement | value |
| ----------- | ----- |
| count & order | **6 mono stems**, cumulative by intensity: `piano → strings → woodwinds → brass → percussion → pad` |
| roles | stems 1–5 are the **ensemble** layers (added as `ensembleSize` climbs); stem 6 is the **richness/pad** layer (driven by `richness`) |
| key / tempo / bars | **identical** across all six; each a whole number of bars |
| loop | **seamless** — the end must join the start with no click |
| any subset | must sound **intentional/consonant** — mix & master them together |
| format | **WAV** (PCM 8/16/24/32-bit or float32/64). Stereo is downmixed to mono; any sample rate is resampled to the daemon's (44.1 kHz default) |

The tier → layer mapping lives in `src/audio/tierGains.ts`; the default gain for
the pad at `richness` 0/1/2 is `0 / 0.6 / 1.0`.

## Wiring them in

Put the files in a directory and point config or the env at it:

```jsonc
// conduct.config.json
{ "stemsDir": "stems" }        // relative paths resolve from the project dir
```

or, when running the daemon directly:

```bash
CONDUCT_STEMS_DIR=./stems npm run daemon
```

**Order** is by filename (lexical), so prefix them `01-…`, `02-…`. To set the
order explicitly, add a manifest:

```json
// stems/stems.json
{ "files": ["piano.wav", "strings.wav", "woodwinds.wav", "brass.wav", "percussion.wav", "pad.wav"] }
```

If the directory is missing or has fewer than 6 stems, the daemon logs a warning
and falls back to the synth placeholders — it never fails to start.

## Preview the format

`npm run export-stems [dir]` writes the current synth placeholders as WAVs plus a
`stems.json`, so you have a concrete template (and can hear the layering):

```bash
npm run export-stems ./stems-preview
CONDUCT_STEMS_DIR=./stems-preview npm run daemon   # loads them through the real path
```

## Where to get real stems

1. **License a layered / "adaptive music" pack** (fastest) — same-key/tempo
   multitracks built to layer. Search "adaptive music stems", "vertical layering
   music", "multitrack loop pack" on Splice, Soundstripe, Artlist, Envato, or
   game-audio asset stores. Check the license permits redistribution (this repo
   is public).
2. **Commission a composer** (best fit) — brief: *"6 orchestral stems, same
   key+tempo, seamless loop, cumulative from solo piano to full ensemble."*
   Fiverr / SoundBetter.
3. **Compose them yourself** in a DAW (GarageBand / Logic / Reaper / Ableton),
   export each track as a stem.

> Licensing note: if the audio ships in this public repo, it needs a license
> allowing redistribution. Otherwise keep `stems/` out of git and load locally.
