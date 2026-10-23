import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";

import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";

import {
  onRoutePaths,
  requireBrowserSession,
  requireCompanyRole,
  requireCompanyRoleForMutations,
} from "./auth.js";
import {
  describeBrowserSessionCondition,
  describeBrowserSessionOnly,
  routeMetadataOf,
  withRouteMetadata,
} from "./routeMetadata.js";
import { validateBody, validateParams, validateQuery } from "./validate.js";

/**
 * Middleware factories record what they enforce on the function they return,
 * so the OpenAPI document can read a route's schemas and guards off the router
 * stack. Recording must be invisible to the request itself — these tests pin
 * both halves.
 */

describe("route metadata", () => {
  test("is attached to the function, returned unchanged, and read back", () => {
    const fn = () => undefined;
    const tagged = withRouteMetadata(fn, { kind: "browserSessionOnly" });
    assert.equal(tagged, fn);
    assert.deepEqual(routeMetadataOf(fn), { kind: "browserSessionOnly" });
  });

  test("stays out of enumeration, JSON and the function's own keys", () => {
    const fn = withRouteMetadata(() => undefined, { kind: "browserSessionOnly" });
    assert.deepEqual(Object.keys(fn), []);
    assert.equal(JSON.stringify({ fn: Object.assign({}, fn) }), '{"fn":{}}');
  });

  test("is absent on anything that never received it", () => {
    for (const value of [undefined, null, 0, "text", {}, () => undefined, Symbol("x")]) {
      assert.equal(routeMetadataOf(value), undefined);
    }
  });

  test("the browser-session helpers describe their guard", () => {
    const conditional = describeBrowserSessionCondition(
      () => undefined,
      "to assign an AI Employee",
    );
    assert.deepEqual(routeMetadataOf(conditional), {
      kind: "conditionalBrowserSession",
      when: "to assign an AI Employee",
    });
    const only = describeBrowserSessionOnly(() => undefined);
    assert.deepEqual(routeMetadataOf(only), { kind: "browserSessionOnly" });
  });
});

describe("validators record the schema they enforce", () => {
  const body = z.object({ name: z.string().min(1) });
  const query = z.object({ limit: z.coerce.number().int().default(20) });
  const params = z.object({ id: z.string().uuid() });

  test("validateBody, validateQuery and validateParams name their location", () => {
    assert.deepEqual(routeMetadataOf(validateBody(body)), {
      kind: "requestSchema",
      location: "body",
      schema: body,
    });
    assert.deepEqual(routeMetadataOf(validateQuery(query)), {
      kind: "requestSchema",
      location: "query",
      schema: query,
    });
    assert.deepEqual(routeMetadataOf(validateParams(params)), {
      kind: "requestSchema",
      location: "params",
      schema: params,
    });
  });

  test("each call records its own schema", () => {
    const other = z.object({ title: z.string() });
    const first = validateBody(body);
    const second = validateBody(other);
    assert.notEqual(first, second);
    assert.equal((routeMetadataOf(first) as { schema: unknown }).schema, body);
    assert.equal((routeMetadataOf(second) as { schema: unknown }).schema, other);
  });

  describe("and still validate exactly as before", () => {
    let server: Server;
    let baseUrl = "";

    before(async () => {
      const app = express();
      app.use(express.json());
      app.post(
        "/things/:id",
        validateParams(params),
        validateQuery(query),
        validateBody(body),
        (req, res) => {
          res.json({ params: req.params, query: req.query, body: req.body });
        },
      );
      await new Promise<void>((resolve) => {
        server = app.listen(0, "127.0.0.1", resolve);
      });
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    after(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    const post = (path: string, payload: unknown) =>
      fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });

    test("replacing params, query and body with the parsed values", async () => {
      const id = "8a6b8a8e-8d4f-4e19-9a52-3c1f1a0d5f8b";
      const response = await post(`/things/${id}?limit=5`, { name: "Ada", extra: true });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        params: { id },
        query: { limit: 5 },
        body: { name: "Ada" },
      });
    });

    test("filling defaults the raw request left out", async () => {
      const id = "8a6b8a8e-8d4f-4e19-9a52-3c1f1a0d5f8b";
      const response = await post(`/things/${id}`, { name: "Ada" });
      assert.deepEqual((await response.json()).query, { limit: 20 });
    });

    test("answering 400 with the zod issues", async () => {
      const response = await post("/things/not-a-uuid", { name: "Ada" });
      assert.equal(response.status, 400);
      const json = await response.json();
      assert.equal(json.error, "ValidationError");
      assert.equal(json.issues[0].path[0], "id");

      const badBody = await post("/things/8a6b8a8e-8d4f-4e19-9a52-3c1f1a0d5f8b", { name: "" });
      assert.equal(badBody.status, 400);
      assert.equal((await badBody.json()).issues[0].path[0], "name");
    });
  });
});

describe("authorization factories record what they demand", () => {
  test("requireCompanyRole names its minimum for every method", () => {
    assert.deepEqual(routeMetadataOf(requireCompanyRole("admin")), {
      kind: "companyRole",
      minimum: "admin",
      mutationsOnly: false,
    });
  });

  test("requireCompanyRoleForMutations says reads pass", () => {
    assert.deepEqual(routeMetadataOf(requireCompanyRoleForMutations("owner")), {
      kind: "companyRole",
      minimum: "owner",
      mutationsOnly: true,
    });
  });

  test("onRoutePaths keeps its matchers and the guard it scopes", () => {
    const matchers = ["/api-keys", /^\/vault(?:\/|$)/];
    const scoped = onRoutePaths(matchers, requireBrowserSession);
    const metadata = routeMetadataOf(scoped);
    assert.equal(metadata?.kind, "pathScoped");
    assert.equal((metadata as { matchers: unknown }).matchers, matchers);
    assert.equal((metadata as { middleware: unknown }).middleware, requireBrowserSession);
  });

  test("the recorded gates still behave as gates", () => {
    const run = (
      gate: (req: Request, res: Response, next: NextFunction) => unknown,
      method: string,
      role?: string,
    ) => {
      let status = 0;
      let passed = false;
      const res = {
        status(code: number) {
          status = code;
          return { json: () => undefined };
        },
      } as unknown as Response;
      gate({ method, companyRole: role } as unknown as Request, res, () => {
        passed = true;
      });
      return passed ? "next" : status;
    };
    assert.equal(run(requireCompanyRole("admin"), "GET", "member"), 403);
    assert.equal(run(requireCompanyRole("admin"), "GET", "admin"), "next");
    assert.equal(run(requireCompanyRoleForMutations("admin"), "GET", "member"), "next");
    assert.equal(run(requireCompanyRoleForMutations("admin"), "POST", "member"), 403);
    assert.equal(run(requireCompanyRoleForMutations("admin"), "POST", "owner"), "next");

    let scopedRan = false;
    const scoped = onRoutePaths(["/audit"], (_req, _res, next) => {
      scopedRan = true;
      next();
    });
    const next = () => undefined;
    scoped({ path: "/finance" } as Request, {} as Response, next);
    assert.equal(scopedRan, false);
    scoped({ path: "/AUDIT/" } as Request, {} as Response, next);
    assert.equal(scopedRan, true);
  });
});
