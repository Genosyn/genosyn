#!/usr/bin/env node
// @ts-check
/*
 * Genosyn browser bridge — runs on a Member's own computer.
 *
 * Genosyn lives on a server and can never dial your laptop, so this dials the
 * server instead: one outbound WebSocket, held open, carrying CDP frames for a
 * Chrome that this process launches and owns.
 *
 * It launches a *dedicated* Chrome with its own `--user-data-dir`, not your
 * everyday profile. Two reasons, and both are hard:
 *
 *   1. Chrome refuses. Since Chrome 136, `--remote-debugging-port` is ignored
 *      when the profile is the default one — on branded Google Chrome the
 *      check is compiled in, there is no flag, and `--remote-debugging-pipe`
 *      is gated the same way.
 *   2. It should. Attaching an automation driver to a browser full of your own
 *      tabs means the AI can read them, the server sees their request headers,
 *      and your JavaScript dialogs get answered by a robot. A separate profile
 *      makes the blast radius the Genosyn window and nothing else.
 *
 * So this is a real Google Chrome, on your machine, with your network and your
 * screen — in a window that belongs to Genosyn. You sign into the sites you
 * want your AI employee to use, once, in that window.
 *
 * Zero dependencies: Node 22 ships a global WebSocket and fetch.
 *
 *   node agent.mjs pair --server https://genosyn.example.com --code ABCD-…
 *   node agent.mjs run
 *   node agent.mjs status
 *   node agent.mjs logout
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const AGENT_VERSION = "1.0.0";

const HOME = process.env.GENOSYN_BRIDGE_HOME || path.join(os.homedir(), ".genosyn");
const CONFIG_PATH = path.join(HOME, "browser-bridge.json");
const PROFILE_DIR = path.join(HOME, "chrome-profile");
const LOG_PATH = path.join(HOME, "browser-bridge.log");

/** Reconnect backoff, in ms. Capped so a laptop that wakes up rejoins quickly. */
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 20_000, 30_000];

// ---------------------------------------------------------------------------
// CDP firewall
// ---------------------------------------------------------------------------

/*
 * The App drives this browser with whatever CDP Playwright emits, which is a
 * lot — and CDP is far wider than the browser_* tools the model actually has.
 * The methods below have no counterpart in those tools and would each hand the
 * server something it should not be able to take from a personal machine, so
 * they are refused here, on the laptop, where the refusal cannot be argued
 * with by a compromised or prompt-injected server.
 *
 * This is defence in depth, not the primary boundary — the dedicated profile
 * is. It is a deny list rather than an allow list on purpose: an allow list
 * would be pinned to one Playwright version and would break silently on
 * upgrade, in the direction of "the browser stopped working", which people fix
 * by turning the check off.
 *
 * Methods that get an empty *success* back without ever reaching Chrome.
 *
 * Both download-behavior calls are part of Playwright's connection handshake,
 * not something the model asked for — refusing them outright makes
 * `connectOverCDP` fail and the feature simply does not work. Answering "fine"
 * and dropping them is the better outcome in both directions: Playwright
 * proceeds, and Chrome keeps its own default download handling, so the App
 * cannot redirect a download to a path of its choosing or silence the
 * browser's own save prompt. The capability is removed, not merely denied.
 */
export const NEUTRALIZED_CDP_METHODS = new Set([
  "Browser.setDownloadBehavior",
  "Page.setDownloadBehavior",
]);

export const DENIED_CDP_METHODS = new Set([
  // Writing files to the human's disk.
  "Page.printToPDF",
  "Page.captureSnapshot",
  "DOM.setFileInputFiles",
  // Bulk credential readout. Playwright's storageState() uses these; the App
  // is guarded against calling it, and this makes that guard enforceable.
  "Network.getAllCookies",
  "Network.setCookie",
  "Network.setCookies",
  "Network.deleteCookies",
  "Storage.getCookies",
  "Storage.setCookies",
  "Storage.clearCookies",
  "Storage.clearDataForOrigin",
  "Storage.clearDataForStorageKey",
  // Turning off the protections the human's browser gives them.
  "Security.setIgnoreCertificateErrors",
  "Security.disable",
  "Browser.grantPermissions",
  "Browser.setPermission",
  // Killing the browser out from under its owner.
  "Browser.close",
  "Browser.crash",
  "Browser.crashGpuProcess",
  // Debugger/profiler surfaces the tools never need.
  "Debugger.enable",
  "Debugger.setBreakpoint",
  "Debugger.setBreakpointByUrl",
  "Profiler.start",
  "HeapProfiler.startSampling",
]);

