import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { createApp } from "../../app.js";
import { buildOpenApiDocument, openApiCoverage } from "../../openapi/spec.js";
import { strictJsonSchemaValidator } from "../../test/jsonSchemaValidator.js";
import { operationCatalogue } from "./appCatalogue.js";
import {
  annotationsFor,
  availabilityFor,
  buildOperationCatalogue,
  CALL_TOOL_BY_KIND,
  kindOf,
  TRANSPORT_AREA,
  type HttpMethod,
  type OpenApiDocumentLike,
} from "./catalogue.js";
import { OPENAPI_ONLY_KEYWORDS } from "./jsonSchema.js";

/**
 * The Genosyn MCP server's operations are generated from the API reference,
 * not listed by hand. These tests hold that to account on the real reference:
 * the catalogue is exactly the operations an API key may call (less the MCP
 * transports themselves), each named by its stable operationId, each with a
 * valid JSON Schema input and annotations read off its HTTP method — and the
 * rules behind that on small synthetic documents.
 */

const app = createApp();
const catalogue = operationCatalogue(app);
const documented = openApiCoverage(app).documented;

describe("generated from the real reference", () => {
  test("is exactly the operations an API key may call, less the MCP transports", () => {
    const expected = documented
      .filter((operation) => operation.access.apiKey && operation.area !== TRANSPORT_AREA)
      .map((operation) => operation.operationId)
      .sort();
    assert.deepEqual(
      catalogue.operations.map((operation) => operation.name),
      expected,
      "the catalogue lists them in code-unit order",
    );
    assert.ok(catalogue.operations.length > 700, `only ${catalogue.operations.length} operations`);
  });

  test("leaves out every operation a key cannot call, each with its reason", () => {
    const left = documented.filter((operation) => !catalogue.byName.has(operation.operationId));
    assert.equal(left.length, catalogue.unavailable.size);
    for (const operation of left) {
      const entry = catalogue.unavailable.get(operation.operationId);
      assert.ok(entry, operation.operationId);
      assert.ok(entry.reason.length > 30, `${operation.operationId}: ${entry.reason}`);
      if (operation.access.sessionOnly === "browserSession") {
        assert.match(entry.reason, /signed-in browser/, operation.operationId);
      } else if (operation.access.sessionOnly === "masterAdmin") {
        assert.match(entry.reason, /instance administration/, operation.operationId);
      } else if (operation.access.sessionOnly === "accountLevel") {
        assert.match(entry.reason, /signed-in account/, operation.operationId);
      } else if (operation.area === TRANSPORT_AREA) {
        assert.match(entry.reason, /MCP transport endpoint/, operation.operationId);
      } else {
        assert.equal(operation.access.authenticated, false, operation.operationId);
        assert.match(entry.reason, /public/, operation.operationId);
      }
    }
    for (const name of ["createApiKey", "listVaultItems", "approveApproval", "getAuthMe"]) {
      if (documented.some((operation) => operation.operationId === name)) {
        assert.ok(!catalogue.byName.has(name), `${name} must not be callable`);
      }
    }
  });

  test("names are the operation ids: unique, identifier-safe, and short enough for clients", () => {
    const names = catalogue.operations.map((operation) => operation.name);
    assert.equal(new Set(names).size, names.length);
    for (const name of names) {
      assert.match(name, /^[a-z][A-Za-z0-9]{1,63}$/, name);
      // Claude Code prefixes `mcp__genosyn__`; the Claude API allows 64 characters.
      assert.ok(`mcp__genosyn__${name}`.length <= 70, name);
    }
  });

  test("is stable: an independent build generates the same tools", () => {
    // A second app is a separate entry in the reference's memo, so this really builds twice.
    const again = buildOperationCatalogue(
      buildOpenApiDocument(createApp()) as unknown as OpenApiDocumentLike,
    );
    assert.deepEqual(
      again.operations.map((operation) => [operation.name, operation.method, operation.path]),
      catalogue.operations.map((operation) => [operation.name, operation.method, operation.path]),
    );
    assert.deepEqual(
      again.operations.map((operation) => operation.inputSchema),
      catalogue.operations.map((operation) => operation.inputSchema),
    );
  });

  test("every input schema is valid, strict JSON Schema 2020-12 with nothing of OpenAPI left", () => {
    const validator = strictJsonSchemaValidator();
    const failures: string[] = [];
    for (const operation of catalogue.operations) {
      try {
        validator.compile(operation.inputSchema);
      } catch (error) {
        failures.push(`${operation.name}: ${(error as Error).message}`);
      }
      const text = JSON.stringify(operation.inputSchema);
      for (const keyword of OPENAPI_ONLY_KEYWORDS) {
        if (text.includes(`"${keyword}":`)) {
          // A body may name a field `example`; the keyword itself never survives.
          const found = findKeyword(operation.inputSchema, keyword);
          if (found) failures.push(`${operation.name}: still has ${keyword} at ${found}`);
        }
      }
    }
    assert.deepEqual(failures, []);
  });

  test("an input schema accepts the example call describe_operation shows", () => {
    const validator = strictJsonSchemaValidator();
    // A few shapes: no inputs, path only, path + body, query, multipart.
    for (const [name, args] of [
      ["listTags", {}],
      ["deleteTag", { path: { tagId: "6f1c2b9e-5d4a-4b8c-9e7f-0a1b2c3d4e5f" } }],
      ["createRevenueDeal", { body: { title: "Big one" } }],
      ["listRevenueContacts", { query: { q: "ada", limit: 10 } }],
      ["createContract", { file: { name: "a.pdf", base64: "JVBERg==" }, body: { title: "MSA" } }],
    ] as const) {
      const operation = catalogue.byName.get(name);
      assert.ok(operation, name);
      const validate = validator.compile(operation.inputSchema);
      assert.ok(validate(args), `${name}: ${validator.errorsText(validate.errors)}`);
    }
    const createDeal = validator.compile(catalogue.byName.get("createRevenueDeal")!.inputSchema);
    assert.equal(createDeal({ body: {} }), false, "a missing required field is caught");
    assert.equal(
      createDeal({ body: { title: "x" }, extra: 1 }),
      false,
      "unknown arguments are caught",
    );
  });

  test("each schema's root is an object of path, query, body and file — and cid is never an input", () => {
    for (const operation of catalogue.operations) {
      const schema = operation.inputSchema as {
        type: string;
        properties: Record<string, { required?: string[]; properties?: Record<string, unknown> }>;
        required?: string[];
        additionalProperties: boolean;
      };
      assert.equal(schema.type, "object", operation.name);
      assert.equal(schema.additionalProperties, false, operation.name);
      for (const key of Object.keys(schema.properties)) {
        assert.ok(["path", "query", "body", "file"].includes(key), `${operation.name}: ${key}`);
      }
      const templateParams = [...operation.path.matchAll(/\{([^}]+)\}/g)]
        .map((match) => match[1])
        .filter((name) => name !== "cid");
      assert.deepEqual(operation.pathParams, templateParams, operation.name);
      if (templateParams.length) {
        assert.deepEqual(schema.properties.path.required, templateParams, operation.name);
        assert.ok(schema.required?.includes("path"), operation.name);
        assert.equal(schema.properties.path.properties?.cid, undefined, operation.name);
      } else {
        assert.equal(schema.properties.path, undefined, operation.name);
      }
      assert.match(operation.path, /^\/api\/companies\/\{cid\}(?:\/|$)/, operation.name);
    }
  });

  test("annotations, kind and call tool all follow the HTTP method", () => {
    const expected: Record<HttpMethod, [boolean, boolean, boolean]> = {
      get: [true, false, true],
      post: [false, false, false],
      put: [false, true, true],
      patch: [false, true, false],
      delete: [false, true, true],
    };
    for (const operation of catalogue.operations) {
      const [readOnly, destructive, idempotent] = expected[operation.method];
      assert.deepEqual(
        operation.annotations,
        {
          title: operation.summary,
          readOnlyHint: readOnly,
          destructiveHint: destructive,
          idempotentHint: idempotent,
        },
        operation.name,
      );
      assert.equal(operation.kind, kindOf(operation.method), operation.name);
      assert.equal(operation.callTool, CALL_TOOL_BY_KIND[operation.kind], operation.name);
    }
    const methods = new Set(catalogue.operations.map((operation) => operation.method));
    assert.deepEqual([...methods].sort(), ["delete", "get", "patch", "post", "put"]);
  });

  test("uploads name their file field and keep it out of the body", () => {
    const uploads = catalogue.operations.filter((operation) => operation.upload);
    assert.ok(uploads.length >= 8, `only ${uploads.length} uploads`);
    for (const operation of uploads) {
      assert.equal(operation.body?.kind, "multipart", operation.name);
      const properties = operation.inputSchema.properties as Record<
        string,
        { properties?: Record<string, unknown> }
      >;
      assert.ok(properties.file, operation.name);
      assert.equal(
        properties.body?.properties?.[operation.upload!.field],
        undefined,
        operation.name,
      );
    }
    assert.deepEqual(catalogue.byName.get("createRecruitingOpeningApplication")?.upload, {
      field: "resume",
      required: false,
      description: "The candidate's resume, one file under 10 MB.",
    });
    assert.equal(
      catalogue.operations.filter((operation) => operation.body?.kind === "unsupported").length,
      0,
      "every body a key can send is JSON or a form",
    );
  });

  test("file answers are marked, and JSON ones are not", () => {
    assert.equal(catalogue.byName.get("getInvoicePdf")?.response.binary, true);
    assert.equal(catalogue.byName.get("getInvoicePdf")?.response.contentType, "application/pdf");
    assert.equal(catalogue.byName.get("getExportsCustomersCsv")?.response.contentType, "text/csv");
    assert.equal(catalogue.byName.get("listTags")?.response.binary, false);
    assert.equal(catalogue.byName.get("createTag")?.response.status, 201);
  });

  test("descriptions lead with the summary and end with what the caller needs", () => {
    for (const operation of catalogue.operations) {
      assert.ok(operation.description.startsWith(operation.summary), operation.name);
      assert.doesNotMatch(operation.description, /\*\*Access\.\*\*/, operation.name);
      if (operation.access.minimumRole) {
        assert.match(operation.description, /company role or higher/, operation.name);
      }
      if (operation.access.financeAccess) {
        assert.match(operation.description, /Finance (read )?access/, operation.name);
      }
    }
    assert.match(
      catalogue.byName.get("createProjectTodo")?.description ?? "",
      /signed-in browser is required to assign an AI Employee/,
    );
  });

  test("areas follow the reference's order and hold every operation", () => {
    const names = catalogue.areas.map((area) => area.name);
    assert.equal(new Set(names).size, names.length);
    assert.ok(!names.includes(TRANSPORT_AREA));
    for (const operation of catalogue.operations)
      assert.ok(names.includes(operation.area), operation.name);
    assert.ok(names.indexOf("Companies") < names.indexOf("Revenue"));
    for (const area of catalogue.areas) assert.ok(area.description.length > 10, area.name);
  });

  test("is built once per app", () => {
    assert.equal(operationCatalogue(app), catalogue);
    assert.notEqual(operationCatalogue(createApp()), catalogue);
  });
});

