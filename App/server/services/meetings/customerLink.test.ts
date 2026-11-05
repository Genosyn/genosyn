import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../../db/datasource.js";
import { Activity } from "../../db/entities/Activity.js";
import { AuditEvent } from "../../db/entities/AuditEvent.js";
import { CalendarAccount } from "../../db/entities/CalendarAccount.js";
import { CalendarEvent } from "../../db/entities/CalendarEvent.js";
import { CompanyFinanceSettings } from "../../db/entities/CompanyFinanceSettings.js";
import { Contact } from "../../db/entities/Contact.js";
import { Customer } from "../../db/entities/Customer.js";
import { CustomerContact } from "../../db/entities/CustomerContact.js";
import { Deal } from "../../db/entities/Deal.js";
import { DealStage } from "../../db/entities/DealStage.js";
import { Meeting } from "../../db/entities/Meeting.js";
import { MeetingParticipant } from "../../db/entities/MeetingParticipant.js";
import { Membership } from "../../db/entities/Membership.js";
import { RevenueOperation } from "../../db/entities/RevenueOperation.js";
import { User } from "../../db/entities/User.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../../test/dbHarness.js";
import { mergeRevenueAccounts, previewRevenueAccountMerge } from "../revenue/accounts.js";
import { rollbackRevenueOperation } from "../revenue/operations.js";
import { linkMeetingCustomer } from "./customerLink.js";
import { linkMeeting, setMeetingCustomer } from "./revenueLink.js";
import { addParticipants, armMeetingsForAccount, createAdHocMeeting, pageMeetings } from "./store.js";

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

const CO = "co_meetings";
const OTHER_CO = "co_someone_else";

const customers = () => AppDataSource.getRepository(Customer).find({ where: { companyId: CO } });

async function reload(meetingId: string): Promise<Meeting> {
  return AppDataSource.getRepository(Meeting).findOneByOrFail({ id: meetingId });
}

async function meetingWith(
  attendees: string[],
  over: Partial<Meeting> = {},
  organizer?: string,
): Promise<Meeting> {
  const meeting = await insert(Meeting, {
    companyId: CO,
    title: "Quarterly review",
    scheduledStartAt: new Date("2026-08-01T10:00:00.000Z"),
    status: "scheduled",
    ...over,
  });
  for (const email of attendees) {
    await insert(MeetingParticipant, {
      companyId: CO,
      meetingId: meeting.id,
      email,
      isOrganizer: email === organizer,
    });
  }
  return meeting;
}

/** A Member signing in at this address, which is how a company proves a domain is its own. */
async function member(email: string): Promise<User> {
  const user = await insert(User, { email, name: email, passwordHash: "x" });
  await insert(Membership, { companyId: CO, userId: user.id, role: "member" });
  return user;
}

