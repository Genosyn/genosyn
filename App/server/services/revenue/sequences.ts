import { Brackets, In, type SelectQueryBuilder } from "typeorm";

import { AppDataSource } from "../../db/datasource.js";
import { Contact } from "../../db/entities/Contact.js";
import {
  DEFAULT_SEND_WINDOW,
  Sequence,
  type SequenceStatus,
} from "../../db/entities/Sequence.js";
import {
  ENROLLMENT_STATUSES,
  SequenceEnrollment,
  TERMINAL_ENROLLMENT_STATUSES,
  type EnrollmentStatus,
} from "../../db/entities/SequenceEnrollment.js";
import { SequenceStep } from "../../db/entities/SequenceStep.js";
import { normalizeEmail } from "../../lib/emailAddress.js";
import { toSlug } from "../../lib/slug.js";
import { partitionRecipients } from "../mail/suppression.js";
import { recordActivity } from "./activities.js";
import type { SendWindow } from "./sendWindow.js";

/**
 * Sequences — campaign definition, the step ladder, and enrolment.
 *
 * This module owns everything about a sequence *except* the act of sending;
 * `sequenceTick.ts` owns that. The split is deliberate: enrolment is a
 * request-path operation that a human or a Signal triggers and that must answer
 * immediately, while sending is a background sweep with its own budget. Putting
 * them in one file would mean the enrolment path imported the drafter and every
 * route test needed a mail account.
 *
 * The rule the whole module bends around: **enrolment refuses, it does not
 * throw.** Every gate — archived contact, do-not-contact, no address, a
 * suppression row, an enrolment that already exists — returns a reason. Bulk
 * enrolment is the common case (somebody selects 80 rows and presses Enrol),
 * and one blocked contact in eighty must not fail the other seventy-nine or
 * leave the caller guessing which one it was. Callers that want a hard failure
 * check `skipped` themselves; nothing here decides that for them.
 *
 * The one place we *are* strict is double-enrolment. The unique
 * `(sequenceId, contactId)` index means a second row is impossible anyway, so
 * re-enrolling somebody who finished resets the row they already have rather
 * than inserting — see {@link enrollContact}.
 */

export type SequenceActor = {
  userId?: string | null;
  employeeId?: string | null;
};

export type SequenceInput = {
  name: string;
  description?: string;
  status?: SequenceStatus;
  mailAccountId: string;
  employeeId: string;
  brief?: string;
  autoSend?: boolean;
  stopOnReply?: boolean;
  dailyCap?: number;
  /** Null (or omitted) stores nothing and reads back as {@link DEFAULT_SEND_WINDOW}. */
  sendWindow?: SendWindow | null;
};

export type SequenceListOptions = {
  status?: SequenceStatus;
  q?: string;
  /** Include archived rows. Default false. */
  includeArchived?: boolean;
};

export type EnrollmentCounts = Record<EnrollmentStatus, number>;

/** Sequence plus the numbers the list needs, so a row is not an N+1 lookup. */
export type HydratedSequence = Sequence & {
  enrollmentCounts: EnrollmentCounts;
  activeCount: number;
  totalEnrolled: number;
  stepCount: number;
};

export type SequenceStepInput = {
  name?: string;
  delayDays?: number;
  delayHours?: number;
  instruction?: string;
  threadWithPrevious?: boolean;
};

/**
 * Why a contact was not enrolled. Every one of these is a normal outcome that
 * the UI renders next to the contact's name, which is why they are a closed
 * union rather than free text — a reason nobody can switch on is a reason
 * nobody explains to the user.
 */
export type EnrollSkipReason =
  | "sequence_not_found"
  | "sequence_archived"
  | "contact_not_found"
  | "contact_archived"
  | "do_not_contact"
  | "no_email"
  | "suppressed"
  | "already_enrolled"
  | "bulk_limit";

export type EnrollResult = {
  /** The row that now exists, or the blocking row for `already_enrolled`. */
  enrollment: SequenceEnrollment | null;
  skipped?: EnrollSkipReason;
};

export type BulkEnrollResult = {
  enrolled: number;
  skipped: Array<{ contactId: string; reason: EnrollSkipReason }>;
};

