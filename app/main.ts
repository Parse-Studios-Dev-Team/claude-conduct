import { Arranger, LEVEL_LAYERS, type BeatPlan, type Cue, type Mix } from '../src/arranger';
import { Conductor, LEVELS, type BuildSpeed, type SessionView } from '../src/conductor';
import { DEMO_LEVEL_SCALE, DEMO_PROJECTS, demoScript } from '../src/demo';
import { dayPosition, noteName, phaseAt } from '../src/harmony';
import type { RadioEvent, SessionState } from '../src/types';
import { palmSvg } from './brand';
import { DEFAULT_ENGINE, Engine, type Sounded } from './engine';
import { Sky } from './sky';

/**
 * Conduct Radio, in the browser: lo-fi that levels up as Claude works.
 * Made by Parse Studios.
 *
 * Events come in (live from the server, or from the demo or a replay), the
 * conductor keeps score, the arranger turns the score into a band, and the
 * engine plays it. This file is the wiring: the beat clock, the sources, and
 * the HUD.
 */

// ── settings ─────────────────────────────────────────────────────────────────

interface Settings {
  volume: number;
  vinyl: number;
  buildSpeed: BuildSpeed;
  tempo: number;
  tonic: number;
  dim: boolean;
}

const DEFAULTS: Settings = {
  volume: DEFAULT_ENGINE.volume,
  vinyl: DEFAULT_ENGINE.vinyl,
  buildSpeed: 'normal',
  tempo: 76,
  tonic: 5,
  dim: false,
};

// v2: the first version's settings (a noise bed, a 16 Hz pulse, D as home)
// belong to a different sound; don't carry them over.
const STORAGE = 'conduct-radio-v2';

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE);
    return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Settings>) } : { ...DEFAULTS };
  } catch {
    return { ...DEFAULTS };
  }
}

const settings = loadSettings();

function saveSettings(): void {
  try {
    localStorage.setItem(STORAGE, JSON.stringify(settings));
  } catch {
    /* private window — settings just won't stick */
  }
}

// ── state ────────────────────────────────────────────────────────────────────

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

type Source = 'live' | 'demo' | 'replay';

let source: Source = 'live';
let conductor = newConductor();
let arranger = new Arranger({ tonic: settings.tonic });
let engine: Engine | null = null;
let playing = false;
let player: Player | null = null;
let liveSessions: SessionState[] = [];
let connected = false;
let lastMix: Mix | null = null;
/** What is actually sounding — the band plays levels in a phrase after they're earned. */
let heard: { chord: string; level: number; band: BeatPlan['band'] } | null = null;
/** Put the sky straight at the right time of day on the next render, instead of gliding there. */
let snapSky = true;

function newConductor(): Conductor {
  return new Conductor({
    buildSpeed: settings.buildSpeed,
    levelScale: source === 'demo' ? DEMO_LEVEL_SCALE : 1,
  });
}

const sky = new Sky($<HTMLCanvasElement>('sky'));
sky.start();
for (const slot of document.querySelectorAll('[data-palm]')) slot.append(palmSvg());
document.body.classList.toggle('dim', settings.dim);

// ── the beat clock ───────────────────────────────────────────────────────────

let beat = 0;
let nextBeatTime = 0;
let clock: ReturnType<typeof setInterval> | undefined;
const beatSeconds = (): number => 60 / settings.tempo;

/**
 * Plan and schedule every beat inside the lookahead window. The window
 * stretches when the tab is hidden, because background timers get throttled
 * and focus music is, by definition, in the background.
 */
function tick(): void {
  if (!engine || !playing) return;
  const ahead = document.hidden ? 1.6 : 0.35;
  while (nextBeatTime < engine.now + ahead) {
    const mix = conductor.mix(Date.now());
    lastMix = mix;
    const plan = arranger.planBeat(beat, mix);
    engine.applyMix(mix, nextBeatTime);
    const sounded = engine.play(plan, nextBeatTime, beatSeconds());
    visualize(plan, sounded, nextBeatTime);
    beat += 1;
    nextBeatTime += beatSeconds();
  }
}

function focusedSeat(): number {
  const view = conductor.view(Date.now());
  return view.sessions.find((s) => s.session === view.focus)?.seat ?? 0;
}