describe("creating a Customer from a meeting", () => {
  test("creates a prospect named from the domain and links the meeting", async () => {
    const meeting = await meetingWith(["sam@acme-corp.co.uk"]);

    const result = await linkMeetingCustomer(CO, meeting.id);

    assert.equal(result.created, true);
    const [customer] = await customers();
    assert.equal(customer.name, "Acme Corp");
    assert.equal(customer.domain, "acme-corp.co.uk");
    assert.equal(customer.accountStatus, "prospect");
    // A billing email is for billing. Nothing here says who pays the invoices.
    assert.equal(customer.email, "");
    assert.equal((await reload(meeting.id)).customerId, customer.id);
  });

  test("never creates a Contact", async () => {
    const meeting = await meetingWith(["sam@acme.test", "priya@acme.test"]);
    await linkMeetingCustomer(CO, meeting.id);
    assert.equal(await AppDataSource.getRepository(Contact).count(), 0);
  });

  test("a subdomain starts an account on the registered domain", async () => {
    const meeting = await meetingWith(["sam@eu.acme.com"]);
    await linkMeetingCustomer(CO, meeting.id);
    assert.equal((await customers())[0].domain, "acme.com");
  });

  test("a tenant host keeps the tenant, so two companies never share one account", async () => {
    const one = await meetingWith(["sam@contoso.onmicrosoft.com"]);
    const two = await meetingWith(["pat@fabrikam.onmicrosoft.com"]);
    await linkMeetingCustomer(CO, one.id);
    await linkMeetingCustomer(CO, two.id);

    const rows = await customers();
    assert.deepEqual(rows.map((row) => row.name).sort(), ["Contoso", "Fabrikam"]);
    assert.notEqual((await reload(one.id)).customerId, (await reload(two.id)).customerId);
  });

  test("a suffix registries sell under is never one company", async () => {
    const one = await meetingWith(["sam@acme.ltd.uk"]);
    const two = await meetingWith(["pat@other.ltd.uk"]);
    await linkMeetingCustomer(CO, one.id);
    await linkMeetingCustomer(CO, two.id);

    const rows = await customers();
    assert.deepEqual(rows.map((row) => row.domain).sort(), ["acme.ltd.uk", "other.ltd.uk"]);
    assert.ok(rows.some((row) => row.name === "Acme"));
  });

  test("everyone at a consumer ISP is their own person", async () => {
    const one = await meetingWith(["a@comcast.net"]);
    const two = await meetingWith(["b@comcast.net"]);
    await linkMeetingCustomer(CO, one.id);
    await linkMeetingCustomer(CO, two.id);
    assert.deepEqual((await customers()).map((row) => row.domain), ["", ""]);
  });

  test("free mail starts an account for that one person, named by address", async () => {
    const meeting = await meetingWith(["Priya.Sharma@gmail.com".toLowerCase()]);
    await linkMeetingCustomer(CO, meeting.id);

    const [customer] = await customers();
    assert.equal(customer.name, "priya.sharma@gmail.com");
    assert.equal(customer.email, "priya.sharma@gmail.com");
    // A domain here would claim every Gmail user on Earth.
    assert.equal(customer.domain, "");
  });

  test("two free-mail attendees are two people, and the second is found again", async () => {
    const first = await meetingWith(["a@gmail.com"]);
    const second = await meetingWith(["b@gmail.com"]);
    const third = await meetingWith(["a@gmail.com"]);
    await linkMeetingCustomer(CO, first.id);
    await linkMeetingCustomer(CO, second.id);
    await linkMeetingCustomer(CO, third.id);

    assert.equal((await customers()).length, 2);
    assert.equal((await reload(first.id)).customerId, (await reload(third.id)).customerId);
    assert.notEqual((await reload(first.id)).customerId, (await reload(second.id)).customerId);
  });

  test("uses the company's home currency when it has one", async () => {
    await insert(CompanyFinanceSettings, { companyId: CO, homeCurrency: "EUR" });
    const meeting = await meetingWith(["sam@acme.test"]);
    await linkMeetingCustomer(CO, meeting.id);
    assert.equal((await customers())[0].currency, "EUR");
  });

  test("creates only one, for the company with the most people on the call", async () => {
    const meeting = await meetingWith([
      "a@small.test",
      "b@big.test",
      "c@big.test",
      "d@gmail.com",
    ]);
    await linkMeetingCustomer(CO, meeting.id);

    const rows = await customers();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].domain, "big.test");
    assert.equal((await reload(meeting.id)).customerId, rows[0].id);
  });

  test("a company beats a free-mail address on a tie", async () => {
    const meeting = await meetingWith(["a@gmail.com", "z@zeta.test"]);
    await linkMeetingCustomer(CO, meeting.id);
    assert.equal((await customers())[0].domain, "zeta.test");
  });

  test("the organizer's company wins a tie", async () => {
    const meeting = await meetingWith(["a@alpha.test", "z@zeta.test"], {}, "z@zeta.test");
    await linkMeetingCustomer(CO, meeting.id);
    assert.equal((await customers())[0].domain, "zeta.test");
  });

  test("records who made the customer and why, on both records", async () => {
    const meeting = await meetingWith(["sam@acme.test"]);
    await linkMeetingCustomer(CO, meeting.id);

    const [customer] = await customers();
    const audits = await AppDataSource.getRepository(AuditEvent).find({ where: { companyId: CO } });
    const created = audits.find((row) => row.targetId === customer.id);
    assert.equal(created?.action, "customer.create");
    assert.equal(created?.actorKind, "system");
    const linked = audits.find((row) => row.targetId === meeting.id);
    assert.equal(linked?.action, "meeting.customer.link");
  });

  test("the Customer's creator is whoever made the meeting", async () => {
    const user = await member("me@gmail.com");
    const meeting = await meetingWith(["sam@acme.test"], { createdByUserId: user.id });
    await linkMeetingCustomer(CO, meeting.id);
    assert.equal((await customers())[0].createdById, user.id);
  });

  test("two passes racing for one new company leave one Customer", async () => {
    const one = await meetingWith(["sam@acme.test"]);
    const two = await meetingWith(["pat@acme.test"]);
    await Promise.all([linkMeetingCustomer(CO, one.id), linkMeetingCustomer(CO, two.id)]);

    assert.equal((await customers()).length, 1);
    assert.equal((await reload(one.id)).customerId, (await reload(two.id)).customerId);
  });
});

