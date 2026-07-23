import { In } from "typeorm";

import { AppDataSource } from "../../db/datasource.js";
import { Company } from "../../db/entities/Company.js";
import { Customer } from "../../db/entities/Customer.js";
import { Membership } from "../../db/entities/Membership.js";
import { Signal } from "../../db/entities/Signal.js";
import { SignalEvent } from "../../db/entities/SignalEvent.js";
import { normalizeEmail } from "../../lib/emailAddress.js";
import { countMissedSlots } from "../cronMath.js";
import { createNotifications } from "../notifications.js";
import { recordActivity } from "./activities.js";
import { upsertContactByEmail } from "./contacts.js";
import { createDeal } from "./deals.js";
import { enrollContact } from "./sequences.js";
import { dedupeKeyFor, selectNewEvents, truncatePayload } from "./signalDedupe.js";
import {
  MAX_SIGNAL_ROWS,
  isValidSignalCron,
  listRunnableSignals,
  loadExistingDedupeKeys,
  parseActionConfig,
  runSignalQuery,
} from "./signals.js";
import { defaultStageFor } from "./stages.js";

/**
 * The Signal tick — the thing that actually fires. See ROADMAP.md M32.
 *
 * One pass per heartbeat: for every enabled Signal whose cron came due, run its
 * query, work out which rows are new, write one SignalEvent per new row, then
 * run that Signal's action once per event.
 *
 * The invariants worth stating, because each one is a bug this module exists to
 * not have:
 *
 * - **{@link tickSignals} never rejects.** It is called from a scheduler with
 *   no handler above it. A Signal that blows up must degrade to a number in the
 *   return value and a message on its own row, never an unhandled rejection
 *   that takes the process with it.
 * - **One bad Signal cannot silence the others.** Every stage — query, insert,
 *   action, bookkeeping — is caught per Signal and per event. Three hundred
 *   Signals are evaluated in the same pass; one customer's dropped database
 *   connection must cost exactly one Signal.
 * - **The unique index is the dedupe, not this code.** We pre-filter with
 *   {@link loadExistingDedupeKeys} because reading 500 keys is cheaper than 500
 *   failed inserts, but the filter is an optimization. Two replicas ticking the
 *   same Signal in the same second both pass the pre-filter; the loser gets a
 *   constraint violation, and that violation means *"somebody else already
 *   handled this row"* — it is swallowed silently and is not a failure.
 * - **Failure stays visible.** `lastError` is written on every pass, cleared on
 *   success, and the Signal keeps its schedule. A Signal that quietly disabled
 *   itself after an error would be discovered weeks later, by which time the
 *   rows it should have fired on have moved on.
 *
 * The AI-employee action goes through {@link setSignalHandler} rather than
 * importing the runner, for the same reason the sequence drafter does: the tick
 * belongs to the revenue layer, and a static import of the agent runtime would
 * drag model providers into every test that touches a Signal.
 */

/** Everything the `hand_to_employee` action gets handed. */
export type SignalHandoff = {
  signal: Signal;
  event: SignalEvent;
  /** The result row as the customer's database returned it. */
  row: Record<string, unknown>;
  /** Parsed `actionConfigJson` — instruction text lives here. */
  config: Record<string, unknown>;
  contactId: string | null;
  customerId: string | null;
};

/**
 * What a handler reports back. `ok: false` is an ordinary outcome, not an
 * exception: "the employee declined" and "the employee crashed" want different
 * detail lines, and forcing the first through a `throw` loses that.
 */
export type SignalHandlerResult = { ok: boolean; detail: string };

export type SignalHandler = (handoff: SignalHandoff) => Promise<SignalHandlerResult>;

/**
 * The default. Reports honestly rather than pretending to succeed, so a process
 * that forgot to wire the handler shows a row of `failed` events with the reason
 * on them instead of a silent no-op nobody notices for a month.
 */
const NO_HANDLER: SignalHandler = async () => ({
  ok: false,
  detail: "no handler configured",
});

let signalHandler: SignalHandler = NO_HANDLER;

