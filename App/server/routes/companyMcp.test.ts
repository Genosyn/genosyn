import assert from "node:assert/strict";
import type { RequestListener, Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { createApp } from "../app.js";
import { AppDataSource } from "../db/datasource.js";
import { ApiKey } from "../db/entities/ApiKey.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { CustomerContract } from "../db/entities/CustomerContract.js";
import { Membership, type FinanceAccess, type Role } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { appVersion } from "../lib/version.js";
import { operationCatalogue } from "../services/companyMcp/catalogue.js";
import { RESIDENT_TOOLS_BY_NAME } from "../services/companyMcp/tools.js";
import { setPublicUrl } from "../services/publicUrl.js";
import {
  createMemberOfNewCompany,
  mintTestApiKey,
  withTestInstanceSecrets,
} from "../test/apiAccess.js";
import { closeTestDb, initTestDb, insert } from "../test/dbHarness.js";

/**
 * The Genosyn MCP server end to end: a real MCP SDK client, over Streamable
 * HTTP, against the full `createApp()` stack with real handlers and a real
 * database. Every operation a tool calls goes back through the same app, so
 * these tests see what the App itself did — rows written, audit events
 * attributed, files stored — not what the MCP layer claims.
 */

let server: Server;
let baseUrl = "";
let restoreSecrets: () => void;
const app = createApp();
app.use(errorHandler);
const clients: Client[] = [];

before(async () => {
  restoreSecrets = withTestInstanceSecrets();
  await initTestDb();
  await setPublicUrl("http://genosyn.example.test");
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await Promise.allSettled(clients.map((client) => client.close()));
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
  restoreSecrets();
});

async function connect(token: string, companyId: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(
    new URL(`${baseUrl}/api/companies/${companyId}/mcp`),
    { requestInit: { headers: { authorization: `Bearer ${token}` } } },
  );
  const client = new Client({ name: "genosyn-mcp-test", version: "1.0.0" });
  await client.connect(transport);
  clients.push(client);
  return client;
}

async function ownerSession() {
  const member = await createMemberOfNewCompany("owner");
  const { key, token } = await mintTestApiKey(member.user.id, member.company.id, {
    name: "Claude Desktop",
  });
  const client = await connect(token, member.company.id);
  return { ...member, key, token, client };
}

/** A Member (not owner) of `companyId` with a key of their own. */
async function memberWithKey(companyId: string, role: Role, financeAccess: FinanceAccess) {
  const user = await insert(User, {
    email: `${role}-${financeAccess}-${Date.now()}-${Math.random()}@example.test`,
    name: `Pat ${role}`,
    passwordHash: "x",
    emailVerifiedAt: new Date(),
    sessionVersion: 0,
  });
  await insert(Membership, { companyId, userId: user.id, role, financeAccess });
  const { token } = await mintTestApiKey(user.id, companyId);
  return { user, token };
}

type Structured = Record<string, unknown>;

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<CallToolResult & { structuredContent?: Structured }> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult & {
    structuredContent?: Structured;
  };
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

describe("connecting", () => {
  test("initialize names the server and says whose authority it carries", async () => {
    const { client, company, user } = await ownerSession();
    assert.deepEqual(client.getServerVersion(), {
      name: "genosyn",
      title: "Genosyn",
      version: appVersion(),
    });
    assert.deepEqual(client.getServerCapabilities()?.tools, {});
    const instructions = client.getInstructions() ?? "";
    assert.match(instructions, new RegExp(company.name));
    assert.match(instructions, new RegExp(user.name));
    assert.match(instructions, /an owner of/);
    assert.match(instructions, /full Finance access/);
    assert.match(instructions, /"Claude Desktop"/);
    assert.match(instructions, /search_operations/);
    assert.match(
      instructions,
      /call_read_operation, call_write_operation and call_delete_operation/,
    );
  });

  test("tools/list shows the six resident tools with their schemas and annotations", async () => {
    const { client } = await ownerSession();
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name),
      [
        "whoami",
        "search_operations",
        "describe_operation",
        "call_read_operation",
        "call_write_operation",
        "call_delete_operation",
      ],
    );
    for (const tool of tools) {
      assert.equal(tool.inputSchema.type, "object", tool.name);
      assert.equal(tool.outputSchema?.type, "object", tool.name);
      assert.ok(tool.description && tool.description.length > 60, tool.name);
      assert.ok(tool.title, tool.name);
    }
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    for (const name of ["whoami", "search_operations", "describe_operation"]) {
      assert.equal(byName.get(name)?.annotations?.readOnlyHint, true, name);
      assert.equal(byName.get(name)?.annotations?.openWorldHint, false, name);
    }
    assert.deepEqual(byName.get("call_read_operation")?.annotations, {
      title: "Call a read operation",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    });
    assert.deepEqual(byName.get("call_write_operation")?.annotations, {
      title: "Call a write operation",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    });
    assert.deepEqual(byName.get("call_delete_operation")?.annotations, {
      title: "Call a delete operation",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    });
    // A read takes no body or file; a write takes both; a delete may carry a body.
    const properties = (name: string) =>
      Object.keys((byName.get(name)?.inputSchema.properties ?? {}) as Record<string, unknown>);
    assert.deepEqual(properties("call_read_operation"), ["operationId", "path", "query"]);
    assert.deepEqual(properties("call_write_operation"), [
      "operationId",
      "path",
      "query",
      "body",
      "file",
    ]);
    assert.deepEqual(properties("call_delete_operation"), ["operationId", "path", "query", "body"]);
  });

  test("a tool the server does not have is a protocol error naming the ones it has", async () => {
    const { client } = await ownerSession();
    await assert.rejects(
      client.callTool({ name: "createRevenueDeal", arguments: {} }),
      /Unknown tool "createRevenueDeal".*call_write_operation/s,
    );
  });

  test("ping answers", async () => {
    const { client } = await ownerSession();
    assert.deepEqual(await client.ping(), {});
  });
});