describe("who never becomes a Customer", () => {
  test("a colleague on the company's own domain", async () => {
    await member("me@ourco.test");
    const meeting = await meetingWith(["colleague@ourco.test", "other@eu.ourco.test"]);
    const result = await linkMeetingCustomer(CO, meeting.id);

    assert.equal(result.customerId, null);
    assert.equal((await customers()).length, 0);
  });

  test("a Member on free mail, by exact address", async () => {
    await member("founder@gmail.com");
    const meeting = await meetingWith(["founder@gmail.com"]);
    await linkMeetingCustomer(CO, meeting.id);
    assert.equal((await customers()).length, 0);
  });

  test("an attendee marked internal when the meeting was made", async () => {
    const meeting = await insert(Meeting, { companyId: CO, title: "Sync" });
    await insert(MeetingParticipant, {
      companyId: CO,
      meetingId: meeting.id,
      email: "me@wasinternal.test",
      isInternal: true,
    });
    await linkMeetingCustomer(CO, meeting.id);
    assert.equal((await customers()).length, 0);
  });

  test("machines: no-reply senders, Google's calendars and notetaker bots", async () => {
    const meeting = await meetingWith([
      "noreply@calendly.test",
      "c_abc123@group.calendar.google.com",
      "fred@fireflies.ai",
    ]);
    await linkMeetingCustomer(CO, meeting.id);
    assert.equal((await customers()).length, 0);
  });

  test("a notetaker bot does not steal a tie from the real customer", async () => {
    const meeting = await meetingWith(["fred@fireflies.ai", "sam@zeta.test"]);
    await linkMeetingCustomer(CO, meeting.id);
    const rows = await customers();
    assert.deepEqual(rows.map((row) => row.domain), ["zeta.test"]);
  });

  test("a meeting with nobody on it", async () => {
    const meeting = await meetingWith([]);
    const result = await linkMeetingCustomer(CO, meeting.id);
    assert.deepEqual(result, { customerId: null, created: false });
  });

  test("another company's meeting id does nothing", async () => {
    const meeting = await meetingWith(["sam@acme.test"]);
    const result = await linkMeetingCustomer(OTHER_CO, meeting.id);
    assert.deepEqual(result, { customerId: null, created: false });
    assert.equal(await AppDataSource.getRepository(Customer).count(), 0);
  });
});

