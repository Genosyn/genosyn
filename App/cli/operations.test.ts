import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { createApp } from "../server/app.js";
import { buildOpenApiDocument } from "../server/openapi/spec.js";
import { BUILTIN_COMMANDS } from "./help.js";
import { areaSlug, OperationIndex, shortenWithinArea, type OpenApiDocument } from "./operations.js";
import { RESERVED_FLAG_NAMES } from "./options.js";
import { syntheticSpec } from "./test/support.js";

describe("names derived from the reference", () => {
  test("area slugs are kebab-case tag names", () => {
    assert.equal(areaSlug("Revenue"), "revenue");
    assert.equal(areaSlug("Letters to the board"), "letters-to-the-board");
    assert.equal(areaSlug("AI Models"), "ai-models");
    assert.equal(areaSlug("TLDRs"), "tldrs");
    assert.equal(areaSlug("  Company SSO!  "), "company-sso");
  });

  test("an operation's name sheds the area's words right after the verb", () => {
    assert.equal(shortenWithinArea("list-revenue-deals", "revenue"), "list-deals");
    assert.equal(shortenWithinArea("run-routine", "routines"), "run");
    assert.equal(shortenWithinArea("list-routines", "routines"), "list");
    assert.equal(shortenWithinArea("get-employee-soul", "employees"), "get-soul");
    assert.equal(shortenWithinArea("list-workspace-channels", "workspace-chat"), null);
    assert.equal(shortenWithinArea("create-employee-routine", "routines"), null);
    assert.equal(shortenWithinArea("list-categories", "category"), "list");
    assert.equal(shortenWithinArea("list", "routines"), null);
  });
});