/** The JSON path to an OpenAPI keyword used as a keyword (not as a property name), if any. */
function findKeyword(schema: unknown, keyword: string, path = "$"): string | null {
  if (Array.isArray(schema)) {
    for (const [index, item] of schema.entries()) {
      const found = findKeyword(item, keyword, `${path}[${index}]`);
      if (found) return found;
    }
    return null;
  }
  if (!schema || typeof schema !== "object") return null;
  for (const [key, value] of Object.entries(schema)) {
    if (key === keyword) return `${path}.${key}`;
    if (key === "properties" && value && typeof value === "object") {
      for (const [name, property] of Object.entries(value)) {
        const found = findKeyword(property, keyword, `${path}.properties.${name}`);
        if (found) return found;
      }
      continue;
    }
    const found = findKeyword(value, keyword, `${path}.${key}`);
    if (found) return found;
  }
  return null;
}

// ── the rules, on synthetic documents ──────────────────────────────────────

const access = (extra: Record<string, unknown> = {}) => ({
  "x-genosyn-access": { apiKey: true, browserSession: true, ...extra },
});

function synthetic(paths: Record<string, Record<string, unknown>>): OpenApiDocumentLike {
  return {
    paths,
    components: {
      schemas: {
        Person: {
          type: "object",
          properties: { name: { type: "string" }, email: { type: "string", nullable: true } },
          required: ["name"],
        },
      },
    },
    tags: [
      { name: "People", description: "People and their things." },
      { name: "Files", description: "Files." },
      { name: "MCP", description: "Transports." },
    ],
  };
}