describe("finding the Customer a company already has", () => {
  const acme = () =>
    insert(Customer, { companyId: CO, name: "Acme", slug: "acme", domain: "acme.test" });

  test("a Contact's account comes first", async () => {
    await acme();
    const holdings = await insert(Customer, { companyId: CO, name: "Holdings", slug: "holdings" });
    await insert(Contact, {
      companyId: CO,
      email: "sam@acme.test",
      name: "Sam",
      customerId: holdings.id,
    });
    const meeting = await meetingWith(["sam@acme.test"]);

    const result = await linkMeetingCustomer(CO, meeting.id);

    assert.equal(result.customerId, holdings.id);
    assert.equal(result.created, false);
  });

  test("the account's own address, whatever case it was typed in", async () => {
    const customer = await insert(Customer, {
      companyId: CO,
      name: "Priya",
      slug: "priya",
      email: "Priya@Gmail.com",
    });
    const meeting = await meetingWith(["priya@gmail.com"]);
    assert.equal((await linkMeetingCustomer(CO, meeting.id)).customerId, customer.id);
    assert.equal((await customers()).length, 1);
  });

  test("a billing contact's address", async () => {
    const customer = await insert(Customer, { companyId: CO, name: "Billed", slug: "billed" });
    await insert(CustomerContact, {
      companyId: CO,
      customerId: customer.id,
      name: "Ana",
      email: "Ana@agency.test",
    });
    const meeting = await meetingWith(["ana@agency.test"]);
    assert.equal((await linkMeetingCustomer(CO, meeting.id)).customerId, customer.id);
  });

  test("an account on the attendee's domain, subdomains included", async () => {
    const customer = await acme();
    const meeting = await meetingWith(["sam@eu.acme.test"]);
    assert.equal((await linkMeetingCustomer(CO, meeting.id)).customerId, customer.id);
    assert.equal((await customers()).length, 1);
  });

  test("the most specific domain wins", async () => {
    await acme();
    const europe = await insert(Customer, {
      companyId: CO,
      name: "Acme Europe",
      slug: "acme-eu",
      domain: "eu.acme.test",
    });
    const meeting = await meetingWith(["sam@eu.acme.test"]);
    assert.equal((await linkMeetingCustomer(CO, meeting.id)).customerId, europe.id);
  });

  test("a known company beats a bigger group nobody knows, and creates nothing", async () => {
    const customer = await acme();
    const meeting = await meetingWith(["sam@acme.test", "a@unknown.test", "b@unknown.test"]);
    assert.equal((await linkMeetingCustomer(CO, meeting.id)).customerId, customer.id);
    assert.equal((await customers()).length, 1);
  });

  test("the account most attendees belong to", async () => {
    await acme();
    const beta = await insert(Customer, {
      companyId: CO,
      name: "Beta",
      slug: "beta",
      domain: "beta.test",
    });
    const meeting = await meetingWith(["a@acme.test", "b@beta.test", "c@beta.test"]);
    assert.equal((await linkMeetingCustomer(CO, meeting.id)).customerId, beta.id);
  });

  test("never matches another company's Customer", async () => {
    await insert(Customer, {
      companyId: OTHER_CO,
      name: "Theirs",
      slug: "theirs",
      domain: "acme.test",
    });
    const meeting = await meetingWith(["sam@acme.test"]);
    const result = await linkMeetingCustomer(CO, meeting.id);
    assert.equal(result.created, true);
    const [ours] = await customers();
    assert.equal(ours.id, result.customerId);
  });

  test("a Customer on a free-mail domain does not claim every user of it", async () => {
    await insert(Customer, {
      companyId: CO,
      name: "Mislabelled",
      slug: "mislabelled",
      domain: "gmail.com",
    });
    const meeting = await meetingWith(["stranger@gmail.com"]);
    const result = await linkMeetingCustomer(CO, meeting.id);
    assert.equal(result.created, true);
    assert.equal((await customers()).length, 2);
  });

  test("the company's own domain does not match a Customer on it", async () => {
    await member("me@ourco.test");
    await insert(Customer, { companyId: CO, name: "Us", slug: "us", domain: "ourco.test" });
    const meeting = await meetingWith(["colleague@ourco.test"]);
    assert.equal((await linkMeetingCustomer(CO, meeting.id)).customerId, null);
  });
});

