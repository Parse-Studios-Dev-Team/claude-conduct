import { mapToTier, DEFAULT_TIER_CONFIG, type TierConfig } from '../src/mapToTier';
import { DEFAULT_VOICES, type VoiceSpec } from '../src/audio/synth';
import {
  parseRecording,
  summarize,
  type RecordedTurn,
  type RecordedSummary,
} from '../src/recordingFormat';
import type { Tier, Usage } from '../src/types';
import { PlaygroundEngine } from './audio';
import { readScore, type VoiceReadout } from './score';

/**
 * The playground: load a recorded session, re-score it live as you move the
 * thresholds, and hear the result.
 *
 * `mapToTier` is imported, never reimplemented — the standalone tuning bench
 * hand-copied the formula once and immediately drifted from it. One source of
 * truth for the mapping is the whole point.
 */

// --- recording ---------------------------------------------------------------

/**
 * A loaded recording plus its display name. The line shape and the parser come
 * from `src/recordingFormat.ts` — shared with the hook, so the writer and this
 * reader cannot drift apart.
 */
interface LoadedRecording {
  name: string;
  turns: RecordedTurn[];
  summary: RecordedSummary;
}

function load(name: string, text: string): LoadedRecording {
  const { turns, summary } = parseRecording(text);
  // An unfinished session has no summary line yet (it's written at SessionEnd).
  // Deriving one from the turns means a live session still shows its models and
  // duration rather than reading as "unknown".
  return { name, turns, summary: summary ?? summarize(turns) };
}

// --- state ------------------------------------------------------------------

const state = {
  recording: null as LoadedRecording | null,
  config: {
    tokenThresholds: [...DEFAULT_TIER_CONFIG.tokenThresholds],
    contextThresholds: [...DEFAULT_TIER_CONFIG.contextThresholds],
    richnessThresholds: [...DEFAULT_TIER_CONFIG.richnessThresholds],
    modelBump: { ...DEFAULT_TIER_CONFIG.modelBump },
    maxEnsemble: DEFAULT_TIER_CONFIG.maxEnsemble,
    maxRichness: DEFAULT_TIER_CONFIG.maxRichness,
    highEndModels: [...DEFAULT_TIER_CONFIG.highEndModels],
  } as TierConfig,
  voices: DEFAULT_VOICES.map((v) => ({ ...v })) as VoiceSpec[],
  index: 0,
  playing: false,
  turnMs: 700,
  volume: 0.8,
  crossfadeMs: 1500,
};

let engine: PlaygroundEngine | null = null;
let advanceTimer: number | null = null;

const usageOf = (turn: RecordedTurn): Usage => ({
  tokens: turn.tok,
  contextPct: turn.ctx,
  model: turn.model,
});

/** Re-score the whole timeline under the current thresholds. */
function scoreAll(): Tier[] {
  if (!state.recording) return [];
  return state.recording.turns.map((turn) => mapToTier(usageOf(turn), state.config));
}

let scored: Tier[] = [];

// --- DOM helpers ------------------------------------------------------------

const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const fmtTier = (t: Tier): string =>
  `E${t.ensembleSize} R${t.richness}${(t.timbre ?? 0) >= 1 ? ' ✦' : ''}`;

// --- chart ------------------------------------------------------------------

const canvas = $<HTMLCanvasElement>('tape');
const ctx2d = canvas.getContext('2d')!;

function readVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function drawChart(): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cssW = canvas.parentElement!.clientWidth;
  const cssH = Math.max(200, Math.min(320, cssW * 0.26));
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  canvas.style.height = `${cssH}px`;
  ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx2d.clearRect(0, 0, cssW, cssH);

  if (!state.recording || scored.length === 0) return;

  const brass = readVar('--brass');
  const brassWash = readVar('--brass-wash');
  const line = readVar('--line');
  const lineSoft = readVar('--line-soft');
  const faint = readVar('--text-faint');
  const good = readVar('--good');
  const accent = readVar('--text');

  const padL = 32;
  const padR = 38;
  const padT = 12;
  const padB = 22;
  const plotW = cssW - padL - padR;
  const plotH = cssH - padT - padB;
  const stepW = plotW / scored.length;
  const rowH = plotH / 6;

  ctx2d.font = '11px ui-monospace, monospace';
  ctx2d.textBaseline = 'middle';

  for (let lv = 0; lv <= 5; lv++) {
    const y = padT + plotH - lv * rowH;
    ctx2d.strokeStyle = lv === 5 ? line : lineSoft;
    ctx2d.lineWidth = 1;
    ctx2d.beginPath();
    ctx2d.moveTo(padL, Math.round(y) + 0.5);
    ctx2d.lineTo(padL + plotW, Math.round(y) + 0.5);
    ctx2d.stroke();
    ctx2d.fillStyle = faint;
    ctx2d.textAlign = 'right';
    ctx2d.fillText(`E${lv}`, padL - 8, y);
  }

  // richness band
  scored.forEach((tier, i) => {
    if (tier.richness === 0) return;
    ctx2d.fillStyle = brassWash;
    ctx2d.globalAlpha = tier.richness === 2 ? 1 : 0.5;
    ctx2d.fillRect(padL + i * stepW, padT, stepW + 0.5, plotH);
    ctx2d.globalAlpha = 1;
  });

  // stepped ensemble area
  ctx2d.beginPath();
  ctx2d.moveTo(padL, padT + plotH);
  scored.forEach((tier, i) => {
    const y = padT + plotH - tier.ensembleSize * rowH;
    ctx2d.lineTo(padL + i * stepW, y);
    ctx2d.lineTo(padL + (i + 1) * stepW, y);
  });
  ctx2d.lineTo(padL + plotW, padT + plotH);
  ctx2d.closePath();
  ctx2d.fillStyle = brass;
  ctx2d.globalAlpha = 0.22;
  ctx2d.fill();
  ctx2d.globalAlpha = 1;

  ctx2d.strokeStyle = brass;
  ctx2d.lineWidth = 2;
  ctx2d.beginPath();
  scored.forEach((tier, i) => {
    const y = padT + plotH - tier.ensembleSize * rowH;
    ctx2d.moveTo(padL + i * stepW, y);
    ctx2d.lineTo(padL + (i + 1) * stepW, y);
  });
  ctx2d.stroke();

  // context % reference line
  ctx2d.strokeStyle = good;
  ctx2d.lineWidth = 1.25;
  ctx2d.setLineDash([3, 3]);
  ctx2d.beginPath();
  state.recording.turns.forEach((turn, i) => {
    const y = padT + plotH - (turn.ctx / 100) * plotH;
    if (i === 0) ctx2d.moveTo(padL + i * stepW, y);
    else ctx2d.lineTo(padL + i * stepW, y);
  });
  ctx2d.stroke();
  ctx2d.setLineDash([]);

  // playhead
  const x = padL + state.index * stepW;
  ctx2d.strokeStyle = accent;
  ctx2d.lineWidth = 1.5;
  ctx2d.beginPath();
  ctx2d.moveTo(x, padT);
  ctx2d.lineTo(x, padT + plotH);
  ctx2d.stroke();

  ctx2d.fillStyle = faint;
  ctx2d.textAlign = 'left';
  ctx2d.fillText('turn 1', padL, cssH - padB / 2);
  ctx2d.textAlign = 'right';
  ctx2d.fillText(`turn ${scored.length}`, padL + plotW, cssH - padB / 2);
  ctx2d.textAlign = 'left';
  ctx2d.fillStyle = good;
  ctx2d.fillText('100%', padL + plotW + 6, padT);
}

// --- metrics ----------------------------------------------------------------