function visualize(plan: BeatPlan, sounded: Sounded[], time: number): void {
  if (!engine) return;
  const now = engine.now;
  const later = (at: number, fn: () => void): void => {
    window.setTimeout(fn, Math.max(0, (at - now) * 1000));
  };
  const seat = focusedSeat();
  for (const { time: t, note } of sounded) {
    // Melody, arpeggio and flourish notes rise from the lantern; chords and bass
    // are the ground they stand on.
    if (note.voice === 'lead' || note.voice === 'arp' || note.voice === 'sparkle') {
      later(t, () => sky.note(seat, note.voice, note.velocity));
    }
  }
  if (plan.downbeat) {
    const { chord, level, band } = plan;
    later(time, () => {
      heard = { chord, level, band };
    });
  }
  if (plan.flourish === 'levelup') later(time + beatSeconds(), () => sky.shootingStar());
  if (plan.flourish === 'sparkle') later(time, () => sky.chime(seat));
  if (plan.flourish === 'sunrise') later(time, () => sky.sunrise());
}

async function play(): Promise<void> {
  engine ??= new Engine({ volume: settings.volume, vinyl: settings.vinyl, swing: DEFAULT_ENGINE.swing });
  await engine.resume();
  playing = true;
  nextBeatTime = engine.now + 0.12;
  clock ??= setInterval(tick, 50);
  tick();
  fadeOut($('intro'));
  renderPlayButton();
  updateMediaSession();
}

async function pause(): Promise<void> {
  playing = false;
  if (engine) await engine.pause();
  renderPlayButton();
  updateMediaSession();
}

/** Hide an element after its `.leaving` transition, rather than in one frame. */
function fadeOut(el: HTMLElement): void {
  if (el.hidden || el.classList.contains('leaving')) return;
  el.classList.add('leaving');
  window.setTimeout(() => {
    el.hidden = true;
    el.classList.remove('leaving');
  }, 450);
}

function renderPlayButton(): void {
  $('play').setAttribute('aria-label', playing ? 'Pause' : 'Play');
  $('playIcon').innerHTML = playing
    ? '<rect x="2.5" y="1.5" width="3.2" height="11" rx="0.8"/><rect x="8.3" y="1.5" width="3.2" height="11" rx="0.8"/>'
    : '<path d="M3 1.5v11l9-5.5z"/>';
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
}

// ── intake ───────────────────────────────────────────────────────────────────

/** Every event, whatever its source, comes through here. */
function intake(event: RadioEvent): void {
  const cues = conductor.handle(event, Date.now());
  // Paused, the conductor still keeps score — but nothing is queued, or
  // unpausing would play every flourish that was missed at once.
  if (playing) for (const cue of cues) arranger.cue(cue);
  narrate(event, cues);
}

/** Start over — for a change of source or key. */
function reset(): void {
  conductor = newConductor();
  arranger = new Arranger({ tonic: settings.tonic });
  heard = null;
  ticker.length = 0;
  renderTicker();
  renderLadder();
}

// ── live ─────────────────────────────────────────────────────────────────────

const stream = new EventSource('/events');
stream.addEventListener('open', () => {
  connected = true;
});
stream.addEventListener('error', () => {
  connected = false;
});
stream.addEventListener('snapshot', (e) => {
  connected = true;
  liveSessions = (JSON.parse((e as MessageEvent<string>).data) as { sessions: SessionState[] }).sessions;
  if (source === 'live') {
    conductor.seed(liveSessions, Date.now());
    snapSky = true;
  }
  const n = liveSessions.length;
  $('introFine').innerHTML =
    n === 0
      ? 'No sessions active right now — start one, or try the <b>Demo</b>. Reads <code>~/.claude/projects</code>; nothing leaves this machine.'
      : `Listening to ${n} active session${n === 1 ? '' : 's'}. Reads <code>~/.claude/projects</code>; nothing leaves this machine.`;
});
stream.addEventListener('session', (e) => {
  const state = JSON.parse((e as MessageEvent<string>).data) as SessionState;
  liveSessions = [state, ...liveSessions.filter((s) => s.session !== state.session)];
  if (source === 'live') conductor.describe(state.session, { project: state.project, title: state.title }, Date.now());
});
stream.addEventListener('message', (e) => {
  if (source !== 'live') return;
  intake(JSON.parse((e as MessageEvent<string>).data) as RadioEvent);
});

