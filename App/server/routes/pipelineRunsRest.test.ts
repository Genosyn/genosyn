import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";

import { createApp } from "../app.js";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import type { Company } from "../db/entities/Company.js";
import { Pipeline } from "../db/entities/Pipeline.js";
import { PipelineRun } from "../db/entities/PipelineRun.js";
import type { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { buildOpenApiDocument } from "../openapi/spec.js";
import { CURSOR_OTHER_FILTERS } from "../services/listPaging.js";
import { issueMcpToken, revokeMcpToken } from "../services/mcpTokens.js";
import {
  createMemberOfNewCompany,
  mintTestApiKey,
  withTestInstanceSecrets,
} from "../test/apiAccess.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";

/**
 * `GET /pipelines/:idOrSlug/runs` with a real API key, end to end through
 * `createApp()`: without `limit` or `cursor` it still answers the newest 50 Runs
 * as the plain array the Pipelines page reads; with either it pages the whole
 * history from the very function `list_pipeline_runs` reads, so a cursor from
 * one continues the other. The API reference documents the filters and the
 * page.
 */

const app = createApp();
app.use(errorHandler);
let server: Server;
let baseUrl = "";
let restoreSecrets: () => void;

before(async () => {
  restoreSecrets = withTestInstanceSecrets();
  await initTestDb();
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
  restoreSecrets();
});

let company: Company;
let owner: User;
let ownerKey: string;
let billing: Pipeline;
let runs: PipelineRun[];

beforeEach(async () => {
  await resetTestDb();
  ({ user: owner, company } = await createMemberOfNewCompany("owner"));
  ownerKey = (await mintTestApiKey(owner.id, company.id)).token;
  billing = await insert(Pipeline, {
    companyId: company.id,
    name: "Billing",
    slug: "billing",
    description: "",
    enabled: true,
    graphJson: JSON.stringify({
      nodes: [{ id: "t", type: "trigger.webhook", x: 0, y: 0, config: {} }],
      edges: [],
    }),
  });
  const at = new Date("2026-01-10T08:00:00.000Z");
  const rows = Array.from({ length: 130 }, (_, index) => ({
    id: randomUUID(),
    pipelineId: billing.id,
    // Four Runs to an instant: a boundary always falls inside a tie.
    startedAt: new Date(at.getTime() + Math.floor(index / 4) * 3_600_000),
    finishedAt: null,
    status: (index % 5 === 0 ? "failed" : "completed") as PipelineRun["status"],
    triggerKind: (index % 2 ? "schedule" : "webhook") as PipelineRun["triggerKind"],
    triggerNodeId: "t",
    inputJson: "{}",
    outputJson: "{}",
    logContent: "log",
    errorMessage: index % 5 === 0 ? "boom" : null,
  }));
  await AppDataSource.getRepository(PipelineRun).insert(rows.map((row) => ({ ...row })));
  runs = await AppDataSource.getRepository(PipelineRun).find({ where: { pipelineId: billing.id } });
});

async function get(path: string, token = ownerKey, companyId = company.id) {
  const response = await fetch(`${baseUrl}/api/companies/${companyId}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown> & { error?: string },
  };
}

function newestFirst(a: PipelineRun, b: PipelineRun) {
  return b.startedAt.getTime() - a.startedAt.getTime() || (a.id < b.id ? 1 : -1);
}

test("without limit or cursor it answers the newest 50 as a plain array, as before", async () => {
  const response = await get("/pipelines/billing/runs");
  assert.equal(response.status, 200);
  assert.ok(Array.isArray(response.body));
  const rows = response.body as unknown as Array<Record<string, unknown>>;
  assert.equal(rows.length, 50);
  assert.deepEqual(
    rows.map((row) => row.id),
    [...runs].sort(newestFirst).slice(0, 50).map((run) => run.id),
  );
  assert.deepEqual(Object.keys(rows[0]).sort(), [
    "errorMessage",
    "finishedAt",
    "id",
    "pipelineId",
    "startedAt",
    "status",
    "triggerKind",
    "triggerLabel",
    "triggerNodeId",
  ]);
  // The filters apply to the plain answer too.
  const failed = (await get("/pipelines/billing/runs?status=failed")).body as unknown as Array<{
    status: string;
  }>;
  assert.equal(failed.length, 26);
  assert.ok(failed.every((row) => row.status === "failed"));
});

test("with limit it pages the whole history once, ties included, and filters like the tool", async () => {
  const seen: string[] = [];
  let cursor = "";
  for (let guard = 0; guard < 50; guard++) {
    const page = await get(`/pipelines/${billing.id}/runs?limit=17${cursor ? `&cursor=${cursor}` : ""}`);
    assert.equal(page.status, 200, page.body.error);
    assert.equal(page.body.total, 130);
    seen.push(...(page.body.runs as Array<{ id: string }>).map((row) => row.id));
    if (!page.body.hasMore) break;
    assert.match(String(page.body.note), /nextCursor/);
    cursor = page.body.nextCursor as string;
  }
  assert.deepEqual(seen, [...runs].sort(newestFirst).map((run) => run.id));

  const webhookFailures = await get(
    "/pipelines/billing/runs?status=failed&triggerKind=webhook&from=2026-01-11&limit=200",
  );
  const expected = runs.filter(
    (run) =>
      run.status === "failed" &&
      run.triggerKind === "webhook" &&
      run.startedAt.toISOString().slice(0, 10) >= "2026-01-11",
  );
  assert.equal(webhookFailures.body.total, expected.length);
  assert.deepEqual(
    (webhookFailures.body.runs as Array<{ id: string }>).map((row) => row.id).sort(),
    expected.map((run) => run.id).sort(),
  );

  const clamped = await get("/pipelines/billing/runs?limit=5000");
  assert.equal((clamped.body.runs as unknown[]).length, 130, "cut to 200, of which 130 exist");
  const backwards = await get("/pipelines/billing/runs?from=2026-02-01&to=2026-01-01");
  assert.equal(backwards.status, 400);
});

test("the tool and the route are one list: the same pages, and cursors carry over", async () => {
  const employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Jamie",
    slug: "jamie",
    role: "Operator",
    soulBody: "",
  });
  const mcp = issueMcpToken(employee.id, company.id, { authority: "employee" });
  try {
    const tool = await fetch(`${baseUrl}/api/internal/mcp/tools/list_pipeline_runs`, {
      method: "POST",
      headers: { authorization: `Bearer ${mcp}`, "content-type": "application/json" },
      body: JSON.stringify({ pipelineId: "billing", status: "completed", limit: 25 }),
    });
    const fromTool = (await tool.json()) as {
      runs: Array<{ id: string }>;
      total: number;
      nextCursor: string;
    };
    const fromRest = await get("/pipelines/billing/runs?status=completed&limit=25");
    assert.deepEqual(
      (fromRest.body.runs as Array<{ id: string }>).map((row) => row.id),
      fromTool.runs.map((row) => row.id),
    );
    assert.equal(fromRest.body.total, fromTool.total);
    const next = await get(`/pipelines/billing/runs?status=completed&limit=25&cursor=${fromTool.nextCursor}`);
    assert.equal(next.status, 200, next.body.error);
    const toolNext = await fetch(`${baseUrl}/api/internal/mcp/tools/list_pipeline_runs`, {
      method: "POST",
      headers: { authorization: `Bearer ${mcp}`, "content-type": "application/json" },
      body: JSON.stringify({
        pipelineId: billing.id,
        status: "completed",
        limit: 25,
        cursor: fromRest.body.nextCursor,
      }),
    });
    const toolSecond = (await toolNext.json()) as { runs: Array<{ id: string }> };
    assert.deepEqual(
      toolSecond.runs.map((row) => row.id),
      (next.body.runs as Array<{ id: string }>).map((row) => row.id),
    );
    const otherFilters = await get(`/pipelines/billing/runs?limit=25&cursor=${fromTool.nextCursor}`);
    assert.equal(otherFilters.status, 400);
    assert.equal(otherFilters.body.error, CURSOR_OTHER_FILTERS);
  } finally {
    revokeMcpToken(mcp);
  }
});

test("another company's key reads none of it, and its own Pipelines' cursors stay its own", async () => {
  const { user, company: theirs } = await createMemberOfNewCompany("owner");
  const theirKey = (await mintTestApiKey(user.id, theirs.id)).token;
  const refused = await get("/pipelines/billing/runs?limit=5", theirKey);
  assert.notEqual(refused.status, 200);
  const notTheirs = await get("/pipelines/billing/runs?limit=5", theirKey, theirs.id);
  assert.equal(notTheirs.status, 404);
  const mine = await get("/pipelines/billing/runs?limit=5");
  await insert(Pipeline, {
    companyId: theirs.id,
    name: "Billing",
    slug: "billing",
    description: "",
    enabled: true,
    graphJson: '{"nodes":[],"edges":[]}',
  });
  const reused = await get(`/pipelines/billing/runs?limit=5&cursor=${mine.body.nextCursor}`, theirKey, theirs.id);
  assert.equal(reused.status, 400, "a cursor is bound to its company and Pipeline");
});

test("the API reference documents the filters and the page", () => {
  const document = buildOpenApiDocument(app) as unknown as {
    paths: Record<string, Record<string, { parameters?: Array<{ name: string }>; description?: string }>>;
  };
  const operation = document.paths["/api/companies/{cid}/pipelines/{idOrSlug}/runs"]?.get;
  assert.ok(operation, "documented");
  const names = (operation.parameters ?? []).map((parameter) => parameter.name);
  for (const filter of ["status", "triggerKind", "from", "to", "limit", "cursor"]) {
    assert.ok(names.includes(filter), `documents ${filter}`);
  }
  assert.match(operation.description ?? "", /nextCursor/);
});
