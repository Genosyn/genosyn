import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { createApp } from "../app.js";
import { AREAS } from "./areas.js";
import { NOT_PUBLIC_API, OUTSIDE_THE_API, exclusionFor } from "./exclusions.js";
import { OPERATION_ID_OVERRIDES } from "./naming.js";
import { discoverRoutes } from "./routeDiscovery.js";
import { openApiCoverage } from "./spec.js";
import { MULTIPART_UPLOADS, RAW_UPLOADS } from "./uploads.js";

/**
 * Nothing the App serves may be left out of the API reference by accident.
 *
 * This enumerates the real router — the same `createApp()` the server listens
 * with — and fails on any route that is neither documented nor on the short,
 * explained list in `exclusions.ts`. It also fails on the reverse kinds of
 * drift: an exclusion, upload entry, operation-id override or hand-written page
 * for a route that no longer exists, a route no product area claims, and a
 * route the reference cannot describe.
 *
 * Adding a route? It is documented automatically. If this fails, the message
 * says which table to update.
 */

const app = createApp();
const report = openApiCoverage(app);
const discovered = discoverRoutes(app).routes;
const keyOf = (method: string, path: string) => `${method.toUpperCase()} ${path}`;

describe("API reference coverage", () => {
  test("every route is documented or deliberately excluded", () => {
    const documented = new Set(
      report.documented.map((operation) => keyOf(operation.method, operation.path)),
    );
    const excluded = new Set(report.excluded.map((route) => keyOf(route.method, route.path)));
    const missing = discovered
      .map((route) => keyOf(route.method, route.path))
      .filter((key) => !documented.has(key) && !excluded.has(key));
    assert.deepEqual(
      missing,
      [],
      "Routes missing from /api/openapi.json — document or exclude them",
    );
    for (const key of documented)
      assert.ok(!excluded.has(key), `${key} is both documented and excluded`);
    assert.ok(documented.size > 1000, `only ${documented.size} operations documented`);
  });

  test("no route is beyond what the reference can describe", () => {
    assert.deepEqual(
      report.undocumentable,
      [],
      "Use a string path and a single HTTP method; RegExp paths, optional parameters and router.all() cannot be documented",
    );
  });

  test("every documented route belongs to a product area", () => {
    assert.deepEqual(report.unplaced, [], "Add the router to the rules in server/openapi/areas.ts");
    const areaNames = new Set(AREAS.map((area) => area.name));
    for (const operation of report.documented) {
      assert.ok(areaNames.has(operation.area), `${operation.area} is not listed in AREAS`);
    }
  });

  test("areas are unique and described", () => {
    const names = AREAS.map((area) => area.name);
    assert.equal(new Set(names).size, names.length);
    for (const area of AREAS) assert.ok(area.description.length > 10, area.name);
  });

  test("hand-written pages describe routes that exist", () => {
    assert.deepEqual(
      report.staleHandWritten,
      [],
      "A hand-written registration in server/openapi/ names a route the App no longer serves",
    );
  });

  test("exclusions, upload entries and id overrides each match a route", () => {
    assert.deepEqual(report.staleExclusions, []);
    assert.deepEqual(report.staleUploads, []);
    assert.deepEqual(report.staleOverrides, []);
  });

  test("every route that runs multer has an upload entry", () => {
    assert.deepEqual(
      report.uploadsWithoutEntry,
      [],
      "Describe the form in server/openapi/uploads.ts so the reference shows its file field",
    );
  });

  test("no documented route is answered first by another", () => {
    assert.deepEqual(
      report.shadowed,
      [],
      "Register the literal route before the parameter route that swallows it",
    );
  });
});

