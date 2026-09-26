# Conduct Radio — design

*Conduct Radio is made by [Parse Studios](https://parsestudios.com).*

Why the radio works the way it does. Several decisions here exist because an
earlier, more obvious version failed, so read the reasons before changing the
decisions.

## The premise

**The more you do, the better the music gets.** Usage is a reward, not a
readout. Output tokens earn levels, and each level adds a layer of a lo-fi band.
Nothing in the session can make the music worse: failures, cache misses and
expensive turns aren't heard at all.

### What failed first

The first radio was a sonification. Every tool call played a phrase on its own
instrument, failures bent in as dissonant "blue notes", cache misses detuned
the pad against everything else, the pad was built from sawtooths, and the
bells were inharmonic FM. It measured fine and sounded harsh, for reasons you
can see in that list:

- **Dissonance was a feature.** Blue notes and cache "haze" were *designed* to
  clash, to mean something. A focus soundtrack can't afford to mean something
  by sounding wrong.
- **Nothing repeated.** Each event produced fresh notes, so there was never a
  loop to settle into. A groove comes from repetition.
- **The timbres were bright.** Sawtooths and inharmonic FM are exactly what
  lo-fi filters out.
- **The framing was a meter.** "Here's what that turn cost" is the opposite of
  "the more I do, the better it sounds".

## The band

A four-bar loop, one chord per bar, in one major key (default F), at a fixed
tempo (default 76). Keys, bass and drums play from the first beat, because a
lo-fi beat is the starting point, not the reward.

| level | tokens | adds |
| --- | --- | --- |
| 1 | 0 | drums, Rhodes chords (7ths), bass roots |
| 2 | 1.5k | a bass line |
| 3 | 5k | rootless 9th voicings, a rhythmic comp |
| 4 | 12k | a lead motif |
| 5 | 24k | string pad, shaker, open hat |
| 6 | 40k | an arpeggio, 11ths and 13ths, more progressions |
| 7 | 65k | ghost notes, walking bass on the turnaround |
| 8 | 100k | a harmonized lead, the borrowed iv and ♭VII |

Thresholds count output tokens from every session and subagent since tuning in.
They're paced so a busy session climbs the ladder in about half an hour. The
build-speed setting scales them (×1.6 / ×1 / ×0.5).

**Levels arrive on phrase boundaries, one at a time.** However many levels a
turn earns, the band plays in one per four bars, each preceded by a
four-sixteenth snare fill and a soft swell. Tuning into a busy afternoon
therefore sounds like a build, not a switch flipping.

**Melodies are motifs.** At each new progression the lead picks a two-bar
rhythm and a contour. It plays the motif twice, varies its ending, then rests
for two bars. The pitches are realized against each bar's chord, so the same
motif fits every chord it meets.

**Loops last.** A progression plays for 16 bars (about 50 s) before changing.
Newly unlocked progressions play first, so levelling up is also heard as new
harmony.

## No clashes, by construction

Every chord carries a **safe set**: its chord tones plus the tensions that sit
well over it (9th and 13th on major sevenths and dominants, 9th and 11th on
minor sevenths). Melody, arpeggio and flourish notes come *only* from the safe
set of the chord sounding when they play, and bass notes only from its chord
tones. Avoid notes (the 4th over a major chord, any ♭9) aren't in the
vocabulary, so a clash can't be generated.

Two refinements, each found by a test:

- **iii takes its 11th, not its 9th.** The 9th of iii is a semitone outside the
  key (F♯ over Em7 in C).
- **No semitones between neighbouring keys voices.** Dm11's 9th and ♭3 are a
  semitone apart as pitch classes, and voice leading put them adjacent. It's now
  a hard rule, and the voicing search spreads those notes a seventh apart
  instead.

`test/radioArranger.test.ts` plays 4,000 beats in three keys across every level
and state and checks every note against its chord.

## The flow

- **Claude working:** the whole band at the earned level.
- **Your turn:** a four-note Rhodes climb through the current chord, then, at
  the next two-bar boundary, the band lays back. Lead and arpeggio rest, the
  comp simplifies, and the drums soften. **The beat never stops.** The first
  version went silent on your turn, which is exactly when you sit down to read
  and think.
- **`/compact`:** the whole mix sweeps down and opens back up into a fresh
  progression, and the sky rises to dawn.
- **Context fill:** the sky's time of day (`(context/100)^0.6`, keyed to the
  4–6% that fresh sessions already hold), plus a warmth filter that closes from
  8.5 kHz to 4.6 kHz by night. It's a late-night tone, never a penalty.
- **The sky follows the session you last prompted.** With two sessions working,
  following the last speaker made it flicker.

## The sound

Only harmonic timbres: a 1:1 FM Rhodes, sines and triangles. Everything is
low-passed, the drums are saturated and dusty, and the whole mix runs through a
tape-style soft clipper and a gentle compressor. **Tape wobble is one LFO shared
by every pitched voice**, so the band drifts *together* and never out of tune
with itself. The first version's "haze" detuned one voice against the rest,
which is the definition of a clash. Keys, pad and arpeggio duck slightly on
every kick (the lo-fi pump). Vinyl crackle sits after the warmth filter, so a
sweep doesn't take it with it.

### Measured, not guessed

The mix was balanced by tapping the output into an analyser, with the speakers
disconnected:

- The first pass had the **sub band 31 dB over the mids**, with kick and bass
  burying the Rhodes. Bus gains (`BUS` in `app/engine.ts`) put it at about
  +6–10 dB at level 1.
- Across the climb: RMS −19.6 → −16 dB (fuller, only ~3 dB louder), spectral
  centroid 229 → 350 Hz (brighter as layers enter), the 5–10 kHz band 26–38 dB
  under the mids (never harsh), peaks around −5 dBFS, and no clipping.

## Why transcripts, not hooks

Hooks fire once per tool call, a **median 13.5 s apart**. Claude Code writes
the transcript a content block at a time, sub-second. The radio tails
`~/.claude/projects/**/*.jsonl` directly, so it needs no install and hears
sessions that were already running. The reader (`src/events.ts`) handles
the transcript's quirks, each pinned by a test:

- `end_turn` is stamped on the thinking line, 2–11 s before the reply, so only
  a visible block ends a turn.
- Usage repeats on every block, so it's counted once per message.
- Subagents are attributed to their parent.
- Compactions, titles and interrupts are all recognized.

## Files

| file | runs in | job |
| --- | --- | --- |
| `src/events.ts` | server | transcript lines → events + session state |
| `src/tail.ts` | server | follows every transcript, subagents too; polls, never `fs.watch` |
| `src/models.ts` | server | context-window sizes and effort levels |
| `src/conductor.ts` | browser | events → levels, flow state, moments to mark |
| `src/arranger.ts` | browser | levels + flow → the band, one beat at a time |
| `src/harmony.ts` | both | chords, safe sets, voice leading, the sky's day |
| `src/demo.ts` | browser | a scripted afternoon that climbs the whole ladder |
| `app/engine.ts` | browser | Web Audio synthesis |
| `app/sky.ts` | browser | the canvas, the Parse Studios palm on its horizon included |
| `app/brand.ts` | browser | Parse Studios' mark and links |
| `app/main.ts` | browser | the beat clock, sources and HUD |
| `scripts/radio.ts` | server | bundles or serves prebuilt, streams (SSE), replays |
| `scripts/radio-ctl.ts` | server | the plugin's start / stop / status |
| `scripts/build-plugin.ts` | build | writes `plugins/conduct-radio/` |
