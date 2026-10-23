import assert from "node:assert/strict";
import fs from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";

import express from "express";

import { createApp } from "../app.js";
import { exclusionFor, OUTSIDE_THE_API } from "../openapi/exclusions.js";
import { openApiCoverage } from "../openapi/spec.js";
import { CLI_BUNDLE_FILE, cliBundleCandidates, cliRouter } from "./cli.js";

/**
 * `GET /cli/genosyn-api.mjs`: every install hands out the CLI it was built
 * with, to anyone, as a script — and the API reference leaves the download
 * out, since it is a file rather than an operation.
 */

const servers: Server[] = [];
let dir: string;

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "genosyn-cli-route-"));
});

after(async () => {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

async function serve(app: express.Express): Promise<string> {
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function appWith(candidates: () => string[]): express.Express {
  const app = express();
  app.use("/cli", cliRouter({ candidates }));
  return app;
}

describe("the CLI download", () => {
  test("serves the bundle as JavaScript to anyone, with a filename", async () => {
    const file = path.join(dir, CLI_BUNDLE_FILE);
    fs.writeFileSync(file, "#!/usr/bin/env node\nconsole.log('hi');\n");
    const base = await serve(appWith(() => [path.join(dir, "missing.mjs"), file]));
    const response = await fetch(`${base}/cli/genosyn-api.mjs`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/javascript; charset=utf-8");
    assert.equal(response.headers.get("content-disposition"), 'inline; filename="genosyn-api.mjs"');
    assert.equal(response.headers.get("cache-control"), "no-cache");
    assert.ok(response.headers.get("etag"), "curl -z and browsers can revalidate");
    assert.equal(await response.text(), "#!/usr/bin/env node\nconsole.log('hi');\n");
  });

  test("answers 404 with a reason when the install was built without it, and finds it once built", async () => {
    const file = path.join(dir, "later", CLI_BUNDLE_FILE);
    const base = await serve(appWith(() => [file]));
    const missing = await fetch(`${base}/cli/genosyn-api.mjs`);
    assert.equal(missing.status, 404);
    assert.match(((await missing.json()) as { error: string }).error, /npm run build:cli/);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "built");
    const found = await fetch(`${base}/cli/genosyn-api.mjs`);
    assert.equal(found.status, 200);
    assert.equal(await found.text(), "built");
  });

  test("serves nothing else under /cli", async () => {
    const base = await serve(appWith(() => []));
    assert.equal((await fetch(`${base}/cli/other.mjs`)).status, 404);
    assert.equal((await fetch(`${base}/cli/genosyn-api.mjs`, { method: "POST" })).status, 404);
  });

  test("looks for the bundle beside the compiled server and in dev's dist/", () => {
    const candidates = cliBundleCandidates();
    assert.equal(candidates.length, 2);
    for (const candidate of candidates) assert.equal(path.basename(candidate), CLI_BUNDLE_FILE);
    assert.ok(candidates.some((candidate) => candidate.endsWith(path.join("dist", "cli", CLI_BUNDLE_FILE))));
  });

  test("createApp() mounts it, and the API reference leaves it out", async () => {
    const app = createApp();
    const base = await serve(app);
    const response = await fetch(`${base}/cli/genosyn-api.mjs`);
    assert.ok([200, 404].includes(response.status));
    if (response.status === 404) {
      assert.match(((await response.json()) as { error: string }).error, /genosyn-api CLI/);
    } else {
      assert.match(await response.text(), /^#!\/usr\/bin\/env node/);
    }
    assert.equal(exclusionFor("GET", "/cli/genosyn-api.mjs"), OUTSIDE_THE_API);
    const report = openApiCoverage(app);
    assert.ok(report.excluded.some((route) => route.path === "/cli/genosyn-api.mjs"));
    assert.ok(!report.documented.some((operation) => operation.path.startsWith("/cli")));
  });
});