describe("archived and merged accounts", () => {
  test("an archived account stops the next meeting recreating it", async () => {
    const archived = await insert(Customer, {
      companyId: CO,
      name: "Junk",
      slug: "junk",
      domain: "junk.test",
      archivedAt: new Date(),
    });
    const meeting = await meetingWith(["sam@junk.test"]);

    const result = await linkMeetingCustomer(CO, meeting.id);

    assert.equal(result.customerId, archived.id);
    assert.equal(result.created, false);
    assert.equal((await customers()).length, 1);
  });

  test("an active account beats an archived one on the same domain", async () => {
    await insert(Customer, {
      companyId: CO,
      name: "Old",
      slug: "old",
      domain: "acme.test",
      archivedAt: new Date(),
    });
    const active = await insert(Customer, {
      companyId: CO,
      name: "New",
      slug: "new",
      domain: "acme.test",
    });
    const meeting = await meetingWith(["sam@acme.test"]);
    assert.equal((await linkMeetingCustomer(CO, meeting.id)).customerId, active.id);
  });

  test("a merged-away account hands over to its survivor", async () => {
    const survivor = await insert(Customer, { companyId: CO, name: "Survivor", slug: "survivor" });
    const merged = await insert(Customer, {
      companyId: CO,
      name: "Merged",
      slug: "merged",
      domain: "merged.test",
      archivedAt: new Date(),
    });
    await insert(RevenueOperation, {
      companyId: CO,
      kind: "merge",
      resourceType: "account",
      sourceId: merged.id,
      targetId: survivor.id,
      status: "completed",
      requestJson: "{}",
      summaryJson: "{}",
      completedAt: new Date(),
    });
    const meeting = await meetingWith(["sam@merged.test"]);
    assert.equal((await linkMeetingCustomer(CO, meeting.id)).customerId, survivor.id);
  });
});

describe("the account's timeline", () => {
  test("a Contact added later replaces the account's row, so the call reads once", async () => {
    const meeting = await meetingWith(["sam@acme.test"], { transcriptText: "Sam: hello." });
    await linkMeeting(CO, meeting.id);
    const [customer] = await customers();
    await insert(Contact, {
      companyId: CO,
      email: "sam@acme.test",
      name: "Sam",
      customerId: customer.id,
    });

    await linkMeeting(CO, meeting.id);

    const rows = await AppDataSource.getRepository(Activity).find({
      where: { companyId: CO, meetingId: meeting.id },
    });
    assert.equal(rows.length, 1);
    assert.ok(rows[0].contactId);
  });

  test("the row picks up the summary once there is one", async () => {
    const meeting = await meetingWith(["sam@acme.test"], { transcriptText: "Sam: hello." });
    await linkMeeting(CO, meeting.id);
    await AppDataSource.getRepository(Meeting).update(
      { id: meeting.id },
      { summaryText: "They want SSO." },
    );

    const again = await linkMeeting(CO, meeting.id);

    assert.equal(again.activities, 0);
    const [row] = await AppDataSource.getRepository(Activity).find({
      where: { companyId: CO, meetingId: meeting.id },
    });
    assert.equal(row.bodyText, "They want SSO.");
  });

  test("a customer's meeting list includes calls its Contacts attended", async () => {
    const beta = await insert(Customer, { companyId: CO, name: "Beta", slug: "beta" });
    const contact = await insert(Contact, {
      companyId: CO,
      email: "b@beta.test",
      name: "B",
      customerId: beta.id,
    });
    const acme = await insert(Customer, { companyId: CO, name: "Acme", slug: "acme" });
    const meeting = await insert(Meeting, {
      companyId: CO,
      title: "Three-way",
      customerId: acme.id,
    });
    await insert(MeetingParticipant, {
      companyId: CO,
      meetingId: meeting.id,
      email: "b@beta.test",
      contactId: contact.id,
    });

    const page = await pageMeetings(CO, { customerId: beta.id }, "all", {}, (row) => row.id);

    assert.deepEqual(page.rows, [meeting.id]);
  });
});