/** The statuses {@link stopEnrollment} may write — the terminal set. */
export type StopStatus = Extract<
  EnrollmentStatus,
  | "completed"
  | "stopped_replied"
  | "stopped_bounced"
  | "stopped_unsubscribed"
  | "stopped_manual"
  | "failed"
>;

/**
 * One request may enrol at most this many contacts.
 *
 * Enrolment is a row plus an activity per contact, so an unbounded bulk from a
 * "select all 40,000 leads" click would hold a request open for minutes and
 * bury the tick under a backlog nobody reviewed. Contacts past the limit come
 * back as `bulk_limit` skips rather than being silently dropped, so the caller
 * can tell the user to enrol the rest in a second pass.
 */
export const MAX_BULK_ENROLL = 500;

/** Keeps `dailyCap` inside a 32-bit `int` column and out of absurd territory. */
const MAX_DAILY_CAP = 100_000;

// ── Sequences ──────────────────────────────────────────────────────────────

function applySearch(qb: SelectQueryBuilder<Sequence>, q: string): void {
  const term = `%${q.trim().toLowerCase()}%`;
  qb.andWhere(
    new Brackets((w) => {
      w.where("s.name LIKE :term", { term }).orWhere("s.description LIKE :term", {
        term,
      });
    }),
  );
}

/**
 * Every sequence for the company with its enrolment counts.
 *
 * Deliberately unpaginated: a company runs tens of sequences, not thousands,
 * and the page that consumes this shows all of them with a status filter. Adding
 * limit/offset here would be ceremony that every caller then has to thread
 * through.
 *
 * The counts come from **one grouped query** over the enrolment table, not a
 * count per row. The N+1 version is invisible in development (three sequences,
 * three extra queries) and is the first thing to fall over on a real account.
 */
export async function listSequences(
  companyId: string,
  opts: SequenceListOptions = {},
): Promise<HydratedSequence[]> {
  const qb = AppDataSource.getRepository(Sequence)
    .createQueryBuilder("s")
    .where("s.companyId = :companyId", { companyId });

  if (!opts.includeArchived) qb.andWhere("s.archivedAt IS NULL");
  if (opts.status) qb.andWhere("s.status = :status", { status: opts.status });
  if (opts.q) applySearch(qb, opts.q);

  const rows = await qb.orderBy("s.updatedAt", "DESC").addOrderBy("s.createdAt", "DESC").getMany();
  return hydrateSequences(companyId, rows);
}

/** Attach counts to a page of sequences in two queries, whatever the page size. */
export async function hydrateSequences(
  companyId: string,
  rows: Sequence[],
): Promise<HydratedSequence[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);

  const [enrollmentRows, stepRows] = await Promise.all([
    AppDataSource.getRepository(SequenceEnrollment)
      .createQueryBuilder("e")
      .select("e.sequenceId", "sequenceId")
      .addSelect("e.status", "status")
      .addSelect("COUNT(*)", "count")
      .where("e.companyId = :companyId", { companyId })
      .andWhere("e.sequenceId IN (:...ids)", { ids })
      .groupBy("e.sequenceId")
      .addGroupBy("e.status")
      .getRawMany<{ sequenceId: string; status: EnrollmentStatus; count: string | number }>(),
    AppDataSource.getRepository(SequenceStep)
      .createQueryBuilder("st")
      .select("st.sequenceId", "sequenceId")
      .addSelect("COUNT(*)", "count")
      .where("st.companyId = :companyId", { companyId })
      .andWhere("st.sequenceId IN (:...ids)", { ids })
      .groupBy("st.sequenceId")
      .getRawMany<{ sequenceId: string; count: string | number }>(),
  ]);

  const counts = new Map<string, EnrollmentCounts>();
  for (const row of enrollmentRows) {
    const bucket = counts.get(row.sequenceId) ?? emptyCounts();
    bucket[row.status] = Number(row.count);
    counts.set(row.sequenceId, bucket);
  }
  const steps = new Map(stepRows.map((r) => [r.sequenceId, Number(r.count)]));

  return rows.map((row) => {
    const enrollmentCounts = counts.get(row.id) ?? emptyCounts();
    const totalEnrolled = ENROLLMENT_STATUSES.reduce(
      (sum, status) => sum + enrollmentCounts[status],
      0,
    );
    return Object.assign(row, {
      enrollmentCounts,
      activeCount: enrollmentCounts.active,
      totalEnrolled,
      stepCount: steps.get(row.id) ?? 0,
    });
  });
}

