import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import express from "express";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AIModel } from "../db/entities/AIModel.js";
import { Company } from "../db/entities/Company.js";
import { Decision } from "../db/entities/Decision.js";
import { DecisionPolicy } from "../db/entities/DecisionPolicy.js";
import { JournalEntry } from "../db/entities/JournalEntry.js";
import { Membership } from "../db/entities/Membership.js";
import { Notification } from "../db/entities/Notification.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { kickoffDecision } from "../services/decisionKickoff.js";
import { kickoffRoutedDecision, tryRouteDecision } from "../services/decisionRouting.js";
import { decideDecision, listDecisions } from "../services/decisions.js";
import { issueMcpToken, revokeMcpToken } from "../services/mcpTokens.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { mcpInternalRouter } from "./mcpInternal.js";

let server: Server;
let url: string;
let company: Company;
let employee: AIEmployee;
let member: User;
let decider: AIEmployee;

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use("/internal/mcp", mcpInternalRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/internal/mcp/tools/request_decision`;
});
beforeEach(async () => {
  await resetTestDb();
  member = await insert(User, { email: "owner@example.com", name: "Owner", passwordHash: "x" });
  company = await insert(Company, { name: "Acme", slug: "acme", ownerId: member.id });
  await insert(Membership, { companyId: company.id, userId: member.id, role: "owner" });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Morgan",
    slug: "morgan",
    role: "Support",
  });
  decider = await insert(AIEmployee, {
    companyId: company.id,
    name: "Alex",
    slug: "alex",
    role: "Manager",
  });
  await insert(AIModel, {
    employeeId: decider.id,
    provider: "anthropic",
    model: "claude-x",
    configJson: "{}",
    isActive: true,
  });
  await insert(DecisionPolicy, {
    companyId: company.id,
    deciderKind: "employee",
    deciderEmployeeId: decider.id,
  });
});
after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await closeTestDb();
});

async function ask(mode: "draft" | "triage"): Promise<Decision> {
  const token = issueMcpToken(employee.id, company.id, {
    authority: "employee",
    mailDeliveryMode: mode,
  });
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        title: "Which verified price applies?",
        options: [{ label: "Standard rate" }, { label: "Contract rate" }],
      }),
    });
    assert.equal(response.status, 200);
    const result = (await response.json()) as { decisionId: string; note: string };
    assert.match(result.note, /Answering does not start another AI session/);
    return AppDataSource.getRepository(Decision).findOneByOrFail({ id: result.decisionId });
  } finally {
    revokeMcpToken(token);
  }
}

test("draft and triage requests stay human-only despite an enabled AI decision policy", async () => {
  for (const mode of ["draft", "triage"] as const) {
    const decision = await ask(mode);
    assert.equal(decision.status, "pending");
    assert.equal(decision.pickupStatus, "skipped");
    assert.equal(decision.routedToEmployeeId, null);
    const summary = decision.pickupSummary ?? "";
    assert.match(summary, /awaiting human review/);
    assert.match(summary, /Answering does not start work/);
    assert.match(summary, /proposed work plan needs its own human approval/);
    // A stale in-memory copy must not route a persistently restricted row.
    assert.equal(
      await tryRouteDecision(Object.assign(new Decision(), decision, { pickupStatus: "none" })),
      null,
    );
  }
  assert.equal(
    await AppDataSource.getRepository(Notification).countBy({ kind: "decision_pending" }),
    2,
  );
});

test("human answers remain readable and journaled without starting either AI continuation", async () => {
  const decision = await ask("draft");
  const result = await decideDecision({
    companyId: company.id,
    decisionId: decision.id,
    userId: member.id,
    role: "owner",
    optionId: "contract-rate",
    note: "Use the signed agreement.",
  });
  assert.equal(result.outcome, "decided");
  for (const authority of ["member", "employee"] as const) {
    await kickoffDecision({
      companyId: company.id,
      decisionId: decision.id,
      requesterUserId: member.id,
      requesterSessionVersion: 0,
      authority,
      runChat: async () => {
        assert.fail("An answer cannot shed the originating ceiling");
      },
    });
  }
  await kickoffRoutedDecision({
    companyId: company.id,
    decisionId: decision.id,
    runChat: async () => {
      assert.fail("No AI decider should run");
    },
  });
  const stored = await AppDataSource.getRepository(Decision).findOneByOrFail({ id: decision.id });
  assert.equal(stored.status, "decided");
  assert.equal(stored.pickupStatus, "skipped");
  assert.equal(stored.chosenOptionLabel, "Contract rate");
  assert.equal(stored.note, "Use the signed agreement.");
  assert.equal(stored.pickupStartedAt, null);
  assert.ok(
    (await listDecisions({ companyId: company.id, status: "decided" })).some(
      (row) => row.id === decision.id,
    ),
  );
  const journals = await AppDataSource.getRepository(JournalEntry).findBy({
    employeeId: employee.id,
  });
  assert.ok(journals.some((entry) => entry.body.includes("Use the signed agreement.")));
});