/** Methods whose params carry a URL we have to check before it is navigated to. */
const NAVIGATING_METHODS = new Set([
  "Page.navigate",
  "Page.navigateToHistoryEntry",
  "Target.createTarget",
]);

export function hostMatchesPattern(hostname, pattern) {
  const host = hostname.toLowerCase();
  const pat = pattern.trim().toLowerCase();
  if (!pat) return false;
  if (pat.startsWith("*.")) {
    const apex = pat.slice(2);
    return host === apex || host.endsWith(`.${apex}`);
  }
  if (pat.includes("*")) {
    // `*` never crosses a dot, so `example.*` cannot match
    // `example.attacker.com`.
    const rx = new RegExp(
      `^${pat
        .split("*")
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("[^.]*")}$`,
    );
    return rx.test(host);
  }
  return host === pat;
}

/**
 * Decide whether one CDP message may go to Chrome.
 *
 * `policy.allowedHosts` is the browser's own list, pushed down by the App and
 * re-checked here. `policy.appOrigin` is Genosyn itself: this browser must
 * never be steered at the Genosyn UI, because it would arrive carrying nothing
 * useful and everything risky.
 */
export function screenCdpMessage(raw, policy) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return { allow: false, reason: "malformed CDP message" };
  }
  const method = typeof msg?.method === "string" ? msg.method : "";
  if (!method) return { allow: true, message: msg };
  // Every synthetic reply has to carry the request's `sessionId` back.
  // Playwright flattens CDP sessions onto one socket and routes a reply by
  // that field; answer without it and the reply lands on the root session,
  // which has no pending callback for the id and throws an assertion from a
  // timer — an uncaught exception that takes the whole App process down.
  const sessionId = typeof msg.sessionId === "string" ? msg.sessionId : undefined;
  if (NEUTRALIZED_CDP_METHODS.has(method)) {
    return {
      allow: false,
      neutralize: true,
      reason: `${method} was ignored`,
      id: msg.id,
      sessionId,
    };
  }
  if (DENIED_CDP_METHODS.has(method)) {
    return {
      allow: false,
      reason: `${method} is not permitted on a member browser`,
      id: msg.id,
      sessionId,
    };
  }
  if (NAVIGATING_METHODS.has(method)) {
    const url = typeof msg.params?.url === "string" ? msg.params.url : "";
    // `about:blank` is how Playwright opens a fresh tab before navigating.
    if (url && url !== "about:blank") {
      const verdict = navigationAllowed(url, policy);
      if (!verdict.allow) return { ...verdict, id: msg.id, sessionId };
    }
  }
  return { allow: true, message: msg };
}

export function navigationAllowed(url, policy) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { allow: false, reason: `refusing to open a malformed URL` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    // file:// would read the human's disk; chrome:// reaches settings and
    // the profile's saved passwords.
    return { allow: false, reason: `refusing to open a ${parsed.protocol} URL` };
  }
  if (policy.appOrigin) {
    try {
      if (new URL(policy.appOrigin).host.toLowerCase() === parsed.host.toLowerCase()) {
        return { allow: false, reason: "refusing to open Genosyn itself in a member browser" };
      }
    } catch {
      // an unparseable configured origin just means no check
    }
  }
  const allowed = policy.allowedHosts ?? [];
  if (allowed.length === 0) {
    return { allow: false, reason: "this browser has no allowed hosts configured" };
  }
  if (!allowed.some((pattern) => hostMatchesPattern(parsed.hostname, pattern))) {
    return { allow: false, reason: `${parsed.hostname} is not on this browser's allow list` };
  }
  return { allow: true };
}

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

export function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return null;
  }
}

function writeConfig(value) {
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(value, null, 2), { mode: 0o600 });
}

function log(message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  process.stdout.write(line);
  try {
    fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
    fs.appendFileSync(LOG_PATH, line);
  } catch {
    // the log is a convenience, never a reason to stop
  }
}