/** Zero-filled so the UI can read every status without a presence check. */
function emptyCounts(): EnrollmentCounts {
  const out = {} as EnrollmentCounts;
  for (const status of ENROLLMENT_STATUSES) out[status] = 0;
  return out;
}

/** Archived sequences resolve — a step run must not lose the campaign it ran in. */
export async function getSequence(companyId: string, id: string): Promise<Sequence | null> {
  return AppDataSource.getRepository(Sequence).findOneBy({ id, companyId });
}

export async function getSequenceBySlug(
  companyId: string,
  slug: string,
): Promise<Sequence | null> {
  return AppDataSource.getRepository(Sequence).findOneBy({ companyId, slug });
}

/**
 * Unique sequence slug within one company.
 *
 * Archived sequences keep their slug, so an archive-then-recreate cycle gets
 * `q3-outbound-2` rather than colliding with the history the first one owns.
 */
export async function uniqueSequenceSlug(companyId: string, base: string): Promise<string> {
  const repo = AppDataSource.getRepository(Sequence);
  const root = toSlug(base) || "sequence";
  let slug = root;
  let n = 1;
  while (await repo.findOneBy({ companyId, slug })) {
    n += 1;
    slug = `${root}-${n}`;
  }
  return slug;
}

/**
 * Create a sequence. Lands in `draft` unless told otherwise — a campaign that
 * went active the moment somebody typed a name would start mailing before the
 * ladder existed.
 */
export async function createSequence(
  companyId: string,
  input: SequenceInput,
  actor: SequenceActor = {},
): Promise<Sequence> {
  const repo = AppDataSource.getRepository(Sequence);
  const name = input.name.trim();
  return repo.save(
    repo.create({
      companyId,
      name,
      slug: await uniqueSequenceSlug(companyId, name),
      description: input.description ?? "",
      status: input.status ?? "draft",
      mailAccountId: input.mailAccountId,
      employeeId: input.employeeId,
      brief: input.brief ?? "",
      autoSend: input.autoSend ?? false,
      stopOnReply: input.stopOnReply ?? true,
      dailyCap: clampDailyCap(input.dailyCap),
      sendWindowJson: serializeSendWindow(input.sendWindow),
      createdById: actor.userId ?? null,
      createdByEmployeeId: actor.employeeId ?? null,
    }),
  );
}

/**
 * Patch a sequence.
 *
 * The slug is **not** regenerated on rename. It is in URLs and in the links
 * people paste to each other, and a campaign renamed from "Q3 Outbound" to "Q3
 * Outbound (EMEA)" is the same campaign — rotting every existing link to make
 * the slug prettier is a bad trade.
 */
export async function updateSequence(
  companyId: string,
  id: string,
  patch: Partial<SequenceInput>,
): Promise<Sequence | null> {
  const repo = AppDataSource.getRepository(Sequence);
  const sequence = await repo.findOneBy({ id, companyId });
  if (!sequence) return null;

  if (patch.name !== undefined) sequence.name = patch.name.trim();
  if (patch.description !== undefined) sequence.description = patch.description;
  if (patch.status !== undefined) sequence.status = patch.status;
  if (patch.mailAccountId !== undefined) sequence.mailAccountId = patch.mailAccountId;
  if (patch.employeeId !== undefined) sequence.employeeId = patch.employeeId;
  if (patch.brief !== undefined) sequence.brief = patch.brief;
  if (patch.autoSend !== undefined) sequence.autoSend = patch.autoSend;
  if (patch.stopOnReply !== undefined) sequence.stopOnReply = patch.stopOnReply;
  if (patch.dailyCap !== undefined) sequence.dailyCap = clampDailyCap(patch.dailyCap);
  if (patch.sendWindow !== undefined) {
    sequence.sendWindowJson = serializeSendWindow(patch.sendWindow);
  }

  return repo.save(sequence);
}

/**
 * Archive a sequence and stop everyone still moving through it.
 *
 * Stopping the enrolments is not a courtesy — the scheduler selects on
 * `(status, nextRunAt)` and knows nothing about the sequence until it has
 * loaded it, so live enrolments pointing at an archived campaign would be
 * re-read on every tick forever. They are stopped as `stopped_manual` because
 * that is what happened: a human ended the campaign.
 */
