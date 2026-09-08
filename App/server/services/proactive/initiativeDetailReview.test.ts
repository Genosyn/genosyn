import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { after, before, beforeEach, test } from "node:test";
import express from "express";
import { AppDataSource } from "../../db/datasource.js";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import { Company } from "../../db/entities/Company.js";
import { Initiative } from "../../db/entities/Initiative.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../../test/dbHarness.js";
import { errorHandler } from "../../middleware/error.js";
import { mcpInternalRouter } from "../../routes/mcpInternal.js";
import { issueMcpToken, revokeMcpToken } from "../mcpTokens.js";
import { serializeInitiative } from "../initiatives.js";
import { redactApprovalSummary } from "../approvalRedaction.js";
import {
  getInitiativeDetailReview,
  INITIATIVE_DETAIL_SECTIONS,
  InitiativeDetailReviewError,
} from "./initiativeReview.js";

let companyId: string;
let employee: AIEmployee;
let initiative: Initiative;
let server: Server;
let baseUrl: string;
let token = "";
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
    name: "Review QA",
    slug: randomUUID(),
    ownerId: randomUUID(),
  });
  companyId = company.id;
  employee = await insert(AIEmployee, {
    companyId,
    name: "Reviewer",
    slug: randomUUID(),
    role: "Operations",
  });
  initiative = await insert(Initiative, {
    companyId,
    employeeId: employee.id,
    title: "Prepare weekly evidence",
    evidence: "Three reports reused the same source.",
    proposal: "Collect the source each week.",
    routineSpecJson: JSON.stringify({
      name: "Read weekly sources",
      cronExpr: "0 9 * * 1",
      body: "Read the source and prepare a report.",
      acceptanceCriteria: "The report includes a source.",
    }),
    status: "declined",
    reviewNote: "Keep the existing review step.",
    decidedAt: new Date(),
  });
  token = issueMcpToken(employee.id, companyId, { authority: "employee" });
});
const read = (options: Parameters<typeof getInitiativeDetailReview>[2] = {}) =>
  getInitiativeDetailReview(companyId, initiative.id, options);

async function large() {
  const escaped = '\\"\n\u0001🧭 Evidence with a source. '.repeat(400);
  await AppDataSource.getRepository(Initiative).update(initiative.id, {
    evidence: escaped,
    proposal: escaped,
    reviewNote: escaped,
    routineSpecJson: JSON.stringify({
      name: "Bounded report",
      cronExpr: "0 9 * * 1",
      body: escaped,
      acceptanceCriteria: escaped,
    }),
  });
  return escaped;
}

test("short details preserve the complete existing response shape and perform no writes", async () => {
  const before = await AppDataSource.getRepository(Initiative).findOneByOrFail({
    id: initiative.id,
  });
  assert.deepEqual(await read(), { initiative: serializeInitiative(before) });
  assert.deepEqual(
    await AppDataSource.getRepository(Initiative).findOneByOrFail({ id: initiative.id }),
    before,
  );
});

test("large defaults mark excerpts and fit the exact pretty-JSON transport budget", async () => {
  await large();
  const result = await read();
  assert.ok("initiative" in result && "truncatedFields" in result);
  assert.ok(JSON.stringify(result, null, 2).length <= 7500);
  assert.ok(Array.isArray(result.truncatedFields));
  for (const field of INITIATIVE_DETAIL_SECTIONS) assert.ok(result.truncatedFields.includes(field));
  assert.ok(
    "pagination" in result && result.pagination !== null && typeof result.pagination === "object",
  );
  assert.ok("sections" in result.pagination);
  assert.deepEqual(result.pagination.sections, INITIATIVE_DETAIL_SECTIONS);
  assert.equal(result.initiative.status, "declined");
  assert.match(result.initiative.reviewNote, /…$/);
});

