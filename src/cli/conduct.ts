import { readFileSync } from 'node:fs';
import { loadConfig, updateConfig } from '../hook/config';
import { resolvePaths, type ConductPaths } from '../hook/paths';
import { isDaemonRunning, startDaemon, stopDaemon } from '../hook/daemonControl';
import { newestTranscript } from '../hook/transcript';
import { sendCommand } from '../daemon/client';
import { parseCommand } from '../daemon/command';
import { extractUsage } from '../extractUsage';
import { renderSessionToFile, pruneRenders } from '../renderStore';
import { listRecordings } from '../recorder';
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
  /** Injectable for tests; defaults to the real process controls. */
  startDaemon?: typeof startDaemon;
  stopDaemon?: typeof stopDaemon;
  isDaemonRunning?: typeof isDaemonRunning;
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

/** Newest recording in the directory, or `null` when there are none. */
function newestRecording(recordingsDir: string): string | null {
  return listRecordings(recordingsDir)[0]?.sessionId ?? null;
}

function helpText(): string {
  return [
    'Usage: /conduct <command>',
    '',
    '  start            begin playback for this session (nothing plays until you do)',
    '  stop             stop playback and release the audio device',
    '  status           show daemon state, mute/volume, session usage + tier',
    '  mute             silence output (persists until unmute)',
    '  unmute           resume output, starting playback if it is not running',
    '  volume <n>       set volume (0–1, or a percent like 80)',
    '  render [session] render a finished session as a piece (newest if omitted)',
  ].join('\n');
}

/**
 * Resolve the tier the daemon should be on right now: prefer the live session's
 * usage, falling back to whatever was last written to the command file.
 */
function tierNow(
  paths: ConductPaths,
  baseDir: string,
  find: (b: string) => string | null,
  config: ReturnType<typeof loadConfig>,
): Tier | undefined {
  const transcript = find(baseDir);
  if (transcript) {
    return mapToTier(extractUsage(transcript, { contextWindows: config.contextWindows }), config.tier);
  }
  return currentTier(paths) ?? undefined;
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
  const start = deps.startDaemon ?? startDaemon;
  const stop = deps.stopDaemon ?? stopDaemon;
  const running = deps.isDaemonRunning ?? isDaemonRunning;
  const command = (argv[0] ?? 'status').toLowerCase();

  switch (command) {
    case 'status':
      return { output: status(paths, baseDir, find), exitCode: 0 };

    case 'start': {
      const config = loadConfig(paths.configPath);
      const already = running(paths.pidPath);
      if (!already) start(paths, config);
      // Seed the tier so playback opens on the current layer, not from silence.
      const tier = tierNow(paths, baseDir, find, config);
      sendCommand(paths.commandPath, { tier, volume: config.mute ? 0 : config.volume }, now());

      if (already) {
        return { output: `Already playing${tier ? ` — ${fmtTier(tier)}` : ''}.`, exitCode: 0 };
      }
      const muted = config.mute ? ' (muted — `/conduct unmute` to hear it)' : '';
      return {
        output: `Playing${tier ? ` — ${fmtTier(tier)}` : ''}${muted}.`,
        exitCode: 0,
      };
    }

    case 'stop': {
      if (!running(paths.pidPath)) {
        return { output: 'Not playing.', exitCode: 0 };
      }
      stop(paths);
      return { output: 'Stopped. `/conduct start` to bring it back.', exitCode: 0 };
    }

    case 'mute': {
      updateConfig(paths.configPath, { mute: true });
      sendCommand(paths.commandPath, { volume: 0 }, now()); // immediate silence if running
      return { output: 'Muted — persists until `/conduct unmute`.', exitCode: 0 };
    }

    case 'unmute': {
      updateConfig(paths.configPath, { mute: false });
      const config = loadConfig(paths.configPath);
      // Asking to hear it implies wanting it running, so this starts playback too.
      const wasRunning = running(paths.pidPath);
      if (!wasRunning) start(paths, config);
      const tier = tierNow(paths, baseDir, find, config);
      // Restore volume and resume the right layer in one atomic command.
      sendCommand(paths.commandPath, { tier, volume: config.volume }, now());
      const started = wasRunning ? '' : ' Started playback.';
      return { output: `Unmuted (volume ${config.volume}).${started}`, exitCode: 0 };
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

    case 'render': {
      // CC-13 on demand: render a session that already ended, or the newest
      // recording if none is named. Synchronous here on purpose — a CLI the user
      // typed *should* block and then tell them where the file went, which is the
      // opposite of the hook's constraint.
      const config = loadConfig(paths.configPath);
      const requested = argv[1];
      const target = requested ?? newestRecording(paths.recordingsDir);
      if (!target) {
        return { output: `No recordings found under ${paths.recordingsDir}.`, exitCode: 1 };
      }

      const outcome = renderSessionToFile(paths.recordingsDir, paths.rendersDir, target, {
        seconds: config.playback.seconds,
        projectDir: baseDir,
      });
      if (!outcome) {
        return {
          output: `Nothing renderable for "${target}" — no recorded turns, and no transcript to fall back on.`,
          exitCode: 1,
        };
      }
      pruneRenders(paths.rendersDir, config.playback.keep);
      return {
        output: [
          `Rendered ${outcome.turns} turns (${outcome.source}) → ${outcome.path}`,
          `${(outcome.durationMs / 1000).toFixed(1)}s`,
        ].join('  '),
        exitCode: 0,
      };
    }

    case 'help':
    case '--help':
    case '-h':
      return { output: helpText(), exitCode: 0 };

    default:
      return { output: `Unknown command "${command}".\n\n${helpText()}`, exitCode: 1 };
  }
}
