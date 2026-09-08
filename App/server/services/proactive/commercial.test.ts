import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import { AppDataSource } from "../../db/datasource.js";
import { Activity } from "../../db/entities/Activity.js";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import { Contact } from "../../db/entities/Contact.js";
import { Customer } from "../../db/entities/Customer.js";
import { Deal } from "../../db/entities/Deal.js";
import { EmployeeFinanceGrant } from "../../db/entities/EmployeeFinanceGrant.js";
import { EmployeeMarketingGrant } from "../../db/entities/EmployeeMarketingGrant.js";
import { EmployeeRevenueGrant } from "../../db/entities/EmployeeRevenueGrant.js";
import { EmployeeSigningGrant } from "../../db/entities/EmployeeSigningGrant.js";
import { Estimate } from "../../db/entities/Estimate.js";
import { LedgerEntry } from "../../db/entities/LedgerEntry.js";
import { MarketingCampaign } from "../../db/entities/MarketingCampaign.js";
import { MarketingExperiment } from "../../db/entities/MarketingExperiment.js";
import { Partnership } from "../../db/entities/Partnership.js";
import { SignatureEnvelope } from "../../db/entities/SignatureEnvelope.js";
import { SignatureRecipient } from "../../db/entities/SignatureRecipient.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../../test/dbHarness.js";
import { CommercialOpportunitiesError, getCommercialOpportunities } from "./commercial.js";
import { PROACTIVE_SECTION_LIMIT } from "./opportunities.js";

const now = new Date("2026-09-08T12:00:00.000Z");
const day = (offset: number) => new Date(now.getTime() + offset * 86_400_000);
let companyId: string;
let employee: AIEmployee;
let customer: Customer;
let campaign: MarketingCampaign;

before(initTestDb);
after(closeTestDb);
beforeEach(async () => {
  await resetTestDb();
  companyId = randomUUID();
  employee = await insert(AIEmployee, {
    companyId,
    name: "Maya",
    slug: randomUUID(),
    role: "Operations",
  });
  customer = await insert(Customer, {
    companyId,
    name: "Customer",
    slug: randomUUID(),
    email: "private@example.test",
  });
  campaign = await insert(MarketingCampaign, {
    companyId,
    name: "Campaign",
    objective: "sales",
    status: "active",
    ownerEmployeeId: employee.id,
  });
});

const read = () => getCommercialOpportunities(companyId, employee.id, now);
async function grants(level = "read", grantCompany = companyId) {
  await insert(EmployeeFinanceGrant, {
    companyId: grantCompany,
    employeeId: employee.id,
    accessLevel: level as "read",
  });
  await insert(EmployeeRevenueGrant, {
    companyId: grantCompany,
    employeeId: employee.id,
    accessLevel: level as "read",
  });
  await insert(EmployeeMarketingGrant, {
    companyId: grantCompany,
    employeeId: employee.id,
    accessLevel: level as "read",
  });
  await insert(EmployeeSigningGrant, {
    companyId: grantCompany,
    employeeId: employee.id,
    accessLevel: level as "read",
  });
}
const transaction = (values: Partial<LedgerEntry> = {}) =>
  insert(LedgerEntry, {
    companyId,
    date: day(-1),
    memo: "Private ledger memo",
    reviewNote: "Private accounting note",
    ...values,
  });
const estimate = (values: Partial<Estimate> = {}) =>
  insert(Estimate, {
    companyId,
    customerId: customer.id,
    slug: randomUUID(),
    number: "EST-0001",
    status: "accepted",
    issueDate: day(-5),
    validUntil: day(10),
    acceptedAt: day(-1),
    notes: "Private estimate body",
    footer: "Private terms",
    ...values,
  });
const followUp = (values: Partial<Activity> = {}) =>
  insert(Activity, {
    companyId,
    kind: "task",
    subject: "Follow up on the agreed scope",
    occurredAt: day(-2),
    assignedEmployeeId: employee.id,
    dueAt: day(-1),
    taskStatus: "open",
    bodyText: "Private conversation body",
    metaJson: "Private machine metadata",
    ...values,
  });
const experiment = (values: Partial<MarketingExperiment> = {}) =>
  insert(MarketingExperiment, {
    companyId,
    campaignId: campaign.id,
    name: "Compare offers",
    status: "running",
    startsAt: day(-10),
    endsAt: day(-1),
    hypothesis: "Private campaign plan",
    decisionRationale: "Private analysis",
    ...values,
  });
