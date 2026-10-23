import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { FlagParam, ItemParam } from "./argv.js";
import { CliError } from "./errors.js";
import { OperationIndex } from "./operations.js";
import { buildRequest, mediaTypeFor, paramLabel, withQuery, type DataInput } from "./request.js";
import { API_KEY, BASE, COMPANY_ID, syntheticSpec } from "./test/support.js";

const index = new OperationIndex(syntheticSpec());

type Args = {
  flags?: Array<[string, string | boolean]>;
  items?: Array<[string, string, boolean?]>;
  positionals?: string[];
  data?: DataInput;
  companyId?: string;
  apiKey?: string;
  files?: Record<string, Blob>;
};

async function build(operationId: string, args: Args = {}) {
  const operation = index.find(operationId);
  assert.ok(operation, operationId);
  const flags: FlagParam[] = (args.flags ?? []).map(([name, value]) => ({
    name,
    value,
    raw: `--${name}`,
  }));
  const items: ItemParam[] = (args.items ?? []).map(([name, value, json]) => ({
    name,
    value,
    json: !!json,
    raw: `${name}${json ? ":=" : "="}${value}`,
  }));
  return buildRequest({
    index,
    operation,
    flags,
    items,
    positionals: args.positionals ?? [],
    data: args.data,
    baseUrl: BASE,
    companyId: "companyId" in args ? args.companyId : COMPANY_ID,
    apiKey: "apiKey" in args ? args.apiKey : API_KEY,
    cwd: "/work",
    openFile: async (file) => {
      const blob = args.files?.[file];
      if (!blob) throw new Error("ENOENT: no such file");
      return blob;
    },
  });
}

function usage(pattern: RegExp) {
  return (error: unknown) =>
    error instanceof CliError && error.kind === "usage" && pattern.test(`${error.message} ${error.hint ?? ""}`);
}

describe("paths", () => {
  test("fills the company and path parameters, positionally in path order", async () => {
    const { request } = await build("moveRevenueDealStage", { positionals: ["deal-1", "stage/2"] });
    assert.equal(request.method, "POST");
    assert.equal(
      request.url,
      `${BASE}/api/companies/${COMPANY_ID}/revenue/deals/deal-1/stage/stage%2F2`,
    );
  });

  test("takes path parameters as flags or name=value too, positionals filling the rest", async () => {
    const byFlag = await build("moveRevenueDealStage", { flags: [["stage-id", "s1"]], positionals: ["d1"] });
    assert.match(byFlag.request.url, /\/revenue\/deals\/d1\/stage\/s1$/);
    const byItem = await build("moveRevenueDealStage", { items: [["id", "d2"], ["stageId", "s2"]] });
    assert.match(byItem.request.url, /\/revenue\/deals\/d2\/stage\/s2$/);
  });

  test("names a missing path parameter", async () => {
    await assert.rejects(build("getGoal"), usage(/needs <gid>/));
    await assert.rejects(build("moveRevenueDealStage", { positionals: ["d1"] }), usage(/needs <stageId>/));
  });

  test("refuses arguments with nowhere to go", async () => {
    await assert.rejects(build("getGoal", { positionals: ["g1", "extra"] }), usage(/Unexpected argument: extra/));
    await assert.rejects(build("listGoals", { positionals: ["x"] }), usage(/takes no positional/));
  });

  test("refuses a company operation without a company", async () => {
    await assert.rejects(build("listGoals", { companyId: undefined }), usage(/acts in a company/));
  });

  test("never builds a request that leaves the install, whatever the description says", async () => {
    const buildFor = (hostile: string) => {
      const spec = syntheticSpec();
      spec.paths![hostile] = {
        get: { operationId: "steal", tags: ["Goals"], "x-genosyn-access": { apiKey: true }, responses: {} },
      };
      const hostileIndex = new OperationIndex(spec);
      return buildRequest({
        index: hostileIndex,
        operation: hostileIndex.find("steal")!,
        flags: [],
        items: [],
        positionals: [],
        baseUrl: BASE,
        apiKey: API_KEY,
        cwd: "/",
        openFile: async () => new Blob([]),
      });
    };
    for (const hostile of ["@evil.test/api/x", "https://evil.test/api/x", ".evil.test/api/x"]) {
      await assert.rejects(
        buildFor(hostile),
        (error: unknown) =>
          error instanceof CliError && error.kind === "network" && /nothing was sent/.test(error.message),
        hostile,
      );
    }
    const doubled = await buildFor("//evil.test/api/x");
    assert.equal(new URL(doubled.request.url).origin, BASE, "a doubled slash stays on the install");
  });

  test("encodes path values so they can't change where a request goes", async () => {
    const { request } = await build("getGoal", { positionals: ["@evil.test/../x?y#z"] });
    const url = new URL(request.url);
    assert.equal(url.origin, BASE);
    assert.equal(url.pathname, `/api/companies/${COMPANY_ID}/goals/%40evil.test%2F..%2Fx%3Fy%23z`);
    assert.equal(url.search, "");
  });

  test("sends the key only when there is one, and asks for JSON", async () => {
    const keyed = await build("listGoals");
    assert.equal(keyed.request.headers.authorization, `Bearer ${API_KEY}`);
    assert.equal(keyed.request.headers.accept, "application/json");
    const anonymous = await build("getHealth", { apiKey: undefined, companyId: undefined });
    assert.equal(anonymous.request.headers.authorization, undefined);
    assert.equal(anonymous.request.url, `${BASE}/api/health`);
  });
});