/** Wire the AI-employee handoff. Pass `null` to restore the no-op default. */
export function setSignalHandler(handler: SignalHandler | null): void {
  signalHandler = handler ?? NO_HANDLER;
}

// The executor seam lives with the rest of the query plumbing; re-exported here
// so a test of the tick does not have to know which module owns it.
export { setQueryRunner, type SignalQueryRunner } from "./signals.js";

export type SignalTickResult = {
  /** Signals whose cron came due and whose query we ran. */
  evaluated: number;
  /** SignalEvents inserted across every Signal. */
  created: number;
  /**
   * Everything that went wrong and was absorbed: a Signal whose query threw
   * counts once, and each event whose action threw counts once. One number
   * because the only consumer is a log line answering "is this healthy".
   */
  failed: number;
};

/** Per-pass caches, so a hundred events for one company do one company lookup. */
type TickContext = {
  now: Date;
  companySlugs: Map<string, string | null>;
};

/**
 * Has a scheduled slot elapsed since this Signal last ran?
 *
 * A Signal that has never run is due immediately: you enable it because you
 * want it, and waiting up to an hour to find out whether it works is how people
 * conclude the feature is broken.
 *
 * `countMissedSlots(..., cap 1)` is the codebase's existing "did a slot pass"
 * arithmetic — it stops at the first occurrence, so a `* * * * *` Signal that
 * has been off for a week costs one iteration, not ten thousand.
 */
export function isSignalDue(
  signal: Pick<Signal, "cron" | "lastRunAt">,
  now: Date,
): boolean {
  if (!signal.lastRunAt) return true;
  return countMissedSlots(signal.cron, signal.lastRunAt, now, 1).count > 0;
}

/**
 * One scheduler pass over every company's Signals.
 *
 * `now` is a parameter rather than a `new Date()` inside, following
 * `cronMath.ts`: a scheduler you cannot hand a fixed instant is a scheduler you
 * cannot test.
 */
export async function tickSignals(now = new Date()): Promise<SignalTickResult> {
  const result: SignalTickResult = { evaluated: 0, created: 0, failed: 0 };
  const ctx: TickContext = { now, companySlugs: new Map() };

  let signals: Signal[];
  try {
    signals = await listRunnableSignals();
  } catch (err) {
    // The work list itself failed to load — nothing to attribute the error to,
    // so log and let the next heartbeat try again.
    logTickError("loading runnable signals", err);
    return result;
  }

  for (const signal of signals) {
    try {
      await tickOneSignal(signal, ctx, result);
    } catch (err) {
      // Belt and braces: `tickOneSignal` catches its own stages, so reaching
      // here means something structural (a dead connection pool). Still only
      // costs this one Signal.
      result.failed += 1;
      logTickError(`signal ${signal.id}`, err);
    }
  }

  return result;
}

