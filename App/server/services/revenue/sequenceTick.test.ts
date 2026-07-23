import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../../db/datasource.js";
import { Activity } from "../../db/entities/Activity.js";
import { Contact } from "../../db/entities/Contact.js";
import { Sequence } from "../../db/entities/Sequence.js";
import { SequenceEnrollment } from "../../db/entities/SequenceEnrollment.js";
import { SequenceStep } from "../../db/entities/SequenceStep.js";
import { SequenceStepRun } from "../../db/entities/SequenceStepRun.js";
import {
  closeTestDb,
  initTestDb,
  insert,
  resetTestDb,
} from "../../test/dbHarness.js";
import { addSuppression } from "../mail/suppression.js";
import {
  MAX_TOUCHES_PER_TICK,
  setTouchDrafter,
  tickSequences,
  type TouchDrafter,
} from "./sequenceTick.js";
import { replaceSteps } from "./sequences.js";

before(initTestDb);
beforeEach(resetTestDb);
beforeEach(() => setTouchDrafter(null));
after(closeTestDb);

const CO = "co_tick_test";

/** Thursday 12:00 UTC — inside the default weekdays 08:00-17:00 UTC window. */
const NOW = new Date("2026-07-23T12:00:00Z");
/** Saturday 12:00 UTC — outside it. The next opening is Monday 08:00 UTC. */
const SATURDAY = new Date("2026-07-25T12:00:00Z");
const MONDAY_OPEN = new Date("2026-07-27T08:00:00Z");

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** A drafter that always succeeds, so a test can focus on the scheduling. */
const drafts: TouchDrafter = async () => ({ status: "drafted", subject: "Hello there" });

type ScenarioOptions = {
  companyId?: string;
  sequence?: Partial<Sequence>;
  steps?: Array<{ name?: string; delayDays?: number; delayHours?: number }>;
  contact?: Partial<Contact>;
  enrollment?: Partial<SequenceEnrollment>;
};

/** Sequence + ladder + contact + one due enrolment, the shape every test needs. */
async function scenario(opts: ScenarioOptions = {}): Promise<{
  sequence: Sequence;
  steps: SequenceStep[];
  contact: Contact;
  enrollment: SequenceEnrollment;
}> {
  const companyId = opts.companyId ?? CO;
  const sequence = await insert(Sequence, {
    companyId,
    name: "Q3 Outbound",
    slug: `seq-${Math.random().toString(36).slice(2, 10)}`,
    description: "",
    status: "active",
    mailAccountId: "ma_1",
    employeeId: "emp_1",
    brief: "",
    autoSend: false,
    stopOnReply: true,
    dailyCap: 50,
    sendWindowJson: null,
    archivedAt: null,
    ...opts.sequence,
  });

  const steps = await replaceSteps(
    companyId,
    sequence.id,
    opts.steps ?? [{ name: "Opener", delayDays: 0 }, { name: "Bump", delayDays: 1 }],
  );

  const contact = await insert(Contact, {
    companyId,
    name: "Dana Prospect",
    email: `dana-${Math.random().toString(36).slice(2, 10)}@example.com`,
    doNotContact: false,
    archivedAt: null,
    ...opts.contact,
  });

  const enrollment = await insert(SequenceEnrollment, {
    companyId,
    sequenceId: sequence.id,
    contactId: contact.id,
    status: "active",
    currentStepOrder: 0,
    nextRunAt: NOW,
    ...opts.enrollment,
  });

  return { sequence, steps, contact, enrollment };
}

function enrollmentRepo() {
  return AppDataSource.getRepository(SequenceEnrollment);
}

async function reload(enrollment: SequenceEnrollment): Promise<SequenceEnrollment> {
  return enrollmentRepo().findOneByOrFail({ id: enrollment.id });
}

async function runsFor(enrollment: SequenceEnrollment): Promise<SequenceStepRun[]> {
  return AppDataSource.getRepository(SequenceStepRun).findBy({ enrollmentId: enrollment.id });
}

// ────────────────────────────── selection ──────────────────────────────