/**
 * A bearer token over plain http would be readable by anyone on the network,
 * and what it unlocks is a channel into a browser. Loopback is exempt because
 * there is no network to read.
 */
export function assertServerUrlIsSafe(serverUrl) {
  const url = new URL(serverUrl);
  // URL keeps the brackets on an IPv6 host, so `http://[::1]:8471` has a
  // hostname of "[::1]" — comparing against the bare form never matches.
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const loopback = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (url.protocol !== "https:" && !loopback) {
    throw new Error(
      `Refusing to connect to ${url.origin} over plain http. Serve Genosyn over https, ` +
        `or run the bridge on the same machine as the server.`,
    );
  }
  return url;
}

// ---------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------

const CHROME_CANDIDATES = {
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ],
  linux: [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
  ],
  win32: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ],
};

export function findChrome() {
  const explicit = process.env.GENOSYN_CHROME_PATH;
  if (explicit) {
    if (!fs.existsSync(explicit)) {
      throw new Error(`GENOSYN_CHROME_PATH points at ${explicit}, which does not exist.`);
    }
    return explicit;
  }
  const candidates = CHROME_CANDIDATES[process.platform] ?? CHROME_CANDIDATES.linux;
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error(
      "Could not find Google Chrome. Install it, or set GENOSYN_CHROME_PATH to the binary.",
    );
  }
  return found;
}

/**
 * Launch the Genosyn-owned Chrome and resolve its browser-level CDP endpoint.
 *
 * The port is `0`, so the OS picks one and Chrome writes the real value to
 * `DevToolsActivePort` in the profile. A fixed port such as 9222 would be a
 * standing invitation: every other process on this machine — any app, any
 * postinstall script — could drive the browser for as long as it was up.
 */
export async function launchChrome(options = {}) {
  const executable = findChrome();
  const profileDir = options.profileDir ?? PROFILE_DIR;
  fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  const activePortFile = path.join(profileDir, "DevToolsActivePort");
  try {
    fs.rmSync(activePortFile, { force: true });
  } catch {
    // a stale file just means we wait for the new one
  }

  const child = spawn(
    executable,
    [
      "--remote-debugging-port=0",
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      // Keeps the browser out of the human's default-browser flow and out of
      // their session restore, so the Genosyn window never adopts their tabs.
      "--no-service-autorun",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"], detached: false },
  );

  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
    if (stderr.length > 4000) stderr = stderr.slice(-4000);
  });

  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(chromeStartupError(stderr, child.exitCode));
    }
    try {
      const contents = fs.readFileSync(activePortFile, "utf8").split("\n");
      const port = Number(contents[0]);
      const wsPath = (contents[1] ?? "").trim();
      if (port > 0 && wsPath) {
        return { child, endpoint: `ws://127.0.0.1:${port}${wsPath}`, profileDir };
      }
    } catch {
      // not written yet
    }
    if (Date.now() > deadline) {
      try {
        child.kill();
      } catch {
        // already gone
      }
      throw new Error(chromeStartupError(stderr, null));
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

export function chromeStartupError(stderr, exitCode) {
  if (/disallowed by the system admin/i.test(stderr)) {
    return (
      "Chrome refused remote debugging because a device-management policy " +
      "(RemoteDebuggingAllowed) forbids it. On a managed computer only your IT " +
      "administrator can change that."
    );
  }
  if (/non-default data directory/i.test(stderr)) {
    return (
      "Chrome refused remote debugging for this profile directory. The bridge " +
      "must use its own profile — do not point GENOSYN_BRIDGE_HOME at your normal Chrome profile."
    );
  }
  return (
    `Chrome exited before the bridge could attach${exitCode === null ? "" : ` (code ${exitCode})`}.` +
    (stderr ? `\n${stderr.trim().slice(-1000)}` : "")
  );
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    } else {
      out._.push(arg);
    }
  }
  return out;
}

