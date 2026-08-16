import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { WebSocketServer, type WebSocket } from "ws";

/**
 * The bridge agent is the half of this feature that runs on a human's own
 * computer, which makes it the one place where a refusal cannot be argued with
 * by a compromised or prompt-injected server. Its screening functions are
 * therefore tested directly, and the whole thing is then run as a real child
 * process against a fake App and a fake Chrome — because "the deny list is
 * correct" and "the deny list is on the wire" are different claims.
 */

const AGENT_PATH = fileURLToPath(new URL("./agent.mjs", import.meta.url));
const BRIDGE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "genosyn-bridge-test-"));
// The agent reads this once, at module load, for both the imported copy below
// and every child process spawned here — so nothing touches the real ~/.genosyn.
process.env.GENOSYN_BRIDGE_HOME = BRIDGE_HOME;

type Policy = { allowedHosts: string[]; appOrigin: string };
type Verdict = {
  allow: boolean;
  reason?: string;
  id?: number;
  sessionId?: string;
  neutralize?: boolean;
};

type AgentModule = {
  AGENT_VERSION: string;
  DENIED_CDP_METHODS: Set<string>;
  NEUTRALIZED_CDP_METHODS: Set<string>;
  screenCdpMessage(raw: string, policy: Policy): Verdict;
  navigationAllowed(url: string, policy: Policy): Verdict;
  hostMatchesPattern(hostname: string, pattern: string): boolean;
  assertServerUrlIsSafe(serverUrl: string): URL;
  chromeStartupError(stderr: string, exitCode: number | null): string;
  readConfig(): { server: string; browserId: string; name: string; token: string } | null;
};

// agent.mjs ships to a Member's machine as plain, dependency-free JavaScript,
// so it is deliberately outside the TypeScript build and has no declarations.
// A computed specifier keeps that a runtime fact rather than a compile error.
const agent = (await import(pathToFileURL(AGENT_PATH).href)) as AgentModule;

const POLICY: Policy = {
  allowedHosts: ["example.com", "*.shop.test"],
  appOrigin: "https://genosyn.example.com",
};

const children = new Set<ChildProcess>();
const servers = new Set<Server>();