describe("whoami", () => {
  test("names the key's Member, their standing, the key and what they can call", async () => {
    const { client, company, user, key } = await ownerSession();
    const result = await call(client, "whoami");
    assert.equal(result.isError, undefined);
    const catalogue = operationCatalogue(app);
    assert.deepEqual(result.structuredContent, {
      user: { id: user.id, email: user.email, name: user.name, handle: null },
      company: { id: company.id, name: company.name, slug: company.slug },
      role: "owner",
      financeAccess: "full",
      authentication: "api_key",
      apiKey: { id: key.id, name: "Claude Desktop", prefix: `gen_${key.prefix}`, expiresAt: null },
      operations: { total: catalogue.operations.length, available: catalogue.operations.length },
      endpoint: `http://genosyn.example.test/api/companies/${company.id}/mcp`,
    });
    assert.match(textOf(result), /"role": "owner"/);
  });

  test("a key that stops working mid-request makes whoami fail plainly, without a mismatched result", async () => {
    const { company, user } = await ownerSession();
    const whoami = RESIDENT_TOOLS_BY_NAME.get("whoami")!;
    const result = await whoami.run(
      {
        app: app as unknown as RequestListener,
        companyId: company.id,
        companyName: company.name,
        member: { id: user.id, name: user.name, email: user.email },
        standing: { role: "owner", financeAccess: "full" },
        apiKey: { id: "k", name: "gone", prefix: "gen_x" },
        authorization: `Bearer gen_${"Z".repeat(43)}`,
        forwardedHeaders: { host: "genosyn.example.test" },
        remote: {},
        baseUrl: "http://genosyn.example.test",
      },
      {},
      new AbortController().signal,
    );
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent, undefined, "whoami's output schema is never violated");
    assert.match(textOf(result), /→ 401 Unauthorized \(getCompanyMe\)/);
  });

  test("a Member without Finance access sees fewer operations available", async () => {
    const { company } = await ownerSession();
    const member = await memberWithKey(company.id, "member", "none");
    const client = await connect(member.token, company.id);
    const result = await call(client, "whoami");
    const operations = result.structuredContent?.operations as { total: number; available: number };
    assert.equal(result.structuredContent?.role, "member");
    assert.equal(result.structuredContent?.financeAccess, "none");
    assert.ok(operations.available < operations.total, JSON.stringify(operations));
    const instructions = client.getInstructions() ?? "";
    assert.match(instructions, /a member of/);
    assert.match(instructions, /no Finance access/);
  });
});

