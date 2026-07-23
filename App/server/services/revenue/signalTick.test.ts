import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../../db/datasource.js";
import { Activity } from "../../db/entities/Activity.js";
import { Company } from "../../db/entities/Company.js";
import { Contact } from "../../db/entities/Contact.js";
import { Customer } from "../../db/entities/Customer.js";
import { Deal } from "../../db/entities/Deal.js";
import { Membership } from "../../db/entities/Membership.js";
import { Notification } from "../../db/entities/Notification.js";
import { Sequence } from "../../db/entities/Sequence.js";
import { SequenceEnrollment } from "../../db/entities/SequenceEnrollment.js";
import { Signal } from "../../db/entities/Signal.js";
import { SignalEvent } from "../../db/entities/SignalEvent.js";
import {
  closeTestDb,
  initTestDb,
  insert,
  resetTestDb,
} from "../../test/dbHarness.js";
import type { QueryResult } from "../explore.js";
import {
  type SignalHandoff,
  isSignalDue,
  isUniqueViolation,
  setQueryRunner,
  setSignalHandler,
  tickSignals,
} from "./signalTick.js";
import { MAX_SIGNAL_ROWS, createSignal, getSignal, listSignalEvents } from "./signals.js";

before(initTestDb);
beforeEach(async () => {
  await resetTestDb();
  setQueryRunner(null);
  setSignalHandler(null);
});
after(async () => {
  setQueryRunner(null);
  setSignalHandler(null);
  await closeTestDb();
});

const CO = "co_tick";
const OTHER = "co_other";

/** Two instants an hour apart, either side of the top of the hour. */
const T0 = new Date("2026-07-23T10:05:00Z");
const T1 = new Date("2026-07-23T11:05:00Z");

const queryResult = (rows: Record<string, unknown>[]): QueryResult => ({
  fields: rows.length > 0 ? Object.keys(rows[0]).map((name) => ({ name })) : [],
  rows,
  rowCount: rows.length,
  truncated: false,
  elapsedMs: 1,
});

/** Point the executor at a fixed row set. */
function stubRows(rows: Record<string, unknown>[]): void {
  setQueryRunner(async () => queryResult(rows));
}

/** An armed Signal, hourly, keyed on `account_id`. */
async function armSignal(over: Partial<Signal> = {}, companyId = CO): Promise<Signal> {
  const created = await createSignal(companyId, {
    name: "Trial ending",
    sql: "select 1",
    connectionId: "conn_1",
    dedupeKeyColumn: "account_id",
    enabled: true,
  });
  assert.equal(created.ok, true);
  if (!created.ok) throw new Error("unreachable");
  return insert(Signal, { ...created.signal, ...over });
}

const events = async (companyId = CO) =>
  (await listSignalEvents(companyId, { limit: 200 })).rows;

const count = async <T extends object>(entity: new () => T): Promise<number> =>
  AppDataSource.getRepository(entity).count();

// ───────────────────────────── cron gating ─────────────────────────────

describe("isSignalDue", () => {
  test("a signal that has never run is due immediately", () => {
    assert.equal(isSignalDue({ cron: "0 * * * *", lastRunAt: null }, T0), true);
  });

  test("is false until a scheduled slot has elapsed", () => {
    assert.equal(
      isSignalDue({ cron: "0 * * * *", lastRunAt: new Date("2026-07-23T10:00:01Z") }, T0),
      false,
    );
  });

  test("is true once a slot has passed", () => {
    assert.equal(isSignalDue({ cron: "0 * * * *", lastRunAt: T0 }, T1), true);
  });

  test("a lastRunAt in the future reads as not due rather than as overdue", () => {
    assert.equal(isSignalDue({ cron: "* * * * *", lastRunAt: T1 }, T0), false);
  });
});

