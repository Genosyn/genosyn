import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../../db/datasource.js";
import { Activity } from "../../db/entities/Activity.js";
import { Contact } from "../../db/entities/Contact.js";
import { DEFAULT_SEND_WINDOW, Sequence } from "../../db/entities/Sequence.js";
import { SequenceEnrollment } from "../../db/entities/SequenceEnrollment.js";
import {
  closeTestDb,
  initTestDb,
  insert,
  resetTestDb,
} from "../../test/dbHarness.js";
import { addSuppression } from "../mail/suppression.js";
import {
  MAX_BULK_ENROLL,
  archiveSequence,
  bulkEnroll,
  createSequence,
  enrollContact,
  getSequence,
  listSequences,
  listSteps,
  parseSendWindow,
  pauseEnrollment,
  replaceSteps,
  resumeEnrollment,
  stopEnrollment,
  stopEnrollmentsForEmail,
  stopEnrollmentsForThread,
  uniqueSequenceSlug,
  updateSequence,
} from "./sequences.js";

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

const CO = "co_sequences_test";
const OTHER_CO = "co_other_test";
const NOW = new Date("2026-07-23T12:00:00Z");

async function mkSequence(over: Partial<Sequence> = {}): Promise<Sequence> {
  return insert(Sequence, {
    companyId: CO,
    name: "Q3 Outbound",
    slug: "q3-outbound",
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
    ...over,
  });
}

async function mkContact(over: Partial<Contact> = {}): Promise<Contact> {
  return insert(Contact, {
    companyId: CO,
    name: "Dana Prospect",
    email: "dana@example.com",
    doNotContact: false,
    archivedAt: null,
    ...over,
  });
}

function enrollmentRepo() {
  return AppDataSource.getRepository(SequenceEnrollment);
}

// ───────────────────────────── parseSendWindow ─────────────────────────────

describe("parseSendWindow", () => {
  test("falls back to the default when nothing is stored", () => {
    assert.deepEqual(parseSendWindow({ sendWindowJson: null }), DEFAULT_SEND_WINDOW);
    assert.deepEqual(parseSendWindow({ sendWindowJson: "" }), DEFAULT_SEND_WINDOW);
  });

  test("returns a copy, so a caller cannot mutate the shared default", () => {
    const parsed = parseSendWindow({ sendWindowJson: null });
    parsed.days.push(6);
    assert.deepEqual(DEFAULT_SEND_WINDOW.days, [1, 2, 3, 4, 5]);
  });

  test("reads a well-formed window", () => {
    const json = JSON.stringify({
      days: [1, 3],
      startHour: 9,
      endHour: 18,
      timezone: "Europe/London",
    });
    assert.deepEqual(parseSendWindow({ sendWindowJson: json }), {
      days: [1, 3],
      startHour: 9,
      endHour: 18,
      timezone: "Europe/London",
    });
  });

  test("never throws on invalid JSON — the tick must survive a hand-edited row", () => {
    assert.deepEqual(parseSendWindow({ sendWindowJson: "{not json" }), DEFAULT_SEND_WINDOW);
    assert.deepEqual(parseSendWindow({ sendWindowJson: "[1,2,3]" }), DEFAULT_SEND_WINDOW);
    assert.deepEqual(parseSendWindow({ sendWindowJson: "42" }), DEFAULT_SEND_WINDOW);
    assert.deepEqual(parseSendWindow({ sendWindowJson: "null" }), DEFAULT_SEND_WINDOW);
  });

  test("preserves an empty days list — that is the supported freeze", () => {
    const json = JSON.stringify({ days: [], startHour: 8, endHour: 17, timezone: "UTC" });
    assert.deepEqual(parseSendWindow({ sendWindowJson: json }).days, []);
  });

  test("falls back field by field, so one bad value does not lose the good ones", () => {
    const json = JSON.stringify({
      days: [2, 4],
      startHour: "nine",
      endHour: null,
      timezone: "   ",
    });
    assert.deepEqual(parseSendWindow({ sendWindowJson: json }), {
      days: [2, 4],
      startHour: DEFAULT_SEND_WINDOW.startHour,
      endHour: DEFAULT_SEND_WINDOW.endHour,
      timezone: DEFAULT_SEND_WINDOW.timezone,
    });
  });

  test("drops day entries that are not integers 0-6", () => {
    const json = JSON.stringify({ days: [1, 9, -1, 2.5, "3", 5], startHour: 8, endHour: 17 });
    assert.deepEqual(parseSendWindow({ sendWindowJson: json }).days, [1, 5]);
  });

  test("a non-array days field falls back to the default days", () => {
    const json = JSON.stringify({ days: "weekdays", startHour: 8, endHour: 17 });
    assert.deepEqual(parseSendWindow({ sendWindowJson: json }).days, DEFAULT_SEND_WINDOW.days);
  });
});