export async function archiveSequence(
  companyId: string,
  id: string,
  now = new Date(),
): Promise<Sequence | null> {
  const repo = AppDataSource.getRepository(Sequence);
  const sequence = await repo.findOneBy({ id, companyId });
  if (!sequence) return null;

  sequence.archivedAt = now;
  sequence.status = "archived";
  const saved = await repo.save(sequence);

  await stopEnrollmentsWhere(
    (qb) => qb.andWhere("e.sequenceId = :sequenceId", { sequenceId: id }),
    companyId,
    "stopped_manual",
    "sequence archived",
  );
  return saved;
}

// ── Steps ──────────────────────────────────────────────────────────────────

export async function listSteps(
  companyId: string,
  sequenceId: string,
): Promise<SequenceStep[]> {
  return AppDataSource.getRepository(SequenceStep).find({
    where: { companyId, sequenceId },
    order: { sortOrder: "ASC", id: "ASC" },
  });
}

/**
 * Replace the whole ladder, renumbering `sortOrder` from 0.
 *
 * Wholesale rather than per-step create/update/delete because **the builder
 * always knows the full ladder**: it is a drag-and-drop list, every save posts
 * the complete array, and a patch API would need stable step ids round-tripped
 * through a UI that lets you reorder, insert and delete in one edit. Applying
 * the array wholesale also makes two concurrent editors converge on one of the
 * two ladders instead of interleaving into a third that neither wrote.
 *
 * What this deliberately does not do:
 *
 * - **It does not preserve step ids.** Old {@link SequenceStepRun} rows keep
 *   pointing at deleted step ids, which is exactly why a run snapshots
 *   `stepOrder` and `subject` — the history reads correctly without the step.
 * - **It does not touch enrolments.** An enrolment sitting at `currentStepOrder`
 *   5 in a ladder that just shrank to 2 is not corrupt: the tick sees
 *   `currentStepOrder >= steps.length` and completes it, which is the honest
 *   outcome for "the steps they had left were deleted".
 *
 * Runs in a transaction so a failed insert cannot leave the sequence with no
 * ladder at all.
 */
export async function replaceSteps(
  companyId: string,
  sequenceId: string,
  steps: SequenceStepInput[],
): Promise<SequenceStep[]> {
  await AppDataSource.transaction(async (m) => {
    await m.delete(SequenceStep, { companyId, sequenceId });
    if (steps.length === 0) return;
    const rows = steps.map((step, index) =>
      m.create(SequenceStep, {
        companyId,
        sequenceId,
        sortOrder: index,
        name: step.name ?? "",
        delayDays: clampDelay(step.delayDays, 3),
        delayHours: clampDelay(step.delayHours, 0),
        instruction: step.instruction ?? "",
        threadWithPrevious: step.threadWithPrevious ?? true,
      }),
    );
    await m.save(rows);
  });
  return listSteps(companyId, sequenceId);
}

// ── Send window ────────────────────────────────────────────────────────────

/**
 * The sequence's send window, or the default when the column is null or junk.
 *
 * **Never throws.** This runs inside the scheduler loop, and a single sequence
 * whose `sendWindowJson` was hand-edited into invalid JSON must not take down
 * the tick for every other company. Fields are validated one at a time and fall
 * back individually, so a good `days` list survives a garbage `timezone`.
 *
 * An **empty `days` array is preserved**, not replaced with the default. It is
 * the supported way to freeze a sequence without pausing it (see
 * `isWithinSendWindow`), and defaulting it would quietly start sending again.
 */
export function parseSendWindow(sequence: { sendWindowJson: string | null }): SendWindow {
  if (!sequence.sendWindowJson) return defaultWindow();

  let raw: unknown;
  try {
    raw = JSON.parse(sequence.sendWindowJson);
  } catch {
    return defaultWindow();
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return defaultWindow();
  }

  const candidate = raw as Partial<Record<keyof SendWindow, unknown>>;
  const days = Array.isArray(candidate.days)
    ? candidate.days
        .filter((d): d is number => typeof d === "number" && Number.isInteger(d))
        .filter((d) => d >= 0 && d <= 6)
    : [...DEFAULT_SEND_WINDOW.days];

  return {
    days,
    startHour: finiteOr(candidate.startHour, DEFAULT_SEND_WINDOW.startHour),
    endHour: finiteOr(candidate.endHour, DEFAULT_SEND_WINDOW.endHour),
    timezone:
      typeof candidate.timezone === "string" && candidate.timezone.trim()
        ? candidate.timezone
        : DEFAULT_SEND_WINDOW.timezone,
  };
}

