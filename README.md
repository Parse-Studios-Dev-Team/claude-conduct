<p align="center">
  <a href="https://parsestudios.com"><img src="docs/parse-studios-palm.svg" alt="Parse Studios" width="120"></a>
</p>

<h1 align="center">Conduct Radio</h1>

<p align="center">
  <b>Lo-fi focus music that levels up as Claude works.</b><br>
  A Claude Code plugin by <a href="https://parsestudios.com">Parse Studios</a>.
</p>

<p align="center">
  <a href="https://github.com/Parse-Studios-Dev-Team/claude-conduct/actions/workflows/ci.yml"><img src="https://github.com/Parse-Studios-Dev-Team/claude-conduct/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-8ec9c5" alt="MIT license"></a>
</p>

---

It starts as a simple beat: boom-bap drums, Rhodes chords and a warm bass
line, with vinyl crackle underneath. Every token Claude writes moves the
track up a level, and each level brings in more of the band. It all stays
in key. The more you build, the better it sounds.

## Install

In Claude Code:

```
/plugin marketplace add Parse-Studios-Dev-Team/claude-conduct
/plugin install conduct-radio@parse-studios
```

You need Node 18+ and a browser. There's nothing else to install; the plugin
ships prebuilt.

## Use

| command | does |
| --- | --- |
| `/conduct-radio:radio` | starts the radio if it isn't running, and opens it |
| `/conduct-radio:radio stop` | stops it |
| `/conduct-radio:radio status` | says whether it's running, and where |
| `/conduct-radio:radio tape [title]` | saves Claude's last finished turn as a tape you can play back |

Press **Tune in** (browsers only play audio after a click). It follows every
Claude Code session on your machine as it happens. Nothing running?
**Demo** climbs all eight levels in two minutes, and **Replay** plays back any
past session, or a tape: a stretch of work you saved to hear again.

## The ladder

Output tokens from every session, subagents included, count toward the level
from the moment you tune in:

| level | tokens | adds |
| --- | --- | --- |
| 1 · Tuned in | start | drums, keys and bass |
| 2 · Groove | 1.5k | a moving bass line |
| 3 · Warmth | 5k | richer chords (9ths) and a busier comp |
| 4 · Melody | 12k | a lead melody |
| 5 · Strings | 24k | a string pad and a shaker |
| 6 · Sparkle | 40k | an arpeggio and new progressions |
| 7 · Pocket | 65k | ghost notes, fills and a walking bass |
| 8 · Flow state | 100k | a harmonized melody and borrowed chords |

Each level comes in at the start of the next phrase, after a small drum fill.
Levels never go down.

- **It never clashes.** Every note is drawn only from the tones that sit well
  over the chord playing at that moment. A test holds 4,000 beats, at every
  level, to that rule.
- **It flows with you.** While Claude works, you hear the whole band. When it
  hands back to you, a soft flourish plays and the band lays back, but the
  beat keeps going. `/compact` sweeps into a fresh chord progression.
- **It's a sky, too.** Context fill is the time of day, dawn to night; each
  session is a lantern on the horizon; every thousand tokens is a star.

Settings: vinyl crackle, build speed, tempo (70–88), key. Space pauses, and
media keys work.

## Privacy

The radio reads `~/.claude/projects` and listens on `127.0.0.1` only. What
reaches the page is event kinds, sizes and token counts, never conversation
text; session titles are the only text shown. Nothing leaves your machine.

## Development

```bash
npm install
npm run radio        # run from source: bundles on the fly, opens on :5274
npm test             # 400+ checks, including the no-clash rule and the shipped plugin
npm run typecheck
npm run build        # rebuild the plugin in plugins/conduct-radio/
npm run tape -- --title "Smooth sky"   # save the latest turn as a tape
```

| path | what |
| --- | --- |
| `src/` | the music, pure and seeded: transcript reader, conductor, arranger, harmony |
| `app/` | the page: Web Audio engine, the sky, the HUD |
| `scripts/` | the server, the plugin's launcher, and the plugin build |
| `plugins/conduct-radio/` | the plugin as it ships (built files are committed) |
| `.claude-plugin/` | this repo as a marketplace, `parse-studios` |
| `docs/radio.md` | the design, and the measurements behind it |

Installs copy the plugin from git with no `npm install`, so its server and page
are prebuilt and committed. `npm test` fails if they're stale.

- **Try it without installing:** `claude --plugin-dir ./plugins/conduct-radio`
- **Validate:** `claude plugin validate .`
- **Branches:** work happens on `feature/…` branches, merged into `dev` by pull
  request; `dev` is released to `main`. Both are protected: changes only by PR,
  and the `CI` check must pass. `marketplace add` reads `main`; to try another
  branch, add `Parse-Studios-Dev-Team/claude-conduct#<branch>`.

### CI and releases

[CI](.github/workflows/ci.yml) runs on every pull request and on `main` and
`dev`. It typechecks and tests on Node 18, 22 and 24, and validates the plugin
and marketplace with Claude Code. The single `CI` check it reports is what the
branch protection requires.

To release:

1. Bump `version` in `package.json` and
   `plugins/conduct-radio/.claude-plugin/plugin.json` (users only get a new
   copy when it changes), and merge to `main` through `dev`.
2. Tag `main` and push the tag: `git tag v0.1.0 && git push origin v0.1.0`.

The [release workflow](.github/workflows/release.yml) checks that the tag is on
`main` and matches both versions, reruns the checks, and publishes a GitHub
Release with the plugin attached as a zip.

[Dependabot](.github/dependabot.yml) opens weekly update PRs against `dev`. An
esbuild bump changes the built plugin, so its PR needs `npm run build` pushed to
it before it goes green.

The original hook-driven engine this grew out of (a daemon, layered stems, a
tape-deck playground) is in the repository's history, before Conduct Radio
replaced it.

## License

[MIT](LICENSE) © 2026 [Parse Studios](https://parsestudios.com)

The code is MIT-licensed. The Parse Studios name and palm mark are the studio's
brand and aren't covered by the license.