describe("tickSequences selection", () => {
  test("does nothing when nothing is due", async () => {
    assert.deepEqual(await tickSequences(NOW), {
      processed: 0,
      sent: 0,
      drafted: 0,
      skipped: 0,
      failed: 0,
    });
  });

  test("leaves an enrolment scheduled for later alone", async () => {
    setTouchDrafter(drafts);
    const { enrollment } = await scenario({
      enrollment: { nextRunAt: new Date(NOW.getTime() + HOUR_MS) },
    });
    const result = await tickSequences(NOW);
    assert.equal(result.processed, 0);
    assert.equal((await reload(enrollment)).currentStepOrder, 0);
  });

  test("ignores an enrolment with no schedule at all", async () => {
    setTouchDrafter(drafts);
    // Null nextRunAt is this system's "not scheduled" — paused, finished, or
    // waiting on a human. It must never be read as "due now".
    await scenario({ enrollment: { nextRunAt: null, status: "paused" } });
    assert.equal((await tickSequences(NOW)).processed, 0);
  });

  test("sweeps every company in one pass", async () => {
    setTouchDrafter(drafts);
    await scenario({ companyId: "co_one" });
    await scenario({ companyId: "co_two" });
    const result = await tickSequences(NOW);
    assert.equal(result.drafted, 2);
  });

  test("takes the oldest due enrolments first and stops at the touch budget", async () => {
    setTouchDrafter(drafts);
    const total = MAX_TOUCHES_PER_TICK + 2;
    const made: SequenceEnrollment[] = [];
    const sequence = await insert(Sequence, {
      companyId: CO,
      name: "Bulk",
      slug: "bulk",
      status: "active",
      mailAccountId: "ma_1",
      employeeId: "emp_1",
      dailyCap: 0,
      sendWindowJson: null,
    });
    await replaceSteps(CO, sequence.id, [{ name: "Opener", delayDays: 0 }]);

    for (let i = 0; i < total; i += 1) {
      const contact = await insert(Contact, {
        companyId: CO,
        name: `Prospect ${i}`,
        email: `p${i}@example.com`,
      });
      made.push(
        await insert(SequenceEnrollment, {
          companyId: CO,
          sequenceId: sequence.id,
          contactId: contact.id,
          status: "active",
          currentStepOrder: 0,
          // Oldest first: index 0 is the most overdue.
          nextRunAt: new Date(NOW.getTime() - (total - i) * 60_000),
        }),
      );
    }

    const result = await tickSequences(NOW);
    assert.equal(result.processed, MAX_TOUCHES_PER_TICK);
    assert.equal(result.drafted, MAX_TOUCHES_PER_TICK);

    // Fairness: the two least overdue are the ones left behind, and they are
    // still queued rather than silently dropped.
    const leftovers = await Promise.all(made.slice(-2).map(reload));
    assert.ok(leftovers.every((e) => e.currentStepOrder === 0 && e.status === "active"));
  });
});

// ───────────────────────────── the happy path ─────────────────────────────