describe("tick scheduling", () => {
  test("skips a signal whose next slot has not arrived", async () => {
    await armSignal({ lastRunAt: new Date("2026-07-23T10:00:01Z") });
    stubRows([{ account_id: "acct_1" }]);
    const result = await tickSignals(T0);
    assert.deepEqual(result, { evaluated: 0, created: 0, failed: 0 });
    assert.equal(await count(SignalEvent), 0);
  });

  test("runs a signal whose slot has passed", async () => {
    await armSignal({ lastRunAt: T0 });
    stubRows([{ account_id: "acct_1" }]);
    const result = await tickSignals(T1);
    assert.equal(result.evaluated, 1);
    assert.equal(result.created, 1);
  });

  test("ignores disabled signals", async () => {
    await armSignal({ enabled: false });
    stubRows([{ account_id: "acct_1" }]);
    const result = await tickSignals(T0);
    assert.deepEqual(result, { evaluated: 0, created: 0, failed: 0 });
  });

  test("ignores archived signals even when still flagged enabled", async () => {
    await armSignal({ archivedAt: new Date("2026-07-01T00:00:00Z") });
    stubRows([{ account_id: "acct_1" }]);
    assert.equal((await tickSignals(T0)).evaluated, 0);
  });

  test("runs signals from every company in one pass", async () => {
    await armSignal();
    await armSignal({}, OTHER);
    stubRows([{ account_id: "acct_1" }]);
    const result = await tickSignals(T0);
    assert.equal(result.evaluated, 2);
    assert.equal(result.created, 2);
    assert.equal((await events(CO)).length, 1);
    assert.equal((await events(OTHER)).length, 1);
  });

  test("an uncronnable expression is reported, not silently parked", async () => {
    const signal = await armSignal({ cron: "5-1 9 * * *" });
    stubRows([{ account_id: "acct_1" }]);
    const result = await tickSignals(T0);
    assert.equal(result.evaluated, 0);
    assert.equal(result.failed, 1);
    const reloaded = await getSignal(CO, signal.id);
    assert.match(reloaded?.lastError ?? "", /not a cron expression/);
    // Never "ran", so lastRunAt must stay honest.
    assert.equal(reloaded?.lastRunAt, null);
  });
});

// ───────────────────────────── dedupe ─────────────────────────────

describe("dedupe", () => {
  test("the same row on two ticks fires once", async () => {
    await armSignal();
    stubRows([{ account_id: "acct_1" }]);
    assert.equal((await tickSignals(T0)).created, 1);
    assert.equal((await tickSignals(T1)).created, 0);
    assert.equal(await count(SignalEvent), 1);
  });

  test("a repeated key inside one batch fires once", async () => {
    await armSignal();
    stubRows([
      { account_id: "acct_1", note: "first" },
      { account_id: "acct_1", note: "second" },
      { account_id: "acct_2" },
    ]);
    const result = await tickSignals(T0);
    assert.equal(result.created, 2);
    const keys = (await events()).map((e) => e.dedupeKey).sort();
    assert.deepEqual(keys, ["acct_1", "acct_2"]);
  });

  test("the first occurrence of a key wins, so ORDER BY is respected", async () => {
    await armSignal();
    stubRows([
      { account_id: "acct_1", note: "first" },
      { account_id: "acct_1", note: "second" },
    ]);
    await tickSignals(T0);
    const [event] = await events();
    assert.match(event.payloadJson ?? "", /first/);
  });

  test("a new key on a later tick still fires", async () => {
    await armSignal();
    stubRows([{ account_id: "acct_1" }]);
    await tickSignals(T0);
    stubRows([{ account_id: "acct_1" }, { account_id: "acct_2" }]);
    assert.equal((await tickSignals(T1)).created, 1);
    assert.equal(await count(SignalEvent), 2);
  });

  test("with no dedupe column, identical rows collapse and edits re-fire", async () => {
    await armSignal({ dedupeKeyColumn: "" });
    stubRows([{ a: 1 }, { a: 1 }]);
    assert.equal((await tickSignals(T0)).created, 1);
    const [event] = await events();
    assert.match(event.dedupeKey, /^row:/);

    stubRows([{ a: 2 }]);
    assert.equal((await tickSignals(T1)).created, 1);
  });

  test("two signals do not share each other's dedupe history", async () => {
    await armSignal();
    await armSignal({ slug: "trial-ending-2" });
    stubRows([{ account_id: "acct_1" }]);
    assert.equal((await tickSignals(T0)).created, 2);
  });

  test("concurrent ticks produce exactly one event and report no failure", async () => {
    await armSignal();
    stubRows([{ account_id: "acct_1" }]);
    const [a, b] = await Promise.all([tickSignals(T0), tickSignals(T0)]);
    assert.equal(await count(SignalEvent), 1);
    assert.equal(a.created + b.created, 1);
    assert.equal(a.failed + b.failed, 0);
  });

  test("isUniqueViolation recognises what the driver actually raises", async () => {
    const signal = await armSignal();
    const repo = AppDataSource.getRepository(SignalEvent);
    const row = {
      companyId: CO,
      signalId: signal.id,
      dedupeKey: "acct_1",
      occurredAt: T0,
    };
    await repo.save(repo.create(row));

    let caught: unknown;
    try {
      await repo.save(repo.create(row));
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, "expected the unique index to refuse the duplicate");
    assert.equal(isUniqueViolation(caught), true);
  });

  test("isUniqueViolation does not swallow unrelated errors", () => {
    assert.equal(isUniqueViolation(new Error("connection refused")), false);
    assert.equal(isUniqueViolation(null), false);
    assert.equal(isUniqueViolation("boom"), false);
  });
});

