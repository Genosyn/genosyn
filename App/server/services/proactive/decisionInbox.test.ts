import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import express from "express";
import { AppDataSource } from "../../db/datasource.js";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import { Company } from "../../db/entities/Company.js";
import { Decision } from "../../db/entities/Decision.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../../test/dbHarness.js";
import { errorHandler } from "../../middleware/error.js";
import { mcpInternalRouter } from "../../routes/mcpInternal.js";
import { STATIC_TOOLS } from "../../mcp/toolManifest.js";
import { issueMcpToken, revokeMcpToken } from "../mcpTokens.js";
import { redactSensitiveText } from "../approvalRedaction.js";
import { TOOL_DOMAINS, TOOL_KEYWORDS } from "../agent/tools/toolIndex.js";
import { RESIDENT_GENOSYN_TOOLS } from "../agent/tools/index.js";
import {
  DecisionReaderError,
  getEmployeeDecisionInbox,
  getEmployeeDecisionDetail,
} from "./decisionInbox.js";

let companyId: string;
let employee: AIEmployee;
let other: AIEmployee;
let token = "";
let server: Server;
let baseUrl: string;
before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use("/internal/mcp", mcpInternalRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  if (token) revokeMcpToken(token);
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await closeTestDb();
});
beforeEach(async () => {
  if (token) revokeMcpToken(token);
  await resetTestDb();
  const company = await insert(Company, {
    name: "Decision QA",
    slug: randomUUID(),
    ownerId: randomUUID(),
  });
  companyId = company.id;
  employee = await insert(AIEmployee, {
    companyId,
    name: "Reader",
    slug: randomUUID(),
    role: "Operations",
  });
  other = await insert(AIEmployee, {
    companyId,
    name: "Other",
    slug: randomUUID(),
    role: "Operations",
  });
  token = issueMcpToken(employee.id, companyId, { authority: "employee" });
});
const add = (values: Partial<Decision> = {}) =>
  insert(Decision, {
    companyId,
    employeeId: employee.id,
    title: "Choose the next step",
    body: "Read the current evidence.",
    optionsJson: JSON.stringify([
      { id: "proceed", label: "Proceed", detail: "Retain the review step.", tone: "neutral" },
    ]),
    ...values,
  });
const inbox = (options: Partial<Parameters<typeof getEmployeeDecisionInbox>[0]> = {}) =>
  getEmployeeDecisionInbox({ companyId, employeeId: employee.id, ...options });