// ── demo and replay ──────────────────────────────────────────────────────────

/**
 * Plays a list of events back in (compressed) real time. Gaps longer than
 * `maxGapMs` are cut down — a lunch break shouldn't be a lunch break of silence.
 */
class Player {
  private index = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly events: RadioEvent[],
    public speed: number,
    private readonly maxGapMs: number,
    private readonly onDone: () => void,
  ) {}

  start(): void {
    this.step();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  get progress(): number {
    return this.events.length === 0 ? 1 : this.index / this.events.length;
  }

  private step(): void {
    const event = this.events[this.index];
    if (!event) {
      this.onDone();
      return;
    }
    intake({ ...event, at: Date.now() });
    this.index += 1;
    const next = this.events[this.index];
    if (!next) {
      this.timer = setTimeout(() => this.onDone(), 18_000);
      return;
    }
    const gap = Math.min(Math.max(0, next.at - event.at), this.maxGapMs) / this.speed;
    this.timer = setTimeout(() => this.step(), gap);
  }
}

function startDemo(): void {
  reset();
  for (const [session, project] of Object.entries(DEMO_PROJECTS)) conductor.describe(session, { project }, Date.now());
  // `?speed=4` plays the demo faster — for checking the whole climb quickly.
  const speed = Number(new URLSearchParams(location.search).get('speed')) || 1;
  player = new Player(demoScript(), speed, 15_000, () => {
    if (source === 'demo') startDemo();
  });
  player.start();
}

let replaySpeed = 12;

interface ReplayListing {
  id: string;
  title: string | null;
  project: string;
  mtime: number;
}

interface TapeListing extends ReplayListing {
  minutes: number;
  out: number;
}

async function loadReplayList(): Promise<void> {
  const pick = $<HTMLSelectElement>('replayPick');
  const get = async <T,>(url: string): Promise<T[]> => {
    try {
      return (await (await fetch(url)).json()) as T[];
    } catch {
      return [];
    }
  };
  const [tapes, sessions] = await Promise.all([get<TapeListing>('/api/tapes'), get<ReplayListing>('/api/sessions')]);
  const option = (value: string, text: string): HTMLOptionElement => {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = text;
    return o;
  };
  const group = (label: string, options: HTMLOptionElement[]): HTMLOptGroupElement => {
    const g = document.createElement('optgroup');
    g.label = label;
    g.append(...options);
    return g;
  };
  pick.replaceChildren(
    option('', tapes.length + sessions.length > 0 ? 'Pick a tape or a session to replay…' : 'Nothing to replay yet'),
  );
  if (tapes.length > 0) {
    pick.append(
      group(
        'Tapes',
        tapes.map((t) => option(t.id, `${t.title} — ${t.project} · ${t.minutes} min · ${k(t.out)} out`)),
      ),
    );
  }
  if (sessions.length > 0) {
    pick.append(
      group(
        'Recent sessions',
        sessions.map((s) => option(s.id, `${s.title ?? s.id.split('/')[1]?.slice(0, 8)} — ${s.project} · ${ago(s.mtime)}`)),
      ),
    );
  }
}

async function startReplay(id: string): Promise<void> {
  player?.stop();
  reset();
  if (!id) return;
  const response = await fetch(`/api/replay?id=${encodeURIComponent(id)}`);
  if (!response.ok) return;
  const { events, project, title } = (await response.json()) as {
    events: RadioEvent[];
    project: string;
    title: string | null;
  };
  const session = events[0]?.session;
  if (session) conductor.describe(session, { project, title }, Date.now());
  player = new Player(events, replaySpeed, 20_000, () => undefined);
  player.start();
}

function useSource(next: Source): void {
  source = next;
  player?.stop();
  player = null;
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-source]')) {
    button.setAttribute('aria-pressed', String(button.dataset.source === next));
  }
  $('replay').hidden = next !== 'replay';
  reset();
  if (next === 'live') conductor.seed(liveSessions, Date.now());
  else if (next === 'demo') startDemo();
  else void loadReplayList();
  if (next !== 'live' && !playing) void play();
}

// ── narration ────────────────────────────────────────────────────────────────

const ticker: Array<{ text: string; color: string }> = [];
const TICKER_LINES = 7;