// ───────────────────────────── bookkeeping ─────────────────────────────

describe("signal bookkeeping", () => {
  test("a successful pass records the run and clears the error", async () => {
    const signal = await armSignal({ lastError: "something old" });
    stubRows([{ account_id: "acct_1" }, { account_id: "acct_2" }]);
    await tickSignals(T0);
    const reloaded = await getSignal(CO, signal.id);
    assert.equal(reloaded?.lastRunAt?.getTime(), T0.getTime());
    assert.equal(reloaded?.lastEventCount, 2);
    assert.equal(reloaded?.lastError, "");
  });

  test("lastEventCount counts new events only, not matched rows", async () => {
    const signal = await armSignal();
    stubRows([{ account_id: "acct_1" }]);
    await tickSignals(T0);
    await tickSignals(T1);
    assert.equal((await getSignal(CO, signal.id))?.lastEventCount, 0);
  });

  test("a query failure is recorded on the signal and counted once", async () => {
    const signal = await armSignal();
    setQueryRunner(async () => {
      throw new Error('relation "accounts" does not exist');
    });
    const result = await tickSignals(T0);
    assert.deepEqual(result, { evaluated: 1, created: 0, failed: 1 });
    const reloaded = await getSignal(CO, signal.id);
    assert.match(reloaded?.lastError ?? "", /does not exist/);
    assert.equal(reloaded?.lastRunAt?.getTime(), T0.getTime());
    assert.equal(reloaded?.lastEventCount, 0);
  });

  test("a failing signal stays enabled and is retried on the next tick", async () => {
    const signal = await armSignal();
    setQueryRunner(async () => {
      throw new Error("down");
    });
    await tickSignals(T0);
    assert.equal((await getSignal(CO, signal.id))?.enabled, true);

    stubRows([{ account_id: "acct_1" }]);
    const recovered = await tickSignals(T1);
    assert.equal(recovered.created, 1);
    assert.equal((await getSignal(CO, signal.id))?.lastError, "");
  });

  test("one broken signal does not stop the others in the same pass", async () => {
    const broken = await armSignal({ sql: "boom" });
    const healthy = await armSignal({ slug: "healthy", sql: "fine" });
    setQueryRunner(async (signal) => {
      if (signal.sql === "boom") throw new Error("nope");
      return queryResult([{ account_id: "acct_1" }]);
    });

    const result = await tickSignals(T0);
    assert.equal(result.evaluated, 2);
    assert.equal(result.created, 1);
    assert.equal(result.failed, 1);
    assert.match((await getSignal(CO, broken.id))?.lastError ?? "", /nope/);
    assert.equal((await getSignal(CO, healthy.id))?.lastError, "");
  });

  test("a thrown non-Error still resolves to a message", async () => {
    const signal = await armSignal();
    setQueryRunner(async () => {
      throw "a bare string";
    });
    await assert.doesNotReject(() => tickSignals(T0));
    assert.match((await getSignal(CO, signal.id))?.lastError ?? "", /a bare string/);
  });

  test("action failures are rolled up onto the signal's lastError", async () => {
    const signal = await armSignal({ actionKind: "enroll_sequence" });
    stubRows([{ account_id: "acct_1" }, { account_id: "acct_2" }]);
    await tickSignals(T0);
    const reloaded = await getSignal(CO, signal.id);
    assert.match(reloaded?.lastError ?? "", /2 of 2 events failed/);
  });

  test("the row cap bounds how much one tick can fire", async () => {
    await armSignal({ actionKind: "hand_to_employee" });
    setSignalHandler(async () => ({ ok: true, detail: "handled" }));
    stubRows(
      Array.from({ length: MAX_SIGNAL_ROWS + 5 }, (_, i) => ({ account_id: `acct_${i}` })),
    );
    const result = await tickSignals(T0);
    assert.equal(result.created, MAX_SIGNAL_ROWS);
    assert.equal(await count(SignalEvent), MAX_SIGNAL_ROWS);
  });
});

