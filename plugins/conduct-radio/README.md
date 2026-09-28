# Conduct Radio

*A Claude Code plugin by [Parse Studios](https://parsestudios.com).*

Lo-fi focus music that levels up as Claude works. It follows every Claude Code
session on your machine and plays in your browser. It starts as a simple beat,
and every token Claude writes brings in more of the band: a bass line, richer
chords, a melody, strings. It all stays in key.

## Install

```
/plugin marketplace add Parse-Studios-Dev-Team/claude-conduct
/plugin install conduct-radio@parse-studios
```

It needs Node 18+ on your `PATH` and a browser. There's nothing else to
install: the plugin ships prebuilt.

## Use

| command | does |
| --- | --- |
| `/conduct-radio:radio` | starts the radio if it isn't running, and opens it |
| `/conduct-radio:radio stop` | stops it |
| `/conduct-radio:radio status` | says whether it's running, and where |
| `/conduct-radio:radio tape [title]` | saves Claude's last finished turn as a tape you can play back |

Press **Tune in** on the page (browsers only play audio after a click). Nothing
running? **Demo** climbs all eight levels in two minutes, and **Replay** plays
back any past session.

**Tapes.** When Claude finishes something you'd like to hear again, run
`/conduct-radio:radio tape`, optionally with a title (`tape Brandon's fix`
works as typed, no quoting needed). It saves that turn to
`~/.claude/conduct-radio/tapes/`, and it's under **Replay → Tapes** from then
on. Like the radio itself, a tape holds token counts and event kinds, never
what was said.

The server runs in the background on `localhost:5274` (or the next free port),
and shuts itself down after 30 minutes with no page open.

## Privacy

It reads `~/.claude/projects` and listens on `127.0.0.1` only. What reaches the
page is event kinds, sizes and token counts, never conversation text; session
titles are the only text shown. State and logs live in the plugin's data
directory (`~/.claude/plugins/data/conduct-radio-…/`).

## License

[MIT](LICENSE) © 2026 [Parse Studios](https://parsestudios.com). The Parse Studios
name and palm mark aren't covered by the license.