function tickerLine(item: { text: string; color: string }): HTMLLIElement {
  const li = document.createElement('li');
  const dot = document.createElement('span');
  dot.className = 'dot';
  dot.style.background = item.color;
  const text = document.createElement('span');
  text.textContent = item.text;
  li.append(dot, text);
  return li;
}

function say(text: string, color = 'rgba(255,255,255,0.5)'): void {
  const item = { text, color };
  ticker.unshift(item);
  ticker.length = Math.min(ticker.length, TICKER_LINES);
  if ($('score').hidden) return;
  // Add the one new line rather than rebuilding the list.
  const list = $('ticker');
  list.prepend(tickerLine(item));
  while (list.children.length > TICKER_LINES) list.lastElementChild?.remove();
}

function renderTicker(): void {
  $('ticker').replaceChildren(...ticker.map(tickerLine));
}

const k = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : `${Math.round(n)}`);

/** Explain what just changed in the music, in the "What am I hearing?" panel. */
function narrate(event: RadioEvent, cues: Cue[]): void {
  for (const cue of cues) {
    if (cue.kind === 'levelUp') {
      const level = LEVELS[cue.level - 1]!;
      say(`Level ${level.level} · ${level.name} — ${LEVEL_LAYERS[level.level]} (at the next phrase)`, '#ffd59a');
      renderLadder();
    }
  }
  if (event.sub) return;
  const who = conductor.view(Date.now()).sessions.find((s) => s.session === event.session)?.project || 'a session';
  switch (event.type) {
    case 'prompt':
      say(`You prompted ${who} — the full band comes back in`, '#c9d2ff');
      break;
    case 'end':
      if (cues.some((c) => c.kind === 'turnEnd')) say(`Your turn in ${who} — a flourish, and the band lays back`, '#ffffff');
      break;
    case 'compact':
      say(`Compacted ${k(event.preTokens)} tokens — a sweep into a fresh progression`, '#ffb88a');
      break;
  }
}

// ── HUD ──────────────────────────────────────────────────────────────────────

function modelName(model: string | null): string {
  if (!model) return '';
  const m = /claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?!\d)/.exec(model);
  if (!m) return model;
  return `${m[1]!.charAt(0).toUpperCase()}${m[1]!.slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}`;
}

