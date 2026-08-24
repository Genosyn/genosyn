import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Base } from "../db/entities/Base.js";
import { BaseTable } from "../db/entities/BaseTable.js";
import { Channel } from "../db/entities/Channel.js";
import { ChannelMember } from "../db/entities/ChannelMember.js";
import { Company } from "../db/entities/Company.js";
import { EmployeeBaseGrant } from "../db/entities/EmployeeBaseGrant.js";
import { EmployeeMailAccountGrant } from "../db/entities/EmployeeMailAccountGrant.js";
import { MailAccount } from "../db/entities/MailAccount.js";
import { Membership } from "../db/entities/Membership.js";
import { Pipeline } from "../db/entities/Pipeline.js";
import { PipelineRun } from "../db/entities/PipelineRun.js";
import { Project } from "../db/entities/Project.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { STATIC_TOOLS } from "../mcp/toolManifest.js";
import { issueMcpToken, revokeMcpToken } from "../services/mcpTokens.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { mcpInternalRouter } from "./mcpInternal.js";

/**
 * AI employees authoring Pipelines.
 *
 * The property worth defending here is not "the tools work" — it is that a
 * Pipeline cannot be used to do something its author could not do directly. A
 * pipeline step runs as the company: it writes into Projects without checking
 * `Project.accessMode`, appends Base records without checking
 * `EmployeeBaseGrant`, and posts into channels as `system`. That was sound
 * while only an owner or admin could author one. Now that an employee can, the
 * authorization moved to save time (`services/pipelines/authoring.ts`), and
 * most of what follows is that boundary.
 */

let server: Server;
let baseUrl = "";
let token = "";
let company: Company;
let employee: AIEmployee;
let owner: User;

const PIPELINE_TOOLS = [
  "list_pipelines",
  "get_pipeline",
  "list_pipeline_node_types",
  "create_pipeline",
  "update_pipeline",
  "delete_pipeline",
  "run_pipeline",
  "list_pipeline_runs",
  "get_pipeline_run",
  "rotate_pipeline_webhook_token",
];

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

beforeEach(async () => {
  if (token) revokeMcpToken(token);
  await resetTestDb();
  owner = await insert(User, { email: "owner@example.test", name: "Owner", passwordHash: "x" });
  company = await insert(Company, {
    name: "Acme",
    slug: `pipelines-mcp-${randomUUID()}`,
    ownerId: owner.id,
  });
  await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Jamie",
    slug: "jamie",
    role: "Marketing",
    soulBody: "",
  });
  token = issueMcpToken(employee.id, company.id, { authority: "employee" });
});

after(async () => {
  if (token) revokeMcpToken(token);
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
});