describe("search_operations", () => {
  test("with no arguments lists every area and how much each offers", async () => {
    const { client } = await ownerSession();
    const result = await call(client, "search_operations");
    const areas = result.structuredContent?.areas as Array<{ name: string; operations: number }>;
    const catalogue = operationCatalogue(app);
    assert.equal(result.structuredContent?.total, catalogue.operations.length);
    assert.equal(
      areas.reduce((sum, area) => sum + area.operations, 0),
      catalogue.operations.length,
    );
    for (const name of ["Revenue", "Tasks", "Finance", "Employees", "Routines"]) {
      assert.ok(
        areas.some((area) => area.name === name),
        `${name} is listed`,
      );
    }
    assert.ok(!areas.some((area) => area.name === "MCP"), "the transports are not operations");
    assert.ok(!areas.some((area) => area.name === "Vault"), "the Vault needs a browser");
    assert.match(textOf(result), /Revenue \(\d+\)/);
  });

  test("a query of nothing but filler lists the areas, as no query does", async () => {
    const { client } = await ownerSession();
    const result = await call(client, "search_operations", { query: " the  " });
    assert.ok(Array.isArray(result.structuredContent?.areas));
  });

  test("finds an operation by what it does, and names the tool that calls it", async () => {
    const { client } = await ownerSession();
    const result = await call(client, "search_operations", { query: "create a tag" });
    const operations = result.structuredContent?.operations as Array<Structured>;
    assert.equal(operations[0]?.operationId, "createTag");
    assert.deepEqual(operations[0], {
      operationId: "createTag",
      method: "POST",
      path: "/api/companies/{cid}/tags",
      summary: operations[0]?.summary,
      area: "Tags",
      tool: "call_write_operation",
      available: true,
    });
    assert.match(textOf(result), /createTag — POST \/tags/);
  });

  test("lists one area by name in any case, and filters by kind", async () => {
    const { client } = await ownerSession();
    const area = await call(client, "search_operations", { area: "tags", limit: 50 });
    const inArea = area.structuredContent?.operations as Array<Structured>;
    assert.equal(area.structuredContent?.area, "Tags");
    assert.ok(inArea.length >= 4);
    assert.ok(inArea.every((operation) => operation.area === "Tags"));

    const deletes = await call(client, "search_operations", { area: "Tags", kind: "delete" });
    const onlyDeletes = deletes.structuredContent?.operations as Array<Structured>;
    assert.ok(onlyDeletes.length >= 1);
    assert.ok(onlyDeletes.every((operation) => operation.method === "DELETE"));
    assert.ok(onlyDeletes.every((operation) => operation.tool === "call_delete_operation"));
  });

  test("pages through long results", async () => {
    const { client } = await ownerSession();
    const first = await call(client, "search_operations", { area: "Revenue", limit: 5 });
    assert.equal(first.structuredContent?.nextOffset, 5);
    const second = await call(client, "search_operations", {
      area: "Revenue",
      limit: 5,
      offset: 5,
    });
    const ids = (result: typeof first) =>
      (result.structuredContent?.operations as Array<Structured>).map((op) => op.operationId);
    assert.equal(ids(second).length, 5);
    assert.deepEqual(
      ids(first).filter((id) => ids(second).includes(id)),
      [],
    );
    assert.match(textOf(first), /call again with offset 5/);
  });

  test("an unknown area lists the real ones; bad arguments are explained", async () => {
    const { client } = await ownerSession();
    const unknown = await call(client, "search_operations", { area: "Spaceships" });
    assert.equal(unknown.isError, true);
    assert.match(textOf(unknown), /There is no area "Spaceships"\. The areas are: .*Revenue/);
    const bad = await call(client, "search_operations", { limit: 500 });
    assert.equal(bad.isError, true);
    assert.match(textOf(bad), /Invalid arguments: limit/);
    const none = await call(client, "search_operations", { query: "zzzqqqxxx" });
    assert.equal(none.structuredContent?.total, 0);
    assert.match(textOf(none), /No operation matching/);
  });

  test("marks what the key's Member cannot call, and why", async () => {
    const { company } = await ownerSession();
    const member = await memberWithKey(company.id, "member", "none");
    const client = await connect(member.token, company.id);
    const goals = await call(client, "search_operations", { query: "create goal" });
    const createGoal = (goals.structuredContent?.operations as Array<Structured>).find(
      (operation) => operation.operationId === "createGoal",
    );
    assert.equal(createGoal?.available, false);
    assert.match(String(createGoal?.unavailableReason), /admin company role.*a member/);
    const invoices = await call(client, "search_operations", { query: "list invoices" });
    const listInvoices = (invoices.structuredContent?.operations as Array<Structured>).find(
      (operation) => operation.operationId === "listInvoices",
    );
    assert.equal(listInvoices?.available, false);
    assert.match(String(listInvoices?.unavailableReason), /Finance read access/);
  });
});