after(async () => {
  for (const child of children) killTree(child);
  children.clear();
  await Promise.all(
    [...servers].map(
      (server) =>
        new Promise<void>((resolve) => {
          // The bridge socket is a live connection; `close()` alone would wait
          // for it and hang the run instead of ending it.
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
  servers.clear();
  fs.rmSync(BRIDGE_HOME, { recursive: true, force: true });
});

function cdp(id: number, method: string, params?: Record<string, unknown>): string {
  return JSON.stringify({ id, method, params: params ?? {} });
}

describe("the CDP deny list", () => {
  test("refuses every denied method and answers it with the original message id", () => {
    assert.ok(agent.DENIED_CDP_METHODS.size > 0);
    for (const [index, method] of [...agent.DENIED_CDP_METHODS].entries()) {
      const verdict = agent.screenCdpMessage(cdp(index + 1, method), POLICY);
      assert.equal(verdict.allow, false, method);
      // Without the id the App would hang on a command that never returns,
      // instead of surfacing a real error to the model.
      assert.equal(verdict.id, index + 1, method);
      assert.match(String(verdict.reason), new RegExp(method.replace(".", "\\.")));
    }
  });

  test("covers the bulk credential readout Playwright's storageState() uses", () => {
    for (const method of ["Network.getAllCookies", "Storage.getCookies"]) {
      assert.equal(agent.DENIED_CDP_METHODS.has(method), true, method);
    }
    // Reading the human's cookie jar is the failure this whole design exists to
    // prevent, so the laptop refuses it even if the App forgets to.
    assert.equal(agent.screenCdpMessage(cdp(1, "Network.getAllCookies"), POLICY).allow, false);
  });

  test("lets ordinary driving traffic and CDP replies through untouched", () => {
    assert.equal(agent.screenCdpMessage(cdp(1, "Runtime.evaluate"), POLICY).allow, true);
    assert.equal(agent.screenCdpMessage(cdp(2, "Page.enable"), POLICY).allow, true);
    // A reply carries no method at all and must not be mistaken for a command.
    assert.equal(agent.screenCdpMessage('{"id":3,"result":{}}', POLICY).allow, true);
  });

  test("refuses a message it cannot parse", () => {
    assert.equal(agent.screenCdpMessage("not json", POLICY).allow, false);
  });

  test("echoes the sessionId back so a refusal cannot crash the App", () => {
    // Playwright flattens every CDP session onto one socket and routes replies
    // by sessionId. A synthetic reply without it lands on the root session,
    // which has no pending callback for that id and throws an assertion from a
    // timer — an uncaught exception that killed the whole server before this
    // was fixed. Refusing a navigation must cost one tool call, not the process.
    const raw = JSON.stringify({
      id: 42,
      sessionId: "SESSION-ABC",
      method: "Page.navigate",
      params: { url: "https://not-allowed.test" },
    });
    const verdict = agent.screenCdpMessage(raw, POLICY);
    assert.equal(verdict.allow, false);
    assert.equal(verdict.id, 42);
    assert.equal(verdict.sessionId, "SESSION-ABC");
  });

  test("answers the download-behaviour calls with success instead of an error", () => {
    // Playwright issues these during connectOverCDP's own handshake, not
    // because the model asked. Erroring makes the connection fail outright and
    // the feature simply does not work; acking without forwarding leaves Chrome
    // on its own default handling, which is what we want anyway.
    for (const method of agent.NEUTRALIZED_CDP_METHODS) {
      const verdict = agent.screenCdpMessage(cdp(7, method), POLICY);
      assert.equal(verdict.allow, false, method);
      assert.equal(verdict.neutralize, true, method);
      assert.equal(verdict.id, 7, method);
    }
    assert.equal(agent.NEUTRALIZED_CDP_METHODS.has("Browser.setDownloadBehavior"), true);
    // A neutralized method must not also be in the deny list, or the reply
    // shape depends on which check runs first.
    for (const method of agent.NEUTRALIZED_CDP_METHODS) {
      assert.equal(agent.DENIED_CDP_METHODS.has(method), false, method);
    }
  });
});

describe("navigation screening", () => {
  test("refuses schemes that reach the human's disk or their browser settings", () => {
    for (const url of [
      "file:///etc/passwd",
      "file:///Users/someone/.ssh/id_rsa",
      "chrome://settings/passwords",
      "chrome-extension://abc/page.html",
      "devtools://devtools/bundled/inspector.html",
    ]) {
      const verdict = agent.navigationAllowed(url, POLICY);
      assert.equal(verdict.allow, false, url);
      assert.match(String(verdict.reason), /refusing to open/i);
    }
  });

  test("refuses Genosyn itself", () => {
    // It would arrive carrying nothing useful and everything risky: the human's
    // own Genosyn session lives in that browser.
    const verdict = agent.navigationAllowed("https://genosyn.example.com/settings", POLICY);
    assert.equal(verdict.allow, false);
    assert.match(String(verdict.reason), /Genosyn itself/i);
  });

  test("refuses a host that is not on this browser's list", () => {
    assert.equal(agent.navigationAllowed("https://attacker.test/", POLICY).allow, false);
    assert.equal(agent.navigationAllowed("https://example.com/orders", POLICY).allow, true);
    assert.equal(agent.navigationAllowed("https://eu.shop.test/", POLICY).allow, true);
  });

  test("refuses everything when the allow list is empty", () => {
    const empty: Policy = { allowedHosts: [], appOrigin: "" };
    const verdict = agent.navigationAllowed("https://example.com/", empty);
    assert.equal(verdict.allow, false);
    assert.match(String(verdict.reason), /no allowed hosts/i);
  });

  test("permits about:blank, which is how Playwright opens a fresh tab", () => {
    const opened = agent.screenCdpMessage(cdp(1, "Page.navigate", { url: "about:blank" }), POLICY);
    assert.equal(opened.allow, true);
    // Only as a navigation target, though — the scheme itself stays refused.
    assert.equal(agent.navigationAllowed("about:blank", POLICY).allow, false);
  });

  test("screens every method that carries a navigation, not just Page.navigate", () => {
    for (const method of ["Page.navigate", "Page.navigateToHistoryEntry", "Target.createTarget"]) {
      const verdict = agent.screenCdpMessage(
        cdp(9, method, { url: "https://attacker.test/" }),
        POLICY,
      );
      assert.equal(verdict.allow, false, method);
      assert.equal(verdict.id, 9, method);
    }
  });

  test("refuses a malformed URL rather than passing it to Chrome to interpret", () => {
    assert.equal(agent.navigationAllowed("https://", POLICY).allow, false);
  });
});

describe("host glob matching", () => {
  test("never lets a star cross a dot", () => {
    // The whole reason the glob is label-scoped: a suffix that merely starts
    // with an allowed name is a different site owned by somebody else.
    assert.equal(agent.hostMatchesPattern("example.attacker.com", "example.*"), false);
    assert.equal(agent.hostMatchesPattern("example.co.uk", "example.*"), false);
    assert.equal(agent.hostMatchesPattern("example.com", "example.*"), true);
    assert.equal(agent.hostMatchesPattern("app.eu.west.example.com", "app.*.example.com"), false);
    assert.equal(agent.hostMatchesPattern("app.eu.example.com", "app.*.example.com"), true);
  });

  test("matches the apex and every subdomain for the *. form", () => {
    assert.equal(agent.hostMatchesPattern("example.com", "*.example.com"), true);
    assert.equal(agent.hostMatchesPattern("mail.example.com", "*.example.com"), true);
    assert.equal(agent.hostMatchesPattern("a.b.example.com", "*.example.com"), true);
    assert.equal(agent.hostMatchesPattern("notexample.com", "*.example.com"), false);
    assert.equal(agent.hostMatchesPattern("example.com.attacker.test", "*.example.com"), false);
  });

  test("treats a bare pattern as an exact host and ignores case and padding", () => {
    assert.equal(agent.hostMatchesPattern("mail.google.com", "mail.google.com"), true);
    assert.equal(agent.hostMatchesPattern("MAIL.GOOGLE.COM", "  mail.google.com  "), true);
    assert.equal(agent.hostMatchesPattern("evil.mail.google.com", "mail.google.com"), false);
    assert.equal(agent.hostMatchesPattern("example.com", ""), false);
  });

  test("does not let a dot in a pattern match an arbitrary character", () => {
    // `.` is a regex metacharacter; unescaped, `mail.google.com` would also
    // admit `mailxgoogle.com`.
    assert.equal(agent.hostMatchesPattern("mailxgoogle.com", "mail.*"), false);
    assert.equal(agent.hostMatchesPattern("aexampleXcom", "*example.com"), false);
  });
});

describe("refusing to carry a bearer token in the clear", () => {
  test("rejects plain http for a remote host", () => {
    assert.throws(
      () => agent.assertServerUrlIsSafe("http://genosyn.example.com"),
      /Refusing to connect/,
    );
    assert.throws(() => agent.assertServerUrlIsSafe("http://192.168.1.10:3000"), /plain http/);
  });

  test("permits plain http on loopback, where there is no network to read", () => {
    assert.equal(
      agent.assertServerUrlIsSafe("http://127.0.0.1:3000").origin,
      "http://127.0.0.1:3000",
    );
    assert.equal(
      agent.assertServerUrlIsSafe("http://localhost:3000").origin,
      "http://localhost:3000",
    );
  });

  test("permits https anywhere", () => {
    assert.equal(
      agent.assertServerUrlIsSafe("https://genosyn.example.com").origin,
      "https://genosyn.example.com",
    );
  });
});

describe("explaining why Chrome would not start", () => {
  test("names the device-management policy when that is what refused", () => {
    const message = agent.chromeStartupError(
      "[1234:0x0] Remote debugging is disallowed by the system admin.",
      1,
    );
    assert.match(message, /RemoteDebuggingAllowed/);
    assert.match(message, /IT administrator/i);
  });

  test("names the profile directory when Chrome refused the default one", () => {
    const message = agent.chromeStartupError(
      "DevTools remote debugging requires a non-default data directory.",
      0,
    );
    assert.match(message, /own profile/i);
    assert.match(message, /GENOSYN_BRIDGE_HOME/);
  });

  test("falls back to the exit code and the tail of stderr", () => {
    const message = agent.chromeStartupError("something else went wrong", 7);
    assert.match(message, /code 7/);
    assert.match(message, /something else went wrong/);
    assert.doesNotMatch(agent.chromeStartupError("", null), /code/);
  });
});

// ---------------------------------------------------------------------------
// The real agent, as a child process, against a fake App and a fake Chrome.
// ---------------------------------------------------------------------------

type AppFrame = Record<string, unknown> & { t: string };

/**
 * A Chrome stand-in: it speaks the one part of Chrome's contract the agent
 * depends on — a `DevToolsActivePort` file in the profile directory and a
 * WebSocket at the path it names — and echoes whatever CDP reaches it, so the
 * test can tell "the agent forwarded this" from "the agent blocked this".
 */
function writeChromeStub(): string {
  const wsModule = pathToFileURL(createRequire(import.meta.url).resolve("ws")).href;
  const stubPath = path.join(BRIDGE_HOME, "chrome-stub.mjs");
  fs.writeFileSync(
    stubPath,
    `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
// ws is CommonJS, and a by-path import cannot see its named exports.
import ws from ${JSON.stringify(wsModule)};
const { WebSocketServer } = ws;

const flag = process.argv.find((arg) => arg.startsWith("--user-data-dir="));
const profileDir = flag.slice("--user-data-dir=".length);
const wss = new WebSocketServer({ host: "127.0.0.1", port: 0, path: "/devtools/browser/stub" });
wss.on("connection", (socket) => {
  socket.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    socket.send(JSON.stringify({ id: message.id, result: { reached: message.method } }));
  });
});
wss.on("listening", () => {
  fs.writeFileSync(
    path.join(profileDir, "DevToolsActivePort"),
    wss.address().port + "\\n/devtools/browser/stub\\n",
  );
});
process.on("SIGTERM", () => process.exit(0));
`,
    { mode: 0o755 },
  );
  return stubPath;
}

/** The App side: the pairing endpoint and the bridge socket, on one server. */
async function fakeApp(expectedCode: string, token: string) {
  const frames: AppFrame[] = [];
  const waiters: Array<{ match: (frame: AppFrame) => boolean; resolve: (f: AppFrame) => void }> =
    [];
  let bridge: WebSocket | null = null;
  let authorization: string | undefined;

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "POST" && req.url === "/api/internal/member-browsers/pair") {
      let raw = "";
      for await (const chunk of req) raw += String(chunk);
      const body = JSON.parse(raw) as { code: string };
      res.setHeader("content-type", "application/json");
      if (body.code !== expectedCode) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "That pairing code is not valid." }));
        return;
      }
      res.end(JSON.stringify({ browserId: "browser-1", name: "MacBook", token }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  servers.add(server);
  const sockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (req.url !== "/api/internal/member-browsers/socket") {
      socket.destroy();
      return;
    }
    authorization = req.headers.authorization;
    sockets.handleUpgrade(req, socket, head, (ws) => {
      bridge = ws;
      ws.on("message", (raw: Buffer) => {
        const frame = JSON.parse(raw.toString("utf8")) as AppFrame;
        const index = waiters.findIndex((waiter) => waiter.match(frame));
        if (index >= 0) waiters.splice(index, 1)[0]!.resolve(frame);
        else frames.push(frame);
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    authorization: () => authorization,
    connected: () => bridge !== null,
    send(frame: Record<string, unknown>) {
      bridge!.send(JSON.stringify(frame));
    },
    /** Take the next unread frame matching this predicate. */
    next(match: (frame: AppFrame) => boolean, what = "a frame"): Promise<AppFrame> {
      const index = frames.findIndex(match);
      if (index >= 0) return Promise.resolve(frames.splice(index, 1)[0]!);
      return new Promise<AppFrame>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), 20_000);
        waiters.push({
          match,
          resolve: (frame) => {
            clearTimeout(timer);
            resolve(frame);
          },
        });
      });
    },
  };
}

function runAgent(args: string[], env: Record<string, string> = {}): ChildProcess {
  const child = spawn(process.execPath, [AGENT_PATH, ...args], {
    env: { ...process.env, GENOSYN_BRIDGE_HOME: BRIDGE_HOME, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    // Its own process group, so teardown can take the Chrome it launched with
    // it. SIGKILL gives the agent no chance to clean up after itself, and a
    // surviving browser holds the runner's pipes open — a hung suite rather
    // than a failing one, which is far harder to read.
    detached: true,
  });
  children.add(child);
  return child;
}

/** Kill the agent and anything it started, not just the agent. */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // The group is already gone, or the child never made it that far.
    child.kill("SIGKILL");
  }
}