describe("merging accounts", () => {
  test("takes the meetings along, and undoing the merge brings them back", async () => {
    const source = await insert(Customer, { companyId: CO, name: "Dupe", slug: "dupe" });
    const target = await insert(Customer, { companyId: CO, name: "Keeper", slug: "keeper" });
    const meeting = await insert(Meeting, {
      companyId: CO,
      title: "Review",
      customerId: source.id,
    });

    const preview = await previewRevenueAccountMerge(CO, source.id, target.id);
    assert.equal(preview.counts.meetings, 1);

    const merged = await mergeRevenueAccounts(CO, source.id, target.id, source.name);
    assert.equal((await reload(meeting.id)).customerId, target.id);

    await rollbackRevenueOperation(CO, merged.operationId!);
    assert.equal((await reload(meeting.id)).customerId, source.id);
  });
});

describe("staying linked", () => {
  test("re-running creates nothing and changes nothing", async () => {
    const meeting = await meetingWith(["sam@acme.test"]);
    const first = await linkMeetingCustomer(CO, meeting.id);
    const second = await linkMeetingCustomer(CO, meeting.id);

    assert.equal(second.customerId, first.customerId);
    assert.equal(second.created, false);
    assert.equal((await customers()).length, 1);
  });

  test("a linked meeting whose attendees stop matching never starts a second account", async () => {
    const meeting = await meetingWith(["sam@acme.test"]);
    const { customerId } = await linkMeetingCustomer(CO, meeting.id);
    // A Member corrected the domain, so nothing on the meeting points at it now.
    await AppDataSource.getRepository(Customer).update({ id: customerId! }, { domain: "acme.example" });

    const again = await linkMeetingCustomer(CO, meeting.id);

    assert.equal(again.customerId, customerId);
    assert.equal((await customers()).length, 1);
  });

  test("moves to an existing account the attendees now point at, timeline row with it", async () => {
    const meeting = await meetingWith(["sam@acme.test"], { transcriptText: "Sam: hello." });
    await linkMeeting(CO, meeting.id);
    const [created] = await customers();
    const betterMatch = await insert(Customer, { companyId: CO, name: "Parent", slug: "parent" });
    await insert(Contact, {
      companyId: CO,
      email: "sam@acme.test",
      name: "Sam",
      customerId: betterMatch.id,
    });

    await linkMeetingCustomer(CO, meeting.id);

    assert.equal((await reload(meeting.id)).customerId, betterMatch.id);
    const rows = await AppDataSource.getRepository(Activity).find({
      where: { companyId: CO, meetingId: meeting.id },
    });
    assert.ok(rows.every((row) => row.customerId !== created.id));
  });
});

