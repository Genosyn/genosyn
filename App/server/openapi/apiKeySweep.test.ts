import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";

import type { NextFunction, Response } from "express";

import { createApp } from "../app.js";
import { errorHandler } from "../middleware/error.js";
import { routeMetadataOf } from "../middleware/routeMetadata.js";
import { setPublicUrl } from "../services/publicUrl.js";
import {
  concretePath,
  createMemberOfNewCompany,
  mintTestApiKey,
  sessionCookieFor,
  withTestInstanceSecrets,
} from "../test/apiAccess.js";
import { closeTestDb, initTestDb } from "../test/dbHarness.js";
import type { DocumentedOperation } from "./document.js";
import { rootStackOf } from "./routeDiscovery.js";
import { openApiCoverage } from "./spec.js";

/**
 * The API reference's promise about every operation, checked against the
 * server.
 *
 * The reference says, for each operation, whether an API key may call it —
 * worked out from the guards in front of the route (`routeAccess.ts`). This
 * suite does not trust that: it sends a real API key, and then a real signed
 * session cookie, through the full `createApp()` stack to every documented
 * operation, and checks the server agrees. A guard the classifier does not
 * recognize — an inline `if (req.apiKey)`, a router-level gate leaking onto
 * a neighbour's routes — shows up here as a mismatch.
 *
 * Every route's validators and its final handler are swapped for stubs first,
 * so the requests exercise authentication and authorization only: no
 * handler runs, nothing is written, and nothing is sent anywhere. That swap
 * mutates the shared router objects, which is why it lives in its own file
 * (`node:test` gives each file its own process) and why the reference is built
 * before it.
 */

const REACHED = "x-openapi-sweep";

let server: Server;
let baseUrl = "";
let restoreSecrets: () => void;
let operations: DocumentedOperation[] = [];
let companyId = "";
let token = "";
let cookie = "";

function stubHandlers(app: unknown): void {
  const seen = new Set<unknown>();
  type Layer = {
    handle: ((...args: unknown[]) => unknown) & { stack?: Layer[] };
    route?: { stack: Layer[] };
  };
  const visit = (stack: Layer[]) => {
    for (const layer of stack) {
      if (layer.route) {
        const routeStack = layer.route.stack;
        routeStack.forEach((inner, index) => {
          if (index === routeStack.length - 1) {
            inner.handle = (_req: unknown, res: unknown) => {
              (res as Response).setHeader(REACHED, "1");
              (res as Response).status(200).json({ reached: true });
            };
          } else if (routeMetadataOf(inner.handle)?.kind === "requestSchema") {
            inner.handle = (_req: unknown, _res: unknown, next: unknown) =>
              (next as NextFunction)();
          }
        });
      } else if (Array.isArray(layer.handle.stack) && !seen.has(layer.handle)) {
        seen.add(layer.handle);
        visit(layer.handle.stack);
      }
    }
  };
  visit(rootStackOf(app) as Layer[]);
}

before(async () => {
  restoreSecrets = withTestInstanceSecrets();
  await initTestDb();
  await setPublicUrl("http://genosyn.example.test");

  const app = createApp();
  // Build the reference from the real handlers, then stub them.
  operations = openApiCoverage(app).documented;
  stubHandlers(app);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // An owner who is also the install's verified master admin passes every
  // role, Finance and operator gate, so only the credential decides.
  const { user, company } = await createMemberOfNewCompany("owner", { isMasterAdmin: true });
  companyId = company.id;
  token = (await mintTestApiKey(user.id, company.id)).token;
  cookie = await sessionCookieFor(user);
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
  restoreSecrets();
});

async function send(operation: DocumentedOperation, headers: Record<string, string>) {
  const hasBody = operation.method !== "get" && operation.method !== "delete";
  const response = await fetch(`${baseUrl}${concretePath(operation.path, companyId)}`, {
    method: operation.method.toUpperCase(),
    headers: { ...headers, ...(hasBody ? { "content-type": "application/json" } : {}) },
    body: hasBody ? "{}" : undefined,
  });
  const text = await response.text();
  return { status: response.status, reached: response.headers.get(REACHED) === "1", text };
}

const describeOperation = (operation: DocumentedOperation) =>
  `${operation.method.toUpperCase()} ${operation.path}`;

type Result = Awaited<ReturnType<typeof send>>;

