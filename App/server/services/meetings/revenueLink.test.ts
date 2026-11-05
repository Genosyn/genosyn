import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../../db/datasource.js";
import { Activity } from "../../db/entities/Activity.js";
import { Contact } from "../../db/entities/Contact.js";
import { Customer } from "../../db/entities/Customer.js";
import { Deal } from "../../db/entities/Deal.js";
import { DealStage } from "../../db/entities/DealStage.js";
import { Meeting } from "../../db/entities/Meeting.js";
import { MeetingParticipant } from "../../db/entities/MeetingParticipant.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../../test/dbHarness.js";
import { linkMeeting, linkMeetingSafely } from "./revenueLink.js";

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

const CO = "co_meetings";
const OTHER_CO = "co_someone_else";

async function meetingWith(
  participants: Array<{ email: string; isInternal?: boolean }>,
  over: Partial<Meeting> = {},
): Promise<Meeting> {
  const meeting = await insert(Meeting, {
    companyId: CO,
    title: "Quarterly review",
    scheduledStartAt: new Date("2026-08-01T10:00:00.000Z"),
    status: "processing",
    transcriptText: "Priya: we want SSO.",
    ...over,
  });
  for (const row of participants) {
    await insert(MeetingParticipant, {
      companyId: CO,
      meetingId: meeting.id,
      email: row.email,
      isInternal: row.isInternal ?? false,
    });
  }
  return meeting;
}