function ago(ms: number): string {
  const minutes = Math.round((Date.now() - ms) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

/** `mcp__Claude_Browser__browser_batch` → `browser_batch`. */
function toolName(name: string | null): string {
  if (!name) return 'a tool';
  return name.startsWith('mcp__') ? (name.split('__').pop() ?? name) : name;
}

function stateLabel(s: SessionView, now: number): string {
  if (s.activity === 'idle') return 'your turn';
  if (now - s.seenAt > 5 * 60_000) return 'resting';
  if (s.activity === 'tool') return `running ${toolName(s.tool)}`;
  return s.waitingSince !== null ? 'thinking…' : 'writing';
}

const cards = new Map<string, HTMLElement>();

function renderSessions(): void {
  const now = Date.now();
  const { sessions, focus } = conductor.view(now);
  const container = $('sessions');
  const seen = new Set<string>();

  for (const s of sessions) {
    seen.add(s.session);
    let card = cards.get(s.session);
    if (!card) {
      card = document.createElement('div');
      card.className = 'card panel';
      card.innerHTML =
        '<div class="card-top"><span class="lamp"></span><span class="project"></span><span class="state"></span></div>' +
        '<div class="title"></div>' +
        '<div class="ctx"><div class="ctx-bar"><div class="rest"></div></div><span class="pct"></span></div>' +
        '<div class="meta"></div>';
      cards.set(s.session, card);
      container.append(card);
    }
    const working = s.activity !== 'idle' && now - s.seenAt < 5 * 60_000;
    card.classList.toggle('focused', s.session === focus);
    card.classList.toggle('working', working);
    card.classList.toggle('waiting', working && s.waitingSince !== null);
    card.classList.toggle('idle', !working);
    card.style.order = String(s.seat);
    const q = (sel: string): HTMLElement => card!.querySelector(sel) as HTMLElement;
    q('.project').textContent = s.project || s.session.slice(0, 8);
    q('.state').textContent = stateLabel(s, now);
    q('.title').textContent = s.title ?? 'Untitled session';
    const pct = Math.max(0, Math.min(100, s.contextPct));
    q('.rest').style.transform = `scaleX(${(1 - pct / 100).toFixed(4)})`;
    q('.pct').textContent = `${pct < 10 ? pct.toFixed(1) : Math.round(pct)}% · ${phaseAt(Math.pow(pct / 100, 0.6)).name}`;
    q('.meta').textContent = [modelName(s.model), s.effort, `${k(s.outTotal)} out`].filter(Boolean).join(' · ');
  }

  for (const [id, card] of cards) {
    if (!seen.has(id)) {
      card.remove();
      cards.delete(id);
    }
  }
}

function renderNow(): void {
  const progress = conductor.progress();
  const level = playing && heard ? heard.level : progress.level;
  const name = LEVELS[level - 1]!.name;
  const parts = [`<b>Level ${level} · ${name}</b>`, `${noteName(settings.tonic, settings.tonic)} major`];
  if (heard && playing) parts.push(heard.chord);
  if (heard && playing && heard.band === 'laid back') parts.push('laid back');
  $('nowText').innerHTML = parts.join(' · ');
  $('conn').className = `conn ${source !== 'live' ? '' : connected ? 'ok' : 'bad'}`;
  $('conn').title = source !== 'live' ? '' : connected ? 'Connected to the radio server' : 'Reconnecting…';

  $('ladderFill').style.transform = `scaleX(${progress.fraction.toFixed(3)})`;
  $('ladderText').textContent = progress.next
    ? `${k(progress.toNext)} tokens to ${progress.next.name.toLowerCase()}`
    : 'Flow state — everything unlocked';
}

let ladderLevel = -1;

/** The ladder in the score panel: what's unlocked, and what's next. */
function renderLadder(): void {
  const progress = conductor.progress();
  if (progress.level === ladderLevel && $('ladder').children.length > 0) return;
  ladderLevel = progress.level;
  $('ladder').replaceChildren(
    ...LEVELS.map((level) => {
      const li = document.createElement('li');
      li.className = level.level < progress.level ? 'done' : level.level === progress.level ? 'current' : '';
      const at = conductor.threshold(level);
      li.innerHTML = `<span class="n">${level.level}</span><span class="name"></span><span class="at">${at === 0 ? 'start' : `${k(at)}`}</span>`;
      (li.querySelector('.name') as HTMLElement).textContent = `${level.name} — ${LEVEL_LAYERS[level.level]}`;
      return li;
    }),
  );
}

function renderSky(): void {
  const now = Date.now();
  const mix = lastMix ?? conductor.mix(now);
  const { sessions, focus } = conductor.view(now);
  const focused = sessions.find((s) => s.session === focus);
  sky.set(
    {
      // Where the day is headed. The sky gets there at its own pace, and a
      // compaction's new day comes up from the east.
      day: focused ? dayPosition(focused.contextPct) : 0,
      stars: mix.stars,
      lanterns: sessions.map((s) => ({
        seat: s.seat,
        working: s.activity !== 'idle' && now - s.seenAt < 5 * 60_000,
        waiting: s.activity === 'model' && s.waitingSince !== null,
        focused: s.session === focus,
      })),
    },
    snapSky,
  );
  snapSky = false;
}

function render(): void {
  if (!playing) lastMix = conductor.mix(Date.now());
  renderSessions();
  renderNow();
  renderSky();
  if (!$('score').hidden) renderLadder();
  if (player && source === 'replay') $('replayProgress').style.transform = `scaleX(${player.progress.toFixed(3)})`;
}

setInterval(render, 250);
render();

let lastMediaLevel = -1;

function updateMediaSession(): void {
  if (!('mediaSession' in navigator)) return;
  const { level, name } = conductor.progress();
  if (level === lastMediaLevel && navigator.mediaSession.metadata) return;
  lastMediaLevel = level;
  const view = conductor.view(Date.now());
  const focused = view.sessions.find((s) => s.session === view.focus);
  navigator.mediaSession.metadata = new MediaMetadata({
    title: `Level ${level} · ${name}`,
    artist: 'Conduct Radio · Parse Studios',
    album: focused?.title ?? focused?.project ?? 'Claude Code',
  });
}
setInterval(updateMediaSession, 2_000);

if ('mediaSession' in navigator) {
  navigator.mediaSession.setActionHandler('play', () => void play());
  navigator.mediaSession.setActionHandler('pause', () => void pause());
}

// ── controls ─────────────────────────────────────────────────────────────────

$('tune').addEventListener('click', () => void play());
$('play').addEventListener('click', () => void (playing ? pause() : play()));
document.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  if (e.target instanceof HTMLButtonElement) return;
  e.preventDefault();
  void (playing ? pause() : play());
});