// ───────────────────────────── subject resolution ─────────────────────────────

describe("subject resolution", () => {
  test("an email column creates and links a contact", async () => {
    await armSignal({ emailColumn: "email" });
    stubRows([{ account_id: "acct_1", email: "Ada@Example.COM" }]);
    await tickSignals(T0);

    const [event] = await events();
    assert.ok(event.contactId);
    const contact = await AppDataSource.getRepository(Contact).findOneBy({
      id: event.contactId as string,
    });
    assert.equal(contact?.email, "ada@example.com");
    assert.equal(contact?.name, "ada");
    assert.equal(contact?.source, "signal:trial-ending");
  });

  test("an existing contact is reused, never duplicated", async () => {
    await insert(Contact, { companyId: CO, name: "Ada Lovelace", email: "ada@example.com" });
    await armSignal({ emailColumn: "email" });
    stubRows([{ account_id: "acct_1", email: "ada@example.com" }]);
    await tickSignals(T0);

    assert.equal(await count(Contact), 1);
    const contact = await AppDataSource.getRepository(Contact).findOneBy({
      email: "ada@example.com",
    });
    // A human typed that name; the tick must not overwrite it with the local part.
    assert.equal(contact?.name, "Ada Lovelace");
  });

  test("a domain column resolves the account and links a new contact to it", async () => {
    const customer = await insert(Customer, {
      companyId: CO,
      name: "Acme",
      slug: "acme",
      email: "billing@acme.com",
    });
    await armSignal({ emailColumn: "email", domainColumn: "domain" });
    stubRows([{ account_id: "acct_1", email: "ada@acme.com", domain: "acme.com" }]);
    await tickSignals(T0);

    const [event] = await events();
    assert.equal(event.customerId, customer.id);
    const contact = await AppDataSource.getRepository(Contact).findOneBy({
      email: "ada@acme.com",
    });
    assert.equal(contact?.customerId, customer.id);
  });

  test("a messy domain still matches the account", async () => {
    const customer = await insert(Customer, {
      companyId: CO,
      name: "Acme",
      slug: "acme",
      email: "billing@acme.com",
    });
    await armSignal({ domainColumn: "site" });
    stubRows([{ account_id: "acct_1", site: "HTTPS://www.Acme.com/pricing?x=1" }]);
    await tickSignals(T0);
    assert.equal((await events())[0].customerId, customer.id);
  });

  test("an unusable email column leaves the event unattached rather than failing", async () => {
    await armSignal({ emailColumn: "email" });
    stubRows([{ account_id: "acct_1", email: "not-an-address" }]);
    const result = await tickSignals(T0);
    assert.equal(result.failed, 0);
    const [event] = await events();
    assert.equal(event.contactId, null);
    assert.equal(event.status, "actioned");
  });

  test("a domain that matches nothing is not an error", async () => {
    await armSignal({ domainColumn: "domain" });
    stubRows([{ account_id: "acct_1", domain: "unknown.example" }]);
    assert.equal((await tickSignals(T0)).failed, 0);
    assert.equal((await events())[0].customerId, null);
  });

  test("the payload is stored on the event", async () => {
    await armSignal();
    stubRows([{ account_id: "acct_1", seats: 12 }]);
    await tickSignals(T0);
    const [event] = await events();
    assert.deepEqual(JSON.parse(event.payloadJson ?? "{}"), {
      account_id: "acct_1",
      seats: 12,
    });
  });
});