async function tickOneSignal(
  signal: Signal,
  ctx: TickContext,
  result: SignalTickResult,
): Promise<void> {
  // An expression the scheduler cannot parse would otherwise read as "never
  // due" and park the Signal forever with a green status. `createSignal` and
  // `updateSignal` reject these, so getting here means a hand-edited row or a
  // cron-parser upgrade that narrowed what it accepts — both worth shouting
  // about. Only written when the message changes, so a permanently broken
  // Signal does not produce a write every heartbeat.
  if (!isValidSignalCron(signal.cron)) {
    const message = `"${signal.cron}" is not a cron expression this scheduler can run`;
    result.failed += 1;
    if (signal.lastError !== message) await saveSignalQuietly(signal, { lastError: message });
    return;
  }

  if (!isSignalDue(signal, ctx.now)) return;
  result.evaluated += 1;

  let rows: Record<string, unknown>[];
  try {
    const query = await runSignalQuery(signal, { maxRows: MAX_SIGNAL_ROWS });
    // Slice defensively: a stubbed or future runner that ignores `maxRows` must
    // not be able to turn one tick into five thousand notifications.
    rows = (query.rows ?? []).slice(0, MAX_SIGNAL_ROWS);
  } catch (err) {
    result.failed += 1;
    await saveSignalQuietly(signal, {
      lastRunAt: ctx.now,
      lastEventCount: 0,
      lastError: errorMessage(err),
    });
    return;
  }

  // Keys are computed twice — once to build the `IN` list, once inside
  // `selectNewEvents`. `dedupeKeyFor` is pure and deterministic, so the two
  // agree by construction, and keeping the selection logic in one pure function
  // is worth a second pass over at most 500 rows.
  const candidateKeys = rows.map((row) => dedupeKeyFor(row, signal.dedupeKeyColumn));

  let existing: Set<string>;
  try {
    existing = await loadExistingDedupeKeys(signal.id, candidateKeys);
  } catch (err) {
    result.failed += 1;
    await saveSignalQuietly(signal, {
      lastRunAt: ctx.now,
      lastEventCount: 0,
      lastError: errorMessage(err),
    });
    return;
  }

  const selection = selectNewEvents(rows, signal.dedupeKeyColumn, existing);

  let created = 0;
  let actionFailures = 0;
  let firstFailure = "";
  let insertFailures = 0;

  for (const candidate of selection.fresh) {
    let event: SignalEvent | null;
    try {
      event = await insertEvent(signal, candidate.key, candidate.row, ctx.now);
    } catch (err) {
      // Not a uniqueness race — a real write failure. Count it and carry on
      // with the remaining rows rather than abandoning the batch.
      insertFailures += 1;
      result.failed += 1;
      if (!firstFailure) firstFailure = errorMessage(err);
      continue;
    }
    // A concurrent replica already wrote this key. Not an error: the row is
    // handled, by them.
    if (!event) continue;

    created += 1;
    result.created += 1;

    const outcome = await runAction(signal, event, candidate.row, ctx);
    if (outcome.status === "failed") {
      actionFailures += 1;
      result.failed += 1;
      if (!firstFailure) firstFailure = outcome.detail;
    }
  }

  // Action failures live on their own events, but a Signal whose every event
  // fails would otherwise show a clean `lastError` on the config screen. Roll
  // them up so the list view tells the truth.
  const problems = actionFailures + insertFailures;
  const lastError =
    problems > 0 ? `${problems} of ${selection.fresh.length} events failed: ${firstFailure}` : "";

  await saveSignalQuietly(signal, {
    lastRunAt: ctx.now,
    lastEventCount: created,
    lastError,
  });
}

// ───────────────────────────── event insert ─────────────────────────────

/**
 * Write one event, or return null when somebody else already wrote it.
 *
 * Subject resolution happens here rather than in the action so that the
 * contact/customer ids are on the row even when the action later fails — the
 * whole point of keeping failed events is that a human can see who it was
 * about.
 */
async function insertEvent(
  signal: Signal,
  dedupeKey: string,
  row: Record<string, unknown>,
  now: Date,
): Promise<SignalEvent | null> {
  const subject = await resolveSubject(signal, row);
  const repo = AppDataSource.getRepository(SignalEvent);
  try {
    return await repo.save(
      repo.create({
        companyId: signal.companyId,
        signalId: signal.id,
        dedupeKey,
        payloadJson: truncatePayload(row),
        contactId: subject.contactId,
        customerId: subject.customerId,
        dealId: null,
        status: "new",
        detail: "",
        occurredAt: now,
      }),
    );
  } catch (err) {
    if (isUniqueViolation(err)) return null;
    throw err;
  }
}

/**
 * Does this error mean the unique `(signalId, dedupeKey)` index refused the row?
 *
 * String matching, because TypeORM does not normalize driver errors and the two
 * databases we ship on disagree about everything: better-sqlite3 raises
 * `SQLITE_CONSTRAINT_UNIQUE`, Postgres raises SQLSTATE `23505`. A false negative
 * here costs a logged failure that did not need logging; it can never produce a
 * duplicate event, because the database already refused the write either way.
 *
 * Exported so a test can feed it an error a real driver actually raised. A
 * predicate matched against hand-written fixtures drifts the moment a driver
 * rewords its message, and the failure mode — every concurrent tick reporting a
 * spurious failure — is invisible until somebody reads the logs.
 */
