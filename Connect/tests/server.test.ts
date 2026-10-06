import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { Logger } from "../src/log.js";
import { startConnect } from "../src/server.js";
import { fakeGoogle, testConfig } from "./helpers.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
    server.once("error", reject);
  });
}

test("startConnect listens, reports what it offers without secrets, and closes once", async () => {
  const lines: string[] = [];
  const log: Logger = { info: (line) => lines.push(line), warn: () => {}, error: () => {} };
  const config = testConfig({ port: await freePort() });
  const running = await startConnect(config, { log, fetch: fakeGoogle().fetch });
  const base = `http://127.0.0.1:${config.port}`;
  assert.deepEqual(await (await fetch(`${base}/healthz`)).json(), { ok: true });
  assert.equal(running.store.name, "memory");
  assert.equal(lines.length, 1);
  assert.match(
    lines[0],
    /listening on 127\.0\.0\.1:\d+ as https:\/\/connect\.example\.test; memory store; offering google \(gmail, calendar\)/,
  );
  for (const secret of [config.secret, config.google!.clientSecret]) {
    assert.equal(lines[0].includes(secret), false);
  }
  const first = running.close();
  assert.equal(running.close(), first);
  await first;
  await assert.rejects(fetch(`${base}/healthz`));
});

test("an unconfigured provider is reported as such at startup", async () => {
  const lines: string[] = [];
  const log: Logger = { info: (line) => lines.push(line), warn: () => {}, error: () => {} };
  const running = await startConnect(testConfig({ port: await freePort(), google: null }), { log });
  assert.match(lines[0], /no providers configured yet/);
  await running.close();
});

function run(env: Record<string, string>) {
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: root,
    env: { PATH: process.env.PATH ?? "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const exited = new Promise<number | null>((resolve) =>
    child.once("exit", (code) => resolve(code)),
  );
  return { child, exited, output: () => output };
}

test("the entry point refuses to start with a broken configuration and lists every problem", async () => {
  const process = run({
    CONNECT_PUBLIC_URL: "http://connect.example.com",
    CONNECT_GOOGLE_CLIENT_ID: "only-id",
  });
  assert.equal(await process.exited, 1);
  assert.match(process.output(), /Genosyn Connect is not configured correctly/);
  assert.match(process.output(), /CONNECT_PUBLIC_URL must be an HTTPS origin/);
  assert.match(
    process.output(),
    /Set both CONNECT_GOOGLE_CLIENT_ID and CONNECT_GOOGLE_CLIENT_SECRET/,
  );
});

test("the entry point serves until SIGTERM and then exits cleanly", async () => {
  const port = await freePort();
  const service = run({
    PORT: String(port),
    CONNECT_LISTEN_HOST: "127.0.0.1",
    CONNECT_PUBLIC_URL: `http://localhost:${port}`,
    CONNECT_GOOGLE_CLIENT_ID: "client.apps.googleusercontent.com",
    CONNECT_GOOGLE_CLIENT_SECRET: "never-logged-secret",
  });
  try {
    const deadline = Date.now() + 20_000;
    while (!/listening on/.test(service.output())) {
      assert.ok(Date.now() < deadline, `no startup line: ${service.output()}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const status = await fetch(`http://127.0.0.1:${port}/api/connect/google/status`);
    assert.equal(status.status, 200);
    assert.equal(((await status.json()) as { available: boolean }).available, true);
    while (!/GET \/api\/connect\/google\/status 200 \d+ms/.test(service.output())) {
      assert.ok(Date.now() < deadline, `no access log line: ${service.output()}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.match(service.output(), /CONNECT_SECRET is not set/);
    service.child.kill("SIGTERM");
    assert.equal(await service.exited, 0);
    assert.match(service.output(), /SIGTERM received/);
    assert.equal(service.output().includes("never-logged-secret"), false);
  } finally {
    service.child.kill("SIGKILL");
  }
});

test("the entry point names the failure when its port is taken", async () => {
  const blocker = net.createServer();
  await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", () => resolve()));
  const { port } = blocker.address() as net.AddressInfo;
  try {
    const service = run({
      PORT: String(port),
      CONNECT_LISTEN_HOST: "127.0.0.1",
      CONNECT_PUBLIC_URL: "http://localhost:1",
    });
    assert.equal(await service.exited, 1);
    assert.match(service.output(), /could not start: Error \(EADDRINUSE\)/);
  } finally {
    blocker.close();
  }
});