function updateMetrics(): void {
  if (scored.length === 0) {
    $('m-move').textContent = '—';
    $('m-levels').textContent = '—';
    $('m-ceil').textContent = '—';
    $('m-verdict').textContent = '—';
    return;
  }

  let changes = 0;
  let ceiling = 0;
  const used = new Set<number>();

  scored.forEach((tier, i) => {
    used.add(tier.ensembleSize);
    if (tier.ensembleSize === state.config.maxEnsemble) ceiling++;
    if (i > 0) {
      const prev = scored[i - 1]!;
      if (tier.ensembleSize !== prev.ensembleSize || tier.richness !== prev.richness) changes++;
    }
  });

  const movePct = scored.length > 1 ? Math.round((changes / (scored.length - 1)) * 100) : 0;
  const ceilPct = Math.round((ceiling / scored.length) * 100);

  $('m-move').textContent = `${movePct}%`;
  $('m-move-note').textContent = `${changes} of ${scored.length - 1} turns`;
  $('m-levels').textContent = String(used.size);
  $('m-ceil').textContent = `${ceilPct}%`;
  $('m-ceil-note').textContent = ceilPct > 45 ? 'no headroom left' : 'room to climb';

  const verdict = $('m-verdict');
  const note = $('m-verdict-note');
  verdict.className = 'metric-value verdict';

  if (ceilPct > 55) {
    verdict.textContent = 'Pinned';
    verdict.classList.add('is-crit');
    note.textContent = 'Sits at full ensemble too long — raise the context thresholds.';
  } else if (movePct < 18) {
    verdict.textContent = 'Flat';
    verdict.classList.add('is-warn');
    note.textContent = 'Barely reacts — lower the token thresholds.';
  } else if (movePct > 62) {
    verdict.textContent = 'Restless';
    verdict.classList.add('is-warn');
    note.textContent = 'Changing most turns; it never settles.';
  } else {
    verdict.textContent = 'Balanced';
    verdict.classList.add('is-good');
    note.textContent = 'Moves enough to feel alive, steady enough to fade under.';
  }
}

// --- score readout ----------------------------------------------------------
//
// A rAF loop rather than a timer: the drift morphs and the bell strikes are
// continuous, so this has to track the audio clock, not the turn clock. It reads
// gains straight off the engine, so what it shows is the mix as it stands
// mid-crossfade rather than the tier we asked for.

let scoreFrame: number | null = null;
let voiceRows: Array<{ row: HTMLElement; note: HTMLElement; fill: HTMLElement; gain: HTMLElement }> = [];

function buildScoreRows(): void {
  const mount = $('score-voices');
  mount.innerHTML = '';
  voiceRows = state.voices.map((voice, i) => {
    const row = document.createElement('div');
    row.className = `voice${voice.pulses ? ' struck' : ''}`;

    const role = document.createElement('span');
    role.className = 'voice-role';

    const note = document.createElement('span');
    note.className = 'voice-note';

    const meter = document.createElement('span');
    meter.className = 'voice-meter';
    const fill = document.createElement('i');
    meter.append(fill);

    const gain = document.createElement('span');
    gain.className = 'voice-gain';

    row.append(role, note, meter, gain);
    mount.append(row);
    role.textContent = readScore(state.voices, [], 0).voices[i]!.role;
    return { row, note, fill, gain };
  });

  const bell = $('score-bell');
  bell.innerHTML = '';
  const figure = readScore(state.voices, [], 0).voices.at(-1)?.strike?.figure ?? [];
  for (const name of figure) {
    const cell = document.createElement('span');
    cell.className = 'bell-cell';
    cell.textContent = name;
    bell.append(cell);
  }
}

