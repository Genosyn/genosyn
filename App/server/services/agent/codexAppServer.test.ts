import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CodexAppServer } from "./codexAppServer.js";

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
  await withFakeServer(async ({ entrypoint, home, cwd }) => {
    const notifications: string[] = [];
    const server = await CodexAppServer.start({
      entrypoint,
      cwd,
      env: { PATH: process.env.PATH, CODEX_HOME: home, HOME: home },
    });
    const stop = server.onNotification((method) => notifications.push(method));
    const echoed = await server.request<{ value: number }>("echo", { value: 42 });
    assert.deepEqual(echoed, { value: 42 });
    await server.request("notifyMe");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(notifications, ["fake/ready"]);
    stop();
    await server.close();
  });
});

test("Codex app-server routes dynamic calls and fails closed on other requests", async () => {
  await withFakeServer(async ({ entrypoint, home, cwd }) => {
    const seen: string[] = [];
    const server = await CodexAppServer.start({
      entrypoint,
      cwd,
      env: { PATH: process.env.PATH, CODEX_HOME: home, HOME: home },
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
    await server.close();
  });
});

test("protocol failures terminate a child that would otherwise stay alive", async () => {
  await withFakeServer(async ({ entrypoint, home, cwd }) => {
    const server = await CodexAppServer.start({
      entrypoint,
      cwd,
      env: { PATH: process.env.PATH, CODEX_HOME: home, HOME: home },
    });
    await assert.rejects(server.request("badJsonHang"), /emitted invalid JSON/);
    await server.close();
  });
});

async function withFakeServer(
  run: (paths: { entrypoint: string; home: string; cwd: string }) => Promise<void>,
): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "genosyn-codex-test-"));
  const home = path.join(root, "home");
  const cwd = path.join(root, "work");
  const entrypoint = path.join(root, "fake-app-server.mjs");
  await fs.mkdir(home, { mode: 0o700 });
  await fs.mkdir(cwd, { mode: 0o700 });
  await fs.writeFile(entrypoint, FAKE_SERVER, { mode: 0o600 });
  try {
    await run({ entrypoint, home, cwd });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
