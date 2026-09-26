#!/usr/bin/env node
// Built by scripts/build-plugin.ts — edit the sources, then `npm run build`.

// scripts/radio-ctl.ts
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, unlinkSync } from "node:fs";
import { get } from "node:http";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
var here = dirname(fileURLToPath(import.meta.url));
var args = process.argv.slice(2);
var flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] ?? null : null;
};
var VALUE_FLAGS = /* @__PURE__ */ new Set(["--data", "--port", "--root", "--idle-exit"]);
var positional = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && VALUE_FLAGS.has(args[i - 1])));
var command = (positional[0] ?? "start").toLowerCase();
var dataFlag = flag("--data");
var dataDir = resolve(dataFlag && !dataFlag.includes("${") ? dataFlag : join(homedir(), ".claude", "conduct-radio"));
var stateFile = join(dataDir, "server.json");
var logFile = join(dataDir, "server.log");
function readState() {
  try {
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
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
  const server = join(here, "radio.mjs");
  const app = resolve(here, "..", "app");
  if (!existsSync(server) || !existsSync(join(app, "bundle.js"))) {
    console.log(`Conduct Radio isn't built: expected ${server} and ${app}/bundle.js.`);
    return 1;
  }
  mkdirSync(dataDir, { recursive: true });
  const log = openSync(logFile, "a");
  const serverArgs = [server, "--app", app, "--state", stateFile, "--no-open", "--idle-exit", flag("--idle-exit") ?? "30"];
  serverArgs.push("--port", flag("--port") ?? "5274");
  const root = flag("--root");
  if (root) serverArgs.push("--root", root);
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
  const state = readState();
  if (!state || !alive(state.pid)) {
    try {
      unlinkSync(stateFile);
    } catch {
    }
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
var commands = { start, open: start, stop, status };
var run = commands[command];
if (!run) {
  console.log(`Unknown command "${command}". Use start, stop or status.`);
  process.exit(1);
}
process.exit(await run());
