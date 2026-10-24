import assert from "node:assert/strict";
import { describe, test } from "node:test";

import express, { Router, type RequestHandler } from "express";

import { createApp } from "../app.js";
import {
  discoverRoutes,
  joinRoutePath,
  mountPathOf,
  pathParamsOf,
  rootStackOf,
  samplePathFor,
  toOpenApiPath,
  type DiscoveredRoute,
} from "./routeDiscovery.js";

/** The layer `router.use(path, …)` creates, for mount-path tests. */
function mountLayer(path: string, options: { caseSensitive?: boolean } = {}) {
  const router = Router(options);
  router.use(path, () => undefined);
  return (router as unknown as { stack: Parameters<typeof mountPathOf>[0][] }).stack[0];
}

const named = (name: string): RequestHandler => {
  const fn: RequestHandler = (_req, _res, next) => next();
  Object.defineProperty(fn, "name", { value: name });
  return fn;
};

const find = (routes: DiscoveredRoute[], method: string, path: string) => {
  const route = routes.find((candidate) => candidate.method === method && candidate.path === path);
  assert.ok(route, `${method.toUpperCase()} ${path} was not discovered`);
  return route;
};

const chainNames = (route: DiscoveredRoute) =>
  route.chain
    .map((link) => (link.handle as { name?: string }).name)
    .filter((name) => name?.startsWith("mw"));

describe("mount paths are recovered from Express's compiled expressions", () => {
  for (const path of [
    "/api",
    "/api/companies/:cid",
    "/api/companies/:cid/employees/:eid/models",
    "/api/auth/sso/company",
    "/api/backup-destinations",
    "/finance/subsidiaries",
    "/files/report.v2",
    "/a_b/c~d",
  ]) {
    test(path, () => {
      assert.equal(mountPathOf(mountLayer(path)), path);
    });
  }

  test("a root mount is the empty prefix", () => {
    assert.equal(mountPathOf(mountLayer("/")), "");
  });

  test("a trailing slash folds into the same mount", () => {
    // Express compiles "/api/" and "/api" to one expression, and so one path.
    assert.equal(mountPathOf(mountLayer("/api/")), "/api");
  });

  test("case-sensitive routers round-trip too", () => {
    assert.equal(mountPathOf(mountLayer("/Api/Things", { caseSensitive: true })), "/Api/Things");
  });

  test("a mount that is not a plain string path is refused, not guessed", () => {
    const router = Router();
    router.use(/^\/regex/, () => undefined);
    router.use(["/one", "/two"], () => undefined);
    const [regex, array] = (router as unknown as { stack: Parameters<typeof mountPathOf>[0][] })
      .stack;
    assert.throws(() => mountPathOf(regex));
    assert.throws(() => mountPathOf(array));
  });

  test("parameter names come from the layer's keys", () => {
    const layer = mountLayer("/api/:cid");
    assert.equal(
      mountPathOf({ regexp: layer.regexp, keys: [{ name: "companyId" }] }),
      "/api/:companyId",
    );
    assert.throws(() => mountPathOf({ regexp: layer.regexp, keys: [] }), /unnamed parameter/);
    assert.throws(
      () => mountPathOf({ regexp: layer.regexp, keys: [{ name: "a" }, { name: "b" }] }),
      /names 2 parameters but has 1/,
    );
  });

  test("an expression no plain path compiles to is refused", () => {
    const regexp = (source: string) => new RegExp(source, "i");
    // No trailing lookahead: an end-anchored route, not a mount.
    assert.throws(
      () => mountPathOf({ regexp: regexp("^\\/api\\/?$"), keys: [] }),
      /not compiled from a string path/,
    );
    // Quantifiers and alternations never come out of a plain path.
    assert.throws(
      () => mountPathOf({ regexp: regexp("^\\/api+\\/?(?=\\/|$)"), keys: [] }),
      /uses \+/,
    );
    assert.throws(
      () => mountPathOf({ regexp: regexp("^\\/a|b\\/?(?=\\/|$)"), keys: [] }),
      /uses \|/,
    );
    // A group that is not a parameter.
    assert.throws(
      () => mountPathOf({ regexp: regexp("^\\/api(?:\\/v1)\\/?(?=\\/|$)"), keys: [] }),
      /not a path parameter/,
    );
    // Case sensitivity is part of the expression: one compiled without "i"
    // reads back only as a case-sensitive mount.
    const sensitive = mountLayer("/Api", { caseSensitive: true });
    assert.equal(mountPathOf(sensitive), "/Api");
  });
});