async function commandPair(args) {
  const serverArg = args.server ?? process.env.GENOSYN_SERVER;
  const code = args.code ?? args._[1];
  if (!serverArg || !code) {
    throw new Error("Usage: node agent.mjs pair --server https://your-genosyn --code <code>");
  }
  const server = assertServerUrlIsSafe(serverArg);
  const response = await fetch(new URL("/api/internal/member-browsers/pair", server), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: String(code), agentVersion: AGENT_VERSION }),
  });
  const text = await response.text();
  if (!response.ok) {
    let message = text.slice(0, 300);
    try {
      message = JSON.parse(text).error ?? message;
    } catch {
      // not JSON
    }
    throw new Error(`Pairing failed: ${message}`);
  }
  const body = JSON.parse(text);
  writeConfig({
    server: server.origin,
    browserId: body.browserId,
    name: body.name,
    token: body.token,
  });
  log(`Paired as "${body.name}". Config written to ${CONFIG_PATH}`);
  log(`Start it with:  node ${path.basename(process.argv[1] ?? "agent.mjs")} run`);
}

function commandStatus() {
  const cfg = readConfig();
  if (!cfg) {
    log(`Not paired. Run: node agent.mjs pair --server <url> --code <code>`);
    return;
  }
  log(`Paired as "${cfg.name}" against ${cfg.server}`);
  log(`Chrome profile: ${PROFILE_DIR}`);
  log(`Log: ${LOG_PATH}`);
}