/**
 * A fresh default window, `days` array included.
 *
 * The array copy is the point: `DEFAULT_SEND_WINDOW` is a module-level const,
 * and a spread alone would hand every caller the *same* days array. One caller
 * pushing a day onto it would silently change the default window for every
 * sequence in the process until the next restart.
 */
function defaultWindow(): SendWindow {
  return { ...DEFAULT_SEND_WINDOW, days: [...DEFAULT_SEND_WINDOW.days] };
}

function finiteOr(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return value;
}

function serializeSendWindow(window: SendWindow | null | undefined): string | null {
  if (!window) return null;
  try {
    return JSON.stringify({
      days: window.days,
      startHour: window.startHour,
      endHour: window.endHour,
      timezone: window.timezone,
    });
  } catch {
    // Unreachable for a well-formed SendWindow, but a caller handing us a proxy
    // or a circular object should get the default window rather than a 500.
    return null;
  }
}

// ── Enrolment ──────────────────────────────────────────────────────────────

/**
 * The refusal rules, as one pure function.
 *
 * Order matters. `doNotContact` is checked before suppression even though
 * `suppressedAmong` also treats a do-not-contact person as blocked, because the
 * two reasons mean different things to whoever is reading the skip list: one is
 * "your colleague marked this person off-limits", the other is "this address
 * opted out". Reporting the vaguer of the two would send somebody hunting
 * through the suppression table for a row that does not exist.
 */
function enrollmentGate(
  contact: Contact | null,
  existing: SequenceEnrollment | null,
  suppressed: boolean,
): EnrollSkipReason | null {
  if (!contact) return "contact_not_found";
  if (contact.archivedAt) return "contact_archived";
  if (contact.doNotContact) return "do_not_contact";
  if (!contact.email) return "no_email";
  if (suppressed) return "suppressed";
  // Paused counts as active for this purpose: somebody mid-ladder should be
  // resumed, not restarted from the opening line they already received.
  if (existing && !TERMINAL_ENROLLMENT_STATUSES.includes(existing.status)) {
    return "already_enrolled";
  }
  return null;
}

/**
 * Insert or reset the enrolment row and log it.
 *
 * `nextRunAt` is set to `now` rather than `now + step 0's delay`. Enrolment is
 * itself the trigger — somebody pressed Enrol, or a Signal fired — and the
 * builder's default of three days on every step would otherwise hold every new
 * enrolment for three days before the opening touch, which reads as a bug. The
 * send window still applies: the tick pushes `now` to the next opening rather
 * than mailing at whatever hour the button was pressed.
 */
async function writeEnrollment(
  companyId: string,
  sequence: Sequence,
  contact: Contact,
  existing: SequenceEnrollment | null,
  opts: { dealId?: string | null; actor?: SequenceActor; now?: Date },
): Promise<SequenceEnrollment> {
  const now = opts.now ?? new Date();
  const actor = opts.actor ?? {};
  const repo = AppDataSource.getRepository(SequenceEnrollment);

  const row = existing ?? repo.create({ companyId, sequenceId: sequence.id, contactId: contact.id });
  const reenrolled = existing !== null;

  row.dealId = opts.dealId ?? row.dealId ?? null;
  row.status = "active";
  row.currentStepOrder = 0;
  row.nextRunAt = now;
  row.lastStepAt = null;
  row.stoppedReason = "";
  // A re-enrolment starts a new conversation. Keeping the old thread id would
  // make step 1 of the new run reply into a campaign that already ended.
  row.mailThreadId = null;
  if (!reenrolled) {
    row.createdById = actor.userId ?? null;
    row.createdByEmployeeId = actor.employeeId ?? null;
  }

  const saved = await repo.save(row);

  await recordActivity(
    companyId,
    {
      kind: "enrollment",
      subject: reenrolled ? `Re-enrolled in ${sequence.name}` : `Enrolled in ${sequence.name}`,
      contactId: contact.id,
      dealId: saved.dealId,
      customerId: contact.customerId,
      occurredAt: now,
      meta: { sequenceId: sequence.id, sequenceName: sequence.name, reenrolled },
    },
    actor,
  );

  return saved;
}