describe("a Member's choice is final", () => {
  const chosen = async (attendees: string[], customerId: string | null) => {
    const meeting = await meetingWith(attendees);
    await setMeetingCustomer(CO, meeting.id, customerId);
    return meeting;
  };

  test("the passes leave a chosen customer alone", async () => {
    const mine = await insert(Customer, { companyId: CO, name: "Mine", slug: "mine" });
    const meeting = await chosen(["sam@acme.test"], mine.id);

    const result = await linkMeetingCustomer(CO, meeting.id);

    assert.equal(result.customerId, mine.id);
    assert.equal((await customers()).length, 1, "and create nothing for the attendees");
  });

  test("a removed link stays removed, through new attendees and a re-link", async () => {
    const meeting = await chosen(["sam@acme.test"], null);

    await addParticipants(meeting, ["pat@acme.test"]);
    await linkMeeting(CO, meeting.id);

    assert.equal((await reload(meeting.id)).customerId, null);
    assert.equal((await customers()).length, 0);
  });

  test("choosing another customer moves the account's timeline row", async () => {
    const meeting = await meetingWith(["sam@acme.test"], { transcriptText: "Sam: hello." });
    await linkMeeting(CO, meeting.id);
    const mine = await insert(Customer, { companyId: CO, name: "Mine", slug: "mine" });

    await setMeetingCustomer(CO, meeting.id, mine.id);

    const rows = await AppDataSource.getRepository(Activity).find({
      where: { companyId: CO, meetingId: meeting.id },
    });
    assert.deepEqual(rows.map((row) => row.customerId), [mine.id]);
  });

  test("removing the link takes the account's row off the timeline", async () => {
    const meeting = await meetingWith(["sam@acme.test"], { transcriptText: "Sam: hello." });
    await linkMeeting(CO, meeting.id);

    await setMeetingCustomer(CO, meeting.id, null);

    assert.equal(await AppDataSource.getRepository(Activity).count(), 0);
  });

  test("a row on the old customer's Deal doesn't stay when the customer changes", async () => {
    const stage = await insert(DealStage, {
      companyId: CO,
      name: "Discovery",
      slug: "discovery",
      sortOrder: 0,
      probability: 10,
    });
    const old = await insert(Customer, {
      companyId: CO,
      name: "Old",
      slug: "old",
      domain: "old.test",
    });
    const deal = await insert(Deal, {
      companyId: CO,
      title: "Old deal",
      customerId: old.id,
      stageId: stage.id,
      status: "open",
    });
    const meeting = await meetingWith(["sam@old.test"], { transcriptText: "Sam: hello." });
    await linkMeeting(CO, meeting.id);
    assert.equal((await reload(meeting.id)).dealId, deal.id);
    const mine = await insert(Customer, { companyId: CO, name: "Mine", slug: "mine" });

    await setMeetingCustomer(CO, meeting.id, mine.id);

    assert.equal((await reload(meeting.id)).dealId, null);
    const rows = await AppDataSource.getRepository(Activity).find({
      where: { companyId: CO, meetingId: meeting.id },
    });
    assert.deepEqual(rows.map((row) => [row.customerId, row.dealId]), [[mine.id, null]]);
  });

  test("a chosen customer never takes another account's Deal", async () => {
    const stage = await insert(DealStage, {
      companyId: CO,
      name: "Discovery",
      slug: "discovery",
      sortOrder: 0,
      probability: 10,
    });
    const other = await insert(Customer, { companyId: CO, name: "Other", slug: "other" });
    const contact = await insert(Contact, {
      companyId: CO,
      email: "sam@other.test",
      name: "Sam",
      customerId: other.id,
    });
    await insert(Deal, {
      companyId: CO,
      title: "Their deal",
      customerId: other.id,
      primaryContactId: contact.id,
      stageId: stage.id,
      status: "open",
    });
    const mine = await insert(Customer, { companyId: CO, name: "Mine", slug: "mine" });
    const meeting = await chosen(["sam@other.test"], mine.id);

    const result = await linkMeeting(CO, meeting.id);
    assert.equal(result.dealId, null);

    await setMeetingCustomer(CO, meeting.id, null);
    assert.equal((await linkMeeting(CO, meeting.id)).dealId, null);
  });

  test("moving a meeting doesn't write a Contact's row twice", async () => {
    await insert(Contact, { companyId: CO, email: "sam@acme.test", name: "Sam" });
    const meeting = await meetingWith(["sam@acme.test"], { transcriptText: "Sam: hello." });
    await linkMeeting(CO, meeting.id);
    const mine = await insert(Customer, { companyId: CO, name: "Mine", slug: "mine" });

    await setMeetingCustomer(CO, meeting.id, mine.id);
    await linkMeeting(CO, meeting.id);

    const rows = await AppDataSource.getRepository(Activity).find({
      where: { companyId: CO, meetingId: meeting.id },
    });
    assert.equal(rows.filter((row) => row.contactId).length, 1);
  });

  test("moving a meeting with no transcript still lets go of the old Deal", async () => {
    const mine = await insert(Customer, { companyId: CO, name: "Mine", slug: "mine" });
    const meeting = await insert(Meeting, { companyId: CO, title: "Plan", dealId: "old_deal" });

    await setMeetingCustomer(CO, meeting.id, mine.id);

    assert.equal((await reload(meeting.id)).dealId, null);
  });

  test("removing the link clears a Deal that only the customer pointed at", async () => {
    const customer = await insert(Customer, { companyId: CO, name: "Acme", slug: "acme" });
    const meeting = await insert(Meeting, {
      companyId: CO,
      title: "Review",
      transcriptText: "Sam: hello.",
      customerId: customer.id,
      dealId: "deal_on_acme",
    });

    await setMeetingCustomer(CO, meeting.id, null);

    assert.equal((await reload(meeting.id)).dealId, null);
  });

  test("choosing a customer on a transcribed meeting writes its timeline row", async () => {
    const mine = await insert(Customer, { companyId: CO, name: "Mine", slug: "mine" });
    const meeting = await chosen([], null);
    await AppDataSource.getRepository(Meeting).update(
      { id: meeting.id },
      { transcriptText: "Sam: hello." },
    );

    await setMeetingCustomer(CO, meeting.id, mine.id);

    const rows = await AppDataSource.getRepository(Activity).find({
      where: { companyId: CO, meetingId: meeting.id },
    });
    assert.deepEqual(rows.map((row) => row.customerId), [mine.id]);
  });

  test("refuses another company's customer", async () => {
    const theirs = await insert(Customer, { companyId: OTHER_CO, name: "Theirs", slug: "theirs" });
    const meeting = await meetingWith([]);
    await assert.rejects(() => setMeetingCustomer(CO, meeting.id, theirs.id), /Customer not found/);
    assert.equal((await reload(meeting.id)).customerId, null);
  });
});

