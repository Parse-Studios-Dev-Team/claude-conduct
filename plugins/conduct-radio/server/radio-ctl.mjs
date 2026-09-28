#!/usr/bin/env node
// Built by scripts/build-plugin.ts — edit the sources, then `npm run build`.

// scripts/radio-ctl.ts
import { spawn } from "node:child_process";
import { existsSync as existsSync3, mkdirSync as mkdirSync2, openSync as openSync2, readFileSync as readFileSync3, unlinkSync } from "node:fs";
import { get } from "node:http";
import { homedir as homedir2 } from "node:os";
import { dirname, join as join3, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// src/shelf.ts
import { existsSync as existsSync2, mkdirSync, readFileSync as readFileSync2, readdirSync as readdirSync2, statSync as statSync2, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join as join2 } from "node:path";

// src/tail.ts
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// src/models.ts
var DEFAULT_CONTEXT_WINDOW = 2e5;
var KNOWN_CONTEXT_WINDOWS = {
  "claude-fable": 1e6,
  "claude-mythos": 1e6,
  "claude-opus-4-6": 1e6,
  "claude-opus-4-7": 1e6,
  "claude-opus-4-8": 1e6,
  "claude-opus-5": 1e6,
  "claude-sonnet-4-6": 1e6,
  "claude-sonnet-5": 1e6,
  "claude-haiku-4-5": 2e5
};
function lookupWindow(model, table) {
  const exact = table[model];
  if (typeof exact === "number") return exact;
  let best = null;
  let bestLength = -1;
  for (const [key, value] of Object.entries(table)) {
    if (key.length > bestLength && model.startsWith(key)) {
      best = value;
      bestLength = key.length;
    }
  }
  return best;
}
function resolveContextWindow(model, overrides) {
  if (model) {
    const configured = overrides ? lookupWindow(model, overrides) : null;
    if (configured !== null) return configured;
    const known = lookupWindow(model, KNOWN_CONTEXT_WINDOWS);
    if (known !== null) return known;
  }
  return DEFAULT_CONTEXT_WINDOW;
}
var EFFORTS = /* @__PURE__ */ new Set(["high", "max", "xhigh"]);
var asEffort = (value) => typeof value === "string" && EFFORTS.has(value) ? value : null;

// src/events.ts
function toolFamily(name) {
  if (/^(Read|Grep|Glob|LS|NotebookRead)$/.test(name)) return "read";
  if (/^(WebFetch|WebSearch)$/.test(name)) return "web";
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(name)) return "write";
  if (/^(Bash|BashOutput|KillShell|KillBash|Monitor)$/.test(name)) return "exec";
  if (/^(Task|Agent|Skill|SendMessage)$/.test(name)) return "agent";
  if (name.startsWith("mcp__")) return "mcp";
  return "other";
}
var estimate = (chars) => Math.max(1, Math.round(chars / 4));
var count = (v) => typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
function timeOf(line, fallback) {
  const ts = line.timestamp;
  if (typeof ts === "string") {
    const ms = Date.parse(ts);
    if (Number.isFinite(ms)) return ms;
  }
  return fallback;
}
function isNoise(text) {
  return /^\s*<(local-command-stdout|local-command-stderr|local-command-caveat|system-reminder|bash-stdout|bash-stderr)/.test(
    text
  );
}
var INTERRUPT = /^\[Request interrupted by user/;
var TranscriptReader = class {
  state;
  sub;
  contextWindows;
  now;
  seenUsage = /* @__PURE__ */ new Set();
  seenEnd = /* @__PURE__ */ new Set();
  titleSource = null;
  constructor(options) {
    this.sub = options.sub === true;
    this.contextWindows = options.contextWindows;
    this.now = options.now ?? Date.now;
    this.state = {
      session: options.session,
      project: options.project ?? "",
      title: null,
      model: null,
      effort: null,
      contextPct: 0,
      outTotal: 0,
      activity: "idle",
      tool: null,
      lastAt: 0,
      compactions: 0
    };
  }
  /** Feed one raw line. Malformed or irrelevant lines yield nothing. */
  push(raw) {
    const text = raw.trim();
    if (!text) return [];
    let line;
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object") return [];
      line = parsed;
    } catch {
      return [];
    }
    return this.read(line);
  }
  read(line) {
    const state = this.state;
    const at = timeOf(line, this.now());
    const base = this.sub ? { session: state.session, at, sub: true } : { session: state.session, at };
    const out = [];
    if (typeof line.cwd === "string" && line.cwd) {
      const parts = line.cwd.split(/[\\/]/).filter(Boolean);
      state.project = parts[parts.length - 1] ?? state.project;
    }
    switch (line.type) {
      case "custom-title":
        return this.retitle(line.customTitle, "custom", base);
      case "ai-title":
        return this.retitle(line.aiTitle ?? line.title, "ai", base);
      case "system": {
        if (line.subtype === "compact_boundary") {
          const meta = line.compactMetadata;
          state.compactions += 1;
          state.contextPct = 0;
          out.push({ ...base, type: "compact", preTokens: count(meta?.preTokens) });
        } else if (line.subtype === "stop_hook_summary" && !this.sub && state.activity !== "idle") {
          state.activity = "idle";
          state.tool = null;
          out.push({ ...base, type: "end" });
        }
        break;
      }
      case "user": {
        if (line.isMeta === true || line.isCompactSummary === true) break;
        const message = line.message;
        const content = message?.content;
        if (typeof content === "string") {
          if (isNoise(content)) break;
          out.push(...this.prompt(content, base));
          break;
        }
        if (!Array.isArray(content)) break;
        let prompted = false;
        for (const block of content) {
          if (block?.type === "tool_result") {
            state.activity = "model";
            state.tool = null;
            const size = JSON.stringify(block.content ?? "").length;
            out.push({ ...base, type: "result", error: block.is_error === true, size });
          } else if (block?.type === "text" && typeof block.text === "string" && !prompted) {
            if (isNoise(block.text)) continue;
            prompted = true;
            out.push(...this.prompt(block.text, base));
          }
        }
        break;
      }
      case "assistant": {
        const message = line.message;
        if (!message) break;
        const id = typeof message.id === "string" ? message.id : `${at}`;
        const model = typeof message.model === "string" && message.model !== "<synthetic>" ? message.model : null;
        if (message.usage && !this.seenUsage.has(id)) {
          this.seenUsage.add(id);
          const usage = message.usage;
          const input = count(usage.input_tokens);
          const created = count(usage.cache_creation_input_tokens);
          const cached = count(usage.cache_read_input_tokens);
          const outTokens = count(usage.output_tokens);
          const prompt = input + created + cached;
          const effort = asEffort(line.effort);
          state.outTotal += outTokens;
          if (!this.sub) {
            if (model) state.model = model;
            if (effort) state.effort = effort;
            if (prompt > 0) {
              const window = resolveContextWindow(model ?? state.model, this.contextWindows);
              state.contextPct = Math.min(100, prompt / window * 100);
            }
          }
          out.push({
            ...base,
            type: "usage",
            model: model ?? state.model,
            effort,
            out: outTokens,
            fresh: input + created,
            cached,
            contextPct: state.contextPct
          });
        }
        const blocks = Array.isArray(message.content) ? message.content : [];
        let visible = false;
        for (const block of blocks) {
          if (block?.type === "thinking" || block?.type === "redacted_thinking") {
            const chars = typeof block.thinking === "string" ? block.thinking.length : 0;
            state.activity = "model";
            out.push({ ...base, type: "think", tokens: chars > 0 ? estimate(chars) : 0 });
          } else if (block?.type === "text") {
            visible = true;
            const chars = typeof block.text === "string" ? block.text.length : 0;
            state.activity = "model";
            out.push({ ...base, type: "text", tokens: estimate(chars) });
          } else if (block?.type === "tool_use") {
            visible = true;
            const name = typeof block.name === "string" ? block.name : "tool";
            state.activity = "tool";
            state.tool = name;
            out.push({
              ...base,
              type: "tool",
              family: toolFamily(name),
              name,
              tokens: estimate(JSON.stringify(block.input ?? {}).length)
            });
          }
        }
        if (message.stop_reason === "end_turn" && visible && !this.seenEnd.has(id)) {
          this.seenEnd.add(id);
          state.activity = "idle";
          state.tool = null;
          out.push({ ...base, type: "end" });
        }
        break;
      }
    }
    if (out.length > 0 || line.type === "user" || line.type === "assistant") {
      state.lastAt = Math.max(state.lastAt, at);
    }
    return out;
  }
  prompt(text, base) {
    const state = this.state;
    if (INTERRUPT.test(text)) {
      if (state.activity === "idle") return [];
      state.activity = "idle";
      state.tool = null;
      return [{ ...base, type: "end", interrupted: true }];
    }
    state.activity = "model";
    state.tool = null;
    const events = [{ ...base, type: "prompt" }];
    if (this.titleSource === null && !this.sub) {
      const title = text.replace(/\s+/g, " ").trim().slice(0, 80);
      if (title && !title.startsWith("<")) {
        this.titleSource = "prompt";
        state.title = title;
        events.push({ ...base, type: "title", title });
      }
    }
    return events;
  }
  retitle(value, source, base) {
    if (this.sub || typeof value !== "string" || !value.trim()) return [];
    if (this.titleSource === "custom" && source === "ai") return [];
    const title = value.trim().slice(0, 80);
    if (title === this.state.title) return [];
    this.titleSource = source;
    this.state.title = title;
    return [{ ...base, type: "title", title }];
  }
};
function readTranscript(text, options) {
  const reader = new TranscriptReader(options);
  const events = [];
  for (const line of text.split("\n")) events.push(...reader.push(line));
  return { events, state: reader.state };
}