// ────────────────────────── create / update / list ──────────────────────────

describe("createSequence", () => {
  test("lands in draft with conservative defaults", async () => {
    const seq = await createSequence(CO, {
      name: "  Winter Push  ",
      mailAccountId: "ma_1",
      employeeId: "emp_1",
    });
    assert.equal(seq.name, "Winter Push");
    assert.equal(seq.slug, "winter-push");
    assert.equal(seq.status, "draft");
    assert.equal(seq.autoSend, false);
    assert.equal(seq.stopOnReply, true);
    assert.equal(seq.dailyCap, 50);
    assert.equal(seq.sendWindowJson, null);
  });

  test("stores a send window that reads back through parseSendWindow", async () => {
    const seq = await createSequence(CO, {
      name: "Windowed",
      mailAccountId: "ma_1",
      employeeId: "emp_1",
      sendWindow: { days: [2], startHour: 10, endHour: 11, timezone: "Asia/Kathmandu" },
    });
    assert.deepEqual(parseSendWindow(seq), {
      days: [2],
      startHour: 10,
      endHour: 11,
      timezone: "Asia/Kathmandu",
    });
  });

  test("clamps a nonsensical daily cap instead of writing it", async () => {
    const negative = await createSequence(CO, {
      name: "Negative",
      mailAccountId: "ma_1",
      employeeId: "emp_1",
      dailyCap: -5,
    });
    const nan = await createSequence(CO, {
      name: "NaN cap",
      mailAccountId: "ma_1",
      employeeId: "emp_1",
      dailyCap: Number.NaN,
    });
    assert.equal(negative.dailyCap, 0);
    assert.equal(nan.dailyCap, 50);
  });

  test("suffixes a colliding slug rather than failing the unique index", async () => {
    await createSequence(CO, { name: "Repeat", mailAccountId: "ma_1", employeeId: "emp_1" });
    const second = await createSequence(CO, {
      name: "Repeat",
      mailAccountId: "ma_1",
      employeeId: "emp_1",
    });
    assert.equal(second.slug, "repeat-2");
  });

  test("slugs are per company — two tenants may both own q3-outbound", async () => {
    await createSequence(CO, { name: "Q3", mailAccountId: "ma_1", employeeId: "emp_1" });
    const other = await createSequence(OTHER_CO, {
      name: "Q3",
      mailAccountId: "ma_2",
      employeeId: "emp_2",
    });
    assert.equal(other.slug, "q3");
  });

  test("uniqueSequenceSlug still yields something for an unsluggable name", async () => {
    assert.equal(await uniqueSequenceSlug(CO, "***"), "sequence");
  });
});

describe("updateSequence", () => {
  test("keeps the slug stable across a rename — links must not rot", async () => {
    const seq = await createSequence(CO, {
      name: "Q3 Outbound",
      mailAccountId: "ma_1",
      employeeId: "emp_1",
    });
    const renamed = await updateSequence(CO, seq.id, { name: "Q3 Outbound (EMEA)" });
    assert.equal(renamed?.name, "Q3 Outbound (EMEA)");
    assert.equal(renamed?.slug, "q3-outbound");
  });

  test("passing a null window clears back to the default", async () => {
    const seq = await createSequence(CO, {
      name: "Windowed",
      mailAccountId: "ma_1",
      employeeId: "emp_1",
      sendWindow: { days: [0], startHour: 1, endHour: 2, timezone: "UTC" },
    });
    const cleared = await updateSequence(CO, seq.id, { sendWindow: null });
    assert.equal(cleared?.sendWindowJson, null);
    assert.deepEqual(parseSendWindow(cleared as Sequence), DEFAULT_SEND_WINDOW);
  });

  test("returns null for another company's sequence", async () => {
    const seq = await mkSequence();
    assert.equal(await updateSequence(OTHER_CO, seq.id, { name: "Stolen" }), null);
  });
});