for (const button of document.querySelectorAll<HTMLButtonElement>('[data-source]')) {
  button.addEventListener('click', () => useSource(button.dataset.source as Source));
}

$<HTMLSelectElement>('replayPick').addEventListener('change', (e) => {
  void startReplay((e.target as HTMLSelectElement).value);
});
for (const button of document.querySelectorAll<HTMLButtonElement>('#speeds [data-speed]')) {
  button.addEventListener('click', () => {
    replaySpeed = Number(button.dataset.speed);
    if (player) player.speed = replaySpeed;
    for (const b of document.querySelectorAll('#speeds [data-speed]')) b.setAttribute('aria-pressed', String(b === button));
  });
}

function toggleDrawer(id: 'score' | 'settings'): void {
  const other = id === 'score' ? 'settings' : 'score';
  const drawer = $(id);
  drawer.hidden = !drawer.hidden;
  $(other).hidden = true;
  $(`${id}Toggle`).setAttribute('aria-expanded', String(!drawer.hidden));
  $(`${other}Toggle`).setAttribute('aria-expanded', 'false');
  if (id === 'score' && !drawer.hidden) {
    renderTicker();
    ladderLevel = -1;
    renderLadder();
  }
}
$('scoreToggle').addEventListener('click', () => toggleDrawer('score'));
$('settingsToggle').addEventListener('click', () => toggleDrawer('settings'));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    $('score').hidden = true;
    $('settings').hidden = true;
  }
});

const volume = $<HTMLInputElement>('volume');
volume.value = String(settings.volume);
volume.addEventListener('input', () => {
  settings.volume = Number(volume.value);
  engine?.setVolume(settings.volume);
  saveSettings();
});

const vinyl = $<HTMLInputElement>('vinyl');
vinyl.value = String(settings.vinyl);
vinyl.addEventListener('input', () => {
  settings.vinyl = Number(vinyl.value);
  engine?.setVinyl(settings.vinyl);
  saveSettings();
});

function chips(id: string, current: string, onPick: (value: string) => void): void {
  const buttons = document.querySelectorAll<HTMLButtonElement>(`#${id} [data-value]`);
  const mark = (value: string): void => {
    for (const b of buttons) b.setAttribute('aria-pressed', String(b.dataset.value === value));
  };
  mark(current);
  for (const b of buttons) {
    b.addEventListener('click', () => {
      mark(b.dataset.value!);
      onPick(b.dataset.value!);
      saveSettings();
    });
  }
}

chips('buildSpeed', settings.buildSpeed, (value) => {
  settings.buildSpeed = value as BuildSpeed;
  conductor.setBuildSpeed(settings.buildSpeed);
  ladderLevel = -1;
  renderLadder();
});
chips('tempo', String(settings.tempo), (value) => {
  settings.tempo = Number(value);
});

const key = $<HTMLSelectElement>('key');
for (let pc = 0; pc < 12; pc++) {
  const option = document.createElement('option');
  option.value = String(pc);
  option.textContent = `${noteName(pc, pc)} major`;
  key.append(option);
}
key.value = String(settings.tonic);
key.addEventListener('change', () => {
  settings.tonic = Number(key.value);
  arranger = new Arranger({ tonic: settings.tonic });
  saveSettings();
});

const dim = $<HTMLInputElement>('dim');
dim.checked = settings.dim;
dim.addEventListener('change', () => {
  settings.dim = dim.checked;
  document.body.classList.toggle('dim', settings.dim);
  saveSettings();
});

// Exposed for debugging from the console, and for the preview harness.
Object.assign(window, {
  conductRadio: {
    get conductor() {
      return conductor;
    },
    get arranger() {
      return arranger;
    },
    get engine() {
      return engine;
    },
    get playing() {
      return playing;
    },
    get beat() {
      return beat;
    },
    sky,
    useSource,
  },
});