// src/tail.ts
var SESSION_FILE = /^[A-Za-z0-9._-]+\.jsonl$/;
function findTranscripts(root) {
  const out = [];
  let projects;
  try {
    projects = readdirSync(root);
  } catch {
    return out;
  }
  for (const project of projects) {
    const dir = join(root, project);
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (SESSION_FILE.test(entry)) {
        out.push({ path: join(dir, entry), session: entry.slice(0, -".jsonl".length), sub: false, project });
        continue;
      }
      const subDir = join(dir, entry, "subagents");
      if (!existsSync(subDir)) continue;
      try {
        for (const agent of readdirSync(subDir)) {
          if (SESSION_FILE.test(agent)) out.push({ path: join(subDir, agent), session: entry, sub: true, project });
        }
      } catch {
      }
    }
  }
  return out;
}
function safeName(name) {
  return /^[A-Za-z0-9._-]+$/.test(name) && !/^\.+$/.test(name);
}
function readSession(root, project, session) {
  if (!safeName(project) || !safeName(session)) return null;
  const main = join(root, project, `${session}.jsonl`);
  if (!existsSync(main)) return null;
  const { events, state } = readTranscript(readFileSync(main, "utf8"), { session });
  const subDir = join(root, project, session, "subagents");
  if (existsSync(subDir)) {
    for (const file of readdirSync(subDir)) {
      if (!SESSION_FILE.test(file)) continue;
      events.push(...readTranscript(readFileSync(join(subDir, file), "utf8"), { session, sub: true }).events);
    }
  }
  events.sort((a, b) => a.at - b.at);
  return { events, state };
}