describe("describe_operation", () => {
  test("returns the operation's generated tool: inputs, annotations, access and an example", async () => {
    const { client } = await ownerSession();
    const result = await call(client, "describe_operation", { operationId: "updateTag" });
    assert.equal(result.isError, undefined);
    const described = result.structuredContent as Structured & {
      inputSchema: { properties: Record<string, { required?: string[] }>; required: string[] };
    };
    assert.equal(described.name, "updateTag");
    assert.equal(described.method, "PATCH");
    assert.equal(described.path, "/api/companies/{cid}/tags/{tagId}");
    assert.equal(described.area, "Tags");
    assert.equal(described.callWith, "call_write_operation");
    assert.equal(described.available, true);
    assert.deepEqual(described.annotations, {
      title: described.title,
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    });
    assert.deepEqual(described.inputSchema.required, ["path", "body"]);
    assert.deepEqual(described.inputSchema.properties.path.required, ["tagId"]);
    // The tags router checks its id inline, so the reference knows it only as a string.
    assert.deepEqual(described.example, {
      operationId: "updateTag",
      path: { tagId: "<string>" },
      body: {},
    });
  });

  test("describes a file upload and its form fields", async () => {
    const { client } = await ownerSession();
    const result = await call(client, "describe_operation", { operationId: "createContract" });
    const described = result.structuredContent as Structured & {
      inputSchema: { properties: Record<string, unknown>; required: string[] };
    };
    assert.deepEqual(described.upload, {
      field: "file",
      required: true,
      description: "The signed agreement.",
    });
    assert.deepEqual(described.inputSchema.required, ["file"]);
    assert.ok(described.inputSchema.properties.body);
    assert.deepEqual(described.example, {
      operationId: "createContract",
      file: { name: "document.pdf", base64: "<base64>" },
    });
  });

  test("an operation the server cannot call is refused with the reason", async () => {
    const { client } = await ownerSession();
    const mint = await call(client, "describe_operation", { operationId: "createApiKey" });
    assert.equal(mint.isError, true);
    assert.match(
      textOf(mint),
      /createApiKey .* cannot be called through this server\. It needs a person at a signed-in browser/,
    );
    const transport = await call(client, "describe_operation", {
      operationId: "sendCompanyMcpMessage",
    });
    assert.equal(transport.isError, true);
    assert.match(textOf(transport), /MCP transport endpoint/);
  });

  test("a mistyped id suggests the operation that was meant", async () => {
    const { client } = await ownerSession();
    const result = await call(client, "describe_operation", { operationId: "createTags" });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /There is no operation "createTags"\. Did you mean createTag/);
  });
});

