import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CodexAppServer, type CodexAppServerOptions } from "./codexAppServer.js";

const FAKE_SERVER = String.raw`
import readline from "node:readline";

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const waiting = new Map();
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");

lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({
      id: message.id,
      result: {
        userAgent: "fake",
        codexHome: process.env.CODEX_HOME,
        platformFamily: "test",
        platformOs: "test",
      },
    });
    return;
  }
  if (message.method === "initialized") {
    return;
  }
  if (message.method === "notifyMe") {
    send({ id: message.id, result: {} });
    send({ method: "fake/ready", params: { ok: true } });
    return;
  }
  if (message.method === "echo") {
    send({ id: message.id, result: message.params });
    return;
  }
  if (message.method === "floodStderr") {
    process.stderr.write("x".repeat(4000) + "\n");
    process.stderr.write("oauth token exchange transport failure is_connect=true\n");
    send({ id: message.id, result: {} });
    return;
  }
  if (message.method === "badJsonHang") {
    process.stdout.write("not-json\n");
    setInterval(() => undefined, 1000);
    return;
  }
  if (message.method === "triggerTool") {
    waiting.set(700, { requestId: message.id, kind: "tool" });
    send({
      id: 700,
      method: "item/tool/call",
      params: {
        threadId: "thread",
        turnId: "turn",
        callId: "call",
        namespace: null,
        tool: "lookup",
        arguments: { id: "ABC" },
      },
    });
    return;
  }
  if (message.method === "triggerDenied") {
    waiting.set(701, { requestId: message.id, kind: "denied" });
    send({
      id: 701,
      method: "item/fileChange/requestApproval",
      params: { threadId: "thread", turnId: "turn" },
    });
    return;
  }
  if (waiting.has(message.id)) {
    const pending = waiting.get(message.id);
    waiting.delete(message.id);
    send({
      id: pending.requestId,
      result:
        pending.kind === "tool"
          ? message.result
          : { denied: Boolean(message.error), errorCode: message.error?.code ?? null },
    });
  }
});
`;

test("Codex app-server transport performs the handshake and streams notifications", async () => {
  await withFakeServer(async ({ start }) => {
    const notifications: string[] = [];
    const server = await start();
    const stop = server.onNotification((method) => notifications.push(method));
    const echoed = await server.request<{ value: number }>("echo", { value: 42 });
    assert.deepEqual(echoed, { value: 42 });
    await server.request("notifyMe");
    // The notification is a second line on the child's stdout, so it can land
    // in a later read than the response we just awaited. Waiting for it beats
    // assuming one turn of the loop is enough — under a loaded machine it is
    // not, and this assertion was the flake that hung the suite.
    await waitUntil(() => notifications.length > 0, "the fake/ready notification");
    assert.deepEqual(notifications, ["fake/ready"]);
    stop();
  });
});

test("Codex app-server routes dynamic calls and fails closed on other requests", async () => {
  await withFakeServer(async ({ start }) => {
    const seen: string[] = [];
    const server = await start({
      onServerRequest: async (method, params) => {
        seen.push(method);
        if (method !== "item/tool/call") throw new Error("denied");
        return {
          contentItems: [{ type: "inputText", text: JSON.stringify(params) }],
          success: true,
        };
      },
    });

    const tool = await server.request<{ success: boolean }>("triggerTool");
    assert.equal(tool.success, true);
    const denied = await server.request<{ denied: boolean; errorCode: number }>("triggerDenied");
    assert.deepEqual(denied, { denied: true, errorCode: -32000 });
    assert.deepEqual(seen, ["item/tool/call", "item/fileChange/requestApproval"]);
  });
});

test("protocol failures terminate a child that would otherwise stay alive", async () => {
  await withFakeServer(async ({ start }) => {
    const server = await start();
    await assert.rejects(server.request("badJsonHang"), /emitted invalid JSON/);
  });
});

test("the stderr summary keeps the last thing Codex said, not the first", async () => {
  await withFakeServer(async ({ start }) => {
    const server = await start();
    await server.request("floodStderr");
    await waitUntil(
      () => server.stderrSummary().includes("oauth token exchange transport failure"),
      "the trailing stderr diagnostic",
    );
    const summary = server.stderrSummary();
    assert.ok(
      summary.includes("oauth token exchange transport failure is_connect=true"),
      `expected the trailing diagnostic, got: ${summary.slice(0, 120)}…`,
    );
    assert.ok(summary.length <= 1_000);
  });
});

/** Poll until `condition` holds, so a test never depends on how many turns of
 * the event loop a child's stdout happens to take. */
async function waitUntil(
  condition: () => boolean,
  what: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * Run a test body against a throwaway fake app-server on disk.
 *
 * Servers are started through the injected `start` so this owns their
 * lifecycle. That ownership is the point: a `CodexAppServer` holds a spawned
 * child with piped stdio, and those pipes keep *this* process alive. Started
 * inside the body and closed on the last line, a single failed assertion skips
 * the close, leaks the child, and the test process then never exits — so
 * `npm test` stops dead instead of reporting a failure, and the run sits there
 * until CI's job timeout. Closing in `finally` turns that back into an
 * ordinary red test.
 */
async function withFakeServer(
  run: (ctx: {
    entrypoint: string;
    home: string;
    cwd: string;
    start: (overrides?: Partial<CodexAppServerOptions>) => Promise<CodexAppServer>;
  }) => Promise<void>,
): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "genosyn-codex-test-"));
  const home = path.join(root, "home");
  const cwd = path.join(root, "work");
  const entrypoint = path.join(root, "fake-app-server.mjs");
  await fs.mkdir(home, { mode: 0o700 });
  await fs.mkdir(cwd, { mode: 0o700 });
  await fs.writeFile(entrypoint, FAKE_SERVER, { mode: 0o600 });
  const started: CodexAppServer[] = [];
  const start = async (
    overrides: Partial<CodexAppServerOptions> = {},
  ): Promise<CodexAppServer> => {
    const server = await CodexAppServer.start({
      entrypoint,
      cwd,
      env: { PATH: process.env.PATH, CODEX_HOME: home, HOME: home },
      ...overrides,
    });
    started.push(server);
    return server;
  };
  try {
    await run({ entrypoint, home, cwd, start });
  } finally {
    for (const server of started) {
      await server.close().catch(() => undefined);
    }
    await fs.rm(root, { recursive: true, force: true });
  }
}