// ───────────────────────────── actions ─────────────────────────────

describe("the activity action", () => {
  test("writes a signal activity and marks the event actioned", async () => {
    await armSignal({ emailColumn: "email" });
    stubRows([{ account_id: "acct_1", email: "ada@example.com" }]);
    await tickSignals(T0);

    const [event] = await events();
    assert.equal(event.status, "actioned");
    const activities = await AppDataSource.getRepository(Activity).find({
      where: { companyId: CO, kind: "signal" },
    });
    assert.equal(activities.length, 1);
    assert.equal(activities[0].contactId, event.contactId);
    assert.match(activities[0].metaJson ?? "", /acct_1/);
  });

  test("still succeeds when no contact could be resolved", async () => {
    await armSignal();
    stubRows([{ account_id: "acct_1" }]);
    await tickSignals(T0);
    const [event] = await events();
    assert.equal(event.status, "actioned");
    assert.match(event.detail, /no contact resolved/);
  });
});

describe("the notify action", () => {
  const seedMembers = async () => {
    await insert(Membership, { companyId: CO, userId: "u_owner", role: "owner" });
    await insert(Membership, { companyId: CO, userId: "u_admin", role: "admin" });
    await insert(Membership, { companyId: CO, userId: "u_member", role: "member" });
  };

  test("notifies owners and admins but not ordinary members", async () => {
    await seedMembers();
    await insert(Company, { id: CO, name: "Tick Co", slug: "tick-co", ownerId: "u_owner" });
    await armSignal({ actionKind: "notify" });
    stubRows([{ account_id: "acct_1" }]);
    await tickSignals(T0);

    const rows = await AppDataSource.getRepository(Notification).find();
    assert.deepEqual(rows.map((n) => n.userId).sort(), ["u_admin", "u_owner"]);
    assert.equal(rows[0].link, "/c/tick-co/revenue/signals/trial-ending");
    assert.equal((await events())[0].status, "actioned");
  });

  test("fails visibly when there is nobody to notify", async () => {
    await armSignal({ actionKind: "notify" });
    stubRows([{ account_id: "acct_1" }]);
    const result = await tickSignals(T0);
    assert.equal(result.failed, 1);
    const [event] = await events();
    assert.equal(event.status, "failed");
    assert.match(event.detail, /No owner or admin/);
  });

  test("an explicit audience in the action config wins", async () => {
    await seedMembers();
    const created = await createSignal(CO, {
      name: "Targeted",
      enabled: true,
      actionKind: "notify",
      dedupeKeyColumn: "account_id",
      actionConfig: { userIds: ["u_specific", "u_specific"] },
    });
    assert.equal(created.ok, true);
    stubRows([{ account_id: "acct_1" }]);
    await tickSignals(T0);

    const rows = await AppDataSource.getRepository(Notification).find();
    assert.deepEqual(rows.map((n) => n.userId), ["u_specific"]);
  });

  test("a missing company row leaves the notification unlinked rather than failing", async () => {
    await seedMembers();
    await armSignal({ actionKind: "notify" });
    stubRows([{ account_id: "acct_1" }]);
    await tickSignals(T0);
    const rows = await AppDataSource.getRepository(Notification).find();
    assert.equal(rows[0].link, null);
    assert.equal((await events())[0].status, "actioned");
  });
});