describe("tickSequences dispatch", () => {
  test("drafts the due step, advances, and schedules the next one", async () => {
    setTouchDrafter(drafts);
    const { enrollment } = await scenario();

    const result = await tickSequences(NOW);
    assert.deepEqual(result, { processed: 1, sent: 0, drafted: 1, skipped: 0, failed: 0 });

    const after = await reload(enrollment);
    assert.equal(after.status, "active");
    assert.equal(after.currentStepOrder, 1);
    assert.equal(after.lastStepAt?.getTime(), NOW.getTime());
    // Step 2 waits a day: Friday noon is still inside the window, so it fires
    // exactly a day later rather than being pushed.
    assert.equal(after.nextRunAt?.getTime(), NOW.getTime() + DAY_MS);
  });

  test("pushes the next touch out of a weekend and into Monday morning", async () => {
    setTouchDrafter(drafts);
    // Three days after Thursday noon is Sunday noon — outside the window.
    const { enrollment } = await scenario({
      steps: [{ delayDays: 0 }, { delayDays: 3 }],
    });
    await tickSequences(NOW);
    assert.equal((await reload(enrollment)).nextRunAt?.getTime(), MONDAY_OPEN.getTime());
  });

  test("records the step run and a timeline entry", async () => {
    setTouchDrafter(async () => ({
      status: "drafted",
      subject: "Quick question",
      mailMessageId: "mm_1",
      mailThreadId: "th_1",
    }));
    const { enrollment, contact, steps } = await scenario();
    await tickSequences(NOW);

    const [run] = await runsFor(enrollment);
    assert.equal(run.status, "drafted");
    assert.equal(run.stepId, steps[0].id);
    assert.equal(run.stepOrder, 0);
    assert.equal(run.subject, "Quick question");
    assert.equal(run.mailMessageId, "mm_1");
    assert.equal(run.ranAt.getTime(), NOW.getTime());

    const activities = await AppDataSource.getRepository(Activity).findBy({
      kind: "sequence_step",
    });
    assert.equal(activities.length, 1);
    assert.equal(activities[0].contactId, contact.id);
    assert.equal(activities[0].mailMessageId, "mm_1");
  });

  test("remembers the thread the conversation landed in", async () => {
    setTouchDrafter(async () => ({ status: "sent", mailThreadId: "th_42" }));
    const { enrollment } = await scenario();
    await tickSequences(NOW);
    assert.equal((await reload(enrollment)).mailThreadId, "th_42");
  });

  test("counts a sent touch separately from a drafted one", async () => {
    setTouchDrafter(async () => ({ status: "sent" }));
    await scenario();
    const result = await tickSequences(NOW);
    assert.deepEqual(result, { processed: 1, sent: 1, drafted: 0, skipped: 0, failed: 0 });
  });

  test("completes the enrolment after the last step", async () => {
    setTouchDrafter(drafts);
    const { enrollment } = await scenario({ steps: [{ name: "Only", delayDays: 0 }] });
    await tickSequences(NOW);

    const after = await reload(enrollment);
    assert.equal(after.status, "completed");
    assert.equal(after.currentStepOrder, 1);
    assert.equal(after.nextRunAt, null);
  });

  test("completes an enrolment whose remaining steps were deleted", async () => {
    setTouchDrafter(drafts);
    const { sequence, enrollment } = await scenario({ enrollment: { currentStepOrder: 5 } });
    // The ladder was shortened under them. Completing is the honest outcome —
    // the steps they had left no longer exist.
    const result = await tickSequences(NOW);
    assert.equal(result.skipped, 1);
    const after = await reload(enrollment);
    assert.equal(after.status, "completed");
    assert.equal(after.nextRunAt, null);
    assert.equal(await AppDataSource.getRepository(SequenceStepRun).countBy({
      sequenceId: sequence.id,
    }), 0);
  });

  test("completes a sequence that has no steps at all", async () => {
    setTouchDrafter(drafts);
    const { enrollment } = await scenario({ steps: [] });
    await tickSequences(NOW);
    assert.equal((await reload(enrollment)).status, "completed");
  });
});

// ───────────────────────────── the send window ─────────────────────────────

describe("tickSequences send window", () => {
  test("defers to the next opening instead of mailing at the weekend", async () => {
    setTouchDrafter(drafts);
    const { enrollment } = await scenario({ enrollment: { nextRunAt: SATURDAY } });

    const result = await tickSequences(SATURDAY);
    assert.deepEqual(result, { processed: 1, sent: 0, drafted: 0, skipped: 1, failed: 0 });

    const after = await reload(enrollment);
    assert.equal(after.status, "active");
    assert.equal(after.currentStepOrder, 0);
    assert.equal(after.nextRunAt?.getTime(), MONDAY_OPEN.getTime());
  });

  test("a deferral is not an attempt — nothing is written to the run log", async () => {
    setTouchDrafter(drafts);
    const { enrollment } = await scenario({ enrollment: { nextRunAt: SATURDAY } });
    await tickSequences(SATURDAY);
    assert.deepEqual(await runsFor(enrollment), []);
  });

  test("a frozen window re-checks tomorrow rather than becoming unschedulable", async () => {
    setTouchDrafter(drafts);
    // An empty days list is the supported freeze. Setting nextRunAt to null
    // here would strand the enrolment even after somebody fixed the window.
    const { enrollment } = await scenario({
      sequence: {
        sendWindowJson: JSON.stringify({ days: [], startHour: 8, endHour: 17, timezone: "UTC" }),
      },
    });
    await tickSequences(NOW);

    const after = await reload(enrollment);
    assert.equal(after.status, "active");
    assert.equal(after.nextRunAt?.getTime(), NOW.getTime() + DAY_MS);
  });

  test("honours a window in the contact's own timezone", async () => {
    setTouchDrafter(drafts);
    // 12:00 UTC is 05:00 in Los Angeles — before this window opens.
    const { enrollment } = await scenario({
      sequence: {
        sendWindowJson: JSON.stringify({
          days: [1, 2, 3, 4, 5],
          startHour: 9,
          endHour: 17,
          timezone: "America/Los_Angeles",
        }),
      },
    });
    await tickSequences(NOW);
    const after = await reload(enrollment);
    assert.equal(after.currentStepOrder, 0);
    assert.equal(after.nextRunAt?.getTime(), new Date("2026-07-23T16:00:00Z").getTime());
  });
});

