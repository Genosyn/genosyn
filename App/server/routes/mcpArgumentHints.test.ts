import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import express from "express";
import { config } from "../../config.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { Routine } from "../db/entities/Routine.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import {
  formatIssues,
  loadGenosynTools,
  withArgumentHint,
} from "../services/agent/tools/genosyn.js";
import type { AgentTool } from "../services/agent/types.js";
import { issueMcpToken, revokeMcpToken } from "../services/mcpTokens.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { mcpInternalRouter } from "./mcpInternal.js";

let server: Server;
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
  const owner = await insert(User, {
    email: "owner@example.test",
    name: "Owner",
    passwordHash: "x",
  });
  const company = await insert(Company, { name: "Acme", slug: "acme", ownerId: owner.id });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Jamie",
    slug: "jamie",
    role: "Community",
    soulBody: "",
  });
  token = issueMcpToken(employee.id, company.id, { authority: "employee" });
});

async function tool(name: string): Promise<AgentTool> {
  const { tools } = await loadGenosynTools(token);
  const found = tools.find((candidate) => candidate.name === name);
  assert.ok(found, `${name} is a Genosyn tool`);
  return found;
}

// 2026-10-01: a Qwen Run called list_journal with {"query":"Nostr"} and
// another called get_routine with {"query":"Daily Reddit Community Help"};
// each then spent a find_tools step to learn the arguments.
test("an unknown argument is answered with the arguments the tool accepts", async () => {
  const result = await (await tool("list_journal")).run({ query: "Nostr" });
  assert.equal(result.isError, true);
  assert.match(result.content, /Unrecognized key\(s\) in object: 'query'/);
  assert.match(result.content, /Accepted arguments: employeeSlug, limit, since, before, cursor\.$/);
});

test("a missing required argument marks which accepted argument is required", async () => {
  await insert(Routine, {
    employeeId: employee.id,
    name: "Daily Reddit Community Help",
    slug: "daily-reddit-community-help",
    cronExpr: "0 11 * * *",
    body: "Help people on Reddit.",
  });
  const getRoutine = await tool("get_routine");
  const rejected = await getRoutine.run({ query: "Daily Reddit Community Help" });
  assert.equal(rejected.isError, true);
  assert.match(rejected.content, /routineId: Required/);
  assert.match(rejected.content, /Accepted arguments: routineId \(required\), employeeSlug\./);

  const retried = await getRoutine.run({ routineId: "Daily Reddit Community Help" });
  assert.notEqual(retried.isError, true, retried.content);
  assert.match(retried.content, /Help people on Reddit\./);
});

test("a rejected value keeps its own message without an argument list", async () => {
  const result = await (await tool("list_journal")).run({ limit: 500 });
  assert.equal(result.isError, true);
  assert.match(result.content, /limit: Number must be less than or equal to 200/);
  assert.doesNotMatch(result.content, /Accepted arguments/);
});

// 2026-10-02: a Qwen audit Run passed get_workstream {"workstreamId":"f66c733f"}
// and get_repository_work_session {"sessionId":"4835a9ff"}, the first eight
// characters its own earlier notes had kept of each id.
test("a shortened id is answered with how to pass the full one", async () => {
  const result = await (await tool("get_workstream")).run({ workstreamId: "f66c733f" });
  assert.equal(result.isError, true);
  assert.match(
    result.content,
    /workstreamId: Invalid uuid \('f66c733f' is only the start of an id; pass the full 36-character id/,
  );
});

test("an id run together with other text is answered with the id inside it", () => {
  const issues = {
    issues: [
      { validation: "uuid", code: "invalid_string", message: "Invalid uuid", path: ["sessionId"] },
      { validation: "uuid", code: "invalid_string", message: "Invalid uuid", path: ["refs", 1] },
      { code: "invalid_type", message: "Required", path: ["limit"] },
    ],
  };
  assert.equal(
    formatIssues(issues, {
      sessionId: "session4835a9ff-d834-4e5d-9a7c-50005101547f",
      refs: ["ok", "Jamie's note"],
    }),
    " — sessionId: Invalid uuid (the id inside it is 4835a9ff-d834-4e5d-9a7c-50005101547f); " +
      "refs.1: Invalid uuid; limit: Required",
  );
});

const describeTable = {
  type: "object",
  properties: {
    schema: { type: "string", description: "Schema. Defaults to 'public'." },
    table: { type: "string", description: "Table name." },
  },
  required: ["table"],
};

// 2026-10-02: an enterprise prospecting Run called a Postgres Connection's
// describe_table with tableName and its query tool with query; the provider
// answered "table is required" and "sql is required" in its own words.
test("a failed integration call that guessed an argument lists the accepted ones", () => {
  const failed = withArgumentHint({ tableName: "Project" }, describeTable, {
    content: "table is required",
    isError: true,
  });
  assert.equal(failed.content, "table is required Accepted arguments: schema, table (required).");
  assert.equal(failed.isError, true);
});

test("an argument hint is added only to a failed call that guessed an argument", () => {
  const rejectedValue = { content: 'relation "Project" does not exist', isError: true };
  assert.deepEqual(
    withArgumentHint({ table: "Project" }, describeTable, rejectedValue),
    rejectedValue,
  );
  const succeeded = { content: "columns: id, name" };
  assert.deepEqual(withArgumentHint({ tableName: "Project" }, describeTable, succeeded), succeeded);
  const unknownSchema = { content: "failed", isError: true };
  assert.deepEqual(
    withArgumentHint({ tableName: "Project" }, { type: "object" }, unknownSchema),
    unknownSchema,
  );
  assert.equal(
    withArgumentHint(
      { limit: 5 },
      { type: "object", properties: {} },
      { content: "failed", isError: true },
    ).content,
    "failed This tool takes no arguments.",
  );
});