test("every section reconstructs its full redacted text with stable hashes and bounded escaped chunks", async () => {
  await large();
  const stored = serializeInitiative(
    await AppDataSource.getRepository(Initiative).findOneByOrFail({ id: initiative.id }),
  );
  const expected = {
    evidence: stored.evidence,
    proposal: stored.proposal,
    routineBody: stored.routineSpec!.body,
    acceptanceCriteria: stored.routineSpec!.acceptanceCriteria!,
    reviewNote: stored.reviewNote,
  };
  for (const section of INITIATIVE_DETAIL_SECTIONS) {
    let offset: number | null = 0;
    let hash: string | undefined;
    const chunks: string[] = [];
    while (offset !== null) {
      const chunk = await read({ section, offset });
      assert.ok("section" in chunk);
      assert.equal(chunk.section, section);
      assert.equal(chunk.offset, offset);
      assert.equal(chunk.initiativeId, initiative.id);
      assert.equal(chunk.status, "declined");
      assert.ok(chunk.text.length <= 4000);
      assert.ok(JSON.stringify(chunk, null, 2).length <= 7500);
      assert.doesNotMatch(chunk.text, /[\uD800-\uDBFF]$/);
      hash ??= chunk.hash;
      assert.equal(chunk.hash, hash);
      chunks.push(chunk.text);
      offset = chunk.nextOffset;
    }
    assert.equal(chunks.join(""), redactApprovalSummary(expected[section]));
  }
});

test("credentials are redacted before clipping and changing source text changes its hash", async () => {
  await AppDataSource.getRepository(Initiative).update(initiative.id, {
    reviewNote:
      "Review context. ".repeat(300) +
      "\napi_key=private-initiative-secret-123456789\nMore context.",
  });
  const first = await read({ section: "reviewNote" });
  assert.ok("section" in first);
  const second = await read({ section: "reviewNote", offset: first.nextOffset! });
  assert.ok("section" in second);
  assert.doesNotMatch(JSON.stringify(second), /private-initiative-secret/);
  assert.doesNotMatch(JSON.stringify(await read()), /private-initiative-secret/);
  await AppDataSource.getRepository(Initiative).update(initiative.id, {
    reviewNote: "Changed feedback.",
  });
  const changed = await read({ section: "reviewNote" });
  assert.ok("section" in changed);
  assert.notEqual(changed.hash, first.hash);
});

test("every continuation rechecks company scope and missing/deleted records return 404", async () => {
  await large();
  const first = await read({ section: "evidence" });
  assert.ok("section" in first);
  await AppDataSource.getRepository(Initiative).update(initiative.id, { companyId: randomUUID() });
  await assert.rejects(
    read({ section: "evidence", offset: first.nextOffset! }),
    (error) => error instanceof InitiativeDetailReviewError && error.status === 404,
  );
  await assert.rejects(
    getInitiativeDetailReview(companyId, "invalid"),
    InitiativeDetailReviewError,
  );
  await AppDataSource.getRepository(Initiative).delete(initiative.id);
  await assert.rejects(read(), InitiativeDetailReviewError);
});

test("invalid offsets and malformed Routine sections are explicit client errors", async () => {
  for (const offset of [-1, 0.5, NaN, 999999])
    await assert.rejects(
      read({ section: "evidence", offset }),
      (error) => error instanceof InitiativeDetailReviewError && error.status === 400,
    );
  await assert.rejects(
    read({ offset: 1 }),
    (error) => error instanceof InitiativeDetailReviewError && error.status === 400,
  );
  await AppDataSource.getRepository(Initiative).update(initiative.id, {
    routineSpecJson: "{broken",
  });
  await assert.rejects(
    read({ section: "routineBody" }),
    (error) => error instanceof InitiativeDetailReviewError && error.status === 400,
  );
});

test("real callback responds to missing records, invalid sections/offsets and revoked tokens without hanging", async () => {
  const request = async (args: unknown) => {
    const response = await fetch(`${baseUrl}/internal/mcp/tools/get_initiative`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(5000),
    });
    return { status: response.status, body: await response.json() };
  };
  const full = await request({ initiativeId: initiative.id });
  assert.equal(full.status, 200);
  assert.deepEqual(full.body, { initiative: serializeInitiative(initiative) });
  assert.equal(
    (await request({ initiativeId: initiative.id, section: "reviewNote", offset: 999999 })).status,
    400,
  );
  assert.equal((await request({ initiativeId: initiative.id, section: "unknown" })).status, 400);
  assert.equal(
    (await request({ initiativeId: initiative.id, employeeId: randomUUID() })).status,
    400,
  );
  assert.equal((await request({ initiativeId: randomUUID() })).status, 404);
  await large();
  const chunk = await request({ initiativeId: initiative.id, section: "reviewNote", offset: 0 });
  assert.equal(chunk.status, 200);
  assert.ok(JSON.stringify(chunk.body, null, 2).length <= 7500);
  revokeMcpToken(token);
  assert.equal(
    (await request({ initiativeId: initiative.id, section: "reviewNote", offset: 0 })).status,
    401,
  );
});