export function isUniqueViolation(err: unknown): boolean {
  const parts: string[] = [];
  const collect = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    const e = value as { code?: unknown; message?: unknown; driverError?: unknown };
    if (typeof e.code === "string") parts.push(e.code);
    if (typeof e.message === "string") parts.push(e.message);
    if (e.driverError && e.driverError !== value) collect(e.driverError);
  };
  collect(err);
  const haystack = parts.join(" ").toUpperCase();
  return (
    haystack.includes("23505") ||
    haystack.includes("SQLITE_CONSTRAINT") ||
    haystack.includes("UNIQUE CONSTRAINT") ||
    haystack.includes("DUPLICATE KEY")
  );
}

// ───────────────────────────── subject resolution ─────────────────────────────

type Subject = { contactId: string | null; customerId: string | null };

/**
 * Turn a result row into "who is this about".
 *
 * The customer is resolved first so a contact created by this very tick lands
 * on the right account immediately, rather than as an orphan somebody has to
 * re-link by hand later.
 *
 * Never throws. A row whose email column holds a phone number should produce an
 * event with no contact, not a dead tick.
 */
async function resolveSubject(
  signal: Signal,
  row: Record<string, unknown>,
): Promise<Subject> {
  try {
    const email = normalizeEmail(cellString(row, signal.emailColumn) ?? "");
    const domain = normalizeDomain(cellString(row, signal.domainColumn) ?? "");

    const customer = domain ? await findCustomerByDomain(signal.companyId, domain) : null;

    if (!email) return { contactId: null, customerId: customer?.id ?? null };

    const contact = await upsertContactByEmail(signal.companyId, {
      // Only used when the contact is new and nameless — `upsertContactByEmail`
      // never overwrites a name a human typed. The local part is a poor name
      // but a far better list row than a blank, and it is deterministic, which
      // a cleverer guess would not be.
      name: localPart(email),
      email,
      companyName: domain,
      customerId: customer?.id ?? null,
      source: `signal:${signal.slug}`,
    });

    return {
      contactId: contact?.id ?? null,
      customerId: customer?.id ?? contact?.customerId ?? null,
    };
  } catch (err) {
    logTickError(`resolving subject for signal ${signal.id}`, err);
    return { contactId: null, customerId: null };
  }
}

/**
 * Find the account for a domain.
 *
 * `Customer` has no `domain` column — adding one is a schema change and a
 * migration this slice does not own — so we match the billing address already
 * on the row. When several accounts share a domain we take the oldest, which is
 * at least deterministic: an event attached to the wrong-but-stable account can
 * be re-pointed by a human, whereas an account that changes between ticks
 * cannot be reasoned about at all.
 */
async function findCustomerByDomain(
  companyId: string,
  domain: string,
): Promise<Customer | null> {
  return AppDataSource.getRepository(Customer)
    .createQueryBuilder("c")
    .where("c.companyId = :companyId", { companyId })
    .andWhere("LOWER(c.email) LIKE :suffix", { suffix: `%@${domain}` })
    .orderBy("c.createdAt", "ASC")
    .addOrderBy("c.id", "ASC")
    .getOne();
}

/** The named column as a trimmed string, or null when it is unusable. */
function cellString(row: Record<string, unknown>, column: string): string | null {
  if (!column || typeof column !== "string") return null;
  const value = row?.[column];
  if (value === null || value === undefined) return null;
  if (typeof value === "object") return null;
  try {
    const text = String(value).trim();
    return text === "" ? null : text;
  } catch {
    return null;
  }
}

/**
 * Reduce whatever the customer stores to a bare hostname.
 *
 * Their "domain" column is, in practice, any of `acme.com`,
 * `https://www.acme.com/pricing`, `@acme.com`, or `ACME.com:443`. All four mean
 * the same account, so all four have to normalize to the same string or the
 * customer lookup silently misses.
 */
