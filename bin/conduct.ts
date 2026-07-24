#!/usr/bin/env node
/**
 * Claude Conduct control CLI (CC-7): `conduct status | mute | unmute | volume <n>`.
 * Invoked directly (`npm run conduct -- status`) or via the `/conduct` slash
 * command (`.claude/commands/conduct.md` → `dist/conduct.mjs`).
 */
import { runConduct } from '../src/cli/conduct';

const baseDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const { output, exitCode } = runConduct(process.argv.slice(2), baseDir);
if (output) console.log(output);
process.exit(exitCode);