function renderScore(): void {
  if (!engine) return;
  const turn = engine.loopTurn();
  const score = readScore(state.voices, engine.gains(), turn);

  const chordEl = $('score-chord');
  chordEl.textContent = score.notes.length > 0 ? score.label : '—';
  chordEl.classList.toggle('unnamed', score.drifting);
  $('score-notes').textContent =
    score.notes.length > 0 ? score.notes.join('  ·  ') : 'silent — no layers above the floor';

  $('score-loop-fill').style.width = `${(turn * 100).toFixed(1)}%`;
  $('score-loop-label').textContent = `loop ${(turn * (engine.loopLengthMs / 1000)).toFixed(1)}s / ${(engine.loopLengthMs / 1000).toFixed(0)}s`;

  score.voices.forEach((voice, i) => {
    const row = voiceRows[i];
    if (!row) return;
    row.row.classList.toggle('on', voice.audible);
    row.note.innerHTML = noteMarkup(voice);
    row.fill.style.width = `${Math.min(100, voice.gain * 100).toFixed(0)}%`;
    row.gain.textContent = voice.gain < 0.005 ? '—' : voice.gain.toFixed(2);
  });

  const bellVoice = score.voices.at(-1);
  const bellCells = $('score-bell').children;
  $('score-bell').parentElement?.classList.toggle('off', !bellVoice?.audible);
  for (let i = 0; i < bellCells.length; i++) {
    bellCells[i]!.classList.toggle('now', !!bellVoice?.audible && bellVoice.strike?.index === i);
  }
}

/** A drifting voice shows where it is going; a settled one just shows its note. */
function noteMarkup(voice: VoiceReadout): string {
  if (voice.toward && voice.toward.blend > 0.06) {
    return `${voice.note}<span class="toward">→ ${voice.toward.note}</span>`;
  }
  return voice.note;
}

function startScoreLoop(): void {
  if (scoreFrame !== null) return;
  const tick = (): void => {
    renderScore();
    scoreFrame = window.requestAnimationFrame(tick);
  };
  scoreFrame = window.requestAnimationFrame(tick);
}

function stopScoreLoop(): void {
  if (scoreFrame === null) return;
  window.cancelAnimationFrame(scoreFrame);
  scoreFrame = null;
  // One last paint so the panel settles on the faded-out state rather than
  // freezing mid-strike.
  window.setTimeout(renderScore, state.crossfadeMs);
}

// --- transport --------------------------------------------------------------

function applyCurrentTier(): void {
  const tier = scored[state.index];
  if (!tier || !engine) return;
  engine.setTier(tier);

  const turn = state.recording!.turns[state.index]!;
  $('now-tier').textContent = fmtTier(tier);
  $('now-usage').textContent = `tok=${turn.tok.toLocaleString()}  ctx=${turn.ctx}%  ${turn.model ?? '—'}`;
  $('now-turn').textContent = `turn ${state.index + 1} / ${scored.length}`;
  ($('scrub') as HTMLInputElement).value = String(state.index);
}

function step(): void {
  if (state.index >= scored.length - 1) {
    pause();
    return;
  }
  state.index += 1;
  applyCurrentTier();
  drawChart();
}

async function play(): Promise<void> {
  if (!engine || scored.length === 0) return;
  await engine.start();
  state.playing = true;
  $('play').textContent = 'Pause';
  startScoreLoop();
  applyCurrentTier();
  if (advanceTimer !== null) window.clearInterval(advanceTimer);
  advanceTimer = window.setInterval(step, state.turnMs);
}

function pause(): void {
  state.playing = false;
  $('play').textContent = 'Play';
  if (advanceTimer !== null) {
    window.clearInterval(advanceTimer);
    advanceTimer = null;
  }
  engine?.setTier({ ensembleSize: 0, richness: 0, timbre: 0 });
  stopScoreLoop();
}

// --- rescoring --------------------------------------------------------------

function rescore(): void {
  scored = scoreAll();
  updateMetrics();
  drawChart();
  if (state.playing) applyCurrentTier();
  updateConfigOutput();
}

// --- controls ---------------------------------------------------------------

type ThresholdKey = 'tokenThresholds' | 'contextThresholds' | 'richnessThresholds';

const RANGES: Record<ThresholdKey, { min: number; max: number; step: number; unit: string }> = {
  tokenThresholds: { min: 50, max: 16000, step: 50, unit: '' },
  contextThresholds: { min: 1, max: 100, step: 1, unit: '%' },
  richnessThresholds: { min: 1, max: 100, step: 1, unit: '%' },
};