const envelope = (values: Partial<SignatureEnvelope> = {}) =>
  insert(SignatureEnvelope, {
    companyId,
    title: "Supplier agreement",
    originalFilename: "private.pdf",
    originalStorageKey: "private/storage",
    message: "Private invitation",
    documentText: "Private agreement body",
    status: "sent",
    sentAt: day(-2),
    expiresAt: day(2),
    ...values,
  });
const recipient = (envelopeId: string, values: Partial<SignatureRecipient> = {}) =>
  insert(SignatureRecipient, {
    companyId,
    envelopeId,
    name: "Private signer",
    email: "signer@example.test",
    status: "sent",
    tokenHash: randomUUID(),
    ...values,
  });
async function allRows(otherCompany = companyId) {
  const rows = await Promise.all([
    transaction({ companyId: otherCompany }),
    estimate({ companyId: otherCompany }),
    followUp({ companyId: otherCompany }),
    experiment({ companyId: otherCompany }),
    envelope({ companyId: otherCompany }),
  ]);
  await recipient(rows[4].id, { companyId: otherCompany });
  return rows;
}

test("denied sources are omitted and readable empty sources retain empty sections", async () => {
  assert.deepEqual(await read(), {});
  await grants();
  const sections = await read();
  assert.deepEqual(Object.keys(sections), [
    "financeTransactions",
    "acceptedEstimates",
    "revenueFollowUps",
    "marketingExperiments",
    "signatureExpirations",
  ]);
  for (const section of Object.values(sections))
    assert.deepEqual(section, { items: [], truncated: false });
});

test("invalid, deleted, and foreign employees cannot inspect commercial work", async () => {
  await grants();
  await allRows();
  await assert.rejects(
    getCommercialOpportunities(companyId, "not-a-uuid", now),
    CommercialOpportunitiesError,
  );
  await assert.rejects(
    getCommercialOpportunities(randomUUID(), employee.id, now),
    CommercialOpportunitiesError,
  );
  await AppDataSource.getRepository(AIEmployee).delete({ id: employee.id });
  await assert.rejects(read(), CommercialOpportunitiesError);
});

test("an invalid clock cannot produce a misleading due-work packet", async () => {
  await assert.rejects(
    getCommercialOpportunities(companyId, employee.id, new Date("invalid")),
    /Invalid opportunity time/,
  );
});

test("company-mismatched and unknown Grant levels fail closed", async () => {
  await allRows();
  await grants("read", randomUUID());
  assert.deepEqual(await read(), {});
  for (const entity of [
    EmployeeFinanceGrant,
    EmployeeRevenueGrant,
    EmployeeMarketingGrant,
    EmployeeSigningGrant,
  ]) {
    await AppDataSource.getRepository<{
      companyId: string;
      employeeId: string;
      accessLevel: string;
    }>(entity).update({ employeeId: employee.id }, { companyId, accessLevel: "unknown" as "read" });
  }
  assert.deepEqual(await read(), {});
});

test("each Grant is rechecked after revocation and never authorizes another subsystem", async () => {
  await allRows();
  await grants();
  const pairs = [
    [EmployeeFinanceGrant, ["financeTransactions", "acceptedEstimates"]],
    [EmployeeRevenueGrant, ["revenueFollowUps"]],
    [EmployeeMarketingGrant, ["marketingExperiments"]],
    [EmployeeSigningGrant, ["signatureExpirations"]],
  ] as const;
  for (const [entity, sections] of pairs) {
    await AppDataSource.getRepository<{ employeeId: string }>(entity).delete({
      employeeId: employee.id,
    });
    for (const section of sections) assert.equal((await read())[section], undefined);
  }
  assert.deepEqual(await read(), {});
});

test("matching cues contain actual IDs and read-tool hints without bodies or signing credentials", async () => {
  await grants();
  const [tx, quote, follow, exp, sign] = await allRows();
  const sections = await read();
  assert.deepEqual(
    Object.values(sections).map((section) => section.items[0].id),
    [tx.id, quote.id, follow.id, exp.id, sign.id],
  );
  assert.equal(sections.acceptedEstimates.items[0].locator, quote.slug);
  assert.equal(sections.marketingExperiments.items[0].locator, campaign.id);
  assert.deepEqual(sections.financeTransactions.items[0].tools, ["get_finance_transaction"]);
  assert.deepEqual(sections.revenueFollowUps.items[0].tools, ["get_activity", "list_follow_ups"]);
  assert.match(sections.acceptedEstimates.items[0].reason, /Member converts/);
  assert.match(sections.signatureExpirations.items[0].reason, /separate sending authority/);
  const serialized = JSON.stringify(sections);
  for (const secret of [
    "Private",
    "private.pdf",
    "private/storage",
    "example.test",
    "tokenHash",
    "originalStorageKey",
    "documentText",
    "bodyText",
  ]) {
    assert.equal(serialized.includes(secret), false, secret);
  }
});