describe("the exclusion list", () => {
  test("explains every entry", () => {
    for (const entry of NOT_PUBLIC_API) {
      assert.ok(entry.reason.length > 20, `${entry.method} ${entry.path} needs a real reason`);
      assert.match(entry.method, /^(\*|GET|POST|PUT|PATCH|DELETE)$/);
    }
  });

  test("keeps the App's internal machine surfaces out", () => {
    for (const route of discovered) {
      if (/^\/api\/internal\//.test(route.path)) {
        assert.ok(
          exclusionFor(route.method, route.path),
          `${route.method} ${route.path} is internal`,
        );
      }
    }
    assert.ok(exclusionFor("POST", "/api/internal/mcp/tools/get_self"));
    assert.ok(exclusionFor("POST", "/api/phone/webhooks/numbers/{numberId}/sms"));
    assert.ok(exclusionFor("GET", "/api/integrations/oauth/callback/{app}"));
    assert.ok(exclusionFor("POST", "/u/{token}"));
  });

  test("never hides an operation an API key can call", () => {
    for (const route of report.excluded) {
      assert.ok(
        !route.path.startsWith("/api/companies/{cid}") ||
          /browser-sessions\/\{id\}\/view/.test(route.path),
        `${route.method} ${route.path} is a company route; document it instead`,
      );
    }
  });

  test("matches prefixes only at a path boundary and exact paths exactly", () => {
    assert.equal(exclusionFor("GET", "/api/internal/mcpx"), undefined);
    assert.equal(exclusionFor("GET", "/api/auth/sso/start/extra"), undefined);
    assert.equal(exclusionFor("POST", "/api/auth/sso/start"), undefined);
    assert.ok(exclusionFor("get", "/api/auth/sso/start"));
  });

  test("leaves out everything served outside /api, and nothing inside it", () => {
    assert.equal(exclusionFor("GET", "/careers/{companySlug}"), OUTSIDE_THE_API);
    assert.equal(exclusionFor("GET", "/"), OUTSIDE_THE_API);
    assert.equal(exclusionFor("GET", "/apis/things"), OUTSIDE_THE_API);
    assert.equal(exclusionFor("GET", "/api/companies/{cid}/employees"), undefined);
    // An entry still names its own reason first.
    assert.notEqual(exclusionFor("POST", "/u/{token}"), OUTSIDE_THE_API);
  });

  test("keeps the server's own page routes out of the reference it serves", async () => {
    // index.ts mounts the careers pages and the App shell after createApp();
    // the document built from that fuller app must not grow by a single path.
    const { default: express } = await import("express");
    const { careersPagesRouter } = await import("../routes/careersSite.js");
    const full = createApp();
    full.use(careersPagesRouter({ isDev: false, loadTemplate: async () => "<html></html>" }));
    full.use(express.static("/nonexistent"));
    full.get(/^\/(?!api).*/, (_req, res) => res.end());
    const fullReport = openApiCoverage(full);
    assert.deepEqual(
      fullReport.documented.map((operation) => `${operation.method} ${operation.path}`).sort(),
      report.documented.map((operation) => `${operation.method} ${operation.path}`).sort(),
    );
    assert.ok(fullReport.excluded.some((route) => route.path.startsWith("/careers")));
    // The shell's catch-all has a RegExp path: reported, never documented.
    assert.ok(
      fullReport.undocumentable.some((route) => route.reason === "The route path is not a string"),
    );
  });
});

describe("the tables the generator reads", () => {
  test("upload entries name a file field and describe it", () => {
    for (const [key, upload] of Object.entries(MULTIPART_UPLOADS)) {
      assert.match(key, /^POST \/api\//, key);
      assert.ok(upload.fileField.length > 0, key);
      assert.ok(upload.file.endsWith("."), key);
    }
    for (const [key, raw] of Object.entries(RAW_UPLOADS)) {
      assert.match(raw.contentType, /^[a-z]+\/[a-z0-9.+-]+$/, key);
    }
  });

  test("override ids are not also produced by the rules for another route", () => {
    const generated = report.documented.filter(
      (operation) =>
        !Object.prototype.hasOwnProperty.call(
          OPERATION_ID_OVERRIDES,
          keyOf(operation.method, operation.path),
        ),
    );
    const overrideIds = new Set(Object.values(OPERATION_ID_OVERRIDES));
    for (const operation of generated) {
      assert.ok(!overrideIds.has(operation.operationId), `${operation.operationId} is taken twice`);
    }
  });
});