function normalizeDomain(raw: string): string {
  let value = raw.trim().toLowerCase();
  if (!value) return "";
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  value = value.replace(/^@+/, "");
  value = value.split("/")[0] ?? "";
  value = value.split("?")[0] ?? "";
  value = value.split(":")[0] ?? "";
  value = value.replace(/^www\./, "");
  value = value.replace(/\.+$/, "");
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(value) ? value : "";
}

function localPart(email: string): string {
  const at = email.indexOf("@");
  return at > 0 ? email.slice(0, at) : email;
}

// ───────────────────────────── actions ─────────────────────────────

/**
 * The three terminal statuses an action can leave on its event.
 *
 * `ignored` is the one worth defending. An enrolment refused because the person
 * unsubscribed is the system working exactly as designed, and filing it under
 * `failed` would both alarm the owner and inflate the tick's failure count until
 * the number stops meaning anything. `failed` is reserved for "somebody has to
 * fix something": a missing sequence, an exception, a Signal wired to an action
 * it has not been configured for.
 */
type ActionOutcome = { status: "actioned" | "ignored" | "failed"; detail: string };

/**
 * Run the Signal's action for one event and stamp the outcome onto it.
 *
 * Always resolves. The event's `status` is the record of what happened, so an
 * action that throws produces `failed` plus the message, and the caller counts
 * it — the exception never travels further than this function.
 */
async function runAction(
  signal: Signal,
  event: SignalEvent,
  row: Record<string, unknown>,
  ctx: TickContext,
): Promise<ActionOutcome> {
  let outcome: ActionOutcome;
  try {
    outcome = await dispatch(signal, event, row, ctx);
  } catch (err) {
    outcome = { status: "failed", detail: errorMessage(err) };
  }

  event.status = outcome.status;
  event.detail = outcome.detail.slice(0, 1000);
  try {
    await AppDataSource.getRepository(SignalEvent).save(event);
  } catch (err) {
    // The action already happened; failing to record that is worth a log but
    // must not re-run it.
    logTickError(`recording outcome for event ${event.id}`, err);
  }
  return outcome;
}

async function dispatch(
  signal: Signal,
  event: SignalEvent,
  row: Record<string, unknown>,
  ctx: TickContext,
): Promise<ActionOutcome> {
  const config = parseActionConfig(signal);

  switch (signal.actionKind) {
    case "activity":
      return actionActivity(signal, event, row, config);
    case "notify":
      return actionNotify(signal, event, ctx);
    case "create_deal":
      return actionCreateDeal(signal, event, row, config);
    case "enroll_sequence":
      return actionEnrollSequence(signal, event, config);
    case "hand_to_employee": {
      const handled = await signalHandler({
        signal,
        event,
        row,
        config,
        contactId: event.contactId,
        customerId: event.customerId,
      });
      return { status: handled.ok ? "actioned" : "failed", detail: handled.detail };
    }
    default:
      return {
        status: "failed",
        detail: `Unknown action kind "${String(signal.actionKind)}"`,
      };
  }
}

/**
 * Log it on the timeline. The safe default, and the one that runs when a
 * Signal is still being tuned — it is the only action with no external effect.
 */
async function actionActivity(
  signal: Signal,
  event: SignalEvent,
  row: Record<string, unknown>,
  config: Record<string, unknown>,
): Promise<ActionOutcome> {
  const subject = stringConfig(config, "subject") || signal.name;
  await recordActivity(signal.companyId, {
    kind: "signal",
    subject,
    bodyText: stringConfig(config, "body") || signal.description,
    occurredAt: event.occurredAt,
    contactId: event.contactId,
    customerId: event.customerId,
    // The whole row, so the timeline entry answers "why did this fire" without
    // a join back to the event. `recordActivity` swallows an unserializable
    // meta rather than losing the activity.
    meta: {
      signalId: signal.id,
      signalSlug: signal.slug,
      dedupeKey: event.dedupeKey,
      row,
    },
  });
  return {
    status: "actioned",
    detail: event.contactId
      ? "Recorded an activity on the contact timeline"
      : "Recorded an activity (no contact resolved)",
  };
}