describe("listSequences", () => {
  test("counts enrolments by status in one pass and zero-fills the rest", async () => {
    const seq = await mkSequence();
    const a = await mkContact({ email: "a@example.com" });
    const b = await mkContact({ email: "b@example.com" });
    const c = await mkContact({ email: "c@example.com" });
    await insert(SequenceEnrollment, {
      companyId: CO,
      sequenceId: seq.id,
      contactId: a.id,
      status: "active",
    });
    await insert(SequenceEnrollment, {
      companyId: CO,
      sequenceId: seq.id,
      contactId: b.id,
      status: "active",
    });
    await insert(SequenceEnrollment, {
      companyId: CO,
      sequenceId: seq.id,
      contactId: c.id,
      status: "completed",
    });

    const [row] = await listSequences(CO);
    assert.equal(row.enrollmentCounts.active, 2);
    assert.equal(row.enrollmentCounts.completed, 1);
    assert.equal(row.enrollmentCounts.stopped_replied, 0);
    assert.equal(row.activeCount, 2);
    assert.equal(row.totalEnrolled, 3);
  });

  test("reports the step count", async () => {
    const seq = await mkSequence();
    await replaceSteps(CO, seq.id, [{ name: "One" }, { name: "Two" }]);
    const [row] = await listSequences(CO);
    assert.equal(row.stepCount, 2);
  });

  test("hides archived rows unless asked, and filters by status and text", async () => {
    await mkSequence({ name: "Live", slug: "live", status: "active" });
    await mkSequence({ name: "Draft one", slug: "draft-one", status: "draft" });
    await mkSequence({ name: "Old", slug: "old", status: "archived", archivedAt: NOW });

    const visible = await listSequences(CO);
    assert.deepEqual(visible.map((s) => s.name).sort(), ["Draft one", "Live"]);

    const withArchived = await listSequences(CO, { includeArchived: true });
    assert.equal(withArchived.length, 3);

    const drafts = await listSequences(CO, { status: "draft" });
    assert.deepEqual(drafts.map((s) => s.name), ["Draft one"]);

    const searched = await listSequences(CO, { q: "liv" });
    assert.deepEqual(searched.map((s) => s.name), ["Live"]);
  });

  test("is company scoped", async () => {
    await mkSequence();
    assert.deepEqual(await listSequences(OTHER_CO), []);
  });
});

describe("archiveSequence", () => {
  test("archives and stops everyone still moving through it", async () => {
    const seq = await mkSequence();
    const live = await mkContact({ email: "live@example.com" });
    const done = await mkContact({ email: "done@example.com" });
    const liveEnrollment = await insert(SequenceEnrollment, {
      companyId: CO,
      sequenceId: seq.id,
      contactId: live.id,
      status: "active",
      nextRunAt: NOW,
    });
    const doneEnrollment = await insert(SequenceEnrollment, {
      companyId: CO,
      sequenceId: seq.id,
      contactId: done.id,
      status: "completed",
    });

    const archived = await archiveSequence(CO, seq.id, NOW);
    assert.equal(archived?.status, "archived");
    assert.equal(archived?.archivedAt?.getTime(), NOW.getTime());

    const after = await enrollmentRepo().findOneByOrFail({ id: liveEnrollment.id });
    assert.equal(after.status, "stopped_manual");
    assert.equal(after.stoppedReason, "sequence archived");
    assert.equal(after.nextRunAt, null);

    // A completed enrolment keeps its status — the report's finished count
    // must not be rewritten by an archive.
    const untouched = await enrollmentRepo().findOneByOrFail({ id: doneEnrollment.id });
    assert.equal(untouched.status, "completed");
  });

  test("returns null for a sequence that is not ours", async () => {
    const seq = await mkSequence();
    assert.equal(await archiveSequence(OTHER_CO, seq.id), null);
  });
});

// ───────────────────────────────── steps ─────────────────────────────────