describe("linkMeeting", () => {
  test("puts the call on a known Contact's timeline", async () => {
    const contact = await insert(Contact, {
      companyId: CO,
      email: "buyer@customer.test",
      name: "Buyer",
    });
    const meeting = await meetingWith([{ email: "buyer@customer.test" }]);

    const result = await linkMeeting(CO, meeting.id);
    assert.equal(result.matched, 1);
    assert.equal(result.activities, 2, "the Contact's row, and the new Customer's");

    const rows = (
      await AppDataSource.getRepository(Activity).find({ where: { companyId: CO } })
    ).filter((row) => row.contactId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, "meeting");
    assert.equal(rows[0].contactId, contact.id);
    assert.equal(rows[0].meetingId, meeting.id);
    // The timeline sorts by when it happened, not when we learned about it.
    assert.equal(rows[0].occurredAt.toISOString(), "2026-08-01T10:00:00.000Z");
  });

  test("never creates a Contact for a stranger — mailLink rule 1", async () => {
    const meeting = await meetingWith([
      { email: "recruiter@spam.test" },
      { email: "someone@nowhere.test" },
    ]);

    const result = await linkMeeting(CO, meeting.id);
    assert.equal(result.matched, 0);
    assert.equal(await AppDataSource.getRepository(Contact).count(), 0);

    // It still records that the pass ran, so it is not retried forever.
    const after = await AppDataSource.getRepository(Meeting).findOneByOrFail({ id: meeting.id });
    assert.ok(after.linkedAt);
  });

  test("puts a call with no known Contact on its new Customer's timeline", async () => {
    const meeting = await meetingWith([{ email: "someone@nowhere.test" }]);

    const result = await linkMeeting(CO, meeting.id);

    const customer = await AppDataSource.getRepository(Customer).findOneByOrFail({
      companyId: CO,
    });
    assert.equal(customer.domain, "nowhere.test");
    assert.equal(result.customerId, customer.id);
    assert.equal(result.activities, 1);
    const [row] = await AppDataSource.getRepository(Activity).find({ where: { companyId: CO } });
    assert.equal(row.kind, "meeting");
    assert.equal(row.customerId, customer.id);
    assert.equal(row.contactId, null);
    assert.equal(row.meetingId, meeting.id);
    assert.equal(row.occurredAt.toISOString(), "2026-08-01T10:00:00.000Z");
  });

  test("a meeting of colleagues reaches no timeline and starts no Customer", async () => {
    const meeting = await meetingWith([{ email: "colleague@ourco.test", isInternal: true }]);

    const result = await linkMeeting(CO, meeting.id);

    assert.equal(result.customerId, null);
    assert.equal(result.activities, 0);
    assert.equal(await AppDataSource.getRepository(Customer).count(), 0);
    assert.equal(await AppDataSource.getRepository(Activity).count(), 0);
  });

  test("writes one row per known Contact on the call", async () => {
    await insert(Contact, { companyId: CO, email: "a@customer.test", name: "A" });
    await insert(Contact, { companyId: CO, email: "b@customer.test", name: "B" });
    const meeting = await meetingWith([
      { email: "a@customer.test" },
      { email: "b@customer.test" },
      { email: "stranger@nowhere.test" },
    ]);

    const result = await linkMeeting(CO, meeting.id);
    assert.equal(result.matched, 2);
    const rows = await AppDataSource.getRepository(Activity).find({ where: { companyId: CO } });
    assert.equal(rows.filter((row) => row.contactId).length, 2);
  });

  test("one account row is enough when a Contact's row already reaches the account", async () => {
    const customer = await insert(Customer, { companyId: CO, name: "Acme", slug: "acme" });
    await insert(Contact, {
      companyId: CO,
      email: "buyer@customer.test",
      name: "Buyer",
      customerId: customer.id,
    });
    const meeting = await meetingWith([{ email: "buyer@customer.test" }]);

    await linkMeeting(CO, meeting.id);

    const rows = await AppDataSource.getRepository(Activity).find({ where: { companyId: CO } });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].customerId, customer.id);
    assert.ok(rows[0].contactId);
  });

  test("is idempotent — re-running writes nothing twice", async () => {
    await insert(Contact, { companyId: CO, email: "buyer@customer.test", name: "Buyer" });
    const meeting = await meetingWith([{ email: "buyer@customer.test" }]);

    await linkMeeting(CO, meeting.id);
    const count = await AppDataSource.getRepository(Activity).count();
    const second = await linkMeeting(CO, meeting.id);

    assert.equal(second.activities, 0, "a re-run must report no fresh writes");
    assert.equal(await AppDataSource.getRepository(Activity).count(), count);
  });

  test("picks up a Contact created after the call, which mail linking cannot", async () => {
    const meeting = await meetingWith([{ email: "late@customer.test" }]);
    await linkMeeting(CO, meeting.id);
    const contactRows = () =>
      AppDataSource.getRepository(Activity)
        .find({ where: { companyId: CO } })
        .then((rows) => rows.filter((row) => row.contactId).length);
    assert.equal(await contactRows(), 0);

    await insert(Contact, { companyId: CO, email: "late@customer.test", name: "Late" });
    const second = await linkMeeting(CO, meeting.id);
    assert.equal(second.matched, 1);
    assert.equal(await contactRows(), 1);
  });

  test("files the call on a Deal of a Customer found without any Contact", async () => {
    const customer = await insert(Customer, {
      companyId: CO,
      name: "Acme",
      slug: "acme",
      domain: "acme.test",
    });
    const stage = await insert(DealStage, {
      companyId: CO,
      name: "Discovery",
      slug: "discovery",
      sortOrder: 0,
      probability: 10,
    });
    const deal = await insert(Deal, {
      companyId: CO,
      title: "Live one",
      customerId: customer.id,
      stageId: stage.id,
      status: "open",
    });
    const meeting = await meetingWith([{ email: "someone@acme.test" }]);

    const result = await linkMeeting(CO, meeting.id);

    assert.equal(result.dealId, deal.id);
    assert.equal(result.customerId, customer.id);
  });

  test("resolves the account and prefers an open Deal", async () => {
    const contact = await insert(Contact, {
      companyId: CO,
      email: "buyer@customer.test",
      name: "Buyer",
      customerId: "cus_1",
    });
    const stage = await insert(DealStage, {
      companyId: CO,
      name: "Discovery",
      slug: "discovery",
      sortOrder: 0,
      probability: 10,
    });
    await insert(Deal, {
      companyId: CO,
      title: "Closed one",
      primaryContactId: contact.id,
      customerId: "cus_1",
      stageId: stage.id,
      status: "lost",
    });
    const open = await insert(Deal, {
      companyId: CO,
      title: "Live one",
      primaryContactId: contact.id,
      customerId: "cus_1",
      stageId: stage.id,
      status: "open",
    });
    const meeting = await meetingWith([{ email: "buyer@customer.test" }]);

    const result = await linkMeeting(CO, meeting.id);
    assert.equal(result.customerId, "cus_1");
    assert.equal(result.dealId, open.id);

    const stored = await AppDataSource.getRepository(Meeting).findOneByOrFail({ id: meeting.id });
    assert.equal(stored.dealId, open.id);
    assert.equal(stored.customerId, "cus_1");
  });

  test("does not match a Contact belonging to another company", async () => {
    await insert(Contact, { companyId: OTHER_CO, email: "buyer@customer.test", name: "Theirs" });
    const meeting = await meetingWith([{ email: "buyer@customer.test" }]);

    const result = await linkMeeting(CO, meeting.id);
    assert.equal(result.matched, 0);
    const rows = await AppDataSource.getRepository(Activity).find({ where: { companyId: CO } });
    assert.ok(rows.every((row) => !row.contactId));
  });

  test("stamps the resolved Contact onto the participant row", async () => {
    const contact = await insert(Contact, {
      companyId: CO,
      email: "buyer@customer.test",
      name: "Buyer",
    });
    const meeting = await meetingWith([{ email: "buyer@customer.test" }]);
    await linkMeeting(CO, meeting.id);

    const participant = await AppDataSource.getRepository(MeetingParticipant).findOneByOrFail({
      meetingId: meeting.id,
      email: "buyer@customer.test",
    });
    assert.equal(participant.contactId, contact.id);
  });

  test("carries the AI summary onto the timeline once it exists", async () => {
    await insert(Contact, { companyId: CO, email: "buyer@customer.test", name: "Buyer" });
    const meeting = await meetingWith([{ email: "buyer@customer.test" }], {
      summaryText: "They want SSO before signing.",
    });
    await linkMeeting(CO, meeting.id);

    const rows = await AppDataSource.getRepository(Activity).find({ where: { companyId: CO } });
    assert.ok(rows.length > 0);
    for (const row of rows) assert.equal(row.bodyText, "They want SSO before signing.");
  });

  test("a missing meeting is a no-op, not a throw", async () => {
    const result = await linkMeeting(CO, "00000000-0000-0000-0000-000000000000");
    assert.equal(result.matched, 0);
  });

  test("linkMeetingSafely swallows failures so a CRM bug cannot break a transcript", async () => {
    const result = await linkMeetingSafely(CO, "not-a-uuid-at-all");
    // Either a clean zero result or null — never a rejection.
    assert.ok(result === null || result.matched === 0);
  });
});
