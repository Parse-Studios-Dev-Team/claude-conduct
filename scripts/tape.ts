#!/usr/bin/env tsx
/**
 * Cut a tape: save a stretch of a session's work so the radio can play it back.
 * Installed as a plugin, the same thing is `/conduct-radio:radio tape [title]`.
 *
 *   npm run tape                                  # the last turn of the latest session
 *   npm run tape -- --title "Smooth sky"
 *   npm run tape -- --session 3713e275 --from 2026-09-27T01:02:03Z [--to …]
 *
 *   --session <id>   a session id, or the start of one (default: the latest session)
 *   --from, --to     ISO times or epoch ms (default: the last turn you prompted)
 *   --finished       the last turn that has ended, rather than one still going
 *   --title <name>   what to call it (default: the session's title)
 *   --root <dir>     a different ~/.claude/projects
 *   --tapes <dir>    a different shelf (default: ~/.claude/conduct-radio/tapes)
 *
 * The radio lists the shelf under Replay → Tapes. A tape holds event kinds,
 * sizes and token counts — never conversation text.
 */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { DEFAULT_SHELF, cutTape, tapeMinutes } from '../src/shelf';

const args = process.argv.slice(2);
const flag = (name: string): string | null => {
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] ?? null) : null;
};

function time(value: string | null): number | null {
  if (value === null) return null;
  const n = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
  if (Number.isFinite(n)) return n;
  console.error(`Can't read "${value}" as a time — use ISO (2026-09-27T01:02:03Z) or epoch ms.`);
  process.exit(1);
}

const result = cutTape({
  root: resolve(flag('--root') ?? join(homedir(), '.claude', 'projects')),
  shelf: resolve(flag('--tapes') ?? DEFAULT_SHELF),
  session: flag('--session'),
  from: time(flag('--from')),
  to: time(flag('--to')),
  title: flag('--title'),
  finished: args.includes('--finished'),
});
if ('error' in result) {
  console.error(result.error);
  process.exit(1);
}

const { tape, file } = result;
const out = tape.out >= 1000 ? `${(tape.out / 1000).toFixed(1)}k` : String(tape.out);
console.log(
  `Saved “${tape.title}”: ${tapeMinutes(tape)} min of ${tape.project}, ${out} output tokens, ${tape.events.length} events.`,
);
console.log(`  ${file}`);
console.log('Play it from the radio: Replay → Tapes.');