function buildThresholdSliders(kind: ThresholdKey, mountId: string): void {
  const mount = $(mountId);
  const range = RANGES[kind];
  const values = state.config[kind];
  mount.innerHTML = '';

  values.forEach((value, index) => {
    const row = document.createElement('div');
    row.className = 'slider-row';

    const tag = document.createElement('label');
    tag.className = 'slider-tag';
    tag.textContent = kind === 'richnessThresholds' ? `pad ${index + 1}` : `level ${index + 1}`;
    tag.htmlFor = `${kind}-${index}`;

    const input = document.createElement('input');
    input.type = 'range';
    input.id = `${kind}-${index}`;
    input.min = String(range.min);
    input.max = String(range.max);
    input.step = String(range.step);
    input.value = String(value);

    const out = document.createElement('output');
    out.className = 'slider-val';
    out.textContent = `${value.toLocaleString()}${range.unit}`;

    input.addEventListener('input', () => {
      const v = Number(input.value);
      state.config[kind][index] = v;
      out.textContent = `${v.toLocaleString()}${range.unit}`;
      rescore();
    });

    row.append(tag, input, out);
    mount.append(row);
  });
}

function buildVoiceControls(): void {
  const mount = $('voice-controls');
  mount.innerHTML = '';

  const labels = ['root', 'fifth', 'third', 'maj7', 'ninth', 'pad', 'bell'];

  state.voices.forEach((voice, i) => {
    const row = document.createElement('div');
    row.className = 'slider-row';

    const tag = document.createElement('label');
    tag.className = 'slider-tag';
    tag.textContent = labels[i] ?? `stem ${i}`;
    tag.htmlFor = `voice-${i}`;

    const input = document.createElement('input');
    input.type = 'range';
    input.id = `voice-${i}`;
    input.min = '0';
    input.max = '0.4';
    input.step = '0.005';
    input.value = String(voice.peak);

    const out = document.createElement('output');
    out.className = 'slider-val';
    out.textContent = voice.peak.toFixed(3);

    let debounce: number | null = null;
    input.addEventListener('input', () => {
      const v = Number(input.value);
      state.voices[i]!.peak = v;
      out.textContent = v.toFixed(3);
      // Rebuilding re-synthesizes every stem, so coalesce drags.
      if (debounce !== null) window.clearTimeout(debounce);
      debounce = window.setTimeout(() => {
        engine?.setVoices(state.voices);
        if (state.playing) applyCurrentTier();
        updateConfigOutput();
      }, 180);
    });

    row.append(tag, input, out);
    mount.append(row);
  });
}

// --- bell melody ------------------------------------------------------------

const D_MAJOR_NOTES: Array<{ name: string; hz: number }> = [
  { name: 'D2', hz: 73.42 },
  { name: 'F#2', hz: 92.5 },
  { name: 'A2', hz: 110.0 },
  { name: 'D3', hz: 146.83 },
  { name: 'F#3', hz: 185.0 },
  { name: 'A3', hz: 220.0 },
  { name: 'D4', hz: 293.66 },
  { name: 'F#4', hz: 369.99 },
  { name: 'A4', hz: 440.0 },
  { name: 'D5', hz: 587.33 },
  { name: 'F#5', hz: 739.99 },
  { name: 'A5', hz: 880.0 },
  { name: 'D6', hz: 1174.66 },
];