describe("query strings", () => {
  test("repeats a list, stringifies numbers, and sends deepObject keys", async () => {
    const { request, query } = await build("listRevenueDeals", {
      flags: [
        ["status", "open"],
        ["status", "won"],
        ["limit", "20"],
        ["filter", '{"owner":"me","stage":"won"}'],
      ],
      items: [["q", "acme & co"]],
    });
    const url = new URL(request.url);
    assert.deepEqual(url.searchParams.getAll("status"), ["open", "won"]);
    assert.equal(url.searchParams.get("limit"), "20");
    assert.equal(url.searchParams.get("q"), "acme & co");
    assert.equal(url.searchParams.get("filter[owner]"), "me");
    assert.equal(url.searchParams.get("filter[stage]"), "won");
    assert.equal(query.limit, "20");
    assert.equal(request.body, undefined);
  });

  test("a JSON array fills a list in one go", async () => {
    const { request } = await build("listRevenueDeals", { items: [["status", '["open","lost"]', true]] });
    assert.deepEqual(new URL(request.url).searchParams.getAll("status"), ["open", "lost"]);
  });

  test("a non-number for an integer is a usage error naming the flag", async () => {
    await assert.rejects(
      build("listRevenueDeals", { flags: [["limit", "twenty"]] }),
      usage(/--limit expects a number/),
    );
  });
});