describe("replaceSteps", () => {
  test("renumbers sortOrder from 0 in the order given", async () => {
    const seq = await mkSequence();
    const steps = await replaceSteps(CO, seq.id, [
      { name: "Opener", delayDays: 0 },
      { name: "Bump", delayDays: 3 },
      { name: "Break up", delayDays: 7 },
    ]);
    assert.deepEqual(steps.map((s) => s.sortOrder), [0, 1, 2]);
    assert.deepEqual(steps.map((s) => s.name), ["Opener", "Bump", "Break up"]);
  });

  test("replaces wholesale — the builder always posts the full ladder", async () => {
    const seq = await mkSequence();
    const first = await replaceSteps(CO, seq.id, [{ name: "A" }, { name: "B" }]);
    const second = await replaceSteps(CO, seq.id, [{ name: "C" }]);
    assert.equal(second.length, 1);
    assert.equal(second[0].name, "C");
    // Nothing from the previous ladder survives, ids included.
    assert.ok(!second.some((s) => first.some((f) => f.id === s.id)));
  });

  test("an empty array clears the ladder", async () => {
    const seq = await mkSequence();
    await replaceSteps(CO, seq.id, [{ name: "A" }]);
    assert.deepEqual(await replaceSteps(CO, seq.id, []), []);
  });

  test("applies the defaults and clamps a negative or NaN delay", async () => {
    const seq = await mkSequence();
    const [plain, negative, nan] = await replaceSteps(CO, seq.id, [
      {},
      { delayDays: -4, delayHours: -1 },
      { delayDays: Number.NaN },
    ]);
    assert.equal(plain.delayDays, 3);
    assert.equal(plain.delayHours, 0);
    assert.equal(plain.threadWithPrevious, true);
    assert.equal(negative.delayDays, 0);
    assert.equal(negative.delayHours, 0);
    assert.equal(nan.delayDays, 3);
  });

  test("does not touch another sequence's steps", async () => {
    const mine = await mkSequence({ slug: "mine" });
    const theirs = await mkSequence({ slug: "theirs" });
    await replaceSteps(CO, theirs.id, [{ name: "Keep" }]);
    await replaceSteps(CO, mine.id, [{ name: "Replace" }]);
    const kept = await listSteps(CO, theirs.id);
    assert.deepEqual(kept.map((s) => s.name), ["Keep"]);
  });
});

// ──────────────────────────────── enrolment ────────────────────────────────