describe("the rules", () => {
  test("query parameters: required ones are required, objects are deepObject", () => {
    const built = buildOperationCatalogue(
      synthetic({
        "/api/companies/{cid}/people": {
          get: {
            operationId: "listPeople",
            summary: "List people",
            tags: ["People"],
            parameters: [
              { name: "cid", in: "path", required: true, schema: { type: "string" } },
              {
                name: "q",
                in: "query",
                required: true,
                schema: { type: "string" },
                description: "Search.",
              },
              { name: "limit", in: "query", required: false, schema: { type: "integer" } },
              {
                name: "filter",
                in: "query",
                style: "deepObject",
                schema: { type: "object", properties: { stage: { type: "string" } } },
              },
            ],
            responses: {
              200: { description: "OK", content: { "application/json": { schema: {} } } },
            },
            ...access(),
          },
        },
      }),
    );
    const operation = built.byName.get("listPeople")!;
    assert.deepEqual(operation.queryParams, [
      { name: "q", required: true, deepObject: false },
      { name: "limit", required: false, deepObject: false },
      { name: "filter", required: false, deepObject: true },
    ]);
    assert.deepEqual(operation.inputSchema, {
      type: "object",
      properties: {
        query: {
          type: "object",
          description: "Query-string parameters.",
          properties: {
            q: { type: "string", description: "Search." },
            limit: { type: "integer" },
            filter: { type: "object", properties: { stage: { type: "string" } } },
          },
          required: ["q"],
          additionalProperties: false,
        },
      },
      required: ["query"],
      additionalProperties: false,
    });
    assert.equal(operation.body, null);
  });

  test("a JSON body is converted, references inlined, and required when the reference says", () => {
    const built = buildOperationCatalogue(
      synthetic({
        "/api/companies/{cid}/people/{id}": {
          put: {
            operationId: "replacePerson",
            summary: "Replace a person",
            tags: ["People"],
            parameters: [
              {
                name: "id",
                in: "path",
                required: true,
                schema: { type: "string", format: "uuid" },
              },
            ],
            requestBody: {
              required: true,
              content: { "application/json": { schema: { $ref: "#/components/schemas/Person" } } },
            },
            responses: { 200: { description: "OK" } },
            ...access({ minimumRole: "admin" }),
          },
          patch: {
            operationId: "editPerson",
            summary: "Edit a person",
            tags: ["People"],
            parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
            requestBody: { content: { "application/json": { schema: { type: "object" } } } },
            responses: { 200: { description: "OK" } },
            ...access(),
          },
        },
      }),
    );
    const replace = built.byName.get("replacePerson")!;
    assert.deepEqual(replace.inputSchema.required, ["path", "body"]);
    assert.deepEqual((replace.inputSchema.properties as Record<string, unknown>).body, {
      type: "object",
      properties: { name: { type: "string" }, email: { type: ["string", "null"] } },
      required: ["name"],
    });
    assert.deepEqual(replace.annotations, {
      title: "Replace a person",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    });
    assert.equal(replace.callTool, "call_write_operation");
    assert.match(replace.description, /Needs the admin company role or higher\./);
    const edit = built.byName.get("editPerson")!;
    assert.deepEqual(edit.inputSchema.required, ["path"], "an optional body is not required");
    assert.deepEqual(edit.body, { kind: "json", required: false });
  });

  test("a form becomes body fields plus a file argument", () => {
    const built = buildOperationCatalogue(
      synthetic({
        "/api/companies/{cid}/files": {
          post: {
            operationId: "uploadFile",
            summary: "Upload a file",
            tags: ["Files"],
            requestBody: {
              required: true,
              content: {
                "multipart/form-data": {
                  schema: {
                    type: "object",
                    properties: {
                      upload: { type: "string", format: "binary", description: "The file." },
                      title: { type: "string" },
                      folderId: { type: "string", format: "uuid" },
                    },
                    required: ["upload", "title"],
                  },
                },
              },
            },
            responses: {
              201: { description: "Created", content: { "application/json": { schema: {} } } },
            },
            ...access(),
          },
        },
      }),
    );
    const operation = built.byName.get("uploadFile")!;
    assert.deepEqual(operation.upload, {
      field: "upload",
      required: true,
      description: "The file.",
    });
    assert.deepEqual(operation.body, { kind: "multipart", required: true });
    const properties = operation.inputSchema.properties as Record<string, Record<string, unknown>>;
    assert.deepEqual(Object.keys(properties.body.properties as object), ["title", "folderId"]);
    assert.deepEqual(properties.body.required, ["title"]);
    assert.equal(
      (properties.file.properties as Record<string, unknown>).base64 !== undefined,
      true,
    );
    assert.deepEqual(operation.inputSchema.required, ["body", "file"]);
    assert.equal(operation.response.status, 201);
  });

  test("a body that is neither JSON nor a form is kept, marked unsupported", () => {
    const built = buildOperationCatalogue(
      synthetic({
        "/api/companies/{cid}/files/raw": {
          post: {
            operationId: "uploadRaw",
            summary: "Upload raw bytes",
            tags: ["Files"],
            requestBody: {
              content: { "application/zip": { schema: { type: "string", format: "binary" } } },
            },
            responses: { 200: { description: "OK" } },
            ...access(),
          },
        },
      }),
    );
    assert.deepEqual(built.byName.get("uploadRaw")?.body, {
      kind: "unsupported",
      contentType: "application/zip",
    });
  });

  test("what a key cannot call is set aside with the reason", () => {
    const built = buildOperationCatalogue(
      synthetic({
        "/api/companies/{cid}/people/secret": {
          get: {
            operationId: "getSecret",
            summary: "Read a secret",
            tags: ["People"],
            ...access({ apiKey: false, sessionOnly: "browserSession" }),
          },
        },
        "/api/admin/things": {
          get: {
            operationId: "listAdminThings",
            summary: "List admin things",
            tags: ["People"],
            ...access({ apiKey: false, sessionOnly: "masterAdmin" }),
          },
        },
        "/api/auth/me": {
          get: {
            operationId: "getMe",
            summary: "Who am I",
            tags: ["People"],
            ...access({ apiKey: false, sessionOnly: "accountLevel" }),
          },
        },
        "/api/forms/{token}": {
          get: {
            operationId: "getPublicForm",
            summary: "Read a public form",
            tags: ["People"],
            "x-genosyn-access": { apiKey: false, browserSession: false },
          },
        },
        "/api/companies/{cid}/mcp": {
          post: { operationId: "sendMcp", summary: "Send MCP", tags: ["MCP"], ...access() },
        },
        "/api/elsewhere": {
          get: { operationId: "getElsewhere", summary: "Elsewhere", tags: ["People"], ...access() },
        },
        "/api/companies/{cid}/nameless": {
          get: { summary: "No id", tags: ["People"], ...access() },
        },
      }),
    );
    assert.equal(built.operations.length, 0);
    assert.match(built.unavailable.get("getSecret")!.reason, /signed-in browser/);
    assert.match(built.unavailable.get("listAdminThings")!.reason, /instance administration/);
    assert.match(built.unavailable.get("getMe")!.reason, /signed-in account/);
    assert.match(built.unavailable.get("getPublicForm")!.reason, /public/);
    assert.match(built.unavailable.get("sendMcp")!.reason, /MCP transport endpoint/);
    assert.ok(built.unavailable.get("getElsewhere"), "outside the company API");
    assert.equal(built.unavailable.size, 6, "an operation with no id is skipped entirely");
    assert.deepEqual(built.areas, []);
  });

  test("areas keep the reference's order; an unlisted one goes last", () => {
    const built = buildOperationCatalogue(
      synthetic({
        "/api/companies/{cid}/zebras": {
          get: { operationId: "listZebras", summary: "List zebras", tags: ["Zoo"], ...access() },
        },
        "/api/companies/{cid}/files": {
          get: { operationId: "listFiles", summary: "List files", tags: ["Files"], ...access() },
        },
        "/api/companies/{cid}/people": {
          get: { operationId: "listPeople", summary: "List people", tags: ["People"], ...access() },
        },
      }),
    );
    assert.deepEqual(built.areas, [
      { name: "People", description: "People and their things." },
      { name: "Files", description: "Files." },
      { name: "Zoo", description: "" },
    ]);
  });
});