function buildMelodyControls(): void {
  const mount = $('melody-controls');
  mount.innerHTML = '';

  const bell = state.voices[state.voices.length - 1]!;
  const sequence = bell.sequenceHz ?? [];

  sequence.forEach((hz, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'note-slot';

    const label = document.createElement('label');
    label.className = 'slider-tag';
    label.textContent = `${i + 1}`;
    label.htmlFor = `note-${i}`;

    const select = document.createElement('select');
    select.id = `note-${i}`;
    for (const note of D_MAJOR_NOTES) {
      const option = document.createElement('option');
      option.value = String(note.hz);
      option.textContent = note.name;
      if (Math.abs(note.hz - hz) < 0.01) option.selected = true;
      select.append(option);
    }

    select.addEventListener('change', () => {
      const next = [...(state.voices[state.voices.length - 1]!.sequenceHz ?? [])];
      next[i] = Number(select.value);
      state.voices[state.voices.length - 1] = {
        ...state.voices[state.voices.length - 1]!,
        sequenceHz: next,
      };
      engine?.setVoices(state.voices);
      if (state.playing) applyCurrentTier();
      buildScoreRows(); // the figure changed — relabel the bell cells
      updateConfigOutput();
    });

    wrap.append(label, select);
    mount.append(wrap);
  });
}

// --- config export ----------------------------------------------------------

function updateConfigOutput(): void {
  const bell = state.voices[state.voices.length - 1]!;
  const config = {
    volume: Number(state.volume.toFixed(2)),
    crossfadeMs: state.crossfadeMs,
    tier: {
      tokenThresholds: state.config.tokenThresholds,
      contextThresholds: state.config.contextThresholds,
      richnessThresholds: state.config.richnessThresholds,
    },
    voices: state.voices.map((v) => ({
      hz: v.hz,
      peak: Number(v.peak.toFixed(3)),
      ...(v.sequenceHz ? { sequenceHz: v.sequenceHz } : {}),
    })),
  };
  void bell;
  $('config-out').textContent = JSON.stringify(config, null, 2);
}

// --- recording loading ------------------------------------------------------

/** What `/recordings.json` serves — the recording plus its label from the transcript. */
interface ServerRecording {
  sessionId: string;
  file: string;
  mtime: number;
  title?: string;
  prompt?: string | null;
}

/** Server metadata by file URL, so the picker's `change` can reach it. */
const serverMeta = new Map<string, ServerRecording>();