describe("calling operations", () => {
  test("a create → read → update → delete round trip on Revenue deal stages, audited as the Member", async () => {
    const { client, company, user } = await ownerSession();

    const created = await call(client, "call_write_operation", {
      operationId: "createRevenueStage",
      body: { name: "Discovery call", probability: 15 },
    });
    assert.equal(created.isError, undefined, textOf(created));
    assert.equal(created.structuredContent?.status, 201);
    assert.equal(created.structuredContent?.ok, true);
    assert.equal(created.structuredContent?.method, "POST");
    assert.equal(created.structuredContent?.path, `/api/companies/${company.id}/revenue/stages`);
    const stage = created.structuredContent?.data as {
      id: string;
      name: string;
      probability: number;
    };
    assert.equal(stage.name, "Discovery call");
    assert.match(
      textOf(created),
      new RegExp(
        `POST /api/companies/${company.id}/revenue/stages → 201 Created \\(createRevenueStage\\)`,
      ),
    );

    const listed = await call(client, "call_read_operation", { operationId: "listRevenueStages" });
    assert.equal(listed.structuredContent?.status, 200);
    const stages = listed.structuredContent?.data as Array<{ id: string; name: string }>;
    assert.ok(stages.some((row) => row.id === stage.id && row.name === "Discovery call"));

    const updated = await call(client, "call_write_operation", {
      operationId: "updateRevenueStage",
      path: { id: stage.id },
      body: { name: "First call" },
    });
    assert.equal(updated.structuredContent?.status, 200, textOf(updated));
    assert.equal((updated.structuredContent?.data as { name: string }).name, "First call");

    const removed = await call(client, "call_delete_operation", {
      operationId: "deleteRevenueStage",
      path: { id: stage.id },
    });
    assert.equal(removed.structuredContent?.status, 200, textOf(removed));

    const after = await call(client, "call_read_operation", { operationId: "listRevenueStages" });
    assert.ok(
      !(after.structuredContent?.data as Array<{ id: string }>).some((row) => row.id === stage.id),
      "the archived stage left the board",
    );

    // The App, not the MCP layer, wrote the audit trail — under the key's Member.
    const events = await AppDataSource.getRepository(AuditEvent).find({
      where: { companyId: company.id, targetId: stage.id },
      order: { createdAt: "ASC" },
    });
    assert.deepEqual(
      events.map((event) => event.action),
      ["revenue.stage.create", "revenue.stage.update", "revenue.stage.archive"],
    );
    for (const event of events) {
      assert.equal(event.actorUserId, user.id);
      assert.equal(event.actorKind, "user");
    }
  });

  test("a full round trip on Tags, with a real DELETE", async () => {
    const { client } = await ownerSession();
    const created = await call(client, "call_write_operation", {
      operationId: "createTag",
      body: { name: "From MCP" },
    });
    const tag = created.structuredContent?.data as { id: string };
    assert.equal(created.structuredContent?.status, 201);
    const renamed = await call(client, "call_write_operation", {
      operationId: "updateTag",
      path: { tagId: tag.id },
      body: { name: "Renamed over MCP" },
    });
    assert.equal(renamed.structuredContent?.status, 200);
    const deleted = await call(client, "call_delete_operation", {
      operationId: "deleteTag",
      path: { tagId: tag.id },
    });
    assert.deepEqual(deleted.structuredContent?.data, { ok: true });
    const listed = await call(client, "call_read_operation", { operationId: "listTags" });
    assert.deepEqual(listed.structuredContent?.data, []);
  });

  test("query parameters reach the route's own validator", async () => {
    const { client } = await ownerSession();
    for (const name of ["Ada Lovelace", "Grace Hopper", "Alan Turing"]) {
      await call(client, "call_write_operation", {
        operationId: "createRevenueContact",
        body: { name },
      });
    }
    const found = await call(client, "call_read_operation", {
      operationId: "listRevenueContacts",
      query: { q: "grace", limit: 10 },
    });
    const data = found.structuredContent?.data as { rows: Array<{ name: string }>; total: number };
    assert.deepEqual(
      data.rows.map((row) => row.name),
      ["Grace Hopper"],
    );
    const limited = await call(client, "call_read_operation", {
      operationId: "listRevenueContacts",
      query: { limit: 2 },
    });
    assert.equal((limited.structuredContent?.data as { rows: unknown[] }).rows.length, 2);
  });

  test("the company is filled in; naming it is fine, naming another is refused", async () => {
    const { client, company } = await ownerSession();
    const same = await call(client, "call_read_operation", {
      operationId: "getCompany",
      path: { cid: company.id },
    });
    assert.equal(same.structuredContent?.status, 200, textOf(same));
    const other = await ownerSession();
    const refused = await call(client, "call_read_operation", {
      operationId: "getCompany",
      path: { cid: other.company.id },
    });
    assert.equal(refused.isError, true);
    assert.match(textOf(refused), /acts for .* only\. Leave cid out/);
  });

  test("structural mistakes are explained before anything is sent", async () => {
    const { client, company } = await ownerSession();
    const cases: Array<[string, Record<string, unknown>, RegExp]> = [
      [
        "call_write_operation",
        { operationId: "updateTag", body: { name: "x" } },
        /updateTag needs the path parameter "tagId"/,
      ],
      [
        "call_write_operation",
        { operationId: "updateTag", path: { id: "nope", tagId: "x" }, body: {} },
        /updateTag has no path parameter "id"\. Its path parameters are "tagId"/,
      ],
      [
        "call_read_operation",
        { operationId: "listTags", path: { tagId: "x" } },
        /listTags takes no path parameters/,
      ],
      [
        "call_read_operation",
        { operationId: "createTag" },
        /createTag is a write \(POST, PUT or PATCH\) operation .*call it with call_write_operation, not call_read_operation/,
      ],
      [
        "call_write_operation",
        { operationId: "deleteTag", path: { tagId: "x" } },
        /deleteTag is a delete \(DELETE\) operation .*call it with call_delete_operation/,
      ],
      [
        "call_read_operation",
        { operationId: "listTags", body: { name: "x" } },
        /A read operation takes no body or file/,
      ],
      [
        "call_write_operation",
        { operationId: "createTag", body: { name: "x" }, file: { name: "a.txt", text: "x" } },
        /createTag takes a JSON body, not a file/,
      ],
      [
        "call_write_operation",
        { operationId: "createContract" },
        /createContract needs a file: The signed agreement\./,
      ],
      [
        "call_write_operation",
        { operationId: "createContract", file: { name: "a.txt", text: "x", base64: "eA==" } },
        /exactly one of base64 \(any file\) or text/,
      ],
      [
        "call_write_operation",
        { operationId: "createContract", file: { name: "a.bin", base64: "not base64!" } },
        /not valid base64/,
      ],
      [
        "call_write_operation",
        { operationId: "updateTag", path: { tagId: ".." }, body: {} },
        /cannot be "\.\."/,
      ],
      ["call_read_operation", { operationId: 42 }, /Invalid arguments: operationId/],
      ["call_read_operation", { operationId: "listTags", extra: true }, /Invalid arguments/],
    ];
    for (const [tool, args, expected] of cases) {
      const result = await call(client, tool, args);
      assert.equal(result.isError, true, `${tool} ${JSON.stringify(args)}`);
      assert.match(textOf(result), expected);
      assert.equal(result.structuredContent, undefined, "nothing was sent, so no status");
    }
    // None of those reached the App.
    const tags = await call(client, "call_read_operation", { operationId: "listTags" });
    assert.deepEqual(tags.structuredContent?.data, []);
    void company;
  });

  test("session-only and transport operations cannot be called", async () => {
    const { client, company } = await ownerSession();
    for (const [tool, operationId] of [
      ["call_write_operation", "createApiKey"],
      ["call_read_operation", "listApiKeys"],
      ["call_read_operation", "listVaultItems"],
      ["call_write_operation", "sendCompanyMcpMessage"],
      ["call_write_operation", "connectEmployeeMcp"],
    ] as const) {
      const result = await call(client, tool, { operationId });
      assert.equal(result.isError, true, operationId);
      assert.match(textOf(result), /cannot be called through this server/, operationId);
    }
    assert.equal(
      await AppDataSource.getRepository(ApiKey).countBy({ companyId: company.id }),
      1,
      "no key was minted",
    );
  });
});

