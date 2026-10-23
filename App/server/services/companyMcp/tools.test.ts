import assert from "node:assert/strict";
import type { RequestListener } from "node:http";
import { describe, test } from "node:test";

import { ToolSchema } from "@modelcontextprotocol/sdk/types.js";

import { createApp } from "../../app.js";
import { strictJsonSchemaValidator } from "../../test/jsonSchemaValidator.js";
import { operationCatalogue } from "./catalogue.js";
import type { CallerContext } from "./context.js";
import { instructionsFor, SERVER_INFO } from "./server.js";
import { exampleValue, RESIDENT_TOOLS, RESIDENT_TOOLS_BY_NAME, toolDefinition } from "./tools.js";

/**
 * The resident tools as `tools/list` publishes them, and what the server tells
 * a client's model on `initialize`. The end-to-end behaviour of each tool is in
 * `routes/companyMcp.test.ts`; this pins the definitions themselves.
 */

describe("the resident tools", () => {
  test("are six, in a stable order, with unique snake_case names", () => {
    assert.deepEqual(
      RESIDENT_TOOLS.map((tool) => tool.name),
      [
        "whoami",
        "search_operations",
        "describe_operation",
        "call_read_operation",
        "call_write_operation",
        "call_delete_operation",
      ],
    );
    for (const tool of RESIDENT_TOOLS) assert.match(tool.name, /^[a-z]+(?:_[a-z]+)*$/);
    assert.equal(RESIDENT_TOOLS_BY_NAME.size, RESIDENT_TOOLS.length);
  });

  test("each definition is a valid MCP tool", () => {
    for (const tool of RESIDENT_TOOLS) {
      const parsed = ToolSchema.safeParse(toolDefinition(tool));
      assert.ok(parsed.success, `${tool.name}: ${parsed.success ? "" : parsed.error.message}`);
      assert.deepEqual(Object.keys(toolDefinition(tool)).sort(), [
        "annotations",
        "description",
        "inputSchema",
        "name",
        "outputSchema",
        "title",
      ]);
    }
  });

  test("every input and output schema is valid, strict JSON Schema 2020-12", () => {
    const validator = strictJsonSchemaValidator();
    for (const tool of RESIDENT_TOOLS) {
      assert.doesNotThrow(() => validator.compile(tool.inputSchema), `${tool.name} input`);
      assert.doesNotThrow(() => validator.compile(tool.outputSchema!), `${tool.name} output`);
    }
  });

  test("input schemas accept good calls and reject bad ones", () => {
    const validator = strictJsonSchemaValidator();
    const accepts = (name: string, args: unknown) =>
      validator.compile(RESIDENT_TOOLS_BY_NAME.get(name)!.inputSchema)(args);
    assert.equal(accepts("whoami", {}), true);
    assert.equal(accepts("whoami", { anything: 1 }), false);
    assert.equal(accepts("search_operations", {}), true);
    assert.equal(
      accepts("search_operations", {
        query: "deals",
        area: "Revenue",
        kind: "read",
        limit: 5,
        offset: 10,
      }),
      true,
    );
    assert.equal(accepts("search_operations", { kind: "everything" }), false);
    assert.equal(accepts("search_operations", { limit: 0 }), false);
    assert.equal(accepts("describe_operation", { operationId: "listTags" }), true);
    assert.equal(accepts("describe_operation", {}), false);
    assert.equal(
      accepts("call_read_operation", {
        operationId: "getTag",
        path: { id: "x", n: 1 },
        query: { q: { deep: true } },
      }),
      true,
    );
    assert.equal(
      accepts("call_read_operation", { operationId: "listTags", body: {} }),
      false,
      "reads take no body",
    );
    assert.equal(accepts("call_read_operation", { path: {} }), false, "operationId is required");
    assert.equal(
      accepts("call_write_operation", {
        operationId: "createContract",
        body: { title: "x" },
        file: { name: "a.pdf", base64: "eA==" },
      }),
      true,
    );
    assert.equal(
      accepts("call_write_operation", { operationId: "createContract", file: { base64: "eA==" } }),
      false,
      "a file needs its name",
    );
    assert.equal(
      accepts("call_delete_operation", { operationId: "deleteTag", path: { tagId: "x" } }),
      true,
    );
    assert.equal(
      accepts("call_delete_operation", { operationId: "deleteTag", file: { name: "a" } }),
      false,
      "deletes take no file",
    );
  });

  test("annotations: discovery reads, calls as their method class", () => {
    const annotations = Object.fromEntries(
      RESIDENT_TOOLS.map((tool) => [tool.name, tool.annotations]),
    );
    for (const name of ["whoami", "search_operations", "describe_operation"]) {
      assert.equal(annotations[name]?.readOnlyHint, true, name);
      assert.equal(annotations[name]?.openWorldHint, false, name);
    }
    assert.equal(annotations.call_read_operation?.readOnlyHint, true);
    assert.equal(annotations.call_write_operation?.readOnlyHint, false);
    assert.equal(annotations.call_write_operation?.destructiveHint, true);
    assert.equal(annotations.call_delete_operation?.destructiveHint, true);
    assert.equal(annotations.call_delete_operation?.idempotentHint, true);
    for (const tool of RESIDENT_TOOLS) assert.equal(tool.annotations?.title, tool.title, tool.name);
  });

  test("descriptions say what each tool is for, in the product's words", () => {
    for (const tool of RESIDENT_TOOLS) {
      assert.ok((tool.description ?? "").length > 80, tool.name);
      assert.doesNotMatch(
        tool.description ?? "",
        /\bTask\b|\bagent\b/,
        `${tool.name} keeps AGENTS.md vocabulary`,
      );
    }
    assert.match(RESIDENT_TOOLS_BY_NAME.get("search_operations")!.description!, /lists the areas/);
    assert.match(RESIDENT_TOOLS_BY_NAME.get("call_write_operation")!.description!, /audit log/);
    assert.match(RESIDENT_TOOLS_BY_NAME.get("call_delete_operation")!.description!, /permanent/);
  });
});

