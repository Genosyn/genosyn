import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import express from "express";
import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { Company } from "../db/entities/Company.js";
import { JournalEntry } from "../db/entities/JournalEntry.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { STATIC_TOOLS } from "../mcp/toolManifest.js";
import { serveOpenCodeTools } from "../services/agent/opencodeMcp.js";
import { loadGenosynTools } from "../services/agent/tools/genosyn.js";
import { RESIDENT_GENOSYN_TOOLS } from "../services/agent/tools/index.js";
import { residentOnlyRegistry } from "../services/agent/tools/toolRegistry.js";
import { issueMcpToken, revokeMcpToken } from "../services/mcpTokens.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { mcpInternalRouter } from "./mcpInternal.js";

let server: Server;
let baseUrl: string;
let employee: AIEmployee;
let token: string;
const originalPort = config.port;

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use("/api/internal/mcp", mcpInternalRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  Object.assign(config, { port: (server.address() as AddressInfo).port });
  baseUrl = `http://127.0.0.1:${config.port}/api/internal/mcp`;
});

after(async () => {
  if (token) revokeMcpToken(token);
  Object.assign(config, { port: originalPort });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeTestDb();
});

beforeEach(async () => {
  if (token) revokeMcpToken(token);
  await resetTestDb();
  const owner = await insert(User, { email: "owner@example.test", name: "Owner", passwordHash: "x" });
  const company = await insert(Company, { name: "Acme", slug: "acme", ownerId: owner.id });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Jamie",
    slug: "jamie",
    role: "Analyst",
    soulBody: "",
  });
  token = issueMcpToken(employee.id, company.id, { authority: "employee" });
});

async function writeJournal(args: unknown) {
  const response = await fetch(`${baseUrl}/tools/add_journal_entry`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(args),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function journalTool() {
  const { tools } = await loadGenosynTools(token);
  const tool = tools.find((candidate) => candidate.name === "add_journal_entry");
  assert.ok(tool);
  return tool;
}

const expectedSchema = {
  type: "object",
  properties: {
    title: { type: "string", minLength: 1, maxLength: 200 },
    body: { type: "string", maxLength: 10_000 },
  },
  required: ["title"],
  additionalProperties: false,
};

test("the resident Journal schema advertises the endpoint's existing title and body limits", async () => {
  const manifest = STATIC_TOOLS.find((tool) => tool.name === "add_journal_entry");
  assert.ok(manifest);
  assert.deepEqual(manifest.inputSchema, expectedSchema);
  assert.ok(RESIDENT_GENOSYN_TOOLS.includes("add_journal_entry"));
  assert.deepEqual((await journalTool()).inputSchema, expectedSchema);
});

test("OpenCode receives the Journal bounds unchanged through MCP tools/list", async () => {
  const endpoint = await serveOpenCodeTools({
    registry: residentOnlyRegistry([await journalTool()]),
  });
  const client = new Client({ name: "journal-schema-regression", version: "1" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(endpoint.url), {
        requestInit: { headers: { Authorization: `Bearer ${endpoint.token}` } },
      }),
    );
    const { tools } = await client.listTools();
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, "add_journal_entry");
    assert.deepEqual(tools[0].inputSchema, expectedSchema);
  } finally {
    await client.close();
    await endpoint.close();
  }
});

test("the advertised maximum title and body persist without truncation", async () => {
  const title = "T".repeat(200);
  const body = 'Evidence: "quoted" \\ source\n'.repeat(400).slice(0, 10_000);
  assert.equal(body.length, 10_000);
  const response = await writeJournal({ title, body });
  assert.equal(response.status, 200);
  const rows = await AppDataSource.getRepository(JournalEntry).find();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].employeeId, employee.id);
  assert.equal(rows[0].title, title);
  assert.equal(rows[0].body, body);
  const effects = await AppDataSource.getRepository(AuditEvent).findBy({ action: "journal.create" });
  assert.equal(effects.length, 1);
  assert.equal(effects[0].targetId, rows[0].id);
});

test("a one-character title accepts an omitted or empty body", async () => {
  for (const args of [{ title: "A" }, { title: "B", body: "" }]) {
    assert.equal((await writeJournal(args)).status, 200);
  }
  const rows = await AppDataSource.getRepository(JournalEntry).find();
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.body === "" && row.employeeId === employee.id));
});

for (const [label, args] of [
  ["missing", { body: "A bounded summary." }],
  ["empty", { title: "", body: "A bounded summary." }],
  ["over 200 characters", { title: "T".repeat(201), body: "A bounded summary." }],
] as const) {
  test(`a Journal title that is ${label} is rejected without appending evidence`, async () => {
    const response = await writeJournal(args);
    assert.equal(response.status, 400);
    assert.equal(response.body.error, "ValidationError");
    assert.equal(await AppDataSource.getRepository(JournalEntry).count(), 0);
    assert.equal(await AppDataSource.getRepository(AuditEvent).countBy({ action: "journal.create" }), 0);
  });
}

test("an oversized body reports its bound and a compact retry appends exactly once", async () => {
  const tool = await journalTool();
  const rejected = await tool.run({ title: "Batch evidence", body: "x".repeat(10_001) });
  assert.equal(rejected.isError, true);
  assert.match(rejected.content, /body: String must contain at most 10000 character/);
  assert.equal(await AppDataSource.getRepository(JournalEntry).count(), 0);
  assert.equal(await AppDataSource.getRepository(AuditEvent).countBy({ action: "journal.create" }), 0);

  const body = "x".repeat(10_000);
  const accepted = await tool.run({ title: "Batch evidence", body });
  assert.notEqual(accepted.isError, true);
  const rows = await AppDataSource.getRepository(JournalEntry).find();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].body, body);
  assert.equal(await AppDataSource.getRepository(AuditEvent).countBy({ action: "journal.create" }), 1);
});