describe("errors come back explained", () => {
  test("a validation failure lists the fields the route's schema refused", async () => {
    const { client } = await ownerSession();
    const result = await call(client, "call_write_operation", {
      operationId: "createRevenueStage",
      body: { probability: 900 },
    });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent?.status, 400);
    assert.equal(result.structuredContent?.ok, false);
    const error = result.structuredContent?.error as {
      message: string;
      issues: unknown[];
      explanation: string;
    };
    assert.equal(error.message, "ValidationError");
    assert.ok(error.issues.length >= 2);
    const text = textOf(result);
    assert.match(text, /→ 400 Bad Request \(createRevenueStage\)/);
    assert.match(text, /- body\.name: Required/);
    assert.match(text, /- body\.probability: /);
    assert.match(text, /describe_operation shows its schema/);
  });

  test("404 reminds that every id belongs to this company", async () => {
    const { client, company } = await ownerSession();
    const result = await call(client, "call_read_operation", {
      operationId: "getRevenueContact",
      path: { id: "6f1c2b9e-5d4a-4b8c-9e7f-0a1b2c3d4e5f" },
    });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent?.status, 404);
    assert.match(textOf(result), /Contact not found/);
    assert.match(textOf(result), new RegExp(`each must belong to ${company.name}`));
  });

  test("409 says the record changed or already exists", async () => {
    const { client } = await ownerSession();
    const first = await call(client, "call_write_operation", {
      operationId: "createTag",
      body: { name: "Alpha" },
    });
    const second = await call(client, "call_write_operation", {
      operationId: "createTag",
      body: { name: "Beta" },
    });
    const result = await call(client, "call_write_operation", {
      operationId: "updateTag",
      path: { tagId: (second.structuredContent?.data as { id: string }).id },
      body: { name: "Alpha" },
    });
    assert.equal(result.isError, true, textOf(result));
    assert.equal(result.structuredContent?.status, 409);
    assert.match(textOf(result), /already exists/);
    void first;
  });

  test("403 for a role says what the operation needs and what the Member has", async () => {
    const { company } = await ownerSession();
    const member = await memberWithKey(company.id, "member", "none");
    const client = await connect(member.token, company.id);
    const read = await call(client, "call_read_operation", { operationId: "listGoals" });
    assert.equal(read.structuredContent?.status, 200, "a Member reads Goals");
    const result = await call(client, "call_write_operation", {
      operationId: "createGoal",
      body: { title: "Grow", targetValue: 10 },
    });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent?.status, 403);
    const text = textOf(result);
    assert.match(text, /admin company role required/);
    assert.match(
      text,
      new RegExp(`acts as ${member.user.name}, a member of ${company.name} with no Finance access`),
    );
    assert.match(text, /Needs the admin company role or higher/);
  });

  test("Finance access limits a key exactly as it limits its Member", async () => {
    const { company } = await ownerSession();
    const none = await memberWithKey(company.id, "member", "none");
    const noneClient = await connect(none.token, company.id);
    const refused = await call(noneClient, "call_read_operation", { operationId: "listInvoices" });
    assert.equal(refused.structuredContent?.status, 403);
    assert.match(textOf(refused), /Needs Finance read access/);

    const reader = await memberWithKey(company.id, "member", "read");
    const readerClient = await connect(reader.token, company.id);
    const read = await call(readerClient, "call_read_operation", { operationId: "listInvoices" });
    assert.equal(read.structuredContent?.status, 200, textOf(read));
    const write = await call(readerClient, "call_write_operation", {
      operationId: "createTaxRate",
      body: { name: "VAT", ratePercent: 20 },
    });
    assert.equal(write.structuredContent?.status, 403, textOf(write));
    assert.match(textOf(write), /read-only Finance access/);
  });
});

