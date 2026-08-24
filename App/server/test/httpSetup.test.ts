import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile } from "node:fs/promises";
import { after, before, describe, test } from "node:test";

// Self-sufficient: the module is normally preloaded by the `test` script, but
// importing it here means this file also holds when run on its own.
import "./httpSetup.js";

/**
 * Guards the two halves of the fix in `httpSetup.ts`: that disabling keep-alive
 * really does stop connection reuse, and that the test script still preloads
 * it. Losing either one brings back a flake that only shows up under CI load,
 * in a different test file on every run — the kind of regression that is very
 * expensive to diagnose a second time.
 */
describe("test-run HTTP setup", () => {
  let server: Server;
  let baseUrl: string;
  let connections = 0;

  before(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    server.on("connection", () => {
      connections += 1;
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  test("global fetch opens a fresh connection per request", async () => {
    for (let i = 0; i < 3; i += 1) {
      const res = await fetch(`${baseUrl}/`);
      await res.text();
    }
    // Pooled, this would be 1. Unpooled there is no idle socket for the
    // server's real-time keep-alive timer and undici's virtual one to
    // disagree about, which is the entire point.
    assert.equal(connections, 3);
  });

  test("`npm test` preloads this setup", async () => {
    const pkg = JSON.parse(
      await readFile(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { scripts: { test: string } };
    assert.match(pkg.scripts.test, /--import \.\/server\/test\/httpSetup\.ts/);
  });
});