// ─────────────────────────────── the daily cap ───────────────────────────────

describe("tickSequences daily cap", () => {
  async function recordUsage(
    sequence: Sequence,
    enrollment: SequenceEnrollment,
    count: number,
    ranAt: Date,
  ): Promise<void> {
    for (let i = 0; i < count; i += 1) {
      await insert(SequenceStepRun, {
        companyId: sequence.companyId,
        sequenceId: sequence.id,
        enrollmentId: enrollment.id,
        stepId: `st_${i}`,
        stepOrder: 0,
        status: "sent",
        detail: "",
        subject: "",
        ranAt,
      });
    }
  }

  test("skips once the sequence has spent its allowance", async () => {
    setTouchDrafter(drafts);
    const { sequence, enrollment } = await scenario({ sequence: { dailyCap: 2 } });
    await recordUsage(sequence, enrollment, 2, new Date(NOW.getTime() - HOUR_MS));

    const result = await tickSequences(NOW);
    assert.deepEqual(result, { processed: 1, sent: 0, drafted: 0, skipped: 1, failed: 0 });
    assert.equal((await reload(enrollment)).currentStepOrder, 0);
  });

  test("the window is rolling — usage older than 24 hours does not count", async () => {
    setTouchDrafter(drafts);
    const { sequence, enrollment } = await scenario({ sequence: { dailyCap: 1 } });
    await recordUsage(sequence, enrollment, 1, new Date(NOW.getTime() - DAY_MS - HOUR_MS));
    assert.equal((await tickSequences(NOW)).drafted, 1);
  });

  test("a skipped run does not count against the cap", async () => {
    setTouchDrafter(drafts);
    const { sequence, enrollment } = await scenario({ sequence: { dailyCap: 1 } });
    await insert(SequenceStepRun, {
      companyId: CO,
      sequenceId: sequence.id,
      enrollmentId: enrollment.id,
      stepId: "st_x",
      stepOrder: 0,
      status: "skipped",
      detail: "suppressed",
      subject: "",
      ranAt: new Date(NOW.getTime() - HOUR_MS),
    });
    assert.equal((await tickSequences(NOW)).drafted, 1);
  });

  test("the budget is spent within one tick, not just across ticks", async () => {
    setTouchDrafter(drafts);
    const { sequence } = await scenario({ sequence: { dailyCap: 1 } });
    const second = await insert(Contact, {
      companyId: CO,
      name: "Second",
      email: "second@example.com",
    });
    await insert(SequenceEnrollment, {
      companyId: CO,
      sequenceId: sequence.id,
      contactId: second.id,
      status: "active",
      currentStepOrder: 0,
      nextRunAt: new Date(NOW.getTime() - 60_000),
    });

    const result = await tickSequences(NOW);
    assert.equal(result.drafted, 1);
    assert.equal(result.skipped, 1);
    assert.equal(result.processed, 2);
  });

  test("a dailyCap of 0 means uncapped, not blocked", async () => {
    setTouchDrafter(drafts);
    const { sequence, enrollment } = await scenario({ sequence: { dailyCap: 0 } });
    await recordUsage(sequence, enrollment, 5, new Date(NOW.getTime() - HOUR_MS));
    assert.equal((await tickSequences(NOW)).drafted, 1);
  });
});

// ──────────────────────── gates re-checked at send time ────────────────────────

