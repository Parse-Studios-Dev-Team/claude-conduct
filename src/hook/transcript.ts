import { readdirSync, statSync, existsSync, type Dirent } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Claude Code encodes a project's transcript dir by replacing non-alphanumerics with `-`. */
export function projectSlug(baseDir: string): string {
  return baseDir.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Best-effort: the newest transcript `.jsonl` for this project (falling back to
 * the newest across all projects). Used by `/conduct status` to report current
 * session usage; `null` when none is found.
 */
export function newestTranscript(baseDir: string): string | null {
  const root = join(homedir(), '.claude', 'projects');
  const scoped = join(root, projectSlug(baseDir));
  return newestJsonl(existsSync(scoped) ? scoped : root);
}

function newestJsonl(dir: string): string | null {
  const found: Array<{ path: string; mtime: number }> = [];
  const walk = (d: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.jsonl')) {
        try {
          found.push({ path: full, mtime: statSync(full).mtimeMs });
        } catch {
          /* skip unreadable */
        }
      }
    }
  };
  walk(dir);
  if (found.length === 0) return null;
  return found.reduce((newest, f) => (f.mtime > newest.mtime ? f : newest)).path;
}