describe("enrollContact", () => {
  test("creates an active enrolment due now and logs it", async () => {
    const seq = await mkSequence();
    const contact = await mkContact();
    const { enrollment, skipped } = await enrollContact(CO, seq.id, contact.id, { now: NOW });

    assert.equal(skipped, undefined);
    assert.equal(enrollment?.status, "active");
    assert.equal(enrollment?.currentStepOrder, 0);
    assert.equal(enrollment?.nextRunAt?.getTime(), NOW.getTime());

    const activities = await AppDataSource.getRepository(Activity).findBy({
      companyId: CO,
      kind: "enrollment",
    });
    assert.equal(activities.length, 1);
    assert.equal(activities[0].contactId, contact.id);
    assert.match(activities[0].subject, /Enrolled in Q3 Outbound/);
  });

  test("carries the deal through when one is named", async () => {
    const seq = await mkSequence();
    const contact = await mkContact();
    const { enrollment } = await enrollContact(CO, seq.id, contact.id, {
      dealId: "deal_1",
      now: NOW,
    });
    assert.equal(enrollment?.dealId, "deal_1");
  });

  test("refuses an unknown sequence and an archived one", async () => {
    const contact = await mkContact();
    const missing = await enrollContact(CO, "seq_nope", contact.id);
    assert.equal(missing.skipped, "sequence_not_found");
    assert.equal(missing.enrollment, null);

    const archived = await mkSequence({ slug: "archived", status: "archived", archivedAt: NOW });
    const refused = await enrollContact(CO, archived.id, contact.id);
    assert.equal(refused.skipped, "sequence_archived");
  });

  test("refuses an unknown contact", async () => {
    const seq = await mkSequence();
    const result = await enrollContact(CO, seq.id, "ct_nope");
    assert.equal(result.skipped, "contact_not_found");
  });

  test("refuses an archived contact", async () => {
    const seq = await mkSequence();
    const contact = await mkContact({ archivedAt: NOW });
    assert.equal((await enrollContact(CO, seq.id, contact.id)).skipped, "contact_archived");
  });

  test("refuses do-not-contact by that name, not as a vague suppression", async () => {
    const seq = await mkSequence();
    const contact = await mkContact({ doNotContact: true });
    // suppressedAmong also blocks this person; the specific reason must win, or
    // whoever reads the skip list goes hunting for a suppression row that does
    // not exist.
    assert.equal((await enrollContact(CO, seq.id, contact.id)).skipped, "do_not_contact");
  });

  test("refuses a contact with no address", async () => {
    const seq = await mkSequence();
    const contact = await mkContact({ email: "" });
    assert.equal((await enrollContact(CO, seq.id, contact.id)).skipped, "no_email");
  });

  test("refuses a suppressed address", async () => {
    const seq = await mkSequence();
    const contact = await mkContact({ email: "blocked@example.com" });
    await addSuppression({ companyId: CO, email: "blocked@example.com", reason: "unsubscribe" });
    assert.equal((await enrollContact(CO, seq.id, contact.id)).skipped, "suppressed");
  });

  test("refuses a second enrolment while the first is live, and hands back the blocker", async () => {
    const seq = await mkSequence();
    const contact = await mkContact();
    const first = await enrollContact(CO, seq.id, contact.id, { now: NOW });
    const second = await enrollContact(CO, seq.id, contact.id, { now: NOW });
    assert.equal(second.skipped, "already_enrolled");
    assert.equal(second.enrollment?.id, first.enrollment?.id);
  });

  test("treats paused as live — resume it rather than restarting the ladder", async () => {
    const seq = await mkSequence();
    const contact = await mkContact();
    const { enrollment } = await enrollContact(CO, seq.id, contact.id, { now: NOW });
    await pauseEnrollment(CO, enrollment?.id ?? "");
    assert.equal((await enrollContact(CO, seq.id, contact.id)).skipped, "already_enrolled");
  });

  test("re-enrolling a terminated enrolment resets the same row", async () => {
    const seq = await mkSequence();
    const contact = await mkContact();
    const { enrollment } = await enrollContact(CO, seq.id, contact.id, { now: NOW });
    const id = enrollment?.id ?? "";

    // Walk it to a terminal state with some history on it.
    await enrollmentRepo().update(id, {
      status: "stopped_replied",
      currentStepOrder: 2,
      nextRunAt: null,
      lastStepAt: NOW,
      stoppedReason: "they replied",
      mailThreadId: "th_old",
    });

    const later = new Date(NOW.getTime() + 60_000);
    const again = await enrollContact(CO, seq.id, contact.id, { now: later });

    assert.equal(again.skipped, undefined);
    assert.equal(again.enrollment?.id, id);
    assert.equal(again.enrollment?.status, "active");
    assert.equal(again.enrollment?.currentStepOrder, 0);
    assert.equal(again.enrollment?.nextRunAt?.getTime(), later.getTime());
    assert.equal(again.enrollment?.lastStepAt, null);
    assert.equal(again.enrollment?.stoppedReason, "");
    // A fresh run must not reply into the thread the last one ended in.
    assert.equal(again.enrollment?.mailThreadId, null);

    // Exactly one row — the unique (sequenceId, contactId) index demands it.
    assert.equal(await enrollmentRepo().countBy({ sequenceId: seq.id }), 1);
  });

  test("a re-enrolment says so on the timeline", async () => {
    const seq = await mkSequence();
    const contact = await mkContact();
    const { enrollment } = await enrollContact(CO, seq.id, contact.id, { now: NOW });
    await enrollmentRepo().update(enrollment?.id ?? "", { status: "completed" });
    await enrollContact(CO, seq.id, contact.id, { now: NOW });

    const activities = await AppDataSource.getRepository(Activity).findBy({
      companyId: CO,
      kind: "enrollment",
    });
    assert.equal(activities.length, 2);
    assert.ok(activities.some((a) => a.subject.startsWith("Re-enrolled")));
  });
});