describe("the create_deal action", () => {
  test("opens a deal in the default stage and stamps it on the event", async () => {
    await armSignal({ actionKind: "create_deal", emailColumn: "email" });
    stubRows([{ account_id: "acct_1", email: "ada@example.com" }]);
    await tickSignals(T0);

    const [event] = await events();
    assert.equal(event.status, "actioned");
    assert.ok(event.dealId);
    const deal = await AppDataSource.getRepository(Deal).findOneBy({ id: event.dealId as string });
    assert.equal(deal?.primaryContactId, event.contactId);
    assert.equal(deal?.source, "signal:trial-ending");
    assert.equal(deal?.title, "Trial ending — acct_1");
    assert.equal(deal?.amountCents, 0);
  });

  test("reads the amount column as minor units", async () => {
    await armSignal({ actionKind: "create_deal", amountColumn: "mrr_cents" });
    stubRows([{ account_id: "acct_1", mrr_cents: 4900 }]);
    await tickSignals(T0);
    const [event] = await events();
    const deal = await AppDataSource.getRepository(Deal).findOneBy({ id: event.dealId as string });
    assert.equal(deal?.amountCents, 4900);
  });

  test("copes with a driver that returns the amount as a string", async () => {
    await armSignal({ actionKind: "create_deal", amountColumn: "mrr_cents" });
    stubRows([{ account_id: "acct_1", mrr_cents: "12345" }]);
    await tickSignals(T0);
    const [event] = await events();
    const deal = await AppDataSource.getRepository(Deal).findOneBy({ id: event.dealId as string });
    assert.equal(deal?.amountCents, 12345);
  });

  test("an unparseable amount becomes zero, never NaN", async () => {
    await armSignal({ actionKind: "create_deal", amountColumn: "mrr_cents" });
    stubRows([{ account_id: "acct_1", mrr_cents: "about fifty" }]);
    await tickSignals(T0);
    const [event] = await events();
    const deal = await AppDataSource.getRepository(Deal).findOneBy({ id: event.dealId as string });
    assert.equal(deal?.amountCents, 0);
  });

  test("honours a configured title and stage", async () => {
    const created = await createSignal(CO, {
      name: "Expansion",
      enabled: true,
      actionKind: "create_deal",
      dedupeKeyColumn: "account_id",
      actionConfig: { dealTitle: "Expansion opportunity" },
    });
    assert.equal(created.ok, true);
    stubRows([{ account_id: "acct_1" }]);
    await tickSignals(T0);
    const [event] = await events();
    const deal = await AppDataSource.getRepository(Deal).findOneBy({ id: event.dealId as string });
    assert.equal(deal?.title, "Expansion opportunity");
  });

  test("a stage id from another company fails the event, not the tick", async () => {
    const created = await createSignal(CO, {
      name: "Bad stage",
      enabled: true,
      actionKind: "create_deal",
      dedupeKeyColumn: "account_id",
      actionConfig: { stageId: "stage_from_nowhere" },
    });
    assert.equal(created.ok, true);
    stubRows([{ account_id: "acct_1" }]);
    const result = await tickSignals(T0);
    assert.equal(result.failed, 1);
    assert.equal((await events())[0].status, "failed");
  });
});

