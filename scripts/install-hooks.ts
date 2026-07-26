#!/usr/bin/env tsx
/**
 * Register the Conduct hooks and the `/conduct` command, idempotently.
 *
 *   npm run install-hooks           # this project only
 *   npm run install-hooks -- --user # every project you open
 *
 * Project scope writes `./.claude/`, keeps runtime files in the project, and only
 * works inside this repo. User scope writes `~/.claude/`, pins absolute paths
 * back to this checkout, and keeps runtime files under one shared root so other
 * repos stay clean.
 *
 * Re-runnable either way: existing `conduct-hook` entries are stripped first, so
 * nothing duplicates. Run `npm run build` first so the bundled entrypoint exists.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const EVENTS = ['SessionStart', 'PostToolUse', 'Stop', 'SessionEnd'] as const;

type HookEntry = { type: string; command: string };
type MatcherGroup = { matcher?: string; hooks: HookEntry[] };
type Settings = { hooks?: Record<string, MatcherGroup[]> } & Record<string, unknown>;

const userScope = process.argv.includes('--user');
const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const claudeDir = userScope ? join(homedir(), '.claude') : join(process.cwd(), '.claude');
const settingsPath = join(claudeDir, 'settings.json');

/**
 * In user scope every path must be absolute (the hook runs with the *other*
 * project as cwd) and the environment has to redirect config and runtime files
 * away from whatever repo happens to be open.
 */
const env = userScope
  ? `CONDUCT_CONFIG="${join(claudeDir, 'conduct.config.json')}" ` +
    `CONDUCT_STATE_DIR="${join(claudeDir, 'conduct')}" `
  : '';

const hookTarget = userScope
  ? `"${join(repoDir, 'dist', 'conduct-hook.mjs')}"`
  : '"$CLAUDE_PROJECT_DIR/dist/conduct-hook.mjs"';
const cliTarget = userScope
  ? `"${join(repoDir, 'dist', 'conduct.mjs')}"`
  : '"${CLAUDE_PROJECT_DIR:-.}/dist/conduct.mjs"';

const hookCommand = `${env}node ${hookTarget}`;

let settings: Settings = {};
if (existsSync(settingsPath)) {
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as Settings;
  } catch {
    console.error(`Refusing to overwrite unparseable ${settingsPath}. Fix or remove it first.`);
    process.exit(1);
  }
  // Back up before touching settings we didn't create.
  copyFileSync(settingsPath, `${settingsPath}.conduct-backup`);
}

const hooks = (settings.hooks ??= {});

/** Drop any existing group that points at our entrypoint, so re-runs don't duplicate. */
const stripOurs = (groups: MatcherGroup[]): MatcherGroup[] =>
  groups
    .map((g) => ({ ...g, hooks: g.hooks.filter((h) => !h.command?.includes('conduct-hook')) }))
    .filter((g) => g.hooks.length > 0);

for (const event of EVENTS) {
  const groups = stripOurs(hooks[event] ?? []);
  const group: MatcherGroup = { hooks: [{ type: 'command', command: hookCommand }] };
  if (event === 'PostToolUse') group.matcher = '*';
  groups.push(group);
  hooks[event] = groups;
}

mkdirSync(dirname(settingsPath), { recursive: true });
writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');

// The slash command has to live alongside the settings that reference it.
const commandPath = join(claudeDir, 'commands', 'conduct.md');
const commandBody = `---
description: Control Claude Conduct ambient music (start | stop | status | mute | unmute | volume <n>)
argument-hint: "[start | stop | status | mute | unmute | volume <n>]"
---

!\`${env}node ${cliTarget} $ARGUMENTS\`
`;
mkdirSync(dirname(commandPath), { recursive: true });
writeFileSync(commandPath, commandBody, 'utf8');

console.log(`Registered Conduct hooks in ${settingsPath}`);
console.log(`Installed /conduct at ${commandPath}`);
if (userScope) {
  console.log(`\nScope: every project. Entrypoints pinned to ${repoDir}`);
  console.log(`Runtime files:  ${join(claudeDir, 'conduct')}/<project-slug>/`);
  console.log(`Shared config:  ${join(claudeDir, 'conduct.config.json')}`);
} else {
  console.log('\nScope: this project only.');
}
console.log('\nNothing plays until you run `/conduct start` — the hooks only track usage.');
if (!existsSync(join(repoDir, 'dist', 'conduct-hook.mjs'))) {
  console.warn('\nNote: dist/conduct-hook.mjs not found — run `npm run build`.');
}