describe("bulkEnroll", () => {
  test("enrols the good ones and names a reason for each of the rest", async () => {
    const seq = await mkSequence();
    const ok = await mkContact({ email: "ok@example.com" });
    const archived = await mkContact({ email: "arch@example.com", archivedAt: NOW });
    const dnc = await mkContact({ email: "dnc@example.com", doNotContact: true });
    const noEmail = await mkContact({ email: "" });
    const blocked = await mkContact({ email: "blocked@example.com" });
    await addSuppression({ companyId: CO, email: "blocked@example.com", reason: "bounce" });

    const result = await bulkEnroll(
      CO,
      seq.id,
      [ok.id, archived.id, dnc.id, noEmail.id, blocked.id, "ct_nope"],
      { now: NOW },
    );

    assert.equal(result.enrolled, 1);
    assert.deepEqual(
      Object.fromEntries(result.skipped.map((s) => [s.contactId, s.reason])),
      {
        [archived.id]: "contact_archived",
        [dnc.id]: "do_not_contact",
        [noEmail.id]: "no_email",
        [blocked.id]: "suppressed",
        ct_nope: "contact_not_found",
      },
    );
  });

  test("de-duplicates the input rather than reporting already_enrolled against itself", async () => {
    const seq = await mkSequence();
    const contact = await mkContact();
    const result = await bulkEnroll(CO, seq.id, [contact.id, contact.id], { now: NOW });
    assert.equal(result.enrolled, 1);
    assert.deepEqual(result.skipped, []);
  });

  test("skips somebody already mid-ladder", async () => {
    const seq = await mkSequence();
    const contact = await mkContact();
    await enrollContact(CO, seq.id, contact.id, { now: NOW });
    const result = await bulkEnroll(CO, seq.id, [contact.id], { now: NOW });
    assert.equal(result.enrolled, 0);
    assert.deepEqual(result.skipped, [{ contactId: contact.id, reason: "already_enrolled" }]);
  });

  test("reports every contact against a missing or archived sequence", async () => {
    const contact = await mkContact();
    const missing = await bulkEnroll(CO, "seq_nope", [contact.id]);
    assert.deepEqual(missing.skipped, [
      { contactId: contact.id, reason: "sequence_not_found" },
    ]);

    const archived = await mkSequence({ slug: "arch", status: "archived", archivedAt: NOW });
    const refused = await bulkEnroll(CO, archived.id, [contact.id]);
    assert.deepEqual(refused.skipped, [{ contactId: contact.id, reason: "sequence_archived" }]);
  });

  test("caps the batch and reports the overflow instead of dropping it", async () => {
    const seq = await mkSequence();
    const ids = Array.from({ length: MAX_BULK_ENROLL + 3 }, (_, i) => `ct_fake_${i}`);
    const result = await bulkEnroll(CO, seq.id, ids, { now: NOW });
    assert.equal(result.enrolled, 0);
    assert.equal(result.skipped.filter((s) => s.reason === "bulk_limit").length, 3);
    assert.equal(
      result.skipped.filter((s) => s.reason === "contact_not_found").length,
      MAX_BULK_ENROLL,
    );
  });

  test("does nothing for an empty list", async () => {
    const seq = await mkSequence();
    assert.deepEqual(await bulkEnroll(CO, seq.id, []), { enrolled: 0, skipped: [] });
  });
});

// ─────────────────────── enrolment lifecycle / stopping ───────────────────────

