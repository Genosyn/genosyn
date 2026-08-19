import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../../db/datasource.js";
import { Activity } from "../../db/entities/Activity.js";
import { Contact } from "../../db/entities/Contact.js";
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
    assert.equal(result.activities, 1);

    const rows = await AppDataSource.getRepository(Activity).find({ where: { companyId: CO } });
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
    assert.equal(await AppDataSource.getRepository(Activity).count(), 0);

    // It still records that the pass ran, so it is not retried forever.
    const after = await AppDataSource.getRepository(Meeting).findOneByOrFail({ id: meeting.id });
    assert.ok(after.linkedAt);
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
    assert.equal(await AppDataSource.getRepository(Activity).count(), 2);
  });

  test("is idempotent — re-running writes nothing twice", async () => {
    await insert(Contact, { companyId: CO, email: "buyer@customer.test", name: "Buyer" });
    const meeting = await meetingWith([{ email: "buyer@customer.test" }]);

    await linkMeeting(CO, meeting.id);
    const second = await linkMeeting(CO, meeting.id);

    assert.equal(second.activities, 0, "a re-run must report no fresh writes");
    assert.equal(await AppDataSource.getRepository(Activity).count(), 1);
  });

  test("picks up a Contact created after the call, which mail linking cannot", async () => {
    const meeting = await meetingWith([{ email: "late@customer.test" }]);
    await linkMeeting(CO, meeting.id);
    assert.equal(await AppDataSource.getRepository(Activity).count(), 0);

    await insert(Contact, { companyId: CO, email: "late@customer.test", name: "Late" });
    const second = await linkMeeting(CO, meeting.id);
    assert.equal(second.matched, 1);
    assert.equal(await AppDataSource.getRepository(Activity).count(), 1);
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
    assert.equal(await AppDataSource.getRepository(Activity).count(), 0);
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

    const row = await AppDataSource.getRepository(Activity).findOneByOrFail({ companyId: CO });
    assert.equal(row.bodyText, "They want SSO before signing.");
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