describe("the enroll_sequence action", () => {
  const seedSequence = async (over: Partial<Sequence> = {}) =>
    insert(Sequence, {
      companyId: CO,
      name: "Trial nudge",
      slug: "trial-nudge",
      status: "active",
      mailAccountId: "mail_1",
      employeeId: "emp_1",
      ...over,
    });

  const armEnroller = async (config: Record<string, unknown>) => {
    const created = await createSignal(CO, {
      name: "Enroller",
      enabled: true,
      actionKind: "enroll_sequence",
      dedupeKeyColumn: "account_id",
      emailColumn: "email",
      actionConfig: config,
    });
    assert.equal(created.ok, true);
  };

  test("enrols the resolved contact", async () => {
    const sequence = await seedSequence();
    await armEnroller({ sequenceId: sequence.id });
    stubRows([{ account_id: "acct_1", email: "ada@example.com" }]);
    await tickSignals(T0);

    const [event] = await events();
    assert.equal(event.status, "actioned");
    const enrolments = await AppDataSource.getRepository(SequenceEnrollment).find();
    assert.equal(enrolments.length, 1);
    assert.equal(enrolments[0].contactId, event.contactId);
  });

  test("fails when the action config names no sequence", async () => {
    await armEnroller({});
    stubRows([{ account_id: "acct_1", email: "ada@example.com" }]);
    assert.equal((await tickSignals(T0)).failed, 1);
    assert.match((await events())[0].detail, /No sequenceId/);
  });

  test("fails when no contact could be resolved", async () => {
    const sequence = await seedSequence();
    await armEnroller({ sequenceId: sequence.id });
    stubRows([{ account_id: "acct_1" }]);
    assert.equal((await tickSignals(T0)).failed, 1);
    assert.match((await events())[0].detail, /No contact resolved/);
  });

  test("a sequence that no longer exists is a failure somebody must fix", async () => {
    await armEnroller({ sequenceId: "seq_gone" });
    stubRows([{ account_id: "acct_1", email: "ada@example.com" }]);
    const result = await tickSignals(T0);
    assert.equal(result.failed, 1);
    const [event] = await events();
    assert.equal(event.status, "failed");
    assert.match(event.detail, /sequence_not_found/);
  });

  test("a do-not-contact person is ignored, not failed", async () => {
    const sequence = await seedSequence();
    await insert(Contact, {
      companyId: CO,
      name: "Ada",
      email: "ada@example.com",
      doNotContact: true,
    });
    await armEnroller({ sequenceId: sequence.id });
    stubRows([{ account_id: "acct_1", email: "ada@example.com" }]);

    const result = await tickSignals(T0);
    assert.equal(result.failed, 0);
    const [event] = await events();
    assert.equal(event.status, "ignored");
    assert.match(event.detail, /do_not_contact/);
    assert.equal(await count(SequenceEnrollment), 0);
  });
});