describe("JSON bodies", () => {
  test("builds the body from flags and items, typed by the schema", async () => {
    const { request, preview } = await build("createGoal", {
      flags: [
        ["title", "Grow MRR"],
        ["target-value", "12.5"],
        ["archived", false],
        ["score", "40"],
      ],
      items: [["metricKind", "chart"], ["parentGoalId", "null"]],
    });
    assert.equal(request.headers["content-type"], "application/json");
    assert.deepEqual(JSON.parse(request.body as string), {
      title: "Grow MRR",
      targetValue: 12.5,
      archived: false,
      score: 40,
      metricKind: "chart",
      parentGoalId: null,
    });
    assert.deepEqual(preview.body, JSON.parse(request.body as string));
  });

  test("keeps text that only looks like a number when the field is a string", async () => {
    const { request } = await build("createGoal", { flags: [["title", "2026"], ["target-value", "1"]] });
    assert.equal(JSON.parse(request.body as string).title, "2026");
  });

  test("name:=json sends an exact JSON value", async () => {
    const { request } = await build("createGoal", {
      items: [["title", '"quoted"', true], ["targetValue", "3", true], ["archived", "true", true]],
    });
    assert.deepEqual(JSON.parse(request.body as string), { title: "quoted", targetValue: 3, archived: true });
  });

  test("refuses values the type can't take", async () => {
    await assert.rejects(
      build("createGoal", { flags: [["score", "4.5"]] }),
      usage(/--score expects a whole number/),
    );
    await assert.rejects(
      build("createGoal", { flags: [["target-value", "abc"]] }),
      usage(/--target-value expects a number/),
    );
    await assert.rejects(build("createGoal", { items: [["archived", "maybe"]] }), usage(/expects true or false/));
    await assert.rejects(build("createGoal", { items: [["title", "{bad", true]] }), usage(/expects JSON/));
  });

  test("parses objects and builds lists from repeated or JSON values", async () => {
    const { request } = await build("createResource", {
      items: [["url", "https://example.com"], ["meta", '{"tier":"gold"}']],
      flags: [
        ["tag-ids", "t1"],
        ["tag-ids", "t2"],
      ],
    });
    assert.deepEqual(JSON.parse(request.body as string), {
      url: "https://example.com",
      meta: { tier: "gold" },
      tagIds: ["t1", "t2"],
    });
    const fromJson = await build("createResource", { items: [["url", "u"], ["tagIds", '["a","b"]']] });
    assert.deepEqual(JSON.parse(fromJson.request.body as string).tagIds, ["a", "b"]);
  });

  test("null only becomes JSON null where the field can't mean the word", async () => {
    const { request } = await build("createResource", { items: [["url", "u"], ["folderId", "null"]] });
    assert.equal(JSON.parse(request.body as string).folderId, null);
    const title = await build("createResource", { items: [["url", "u"], ["title", "null"]] });
    assert.equal(JSON.parse(title.request.body as string).title, "null");
  });

  test("--data is the base body and flags add to and override it", async () => {
    const { request } = await build("createGoal", {
      data: { kind: "json", value: { title: "From data", targetValue: 1, unit: "%" }, source: "--data" },
      flags: [["title", "From flag"]],
    });
    assert.deepEqual(JSON.parse(request.body as string), {
      title: "From flag",
      targetValue: 1,
      unit: "%",
    });
  });

  test("--data alone is sent as given, even fields the reference doesn't list", async () => {
    const { request } = await build("createGoal", {
      data: { kind: "json", value: { anything: [1, 2] }, source: "--data" },
    });
    assert.deepEqual(JSON.parse(request.body as string), { anything: [1, 2] });
  });

  test("refuses to add fields to a --data that isn't an object", async () => {
    await assert.rejects(
      build("createGoal", { data: { kind: "json", value: [1], source: "--data" }, flags: [["title", "x"]] }),
      usage(/not a JSON object/),
    );
  });

  test("sends {} for a required body nobody filled, and nothing for an operation without one", async () => {
    const empty = await build("createGoal");
    assert.equal(empty.request.body, "{}");
    const none = await build("listGoals");
    assert.equal(none.request.body, undefined);
    assert.equal(none.request.headers["content-type"], undefined);
  });

  test("refuses --data for an operation that takes no body", async () => {
    await assert.rejects(
      build("listGoals", { data: { kind: "json", value: {}, source: "--data" } }),
      usage(/takes no request body/),
    );
  });

  test("names an unknown parameter and suggests the close ones", async () => {
    await assert.rejects(
      build("createGoal", { flags: [["titel", "x"]] }),
      usage(/has no parameter "titel".*--title/),
    );
    await assert.rejects(build("createGoal", { items: [["zzz", "x"]] }), usage(/describe createGoal/));
  });

  test("reaches a parameter named like a CLI option through name=value", async () => {
    const { request } = await build("setRevenueSettings", {
      items: [["mode", "advanced"], ["threshold", "0.5"], ["dryRun", "true"]],
    });
    assert.deepEqual(JSON.parse(request.body as string), { mode: "advanced", threshold: 0.5, dryRun: true });
  });
});