describe("stopEnrollment, pause and resume", () => {
  test("stopping clears the schedule and records the reason", async () => {
    const seq = await mkSequence();
    const contact = await mkContact();
    const { enrollment } = await enrollContact(CO, seq.id, contact.id, { now: NOW });
    const stopped = await stopEnrollment(
      CO,
      enrollment?.id ?? "",
      "stopped_replied",
      "they replied",
    );
    assert.equal(stopped?.status, "stopped_replied");
    assert.equal(stopped?.stoppedReason, "they replied");
    assert.equal(stopped?.nextRunAt, null);
  });

  test("pause then resume returns to active, due now", async () => {
    const seq = await mkSequence();
    const contact = await mkContact();
    const { enrollment } = await enrollContact(CO, seq.id, contact.id, { now: NOW });
    const paused = await pauseEnrollment(CO, enrollment?.id ?? "", "holiday freeze");
    assert.equal(paused?.status, "paused");
    assert.equal(paused?.nextRunAt, null);

    const later = new Date(NOW.getTime() + 86_400_000);
    const resumed = await resumeEnrollment(CO, enrollment?.id ?? "", later);
    assert.equal(resumed?.status, "active");
    assert.equal(resumed?.stoppedReason, "");
    // Not the time it would have fired had it never paused — a fortnight of
    // backlog must not go out at once.
    assert.equal(resumed?.nextRunAt?.getTime(), later.getTime());
  });

  test("pausing a stopped enrolment leaves it stopped", async () => {
    const seq = await mkSequence();
    const contact = await mkContact();
    const { enrollment } = await enrollContact(CO, seq.id, contact.id, { now: NOW });
    await stopEnrollment(CO, enrollment?.id ?? "", "stopped_bounced", "hard bounce");
    const paused = await pauseEnrollment(CO, enrollment?.id ?? "");
    assert.equal(paused?.status, "stopped_bounced");
  });

  test("resuming a terminal enrolment does not restart it", async () => {
    const seq = await mkSequence();
    const contact = await mkContact();
    const { enrollment } = await enrollContact(CO, seq.id, contact.id, { now: NOW });
    await stopEnrollment(CO, enrollment?.id ?? "", "completed", "");
    const resumed = await resumeEnrollment(CO, enrollment?.id ?? "", NOW);
    assert.equal(resumed?.status, "completed");
    assert.equal(resumed?.nextRunAt, null);
  });

  test("all three return null for another company's row", async () => {
    const seq = await mkSequence();
    const contact = await mkContact();
    const { enrollment } = await enrollContact(CO, seq.id, contact.id, { now: NOW });
    const id = enrollment?.id ?? "";
    assert.equal(await stopEnrollment(OTHER_CO, id, "stopped_manual"), null);
    assert.equal(await pauseEnrollment(OTHER_CO, id), null);
    assert.equal(await resumeEnrollment(OTHER_CO, id), null);
  });
});

describe("stopEnrollmentsForThread", () => {
  test("stops the live enrolments on a thread and counts them", async () => {
    const seq = await mkSequence();
    const one = await mkContact({ email: "one@example.com" });
    const two = await mkContact({ email: "two@example.com" });
    await insert(SequenceEnrollment, {
      companyId: CO,
      sequenceId: seq.id,
      contactId: one.id,
      status: "active",
      nextRunAt: NOW,
      mailThreadId: "th_1",
    });
    await insert(SequenceEnrollment, {
      companyId: CO,
      sequenceId: seq.id,
      contactId: two.id,
      status: "paused",
      mailThreadId: "th_1",
    });

    const stopped = await stopEnrollmentsForThread(CO, "th_1", "stopped_replied", "replied");
    assert.equal(stopped, 2);
    const rows = await enrollmentRepo().findBy({ companyId: CO, mailThreadId: "th_1" });
    assert.ok(rows.every((r) => r.status === "stopped_replied" && r.nextRunAt === null));
  });

  test("leaves an already-terminal enrolment alone", async () => {
    const seq = await mkSequence();
    const contact = await mkContact();
    await insert(SequenceEnrollment, {
      companyId: CO,
      sequenceId: seq.id,
      contactId: contact.id,
      status: "completed",
      mailThreadId: "th_1",
    });
    assert.equal(await stopEnrollmentsForThread(CO, "th_1", "stopped_replied"), 0);
  });

  test("is company scoped and tolerates an empty thread id", async () => {
    const seq = await mkSequence();
    const contact = await mkContact();
    await insert(SequenceEnrollment, {
      companyId: CO,
      sequenceId: seq.id,
      contactId: contact.id,
      status: "active",
      mailThreadId: "th_1",
    });
    assert.equal(await stopEnrollmentsForThread(OTHER_CO, "th_1", "stopped_replied"), 0);
    assert.equal(await stopEnrollmentsForThread(CO, "", "stopped_replied"), 0);
  });

  test("a sequence with stopOnReply off is NOT stopped by a reply", async () => {
    // Regression: the flag was inert when this was first wired, because the
    // check was documented as the caller's job and the only caller did not do
    // it. The gate lives in stopEnrollmentsForThread now, keyed off the status.
    const seq = await mkSequence({ stopOnReply: false });
    const contact = await mkContact();
    await insert(SequenceEnrollment, {
      companyId: CO,
      sequenceId: seq.id,
      contactId: contact.id,
      status: "active",
      nextRunAt: NOW,
      mailThreadId: "th_optout",
    });

    assert.equal(await stopEnrollmentsForThread(CO, "th_optout", "stopped_replied"), 0);
    const row = await enrollmentRepo().findOneBy({ mailThreadId: "th_optout" });
    assert.equal(row?.status, "active");
  });

  test("the opt-out applies only to replies — an unsubscribe still stops it", async () => {
    // stopOnReply is about replies. Somebody who unsubscribes must come out of
    // the sequence regardless of how it is configured.
    const seq = await mkSequence({ stopOnReply: false });
    const contact = await mkContact();
    await insert(SequenceEnrollment, {
      companyId: CO,
      sequenceId: seq.id,
      contactId: contact.id,
      status: "active",
      mailThreadId: "th_unsub",
    });

    assert.equal(
      await stopEnrollmentsForThread(CO, "th_unsub", "stopped_unsubscribed"),
      1,
    );
  });

  test("only the opted-out sequence is exempt — others on the thread still stop", async () => {
    // Distinct slugs: (companyId, slug) is uniquely indexed.
    const optedOut = await mkSequence({ stopOnReply: false, slug: "opted-out" });
    const optedIn = await mkSequence({ stopOnReply: true, slug: "opted-in" });
    const one = await mkContact({ email: "a@example.com" });
    const two = await mkContact({ email: "b@example.com" });
    await insert(SequenceEnrollment, {
      companyId: CO,
      sequenceId: optedOut.id,
      contactId: one.id,
      status: "active",
      mailThreadId: "th_mixed",
    });
    await insert(SequenceEnrollment, {
      companyId: CO,
      sequenceId: optedIn.id,
      contactId: two.id,
      status: "active",
      mailThreadId: "th_mixed",
    });

    assert.equal(await stopEnrollmentsForThread(CO, "th_mixed", "stopped_replied"), 1);
    const rows = await enrollmentRepo().findBy({ companyId: CO, mailThreadId: "th_mixed" });
    const byStatus = rows.map((r) => r.status).sort();
    assert.deepEqual(byStatus, ["active", "stopped_replied"]);
  });
});