describe("example values", () => {
  test("fill required fields with a placeholder of the right shape", () => {
    assert.deepEqual(
      exampleValue({
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          when: { type: "string", format: "date-time" },
          day: { type: "string", format: "date" },
          email: { type: "string", format: "email" },
          site: { type: "string", format: "uri" },
          name: { type: "string" },
          count: { type: "integer", minimum: 3 },
          ratio: { type: "number" },
          on: { type: "boolean" },
          optional: { type: "string" },
        },
        required: ["id", "when", "day", "email", "site", "name", "count", "ratio", "on"],
      }),
      {
        id: "<uuid>",
        when: "2026-01-31T09:00:00.000Z",
        day: "2026-01-31",
        email: "name@example.com",
        site: "https://example.com",
        name: "<string>",
        count: 3,
        ratio: 1,
        on: true,
      },
    );
  });

  test("prefer what the schema itself offers: examples, defaults, consts and enums", () => {
    assert.equal(exampleValue({ type: "string", examples: ["Ada"] }), "Ada");
    assert.equal(exampleValue({ type: "integer", default: 25 }), 25);
    assert.equal(exampleValue({ const: "dismiss" }), "dismiss");
    assert.equal(exampleValue({ type: ["string", "null"], enum: [null, "won", "lost"] }), "won");
  });

  test("unions take their first non-null member; arrays fill only when they must", () => {
    assert.equal(
      exampleValue({ anyOf: [{ type: "null" }, { type: "string", format: "uuid" }] }),
      "<uuid>",
    );
    assert.deepEqual(exampleValue({ type: "array", items: { type: "string" } }), []);
    assert.deepEqual(exampleValue({ type: "array", items: { type: "string" }, minItems: 1 }), [
      "<string>",
    ]);
    assert.equal(exampleValue({ type: ["integer", "null"] }), 1);
    assert.deepEqual(exampleValue({ type: "object" }), {});
    assert.equal(exampleValue({}), null);
    assert.equal(exampleValue("nonsense"), null);
  });
});

describe("what the server tells a client on initialize", () => {
  const app = createApp() as unknown as RequestListener;
  const catalogue = operationCatalogue(app);
  const context = (
    role: "owner" | "admin" | "member",
    financeAccess: "none" | "read" | "full",
  ): CallerContext => ({
    app,
    companyId: "c1",
    companyName: "Sunwise",
    member: { id: "u1", name: "Morgan Lee", email: "morgan@example.com" },
    standing: { role, financeAccess },
    apiKey: { id: "k1", name: "Cursor", prefix: "gen_abcdefgh" },
    authorization: "Bearer gen_x",
    forwardedHeaders: {},
    remote: {},
    baseUrl: "https://genosyn.example.com",
  });

  test("whose authority, how much of the API, and how to find an operation", () => {
    const text = instructionsFor(context("owner", "full"));
    assert.match(text, /^Genosyn is where Sunwise is run with AI Employees\./);
    assert.match(
      text,
      /acts as Morgan Lee — an owner of Sunwise with full Finance access — through their API key "Cursor"/,
    );
    assert.match(
      text,
      new RegExp(
        `${catalogue.operations.length} of ${catalogue.operations.length} operations, in ${catalogue.areas.length} areas`,
      ),
    );
    assert.match(text, /search_operations finds an operation/);
    assert.match(text, /audit log under this Member/);
  });

  test("a narrower Member is told how much less they can do", () => {
    const text = instructionsFor(context("member", "none"));
    assert.match(text, /a member of Sunwise with no Finance access/);
    const available = Number(/(\d+) of \d+ operations/.exec(text)?.[1]);
    assert.ok(available < catalogue.operations.length);
    assert.match(
      instructionsFor(context("admin", "read")),
      /an admin of Sunwise with read-only Finance access/,
    );
  });

  test("the server is called genosyn", () => {
    assert.deepEqual(SERVER_INFO, { name: "genosyn", title: "Genosyn" });
  });
});