describe("files", () => {
  test("a file goes up as base64 and comes back as an embedded resource", async () => {
    const { client, company, user } = await ownerSession();
    const bytes = Buffer.from("%PDF-1.4\n% a tiny agreement\n", "utf8");
    const uploaded = await call(client, "call_write_operation", {
      operationId: "createContract",
      body: { title: "Master services agreement", notes: "Signed in person" },
      file: { name: "msa.pdf", base64: bytes.toString("base64") },
    });
    assert.equal(uploaded.structuredContent?.status, 201, textOf(uploaded));
    const contract = uploaded.structuredContent?.data as {
      id: string;
      filename: string;
      mimeType: string;
      sizeBytes: number;
      title: string;
    };
    assert.equal(contract.title, "Master services agreement");
    assert.equal(contract.filename, "msa.pdf");
    assert.equal(contract.mimeType, "application/pdf");
    assert.equal(contract.sizeBytes, bytes.length);
    const row = await AppDataSource.getRepository(CustomerContract).findOneByOrFail({
      id: contract.id,
    });
    assert.equal(row.uploadedByUserId, user.id);

    const downloaded = await call(client, "call_read_operation", {
      operationId: "getContractFile",
      path: { id: contract.id },
    });
    assert.equal(downloaded.isError, undefined, textOf(downloaded));
    const file = downloaded.structuredContent?.file as Structured;
    assert.equal(file.contentType, "application/pdf");
    assert.equal(file.bytes, bytes.length);
    assert.equal(file.embedded, true);
    assert.equal(file.name, "msa.pdf");
    assert.equal(
      file.url,
      `http://genosyn.example.test/api/companies/${company.id}/contracts/${contract.id}/file`,
    );
    const resource = downloaded.content.find((block) => block.type === "resource") as
      | { type: "resource"; resource: { uri: string; mimeType: string; blob: string } }
      | undefined;
    assert.ok(resource, "the file is embedded");
    assert.equal(resource.resource.mimeType, "application/pdf");
    assert.deepEqual(Buffer.from(resource.resource.blob, "base64"), bytes);
  });

  test("a text file goes up as text, its type guessed from its name", async () => {
    const { client } = await ownerSession();
    const uploaded = await call(client, "call_write_operation", {
      operationId: "createContract",
      file: { name: "terms.txt", text: "Net 30. Governing law: Delaware." },
    });
    assert.equal(uploaded.structuredContent?.status, 201, textOf(uploaded));
    const contract = uploaded.structuredContent?.data as { id: string; mimeType: string };
    assert.equal(contract.mimeType, "text/plain");
    const downloaded = await call(client, "call_read_operation", {
      operationId: "getContractFile",
      path: { id: contract.id },
    });
    assert.equal(downloaded.structuredContent?.data, "Net 30. Governing law: Delaware.");
  });

  test("an image comes back as an image the model can see", async () => {
    const { client } = await ownerSession();
    // A 1×1 transparent PNG.
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
      "base64",
    );
    const uploaded = await call(client, "call_write_operation", {
      operationId: "createContract",
      file: { name: "signature.png", base64: png.toString("base64") },
    });
    const contract = uploaded.structuredContent?.data as { id: string };
    const downloaded = await call(client, "call_read_operation", {
      operationId: "getContractFile",
      path: { id: contract.id },
    });
    const image = downloaded.content.find((block) => block.type === "image") as
      | { type: "image"; data: string; mimeType: string }
      | undefined;
    assert.ok(image);
    assert.equal(image.mimeType, "image/png");
    assert.deepEqual(Buffer.from(image.data, "base64"), png);
  });

  test("a CSV export comes back as text", async () => {
    const { client } = await ownerSession();
    const result = await call(client, "call_read_operation", {
      operationId: "getExportsCustomersCsv",
    });
    assert.equal(result.isError, undefined, textOf(result));
    assert.match(String(result.structuredContent?.contentType), /text\/csv/);
    assert.equal(typeof result.structuredContent?.data, "string");
  });
});