/**
 * Enrol one contact, refusing rather than throwing.
 *
 * Re-enrolling somebody whose enrolment is **terminal** resets that row —
 * status back to active, `currentStepOrder` to 0, `nextRunAt` to now — instead
 * of inserting a second. The unique `(sequenceId, contactId)` index requires
 * this, and it is also the behaviour you want: the history of what they were
 * sent lives on `SequenceStepRun`, which is append-only, so nothing is lost by
 * reusing the row.
 */
export async function enrollContact(
  companyId: string,
  sequenceId: string,
  contactId: string,
  opts: { dealId?: string | null; actor?: SequenceActor; now?: Date } = {},
): Promise<EnrollResult> {
  const sequence = await getSequence(companyId, sequenceId);
  if (!sequence) return { enrollment: null, skipped: "sequence_not_found" };
  if (sequence.archivedAt || sequence.status === "archived") {
    return { enrollment: null, skipped: "sequence_archived" };
  }

  const contact = await AppDataSource.getRepository(Contact).findOneBy({
    id: contactId,
    companyId,
  });
  const existing = await AppDataSource.getRepository(SequenceEnrollment).findOneBy({
    companyId,
    sequenceId,
    contactId,
  });

  let suppressed = false;
  if (contact?.email) {
    const partition = await partitionRecipients(companyId, [contact.email]);
    suppressed = partition.suppressed.length > 0;
  }

  const reason = enrollmentGate(contact, existing, suppressed);
  if (reason) {
    return { enrollment: reason === "already_enrolled" ? existing : null, skipped: reason };
  }

  // The gate guarantees both of these; the assertions are for the type checker.
  const enrollment = await writeEnrollment(
    companyId,
    sequence,
    contact as Contact,
    existing,
    opts,
  );
  return { enrollment };
}

/**
 * Enrol many contacts in one pass.
 *
 * Reads the contacts, their existing enrolments and the suppression list in
 * three queries rather than three per contact — a hundred-row bulk otherwise
 * costs three hundred round-trips before it writes anything. The writes stay
 * sequential, because each one is a row plus an activity and the point of the
 * cap is that this stays bounded rather than fast.
 */
export async function bulkEnroll(
  companyId: string,
  sequenceId: string,
  contactIds: string[],
  opts: { dealId?: string | null; actor?: SequenceActor; now?: Date } = {},
): Promise<BulkEnrollResult> {
  const out: BulkEnrollResult = { enrolled: 0, skipped: [] };
  const unique = [...new Set(contactIds.filter(Boolean))];
  if (unique.length === 0) return out;

  const ids = unique.slice(0, MAX_BULK_ENROLL);
  for (const contactId of unique.slice(MAX_BULK_ENROLL)) {
    out.skipped.push({ contactId, reason: "bulk_limit" });
  }

  const sequence = await getSequence(companyId, sequenceId);
  if (!sequence || sequence.archivedAt || sequence.status === "archived") {
    const reason: EnrollSkipReason = sequence ? "sequence_archived" : "sequence_not_found";
    for (const contactId of ids) out.skipped.push({ contactId, reason });
    return out;
  }

  const [contacts, enrollments] = await Promise.all([
    AppDataSource.getRepository(Contact).find({ where: { companyId, id: In(ids) } }),
    AppDataSource.getRepository(SequenceEnrollment).find({
      where: { companyId, sequenceId, contactId: In(ids) },
    }),
  ]);
  const contactById = new Map(contacts.map((c) => [c.id, c]));
  const enrollmentByContact = new Map(enrollments.map((e) => [e.contactId, e]));

  const emails = contacts.map((c) => c.email).filter(Boolean);
  const { suppressed } = await partitionRecipients(companyId, emails);
  const blocked = new Set(suppressed);

  for (const contactId of ids) {
    const contact = contactById.get(contactId) ?? null;
    const isBlocked = contact ? blocked.has(normalizeEmail(contact.email) ?? "") : false;
    const existing = enrollmentByContact.get(contactId) ?? null;
    const reason = enrollmentGate(contact, existing, isBlocked);
    if (reason) {
      out.skipped.push({ contactId, reason });
      continue;
    }
    await writeEnrollment(companyId, sequence, contact as Contact, existing, opts);
    out.enrolled += 1;
  }

  return out;
}

