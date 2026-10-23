import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";

import { CliError } from "./errors.js";
import type { HttpOptions } from "./http.js";
import {
  DEFAULT_SPEC_TTL_SECONDS,
  loadSpec,
  readCachedSpec,
  specCachePath,
  specTtlMs,
} from "./spec.js";
import { BASE, fakeFetch, json, syntheticSpec, tempDir } from "./test/support.js";

type Server = {
  version: string;
  etag?: string;
  spec: ReturnType<typeof syntheticSpec>;
  down?: boolean;
  html?: boolean;
};

function install(server: Server) {
  const { fetch, requests } = fakeFetch({
    "GET /api/health": () => json({ ok: true, version: server.version }),
    "GET /api/openapi.json": (request) => {
      if (server.html) return new Response("<html>login</html>", { headers: { "content-type": "text/html" } });
      if (server.etag && request.headers.get("if-none-match") === server.etag) {
        return new Response(null, { status: 304 });
      }
      return json(server.spec, 200, server.etag ? { etag: server.etag } : {});
    },
  });
  const guarded = (async (input: string | URL | Request, init?: RequestInit) => {
    if (server.down) {
      throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("refused"), { code: "ECONNREFUSED" }) });
    }
    return fetch(input, init);
  }) as typeof globalThis.fetch;
  const paths = () => requests.map((request) => `${request.method} ${request.url.pathname}`);
  return { fetch: guarded, requests, paths };
}

function setup(t: { after: (fn: () => void) => void }, server: Server) {
  const dir = tempDir(t);
  const clock = { now: 1_000_000 };
  const fake = install(server);
  const http: HttpOptions = {
    fetch: fake.fetch,
    timeoutMs: 5_000,
    now: () => clock.now,
    sleep: async () => {},
    retries: 0,
  };
  const load = (refresh = false, ttlMs = 300_000) =>
    loadSpec({ baseUrl: BASE, cacheDirectory: dir, http, ttlMs, refresh });
  return { dir, clock, fake, load };
}