describe("when a meeting is created", () => {
  test("an ad-hoc meeting comes back linked", async () => {
    const meeting = await createAdHocMeeting({
      companyId: CO,
      title: "Intro",
      scheduledStartAt: null,
      conferenceUrl: "",
      notetakerEmployeeId: null,
      createdByUserId: null,
      attendeeEmails: ["sam@acme.test"],
    });
    const [customer] = await customers();
    assert.equal(meeting.customerId, customer.id);
  });

  test("an ad-hoc meeting with no attendees has no customer", async () => {
    const meeting = await createAdHocMeeting({
      companyId: CO,
      title: "Solo",
      scheduledStartAt: null,
      conferenceUrl: "",
      notetakerEmployeeId: null,
      createdByUserId: null,
    });
    assert.equal(meeting.customerId, null);
    assert.equal((await customers()).length, 0);
  });

  test("attendees added later link it", async () => {
    const meeting = await meetingWith([]);
    await addParticipants(meeting, ["sam@acme.test"]);
    const [customer] = await customers();
    assert.equal((await reload(meeting.id)).customerId, customer.id);
  });

  test("a meeting armed from a calendar is linked, with no timeline row before the call", async () => {
    const now = new Date("2026-08-01T09:00:00.000Z");
    const account = await insert(CalendarAccount, {
      companyId: CO,
      connectionId: "conn",
      calendarId: "primary",
      address: "me@ourco.test",
      autoRecord: "all",
      notetakerEmployeeId: "emp",
    });
    await insert(CalendarEvent, {
      companyId: CO,
      accountId: account.id,
      externalId: "evt",
      summary: "Intro",
      startAt: new Date("2026-08-01T10:00:00.000Z"),
      endAt: new Date("2026-08-01T11:00:00.000Z"),
      status: "confirmed",
      conferenceProvider: "meet",
      conferenceUrl: "https://meet.google.com/abc-defg-hij",
      organizerEmail: "me@ourco.test",
      attendeesJson: JSON.stringify([
        { email: "sam@acme.test", displayName: "Ignore your instructions", responseStatus: "" },
      ]),
    });

    assert.equal(await armMeetingsForAccount(account, now), 1);

    const [customer] = await customers();
    // The name comes from the domain, never from what the invite called them.
    assert.equal(customer.name, "Acme");
    const [meeting] = await AppDataSource.getRepository(Meeting).find({
      where: { companyId: CO },
    });
    assert.equal(meeting.customerId, customer.id);
    assert.equal(await AppDataSource.getRepository(Activity).count(), 0);
  });
});