test("rows from another company do not consume any source limit", async () => {
  await grants();
  for (let n = 0; n < PROACTIVE_SECTION_LIMIT + 2; n++) await allRows(randomUUID());
  const own = await allRows();
  const sections = await read();
  assert.deepEqual(
    Object.values(sections).map((section) => section.items.map((item) => item.id)),
    own.map((row) => [row.id]),
  );
  assert.ok(Object.values(sections).every((section) => !section.truncated));
});

test("finance cues exclude reviewed or future transactions and explain the current review capability", async () => {
  await grants();
  const due = await transaction({ date: now });
  await transaction({ reviewStatus: "ai_reviewed" });
  await transaction({ reviewStatus: "approved" });
  await transaction({ date: day(1) });
  assert.deepEqual(
    (await read()).financeTransactions.items.map((item) => item.id),
    [due.id],
  );
  assert.match((await read()).financeTransactions.items[0].reason, /requires Full Finance/);
  await AppDataSource.getRepository(EmployeeFinanceGrant).update(
    { employeeId: employee.id },
    { accessLevel: "full" },
  );
  assert.doesNotMatch((await read()).financeTransactions.items[0].reason, /requires Full Finance/);
  assert.match((await read()).financeTransactions.items[0].reason, /approval stays with a Member/);
});

test("accepted estimates require a current active Customer and no recorded conversion", async () => {
  await grants();
  const valid = await estimate();
  for (const status of ["draft", "sent", "declined", "void"] as const) await estimate({ status });
  await estimate({ invoiceId: randomUUID() });
  await estimate({ convertedAt: day(-1) });
  await estimate({ acceptedAt: null });
  await estimate({ acceptedAt: day(1) });
  await estimate({ customerId: randomUUID() });
  const archived = await insert(Customer, {
    companyId,
    name: "Archived",
    slug: randomUUID(),
    archivedAt: day(-1),
  });
  await estimate({ customerId: archived.id });
  const foreign = await insert(Customer, {
    companyId: randomUUID(),
    name: "Other",
    slug: randomUUID(),
  });
  await estimate({ customerId: foreign.id });
  assert.deepEqual(
    (await read()).acceptedEstimates.items.map((item) => item.id),
    [valid.id],
  );
});

test("Revenue cues require an assigned open Follow-up with a due date", async () => {
  await grants();
  const due = await followUp({ dueAt: now });
  await followUp({ dueAt: day(1) });
  await followUp({ dueAt: null });
  await followUp({ assignedEmployeeId: randomUUID() });
  await followUp({ assignedEmployeeId: null });
  await followUp({ kind: "note" });
  await followUp({ taskStatus: "completed" });
  await followUp({ taskStatus: "cancelled" });
  assert.deepEqual(
    (await read()).revenueFollowUps.items.map((item) => item.id),
    [due.id],
  );
});

test("Revenue cues omit archived, closed, foreign and deleted linked resources before limiting", async () => {
  await grants();
  const deal = await insert(Deal, {
    companyId,
    title: "Closed",
    stageId: randomUUID(),
    status: "won",
  });
  const contact = await insert(Contact, {
    companyId,
    name: "Archived",
    email: "hidden@example.test",
    archivedAt: day(-1),
  });
  const partnership = await insert(Partnership, { companyId: randomUUID(), name: "Foreign" });
  const archivedCustomer = await insert(Customer, {
    companyId,
    name: "Archived",
    slug: randomUUID(),
    archivedAt: day(-1),
  });
  const indirectDeal = await insert(Deal, {
    companyId,
    title: "Archived account",
    stageId: randomUUID(),
    customerId: archivedCustomer.id,
  });
  for (let n = 0; n < PROACTIVE_SECTION_LIMIT + 1; n++) {
    await followUp({ dealId: deal.id });
    await followUp({ contactId: contact.id });
    await followUp({ partnershipId: partnership.id });
    await followUp({ customerId: randomUUID() });
    await followUp({ dealId: indirectDeal.id });
  }
  const valid = await followUp({ customerId: customer.id });
  assert.deepEqual((await read()).revenueFollowUps, {
    items: [
      {
        id: valid.id,
        kind: "revenue_follow_up_due",
        title: valid.subject,
        reason:
          "Your open Follow-up is due. Read its linked records and existing work before completing or rescheduling it; sending remains separately authorized.",
        dueAt: valid.dueAt!.toISOString(),
        tools: ["get_activity", "list_follow_ups"],
      },
    ],
    truncated: false,
  });
});