const detail = (
  decisionId: string,
  options: Partial<Parameters<typeof getEmployeeDecisionDetail>[0]> = {},
) => getEmployeeDecisionDetail({ companyId, employeeId: employee.id, decisionId, ...options });
async function tool(name: string, args: unknown = {}) {
  const response = await fetch(`${baseUrl}/internal/mcp/tools/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(5000),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

test("raised remains the default and assigned access ends at answer, rerouting or expiry", async () => {
  const own = await add({
    status: "decided",
    note: "Keep the existing scope.",
    chosenOptionId: "proceed",
    chosenOptionLabel: "Proceed",
  });
  const assigned = await add({ employeeId: other.id, routedToEmployeeId: employee.id });
  const unrelated = await add({ employeeId: other.id });
  assert.deepEqual(
    (await inbox()).decisions.map((row) => row.id),
    [own.id],
  );
  assert.deepEqual(
    (await inbox({ direction: "assigned" })).decisions.map((row) => row.id),
    [assigned.id],
  );
  assert.equal((await inbox({ direction: "both" })).decisions.length, 2);
  const ownDetail = await detail(own.id);
  assert.ok("decision" in ownDetail && ownDetail.decision);
  assert.equal(ownDetail.decision.note, "Keep the existing scope.");
  await detail(assigned.id);
  await assert.rejects(detail(unrelated.id), DecisionReaderError);
  for (const change of [
    { status: "decided" as const },
    { status: "pending" as const, routedToEmployeeId: other.id },
    { routedToEmployeeId: employee.id, expiresAt: new Date(Date.now() - 1000) },
  ]) {
    await AppDataSource.getRepository(Decision).update(assigned.id, change);
    await assert.rejects(detail(assigned.id), DecisionReaderError);
  }
});

test("bounded list pagination visits every eligible Decision without losing long human notes", async () => {
  const ids: string[] = [];
  const text = '\\"\n\u0001🧭 Feedback. '.repeat(350);
  for (let index = 0; index < 12; index++)
    ids.push(
      (
        await add({
          status: "decided",
          note: text,
          body: text,
          createdAt: new Date(2025, 0, index + 1),
        })
      ).id,
    );
  const seen: string[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const result = await inbox({ offset, limit: 20 });
    assert.ok(JSON.stringify(result, null, 2).length <= 7500);
    assert.ok(result.decisions.length > 0);
    for (const row of result.decisions) {
      assert.equal(row.noteTruncated, true);
      seen.push(row.id);
    }
    offset = result.nextOffset;
  }
  assert.equal(new Set(seen).size, 12);
  assert.deepEqual(seen, ids.reverse());
  const oldest = await detail(seen.at(-1)!, { section: "note" });
  assert.ok("text" in oldest && typeof oldest.text === "string");
  assert.ok(oldest.text.length > 0);
});

test("full context, option detail and answer notes reconstruct with stable hashes below the JSON budget", async () => {
  const text = '\\"\n\u0001🧭 Evidence. '.repeat(600);
  const decision = await add({
    body: text,
    note: text,
    optionsJson: JSON.stringify([
      { id: "choice", label: "Keep the scope", detail: text, tone: "neutral" },
    ]),
  });
  for (const section of ["context", "optionDetail", "note"] as const) {
    const chunks: string[] = [];
    let offset: number | null = 0;
    let hash: string | undefined;
    while (offset !== null) {
      const result = await detail(decision.id, {
        section,
        offset,
        ...(section === "optionDetail" ? { optionId: "choice" } : {}),
      });
      assert.ok(
        "text" in result && typeof result.text === "string" && typeof result.hash === "string",
      );
      assert.ok(JSON.stringify(result, null, 2).length <= 7500);
      assert.ok(result.text.length <= 4000);
      assert.doesNotMatch(result.text, /[\uD800-\uDBFF]$/);
      hash ??= result.hash;
      assert.equal(result.hash, hash);
      chunks.push(result.text);
      assert.ok(result.nextOffset === null || typeof result.nextOffset === "number");
      offset = result.nextOffset;
    }
    assert.equal(chunks.join(""), text);
  }
});

test("redaction precedes slicing and source edits change hashes", async () => {
  const text = "Context. ".repeat(700) + "\napi_key=private-decision-secret-123456789\nEnd.";
  const decision = await add({ body: text, note: "api_key=private-feedback-secret-123456789" });
  const first = await detail(decision.id, { section: "context" });
  assert.ok("hash" in first && typeof first.hash === "string");
  const second = await detail(decision.id, { section: "context", offset: 4000 });
  assert.doesNotMatch(JSON.stringify(second), /private-decision-secret/);
  assert.doesNotMatch(JSON.stringify(await inbox()), /private-feedback-secret/);
  assert.equal(redactSensitiveText(text).includes("private-decision-secret"), false);
  await AppDataSource.getRepository(Decision).update(decision.id, { body: "Changed context." });
  const changed = await detail(decision.id, { section: "context" });
  assert.ok("hash" in changed);
  assert.notEqual(changed.hash, first.hash);
});

test("every chunk rechecks company, current routing and employee existence", async () => {
  const decision = await add({
    employeeId: other.id,
    routedToEmployeeId: employee.id,
    body: "Context. ".repeat(1000),
  });
  await detail(decision.id, { section: "context" });
  await AppDataSource.getRepository(Decision).update(decision.id, { routedToEmployeeId: null });
  await assert.rejects(
    detail(decision.id, { section: "context", offset: 4000 }),
    DecisionReaderError,
  );
  await AppDataSource.getRepository(Decision).update(decision.id, {
    routedToEmployeeId: employee.id,
    companyId: randomUUID(),
  });
  await assert.rejects(detail(decision.id), DecisionReaderError);
  await assert.rejects(detail("invalid"), DecisionReaderError);
  await AppDataSource.getRepository(AIEmployee).delete(employee.id);
  await assert.rejects(inbox(), DecisionReaderError);
});

test("single large choice metadata remains bounded and invalid offsets/options are explicit errors", async () => {
  const text = '\\"\u0001'.repeat(100);
  const decision = await add({
    title: text,
    body: text,
    note: text,
    optionsJson: JSON.stringify(
      Array.from({ length: 6 }, (_, index) => ({
        id: `choice-${index}`,
        label: text,
        detail: text,
        tone: "neutral",
      })),
    ),
  });
  assert.ok(JSON.stringify(await inbox(), null, 2).length <= 7500);
  assert.ok(JSON.stringify(await detail(decision.id), null, 2).length <= 7500);
  for (const offset of [-1, 0.5, NaN, 999999])
    await assert.rejects(
      detail(decision.id, { section: "context", offset }),
      (error) => error instanceof DecisionReaderError && error.status === 400,
    );
  await assert.rejects(
    detail(decision.id, { section: "optionDetail", optionId: "missing" }),
    DecisionReaderError,
  );
  await assert.rejects(detail(decision.id, { offset: 1 }), DecisionReaderError);
});

test("new granular reader is deferred and real HTTP failures terminate without expanding scope", async () => {
  assert.ok(STATIC_TOOLS.some((row) => row.name === "get_decision"));
  assert.ok(Object.values(TOOL_DOMAINS).some((row) => row.tools.includes("get_decision")));
  assert.ok(TOOL_KEYWORDS.get_decision.length > 0);
  assert.ok(!(RESIDENT_GENOSYN_TOOLS as readonly string[]).includes("get_decision"));
  const decision = await add({ status: "decided", note: "Preserve the original scope." });
  const result = await tool("get_decision", { decisionId: decision.id });
  assert.equal(result.status, 200);
  assert.equal((await tool("get_decision", { decisionId: randomUUID() })).status, 404);
  assert.equal(
    (await tool("get_decision", { decisionId: decision.id, section: "note", offset: 999999 }))
      .status,
    400,
  );
  assert.equal(
    (await tool("get_decision", { decisionId: decision.id, employeeId: other.id })).status,
    400,
  );
  assert.equal((await tool("list_decisions", { offset: 0, limit: 1 })).status, 200);
  assert.equal((await tool("list_decisions", { offset: -1 })).status, 400);
  revokeMcpToken(token);
  assert.equal((await tool("get_decision", { decisionId: decision.id })).status, 401);
});
