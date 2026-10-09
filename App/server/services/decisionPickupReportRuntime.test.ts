import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AIModel } from "../db/entities/AIModel.js";
import { Company } from "../db/entities/Company.js";
import { Decision } from "../db/entities/Decision.js";
import { JournalEntry } from "../db/entities/JournalEntry.js";
import { Membership } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { encryptSecret } from "../lib/secret.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { agentRuntime } from "./agent/runtime.js";
import { createDecision, decideDecision } from "./decisions.js";
import { kickoffDecision } from "./decisionKickoff.js";

/**
 * The pickup report through the real chat path. A session narrates as it
 * works — "I opened the deal. Now I'll…" — and the stack used to show every
 * one of those lines. The model runtime reports the turn's final message on
 * its own; this pins that it reaches the Decision as `pickupReport`, while
 * `pickupSummary` keeps everything that was streamed, so the stack can lead
 * with the report and keep the narration behind a toggle.
 */

before(initTestDb);
after(closeTestDb);

let company: Company;
let employee: AIEmployee;
let member: User;

beforeEach(async () => {
  await resetTestDb();
  member = await insert(User, {
    email: "mia@example.test",
    name: "Mia",
    passwordHash: "x",
    sessionVersion: 0,
  });
  company = await insert(Company, { name: "Acme", slug: "acme", ownerId: member.id });
  await insert(Membership, { companyId: company.id, userId: member.id, role: "owner" });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Nova",
    slug: "nova",
    role: "Sales",
    soulBody: "",
  });
  await insert(AIModel, {
    employeeId: employee.id,
    provider: "custom",
    model: "pickup-test",
    authMode: "customEndpoint",
    isActive: true,
    connectedAt: new Date(),
    configJson: JSON.stringify({
      baseURLEncrypted: encryptSecret("http://127.0.0.1:19999/v1"),
      modelId: "pickup-test",
    }),
  });
});

test("the final message becomes the report; the narration stays in the log", async (t) => {
  const narration = [
    "I opened the Acme deal. Now I'll check the quote.\n\n",
    "The quote is current. Sending the reply.\n\n",
  ];
  const report = "Sent Acme the signed renewal and logged it on the deal.";
  let briefed = "";
  t.mock.method(agentRuntime, "run", async (input: Parameters<typeof agentRuntime.run>[0]) => {
    briefed = JSON.stringify(input.messages);
    for (const step of narration) input.callbacks?.onText?.(step);
    input.callbacks?.onText?.(report);
    return { finalText: report, steps: 3, stopReason: "end_turn" };
  });
  const { decision } = await createDecision({
    companyId: company.id,
    employeeId: employee.id,
    title: "Sign Acme's renewal?",
    summary: "Acme will renew for three years at 10% off.",
    options: [{ label: "Sign it", tone: "primary" }, { label: "Hold" }],
  });
  const answered = await decideDecision({
    companyId: company.id,
    decisionId: decision.id,
    userId: member.id,
    role: "owner",
    optionId: "sign-it",
  });
  assert.equal(answered.outcome, "decided");
  await kickoffDecision({
    companyId: company.id,
    decisionId: decision.id,
    requesterUserId: member.id,
    requesterSessionVersion: 0,
  });
  const row = await AppDataSource.getRepository(Decision).findOneByOrFail({ id: decision.id });
  assert.equal(row.pickupStatus, "done", row.pickupSummary ?? "");
  assert.equal(row.pickupReport, report);
  assert.equal(row.pickupSummary, `${narration.join("")}${report}`);
  assert.match(briefed, /Your final message is shown to the team on the decision itself/);
  const [entry] = await AppDataSource.getRepository(JournalEntry).find({
    where: { employeeId: employee.id, title: 'Picked up the decision "Sign Acme\'s renewal?"' },
  });
  assert.equal(entry.body, report, "the journal keeps the report, not the narration");
});