describe("path helpers", () => {
  test("joining prefixes and route paths spells the request URL", () => {
    assert.equal(joinRoutePath("/api/companies", "/"), "/api/companies");
    assert.equal(joinRoutePath("", "/api/health"), "/api/health");
    assert.equal(joinRoutePath("/api", "employee-templates"), "/api/employee-templates");
    assert.equal(joinRoutePath("/api//x", "/y/"), "/api/x/y");
    assert.equal(joinRoutePath("", "/"), "/");
  });

  test("Express parameters become OpenAPI templates, in order", () => {
    const path = "/api/companies/:cid/employees/:eid/models/:id";
    assert.equal(toOpenApiPath(path), "/api/companies/{cid}/employees/{eid}/models/{id}");
    assert.deepEqual(pathParamsOf(path), ["cid", "eid", "id"]);
    assert.equal(samplePathFor(path), "/api/companies/__cid__/employees/__eid__/models/__id__");
    assert.deepEqual(pathParamsOf("/api/health"), []);
  });
});

describe("discovering a synthetic app", () => {
  const mwApp = named("mwApp");
  const mwApi = named("mwApi");
  const mwCompany = named("mwCompany");
  const mwInner = named("mwInner");
  const mwOther = named("mwOther");
  const mwSign = named("mwSign");
  const handler: RequestHandler = (_req, res) => {
    res.end();
  };
  const errorHandler = (_err: unknown, _req: unknown, _res: unknown, next: () => void) => next();

  const companyRouter = Router({ mergeParams: true });
  companyRouter.use(mwCompany);
  companyRouter.get("/deals", handler);
  companyRouter.get("/deals/:id", named("mwRouteLevel"), handler);
  companyRouter.post("/deals/:id/archive", handler);

  const nested = Router({ mergeParams: true });
  nested.use(mwInner);
  nested.patch("/:sourceId", handler);
  companyRouter.use("/vault/sources", nested);

  const otherRouter = Router({ mergeParams: true });
  otherRouter.use(mwOther);
  otherRouter.get("/notes", handler);

  const shadowing = Router();
  shadowing.get("/things/:id", handler);
  shadowing.get("/things/board", handler);

  const odd = Router();
  odd.all("/everything", handler);
  odd.get(/^\/pattern$/, handler);
  odd.get("/maybe/:id?", handler);

  const app = express();
  app.use(mwApp);
  app.get("/api/health", handler);
  app.use("/api/sign", mwSign);
  app.use("/api", mwApi);
  app.use("/api/companies/:cid", companyRouter);
  app.use("/api/companies/:cid", otherRouter);
  app.use("/api/shadow", shadowing);
  app.use("/api/odd", odd);
  app.use(errorHandler);

  const { routes, undocumentable } = discoverRoutes(app);

  test("every route appears with its full path and parameters", () => {
    const keys = routes.map((route) => `${route.method.toUpperCase()} ${route.path}`);
    assert.deepEqual(keys, [
      "GET /api/health",
      "GET /api/companies/{cid}/deals",
      "GET /api/companies/{cid}/deals/{id}",
      "POST /api/companies/{cid}/deals/{id}/archive",
      "PATCH /api/companies/{cid}/vault/sources/{sourceId}",
      "GET /api/companies/{cid}/notes",
      "GET /api/shadow/things/{id}",
      "GET /api/shadow/things/board",
    ]);
    const nestedRoute = find(routes, "patch", "/api/companies/{cid}/vault/sources/{sourceId}");
    assert.equal(nestedRoute.expressPath, "/api/companies/:cid/vault/sources/:sourceId");
    assert.deepEqual(nestedRoute.pathParams, ["cid", "sourceId"]);
  });

  test("the chain holds exactly the middleware a request would meet, in order", () => {
    assert.deepEqual(chainNames(find(routes, "get", "/api/health")), ["mwApp"]);
    assert.deepEqual(chainNames(find(routes, "get", "/api/companies/{cid}/deals")), [
      "mwApp",
      "mwApi",
      "mwCompany",
    ]);
    // The nested router's own guard joins, and a neighbour router mounted at
    // the same prefix contributes nothing until a request passes through it.
    assert.deepEqual(
      chainNames(find(routes, "patch", "/api/companies/{cid}/vault/sources/{sourceId}")),
      ["mwApp", "mwApi", "mwCompany", "mwInner"],
    );
    // A router mounted at the same prefix earlier runs its guards for every
    // request below that prefix, even ones it has no route for.
    assert.deepEqual(chainNames(find(routes, "get", "/api/companies/{cid}/notes")), [
      "mwApp",
      "mwApi",
      "mwCompany",
      "mwOther",
    ]);
  });

  test("middleware mounted at another path stays out of the chain", () => {
    for (const route of routes) {
      assert.ok(!chainNames(route).includes("mwSign"), route.path);
    }
  });

  test("each link records the path its middleware sees", () => {
    const route = find(routes, "patch", "/api/companies/{cid}/vault/sources/{sourceId}");
    const byName = new Map(
      route.chain.map((link) => [(link.handle as { name: string }).name, link.path]),
    );
    assert.equal(byName.get("mwApp"), "/api/companies/__cid__/vault/sources/__sourceid__");
    assert.equal(byName.get("mwApi"), "/companies/__cid__/vault/sources/__sourceid__");
    assert.equal(byName.get("mwCompany"), "/vault/sources/__sourceid__");
    assert.equal(byName.get("mwInner"), "/__sourceid__");
    assert.equal(route.routePath, "/__sourceid__");
  });

  test("route-level handlers and the routers on the way are reported", () => {
    const route = find(routes, "get", "/api/companies/{cid}/deals/{id}");
    assert.deepEqual(
      route.handlers.map((handle) => (handle as { name: string }).name),
      ["mwRouteLevel", "handler"],
    );
    assert.deepEqual(route.routers, [companyRouter]);
    assert.deepEqual(
      find(routes, "patch", "/api/companies/{cid}/vault/sources/{sourceId}").routers,
      [companyRouter, nested],
    );
  });

  test("error handlers never join a chain", () => {
    for (const route of routes) {
      assert.ok(!route.chain.some((link) => link.handle === errorHandler));
    }
  });

  test("a route registered after a parameter route that answers first is flagged", () => {
    assert.equal(find(routes, "get", "/api/shadow/things/{id}").shadowedBy, undefined);
    assert.equal(
      find(routes, "get", "/api/shadow/things/board").shadowedBy,
      "GET /api/shadow/things/:id",
    );
  });

  test("routes the reference cannot describe are reported, never dropped silently", () => {
    const reported = undocumentable.map((route) => `${route.method} ${route.expressPath}`);
    assert.ok(reported.includes("ALL /api/odd/everything"), reported.join(", "));
    assert.ok(
      reported.some((entry) => entry.startsWith("GET /api/odd/^")),
      reported.join(", "),
    );
    assert.ok(reported.includes("GET /api/odd/maybe/:id?"), reported.join(", "));
  });

  test("an app with no routes, or a bare router, is fine", () => {
    assert.deepEqual(discoverRoutes(express()).routes, []);
    const router = Router();
    router.get("/x", handler);
    assert.deepEqual(
      discoverRoutes(router).routes.map((route) => route.path),
      ["/x"],
    );
  });
});