/** Send one request per operation, a few at a time, keeping each result beside its operation. */
async function sweep(
  selected: DocumentedOperation[],
  headers: Record<string, string>,
): Promise<Array<{ operation: DocumentedOperation; result: Result }>> {
  const results: Array<{ operation: DocumentedOperation; result: Result }> = [];
  let next = 0;
  const worker = async () => {
    while (next < selected.length) {
      const operation = selected[next++];
      results.push({ operation, result: await send(operation, headers) });
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return results;
}

describe("every documented operation answers credentials the way the reference says", () => {
  let withKey: Array<{ operation: DocumentedOperation; result: Result }> = [];

  before(async () => {
    withKey = await sweep(
      operations.filter((operation) => operation.access.authenticated),
      { authorization: `Bearer ${token}` },
    );
  });

  test("the sweep covers the whole authenticated surface", () => {
    assert.ok(withKey.length > 900, `only ${withKey.length} authenticated operations`);
    assert.ok(operations.some((operation) => operation.access.apiKey));
    assert.ok(operations.some((operation) => operation.access.sessionOnly === "browserSession"));
    assert.ok(operations.some((operation) => operation.access.sessionOnly === "masterAdmin"));
    assert.ok(operations.some((operation) => operation.access.sessionOnly === "accountLevel"));
  });

  test("an API key passes authentication exactly where the reference promises it does", () => {
    const mismatches: string[] = [];
    for (const { operation, result } of withKey) {
      const refused = result.status === 401 || result.status === 403;
      if (operation.access.apiKey && refused) {
        mismatches.push(
          `${describeOperation(operation)} refused the key (${result.status} ${result.text})`,
        );
      }
      if (!operation.access.apiKey && !refused) {
        mismatches.push(`${describeOperation(operation)} accepted the key (${result.status})`);
      }
    }
    assert.deepEqual(mismatches, []);
    // Most stubs answer; the rest stop at a lookup of the made-up ids.
    const reached = withKey.filter(({ result }) => result.reached).length;
    assert.ok(reached > 500, `only ${reached} operations reached their handler`);
  });

  test("a browser session passes authentication wherever a key cannot, and elsewhere too", async () => {
    // Every browser-only operation — the ones a session is the sole way into —
    // plus every tenth of the rest, which share their guards with the others.
    // Operations that take an API key and nothing else are checked below.
    const authenticated = operations.filter(
      (operation) => operation.access.authenticated && !operation.access.apiKeyOnly,
    );
    const selected = authenticated.filter(
      (operation, index) => !operation.access.apiKey || index % 10 === 0,
    );
    assert.ok(selected.length > 300, `only ${selected.length} operations selected`);
    const refusals = (await sweep(selected, { cookie }))
      .filter(({ result }) => result.status === 401 || result.status === 403)
      .map(
        ({ operation, result }) =>
          `${describeOperation(operation)} refused the session (${result.status} ${result.text})`,
      );
    assert.deepEqual(refusals, []);
  });

  test("operations that take only an API key refuse a browser session", async () => {
    const keyOnly = operations.filter((operation) => operation.access.apiKeyOnly);
    // The Genosyn MCP server's POST, GET and DELETE, at least.
    assert.ok(keyOnly.length >= 3, `only ${keyOnly.length} key-only operations`);
    for (const { operation, result } of await sweep(keyOnly, { cookie })) {
      assert.equal(result.status, 401, `${describeOperation(operation)} accepted a session`);
      assert.equal(result.reached, false, describeOperation(operation));
    }
    // And the key itself passes, as the sweep above already proved for all of them.
    for (const { operation, result } of withKey) {
      if (!operation.access.apiKeyOnly) continue;
      assert.equal(result.reached, true, `${describeOperation(operation)} → ${result.status}`);
    }
  });

  test("session-only operations name the browser in their refusal", () => {
    for (const { operation, result } of withKey) {
      if (operation.access.sessionOnly !== "browserSession") continue;
      assert.equal(result.status, 403, describeOperation(operation));
      assert.match(
        result.text,
        /browser session|logged-in Member/i,
        `${describeOperation(operation)} refused without saying why: ${result.text}`,
      );
    }
  });

  test("instance administration refuses an API key even from a master admin", () => {
    const admin = withKey.filter(({ operation }) => operation.access.sessionOnly === "masterAdmin");
    assert.ok(admin.length > 20);
    for (const { operation, result } of admin) {
      assert.ok(result.status === 401 || result.status === 403, describeOperation(operation));
    }
  });

  test("account-level operations do not recognize an API key at all", () => {
    const accountLevel = withKey.filter(
      ({ operation }) => operation.access.sessionOnly === "accountLevel",
    );
    assert.ok(accountLevel.length > 10);
    for (const { operation, result } of accountLevel) {
      assert.equal(result.status, 401, describeOperation(operation));
    }
  });
});