/**
 * Bell + push to the humans who can act on it.
 *
 * Owners and admins, not every member: a Signal firing is an operational
 * event, and notifying the whole company is the fastest route to the bell being
 * ignored. `actionConfig.userIds` overrides the audience when somebody wants a
 * specific person.
 *
 * The notification `kind` reuses `finance_review_ready` deliberately. The bell
 * UI keys an exhaustive `Record<NotificationKind, …>` off that union, so adding
 * a `signal_fired` member is a client change this slice does not own; picking
 * the nearest existing kind keeps the row rendering correctly today and leaves
 * the taxonomy decision to whoever ships the Signals UI.
 */
async function actionNotify(
  signal: Signal,
  event: SignalEvent,
  ctx: TickContext,
): Promise<ActionOutcome> {
  const recipients = await notifyAudience(signal);
  if (recipients.length === 0) {
    return { status: "failed", detail: "No owner or admin to notify" };
  }

  const slug = await companySlug(signal.companyId, ctx);
  const link = slug ? `/c/${slug}/revenue/signals/${signal.slug}` : null;

  await createNotifications(
    recipients.map((userId) => ({
      companyId: signal.companyId,
      userId,
      kind: "finance_review_ready" as const,
      title: signal.name,
      body: signal.description || `Signal fired for ${event.dedupeKey}`,
      link,
      actorKind: "system" as const,
      actorId: null,
    })),
  );
  return { status: "actioned", detail: `Notified ${recipients.length} recipient(s)` };
}

async function notifyAudience(signal: Signal): Promise<string[]> {
  const config = parseActionConfig(signal);
  const explicit = Array.isArray(config.userIds)
    ? config.userIds.filter((v): v is string => typeof v === "string" && v.trim() !== "")
    : [];
  if (explicit.length > 0) return [...new Set(explicit)];

  const members = await AppDataSource.getRepository(Membership).find({
    where: { companyId: signal.companyId, role: In(["owner", "admin"]) },
  });
  return [...new Set(members.map((m) => m.userId))];
}

/**
 * Open a deal for the row.
 *
 * Lands in the board's default stage unless `actionConfig.stageId` names one,
 * matching what a human gets from the "New deal" button — a Signal-created deal
 * that appears in a different column than every other new deal is confusing for
 * no benefit.
 *
 * The amount is read straight from `amountColumn` **as minor units**. That is
 * the house rule for money everywhere in this codebase and it is not negotiable
 * here, but it is worth saying out loud because the customer's column is often
 * in dollars: pointing this at a `mrr` column that holds `49` opens a 49-cent
 * deal, not a $49 one. The docs and the field's help text say so.
 */
async function actionCreateDeal(
  signal: Signal,
  event: SignalEvent,
  row: Record<string, unknown>,
  config: Record<string, unknown>,
): Promise<ActionOutcome> {
  const explicitStage = stringConfig(config, "stageId");
  let stageId = explicitStage;
  if (!stageId) {
    const stage = await defaultStageFor(signal.companyId);
    if (!stage) return { status: "failed", detail: "The company has no deal stages" };
    stageId = stage.id;
  }

  const deal = await createDeal(signal.companyId, {
    title: dealTitle(signal, event, config),
    description: signal.description,
    primaryContactId: event.contactId,
    customerId: event.customerId,
    stageId,
    amountCents: signal.amountColumn ? toMinorUnits(row[signal.amountColumn]) : 0,
    source: `signal:${signal.slug}`,
  });

  event.dealId = deal.id;
  return { status: "actioned", detail: `Opened deal ${deal.id}` };
}

function dealTitle(
  signal: Signal,
  event: SignalEvent,
  config: Record<string, unknown>,
): string {
  const configured = stringConfig(config, "dealTitle");
  if (configured) return configured;
  return `${signal.name} — ${event.dedupeKey}`;
}

/**
 * Money from somebody else's database.
 *
 * Drivers return the same column as a number, a string, or a bigint depending
 * on the type and the driver, and Explore's normalizer already turns bigint
 * into a string. Anything unparseable becomes 0 rather than NaN: a deal worth
 * nothing is obviously wrong on the board, whereas a NaN amount propagates into
 * every pipeline total on the page.
 */