// src/tape.ts
function lastTurn(events, options = {}) {
  const mine = (e, type) => e.type === type && !e.sub;
  for (let start2 = events.length - 1; start2 >= 0; start2--) {
    if (!mine(events[start2], "prompt")) continue;
    let end = -1;
    for (let i = start2 + 1; i < events.length && !mine(events[i], "prompt"); i++) {
      if (mine(events[i], "end")) {
        end = i;
        break;
      }
    }
    if (end < 0 && options.finished) continue;
    return { from: events[start2].at, to: events[end < 0 ? events.length - 1 : end].at };
  }
  return null;
}
function cut(events, from, to) {
  return events.filter((e) => e.at >= from && e.at <= to).sort((a, b) => a.at - b.at);
}
function makeTape(events, meta, now) {
  const on = cut(events, meta.from, meta.to);
  let out = 0;
  for (const e of on) if (e.type === "usage") out += e.out;
  return { app: "conduct-radio", tape: 1, ...meta, recordedAt: now, out, events: on };
}
function tapeFileName(tape2) {
  const date = new Date(tape2.recordedAt).toISOString().slice(0, 10);
  const slug = tape2.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return `${date}-${slug || "tape"}.json`;
}

// src/shelf.ts
var DEFAULT_SHELF = join2(homedir(), ".claude", "conduct-radio", "tapes");
function cleanTitle(title) {
  const flat = (title ?? "").replace(/[\u0000-\u001f\u007f\u2028\u2029\s]+/g, " ").trim();
  return flat.length > 80 ? `${flat.slice(0, 79).trimEnd()}\u2026` : flat;
}
var tapeMinutes = (tape2) => Math.max(1, Math.round((tape2.to - tape2.from) / 6e4));
function cutTape(options) {
  const wanted = options.session || null;
  const transcripts = findTranscripts(options.root).filter((t) => !t.sub && (!wanted || t.session.startsWith(wanted)));
  if (transcripts.length === 0) {
    return { error: wanted ? `No session starting "${wanted}" under ${options.root}.` : `No sessions under ${options.root}.` };
  }
  const latest = transcripts.map((t) => {
    try {
      return { ...t, mtime: statSync2(t.path).mtimeMs };
    } catch {
      return { ...t, mtime: 0 };
    }
  }).sort((a, b) => b.mtime - a.mtime)[0];
  const session = readSession(options.root, latest.project, latest.session);
  if (!session || session.events.length === 0) return { error: `Nothing to tape in ${latest.session}.` };
  const { events } = session;
  let from = options.from ?? null;
  let to = options.to ?? null;
  if (from === null) {
    const turn = lastTurn(events, { finished: options.finished });
    if (!turn) return { error: options.finished ? "No finished turn to tape yet." : "No turn to tape yet." };
    from = turn.from;
    to ??= turn.to;
  }
  to ??= events[events.length - 1].at;
  if (to < from) return { error: "The end is before the start." };
  const tape2 = makeTape(
    events,
    {
      title: cleanTitle(options.title) || cleanTitle(session.state.title) || latest.session.slice(0, 8),
      project: session.state.project,
      session: latest.session,
      from,
      to
    },
    options.now ?? Date.now()
  );
  if (tape2.events.length === 0) return { error: "No events in that stretch." };
  mkdirSync(options.shelf, { recursive: true });
  const name = tapeFileName(tape2).replace(/\.json$/, "");
  let file = join2(options.shelf, `${name}.json`);
  for (let n = 2; existsSync2(file); n++) file = join2(options.shelf, `${name}-${n}.json`);
  writeFileSync(file, `${JSON.stringify(tape2)}
`);
  return { tape: tape2, file };
}