describe("the command tree from a synthetic reference", () => {
  const index = new OperationIndex(syntheticSpec());

  test("lists areas in the reference's tag order with their descriptions", () => {
    assert.deepEqual(
      index.areas.map((area) => [area.slug, area.apiKeyOperations, area.operations.length]),
      [
        ["goals", 6, 6],
        ["revenue", 4, 4],
        ["resources", 3, 3],
        ["api-keys", 0, 1],
        ["system", 0, 1],
      ],
    );
    assert.equal(index.area("revenue")?.description, "Contacts and deals.");
    assert.equal(index.serverVersion, "9.9.9");
  });

  test("shortens command names only where they stay unique", () => {
    const names = Object.fromEntries(
      index.operations.map((operation) => [operation.operationId, operation.commandName]),
    );
    assert.equal(names.listGoals, "list");
    assert.equal(names.createGoal, "create");
    assert.equal(names.listRevenueDeals, "list-deals");
    assert.equal(names.moveRevenueDealStage, "move-deal-stage");
    assert.equal(names.getCompanyMe, "get-company-me", "no area words to shed");
    assert.equal(names.createApiKey, "create", "within API Keys");
    assert.equal(index.commandFor(index.find("listRevenueDeals")!), "revenue list-deals");
  });

  test("falls back to the full name when two operations would share a short one", () => {
    const spec = syntheticSpec();
    spec.paths!["/api/companies/{cid}/deals"] = {
      get: {
        operationId: "listDeals",
        tags: ["Revenue"],
        "x-genosyn-access": { apiKey: true },
        responses: {},
      },
    };
    const clashing = new OperationIndex(spec);
    assert.equal(clashing.find("listRevenueDeals")?.commandName, "list-revenue-deals");
    assert.equal(clashing.find("listDeals")?.commandName, "list-deals");
  });

  test("finds operations by id in any case and by kebab id", () => {
    assert.equal(index.find("listRevenueDeals")?.path, "/api/companies/{cid}/revenue/deals");
    assert.equal(index.find("LISTREVENUEDEALS")?.operationId, "listRevenueDeals");
    assert.equal(index.find("list-revenue-deals")?.operationId, "listRevenueDeals");
    assert.equal(index.find("nope"), undefined);
  });

  test("finds an area's operation by command name, kebab id or operation id", () => {
    const revenue = index.area("Revenue")!;
    for (const name of ["list-deals", "list-revenue-deals", "listRevenueDeals"]) {
      assert.equal(index.findInArea(revenue, name)?.operationId, "listRevenueDeals", name);
    }
    assert.equal(index.findInArea(revenue, "create"), undefined);
  });

  test("orders path parameters by the path and leaves the company to the CLI", () => {
    const move = index.find("moveRevenueDealStage")!;
    assert.deepEqual(
      move.pathParams.map((param) => param.name),
      ["id", "stageId"],
    );
    assert.equal(move.companyScoped, true);
    assert.equal(move.shortPath, "/revenue/deals/{id}/stage/{stageId}");
    const health = index.find("getHealth")!;
    assert.equal(health.companyScoped, false);
    assert.equal(health.shortPath, "/api/health");
  });

  test("reads query parameters, including deepObject ones", () => {
    const list = index.find("listRevenueDeals")!;
    assert.deepEqual(
      list.queryParams.map((param) => [param.name, param.flag, param.deepObject]),
      [
        ["q", "--q", false],
        ["status", "--status", false],
        ["limit", "--limit", false],
        ["offset", "--offset", false],
        ["filter", "--filter", true],
      ],
    );
  });

  test("reads a $ref'd JSON body's fields with their requiredness", () => {
    const create = index.find("createGoal")!;
    assert.equal(create.body?.kind, "json");
    assert.equal(create.body?.required, true);
    assert.deepEqual(
      create.bodyFields.map((field) => [field.name, field.required, field.flag]),
      [
        ["title", true, "--title"],
        ["targetValue", true, "--target-value"],
        ["parentGoalId", false, "--parent-goal-id"],
        ["metricKind", false, "--metric-kind"],
        ["archived", false, "--archived"],
        ["score", false, "--score"],
      ],
    );
    assert.equal(create.bodyFields[0].description, "What to achieve.");
  });

  test("merges allOf members and unions oneOf variants", () => {
    const update = index.find("updateGoal")!;
    assert.ok(update.bodyFields.some((field) => field.name === "note"));
    assert.ok(update.bodyFields.some((field) => field.name === "title"));
    const settings = index.find("setRevenueSettings")!;
    assert.deepEqual(
      settings.bodyFields.map((field) => [field.name, field.required]),
      [
        ["mode", true],
        ["enabled", false],
        ["threshold", false],
        ["dryRun", false],
      ],
    );
  });

  test("gives no --flag to a parameter named like a CLI option", () => {
    const create = index.find("createResource")!;
    const url = create.bodyFields.find((field) => field.name === "url")!;
    assert.equal(url.flag, undefined);
    const settings = index.find("setRevenueSettings")!;
    assert.equal(settings.bodyFields.find((field) => field.name === "dryRun")?.flag, undefined);
    assert.ok(RESERVED_FLAG_NAMES.has("url") && RESERVED_FLAG_NAMES.has("dry-run"));
  });

  test("marks multipart file fields and file responses", () => {
    const upload = index.find("uploadResources")!;
    assert.equal(upload.body?.kind, "multipart");
    assert.deepEqual(
      upload.bodyFields.map((field) => [field.name, field.file]),
      [
        ["file", true],
        ["folderId", false],
      ],
    );
    assert.equal(index.find("getResourceFile")?.fileResponse, "application/octet-stream");
    assert.equal(index.find("listGoals")?.fileResponse, undefined);
  });

  test("reads who may call it: key, public, or browser only", () => {
    const key = index.find("listGoals")!;
    assert.deepEqual([key.apiKey, key.public, key.callable], [true, false, true]);
    const browser = index.find("createApiKey")!;
    assert.deepEqual([browser.apiKey, browser.public, browser.callable], [false, false, false]);
    const health = index.find("getHealth")!;
    assert.deepEqual([health.apiKey, health.public, health.callable], [false, true, true]);
  });

  test("falls back to the security list when an operation has no access extension", () => {
    const spec: OpenApiDocument = {
      openapi: "3.0.0",
      paths: {
        "/api/a": { get: { operationId: "keyed", security: [{ bearerAuth: [] }], responses: {} } },
        "/api/b": { get: { operationId: "open", security: [], responses: {} } },
        "/api/c": { get: { operationId: "cookie", security: [{ cookieAuth: [] }], responses: {} } },
      },
    };
    const fallback = new OperationIndex(spec);
    assert.equal(fallback.find("keyed")?.apiKey, true);
    assert.equal(fallback.find("open")?.public, true);
    assert.equal(fallback.find("cookie")?.callable, false);
    assert.equal(fallback.find("keyed")?.area, "Other");
  });

  test("resolves a parameter exactly, or by its kebab or camel spelling", () => {
    const create = index.find("createGoal")!;
    assert.equal(index.findParam(create, "targetValue")?.name, "targetValue");
    assert.equal(index.findParam(create, "target-value")?.name, "targetValue");
    assert.equal(index.findParam(create, "TARGET_VALUE")?.name, "targetValue");
    assert.equal(index.findParam(create, "nope"), undefined);
  });

  test("refuses an inexact spelling two parameters share", () => {
    const spec: OpenApiDocument = {
      openapi: "3.0.0",
      paths: {
        "/api/x": {
          get: {
            operationId: "twins",
            "x-genosyn-access": { apiKey: true },
            parameters: [
              { name: "fooBar", in: "query", schema: { type: "string" } },
              { name: "foo_bar", in: "query", schema: { type: "string" } },
            ],
            responses: {},
          },
        },
      },
    };
    const twins = new OperationIndex(spec);
    const operation = twins.find("twins")!;
    assert.equal(twins.findParam(operation, "fooBar")?.name, "fooBar");
    assert.equal(twins.findParam(operation, "foo_bar")?.name, "foo_bar");
    assert.equal(twins.findParam(operation, "foo-bar"), undefined);
  });

  test("searches every word across id, summary, path and area, best first", () => {
    const ids = (query: string, includeAll = false) =>
      index.search(query, { includeAll }).map((operation) => operation.operationId);
    assert.equal(ids("listRevenueDeals")[0], "listRevenueDeals");
    assert.deepEqual(ids("deal list"), ["listRevenueDeals"]);
    assert.ok(ids("goal").includes("createGoal"));
    assert.deepEqual(ids("api key"), [], "browser-only operations are hidden by default");
    assert.deepEqual(ids("api key", true), ["createApiKey"]);
    assert.deepEqual(ids("health"), [], "public operations are listed only on request");
    assert.deepEqual(ids("health", true), ["getHealth"]);
    assert.equal(ids("").length, index.operations.filter((operation) => operation.apiKey).length);
  });
});