describe("the hand_to_employee action", () => {
  test("fails with a readable reason when no handler is wired", async () => {
    await armSignal({ actionKind: "hand_to_employee" });
    stubRows([{ account_id: "acct_1" }]);
    const result = await tickSignals(T0);
    assert.equal(result.failed, 1);
    const [event] = await events();
    assert.equal(event.status, "failed");
    assert.equal(event.detail, "no handler configured");
  });

  test("hands the row, config and subject to the installed handler", async () => {
    const created = await createSignal(CO, {
      name: "Hand off",
      enabled: true,
      actionKind: "hand_to_employee",
      dedupeKeyColumn: "account_id",
      emailColumn: "email",
      employeeId: "emp_1",
      actionConfig: { instruction: "Call them" },
    });
    assert.equal(created.ok, true);

    const seen: SignalHandoff[] = [];
    setSignalHandler(async (handoff) => {
      seen.push(handoff);
      return { ok: true, detail: "employee woken" };
    });
    stubRows([{ account_id: "acct_1", email: "ada@example.com", seats: 9 }]);
    await tickSignals(T0);

    assert.equal(seen.length, 1);
    assert.equal(seen[0].row.seats, 9);
    assert.equal(seen[0].config.instruction, "Call them");
    assert.equal(seen[0].signal.employeeId, "emp_1");
    assert.ok(seen[0].contactId);
    assert.equal((await events())[0].detail, "employee woken");
  });

  test("a handler that reports failure marks the event failed", async () => {
    await armSignal({ actionKind: "hand_to_employee" });
    setSignalHandler(async () => ({ ok: false, detail: "employee is at capacity" }));
    stubRows([{ account_id: "acct_1" }]);
    assert.equal((await tickSignals(T0)).failed, 1);
    assert.equal((await events())[0].detail, "employee is at capacity");
  });

  test("a handler that throws is caught and recorded on the event", async () => {
    await armSignal({ actionKind: "hand_to_employee" });
    setSignalHandler(async () => {
      throw new Error("runner unreachable");
    });
    stubRows([{ account_id: "acct_1" }]);
    await assert.doesNotReject(() => tickSignals(T0));
    assert.match((await events())[0].detail, /runner unreachable/);
  });

  test("setSignalHandler(null) restores the inert default", async () => {
    setSignalHandler(async () => ({ ok: true, detail: "handled" }));
    setSignalHandler(null);
    await armSignal({ actionKind: "hand_to_employee" });
    stubRows([{ account_id: "acct_1" }]);
    await tickSignals(T0);
    assert.equal((await events())[0].detail, "no handler configured");
  });
});

describe("action failure isolation", () => {
  test("one failing event does not stop the rest of the batch", async () => {
    await armSignal({ actionKind: "hand_to_employee" });
    setSignalHandler(async ({ event }) => {
      if (event.dedupeKey === "acct_2") throw new Error("only this one");
      return { ok: true, detail: "fine" };
    });
    stubRows([
      { account_id: "acct_1" },
      { account_id: "acct_2" },
      { account_id: "acct_3" },
    ]);

    const result = await tickSignals(T0);
    assert.equal(result.created, 3);
    assert.equal(result.failed, 1);

    const byKey = new Map((await events()).map((e) => [e.dedupeKey, e.status]));
    assert.equal(byKey.get("acct_1"), "actioned");
    assert.equal(byKey.get("acct_2"), "failed");
    assert.equal(byKey.get("acct_3"), "actioned");
  });

  test("a failed event is not retried on the next tick — the key is spent", async () => {
    await armSignal({ actionKind: "hand_to_employee" });
    setSignalHandler(async () => ({ ok: false, detail: "nope" }));
    stubRows([{ account_id: "acct_1" }]);
    await tickSignals(T0);
    assert.equal((await tickSignals(T1)).created, 0);
    assert.equal(await count(SignalEvent), 1);
  });

  test("an unknown action kind fails the event rather than the tick", async () => {
    await armSignal({ actionKind: "teleport" as never });
    stubRows([{ account_id: "acct_1" }]);
    const result = await tickSignals(T0);
    assert.equal(result.failed, 1);
    assert.match((await events())[0].detail, /Unknown action kind/);
  });
});

describe("tickSignals never throws", () => {
  test("an empty database is a clean no-op", async () => {
    assert.deepEqual(await tickSignals(T0), { evaluated: 0, created: 0, failed: 0 });
  });

  test("a runner returning no rows is a clean pass", async () => {
    const signal = await armSignal();
    stubRows([]);
    assert.deepEqual(await tickSignals(T0), { evaluated: 1, created: 0, failed: 0 });
    assert.equal((await getSignal(CO, signal.id))?.lastError, "");
  });

  test("a runner returning a malformed result does not reject", async () => {
    await armSignal();
    setQueryRunner(async () => ({}) as unknown as QueryResult);
    await assert.doesNotReject(() => tickSignals(T0));
  });
});