// ── Enrolment lifecycle ────────────────────────────────────────────────────

export async function getEnrollment(
  companyId: string,
  id: string,
): Promise<SequenceEnrollment | null> {
  return AppDataSource.getRepository(SequenceEnrollment).findOneBy({ id, companyId });
}

export type EnrollmentListOptions = {
  sequenceId?: string;
  contactId?: string;
  status?: EnrollmentStatus;
  limit?: number;
  offset?: number;
};

export async function listEnrollments(
  companyId: string,
  opts: EnrollmentListOptions = {},
): Promise<{ rows: SequenceEnrollment[]; total: number }> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);

  const qb = AppDataSource.getRepository(SequenceEnrollment)
    .createQueryBuilder("e")
    .where("e.companyId = :companyId", { companyId });

  if (opts.sequenceId) qb.andWhere("e.sequenceId = :sid", { sid: opts.sequenceId });
  if (opts.contactId) qb.andWhere("e.contactId = :cid", { cid: opts.contactId });
  if (opts.status) qb.andWhere("e.status = :status", { status: opts.status });

  const total = await qb.clone().getCount();
  const rows = await qb.orderBy("e.updatedAt", "DESC").skip(offset).take(limit).getMany();
  return { rows, total };
}

/**
 * End one enrolment.
 *
 * Writes no activity. The events worth putting on a timeline are the ones a
 * human can act on, and every caller of this already produces one: a reply
 * lands as `email_in`, an unsubscribe as `unsubscribe`, a manual stop is a
 * click the user just made. A third row saying "and then we stopped mailing
 * them" is noise on the one screen that must stay readable.
 */
export async function stopEnrollment(
  companyId: string,
  enrollmentId: string,
  status: StopStatus,
  reason = "",
): Promise<SequenceEnrollment | null> {
  const repo = AppDataSource.getRepository(SequenceEnrollment);
  const enrollment = await repo.findOneBy({ id: enrollmentId, companyId });
  if (!enrollment) return null;
  enrollment.status = status;
  enrollment.stoppedReason = reason;
  enrollment.nextRunAt = null;
  return repo.save(enrollment);
}

/**
 * Pause an enrolment. Only an active one — pausing something already stopped
 * would resurrect it into a state the scheduler treats as resumable.
 */
export async function pauseEnrollment(
  companyId: string,
  enrollmentId: string,
  reason = "",
): Promise<SequenceEnrollment | null> {
  const repo = AppDataSource.getRepository(SequenceEnrollment);
  const enrollment = await repo.findOneBy({ id: enrollmentId, companyId });
  if (!enrollment) return null;
  if (enrollment.status !== "active") return enrollment;
  enrollment.status = "paused";
  enrollment.stoppedReason = reason;
  enrollment.nextRunAt = null;
  return repo.save(enrollment);
}

/**
 * Resume a paused enrolment at the step it stopped on.
 *
 * `nextRunAt` is `now`, not the time it would have fired had it never paused —
 * `computeNextRunAt` clamps to the present for exactly this reason, and a
 * sequence paused for a fortnight must not wake up and fire its whole backlog.
 * Terminal enrolments are returned untouched; restarting one is
 * {@link enrollContact}'s job, and it resets the ladder rather than continuing
 * from wherever the contact happened to stop.
 */
export async function resumeEnrollment(
  companyId: string,
  enrollmentId: string,
  now = new Date(),
): Promise<SequenceEnrollment | null> {
  const repo = AppDataSource.getRepository(SequenceEnrollment);
  const enrollment = await repo.findOneBy({ id: enrollmentId, companyId });
  if (!enrollment) return null;
  if (enrollment.status !== "paused") return enrollment;
  enrollment.status = "active";
  enrollment.stoppedReason = "";
  enrollment.nextRunAt = now;
  return repo.save(enrollment);
}

/**
 * Stop every live enrolment matching a predicate.
 *
 * Counts the ids first and updates by id rather than trusting `affected` from
 * an `UPDATE ... WHERE`. The drivers disagree about whether that field is
 * populated, and the count is the return value callers log ("stopped 3
 * enrolments on this thread") — a number that is right on Postgres and
 * undefined on SQLite is worse than a second query.
 *
 * Only `active` and `paused` rows are touched. A reply arriving on a thread
 * whose enrolment already completed must not rewrite the completed status into
 * `stopped_replied`, or the sequence report loses its finished count.
 */