/** "26 Jul, 20:29" — enough to tell two sessions from the same day apart. */
function shortDate(mtime: number): string {
  return new Date(mtime).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function loadRecording(recording: LoadedRecording, meta?: ServerRecording): void {
  if (recording.turns.length === 0) {
    $('load-note').textContent = `${recording.name}: no turns found in that file.`;
    return;
  }
  state.recording = recording;
  state.index = 0;
  scored = scoreAll();

  const scrub = $<HTMLInputElement>('scrub');
  scrub.max = String(recording.turns.length - 1);
  scrub.value = '0';
  scrub.disabled = false;
  ($('play') as HTMLButtonElement).disabled = false;

  const minutes = Math.round(recording.summary.durationMs / 60000);
  const span = minutes > 0 ? `${minutes} min` : '<1 min';
  const models = recording.summary.models.join(', ') || 'unknown model';
  const facts = `${recording.turns.length} turns, ${span}, ${models}`;

  // The opening prompt is the useful part; the id is kept as a subtitle so a
  // session can still be matched back to its transcript file.
  const note = $('load-note');
  note.innerHTML = '';
  if (meta?.prompt) {
    const quote = document.createElement('div');
    quote.className = 'load-title';
    quote.textContent = `“${meta.prompt.length > 160 ? `${meta.prompt.slice(0, 160).trimEnd()}…` : meta.prompt}”`;
    note.append(quote);
  }
  const line = document.createElement('div');
  line.className = 'load-facts';
  line.textContent = meta ? `${facts} · ${meta.sessionId.slice(0, 8)}` : `${recording.name} — ${facts}`;
  note.append(line);

  updateMetrics();
  drawChart();
  applyCurrentTier();
}

async function loadFromServer(): Promise<void> {
  try {
    const response = await fetch('./recordings.json');
    if (!response.ok) return;
    const list: ServerRecording[] = await response.json();
    const picker = $<HTMLSelectElement>('recording-picker');
    picker.innerHTML = '';
    if (list.length === 0) {
      picker.append(new Option('(no recordings found)', ''));
      picker.disabled = true;
      return;
    }
    picker.disabled = false;
    picker.append(new Option('Choose a session…', ''));
    for (const item of list) {
      // Date first so the list reads chronologically at a glance, then what the
      // session was actually about.
      const option = new Option(`${shortDate(item.mtime)} — ${item.title ?? item.sessionId}`, item.file);
      option.title = item.prompt ?? item.sessionId; // full opening prompt on hover
      picker.append(option);
    }
    for (const item of list) serverMeta.set(item.file, item);

    picker.addEventListener('change', async () => {
      if (!picker.value) return;
      const meta = serverMeta.get(picker.value);
      const text = await (await fetch(picker.value)).text();
      loadRecording(load(meta?.title ?? picker.selectedOptions[0]!.text, text), meta);
    });
  } catch {
    /* served standalone; drag-and-drop still works */
  }
}

// --- wiring -----------------------------------------------------------------

function init(): void {
  engine = new PlaygroundEngine({
    crossfadeMs: state.crossfadeMs,
    masterGain: state.volume,
  });

  buildThresholdSliders('tokenThresholds', 'token-sliders');
  buildThresholdSliders('contextThresholds', 'context-sliders');
  buildThresholdSliders('richnessThresholds', 'richness-sliders');
  buildVoiceControls();
  buildMelodyControls();
  buildScoreRows();
  renderScore();
  updateConfigOutput();

  $('play').addEventListener('click', () => {
    if (state.playing) pause();
    else void play();
  });

  $<HTMLInputElement>('scrub').addEventListener('input', (event) => {
    state.index = Number((event.target as HTMLInputElement).value);
    applyCurrentTier();
    drawChart();
  });

  const speed = $<HTMLInputElement>('speed');
  speed.addEventListener('input', () => {
    state.turnMs = Number(speed.value);
    $('speed-val').textContent = `${state.turnMs}ms / turn`;
    if (state.playing) void play(); // restart the interval at the new rate
  });

  const volume = $<HTMLInputElement>('volume');
  volume.addEventListener('input', () => {
    state.volume = Number(volume.value);
    $('volume-val').textContent = state.volume.toFixed(2);
    engine?.setMasterGain(state.volume);
    updateConfigOutput();
  });

  const crossfade = $<HTMLInputElement>('crossfade');
  crossfade.addEventListener('input', () => {
    state.crossfadeMs = Number(crossfade.value);
    $('crossfade-val').textContent = `${state.crossfadeMs}ms`;
    engine?.setCrossfadeMs(state.crossfadeMs);
    updateConfigOutput();
  });

  $('reseed').addEventListener('click', () => {
    engine?.reseedPan();
    $('seed-val').textContent = String(engine?.seed ?? 0);
  });

  $('copy-config').addEventListener('click', () => {
    const button = $('copy-config');
    void navigator.clipboard.writeText($('config-out').textContent ?? '').then(
      () => {
        button.textContent = 'Copied';
        setTimeout(() => (button.textContent = 'Copy'), 1600);
      },
      () => {
        button.textContent = 'Select and copy';
        setTimeout(() => (button.textContent = 'Copy'), 1600);
      },
    );
  });

  // drag-and-drop a recording
  const drop = $('drop');
  drop.addEventListener('dragover', (event) => {
    event.preventDefault();
    drop.classList.add('is-over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
  drop.addEventListener('drop', async (event) => {
    event.preventDefault();
    drop.classList.remove('is-over');
    const file = (event as DragEvent).dataTransfer?.files?.[0];
    if (!file) return;
    loadRecording(load(file.name, await file.text()));
  });

  $<HTMLInputElement>('file-input').addEventListener('change', async (event) => {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    loadRecording(load(file.name, await file.text()));
  });

  window.addEventListener('resize', () => drawChart());
  new MutationObserver(() => drawChart()).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });

  void loadFromServer();
  drawChart();
}

init();