// scripts/radio-ctl.ts
var here = dirname(fileURLToPath(import.meta.url));
var args = process.argv.slice(2);
var flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] ?? null : null;
};
var VALUE_FLAGS = /* @__PURE__ */ new Set(["--data", "--port", "--root", "--idle-exit", "--session", "--tapes"]);
function typedWords() {
  if (!args.includes("--args-stdin")) {
    return args.filter((a, i) => !a.startsWith("--") && !(i > 0 && VALUE_FLAGS.has(args[i - 1])));
  }
  let text = "";
  try {
    text = readFileSync3(0, "utf8").trim();
  } catch {
  }
  if (text === "$ARGUMENTS") text = "";
  return text ? text.split(/\s+/) : [];
}
var positional = typedWords();
var command = (positional[0] ?? "start").toLowerCase();
var substituted = (value) => value && !value.includes("${") ? value : null;
var dataDir = resolve(substituted(flag("--data")) ?? join3(homedir2(), ".claude", "conduct-radio"));
var stateFile = join3(dataDir, "server.json");
var logFile = join3(dataDir, "server.log");
function readState() {
  try {
    const state = JSON.parse(readFileSync3(stateFile, "utf8"));
    return state.app === "conduct-radio" && Number.isInteger(state.pid) ? state : null;
  } catch {
    return null;
  }
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function healthy(state) {
  return new Promise((done) => {
    const req = get({ host: "127.0.0.1", port: state.port, path: "/healthz", timeout: 800 }, (res) => {
      let body = "";
      res.on("data", (chunk) => body += chunk);
      res.on("end", () => {
        try {
          const reply = JSON.parse(body);
          done(reply.app === "conduct-radio" && reply.pid === state.pid);
        } catch {
          done(false);
        }
      });
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => done(false));
  });
}
async function running() {
  const state = readState();
  if (!state) return null;
  if (alive(state.pid) && await healthy(state)) return state;
  try {
    unlinkSync(stateFile);
  } catch {
  }
  return null;
}
var noOpen = args.includes("--no-open");
function openBrowser(url) {
  if (noOpen) return "";
  const [cmd, cmdArgs] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try {
    spawn(cmd, cmdArgs, { stdio: "ignore", detached: true }).unref();
    return " \u2014 opened it in your browser";
  } catch {
    return "";
  }
}
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function start() {
  const existing = await running();
  if (existing) {
    console.log(`Conduct Radio is already running at ${existing.url}${openBrowser(existing.url)}.`);
    return 0;
  }
  const server = join3(here, "radio.mjs");
  const app = resolve(here, "..", "app");
  if (!existsSync3(server) || !existsSync3(join3(app, "bundle.js"))) {
    console.log(`Conduct Radio isn't built: expected ${server} and ${app}/bundle.js.`);
    return 1;
  }
  mkdirSync2(dataDir, { recursive: true });
  const log = openSync2(logFile, "a");
  const serverArgs = [server, "--app", app, "--state", stateFile, "--no-open", "--idle-exit", flag("--idle-exit") ?? "30"];
  serverArgs.push("--port", flag("--port") ?? "5274");
  const root = flag("--root");
  if (root) serverArgs.push("--root", root);
  const tapes = flag("--tapes");
  if (tapes) serverArgs.push("--tapes", tapes);
  const child = spawn(process.execPath, serverArgs, { detached: true, stdio: ["ignore", log, log] });
  child.unref();
  for (let waited = 0; waited < 6e3; waited += 100) {
    await sleep(100);
    const state = readState();
    if (state && state.pid === child.pid && await healthy(state)) {
      const opened = openBrowser(state.url);
      console.log(`Conduct Radio is running at ${state.url}${opened}. Press Tune in to start the music.`);
      return 0;
    }
    if (child.exitCode !== null) break;
  }
  console.log(`Conduct Radio didn't start. Its output is in ${logFile}`);
  return 1;
}
async function stop() {
  const state = await running();
  if (!state) {
    console.log("Conduct Radio is not running.");
    return 0;
  }
  process.kill(state.pid, "SIGTERM");
  for (let waited = 0; waited < 3e3; waited += 100) {
    await sleep(100);
    if (!alive(state.pid)) {
      console.log("Conduct Radio stopped.");
      return 0;
    }
  }
  console.log(`Conduct Radio (pid ${state.pid}) didn't stop within 3s.`);
  return 1;
}
async function status() {
  const state = await running();
  if (!state) {
    console.log("Conduct Radio is not running. Start it with /conduct-radio:radio");
    return 0;
  }
  const minutes = Math.round((Date.now() - state.startedAt) / 6e4);
  console.log(`Conduct Radio is running at ${state.url} (pid ${state.pid}, up ${minutes} min).`);
  return 0;
}
async function tape() {
  const result = cutTape({
    root: resolve(flag("--root") ?? join3(homedir2(), ".claude", "projects")),
    shelf: resolve(flag("--tapes") ?? DEFAULT_SHELF),
    // `${CLAUDE_SESSION_ID}` from the skill; without it, the latest session.
    session: substituted(flag("--session")),
    // `tape "Smooth sky"` means the title, not the quotes.
    title: positional.slice(1).join(" ").replace(/^(["'“‘])(.*)(["'”’])$/s, "$2") || null,
    finished: true
  });
  if ("error" in result) {
    console.log(`Couldn't cut a tape: ${result.error}`);
    return 1;
  }
  const { tape: saved } = result;
  const out = saved.out >= 1e3 ? `${(saved.out / 1e3).toFixed(1)}k` : String(saved.out);
  const named = positional.length > 1 ? `the tape \u201C${saved.title}\u201D` : "the last turn as a tape";
  console.log(`Saved ${named} (${tapeMinutes(saved)} min, ${out} output tokens). Play it on the radio under Replay \u2192 Tapes.`);
  return 0;
}
var commands = { start, open: start, stop, status, tape };
var run = commands[command];
if (!run) {
  console.log(`Unknown command "${command}". Use start, stop, status or tape.`);
  process.exit(1);
}
process.exit(await run());