async function stopEnrollmentsWhere(
  narrow: (qb: SelectQueryBuilder<SequenceEnrollment>) => SelectQueryBuilder<SequenceEnrollment>,
  companyId: string,
  status: StopStatus,
  reason: string,
): Promise<number> {
  const repo = AppDataSource.getRepository(SequenceEnrollment);
  const qb = repo
    .createQueryBuilder("e")
    .select("e.id", "id")
    .where("e.companyId = :companyId", { companyId })
    .andWhere("e.status IN (:...live)", { live: ["active", "paused"] });

  const rows = await narrow(qb).getRawMany<{ id: string }>();
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return 0;

  await repo
    .createQueryBuilder()
    .update(SequenceEnrollment)
    .set({ status, stoppedReason: reason, nextRunAt: null })
    .where("companyId = :companyId", { companyId })
    .andWhere("id IN (:...ids)", { ids })
    .execute();

  return ids.length;
}

/**
 * Stop everyone whose conversation lives in this thread — mail sync calls it
 * when a reply arrives on a sequence thread.
 *
 * Keyed on the thread rather than the contact because that is what sync
 * actually holds, and because a reply from a colleague on the same thread is
 * still the signal that the campaign has done its job.
 *
 * `stopped_replied` additionally honours each sequence's own `stopOnReply`
 * flag. That check lives here rather than at the call site deliberately: the
 * status *is* the intent, so a future caller cannot forget it and quietly make
 * the setting inert — which is exactly what happened the first time this was
 * wired.
 *
 * It is expressed as an **opt-out** — exclude the sequences that have turned
 * the flag off — rather than an opt-in, so that anything we cannot resolve
 * still stops. An enrolment whose sequence row has gone missing is a state that
 * should not occur, and if it ever does, continuing to mail somebody who has
 * already replied is the worse of the two failures.
 */
export async function stopEnrollmentsForThread(
  companyId: string,
  mailThreadId: string,
  status: StopStatus,
  reason = "",
): Promise<number> {
  if (!mailThreadId) return 0;

  let exemptSequenceIds: string[] = [];
  if (status === "stopped_replied") {
    const optedOut = await AppDataSource.getRepository(Sequence).find({
      where: { companyId, stopOnReply: false },
      select: { id: true },
    });
    exemptSequenceIds = optedOut.map((s) => s.id);
  }

  return stopEnrollmentsWhere(
    (qb) => {
      qb.andWhere("e.mailThreadId = :threadId", { threadId: mailThreadId });
      // Guarded: an empty `NOT IN ()` is a syntax error on both drivers.
      if (exemptSequenceIds.length > 0) {
        qb.andWhere("e.sequenceId NOT IN (:...exemptIds)", {
          exemptIds: exemptSequenceIds,
        });
      }
      return qb;
    },
    companyId,
    status,
    reason,
  );
}

/**
 * Stop every enrolment for whoever owns this address — the unsubscribe and
 * hard-bounce path.
 *
 * Resolves through contacts because enrolments key on `contactId`, and stops
 * **every** matching contact rather than the first: an address that resolved to
 * two rows after a merge race is precisely when you cannot afford to keep
 * mailing one of them. Returns 0 for an unusable address rather than throwing,
 * because the caller is a webhook parsing somebody else's bounce report.
 */
export async function stopEnrollmentsForEmail(
  companyId: string,
  email: string,
  status: StopStatus,
  reason = "",
): Promise<number> {
  const normalized = normalizeEmail(email);
  if (!normalized) return 0;

  const contacts = await AppDataSource.getRepository(Contact).find({
    where: { companyId, email: normalized },
    select: { id: true },
  });
  if (contacts.length === 0) return 0;
  const contactIds = contacts.map((c) => c.id);

  return stopEnrollmentsWhere(
    (qb) => qb.andWhere("e.contactId IN (:...contactIds)", { contactIds }),
    companyId,
    status,
    reason,
  );
}

function clampDailyCap(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 50;
  return Math.min(Math.max(Math.round(value), 0), MAX_DAILY_CAP);
}

function clampDelay(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.round(value), 0), 365);
}