describe("tickSequences send-time gates", () => {
  test("stops an enrolment whose contact unsubscribed after enrolling", async () => {
    setTouchDrafter(drafts);
    const { enrollment, contact } = await scenario();
    await addSuppression({ companyId: CO, email: contact.email, reason: "unsubscribe" });

    const result = await tickSequences(NOW);
    assert.equal(result.skipped, 1);

    const after = await reload(enrollment);
    assert.equal(after.status, "stopped_unsubscribed");
    assert.equal(after.nextRunAt, null);
    assert.equal(after.currentStepOrder, 0);
  });

  test("records why it did not mail them — the answer to a later complaint", async () => {
    setTouchDrafter(drafts);
    const { enrollment, contact } = await scenario();
    await addSuppression({ companyId: CO, email: contact.email, reason: "complaint" });
    await tickSequences(NOW);

    const [run] = await runsFor(enrollment);
    assert.equal(run.status, "skipped");
    assert.match(run.detail, /suppressed/);
  });

  test("a contact marked do-not-contact since enrolment is stopped too", async () => {
    setTouchDrafter(drafts);
    const { enrollment, contact } = await scenario();
    await AppDataSource.getRepository(Contact).update(contact.id, { doNotContact: true });
    await tickSequences(NOW);
    assert.equal((await reload(enrollment)).status, "stopped_unsubscribed");
  });

  test("another company's suppression does not block us", async () => {
    setTouchDrafter(drafts);
    const { contact } = await scenario();
    await addSuppression({ companyId: "co_elsewhere", email: contact.email, reason: "unsubscribe" });
    assert.equal((await tickSequences(NOW)).drafted, 1);
  });

  test("stops an archived contact as a manual stop, not an unsubscribe", async () => {
    setTouchDrafter(drafts);
    const { enrollment, contact } = await scenario();
    await AppDataSource.getRepository(Contact).update(contact.id, { archivedAt: NOW });

    const result = await tickSequences(NOW);
    assert.equal(result.skipped, 1);
    const after = await reload(enrollment);
    assert.equal(after.status, "stopped_manual");
    assert.equal(after.stoppedReason, "contact archived");
  });

  test("stops a contact whose address was cleared", async () => {
    setTouchDrafter(drafts);
    const { enrollment, contact } = await scenario();
    await AppDataSource.getRepository(Contact).update(contact.id, { email: "" });
    await tickSequences(NOW);
    assert.equal((await reload(enrollment)).status, "stopped_manual");
  });

  test("fails an enrolment whose contact no longer exists", async () => {
    setTouchDrafter(drafts);
    const { enrollment, contact } = await scenario();
    await AppDataSource.getRepository(Contact).delete(contact.id);

    const result = await tickSequences(NOW);
    assert.equal(result.failed, 1);
    assert.equal((await reload(enrollment)).status, "failed");
  });
});

// ───────────────────────── sequence-level gating ─────────────────────────

describe("tickSequences sequence state", () => {
  test("skips a paused sequence and leaves its schedule untouched", async () => {
    setTouchDrafter(drafts);
    const { enrollment } = await scenario({ sequence: { status: "paused" } });

    const result = await tickSequences(NOW);
    assert.deepEqual(result, { processed: 1, sent: 0, drafted: 0, skipped: 1, failed: 0 });

    const after = await reload(enrollment);
    assert.equal(after.status, "active");
    assert.equal(after.nextRunAt?.getTime(), NOW.getTime());
  });

  test("a paused campaign's backlog cannot starve a live one", async () => {
    setTouchDrafter(drafts);
    const paused = await insert(Sequence, {
      companyId: CO,
      name: "Paused",
      slug: "paused",
      status: "paused",
      mailAccountId: "ma_1",
      employeeId: "emp_1",
      dailyCap: 0,
      sendWindowJson: null,
    });
    await replaceSteps(CO, paused.id, [{ name: "Opener", delayDays: 0 }]);
    for (let i = 0; i < MAX_TOUCHES_PER_TICK + 5; i += 1) {
      const contact = await insert(Contact, {
        companyId: CO,
        name: `Backlog ${i}`,
        email: `backlog${i}@example.com`,
      });
      await insert(SequenceEnrollment, {
        companyId: CO,
        sequenceId: paused.id,
        contactId: contact.id,
        status: "active",
        currentStepOrder: 0,
        // Older than the live one, so a naive cap-then-filter would eat the
        // entire budget on rows that cannot possibly send.
        nextRunAt: new Date(NOW.getTime() - DAY_MS),
      });
    }

    const { enrollment: live } = await scenario();
    const result = await tickSequences(NOW);

    assert.equal(result.drafted, 1);
    assert.equal((await reload(live)).currentStepOrder, 1);
  });

  test("fails an enrolment whose sequence row has gone", async () => {
    setTouchDrafter(drafts);
    const { sequence, enrollment } = await scenario();
    await AppDataSource.getRepository(Sequence).delete(sequence.id);

    const result = await tickSequences(NOW);
    assert.deepEqual(result, { processed: 1, sent: 0, drafted: 0, skipped: 0, failed: 1 });

    const after = await reload(enrollment);
    assert.equal(after.status, "failed");
    assert.match(after.stoppedReason, /sequence no longer exists/);
    assert.equal(after.nextRunAt, null);
  });
});

// ──────────────────────── drafter outcomes and isolation ────────────────────────