function toMinorUnits(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? Math.round(value) : 0;
  if (typeof value === "bigint") {
    return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(-Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : 0;
  }
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? Math.round(parsed) : 0;
  }
  return 0;
}

/**
 * Refusals from {@link enrollContact} that mean *somebody has to go and fix
 * something*, as opposed to the compliance refusals — unsubscribed, bounced,
 * do-not-contact, already enrolled — which mean the system worked.
 */
const ENROLL_SKIP_IS_BROKEN: Record<string, true> = {
  sequence_not_found: true,
  sequence_archived: true,
  contact_not_found: true,
};

/**
 * Add the resolved contact to an outbound sequence.
 *
 * Both preconditions fail loudly on the event rather than silently doing
 * nothing: a Signal configured to enrol people but with no email column is a
 * Signal whose owner believes emails are going out, and that belief needs
 * correcting on the first tick.
 */
async function actionEnrollSequence(
  signal: Signal,
  event: SignalEvent,
  config: Record<string, unknown>,
): Promise<ActionOutcome> {
  const sequenceId = stringConfig(config, "sequenceId");
  if (!sequenceId) {
    return { status: "failed", detail: "No sequenceId in the action config" };
  }
  if (!event.contactId) {
    return {
      status: "failed",
      detail: "No contact resolved — set the signal's email column to enrol people",
    };
  }

  const result = await enrollContact(signal.companyId, sequenceId, event.contactId, {
    dealId: event.dealId,
  });
  // enrollContact reports a refusal rather than throwing. A compliance refusal
  // — suppressed, unsubscribed, no address, already enrolled — is `ignored`,
  // not `failed`: nobody has anything to fix, and marking it failed would fill
  // the events table with red rows for the system working correctly. It is not
  // `actioned` either, because a signal that silently enrols nobody must not
  // read as if it did. A missing or archived sequence is a different animal:
  // the Signal points at something that no longer exists, and it will keep
  // enrolling nobody until a human is told.
  if (result.skipped || !result.enrollment) {
    const reason = result.skipped ?? "unknown reason";
    return {
      status: ENROLL_SKIP_IS_BROKEN[reason] ? "failed" : "ignored",
      detail: `Not enrolled in sequence ${sequenceId}: ${reason}`,
    };
  }
  return {
    status: "actioned",
    detail: `Enrolled in sequence ${sequenceId} (${result.enrollment.id})`,
  };
}

// ───────────────────────────── plumbing ─────────────────────────────

function stringConfig(config: Record<string, unknown>, key: string): string {
  const value = config[key];
  return typeof value === "string" ? value.trim() : "";
}

async function companySlug(companyId: string, ctx: TickContext): Promise<string | null> {
  const cached = ctx.companySlugs.get(companyId);
  if (cached !== undefined) return cached;
  let slug: string | null = null;
  try {
    const company = await AppDataSource.getRepository(Company).findOneBy({ id: companyId });
    slug = company?.slug ?? null;
  } catch (err) {
    logTickError(`resolving company slug for ${companyId}`, err);
  }
  ctx.companySlugs.set(companyId, slug);
  return slug;
}

/**
 * Persist the pass's bookkeeping. Swallows its own failure because it is the
 * *last* thing a Signal does — losing the `lastRunAt` write means the Signal
 * re-runs next heartbeat and the dedupe keys stop it from firing twice, which
 * is a far better failure than an exception escaping into the scheduler.
 */
async function saveSignalQuietly(signal: Signal, patch: Partial<Signal>): Promise<void> {
  Object.assign(signal, patch);
  try {
    await AppDataSource.getRepository(Signal).save(signal);
  } catch (err) {
    logTickError(`updating signal ${signal.id}`, err);
  }
}

function errorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.slice(0, 500);
}

function logTickError(what: string, err: unknown): void {
  // eslint-disable-next-line no-console
  console.error(`[signalTick] ${what} failed:`, err);
}