describe("the command tree from the real App's reference", () => {
  const document = buildOpenApiDocument(createApp()) as unknown as OpenApiDocument;
  const index = new OperationIndex(document);
  const keyOperations: Array<{ id: string; path: string; method: string }> = [];
  for (const [path, item] of Object.entries(document.paths ?? {})) {
    for (const [method, raw] of Object.entries(item as Record<string, Record<string, unknown>>)) {
      const access = raw["x-genosyn-access"] as { apiKey?: boolean } | undefined;
      if (access?.apiKey) keyOperations.push({ id: raw.operationId as string, path, method });
    }
  }

  test("indexes every operation an API key can call, by its operation id", () => {
    assert.ok(keyOperations.length > 700, `only ${keyOperations.length} key operations`);
    for (const { id, path, method } of keyOperations) {
      const operation = index.find(id);
      assert.ok(operation, `${id} is missing`);
      assert.equal(operation.path, path);
      assert.equal(operation.method, method.toUpperCase());
      assert.ok(operation.apiKey && operation.callable, `${id} should be callable with a key`);
    }
    assert.equal(
      index.operations.filter((operation) => operation.apiKey).length,
      keyOperations.length,
    );
  });

  test("reaches every operation through its area command, unambiguously", () => {
    for (const area of index.areas) {
      const names = area.operations.map((operation) => operation.commandName);
      assert.equal(new Set(names).size, names.length, `${area.slug} has duplicate command names`);
      for (const operation of area.operations) {
        assert.equal(index.findInArea(area, operation.commandName), operation);
        assert.equal(index.findInArea(area, operation.operationId), operation);
      }
    }
  });

  test("area commands are distinct and never shadow a built-in command", () => {
    const slugs = index.areas.map((area) => area.slug);
    assert.equal(new Set(slugs).size, slugs.length);
    for (const slug of slugs) {
      assert.ok(!BUILTIN_COMMANDS.includes(slug), `${slug} collides with a built-in command`);
      assert.match(slug, /^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });

  test("gives every operation unique flags that the CLI's options don't own", () => {
    for (const operation of index.operations) {
      const flags = index
        .parametersOf(operation)
        .map((param) => param.flag)
        .filter((flag): flag is string => !!flag);
      assert.equal(new Set(flags).size, flags.length, `${operation.operationId} repeats a flag`);
      for (const flag of flags) {
        assert.ok(!RESERVED_FLAG_NAMES.has(flag.slice(2)), `${operation.operationId} uses ${flag}`);
      }
      for (const param of index.parametersOf(operation)) {
        assert.equal(index.findParam(operation, param.name), param, `${operation.operationId}.${param.name}`);
      }
    }
  });

  test("names the everyday commands the docs use", () => {
    const at = (area: string, name: string) => {
      const found = index.area(area);
      return found ? index.findInArea(found, name)?.operationId : undefined;
    };
    assert.equal(at("revenue", "list-deals"), "listRevenueDeals");
    assert.equal(at("revenue", "create-deal"), "createRevenueDeal");
    assert.equal(at("routines", "run"), "runRoutine");
    assert.equal(at("routines", "create-employee-routine"), "createEmployeeRoutine");
    assert.equal(at("goals", "create"), "createGoal");
    assert.equal(at("resources", "upload"), "uploadResources");
    assert.equal(at("companies", "get-company-me") ?? at("companies", "get-me"), "getCompanyMe");
  });

  test("knows the uploads, the paged lists and the parameters only name=value reaches", () => {
    const upload = index.find("uploadResources")!;
    assert.equal(upload.body?.kind, "multipart");
    assert.ok(upload.bodyFields.find((field) => field.name === "file")?.file);
    const deals = index.find("listRevenueDeals")!;
    assert.ok(deals.queryParams.some((param) => param.name === "offset"));
    const createResource = index.find("createResource");
    if (createResource) {
      assert.equal(createResource.bodyFields.find((field) => field.name === "url")?.flag, undefined);
    }
    assert.equal(index.find("createApiKey")?.callable, false);
    assert.equal(index.find("getHealth")?.public, true);
  });
});