describe("discovering the App", () => {
  const app = createApp();
  const { routes, undocumentable } = discoverRoutes(app);

  test("finds every route, and none it cannot describe", () => {
    assert.ok(routes.length > 1400, `only ${routes.length} routes`);
    assert.deepEqual(undocumentable, []);
  });

  test("finds no route that another one answers first", () => {
    assert.deepEqual(
      routes
        .filter((route) => route.shadowedBy)
        .map((route) => `${route.method} ${route.path} ← ${route.shadowedBy}`),
      [],
    );
  });

  test("reads every mount in the App back to a path Express compiles the same way", () => {
    // mountPathOf throws on any mount it cannot round-trip; discovering at all proves it.
    const mounts = new Set<string>();
    const visit = (stack: ReturnType<typeof rootStackOf>, prefix: string) => {
      for (const layer of stack) {
        const child = layer.handle as { stack?: ReturnType<typeof rootStackOf> };
        if (!layer.route && Array.isArray(child.stack)) {
          const mounted = prefix + mountPathOf(layer);
          mounts.add(mounted);
          visit(child.stack, mounted);
        }
      }
    };
    visit(rootStackOf(app), "");
    assert.ok(mounts.has("/api/companies/:cid"));
    assert.ok(mounts.has("/api/companies/:cid/employees/:eid/models"));
    assert.ok(mounts.has("/api/companies/:cid/vault/sources"));
  });

  test("every company route sits behind requireAuth — or, for the MCP server, requireBearerAuth", async () => {
    const { requireBearerAuth, requireAuth } = await import("../middleware/auth.js");
    for (const route of routes) {
      if (!route.path.startsWith("/api/companies/{cid}")) continue;
      const handlers = [...route.chain.map((link) => link.handle), ...route.handlers];
      assert.ok(
        handlers.includes(requireAuth) || handlers.includes(requireBearerAuth),
        `${route.method} ${route.path}`,
      );
    }
    // The Genosyn MCP server never reaches the cookie-reading guard at all.
    const mcp = routes.filter((route) => route.path === "/api/companies/{cid}/mcp");
    assert.deepEqual(mcp.map((route) => route.method).sort(), ["delete", "get", "post"]);
    for (const route of mcp) {
      const handlers = [...route.chain.map((link) => link.handle), ...route.handlers];
      assert.ok(handlers.includes(requireBearerAuth), route.method);
      assert.ok(!handlers.includes(requireAuth), `${route.method} must not read the session`);
    }
  });

  test("is deterministic", () => {
    const again = discoverRoutes(app).routes.map((route) => `${route.method} ${route.path}`);
    assert.deepEqual(
      again,
      routes.map((route) => `${route.method} ${route.path}`),
    );
  });
});
