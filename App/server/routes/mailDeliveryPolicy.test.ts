import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, afterEach, before, beforeEach, describe, mock, test } from "node:test";
import express from "express";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AIModel } from "../db/entities/AIModel.js";
import { Company } from "../db/entities/Company.js";
import { EmployeeMailAccountGrant } from "../db/entities/EmployeeMailAccountGrant.js";
import { MailAccount } from "../db/entities/MailAccount.js";
import { Pipeline } from "../db/entities/Pipeline.js";
import { Project } from "../db/entities/Project.js";
import { Todo } from "../db/entities/Todo.js";
import { errorHandler } from "../middleware/error.js";
import { issueMcpToken, revokeMcpToken } from "../services/mcpTokens.js";
import type { MailDeliveryMode } from "../services/mail/deliveryPolicy.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { mcpInternalRouter } from "./mcpInternal.js";

let server: Server;
let url = "";
let token = "";
let employee: AIEmployee;
let company: Company;
before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use("/internal/mcp", mcpInternalRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/internal/mcp`;
});
beforeEach(async () => {
  if (token) revokeMcpToken(token);
  await resetTestDb();
  company = await insert(Company, {
    name: "Draft Company",
    slug: "draft-company",
    ownerId: "owner",
  });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Morgan",
    slug: "morgan",
    role: "Support",
    soulBody: "",
  });
  const account = await insert(MailAccount, {
    companyId: company.id,
    address: "team@example.com",
    connectionId: "connection",
  });
  await insert(EmployeeMailAccountGrant, {
    employeeId: employee.id,
    accountId: account.id,
    accessLevel: "send",
  });
  token = issueMcpToken(employee.id, company.id, {
    authority: "employee",
    mailDeliveryMode: "draft",
  });
});
after(async () => {
  revokeMcpToken(token);
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await closeTestDb();
});
afterEach(() => mock.restoreAll());

function setDeliveryMode(mode: MailDeliveryMode | null) {
  revokeMcpToken(token);
  token = issueMcpToken(employee.id, company.id, {
    authority: "employee",
    ...(mode ? { mailDeliveryMode: mode } : {}),
  });
}

async function call(tool: string, body: unknown) {
  const response = await fetch(`${url}/tools/${tool}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as { error?: string } };
}

describe("server enforced mail delivery ceiling", () => {
  for (const mode of ["draft", "triage", "reply", null] as const) {
    test(`${mode ?? "ordinary"} turns save Todos with the correct Pipeline follow-on authority`, async () => {
      setDeliveryMode(mode);
      const project = await insert(Project, {
        companyId: company.id,
        name: "Customer follow-up",
        slug: "follow-up",
        key: "FOLLOW",
      });
      // Observe the actual event-dispatch boundary without starting an unrelated
      // Pipeline. The restricted branch must never even discover workers.
      const pipelineReads = mock.method(
        AppDataSource.getRepository(Pipeline),
        "findBy",
        async () => [],
      );
      const result = await call("create_todo", {
        projectSlug: project.slug,
        title: "Prepare a customer follow-up",
        description: "Review the saved draft with the customer context.",
      });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      const todo = await AppDataSource.getRepository(Todo).findOneByOrFail({
        projectId: project.id,
      });
      assert.equal(todo.assigneeEmployeeId, employee.id);
      assert.equal(todo.description, "Review the saved draft with the customer context.");
      // Fire-and-forget dispatch performs a few database reads first.
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(pipelineReads.mock.callCount(), mode === "reply" || mode === null ? 1 : 0);
    });

    test(`${mode ?? "ordinary"} turns retain review status without starting an unauthorized reviewer`, async () => {
      setDeliveryMode(mode);
      const project = await insert(Project, {
        companyId: company.id,
        name: "Customer follow-up",
        slug: "follow-up",
        key: "FOLLOW",
      });
      const reviewer = await insert(AIEmployee, {
        companyId: company.id,
        name: "Reviewer",
        slug: "reviewer",
        role: "Review",
        soulBody: "",
      });
      const todo = await insert(Todo, {
        projectId: project.id,
        number: 1,
        title: "Check the draft",
        assigneeEmployeeId: employee.id,
        reviewerEmployeeId: reviewer.id,
      });
      // A real kickoff resolves the reviewer's model; returning no models
      // makes the permitted control path finish without an external call.
      const modelReads = mock.method(AppDataSource.getRepository(AIModel), "find", async () => []);
      const result = await call("update_todo", { todoId: todo.id, status: "in_review" });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(
        (await AppDataSource.getRepository(Todo).findOneByOrFail({ id: todo.id })).status,
        "in_review",
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(modelReads.mock.callCount(), mode === "reply" || mode === null ? 1 : 0);
    });
  }

  test("a Send-granted employee cannot send drafts, replies, fresh mail or Finance mail from a preparation turn", async () => {
    for (const body of [
      { draftMessageId: "draft" },
      { threadId: "thread", bodyText: "reply" },
      { to: "any@example.com", subject: "new", bodyText: "new", mailDeliveryMode: "reply" },
    ]) {
      const result = await call("send_mail", body);
      assert.equal(result.status, 403);
      assert.match(result.body.error!, /preparation only/);
    }
    for (const name of ["send_invoice", "send_signature_envelope", "remind_signature_recipient"]) {
      assert.equal((await call(name, {})).status, 403, name);
    }
  });

  test("triage is enforced before native draft handlers and request parameters cannot raise it", async () => {
    revokeMcpToken(token);
    token = issueMcpToken(employee.id, company.id, {
      authority: "employee",
      mailDeliveryMode: "triage",
    });
    for (const name of ["create_mail_draft", "edit_mail_draft"]) {
      const result = await call(name, { bodyText: "send this", mailDeliveryMode: "reply" });
      assert.equal(result.status, 403);
      assert.match(result.body.error!, /triage only/);
    }
  });

  test("restricted turns cannot export authority to separate automation", async () => {
    for (const name of [
      "schedule_wakeup",
      "create_routine",
      "create_handoff",
      "run_pipeline",
      "enroll_in_sequence",
    ]) {
      const result = await call(name, {});
      assert.equal(result.status, 403, name);
      assert.match(result.body.error!, /separate automation|delegate/);
    }
  });

  test("reply mode leaves the normal strict body and mailbox Grant checks in force", async () => {
    revokeMcpToken(token);
    token = issueMcpToken(employee.id, company.id, {
      authority: "employee",
      mailDeliveryMode: "reply",
    });
    assert.equal((await call("send_mail", { injected: "bad" })).status, 400);
    assert.equal((await call("create_mail_draft", {})).status, 400);
  });

  test("sender tools cannot be steered to a different email from a bound handover", async () => {
    revokeMcpToken(token);
    token = issueMcpToken(employee.id, company.id, {
      authority: "employee",
      mailDeliveryMode: "draft",
      mailThreadId: "00000000-0000-4000-8000-000000000001",
    });
    for (const tool of ["mail_block_sender", "mail_unsubscribe"]) {
      const result = await call(tool, { threadId: "00000000-0000-4000-8000-000000000002" });
      assert.equal(result.status, 403);
      assert.match(result.body.error!, /own email thread/);
    }
  });
});
