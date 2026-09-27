#!/usr/bin/env node
// Built by scripts/build-plugin.ts — edit the sources, then `npm run build`.

// scripts/radio.ts
import { createServer } from "node:http";
import {
  closeSync as closeSync2,
  openSync as openSync2,
  readFileSync as readFileSync3,
  readSync as readSync2,
  renameSync,
  statSync as statSync3,
  unlinkSync,
  writeFileSync as writeFileSync2
} from "node:fs";
import { homedir as homedir2 } from "node:os";
import { join as join3, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

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
function findTranscripts(root2) {
  const out = [];
  let projects;
  try {
    projects = readdirSync(root2);
  } catch {
    return out;
  }
  for (const project of projects) {
    const dir = join(root2, project);
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
function readSession(root2, project, session) {
  if (!safeName(project) || !safeName(session)) return null;
  const main = join(root2, project, `${session}.jsonl`);
  if (!existsSync(main)) return null;
  const { events, state } = readTranscript(readFileSync(main, "utf8"), { session });
  const subDir = join(root2, project, session, "subagents");
  if (existsSync(subDir)) {
    for (const file of readdirSync(subDir)) {
      if (!SESSION_FILE.test(file)) continue;
      events.push(...readTranscript(readFileSync(join(subDir, file), "utf8"), { session, sub: true }).events);
    }
  }
  events.sort((a, b) => a.at - b.at);
  return { events, state };
}
function projectLabel(dirName) {
  const parts = dirName.split("-").filter(Boolean);
  return parts[parts.length - 1] ?? dirName;
}
var TranscriptWatcher = class {
  opts;
  files = /* @__PURE__ */ new Map();
  scanTimer;
  pollTimer;
  started = false;
  constructor(options) {
    this.opts = {
      hotMs: 30 * 6e4,
      scanMs: 3e3,
      pollMs: 300,
      primeBytes: 24 * 1024 * 1024,
      now: Date.now,
      ...options
    };
  }
  /**
   * Begin following. Files that already exist are *primed* — read silently for
   * their state — so the radio knows where every session is without replaying
   * its history through the speakers.
   */
  start() {
    if (this.started) return;
    this.started = true;
    this.scan(true);
    this.poll();
    this.scanTimer = setInterval(() => this.scan(false), this.opts.scanMs);
    this.pollTimer = setInterval(() => this.poll(), this.opts.pollMs);
    this.scanTimer.unref?.();
    this.pollTimer.unref?.();
  }
  stop() {
    if (this.scanTimer) clearInterval(this.scanTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.scanTimer = void 0;
    this.pollTimer = void 0;
    this.started = false;
  }
  /** Main-thread sessions active within the hot window. */
  sessions() {
    const now = this.opts.now();
    const out = [];
    for (const f of this.files.values()) {
      if (f.sub || !f.primed) continue;
      if (now - f.reader.state.lastAt <= this.opts.hotMs) out.push({ ...f.reader.state });
    }
    return out.sort((a, b) => b.lastAt - a.lastAt);
  }
  /**
   * Look for transcripts. On the first scan everything is existing history; a
   * file that appears later is a brand-new session and is played from its
   * first line.
   */
  scan(initial = false) {
    for (const found of findTranscripts(this.opts.root)) {
      if (this.files.has(found.path)) continue;
      let size = 0;
      let mtime = 0;
      try {
        const st = statSync(found.path);
        size = st.size;
        mtime = st.mtimeMs;
      } catch {
        continue;
      }
      this.files.set(found.path, {
        path: found.path,
        session: found.session,
        sub: found.sub,
        reader: new TranscriptReader({
          session: found.session,
          sub: found.sub,
          project: projectLabel(found.project),
          contextWindows: this.opts.contextWindows,
          now: this.opts.now
        }),
        offset: initial ? size : 0,
        partial: Buffer.alloc(0),
        mtime,
        primed: !initial,
        announced: false
      });
    }
  }
  /** Read whatever hot files have gained since the last poll. */
  poll() {
    const now = this.opts.now();
    for (const f of this.files.values()) {
      let size;
      try {
        const st = statSync(f.path);
        size = st.size;
        f.mtime = st.mtimeMs;
      } catch {
        this.files.delete(f.path);
        continue;
      }
      if (now - f.mtime > this.opts.hotMs) continue;
      if (!f.primed) this.prime(f);
      if (size < f.offset) {
        f.offset = 0;
        f.partial = Buffer.alloc(0);
        f.primed = false;
        this.prime(f);
        continue;
      }
      const events = size > f.offset ? this.read(f, size) : [];
      if (!f.sub && !f.announced && (events.length > 0 || f.reader.state.lastAt > 0)) {
        f.announced = true;
        this.opts.onSession?.({ ...f.reader.state });
      }
      for (const event of events) this.opts.onEvent(event);
    }
  }
  /** Read existing content for state, discarding the events. */
  prime(f) {
    f.primed = true;
    const end = f.offset;
    const start = Math.max(0, end - this.opts.primeBytes);
    if (end <= start) return;
    const text = this.slice(f.path, start, end).toString("utf8");
    const lines = text.split("\n");
    if (start > 0) lines.shift();
    for (const line of lines) f.reader.push(line);
  }
  read(f, size) {
    const chunk = this.slice(f.path, f.offset, size);
    f.offset = size;
    const data = f.partial.length > 0 ? Buffer.concat([f.partial, chunk]) : chunk;
    const events = [];
    let from = 0;
    for (let i = 0; i < data.length; i++) {
      if (data[i] !== 10) continue;
      events.push(...f.reader.push(data.subarray(from, i).toString("utf8")));
      from = i + 1;
    }
    f.partial = Buffer.from(data.subarray(from));
    return events;
  }
  slice(path, start, end) {
    const buffer = Buffer.alloc(end - start);
    let fd;
    try {
      fd = openSync(path, "r");
      let read = 0;
      while (read < buffer.length) {
        const n = readSync(fd, buffer, read, buffer.length - read, start + read);
        if (n <= 0) break;
        read += n;
      }
      return buffer.subarray(0, read);
    } catch {
      return Buffer.alloc(0);
    } finally {
      if (fd !== void 0) closeSync(fd);
    }
  }
};

// src/shelf.ts
import { existsSync as existsSync2, mkdirSync, readFileSync as readFileSync2, readdirSync as readdirSync2, statSync as statSync2, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join as join2 } from "node:path";

// src/tape.ts
function isTape(value) {
  const t = value;
  return !!t && t.app === "conduct-radio" && t.tape === 1 && Array.isArray(t.events) && typeof t.title === "string";
}

// src/shelf.ts
var DEFAULT_SHELF = join2(homedir(), ".claude", "conduct-radio", "tapes");
function listTapes(shelf2) {
  let files;
  try {
    files = readdirSync2(shelf2).filter((f) => f.endsWith(".json") && safeName(f));
  } catch {
    return [];
  }
  const found = [];
  for (const file of files) {
    const tape = readTape(shelf2, file);
    if (!tape) continue;
    found.push({
      id: `tape:${file}`,
      title: tape.title,
      project: tape.project,
      mtime: tape.recordedAt,
      minutes: tapeMinutes(tape),
      out: tape.out
    });
  }
  return found.sort((a, b) => b.mtime - a.mtime);
}
function readTape(shelf2, file) {
  if (!safeName(file) || !file.endsWith(".json")) return null;
  try {
    const tape = JSON.parse(readFileSync2(join2(shelf2, file), "utf8"));
    return isTape(tape) ? tape : null;
  } catch {
    return null;
  }
}
var tapeMinutes = (tape) => Math.max(1, Math.round((tape.to - tape.from) / 6e4));

// scripts/radio.ts
var repoDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
var args = process.argv.slice(2);
var flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] ?? null : null;
};
var port = Number(flag("--port") ?? process.env.PORT ?? 5274);
var shouldOpen = !args.includes("--no-open");
var root = resolve(flag("--root") ?? join3(homedir2(), ".claude", "projects"));
var shelf = resolve(flag("--tapes") ?? DEFAULT_SHELF);
var stateFile = flag("--state");
var idleExitMs = Number(flag("--idle-exit") ?? 0) * 6e4;
async function loadApp() {
  const prebuilt = flag("--app");
  if (prebuilt) {
    const dir = resolve(prebuilt);
    const bundle2 = readFileSync3(join3(dir, "bundle.js"), "utf8");
    return { html: () => readFileSync3(join3(dir, "index.html")), bundle: bundle2 };
  }
  const { build } = await import("esbuild");
  const appDir = join3(repoDir, "app");
  const result = await build({
    entryPoints: [join3(appDir, "main.ts")],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    write: false,
    sourcemap: "inline"
  });
  const bundle = result.outputFiles[0].text;
  console.log(`Bundled radio (${(bundle.length / 1024).toFixed(0)}kb)`);
  return { html: () => readFileSync3(join3(appDir, "index.html")), bundle };
}
var app = await loadApp();
var clients = /* @__PURE__ */ new Set();
var lastClientAt = Date.now();
function send(res, event, data) {
  res.write(`${event ? `event: ${event}
` : ""}data: ${JSON.stringify(data)}

`);
}
function broadcast(event, data) {
  for (const res of clients) send(res, event, data);
}
var watcher = new TranscriptWatcher({
  root,
  onEvent: (event) => broadcast(null, event),
  onSession: (state) => broadcast("session", state)
});
watcher.start();
setInterval(() => {
  for (const res of clients) res.write(": ping\n\n");
}, 15e3).unref();
function readRange(path, start, length) {
  const buffer = Buffer.alloc(length);
  let fd;
  try {
    fd = openSync2(path, "r");
    const n = readSync2(fd, buffer, 0, length, start);
    return buffer.subarray(0, n).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== void 0) closeSync2(fd);
  }
}
function quickProject(path, size, fallback) {
  const m = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(readRange(path, 0, Math.min(size, 64 * 1024)));
  const cwd = m?.[1];
  return cwd ? cwd.split(/[\\/]/).filter(Boolean).pop() ?? fallback : fallback;
}
function quickTitle(path, size) {
  const tail = readRange(path, Math.max(0, size - 256 * 1024), Math.min(size, 256 * 1024)).split("\n").reverse();
  for (const line of tail) {
    const m = /"type":"(custom-title|ai-title)".*?"(customTitle|aiTitle)":"((?:[^"\\]|\\.)*)"/.exec(line);
    if (m) {
      try {
        return JSON.parse(`"${m[3]}"`);
      } catch {
        return m[3] ?? null;
      }
    }
  }
  const { state } = readTranscript(readRange(path, 0, Math.min(size, 128 * 1024)), { session: "x" });
  return state.title;
}
function listSessions() {
  const found = findTranscripts(root).filter((t) => !t.sub).map((t) => {
    try {
      const st = statSync3(t.path);
      return { ...t, size: st.size, mtime: st.mtimeMs };
    } catch {
      return null;
    }
  }).filter((t) => t !== null && t.size > 2e3).sort((a, b) => b.mtime - a.mtime).slice(0, 40);
  return found.map((t) => ({
    id: `${t.project}/${t.session}`,
    session: t.session,
    title: quickTitle(t.path, t.size),
    project: quickProject(t.path, t.size, t.project.split("-").filter(Boolean).pop() ?? t.project),
    mtime: t.mtime,
    size: t.size
  }));
}
function replay(id) {
  if (id.startsWith("tape:")) {
    const tape = readTape(shelf, id.slice("tape:".length));
    return tape && { events: tape.events, project: tape.project, title: tape.title };
  }
  const [project, session] = id.split("/");
  const found = project && session ? readSession(root, project, session) : null;
  return found && { events: found.events, project: found.state.project, title: found.state.title };
}
var json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};
var LOCAL_HOST = /^(localhost|127\.0\.0\.1)(:\d+)?$/i;
var PAGE_POLICY = [
  "default-src 'self'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join("; ");
var server = createServer((req, res) => {
  if (!LOCAL_HOST.test(req.headers.host ?? "")) {
    res.writeHead(403, { "content-type": "text/plain" });
    res.end("Conduct Radio only answers on localhost.");
    return;
  }
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "no-referrer");
  const url2 = new URL(req.url ?? "/", "http://localhost");
  switch (url2.pathname) {
    case "/":
    case "/index.html":
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": PAGE_POLICY
      });
      res.end(app.html());
      return;
    case "/bundle.js":
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
      res.end(app.bundle);
      return;
    // How `radio-ctl` tells this server from anything else on the port.
    case "/healthz":
      json(res, 200, { app: "conduct-radio", pid: process.pid, clients: clients.size });
      return;
    case "/events":
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive"
      });
      res.write("retry: 2000\n\n");
      send(res, "snapshot", { sessions: watcher.sessions(), now: Date.now() });
      clients.add(res);
      req.on("close", () => {
        clients.delete(res);
        lastClientAt = Date.now();
      });
      return;
    case "/api/sessions":
      json(res, 200, listSessions());
      return;
    case "/api/tapes":
      json(res, 200, listTapes(shelf));
      return;
    case "/api/replay": {
      const found = replay(url2.searchParams.get("id") ?? "");
      if (!found) json(res, 404, { error: "no such session" });
      else json(res, 200, found);
      return;
    }
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("Not found");
});
function listen(at, attempts) {
  return new Promise((done, fail) => {
    const onError = (error) => {
      server.off("listening", onListening);
      if (error.code === "EADDRINUSE" && at !== 0 && attempts > 0) done(listen(at + 1, attempts - 1));
      else fail(error);
    };
    const onListening = () => {
      server.off("error", onError);
      done(server.address().port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(at, "127.0.0.1");
  });
}
var actualPort = await listen(port, 20);
var url = `http://localhost:${actualPort}`;
if (stateFile) {
  const temp = `${stateFile}.${process.pid}.tmp`;
  writeFileSync2(temp, JSON.stringify({ app: "conduct-radio", pid: process.pid, port: actualPort, url, startedAt: Date.now() }));
  renameSync(temp, stateFile);
}
function shutdown() {
  watcher.stop();
  server.close();
  for (const res of clients) res.end();
  if (stateFile) {
    try {
      const state = JSON.parse(readFileSync3(stateFile, "utf8"));
      if (state.pid === process.pid) unlinkSync(stateFile);
    } catch {
    }
  }
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
if (idleExitMs > 0) {
  setInterval(() => {
    if (clients.size > 0) lastClientAt = Date.now();
    else if (Date.now() - lastClientAt >= idleExitMs) shutdown();
  }, Math.min(3e4, idleExitMs)).unref();
}
var live = watcher.sessions();
console.log(`
\u266A  Conduct Radio by Parse Studios \u2192 ${url}`);
console.log(`   following ${root}`);
console.log(
  live.length === 0 ? "   no sessions active in the last 30 minutes \u2014 start one, or play the demo\n" : `   ${live.length} active session${live.length === 1 ? "" : "s"}: ${live.map((s) => s.title ?? s.session.slice(0, 8)).join(" \xB7 ")}
`
);
if (shouldOpen) {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  spawn(opener, [url], { stdio: "ignore", detached: true }).unref();
}