describe("uploads", () => {
  const pdf = new Blob(["%PDF-1.4 hello"], { type: "application/pdf" });

  test("sends the file and the text fields as a multipart form", async () => {
    const { request, preview } = await build("uploadResources", {
      flags: [["file", "docs/handbook.pdf"], ["folder-id", "f1"]],
      files: { "/work/docs/handbook.pdf": pdf },
    });
    assert.ok(request.body instanceof FormData);
    const form = request.body as FormData;
    const file = form.get("file") as File;
    assert.equal(file.name, "handbook.pdf");
    assert.equal(await file.text(), "%PDF-1.4 hello");
    assert.equal(form.get("folderId"), "f1");
    assert.equal(request.headers["content-type"], undefined, "fetch sets the boundary");
    assert.deepEqual(preview.body, {
      form: { file: "@/work/docs/handbook.pdf (14 bytes)", folderId: "f1" },
    });
  });

  test("adds --data's fields to the form", async () => {
    const { request } = await build("uploadResources", {
      flags: [["file", "/abs/a.pdf"]],
      data: { kind: "json", value: { title: "Handbook", tags: ["a", "b"] }, source: "--data" },
      files: { "/abs/a.pdf": pdf },
    });
    const form = request.body as FormData;
    assert.equal(form.get("title"), "Handbook");
    assert.equal(form.get("tags"), '["a","b"]');
  });

  test("needs the file, and says which flag takes it", async () => {
    await assert.rejects(build("uploadResources"), usage(/pass --file <path>/));
    await assert.rejects(
      build("uploadResources", { flags: [["file", "missing.pdf"]] }),
      usage(/Can't read missing\.pdf/),
    );
    await assert.rejects(
      build("uploadResources", { data: { kind: "json", value: [1], source: "--data" }, flags: [["file", "/abs/a.pdf"]], files: { "/abs/a.pdf": pdf } }),
      usage(/JSON object of form fields/),
    );
  });

  test("guesses an upload's media type from its extension", () => {
    assert.equal(mediaTypeFor("a.PDF"), "application/pdf");
    assert.equal(mediaTypeFor("notes.md"), "text/markdown");
    assert.equal(mediaTypeFor("photo.jpeg"), "image/jpeg");
    assert.equal(mediaTypeFor("archive.unknown"), "application/octet-stream");
    assert.equal(mediaTypeFor("noextension"), "application/octet-stream");
  });
});

describe("raw bodies and previews", () => {
  const spec = syntheticSpec();
  spec.paths!["/api/backups/upload"] = {
    post: {
      operationId: "uploadBackup",
      tags: ["System"],
      "x-genosyn-access": { apiKey: true },
      requestBody: {
        required: true,
        content: { "application/zip": { schema: { type: "string", format: "binary" } } },
      },
      responses: {},
    },
  };
  const rawIndex = new OperationIndex(spec);

  async function buildRaw(data?: DataInput) {
    return buildRequest({
      index: rawIndex,
      operation: rawIndex.find("uploadBackup")!,
      flags: [],
      items: [],
      positionals: [],
      data,
      baseUrl: BASE,
      apiKey: API_KEY,
      cwd: "/",
      openFile: async () => new Blob([]),
    });
  }

  test("sends --data's bytes with the operation's content type", async () => {
    const bytes = new Uint8Array([80, 75, 3, 4]);
    const { request, preview } = await buildRaw({ kind: "bytes", value: bytes, source: "a.zip" });
    assert.equal(request.body, bytes);
    assert.equal(request.headers["content-type"], "application/zip");
    assert.deepEqual(preview.body, { bytes: 4, contentType: "application/zip" });
  });

  test("needs --data for a raw body", async () => {
    await assert.rejects(buildRaw(), usage(/--data @<file>/));
  });

  test("the preview never shows the key", async () => {
    const { preview } = await build("listGoals");
    assert.equal(preview.headers.authorization, "Bearer gen_TestKeyA…");
    assert.ok(!JSON.stringify(preview).includes(API_KEY));
  });

  test("withQuery replaces one query value and keeps the rest", () => {
    const next = withQuery(
      { method: "GET", url: `${BASE}/x?limit=5&offset=0&q=a`, headers: {} },
      { offset: "5" },
    );
    const url = new URL(next.url);
    assert.equal(url.searchParams.get("offset"), "5");
    assert.equal(url.searchParams.get("limit"), "5");
    assert.equal(url.searchParams.get("q"), "a");
  });

  test("labels parameters the way messages name them", () => {
    const create = index.find("createResource")!;
    assert.equal(paramLabel(create.bodyFields.find((field) => field.name === "url")!), "url=…");
    assert.equal(paramLabel(create.bodyFields.find((field) => field.name === "title")!), "--title");
    assert.equal(paramLabel(index.find("getGoal")!.pathParams[0]), "<gid>");
  });
});