describe("the key stays the authority for every call", () => {
  test("a key revoked mid-conversation stops the next call", async () => {
    const { client, key } = await ownerSession();
    assert.equal((await call(client, "whoami")).isError, undefined);
    await AppDataSource.getRepository(ApiKey).update({ id: key.id }, { revokedAt: new Date() });
    await assert.rejects(call(client, "whoami"), /401|not accepted/);
  });

  test("a Member demoted mid-conversation loses the power on the next call", async () => {
    const { company } = await ownerSession();
    const admin = await memberWithKey(company.id, "admin", "full");
    const client = await connect(admin.token, company.id);
    const allowed = await call(client, "call_write_operation", {
      operationId: "createGoal",
      body: { title: "Grow revenue", targetValue: 10 },
    });
    assert.ok(
      (allowed.structuredContent?.status as number) < 300,
      `an admin creates a Goal: ${textOf(allowed)}`,
    );
    await AppDataSource.getRepository(Membership).update(
      { companyId: company.id, userId: admin.user.id },
      { role: "member" },
    );
    const refused = await call(client, "call_write_operation", {
      operationId: "createGoal",
      body: { title: "Grow again", targetValue: 20 },
    });
    assert.equal(refused.structuredContent?.status, 403);
  });

  test("another company's records are out of reach, by id or by listing", async () => {
    const first = await ownerSession();
    const second = await ownerSession();
    const made = await call(first.client, "call_write_operation", {
      operationId: "createRevenueContact",
      body: { name: "Only in the first company" },
    });
    const contact = made.structuredContent?.data as { id: string };
    assert.equal(made.structuredContent?.status, 201);

    const read = await call(second.client, "call_read_operation", {
      operationId: "getRevenueContact",
      path: { id: contact.id },
    });
    assert.equal(read.structuredContent?.status, 404);
    const update = await call(second.client, "call_write_operation", {
      operationId: "updateRevenueContact",
      path: { id: contact.id },
      body: { name: "Hijacked" },
    });
    assert.equal(update.structuredContent?.status, 404);
    const listed = await call(second.client, "call_read_operation", {
      operationId: "listRevenueContacts",
    });
    assert.equal((listed.structuredContent?.data as { total: number }).total, 0);
    const untouched = await call(first.client, "call_read_operation", {
      operationId: "getRevenueContact",
      path: { id: contact.id },
    });
    assert.equal(
      (untouched.structuredContent?.data as { contact: { name: string } }).contact.name,
      "Only in the first company",
    );
  });

  test("using the server records the key as used", async () => {
    const { client, key } = await ownerSession();
    await call(client, "whoami");
    let stored: ApiKey | null = null;
    for (let attempt = 0; attempt < 20 && !stored?.lastUsedAt; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      stored = await AppDataSource.getRepository(ApiKey).findOneBy({ id: key.id });
    }
    assert.ok(stored?.lastUsedAt, "lastUsedAt was recorded");
  });
});
