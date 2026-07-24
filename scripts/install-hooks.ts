#!/usr/bin/env tsx
/**
 * Register the Conduct hooks in `.claude/settings.json`, idempotently.
 *
 *   npm run install-hooks
 *
 * Merges our four event hooks into any existing settings (preserving other
 * hooks) and re-runnable safely — it first strips any prior `conduct-hook`
 * entries, then adds fresh ones. Run `npm run build` first so the bundled
 * entrypoint exists.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const COMMAND = 'node "$CLAUDE_PROJECT_DIR/dist/conduct-hook.mjs"';
const EVENTS = ['SessionStart', 'PostToolUse', 'Stop', 'SessionEnd'] as const;

type HookEntry = { type: string; command: string };
type MatcherGroup = { matcher?: string; hooks: HookEntry[] };
type Settings = { hooks?: Record<string, MatcherGroup[]> } & Record<string, unknown>;

const settingsPath = join(process.cwd(), '.claude', 'settings.json');

let settings: Settings = {};
if (existsSync(settingsPath)) {
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as Settings;
  } catch {
    console.error(`Refusing to overwrite unparseable ${settingsPath}. Fix or remove it first.`);
    process.exit(1);
  }
}

const hooks = (settings.hooks ??= {});

/** Drop any existing group that points at our entrypoint, so re-runs don't duplicate. */
const stripOurs = (groups: MatcherGroup[]): MatcherGroup[] =>
  groups
    .map((g) => ({ ...g, hooks: g.hooks.filter((h) => !h.command?.includes('conduct-hook')) }))
    .filter((g) => g.hooks.length > 0);

for (const event of EVENTS) {
  const groups = stripOurs(hooks[event] ?? []);
  const group: MatcherGroup = { hooks: [{ type: 'command', command: COMMAND }] };
  if (event === 'PostToolUse') group.matcher = '*';
  groups.push(group);
  hooks[event] = groups;
}

mkdirSync(dirname(settingsPath), { recursive: true });
writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');

console.log(`Registered Conduct hooks in ${settingsPath}.`);
if (!existsSync(join(process.cwd(), 'dist', 'conduct-hook.mjs'))) {
  console.warn('Note: dist/conduct-hook.mjs not found — run `npm run build` before starting a session.');
}
console.log('Verify with `/hooks` in Claude Code.');