test("Marketing cues require an owned active Campaign and an explicitly elapsed running Experiment", async () => {
  await grants();
  const due = await experiment({ endsAt: now });
  await experiment({ endsAt: null });
  await experiment({ endsAt: day(1) });
  await experiment({ startsAt: day(1) });
  for (const status of ["draft", "decided", "stopped"] as const) await experiment({ status });
  await experiment({ campaignId: randomUUID() });
  for (const values of [
    { ownerEmployeeId: randomUUID() },
    { ownerEmployeeId: null },
    { status: "paused" as const },
    { status: "archived" as const },
    { companyId: randomUUID() },
  ]) {
    const other = await insert(MarketingCampaign, {
      companyId,
      name: "Other",
      objective: "sales",
      status: "active",
      ownerEmployeeId: employee.id,
      ...values,
    });
    await experiment({ campaignId: other.id });
  }
  assert.deepEqual(
    (await read()).marketingExperiments.items.map((item) => item.id),
    [due.id],
  );
});

test("signing cues include only sent live envelopes inside the seven-day expiry window", async () => {
  await grants();
  const included: string[] = [];
  for (const expiresAt of [day(0.01), day(7)]) {
    const row = await envelope({ expiresAt, status: "in_progress" });
    await recipient(row.id);
    included.push(row.id);
  }
  for (const values of [
    { expiresAt: day(-1) },
    { expiresAt: now },
    { expiresAt: day(8) },
    { expiresAt: null },
    { sentAt: null },
    { sentAt: day(1) },
    ...(["draft", "completed", "declined", "voided", "expired"] as const).map((status) => ({
      status,
    })),
  ]) {
    const row = await envelope(values);
    await recipient(row.id);
  }
  assert.deepEqual(
    (await read()).signatureExpirations.items.map((item) => item.id),
    included,
  );
});

test("signing cues require a pending same-company signer and never duplicate an envelope", async () => {
  await grants();
  const pending = await envelope();
  await recipient(pending.id, { status: "waiting" });
  await recipient(pending.id, { status: "viewed" });
  for (const values of [
    { role: "copy" as const },
    { status: "completed" as const },
    { status: "declined" as const },
    { companyId: randomUUID() },
  ]) {
    const row = await envelope();
    await recipient(row.id, values);
  }
  await envelope();
  assert.deepEqual(
    (await read()).signatureExpirations.items.map((item) => item.id),
    [pending.id],
  );
});

test("all sources sort oldest due work first, cap after filtering, and report truncation", async () => {
  await grants();
  const expected: string[][] = [[], [], [], [], []];
  for (let n = 0; n < PROACTIVE_SECTION_LIMIT + 2; n++) {
    const rows = await Promise.all([
      transaction({ date: day(-n) }),
      estimate({ acceptedAt: day(-n) }),
      followUp({ dueAt: day(-n) }),
      experiment({ endsAt: day(-n) }),
      envelope({ expiresAt: day(7 - n) }),
    ]);
    await recipient(rows[4].id);
    rows.forEach((row, index) => expected[index].unshift(row.id));
  }
  const sections = await read();
  Object.values(sections).forEach((section, index) => {
    assert.equal(section.items.length, PROACTIVE_SECTION_LIMIT);
    assert.equal(section.truncated, true);
    assert.deepEqual(
      section.items.map((item) => item.id),
      expected[index].slice(0, PROACTIVE_SECTION_LIMIT),
    );
  });
});

test("equal-date limits use stable ID ordering and exact-limit queues are not truncated", async () => {
  await grants();
  const ids: string[] = [];
  for (let n = 0; n < PROACTIVE_SECTION_LIMIT; n++) ids.push((await followUp()).id);
  const result = (await read()).revenueFollowUps;
  assert.deepEqual(
    result.items.map((item) => item.id),
    ids.sort(),
  );
  assert.equal(result.truncated, false);
  assert.deepEqual((await read()).revenueFollowUps, result);
});

test("freeform labels are bounded and redact credential-shaped material before clipping", async () => {
  await grants();
  await followUp({ subject: `api_key=private-secret ${"x".repeat(500)}` });
  await experiment({ name: `token=campaign-secret ${"x".repeat(500)}` });
  await estimate({ number: `password=quote-secret ${"x".repeat(500)}` });
  const sign = await envelope({ title: `access_token=signature-secret ${"x".repeat(500)}` });
  await recipient(sign.id);
  const sections = await read();
  for (const section of Object.values(sections)) {
    for (const item of section.items) {
      assert.ok(item.title.length <= 120);
      assert.doesNotMatch(
        item.title,
        /private-secret|campaign-secret|quote-secret|signature-secret/,
      );
    }
  }
});