async function exited(child: ChildProcess): Promise<{ code: number | null; stderr: string }> {
  let stderr = "";
  child.stderr?.on("data", (chunk) => (stderr += String(chunk)));
  const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
  return { code, stderr };
}

async function until(condition: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("the agent as it actually runs", () => {
  test("pairs, connects, and relays CDP between the App and its own Chrome", async () => {
    const token = "bridge-token-" + "z".repeat(24);
    const app = await fakeApp("aaaabbbb-ccccdddd", token);

    const paired = await exited(
      runAgent(["pair", "--server", app.origin, "--code", "aaaabbbb-ccccdddd"]),
    );
    assert.equal(paired.code, 0, paired.stderr);
    const config = agent.readConfig();
    assert.equal(config?.token, token);
    assert.equal(config?.server, app.origin);
    // A bearer token at rest on somebody's laptop is owner-readable only.
    assert.equal(fs.statSync(path.join(BRIDGE_HOME, "browser-bridge.json")).mode & 0o077, 0);

    runAgent(["run"], { GENOSYN_CHROME_PATH: writeChromeStub() });
    await until(() => app.connected(), "the bridge socket");
    assert.equal(app.authorization(), `Bearer ${token}`);

    const hello = await app.next((frame) => frame.t === "hello", "the agent's hello");
    assert.equal(hello.agentVersion, agent.AGENT_VERSION);

    app.send({ t: "policy", allowedHosts: ["example.com"], appOrigin: app.origin });
    app.send({ t: "cdp.open", ch: "channel-1" });
    const opened = await app.next((frame) => frame.t === "cdp.opened", "the CDP channel");
    assert.equal(opened.ch, "channel-1");

    // Ordinary traffic reaches Chrome and its reply comes back on the channel.
    app.send({ t: "cdp.msg", ch: "channel-1", data: cdp(1, "Browser.getVersion") });
    const reply = await app.next((frame) => frame.t === "cdp.msg", "Chrome's reply");
    assert.deepEqual(JSON.parse(String(reply.data)), {
      id: 1,
      result: { reached: "Browser.getVersion" },
    });

    // A denied method never reaches Chrome, and the refusal comes back in CDP's
    // own error shape so Playwright fails the call instead of hanging on it.
    app.send({ t: "cdp.msg", ch: "channel-1", data: cdp(2, "Network.getAllCookies") });
    const refusal = await app.next((frame) => frame.t === "cdp.msg", "the refusal");
    const decoded = JSON.parse(String(refusal.data)) as {
      id: number;
      error: { code: number; message: string };
      result?: unknown;
    };
    assert.equal(decoded.id, 2);
    assert.equal(decoded.result, undefined);
    assert.equal(decoded.error.code, -32000);
    assert.match(decoded.error.message, /Genosyn bridge: Network\.getAllCookies/);

    // Same for a navigation off the list the App just pushed down.
    app.send({
      t: "cdp.msg",
      ch: "channel-1",
      data: cdp(3, "Page.navigate", { url: "https://attacker.test/" }),
    });
    const blockedNavigation = JSON.parse(
      String((await app.next((frame) => frame.t === "cdp.msg", "the blocked navigation")).data),
    ) as { id: number; error: { message: string } };
    assert.equal(blockedNavigation.id, 3);
    assert.match(blockedNavigation.error.message, /attacker\.test is not on this browser's allow/);

    app.send({
      t: "cdp.msg",
      ch: "channel-1",
      data: cdp(4, "Page.navigate", { url: "https://example.com/orders" }),
    });
    const allowedNavigation = JSON.parse(
      String((await app.next((frame) => frame.t === "cdp.msg", "the allowed navigation")).data),
    ) as { id: number; result?: { reached?: string } };
    assert.equal(allowedNavigation.id, 4);
    assert.equal(allowedNavigation.result?.reached, "Page.navigate");
  });

  test("refuses to run before it has been paired", async () => {
    const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), "genosyn-bridge-unpaired-"));
    try {
      const result = await exited(runAgent(["run"], { GENOSYN_BRIDGE_HOME: emptyHome }));
      assert.equal(result.code, 1);
      assert.match(result.stderr, /Not paired yet/);
    } finally {
      fs.rmSync(emptyHome, { recursive: true, force: true });
    }
  });

  test("refuses to pair against a plain-http server that is not loopback", async () => {
    const result = await exited(
      runAgent(["pair", "--server", "http://genosyn.example.com", "--code", "aaaabbbbccccdddd"], {
        GENOSYN_BRIDGE_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "genosyn-bridge-http-")),
      }),
    );
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Refusing to connect/);
  });

  test("reports the App's own message when a pairing code is rejected", async () => {
    const app = await fakeApp("the-right-code", "unused");
    const result = await exited(
      runAgent(["pair", "--server", app.origin, "--code", "the-wrong-code"], {
        GENOSYN_BRIDGE_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "genosyn-bridge-wrong-")),
      }),
    );
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Pairing failed: That pairing code is not valid\./);
  });
});