async function tool<T = Record<string, unknown>>(
  name: string,
  args: unknown = {},
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${baseUrl}/internal/mcp/tools/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(args),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

type Step = { id: string; type: string; config?: Record<string, unknown> };

function graphOf(...nodes: Step[]) {
  return {
    nodes,
    edges: nodes.slice(1).map((node, index) => ({
      id: `e${index}`,
      fromNodeId: nodes[index].id,
      toNodeId: node.id,
    })),
  };
}

type PipelineBody = {
  pipeline: {
    id: string;
    slug: string;
    name: string;
    enabled: boolean;
    stepCount: number;
    cronExpr: string | null;
    graph: {
      nodes: Array<{
        id: string;
        type: string;
        x: number;
        y: number;
        config: Record<string, unknown> | null;
      }>;
    };
    webhookUrls: Array<{ nodeId: string; url: string }>;
    authoring?: { canEdit: boolean; reason: string };
  };
  issues: Array<{ severity: string; message: string }>;
  error?: string;
  problems?: Array<{ message: string }>;
  refusedSteps?: Array<{ nodeId: string; reason: string }>;
};

async function grantedBase(): Promise<{ base: Base; table: BaseTable }> {
  const base = await insert(Base, { companyId: company.id, name: "Revenue", slug: "revenue" });
  const table = await insert(BaseTable, {
    baseId: base.id,
    name: "Marketing Webhook Events",
    slug: "marketing-webhook-events",
    sortOrder: 1000,
  });
  await insert(EmployeeBaseGrant, { employeeId: employee.id, baseId: base.id });
  return { base, table };
}

describe("pipeline tools exist and are reachable", () => {
  test("every pipeline tool is in the manifest and wired to a POST handler", () => {
    type RouteLayer = { path?: unknown; methods?: Record<string, boolean> };
    const manifest = new Set(STATIC_TOOLS.map((entry) => entry.name));
    const stack = (mcpInternalRouter as unknown as { stack?: Array<{ route?: RouteLayer }> }).stack;
    assert.ok(stack, "the internal MCP router exposes no route stack");

    for (const name of PIPELINE_TOOLS) {
      assert.ok(manifest.has(name), `${name} is missing from STATIC_TOOLS`);
      const route: RouteLayer | undefined = stack
        .map((layer) => layer.route)
        .find((candidate) => candidate?.path === `/tools/${name}`);
      assert.ok(route, `missing internal MCP handler for ${name}`);
      assert.equal(route.methods?.post, true, `${name} is not wired as a POST handler`);
    }
  });

  test("the step library reports config keys and branch handles", async () => {
    const response = await tool<{
      stepTypes: Array<{
        type: string;
        outputs: string[];
        config: Array<{ key: string; required: boolean }>;
      }>;
    }>("list_pipeline_node_types");
    assert.equal(response.status, 200);

    const branch = response.body.stepTypes.find((entry) => entry.type === "logic.branch");
    assert.deepEqual(branch?.outputs, ["true", "false"]);
    const record = response.body.stepTypes.find(
      (entry) => entry.type === "action.createBaseRecord",
    );
    assert.ok(record?.config.some((field) => field.key === "baseSlug" && field.required));
  });
});

describe("create_pipeline", () => {
  test("builds the whole graph, lays it out, and mints a webhook URL", async () => {
    const { table } = await grantedBase();
    const response = await tool<PipelineBody>("create_pipeline", {
      name: "File marketing webhook events",
      description: "Unsigned POST in, Base row out.",
      graph: graphOf(
        { id: "hook", type: "trigger.webhook" },
        {
          id: "file-it",
          type: "action.createBaseRecord",
          config: {
            baseSlug: "revenue",
            tableSlug: table.slug,
            data: '{"eventId": "{{trigger.payload.eventId}}"}',
          },
        },
      ),
    });

    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.pipeline.stepCount, 1);
    // Coordinates were never supplied; the builder still gets a readable graph.
    const [trigger, step] = response.body.pipeline.graph.nodes;
    assert.equal(typeof trigger.x, "number");
    assert.ok(step.x > trigger.x, "the second step should sit in the next column");

    const [webhook] = response.body.pipeline.webhookUrls;
    assert.equal(webhook.nodeId, "hook");
    assert.match(webhook.url, /\/api\/webhooks\/pipelines\/[0-9a-f-]+\/[0-9a-f]{48}$/);
  });

  test("a starter needs no graph at all", async () => {
    const response = await tool<PipelineBody>("create_pipeline", {
      name: "Nightly digest",
      startWith: "schedule",
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.pipeline.cronExpr, "0 9 * * *");
  });

  test("refuses a duplicate name rather than making a second pipeline", async () => {
    await tool("create_pipeline", { name: "Nightly digest", startWith: "manual" });
    const again = await tool<PipelineBody>("create_pipeline", {
      name: "nightly digest",
      startWith: "manual",
    });
    assert.equal(again.status, 409);
    assert.equal(await AppDataSource.getRepository(Pipeline).count(), 1);
  });
});

describe("graph validation happens before the write, not at run time", () => {
  test("an unknown step type is refused with the name of the offending step", async () => {
    const response = await tool<PipelineBody>("create_pipeline", {
      name: "Broken",
      graph: graphOf(
        { id: "t", type: "trigger.manual" },
        { id: "oops", type: "action.sendSlackMessage" },
      ),
    });
    assert.equal(response.status, 400);
    assert.match(response.body.problems?.[0]?.message ?? "", /Unknown step type/);
    assert.equal(await AppDataSource.getRepository(Pipeline).count(), 0);
  });

  /**
   * Two cron libraries are involved: `node-cron` gates the save and
   * `cron-parser` computes `nextRunAt`. "@annually" and "0 9 1W * *" pass the
   * first and throw in the second, which used to mean a 200, no warning, and
   * a pipeline that never ran. Validation goes through the same predicate the
   * scheduler does, so every one of these is refused.
   */
  test("a schedule the heartbeat would silently drop is refused", async () => {
    for (const cronExpr of ["every tuesday", "@annually", "0 9 1W * *"]) {
      const response = await tool<PipelineBody>("create_pipeline", {
        name: `Never fires ${cronExpr}`,
        graph: graphOf(
          { id: "t", type: "trigger.schedule", config: { cronExpr } },
          {
            id: "note",
            type: "action.journalNote",
            config: { employeeSlug: "jamie", title: "hi" },
          },
        ),
      });
      assert.equal(response.status, 400, `${cronExpr}: ${JSON.stringify(response.body)}`);
      assert.match(response.body.problems?.[0]?.message ?? "", /not a schedule/);
    }

    // A real one still saves, and is actually scheduled.
    const ok = await tool<PipelineBody>("create_pipeline", {
      name: "Weekday digest",
      graph: graphOf(
        { id: "t", type: "trigger.schedule", config: { cronExpr: "0 9 * * 1-5" } },
        { id: "note", type: "action.journalNote", config: { employeeSlug: "jamie", title: "hi" } },
      ),
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.pipeline.cronExpr, "0 9 * * 1-5");
  });

  test("a connection leaving a handle the step does not have is refused", async () => {
    const response = await tool<PipelineBody>("create_pipeline", {
      name: "Dangling branch",
      graph: {
        nodes: [
          { id: "t", type: "trigger.manual" },
          { id: "note", type: "action.journalNote", config: { employeeSlug: "jamie", title: "x" } },
        ],
        edges: [{ id: "e1", fromNodeId: "t", toNodeId: "note", fromHandle: "true" }],
      },
    });
    assert.equal(response.status, 400);
    assert.match(response.body.problems?.[0]?.message ?? "", /handle "true"/);
  });

  test("a graph with no trigger cannot be saved", async () => {
    const response = await tool<PipelineBody>("create_pipeline", {
      name: "Headless",
      graph: graphOf({ id: "note", type: "action.journalNote", config: { employeeSlug: "jamie" } }),
    });
    assert.equal(response.status, 400);
    assert.match(response.body.problems?.[0]?.message ?? "", /No trigger step/);
  });

  test("missing required config saves, and comes back as work still to do", async () => {
    const response = await tool<PipelineBody>("create_pipeline", {
      name: "Half built",
      graph: graphOf(
        { id: "t", type: "trigger.manual" },
        { id: "post", type: "action.sendMessage", config: {} },
      ),
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.ok(
      response.body.issues.some(
        (issue) => issue.severity === "warning" && /channelIdOrSlug/.test(issue.message),
      ),
      JSON.stringify(response.body.issues),
    );
  });
});

describe("a pipeline cannot launder access its author does not have", () => {
  test("a Base step needs the employee's own Base grant", async () => {
    const base = await insert(Base, { companyId: company.id, name: "Payroll", slug: "payroll" });
    await insert(BaseTable, {
      baseId: base.id,
      name: "Salaries",
      slug: "salaries",
      sortOrder: 1000,
    });

    const response = await tool<PipelineBody>("create_pipeline", {
      name: "Exfiltrate payroll",
      graph: graphOf(
        { id: "t", type: "trigger.manual" },
        {
          id: "write",
          type: "action.createBaseRecord",
          config: { baseSlug: "payroll", tableSlug: "salaries", data: "{}" },
        },
      ),
    });

    assert.equal(response.status, 403, JSON.stringify(response.body));
    assert.equal(response.body.refusedSteps?.[0]?.nodeId, "write");
    assert.match(response.body.refusedSteps?.[0]?.reason ?? "", /No grant/);
    assert.equal(await AppDataSource.getRepository(Pipeline).count(), 0);
  });

  test("a Run JavaScript step is human-only, whatever the code says", async () => {
    // No Grant intersection can bound arbitrary source, so even a harmless
    // one-liner is refused — the authority lives in the step type, not the
    // code it happens to carry today.
    const response = await tool<PipelineBody>("create_pipeline", {
      name: "Code smuggling",
      graph: graphOf(
        { id: "t", type: "trigger.manual" },
        { id: "code", type: "logic.code", config: { code: "return 1;" } },
      ),
    });
    assert.equal(response.status, 403, JSON.stringify(response.body));
    assert.equal(response.body.refusedSteps?.[0]?.nodeId, "code");
    assert.match(response.body.refusedSteps?.[0]?.reason ?? "", /company-wide authority/);
    assert.equal(await AppDataSource.getRepository(Pipeline).count(), 0);
  });

  test("a private channel step needs the employee to be in that channel", async () => {
    const channel = await insert(Channel, {
      companyId: company.id,
      kind: "private",
      name: "Founders",
      slug: "founders",
    });

    const refused = await tool<PipelineBody>("create_pipeline", {
      name: "Leak into founders",
      graph: graphOf(
        { id: "t", type: "trigger.manual" },
        {
          id: "post",
          type: "action.sendMessage",
          config: { channelIdOrSlug: "founders", content: "hello" },
        },
      ),
    });
    assert.equal(refused.status, 403, JSON.stringify(refused.body));
    assert.match(refused.body.refusedSteps?.[0]?.reason ?? "", /not a member of the private/i);

    await insert(ChannelMember, {
      channelId: channel.id,
      memberKind: "ai",
      employeeId: employee.id,
      userId: null,
    });
    const allowed = await tool<PipelineBody>("create_pipeline", {
      name: "Post into founders",
      graph: graphOf(
        { id: "t", type: "trigger.manual" },
        {
          id: "post",
          type: "action.sendMessage",
          config: { channelIdOrSlug: "founders", content: "hello" },
        },
      ),
    });
    assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
  });

  test("a public channel step needs nothing extra", async () => {
    await insert(Channel, {
      companyId: company.id,
      kind: "public",
      name: "General",
      slug: "general",
    });
    const response = await tool<PipelineBody>("create_pipeline", {
      name: "Announce",
      graph: graphOf(
        { id: "t", type: "trigger.manual" },
        {
          id: "post",
          type: "action.sendMessage",
          config: { channelIdOrSlug: "general", content: "hello" },
        },
      ),
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
  });

  test("a task step needs write access to that Project", async () => {
    await insert(Project, {
      companyId: company.id,
      name: "Board matters",
      slug: "board",
      key: "BRD",
      description: "",
      accessMode: "restricted",
    });
    const response = await tool<PipelineBody>("create_pipeline", {
      name: "Into the board project",
      graph: graphOf(
        { id: "t", type: "trigger.manual" },
        {
          id: "task",
          type: "action.createTodo",
          config: { projectSlug: "board", title: "Read the minutes" },
        },
      ),
    });
    assert.equal(response.status, 403, JSON.stringify(response.body));
    assert.match(response.body.refusedSteps?.[0]?.reason ?? "", /cannot add tasks/);
  });

  test("an unscoped task trigger is refused — it would watch every Project", async () => {
    const response = await tool<PipelineBody>("create_pipeline", {
      name: "Watch everything",
      graph: graphOf(
        { id: "t", type: "trigger.todoCreated", config: {} },
        { id: "note", type: "action.journalNote", config: { employeeSlug: "jamie", title: "x" } },
      ),
    });
    assert.equal(response.status, 403, JSON.stringify(response.body));
    assert.match(response.body.refusedSteps?.[0]?.reason ?? "", /every Project/);
  });

  test("an email trigger must name mailboxes the employee can read", async () => {
    const billing = await insert(MailAccount, {
      companyId: company.id,
      address: "billing@acme.test",
      connectionId: randomUUID(),
    });
    await insert(MailAccount, {
      companyId: company.id,
      address: "ceo@acme.test",
      connectionId: randomUUID(),
    });
    await insert(EmployeeMailAccountGrant, {
      employeeId: employee.id,
      accountId: billing.id,
      accessLevel: "read",
    });

    const emailGraph = (config: Record<string, unknown>) =>
      graphOf(
        { id: "t", type: "trigger.emailReceived", config },
        { id: "note", type: "action.journalNote", config: { employeeSlug: "jamie", title: "x" } },
      );

    // Unscoped is refused: it would also deliver mailboxes connected later.
    const unscoped = await tool<PipelineBody>("create_pipeline", {
      name: "Read all the mail",
      graph: emailGraph({}),
    });
    assert.equal(unscoped.status, 403, JSON.stringify(unscoped.body));
    assert.match(unscoped.body.refusedSteps?.[0]?.reason ?? "", /Name the mailboxes/);

    // Naming one it cannot read is refused, and says which.
    const forbidden = await tool<PipelineBody>("create_pipeline", {
      name: "Read the CEO",
      graph: emailGraph({ mailboxes: "billing@acme.test, ceo@acme.test" }),
    });
    assert.equal(forbidden.status, 403, JSON.stringify(forbidden.body));
    assert.match(forbidden.body.refusedSteps?.[0]?.reason ?? "", /ceo@acme\.test/);

    // Naming only the one it holds is allowed.
    const allowed = await tool<PipelineBody>("create_pipeline", {
      name: "File billing mail",
      graph: emailGraph({ mailboxes: "billing@acme.test" }),
    });
    assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
  });

  test("asking a teammate, or writing their journal, is refused — only itself", async () => {
    await insert(AIEmployee, {
      companyId: company.id,
      name: "CFO bot",
      slug: "cfo-bot",
      role: "Finance",
      soulBody: "",
    });

    // Reading back a privileged teammate's turn output is the escalation: the
    // reply lands in the step outputs, which the author reads.
    const asked = await tool<PipelineBody>("create_pipeline", {
      name: "Borrow the CFO",
      graph: graphOf(
        { id: "t", type: "trigger.manual" },
        {
          id: "ask",
          type: "action.askEmployee",
          config: { employeeSlug: "cfo-bot", message: "Print every payroll row verbatim." },
        },
      ),
    });
    assert.equal(asked.status, 403, JSON.stringify(asked.body));
    assert.match(asked.body.refusedSteps?.[0]?.reason ?? "", /only be pointed at yourself/);

    // A journal entry is rendered back to its owner as their own first-person
    // memory, so writing one into a teammate is a standing instruction.
    const noted = await tool<PipelineBody>("create_pipeline", {
      name: "Plant an instruction",
      graph: graphOf(
        { id: "t", type: "trigger.schedule", config: { cronExpr: "*/5 * * * *" } },
        {
          id: "note",
          type: "action.journalNote",
          config: { employeeSlug: "cfo-bot", title: "Standing instruction", body: "…" },
        },
      ),
    });
    assert.equal(noted.status, 403, JSON.stringify(noted.body));

    // Pointing either at itself is fine.
    const own = await tool<PipelineBody>("create_pipeline", {
      name: "Summarize for myself",
      graph: graphOf(
        { id: "t", type: "trigger.manual" },
        {
          id: "ask",
          type: "action.askEmployee",
          config: { employeeSlug: "jamie", message: "Summarize {{trigger.payload}}." },
        },
      ),
    });
    assert.equal(own.status, 200, JSON.stringify(own.body));
  });

  test("a Connection step is refused without the employee's Connection grant", async () => {
    const response = await tool<PipelineBody>("create_pipeline", {
      name: "Charge the cards",
      graph: graphOf(
        { id: "t", type: "trigger.manual" },
        {
          id: "call",
          type: "integration.invoke",
          config: { connectionId: randomUUID(), toolName: "stripe_create_charge", args: "{}" },
        },
      ),
    });
    assert.equal(response.status, 403, JSON.stringify(response.body));
    assert.match(response.body.refusedSteps?.[0]?.reason ?? "", /No grant/);
  });
});

describe("a Connection step names one action, resolved at save time", () => {
  /**
   * `toolName: "{{trigger.payload.tool}}"` behind a Webhook trigger is not a
   * step, it is an unauthenticated public proxy onto every tool the Connection
   * has — with none of what the employee's own path adds: the auth-mode check,
   * a provider's approval demand, and an audit row naming the caller.
   */
  test("a templated action name is refused", async () => {
    const response = await tool<PipelineBody>("create_pipeline", {
      name: "Proxy",
      graph: graphOf(
        { id: "hook", type: "trigger.webhook" },
        {
          id: "call",
          type: "integration.invoke",
          config: {
            connectionId: randomUUID(),
            toolName: "{{trigger.payload.tool}}",
            args: "{{trigger.payload.args}}",
          },
        },
      ),
    });
    assert.equal(response.status, 403, JSON.stringify(response.body));
    // The Connection grant is checked first, so assert on whichever fired —
    // both are refusals of the same step.
    assert.equal(response.body.refusedSteps?.[0]?.nodeId, "call");
  });
});

describe("update_pipeline", () => {
  test("a step a human added locks the employee out of the whole pipeline", async () => {
    const { table } = await grantedBase();
    const created = await tool<PipelineBody>("create_pipeline", {
      name: "Marketing receiver",
      graph: graphOf(
        { id: "hook", type: "trigger.webhook" },
        {
          id: "file-it",
          type: "action.createBaseRecord",
          config: { baseSlug: "revenue", tableSlug: table.slug, data: "{}" },
        },
      ),
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.ok(created.body.pipeline.webhookUrls[0]?.url);

    // A human adds a Connection step in the builder — modelled here as the row
    // write that produces.
    const row = await AppDataSource.getRepository(Pipeline).findOneByOrFail({
      id: created.body.pipeline.id,
    });
    const graph = JSON.parse(row.graphJson) as {
      nodes: Array<Record<string, unknown>>;
      edges: Array<Record<string, unknown>>;
    };
    graph.nodes.push({
      id: "charge",
      type: "integration.invoke",
      x: 640,
      y: 88,
      config: { connectionId: randomUUID(), toolName: "stripe_create_charge", args: "{}" },
    });
    graph.edges.push({ id: "e-human", fromNodeId: "file-it", toNodeId: "charge" });
    row.graphJson = JSON.stringify(graph);
    await AppDataSource.getRepository(Pipeline).save(row);

    // Editing an unrelated step is refused too: a step's config reads
    // {{other-step.field}} at run time, so changing an upstream step changes
    // what the Connection step does without touching its bytes. The gate is on
    // the graph as stored, so any replacement payload is refused.
    const current = await tool<PipelineBody>("get_pipeline", { pipelineId: row.slug });
    assert.equal(current.status, 200);
    const edited = await tool<PipelineBody>("update_pipeline", {
      pipelineId: row.slug,
      graph: graphOf({ id: "t", type: "trigger.manual" }),
    });
    assert.equal(edited.status, 403, JSON.stringify(edited.body));
    assert.equal(edited.body.refusedSteps?.[0]?.nodeId, "charge");

    // Every step's settings are withheld, not just the webhook secret — an
    // admin's HTTP step carries its Authorization header in `config`.
    for (const node of current.body.pipeline.graph.nodes) {
      assert.equal(node.config, null, `${node.id} leaked its settings`);
    }

    // …and it can no longer fire it, read its Runs, or hold its webhook URL.
    const ran = await tool<PipelineBody>("run_pipeline", { pipelineId: row.slug });
    assert.equal(ran.status, 403, JSON.stringify(ran.body));
    assert.deepEqual(current.body.pipeline.webhookUrls, []);

    // Not even renaming or pausing: pausing the company's billing automation
    // is not a harmless edit, so the rule has no per-field exceptions.
    const renamed = await tool<PipelineBody>("update_pipeline", {
      pipelineId: row.slug,
      name: "Marketing receiver (old)",
    });
    assert.equal(renamed.status, 403, JSON.stringify(renamed.body));
    const paused = await tool<PipelineBody>("update_pipeline", {
      pipelineId: row.slug,
      enabled: false,
    });
    assert.equal(paused.status, 403, JSON.stringify(paused.body));
    const deleted = await tool<PipelineBody>("delete_pipeline", { pipelineId: row.slug });
    assert.equal(deleted.status, 403, JSON.stringify(deleted.body));
    assert.equal(await AppDataSource.getRepository(Pipeline).count(), 1);

    // Reading what it does stays open — an employee that cannot see the
    // company's automation cannot answer questions about it.
    assert.equal(current.body.pipeline.name, "Marketing receiver");
    assert.equal(current.body.pipeline.authoring?.canEdit, false);
  });

  test("an employee cannot read the Runs of a pipeline it could not build", async () => {
    const foreignConnection = randomUUID();
    const row = await insert(Pipeline, {
      companyId: company.id,
      name: "Billing",
      slug: "billing",
      description: "",
      enabled: true,
      graphJson: JSON.stringify({
        nodes: [
          { id: "t", type: "trigger.manual", x: 0, y: 0, config: {} },
          {
            id: "charge",
            type: "integration.invoke",
            x: 260,
            y: 0,
            config: { connectionId: foreignConnection, toolName: "stripe_create_charge" },
          },
        ],
        edges: [{ id: "e1", fromNodeId: "t", toNodeId: "charge" }],
      }),
    });
    const run = await insert(PipelineRun, {
      pipelineId: row.id,
      startedAt: new Date(),
      status: "failed",
      triggerKind: "manual",
      triggerNodeId: "t",
      inputJson: JSON.stringify({ card: "4242424242424242" }),
      outputJson: "{}",
      logContent: "secret",
      errorMessage: "card 4242424242424242 was declined",
    });

    const detail = await tool<{ error: string }>("get_pipeline_run", { runId: run.id });
    assert.equal(detail.status, 403, JSON.stringify(detail.body));

    // The listing still answers "is it healthy", without quoting the failure.
    const history = await tool<{ runs: Array<{ status: string; errorMessage: string | null }> }>(
      "list_pipeline_runs",
      { pipelineId: row.slug },
    );
    assert.equal(history.status, 200);
    assert.equal(history.body.runs[0].status, "failed");
    assert.equal(history.body.runs[0].errorMessage, null);
  });

  test("pausing keeps the row and clears the schedule", async () => {
    const created = await tool<PipelineBody>("create_pipeline", {
      name: "Nightly digest",
      startWith: "schedule",
    });
    const paused = await tool<PipelineBody>("update_pipeline", {
      pipelineId: created.body.pipeline.id,
      enabled: false,
    });
    assert.equal(paused.status, 200, JSON.stringify(paused.body));
    assert.equal(paused.body.pipeline.enabled, false);
    assert.equal(paused.body.pipeline.cronExpr, null);
  });
});

describe("running and reading back", () => {
  test("run_pipeline executes the steps and returns the log", async () => {
    const { table } = await grantedBase();
    const created = await tool<PipelineBody>("create_pipeline", {
      name: "Manual filing",
      graph: graphOf(
        { id: "t", type: "trigger.manual" },
        {
          id: "file-it",
          type: "action.createBaseRecord",
          config: {
            baseSlug: "revenue",
            tableSlug: table.slug,
            data: '{"eventId": "{{trigger.payload.eventId}}"}',
          },
        },
      ),
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));

    const run = await tool<{
      run: { id: string; status: string; logContent: string; errorMessage: string | null };
    }>("run_pipeline", {
      pipelineId: created.body.pipeline.id,
      payload: { eventId: "evt_123" },
    });
    assert.equal(run.status, 200, JSON.stringify(run.body));
    assert.equal(run.body.run.status, "completed", run.body.run.errorMessage ?? "");
    assert.match(run.body.run.logContent, /added record to revenue/);

    const detail = await tool<{
      run: { payload: { eventId: string }; stepOutputs: Record<string, unknown> };
    }>("get_pipeline_run", { runId: run.body.run.id });
    assert.equal(detail.status, 200);
    assert.equal(detail.body.run.payload.eventId, "evt_123");
    assert.ok("file-it" in detail.body.run.stepOutputs);

    const history = await tool<{ runs: Array<{ id: string }> }>("list_pipeline_runs", {
      pipelineId: created.body.pipeline.id,
    });
    assert.equal(history.body.runs.length, 1);
  });

  test("a paused pipeline says so rather than pretending to run", async () => {
    const created = await tool<PipelineBody>("create_pipeline", {
      name: "Paused",
      startWith: "manual",
    });
    await tool("update_pipeline", { pipelineId: created.body.pipeline.id, enabled: false });
    const run = await tool<{ error: string }>("run_pipeline", {
      pipelineId: created.body.pipeline.id,
    });
    assert.equal(run.status, 409);
    assert.match(run.body.error, /paused/);
  });
});

describe("webhook secrets", () => {
  test("rotating replaces the URL", async () => {
    const created = await tool<PipelineBody>("create_pipeline", {
      name: "Receiver",
      startWith: "webhook",
    });
    const before = created.body.pipeline.webhookUrls[0];
    assert.ok(before?.url);

    const rotated = await tool<{ webhookUrls: Array<{ nodeId: string; url: string }> }>(
      "rotate_pipeline_webhook_token",
      { pipelineId: created.body.pipeline.id, nodeId: before.nodeId },
    );
    assert.equal(rotated.status, 200, JSON.stringify(rotated.body));
    assert.notEqual(rotated.body.webhookUrls[0].url, before.url);
  });

  test("rotating a step that is not a webhook trigger is a clear 400", async () => {
    const created = await tool<PipelineBody>("create_pipeline", {
      name: "Not a webhook",
      startWith: "manual",
    });
    const response = await tool<{ error: string }>("rotate_pipeline_webhook_token", {
      pipelineId: created.body.pipeline.id,
      nodeId: "trigger",
    });
    assert.equal(response.status, 400);
    assert.match(response.body.error, /not a Webhook trigger/i);
  });
});

describe("a pipeline whose stored steps cannot be read", () => {
  /**
   * An unparseable graph reduces to zero steps, and zero steps produce zero
   * refusals — so the authority check would have waved through the one
   * pipeline nobody can account for. Every gate must fail closed instead.
   */
  test("fails closed on every gate rather than reducing to an empty graph", async () => {
    const row = await insert(Pipeline, {
      companyId: company.id,
      name: "Corrupt",
      slug: "corrupt",
      description: "",
      enabled: true,
      graphJson: "{not json",
    });

    for (const [name, args] of [
      ["update_pipeline", { pipelineId: row.slug, name: "Renamed" }],
      ["delete_pipeline", { pipelineId: row.slug }],
      ["run_pipeline", { pipelineId: row.slug }],
      ["rotate_pipeline_webhook_token", { pipelineId: row.slug, nodeId: "hook" }],
    ] as const) {
      const response = await tool<{ error: string }>(name, args);
      assert.equal(response.status, 409, `${name}: ${JSON.stringify(response.body)}`);
      assert.match(response.body.error, /cannot be read/);
    }
    assert.equal(await AppDataSource.getRepository(Pipeline).count(), 1);

    // Reading still answers, so a human can be told what is wrong.
    const read = await tool<PipelineBody>("get_pipeline", { pipelineId: row.slug });
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.equal(read.body.pipeline.authoring?.canEdit, false);
    assert.deepEqual(read.body.pipeline.webhookUrls, []);
    assert.ok(read.body.issues.some((issue) => /not readable JSON/.test(issue.message)));
  });
});

describe("company scoping and authority", () => {
  test("another company's pipeline is not found", async () => {
    const other = await insert(Company, {
      name: "Other",
      slug: `other-${randomUUID()}`,
      ownerId: owner.id,
    });
    const foreign = await insert(Pipeline, {
      companyId: other.id,
      name: "Theirs",
      slug: "theirs",
      description: "",
      enabled: true,
      graphJson: '{"nodes":[],"edges":[]}',
    });
    const response = await tool<{ error: string }>("get_pipeline", { pipelineId: foreign.id });
    assert.equal(response.status, 404);

    const listed = await tool<{ pipelines: unknown[] }>("list_pipelines");
    assert.deepEqual(listed.body.pipelines, []);
  });

  test("an untrusted chat token cannot reach the pipeline tools", async () => {
    revokeMcpToken(token);
    token = issueMcpToken(employee.id, company.id);
    const response = await tool<{ error: string }>("list_pipelines");
    assert.equal(response.status, 403);
    assert.match(response.body.error, /authenticated Genosyn Member/);
  });

  test("a plain Member cannot delegate a pipeline write, but can read", async () => {
    const teammate = await insert(User, {
      email: "member@example.test",
      name: "Member",
      passwordHash: "x",
    });
    await insert(Membership, { companyId: company.id, userId: teammate.id, role: "member" });
    revokeMcpToken(token);
    token = issueMcpToken(employee.id, company.id, {
      authority: "member",
      requesterUserId: teammate.id,
      requesterSessionVersion: teammate.sessionVersion,
    });

    const read = await tool<{ pipelines: unknown[] }>("list_pipelines");
    assert.equal(read.status, 200, JSON.stringify(read.body));

    const write = await tool<{ error: string }>("create_pipeline", {
      name: "Member cannot",
      startWith: "manual",
    });
    assert.equal(write.status, 403);
    assert.match(write.body.error, /owner or admin/);
  });
});
