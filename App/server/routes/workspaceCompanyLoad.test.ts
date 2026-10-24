import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";

import express, { Router } from "express";

import type { Company } from "../db/entities/Company.js";
import { errorHandler } from "../middleware/error.js";
import {
  createMemberOfNewCompany,
  mintTestApiKey,
  withTestInstanceSecrets,
} from "../test/apiAccess.js";
import { closeTestDb, initTestDb } from "../test/dbHarness.js";
import { failNextRead } from "../test/failedReads.js";
import { workspaceRouter } from "./workspace.js";

/**
 * The workspace router loads the company in the URL before its own routes run:
 * each of them answers for that company, and an upload needs its slug to know
 * where the bytes go. The group chat and discussion routes are mounted after it
 * at `/api/companies/:cid/workspace`, so the load is kept to the router's own
 * paths (unscoped, it cost each of their requests a Company read), and a read
 * that fails answers the request instead of leaving it open.
 */

const LATER = "/after-workspace";

const app = express();
app.use(express.json());
app.use("/api/companies/:cid/workspace", workspaceRouter);
// Mounted after the workspace router at the same place, the way the group
// discussion routes are.
const later = Router({ mergeParams: true });
later.get(LATER, (req, res) => {
  res.json({ company: (req as { company?: Company }).company?.id ?? null });
});
app.use("/api/companies/:cid/workspace", later);
app.use(errorHandler);

let server: Server;
let baseUrl = "";
let restoreSecrets: () => void;
let companyId = "";
let authorization = "";

before(async () => {
  restoreSecrets = withTestInstanceSecrets();
  await initTestDb();
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const { user, company } = await createMemberOfNewCompany("member");
  companyId = company.id;
  // Used a moment ago, so a request does not also record the use.
  const { token } = await mintTestApiKey(user.id, companyId, { lastUsedAt: new Date() });
  authorization = `Bearer ${token}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
  restoreSecrets();
});

function send(path: string, init: { method?: string; body?: FormData } = {}): Promise<Response> {
  return fetch(`${baseUrl}/api/companies/${companyId}/workspace${path}`, {
    method: init.method,
    headers: { authorization },
    body: init.body,
    // A request the server leaves open fails here, not at the suite's timeout.
    signal: AbortSignal.timeout(5_000),
  });
}

/**
 * Every route the router serves, with its parameters filled in.
 *
 * Read from the router rather than listed by hand, so that a route added later
 * is checked here even if nobody remembers to add its path to the ones the
 * Company is loaded for.
 */
function workspaceRoutes(): Array<{ route: string; method: string; path: string }> {
  return workspaceRouter.stack.flatMap((layer) => {
    if (!layer.route) return [];
    const { path: pattern, stack } = layer.route;
    const path = pattern.replace(/:(\w+)/g, () => randomUUID());
    const methods = new Set(stack.map((handler) => handler.method.toUpperCase()));
    return [...methods].map((method) => ({ route: `${method} ${pattern}`, method, path }));
  });
}

describe("the company it loads", () => {
  test("files an upload under the company, and the file comes back", async () => {
    const bytes = "Quarterly numbers\n";
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: "text/plain" }), "numbers.txt");
    const uploaded = await send("/attachments", { method: "POST", body: form });
    assert.equal(uploaded.status, 201);
    const { id } = (await uploaded.json()) as { id: string };

    const file = await send(`/attachments/${id}`);
    assert.equal(file.status, 200);
    assert.equal(await file.text(), bytes);
  });

  test("is loaded for workspace routes only, not for routers mounted after it", async () => {
    const response = await send(LATER);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { company: null });
  });

  test("a failed read answers 500 instead of leaving the request open, on every route", async (t) => {
    t.mock.method(console, "error", () => undefined);
    const routes = workspaceRoutes();
    for (const route of ["GET /channels", "POST /attachments", "GET /attachments/:id"]) {
      assert.ok(
        routes.some((entry) => entry.route === route),
        `${route} is not on the router`,
      );
    }
    for (const { route, method, path } of routes) {
      await t.test(route, async (st) => {
        // An API key never reads the Company to authorize, so the first
        // Company read is the router's own, ahead of every route's own guards
        // and validation.
        failNextRead(st, "companies");
        const response = await send(path, { method });
        assert.equal(response.status, 500);
        assert.deepEqual(await response.json(), { error: "Internal server error" });
      });
    }
  });
});