describe("the API description cache", () => {
  test("downloads once, then answers from the cache within the window", async (t) => {
    const server: Server = { version: "1.0.0", spec: syntheticSpec("1.0.0") };
    const { dir, clock, fake, load } = setup(t, server);
    const first = await load();
    assert.equal(first.source, "network");
    assert.equal(first.serverVersion, "1.0.0");
    assert.deepEqual(fake.paths(), ["GET /api/openapi.json"]);
    const file = specCachePath(dir, BASE);
    assert.ok(fs.existsSync(file));
    if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);

    clock.now += 60_000;
    const second = await load();
    assert.equal(second.source, "cache");
    assert.deepEqual(second.document, first.document);
    assert.equal(fake.requests.length, 1, "no network inside the window");
  });

  test("after the window, asks the version and keeps the copy when it hasn't moved", async (t) => {
    const server: Server = { version: "1.0.0", spec: syntheticSpec("1.0.0") };
    const { clock, fake, load } = setup(t, server);
    await load();
    clock.now += 301_000;
    const again = await load();
    assert.equal(again.source, "cache");
    assert.deepEqual(fake.paths(), ["GET /api/openapi.json", "GET /api/health"]);
    clock.now += 60_000;
    await load();
    assert.equal(fake.requests.length, 2, "the version check restarts the window");
  });

  test("downloads again when the server's version changes", async (t) => {
    const server: Server = { version: "1.0.0", spec: syntheticSpec("1.0.0") };
    const { clock, fake, load } = setup(t, server);
    await load();
    server.version = "1.1.0";
    server.spec = syntheticSpec("1.1.0");
    server.spec.paths!["/api/companies/{cid}/new-thing"] = {
      get: { operationId: "listNewThings", tags: ["Goals"], "x-genosyn-access": { apiKey: true }, responses: {} },
    };
    clock.now += 301_000;
    const updated = await load();
    assert.equal(updated.source, "network");
    assert.equal(updated.serverVersion, "1.1.0");
    assert.ok(updated.document.paths?.["/api/companies/{cid}/new-thing"]);
    assert.deepEqual(fake.paths(), ["GET /api/openapi.json", "GET /api/health", "GET /api/openapi.json"]);
  });

  test("revalidates with If-None-Match and keeps the copy on a 304", async (t) => {
    const server: Server = { version: "1.0.0", spec: syntheticSpec("1.0.0"), etag: 'W/"abc"' };
    const { clock, fake, load } = setup(t, server);
    await load();
    server.version = "1.0.1";
    clock.now += 301_000;
    const revalidated = await load();
    assert.equal(revalidated.source, "network");
    assert.equal(revalidated.serverVersion, "1.0.1");
    const conditional = fake.requests.at(-1)!;
    assert.equal(conditional.headers.get("if-none-match"), 'W/"abc"');
    clock.now += 301_000;
    await load();
    assert.equal(fake.requests.at(-1)?.url.pathname, "/api/health", "the stored version now matches");
  });

  test("refresh skips the window and the version check", async (t) => {
    const server: Server = { version: "1.0.0", spec: syntheticSpec("1.0.0"), etag: '"v1"' };
    const { fake, load } = setup(t, server);
    await load();
    const refreshed = await load(true);
    assert.equal(refreshed.source, "network");
    assert.deepEqual(fake.paths(), ["GET /api/openapi.json", "GET /api/openapi.json"]);
    assert.equal(fake.requests[1].headers.get("if-none-match"), '"v1"');
  });

  test("uses the cached copy, saying why, when the server can't be reached", async (t) => {
    const server: Server = { version: "1.0.0", spec: syntheticSpec("1.0.0") };
    const { clock, load } = setup(t, server);
    await load();
    server.down = true;
    clock.now += 301_000;
    const stale = await load();
    assert.equal(stale.source, "cache");
    assert.match(stale.staleReason ?? "", /Connection refused/);
  });

  test("fails with a network error when nothing is cached and the server is down", async (t) => {
    const { load } = setup(t, { version: "1", spec: syntheticSpec(), down: true });
    await assert.rejects(load(), (error: unknown) => error instanceof CliError && error.exitCode === 9);
  });

  test("refuses an address that doesn't serve an OpenAPI document", async (t) => {
    const { load } = setup(t, { version: "1", spec: syntheticSpec(), html: true });
    await assert.rejects(
      load(),
      (error: unknown) => error instanceof CliError && error.kind === "network" && /doesn't look like Genosyn/.test(error.message),
    );
  });

  test("ignores a corrupt cache and keeps installs apart", async (t) => {
    const server: Server = { version: "1.0.0", spec: syntheticSpec("1.0.0") };
    const { dir, fake, load } = setup(t, server);
    const file = specCachePath(dir, BASE);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{broken");
    assert.equal(readCachedSpec(file, BASE), null);
    await load();
    assert.equal(fake.requests.length, 1);
    assert.notEqual(specCachePath(dir, "https://other.test"), file);
    assert.equal(specCachePath(dir, BASE.toUpperCase()), file, "the same install in any case");
    assert.equal(readCachedSpec(file, "https://other.test"), null, "a copy never answers for another install");
  });

  test("reads GENOSYN_SPEC_TTL in seconds", () => {
    assert.equal(specTtlMs({}), DEFAULT_SPEC_TTL_SECONDS * 1000);
    assert.equal(specTtlMs({ GENOSYN_SPEC_TTL: "0" }), 0);
    assert.equal(specTtlMs({ GENOSYN_SPEC_TTL: "30" }), 30_000);
    assert.equal(specTtlMs({ GENOSYN_SPEC_TTL: "soon" }), DEFAULT_SPEC_TTL_SECONDS * 1000);
    assert.equal(specTtlMs({ GENOSYN_SPEC_TTL: "-5" }), DEFAULT_SPEC_TTL_SECONDS * 1000);
  });

  test("with a zero window, checks the version on every run", async (t) => {
    const server: Server = { version: "1.0.0", spec: syntheticSpec("1.0.0") };
    const { fake, load } = setup(t, server);
    await load(false, 0);
    await load(false, 0);
    await load(false, 0);
    assert.deepEqual(fake.paths(), ["GET /api/openapi.json", "GET /api/health", "GET /api/health"]);
  });
});
