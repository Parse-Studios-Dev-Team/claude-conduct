import { readFileSync } from 'node:fs';
import { loadConfig, updateConfig } from '../hook/config';
import { resolvePaths, type ConductPaths } from '../hook/paths';
import { isDaemonRunning } from '../hook/daemonControl';
import { newestTranscript } from '../hook/transcript';
import { sendCommand } from '../daemon/client';
import { parseCommand } from '../daemon/command';
import { extractUsage } from '../extractUsage';
import { mapToTier } from '../mapToTier';
import type { Tier } from '../types';

export interface CliResult {
  output: string;
  exitCode: number;
}

export interface CliDeps {
  now?: () => number;
  /** Injectable for tests; defaults to {@link newestTranscript}. */
  findTranscript?: (baseDir: string) => string | null;
}

const fmtTier = (t: Tier): string =>
  `E${t.ensembleSize} R${t.richness}${(t.timbre ?? 0) >= 1 ? ' ✦' : ''}`;

/** The tier last sent to the daemon (from the command file), if any. */
function currentTier(paths: ConductPaths): Tier | null {
  try {
    return parseCommand(readFileSync(paths.commandPath, 'utf8'))?.tier ?? null;
  } catch {
    return null;
  }
}

function helpText(): string {
  return [
    'Usage: /conduct <command>',
    '',
    '  status           show daemon state, mute/volume, session usage + tier',
    '  mute             silence output (persists until unmute)',
    '  unmute           resume output',
    '  volume <n>       set volume (0–1, or a percent like 80)',
  ].join('\n');
}

function status(paths: ConductPaths, baseDir: string, find: (b: string) => string | null): string {
  const config = loadConfig(paths.configPath);
  const running = isDaemonRunning(paths.pidPath);
  const transcript = find(baseDir);
  const usage = transcript ? extractUsage(transcript, { contextWindows: config.contextWindows }) : null;
  const mappedTier = usage ? mapToTier(usage, config.tier) : null;
  const playing = currentTier(paths);

  const lines = [
    'Claude Conduct',
    `  daemon:  ${running ? 'running' : 'not running'}`,
    `  mute:    ${config.mute ? 'on' : 'off'}`,
    `  volume:  ${config.volume}`,
    `  stems:   ${config.stemsDir ? config.stemsDir : 'synth placeholders'}`,
    `  playing: ${playing ? fmtTier(playing) : '—'}`,
  ];
  if (usage) {
    lines.push(
      `  usage:   tok=${usage.tokens} ctx=${usage.contextPct.toFixed(0)}% ${usage.model ?? '-'}`,
      `  tier:    ${mappedTier ? fmtTier(mappedTier) : '—'}${config.mute ? '  (muted)' : ''}`,
    );
  } else {
    lines.push('  usage:   (no session transcript found)');
  }
  return lines.join('\n');
}

/**
 * Run a `/conduct` command against the project at `baseDir`. Pure of its own
 * globals (paths derive from `baseDir`); side effects are writing the config
 * file and the daemon command file.
 */
export function runConduct(argv: string[], baseDir: string, deps: CliDeps = {}): CliResult {
  const paths = resolvePaths(baseDir);
  const now = deps.now ?? Date.now;
  const find = deps.findTranscript ?? newestTranscript;
  const command = (argv[0] ?? 'status').toLowerCase();

  switch (command) {
    case 'status':
      return { output: status(paths, baseDir, find), exitCode: 0 };

    case 'mute': {
      updateConfig(paths.configPath, { mute: true });
      sendCommand(paths.commandPath, { volume: 0 }, now()); // immediate silence if running
      return { output: 'Muted — persists until `/conduct unmute`.', exitCode: 0 };
    }

    case 'unmute': {
      updateConfig(paths.configPath, { mute: false });
      const config = loadConfig(paths.configPath);
      const transcript = find(baseDir);
      const tier = transcript
        ? mapToTier(extractUsage(transcript, { contextWindows: config.contextWindows }), config.tier)
        : (currentTier(paths) ?? undefined);
      // Restore volume and resume the right layer in one atomic command.
      sendCommand(paths.commandPath, { tier, volume: config.volume }, now());
      return { output: `Unmuted (volume ${config.volume}).`, exitCode: 0 };
    }

    case 'volume': {
      const raw = argv[1];
      if (raw === undefined) {
        return { output: 'Usage: /conduct volume <n>  (0–1, or a percent like 80)', exitCode: 1 };
      }
      let value = Number(raw);
      if (!Number.isFinite(value)) {
        return { output: `Not a number: "${raw}"`, exitCode: 1 };
      }
      if (value > 1) value /= 100; // accept 0–100 percents
      value = Math.max(0, Math.min(1, value));
      updateConfig(paths.configPath, { volume: value });
      const config = loadConfig(paths.configPath);
      if (!config.mute) sendCommand(paths.commandPath, { volume: value }, now());
      const suffix = config.mute ? ' (muted — applies on unmute)' : '';
      return { output: `Volume set to ${value}${suffix}.`, exitCode: 0 };
    }

    case 'help':
    case '--help':
    case '-h':
      return { output: helpText(), exitCode: 0 };

    default:
      return { output: `Unknown command "${command}".\n\n${helpText()}`, exitCode: 1 };
  }
}
