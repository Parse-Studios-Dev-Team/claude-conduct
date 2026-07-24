#!/usr/bin/env tsx
/**
 * Dev tool: print the {@link Usage} snapshot for a transcript on disk.
 *
 *   tsx scripts/inspect.ts <path-to-transcript.jsonl>
 *
 * With no argument it prints usage for the most-recently-modified transcript in
 * ~/.claude/projects (handy for eyeballing the current live session).
 */
import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { extractUsage } from '../src/extractUsage';

function newestTranscript(root: string): string | null {
  let best: { path: string; mtime: number } | null = null;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.jsonl')) {
        const mtime = statSync(full).mtimeMs;
        if (!best || mtime > best.mtime) best = { path: full, mtime };
      }
    }
  };
  try {
    walk(root);
  } catch {
    return null;
  }
  return best ? (best as { path: string }).path : null;
}

const arg = process.argv[2];
const path = arg ?? newestTranscript(join(homedir(), '.claude', 'projects'));

if (!path) {
  console.error('No transcript found. Pass a path explicitly.');
  process.exit(1);
}

console.log('transcript:', path);
console.log('usage:', extractUsage(path));