function commandLogout() {
  try {
    fs.rmSync(CONFIG_PATH, { force: true });
    log("Bridge credentials removed. Revoke the browser in Genosyn too, if you have not already.");
  } catch (err) {
    log(`Could not remove ${CONFIG_PATH}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

/**
 * One connected lifetime: hold the App socket, launch Chrome lazily on the
 * first CDP channel, and relay until something closes.
 */
export function createBridgeSession(options) {
  const { WebSocketImpl = WebSocket, launch = launchChrome, logger = log } = options;
  /** @type {{allowedHosts: string[], appOrigin: string}} */
  const policy = { allowedHosts: [], appOrigin: options.appOrigin ?? "" };
  /** @type {Map<string, WebSocket>} */
  const channels = new Map();
  let chrome = null;
  let chromeEndpoint = null;
  let app = null;
  let stopped = false;

  const sendUp = (frame) => {
    if (app && app.readyState === 1) app.send(JSON.stringify(frame));
  };

  async function ensureChrome() {
    if (chromeEndpoint) return chromeEndpoint;
    const launched = await launch({ name: options.name });
    chrome = launched.child;
    chromeEndpoint = launched.endpoint;
    logger(`Chrome is up for "${options.name ?? "this browser"}"`);
    chrome?.on?.("exit", () => {
      logger("Chrome exited — closing open channels");
      chromeEndpoint = null;
      for (const [id, socket] of channels) {
        try {
          socket.close();
        } catch {
          // ignore
        }
        sendUp({ t: "cdp.closed", ch: id, reason: "Chrome was closed on the paired computer" });
      }
      channels.clear();
    });
    return chromeEndpoint;
  }

  async function openChannel(id) {
    let endpoint;
    try {
      endpoint = await ensureChrome();
    } catch (err) {
      sendUp({
        t: "cdp.error",
        ch: id,
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    // No options: Node's global WebSocket takes `protocols` here, not a `ws`
    // options bag, and silently drops anything else. It enforces no frame-size
    // cap of its own, which is what large CDP payloads such as screenshots need.
    const socket = new WebSocketImpl(endpoint);
    channels.set(id, socket);
    socket.addEventListener("open", () => sendUp({ t: "cdp.opened", ch: id }));
    socket.addEventListener("message", (event) => {
      const data = typeof event.data === "string" ? event.data : String(event.data);
      sendUp({ t: "cdp.msg", ch: id, data });
    });
    socket.addEventListener("close", () => {
      if (!channels.has(id)) return;
      channels.delete(id);
      sendUp({ t: "cdp.closed", ch: id, reason: "the browser closed the connection" });
    });
    socket.addEventListener("error", () => {
      if (!channels.has(id)) return;
      channels.delete(id);
      sendUp({ t: "cdp.error", ch: id, message: "the local CDP connection failed" });
    });
  }

  function handleDown(raw) {
    let frame;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    switch (frame.t) {
      case "ping":
        sendUp({ t: "pong" });
        return;
      case "policy":
        policy.allowedHosts = Array.isArray(frame.allowedHosts) ? frame.allowedHosts : [];
        policy.appOrigin = typeof frame.appOrigin === "string" ? frame.appOrigin : policy.appOrigin;
        return;
      case "cdp.open":
        void openChannel(frame.ch);
        return;
      case "cdp.msg": {
        const socket = channels.get(frame.ch);
        if (!socket) return;
        const verdict = screenCdpMessage(frame.data, policy);
        if (!verdict.allow) {
          logger(`${verdict.neutralize ? "ignored" : "blocked"}: ${verdict.reason}`);
          // Answer the App ourselves — either an empty success for a
          // neutralized call, or a CDP-shaped error so Playwright surfaces a
          // real failure instead of hanging on a command that never returns.
          if (verdict.id !== undefined) {
            const reply = verdict.neutralize
              ? { id: verdict.id, sessionId: verdict.sessionId, result: {} }
              : {
                  id: verdict.id,
                  sessionId: verdict.sessionId,
                  error: { code: -32000, message: `Genosyn bridge: ${verdict.reason}` },
                };
            sendUp({ t: "cdp.msg", ch: frame.ch, data: JSON.stringify(reply) });
          }
          return;
        }
        try {
          socket.send(frame.data);
        } catch {
          // the close handler reports it
        }
        return;
      }
      case "cdp.close": {
        const socket = channels.get(frame.ch);
        channels.delete(frame.ch);
        try {
          socket?.close();
        } catch {
          // ignore
        }
        return;
      }
      default:
        return;
    }
  }

  return {
    policy,
    channels,
    handleDown,
    attach(socket) {
      app = socket;
      sendUp({
        t: "hello",
        agentVersion: AGENT_VERSION,
        platform: `${process.platform} ${os.release()}`,
        browserVersion: null,
      });
    },
    stop() {
      if (stopped) return;
      stopped = true;
      for (const socket of channels.values()) {
        try {
          socket.close();
        } catch {
          // ignore
        }
      }
      channels.clear();
      try {
        chrome?.kill?.();
      } catch {
        // ignore
      }
      chrome = null;
      chromeEndpoint = null;
    },
  };
}

async function commandRun() {
  const cfg = readConfig();
  if (!cfg) {
    throw new Error("Not paired yet. Run: node agent.mjs pair --server <url> --code <code>");
  }
  const server = assertServerUrlIsSafe(cfg.server);
  const socketUrl = new URL("/api/internal/member-browsers/socket", server);
  socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";

  let attempt = 0;
  let session = null;

  const shutdown = () => {
    session?.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  for (;;) {
    session = createBridgeSession({ name: cfg.name, appOrigin: server.origin });
    const closed = await new Promise((resolve) => {
      const socket = new WebSocket(socketUrl, {
        headers: { authorization: `Bearer ${cfg.token}` },
      });
      socket.addEventListener("open", () => {
        attempt = 0;
        log(`Connected to ${server.origin} as "${cfg.name}"`);
        session.attach(socket);
      });
      socket.addEventListener("message", (event) => {
        session.handleDown(typeof event.data === "string" ? event.data : String(event.data));
      });
      socket.addEventListener("close", (event) => resolve(event.reason || "disconnected"));
      socket.addEventListener("error", () => resolve("connection failed"));
    });
    session.stop();
    const wait = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
    attempt++;
    log(`Disconnected (${closed}). Reconnecting in ${Math.round(wait / 1000)}s…`);
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] ?? "run";
  switch (command) {
    case "pair":
      await commandPair(args);
      return;
    case "status":
      commandStatus();
      return;
    case "logout":
      commandLogout();
      return;
    case "run":
      await commandRun();
      return;
    default:
      process.stderr.write(
        `Unknown command "${command}".\n\n` +
          `  node agent.mjs pair --server <url> --code <code>\n` +
          `  node agent.mjs run\n` +
          `  node agent.mjs status\n` +
          `  node agent.mjs logout\n`,
      );
      process.exitCode = 1;
  }
}

// Only run when invoked directly, so the tests can import the pure pieces.
// `new URL(import.meta.url).pathname` percent-encodes spaces and keeps a
// leading slash before a Windows drive letter, so comparing it to argv[1]
// silently never matches on either — and the agent would exit 0 having done
// nothing. `fileURLToPath` is the decoder for exactly this.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