describe("stopEnrollmentsForEmail", () => {
  test("stops every live enrolment for whoever owns the address", async () => {
    const first = await mkSequence({ slug: "one" });
    const second = await mkSequence({ slug: "two" });
    const contact = await mkContact({ email: "gone@example.com" });
    await insert(SequenceEnrollment, {
      companyId: CO,
      sequenceId: first.id,
      contactId: contact.id,
      status: "active",
      nextRunAt: NOW,
    });
    await insert(SequenceEnrollment, {
      companyId: CO,
      sequenceId: second.id,
      contactId: contact.id,
      status: "active",
      nextRunAt: NOW,
    });

    const stopped = await stopEnrollmentsForEmail(
      CO,
      "  GONE@Example.com ",
      "stopped_unsubscribed",
      "clicked unsubscribe",
    );
    assert.equal(stopped, 2);
    const rows = await enrollmentRepo().findBy({ companyId: CO, contactId: contact.id });
    assert.ok(rows.every((r) => r.status === "stopped_unsubscribed"));
  });

  test("stops both rows when an address resolved to two contacts", async () => {
    const seq = await mkSequence();
    const a = await mkContact({ email: "dupe@example.com" });
    const b = await mkContact({ email: "dupe@example.com" });
    await insert(SequenceEnrollment, {
      companyId: CO,
      sequenceId: seq.id,
      contactId: a.id,
      status: "active",
    });
    await insert(SequenceEnrollment, {
      companyId: CO,
      sequenceId: seq.id,
      contactId: b.id,
      status: "active",
    });
    assert.equal(await stopEnrollmentsForEmail(CO, "dupe@example.com", "stopped_bounced"), 2);
  });

  test("returns 0 for an unusable or unknown address instead of throwing", async () => {
    assert.equal(await stopEnrollmentsForEmail(CO, "junk", "stopped_bounced"), 0);
    assert.equal(await stopEnrollmentsForEmail(CO, "", "stopped_bounced"), 0);
    assert.equal(await stopEnrollmentsForEmail(CO, "nobody@example.com", "stopped_bounced"), 0);
  });
});

describe("getSequence", () => {
  test("resolves an archived sequence — history must not lose its campaign", async () => {
    const seq = await mkSequence({ status: "archived", archivedAt: NOW });
    assert.equal((await getSequence(CO, seq.id))?.id, seq.id);
  });

  test("does not resolve across companies", async () => {
    const seq = await mkSequence();
    assert.equal(await getSequence(OTHER_CO, seq.id), null);
  });
});