describe("tickSequences drafter outcomes", () => {
  test("the default drafter refuses, auditably, rather than throwing", async () => {
    const { enrollment } = await scenario();
    const result = await tickSequences(NOW);
    assert.equal(result.skipped, 1);

    const [run] = await runsFor(enrollment);
    assert.equal(run.status, "skipped");
    assert.equal(run.detail, "no drafter configured");
  });

  test("a skipped touch holds its place and retries later", async () => {
    setTouchDrafter(async () => ({ status: "skipped", detail: "employee is busy" }));
    const { enrollment } = await scenario();
    await tickSequences(NOW);

    const after = await reload(enrollment);
    // Not advanced: silently burning a step the contact never received is the
    // one outcome nobody could debug later.
    assert.equal(after.currentStepOrder, 0);
    assert.equal(after.status, "active");
    assert.equal(after.nextRunAt?.getTime(), NOW.getTime() + HOUR_MS);
  });

  test("a skipped touch's retry still respects the send window", async () => {
    setTouchDrafter(async () => ({ status: "skipped", detail: "employee is busy" }));
    // 16:30 on Thursday: an hour later is 17:30, past the window's close.
    const late = new Date("2026-07-23T16:30:00Z");
    const { enrollment } = await scenario({ enrollment: { nextRunAt: late } });
    await tickSequences(late);
    assert.equal(
      (await reload(enrollment)).nextRunAt?.getTime(),
      new Date("2026-07-24T08:00:00Z").getTime(),
    );
  });

  test("a failed touch stops the enrolment retry-free", async () => {
    setTouchDrafter(async () => ({ status: "failed", detail: "mail account revoked" }));
    const { enrollment } = await scenario();

    const result = await tickSequences(NOW);
    assert.deepEqual(result, { processed: 1, sent: 0, drafted: 0, skipped: 0, failed: 1 });

    const after = await reload(enrollment);
    assert.equal(after.status, "failed");
    assert.equal(after.stoppedReason, "mail account revoked");
    assert.equal(after.nextRunAt, null);

    const [run] = await runsFor(enrollment);
    assert.equal(run.status, "failed");
    assert.equal(run.detail, "mail account revoked");
  });

  test("a thrown touch fails that enrolment and records the message", async () => {
    setTouchDrafter(async () => {
      throw new Error("the model timed out");
    });
    const { enrollment } = await scenario();

    const result = await tickSequences(NOW);
    assert.equal(result.failed, 1);

    const after = await reload(enrollment);
    assert.equal(after.status, "failed");
    assert.equal(after.stoppedReason, "the model timed out");

    const [run] = await runsFor(enrollment);
    assert.equal(run.status, "failed");
    assert.equal(run.detail, "the model timed out");
  });

  test("a thrown non-Error is still recorded rather than escaping", async () => {
    setTouchDrafter(async () => {
      throw "just a string";
    });
    const { enrollment } = await scenario();
    assert.equal((await tickSequences(NOW)).failed, 1);
    assert.match((await reload(enrollment)).stoppedReason, /just a string/);
  });

  test("one failing enrolment does not abort the rest of the sweep", async () => {
    const { enrollment: poisoned, contact: poisonedContact } = await scenario();
    const { enrollment: healthy } = await scenario();
    const { enrollment: alsoHealthy } = await scenario();

    setTouchDrafter(async ({ contact }) => {
      if (contact.id === poisonedContact.id) throw new Error("boom");
      return { status: "drafted" };
    });

    const result = await tickSequences(NOW);
    assert.equal(result.processed, 3);
    assert.equal(result.drafted, 2);
    assert.equal(result.failed, 1);

    assert.equal((await reload(poisoned)).status, "failed");
    assert.equal((await reload(healthy)).currentStepOrder, 1);
    assert.equal((await reload(alsoHealthy)).currentStepOrder, 1);
  });

  test("the drafter is handed everything it needs to write the touch", async () => {
    const seen: string[] = [];
    setTouchDrafter(async ({ sequence, step, enrollment, contact }) => {
      seen.push(sequence.name, step.name, String(enrollment.currentStepOrder), contact.email);
      return { status: "drafted" };
    });
    const { contact } = await scenario();
    await tickSequences(NOW);
    assert.deepEqual(seen, ["Q3 Outbound", "Opener", "0", contact.email]);
  });

  test("setTouchDrafter(null) puts the inert default back", async () => {
    setTouchDrafter(drafts);
    setTouchDrafter(null);
    await scenario();
    const result = await tickSequences(NOW);
    assert.equal(result.drafted, 0);
    assert.equal(result.skipped, 1);
  });
});
