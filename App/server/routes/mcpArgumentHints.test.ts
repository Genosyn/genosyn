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
import { loadGenosynTools } from "../services/agent/tools/genosyn.js";
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