describe("annotations from the HTTP method", () => {
  test("map each method to its hints", () => {
    assert.deepEqual(annotationsFor("get", "x"), {
      title: "x",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    });
    assert.equal(annotationsFor("post", "x").destructiveHint, false);
    assert.equal(annotationsFor("put", "x").idempotentHint, true);
    assert.equal(annotationsFor("patch", "x").idempotentHint, false);
    assert.equal(annotationsFor("delete", "x").destructiveHint, true);
    assert.deepEqual((["get", "post", "put", "patch", "delete"] as const).map(kindOf), [
      "read",
      "write",
      "write",
      "write",
      "delete",
    ]);
  });
});

describe("what one Member may call", () => {
  const op = (extra: Record<string, unknown>) => ({
    access: { browserSessionRequiredTo: [], ...extra },
  });

  test("roles", () => {
    assert.deepEqual(availabilityFor(op({}), { role: "member", financeAccess: "none" }), {
      available: true,
    });
    const adminOnly = op({ minimumRole: "admin" });
    assert.equal(
      availabilityFor(adminOnly, { role: "admin", financeAccess: "full" }).available,
      true,
    );
    assert.equal(
      availabilityFor(adminOnly, { role: "owner", financeAccess: "full" }).available,
      true,
    );
    const refused = availabilityFor(adminOnly, { role: "member", financeAccess: "full" });
    assert.equal(refused.available, false);
    assert.match(
      (refused as { reason: string }).reason,
      /admin company role or higher; the key's Member is a member/,
    );
    const ownerOnly = availabilityFor(op({ minimumRole: "owner" }), {
      role: "admin",
      financeAccess: "full",
    });
    assert.match((ownerOnly as { reason: string }).reason, /is an admin/);
  });

  test("Finance access", () => {
    const read = op({ financeAccess: "read" });
    const full = op({ financeAccess: "full" });
    assert.equal(availabilityFor(read, { role: "member", financeAccess: "read" }).available, true);
    assert.equal(availabilityFor(read, { role: "member", financeAccess: "none" }).available, false);
    assert.equal(availabilityFor(full, { role: "member", financeAccess: "full" }).available, true);
    const readOnly = availabilityFor(full, { role: "member", financeAccess: "read" });
    assert.match((readOnly as { reason: string }).reason, /read-only Finance access/);
    const none = availabilityFor(full, { role: "member", financeAccess: "none" });
    assert.match((none as { reason: string }).reason, /no Finance access/);
  });
});
