import parser from "cron-parser";
import { In, IsNull, LessThanOrEqual, type EntityManager } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { Customer } from "../db/entities/Customer.js";
import { Invoice } from "../db/entities/Invoice.js";
import { InvoiceLineItem } from "../db/entities/InvoiceLineItem.js";
import {
  RecurringInvoice,
  RecurringInvoiceFrequency,
  RecurringInvoiceStatus,
} from "../db/entities/RecurringInvoice.js";
import { RecurringInvoiceLineItem } from "../db/entities/RecurringInvoiceLineItem.js";
import {
  RecurringInvoiceRun,
  RecurringInvoiceRunStatus,
} from "../db/entities/RecurringInvoiceRun.js";
import { TaxRate } from "../db/entities/TaxRate.js";
import { withSerializedTransaction } from "../db/transactions.js";
import { computeLineTotals } from "../lib/money.js";
import { issueInvoice, sendInvoiceEmail } from "./finance.js";
import { emitResourceChange } from "./resourceEvents.js";
import { resolveDocumentIssuer } from "./subsidiaries.js";
import { SchedulerLeaseLostError, withSchedulerLease } from "./schedulerLeases.js";

/**
 * Recurring invoices — schedule-driven invoice templates.
 *
 * Each `RecurringInvoice` carries a cron expression and a set of template
 * line items. The heartbeat (see `bootRecurringInvoices()` below) records
 * each due slot as a `RecurringInvoiceRun`, advances the schedule, and then
 * works the run until its invoice exists (issued and emailed, for auto-send
 * schedules). Runs resume after a crash or restart and retry failed steps
 * with a backoff, and a resumed run never bills the same slot twice.
 *
 * The generated invoice is a normal `Invoice` row — issuing, sending,
 * voiding, ledger posting, and reports all flow through the same code
 * paths that humans use. The only thing that differentiates a recurring-
 * sourced invoice from a hand-authored one is the `notes` line we stamp
 * onto it ("Auto-generated from recurring schedule …").
 */

// ─────────────────────────── Scheduling ────────────────────────────────

const HEARTBEAT_INTERVAL_MS = 30 * 1000;
let heartbeat: NodeJS.Timeout | null = null;
let ticking = false;

/**
 * Compute the next scheduled fire time for a cron expression, or null
 * if the expression is invalid.
 */
export function nextRunForRecurring(cronExpr: string, from: Date = new Date()): Date | null {
  try {
    const interval = parser.parseExpression(cronExpr, { currentDate: from });
    return interval.next().toDate();
  } catch {
    return null;
  }
}

// ─────────────────── Interval ("every N units") math ───────────────────
//
// Cron is a stateless matcher: it can say "the 1st of every month" but not
// "every other month" or "every 2 weeks" — those need an epoch to count
// from. So for schedules with `intervalCount >= 2` we step a calendar unit
// at a time from `anchorAt` (the first base cron occurrence) and skip to the
// Nth one. A count of 1 is left entirely to `cron-parser` above, preserving
// the exact behavior every existing schedule already has.

const INTERVAL_GUARD = 10_000;

/**
 * The j-th interval occurrence: `anchor` advanced by `j * intervalCount`
 * units of `frequency`, preserving the anchor's local clock time. Returns
 * null for month-family units when the anchor's day-of-month doesn't exist
 * in the target month (e.g. the 31st of February) — callers skip those,
 * matching cron's "only fire in months that have this day" semantics.
 */
function intervalOccurrence(
  anchor: Date,
  frequency: RecurringInvoiceFrequency,
  intervalCount: number,
  j: number,
): Date | null {
  const d = new Date(anchor);
  if (frequency === "daily") {
    d.setDate(d.getDate() + j * intervalCount);
    return d;
  }
  if (frequency === "weekly") {
    d.setDate(d.getDate() + j * intervalCount * 7);
    return d;
  }
  const monthsPer = frequency === "yearly" ? 12 : frequency === "quarterly" ? 3 : 1;
  const day = anchor.getDate();
  // Move to the 1st first so shifting the month never rolls into the next
  // one, then re-apply the day once we know the target month's length.
  d.setDate(1);
  d.setMonth(anchor.getMonth() + j * intervalCount * monthsPer);
  const daysInMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  if (day > daysInMonth) return null;
  d.setDate(day);
  return d;
}

/**
 * First interval occurrence strictly after `from`. Estimates a starting
 * index near `from` so we don't walk from the anchor across months/years of
 * history, then steps forward (skipping non-existent days) until past it.
 */
function nextIntervalRun(
  anchor: Date,
  frequency: RecurringInvoiceFrequency,
  intervalCount: number,
  from: Date,
): Date | null {
  const fromMs = from.getTime();
  let j = 0;
  if (fromMs > anchor.getTime()) {
    const elapsedMs = fromMs - anchor.getTime();
    if (frequency === "daily") {
      j = Math.floor(elapsedMs / (86_400_000 * intervalCount));
    } else if (frequency === "weekly") {
      j = Math.floor(elapsedMs / (86_400_000 * 7 * intervalCount));
    } else {
      const monthsPer = frequency === "yearly" ? 12 : frequency === "quarterly" ? 3 : 1;
      const elapsedMonths =
        (from.getFullYear() - anchor.getFullYear()) * 12 + (from.getMonth() - anchor.getMonth());
      j = Math.floor(elapsedMonths / (intervalCount * monthsPer));
    }
    j = Math.max(0, j - 2); // back off to absorb estimate error
  }
  for (let guard = 0; guard < INTERVAL_GUARD; guard += 1) {
    const occ = intervalOccurrence(anchor, frequency, intervalCount, j);
    if (occ && occ.getTime() > fromMs) return occ;
    j += 1;
  }
  return null;
}

/** The schedule fields the next-run computation reads. */
type SchedulableFields = Pick<
  RecurringInvoice,
  "cronExpr" | "frequency" | "intervalCount" | "anchorAt"
>;

/**
 * Next fire time for a schedule, honoring its "every N" count. Plain
 * (count ≤ 1) schedules defer entirely to `cron-parser`; interval schedules
 * step from `anchorAt`. Falls back to the cron path if the anchor is missing
 * so a half-populated row still schedules something sane.
 */
export function computeNextRun(ri: SchedulableFields, from: Date = new Date()): Date | null {
  const n = ri.intervalCount ?? 1;
  if (!Number.isFinite(n) || n <= 1 || !ri.anchorAt) {
    return nextRunForRecurring(ri.cronExpr, from);
  }
  return nextIntervalRun(ri.anchorAt, ri.frequency, n, from);
}

/**
 * Mutate `nextRunAt` based on the row's current cron / status / cap
 * fields. Callers save afterward. Centralizes the "should this fire
 * again?" decision so create/update/tick all use the same rules.
 */
export function registerRecurringInvoice(ri: RecurringInvoice): void {
  if (ri.status !== "active") {
    ri.nextRunAt = null;
    return;
  }
  if (ri.maxRuns != null && ri.runsCreated >= ri.maxRuns) {
    ri.status = "ended";
    ri.nextRunAt = null;
    return;
  }
  // Phase an "every N" schedule by anchoring it on the first base cron
  // occurrence (so it keeps cron's day-of-week / day-of-month / quarter
  // alignment), seeded once. The route clears `anchorAt` when the schedule
  // definition changes, prompting a re-seed; firing keeps it stable so the
  // cadence doesn't drift. Plain schedules carry no anchor.
  if ((ri.intervalCount ?? 1) >= 2) {
    if (!ri.anchorAt) ri.anchorAt = nextRunForRecurring(ri.cronExpr);
  } else {
    ri.anchorAt = null;
  }
  const next = computeNextRun(ri);
  if (next && ri.endsOn && next.getTime() > ri.endsOn.getTime()) {
    ri.status = "ended";
    ri.nextRunAt = null;
    return;
  }
  ri.nextRunAt = next;
}

// ──────────────────────────── Slug helper ─────────────────────────────

async function uniqueDraftInvoiceSlug(companyId: string): Promise<string> {
  const repo = AppDataSource.getRepository(Invoice);
  for (let i = 0; i < 16; i += 1) {
    const slug = `draft-${Math.random().toString(36).slice(2, 8)}`;
    if (!(await repo.findOneBy({ companyId, slug }))) return slug;
  }
  return `draft-${Date.now().toString(36)}`;
}

// ──────────────────────────── Lookups ─────────────────────────────────

export async function loadRecurringInvoiceBySlug(
  companyId: string,
  slug: string,
): Promise<RecurringInvoice | null> {
  return AppDataSource.getRepository(RecurringInvoice).findOneBy({
    companyId,
    slug,
  });
}

// ──────────────────────────── Hydration ────────────────────────────────

export type RecurringInvoiceCustomerStub = {
  id: string;
  name: string;
  slug: string;
  email: string;
};

/** The parts of a schedule's latest run that pages show. */
export type RecurringInvoiceRunSummary = Pick<
  RecurringInvoiceRun,
  "status" | "scheduledFor" | "attempts" | "retryAt" | "lastError" | "emailStatus" | "completedAt"
> & { invoiceSlug: string | null };

export type HydratedRecurringInvoice = RecurringInvoice & {
  customer: RecurringInvoiceCustomerStub | null;
  lines: RecurringInvoiceLineItem[];
  /** What one run bills, tax included: the generated invoice's total. */
  totalCents: number;
  /** The most recent scheduled run, so a retrying or failed one is visible. */
  latestRun: RecurringInvoiceRunSummary | null;
};

/** Each schedule's run with the latest `scheduledFor`. */
async function loadLatestRuns(ids: string[]): Promise<RecurringInvoiceRun[]> {
  return AppDataSource.getRepository(RecurringInvoiceRun)
    .createQueryBuilder("run")
    .where("run.recurringInvoiceId IN (:...ids)", { ids })
    .andWhere((qb) => {
      const latest = qb
        .subQuery()
        .select("MAX(other.scheduledFor)")
        .from(RecurringInvoiceRun, "other")
        .where("other.recurringInvoiceId = run.recurringInvoiceId")
        .getQuery();
      return `run.scheduledFor = ${latest}`;
    })
    .getMany();
}

export async function hydrateRecurringInvoices(
  companyId: string,
  rows: RecurringInvoice[],
): Promise<HydratedRecurringInvoice[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const customerIds = [...new Set(rows.map((r) => r.customerId))];
  const [customers, lines, runs] = await Promise.all([
    AppDataSource.getRepository(Customer).find({
      where: { id: In(customerIds), companyId },
      select: ["id", "name", "slug", "email"],
    }),
    AppDataSource.getRepository(RecurringInvoiceLineItem).find({
      where: { recurringInvoiceId: In(ids) },
      order: { sortOrder: "ASC" },
    }),
    loadLatestRuns(ids),
  ]);
  const invoiceIds = runs.flatMap((run) => (run.invoiceId ? [run.invoiceId] : []));
  const [rates, invoices] = await Promise.all([
    loadTaxRates(companyId, lines),
    invoiceIds.length > 0
      ? AppDataSource.getRepository(Invoice).find({
          where: { id: In(invoiceIds), companyId },
          select: ["id", "slug"],
        })
      : Promise.resolve([] as Invoice[]),
  ]);
  const customerById = new Map(customers.map((c) => [c.id, c]));
  const slugByInvoiceId = new Map(invoices.map((inv) => [inv.id, inv.slug]));
  const runByRi = new Map(runs.map((run) => [run.recurringInvoiceId, run]));
  const linesByRi = new Map<string, RecurringInvoiceLineItem[]>();
  for (const l of lines) {
    const arr = linesByRi.get(l.recurringInvoiceId) ?? [];
    arr.push(l);
    linesByRi.set(l.recurringInvoiceId, arr);
  }
  return rows.map((r) => {
    const riLines = linesByRi.get(r.id) ?? [];
    const run = runByRi.get(r.id);
    return {
      ...r,
      customer: customerById.get(r.customerId) ?? null,
      lines: riLines,
      totalCents: riLines.reduce(
        (sum, line) => sum + priceTemplateLine(line, rates).lineTotalCents,
        0,
      ),
      latestRun: run
        ? {
            status: run.status,
            scheduledFor: run.scheduledFor,
            attempts: run.attempts,
            retryAt: run.retryAt,
            lastError: run.lastError,
            emailStatus: run.emailStatus,
            completedAt: run.completedAt,
            invoiceSlug: run.invoiceId ? (slugByInvoiceId.get(run.invoiceId) ?? null) : null,
          }
        : null,
    };
  });
}

// ──────────────────────── Line replacement ─────────────────────────────

export type RecurringLineDraft = {
  productId?: string | null;
  description: string;
  quantity: number;
  unitPriceCents: number;
  taxRateId?: string | null;
  sortOrder?: number;
};

export async function replaceRecurringInvoiceLines(
  ri: RecurringInvoice,
  drafts: RecurringLineDraft[],
  manager: EntityManager = AppDataSource.manager,
): Promise<RecurringInvoiceLineItem[]> {
  const repo = manager.getRepository(RecurringInvoiceLineItem);
  await repo.delete({ recurringInvoiceId: ri.id });
  if (drafts.length === 0) return [];
  const built: RecurringInvoiceLineItem[] = [];
  for (let i = 0; i < drafts.length; i += 1) {
    const d = drafts[i];
    built.push(
      repo.create({
        recurringInvoiceId: ri.id,
        productId: d.productId ?? null,
        description: d.description,
        quantity: d.quantity,
        unitPriceCents: d.unitPriceCents,
        taxRateId: d.taxRateId ?? null,
        sortOrder: d.sortOrder ?? i,
      }),
    );
  }
  return repo.save(built);
}

// ──────────────────────────── Duplication ──────────────────────────────

export async function uniqueRecurringInvoiceSlug(
  companyId: string,
  manager: EntityManager = AppDataSource.manager,
): Promise<string> {
  const repo = manager.getRepository(RecurringInvoice);
  for (let i = 0; i < 16; i += 1) {
    const slug = `ri-${Math.random().toString(36).slice(2, 8)}`;
    if (!(await repo.findOneBy({ companyId, slug }))) return slug;
  }
  return `ri-${Date.now().toString(36)}`;
}

/**
 * Clone a schedule into a fresh, **paused** copy. Starting paused is
 * deliberate: an exact duplicate of an active schedule must not begin
 * billing the customer the moment it is created — the operator reviews it
 * and resumes when ready (mirrors "duplicate invoice as draft"). Run
 * history (runsCreated / lastRunAt / lastInvoiceSlug) resets and the
 * interval anchor is dropped so re-registration re-phases from now; the
 * template line items are copied verbatim.
 */
export async function duplicateRecurringInvoice(
  source: RecurringInvoice,
  actorUserId: string | null,
): Promise<RecurringInvoice> {
  const repo = AppDataSource.getRepository(RecurringInvoice);
  const slug = await uniqueRecurringInvoiceSlug(source.companyId);
  const copy = repo.create({
    companyId: source.companyId,
    customerId: source.customerId,
    subsidiaryId: source.subsidiaryId,
    slug,
    name: `${source.name} (copy)`,
    cronExpr: source.cronExpr,
    frequency: source.frequency,
    intervalCount: source.intervalCount,
    anchorAt: null,
    status: "paused",
    daysUntilDue: source.daysUntilDue,
    autoSend: source.autoSend,
    currency: source.currency,
    notes: source.notes,
    footer: source.footer,
    nextRunAt: null,
    lastRunAt: null,
    lastInvoiceSlug: "",
    runsCreated: 0,
    maxRuns: source.maxRuns,
    endsOn: source.endsOn,
    createdById: actorUserId,
  });
  registerRecurringInvoice(copy); // paused → nextRunAt stays null
  await repo.save(copy);

  const sourceLines = await AppDataSource.getRepository(RecurringInvoiceLineItem).find({
    where: { recurringInvoiceId: source.id },
    order: { sortOrder: "ASC" },
  });
  if (sourceLines.length > 0) {
    const lineRepo = AppDataSource.getRepository(RecurringInvoiceLineItem);
    await lineRepo.save(
      sourceLines.map((l) =>
        lineRepo.create({
          recurringInvoiceId: copy.id,
          productId: l.productId,
          description: l.description,
          quantity: l.quantity,
          unitPriceCents: l.unitPriceCents,
          taxRateId: l.taxRateId,
          sortOrder: l.sortOrder,
        }),
      ),
    );
  }
  return copy;
}

// ──────────────────────────── Generation ───────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

async function loadTaxRates(
  companyId: string,
  lines: Pick<RecurringInvoiceLineItem, "taxRateId">[],
): Promise<Map<string, TaxRate>> {
  const ids = [...new Set(lines.flatMap((l) => (l.taxRateId ? [l.taxRateId] : [])))];
  if (ids.length === 0) return new Map();
  const rates = await AppDataSource.getRepository(TaxRate).find({
    where: { id: In(ids), companyId },
  });
  return new Map(rates.map((rate) => [rate.id, rate]));
}

/**
 * Price a template line exactly as the generated invoice will: snapshot its
 * tax rate (a rate deleted since bills untaxed) and compute the line totals.
 */
function priceTemplateLine(line: RecurringInvoiceLineItem, rates: Map<string, TaxRate>) {
  const rate = line.taxRateId ? rates.get(line.taxRateId) : undefined;
  const tax = {
    taxRateId: rate?.id ?? null,
    taxName: rate?.name ?? "",
    taxPercent: rate?.ratePercent ?? 0,
    taxInclusive: rate?.inclusive ?? false,
  };
  return {
    ...tax,
    ...computeLineTotals({
      quantity: line.quantity,
      unitPriceCents: line.unitPriceCents,
      taxPercent: tax.taxPercent,
      taxInclusive: tax.taxInclusive,
    }),
  };
}

/**
 * Write a draft invoice and its lines from the template in one transaction,
 * so no crash can leave an invoice without its lines. `link` runs inside
 * that transaction: a scheduled run uses it to attach the invoice to itself,
 * and returning false rolls the invoice back.
 */
async function createInvoiceFromTemplate(
  ri: RecurringInvoice,
  actorUserId: string | null,
  link?: (manager: EntityManager, invoice: Invoice) => Promise<boolean>,
): Promise<Invoice> {
  const customer = await AppDataSource.getRepository(Customer).findOneBy({
    id: ri.customerId,
    companyId: ri.companyId,
  });
  if (!customer) {
    throw new Error("Customer for this recurring schedule no longer exists");
  }
  const templateLines = await AppDataSource.getRepository(RecurringInvoiceLineItem).find({
    where: { recurringInvoiceId: ri.id },
    order: { sortOrder: "ASC" },
  });
  if (templateLines.length === 0) {
    throw new Error("Recurring schedule has no line items to bill");
  }
  const issuer = await resolveDocumentIssuer(ri.companyId, ri.subsidiaryId);
  const rates = await loadTaxRates(ri.companyId, templateLines);
  const priced = templateLines.map((line) => ({ line, ...priceTemplateLine(line, rates) }));
  const slug = await uniqueDraftInvoiceSlug(ri.companyId);
  const issueDate = new Date();
  const totalCents = priced.reduce((sum, p) => sum + p.lineTotalCents, 0);

  return withSerializedTransaction(async (manager) => {
    const invoiceRepo = manager.getRepository(Invoice);
    const invoice = await invoiceRepo.save(
      invoiceRepo.create({
        companyId: ri.companyId,
        customerId: ri.customerId,
        ...issuer,
        slug,
        numberSeq: 0,
        number: "",
        status: "draft",
        issueDate,
        dueDate: new Date(issueDate.getTime() + ri.daysUntilDue * DAY_MS),
        currency: ri.currency || customer.currency || "USD",
        notes: ri.notes,
        footer: ri.footer,
        // A fresh draft carries no payments or credits, so these are exactly
        // what `recomputeInvoiceTotals` would store.
        subtotalCents: priced.reduce((sum, p) => sum + p.lineSubtotalCents, 0),
        taxCents: priced.reduce((sum, p) => sum + p.lineTaxCents, 0),
        totalCents,
        balanceCents: totalCents,
        createdById: actorUserId,
      }),
    );
    const lineRepo = manager.getRepository(InvoiceLineItem);
    await lineRepo.save(
      priced.map(({ line, ...totals }, i) =>
        lineRepo.create({
          invoiceId: invoice.id,
          productId: line.productId,
          description: line.description,
          quantity: line.quantity,
          unitPriceCents: line.unitPriceCents,
          ...totals,
          sortOrder: line.sortOrder ?? i,
        }),
      ),
    );
    if (link && !(await link(manager, invoice))) {
      throw new Error("This run was taken over by another worker before its invoice was saved");
    }
    return invoice;
  });
}

/**
 * Generate one invoice from the template right now (the "Run now" path).
 * Returns the (possibly already-issued, possibly already-sent) invoice plus
 * the email send result when `autoSend` is true.
 *
 * The invoice is created as a draft first, then walked through the same
 * `issueInvoice` + `sendInvoiceEmail` paths a human would, so the ledger
 * and email log capture it identically.
 */
export async function generateInvoiceFromRecurring(
  ri: RecurringInvoice,
  actorUserId: string | null,
): Promise<{
  invoice: Invoice;
  emailStatus: "sent" | "skipped" | "failed" | "not_attempted";
  emailError: string;
}> {
  let invoice = await createInvoiceFromTemplate(ri, actorUserId);

  // `autoSend` implies "issue and email"; otherwise the invoice stays as a
  // fresh draft and the user can review before sending.
  let emailStatus: "sent" | "skipped" | "failed" | "not_attempted" = "not_attempted";
  let emailError = "";
  if (ri.autoSend) {
    invoice = await issueInvoice(invoice, actorUserId);
    try {
      const result = await sendInvoiceEmail(ri.companyId, invoice, actorUserId);
      emailStatus = result.status;
      emailError = result.errorMessage;
    } catch (err) {
      emailStatus = "failed";
      emailError = (err as Error).message;
    }
  }
  return { invoice, emailStatus, emailError };
}

// ─────────────────────────── Scheduled runs ────────────────────────────
//
// Each due slot becomes a `RecurringInvoiceRun` row *before* any work
// starts, and that row tracks the slot until it is billed. So a run survives
// a crash, a restart, or a failed step, and resuming it continues the
// invoice it already created instead of billing the customer again.

/** How long one attempt holds a run. If the worker dies mid-attempt the hold
 *  lapses and the next pass resumes the run. */
const RUN_LOCK_MS = 5 * 60 * 1000;

/** Wait after the 1st, 2nd, … failed attempt. Generation keeps retrying at
 *  the last step for as long as the schedule stays active; email gives up
 *  once the ladder runs out and leaves the issued invoice for a Member. */
const RETRY_DELAYS_MS = [1, 5, 15, 60, 180, 360].map((minutes) => minutes * 60 * 1000);
const MAX_EMAIL_ATTEMPTS = RETRY_DELAYS_MS.length;

function retryDelayMs(failures: number): number {
  const step = Math.min(Math.max(failures, 1), RETRY_DELAYS_MS.length);
  return RETRY_DELAYS_MS[step - 1];
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Run writes go through query builders, which hand the change subscriber
 *  no companyId, so open pages are told directly. */
function notifyRunChange(companyId: string): void {
  emitResourceChange(companyId, "recurringinvoice", undefined, { trigger: false });
}

export type RecurringInvoiceRunResult = {
  run: RecurringInvoiceRun;
  invoice: Invoice | null;
};

/** The run a schedule is still working on, if any. */
export async function findPendingRecurringInvoiceRun(
  recurringInvoiceId: string,
): Promise<RecurringInvoiceRun | null> {
  return AppDataSource.getRepository(RecurringInvoiceRun).findOne({
    where: { recurringInvoiceId, status: "pending" },
    order: { scheduledFor: "ASC" },
  });
}

/**
 * Record a due slot as a run, then move the schedule past it. In that order
 * a crash between the two writes is harmless: the schedule is still due on
 * the next pass and the duplicate insert is ignored.
 *
 * A schedule has at most one run in flight. A run that is still retrying
 * holds the next slot back, and missed slots collapse into one run, just as
 * they do after downtime.
 */
async function claimDueRun(ri: RecurringInvoice, now: Date): Promise<void> {
  const scheduledFor = ri.nextRunAt;
  if (!scheduledFor) return;
  const runs = AppDataSource.getRepository(RecurringInvoiceRun);
  if ((await runs.count({ where: { recurringInvoiceId: ri.id, status: "pending" } })) > 0) {
    return;
  }
  await runs
    .createQueryBuilder()
    .insert()
    .values({ companyId: ri.companyId, recurringInvoiceId: ri.id, scheduledFor, status: "pending" })
    .orIgnore()
    .execute();
  await AppDataSource.getRepository(RecurringInvoice).update(
    { id: ri.id, nextRunAt: scheduledFor },
    { nextRunAt: computeNextRun(ri, now) },
  );
  notifyRunChange(ri.companyId);
}

/**
 * Hold a pending run for one attempt. Returns the hold's expiry, which every
 * later write for this attempt must match, or null when the run is finished,
 * held by another attempt, or (unless `ignoreBackoff`) waiting out a backoff.
 */
async function takeRun(runId: string, now: Date, ignoreBackoff: boolean): Promise<Date | null> {
  const lockedUntil = new Date(now.getTime() + RUN_LOCK_MS);
  const query = AppDataSource.getRepository(RecurringInvoiceRun)
    .createQueryBuilder()
    .update()
    .set({ lockedUntil, attempts: () => "attempts + 1" })
    .where("id = :id AND status = :pending", { id: runId, pending: "pending" })
    .andWhere("(lockedUntil IS NULL OR lockedUntil <= :now)", { now });
  if (!ignoreBackoff) query.andWhere("(retryAt IS NULL OR retryAt <= :now)", { now });
  const result = await query.execute();
  return result.affected === 1 ? lockedUntil : null;
}

/** Write to a run only while this attempt still holds it, so an attempt that
 *  outlived its hold can never overwrite the attempt that took over. */
async function updateHeldRun(
  run: RecurringInvoiceRun,
  lockedUntil: Date,
  values: Partial<RecurringInvoiceRun>,
  manager: EntityManager = AppDataSource.manager,
): Promise<boolean> {
  const result = await manager
    .getRepository(RecurringInvoiceRun)
    .createQueryBuilder()
    .update()
    .set(values)
    .where("id = :id AND lockedUntil = :lockedUntil", { id: run.id, lockedUntil })
    .execute();
  return result.affected === 1;
}

async function retryRun(
  run: RecurringInvoiceRun,
  lockedUntil: Date,
  delayMs: number,
  values: Partial<RecurringInvoiceRun> & { lastError: string },
  invoice: Invoice | null,
): Promise<RecurringInvoiceRunResult> {
  const update = { ...values, lockedUntil: null, retryAt: new Date(Date.now() + delayMs) };
  await updateHeldRun(run, lockedUntil, update);
  // eslint-disable-next-line no-console
  console.error(
    `[recurring-invoices] run ${run.id} attempt ${run.attempts} failed: ${values.lastError}`,
  );
  return { run: Object.assign(run, update), invoice };
}

/**
 * Close a run and, when it produced an invoice, record that on the schedule
 * in the same transaction: run count, latest invoice, and the cap / end-date
 * checks that may end the schedule.
 */
async function finishRun(
  run: RecurringInvoiceRun,
  lockedUntil: Date,
  status: Exclude<RecurringInvoiceRunStatus, "pending">,
  values: Partial<RecurringInvoiceRun>,
  invoice: Invoice | null,
): Promise<RecurringInvoiceRunResult> {
  const update = { ...values, status, lockedUntil: null, retryAt: null, completedAt: new Date() };
  await withSerializedTransaction(async (manager) => {
    if (!(await updateHeldRun(run, lockedUntil, update, manager))) return;
    if (!invoice) return;
    const repo = manager.getRepository(RecurringInvoice);
    const schedule = await repo.findOneBy({ id: run.recurringInvoiceId });
    if (!schedule) return;
    schedule.runsCreated += 1;
    schedule.lastRunAt = new Date();
    schedule.lastInvoiceSlug = invoice.slug;
    registerRecurringInvoice(schedule);
    await repo.save(schedule);
  });
  return { run: Object.assign(run, update), invoice };
}

/**
 * Take one pending run and carry it as far as it will go: create its
 * invoice (once), issue and email it when the schedule auto-sends, then
 * record it on the schedule. A failed step leaves the run pending with a
 * backoff, and the next attempt resumes at that step.
 *
 * Returns null when the run is not available: finished, held by another
 * attempt, or (unless `ignoreBackoff`) still waiting out a backoff.
 */
export async function processRecurringInvoiceRun(
  runId: string,
  options: {
    ignoreBackoff?: boolean;
    actorUserId?: string | null;
    assertLeaseHeld?: () => void;
  } = {},
): Promise<RecurringInvoiceRunResult | null> {
  const lockedUntil = await takeRun(runId, new Date(), options.ignoreBackoff ?? false);
  if (!lockedUntil) return null;
  const run = await AppDataSource.getRepository(RecurringInvoiceRun).findOneByOrFail({
    id: runId,
  });
  try {
    return await advanceRun(
      run,
      lockedUntil,
      options.actorUserId ?? null,
      options.assertLeaseHeld ?? (() => undefined),
    );
  } catch (err) {
    // `advanceRun` records its own failures, so only a lost scheduler lease
    // or a failing database gets here. Hand the run back so the next attempt
    // resumes it at once instead of after the hold lapses.
    await updateHeldRun(run, lockedUntil, { lockedUntil: null }).catch(() => undefined);
    throw err;
  } finally {
    notifyRunChange(run.companyId);
  }
}

async function advanceRun(
  run: RecurringInvoiceRun,
  lockedUntil: Date,
  actorUserId: string | null,
  assertLeaseHeld: () => void,
): Promise<RecurringInvoiceRunResult> {
  const schedule = await AppDataSource.getRepository(RecurringInvoice).findOneBy({
    id: run.recurringInvoiceId,
  });
  let invoice = run.invoiceId
    ? await AppDataSource.getRepository(Invoice).findOneBy({ id: run.invoiceId })
    : null;
  if (!schedule || schedule.status !== "active") {
    const lastError = schedule
      ? `Stopped because the schedule was ${schedule.status} before this run finished.`
      : "Stopped because the schedule was deleted before this run finished.";
    return finishRun(run, lockedUntil, "cancelled", { lastError }, invoice);
  }
  if (run.invoiceId && !invoice) {
    return finishRun(
      run,
      lockedUntil,
      "cancelled",
      { lastError: "Stopped because the invoice this run created was deleted." },
      null,
    );
  }

  try {
    if (!invoice) {
      assertLeaseHeld();
      invoice = await createInvoiceFromTemplate(schedule, actorUserId, (manager, created) =>
        updateHeldRun(run, lockedUntil, { invoiceId: created.id }, manager),
      );
      run.invoiceId = invoice.id;
    }
    if (schedule.autoSend && invoice.status === "draft") {
      assertLeaseHeld();
      invoice = await issueInvoice(invoice, actorUserId);
    }
  } catch (err) {
    if (err instanceof SchedulerLeaseLostError) throw err;
    return retryRun(
      run,
      lockedUntil,
      retryDelayMs(run.attempts),
      { lastError: messageOf(err) },
      invoice,
    );
  }

  const needsEmail =
    schedule.autoSend &&
    invoice.status !== "draft" &&
    invoice.status !== "void" &&
    run.emailStatus !== "sent";
  if (needsEmail) {
    let status: "sent" | "skipped" | "failed";
    let reason: string;
    try {
      assertLeaseHeld();
      const result = await sendInvoiceEmail(schedule.companyId, invoice, actorUserId);
      status = result.status;
      reason = result.errorMessage;
    } catch (err) {
      if (err instanceof SchedulerLeaseLostError) throw err;
      status = "failed";
      reason = messageOf(err);
    }
    if (status === "skipped") {
      // No email transport is configured; retrying cannot change that.
      return finishRun(
        run,
        lockedUntil,
        "failed",
        {
          emailStatus: status,
          lastError: `Invoice ${invoice.number} was issued, but no email transport is configured, so it was not emailed. Send it from the invoice page once email is set up.`,
        },
        invoice,
      );
    }
    if (status === "failed") {
      const emailAttempts = run.emailAttempts + 1;
      const why = reason || "the email provider did not accept it";
      if (emailAttempts >= MAX_EMAIL_ATTEMPTS) {
        return finishRun(
          run,
          lockedUntil,
          "failed",
          {
            emailAttempts,
            emailStatus: status,
            lastError: `Invoice ${invoice.number} was issued, but emailing it failed ${emailAttempts} times (${why}). Send it from the invoice page.`,
          },
          invoice,
        );
      }
      return retryRun(
        run,
        lockedUntil,
        retryDelayMs(emailAttempts),
        {
          emailAttempts,
          emailStatus: status,
          lastError: `Invoice ${invoice.number} was issued; emailing it failed (${why}) and will be retried.`,
        },
        invoice,
      );
    }
  }
  return finishRun(
    run,
    lockedUntil,
    "succeeded",
    { emailStatus: needsEmail ? "sent" : run.emailStatus, lastError: "" },
    invoice,
  );
}

// ──────────────────────────── Heartbeat ────────────────────────────────

/**
 * One heartbeat pass: claim every schedule whose `nextRunAt` has come due,
 * then work every pending run whose backoff has passed, including runs a
 * crashed or restarted server left unfinished.
 *
 * The `ticking` guard prevents overlapping passes if a heartbeat interval
 * fires while the previous pass is still working.
 */
async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    await withSchedulerLease("recurring-invoices", HEARTBEAT_INTERVAL_MS * 3, async (lease) => {
      const now = new Date();
      const due = await AppDataSource.getRepository(RecurringInvoice).find({
        where: { status: "active", nextRunAt: LessThanOrEqual(now) },
      });
      for (const schedule of due) {
        lease.assertHeld();
        try {
          await claimDueRun(schedule, now);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error(`[recurring-invoices] could not claim ${schedule.id}:`, err);
        }
      }
      const pending = await AppDataSource.getRepository(RecurringInvoiceRun).find({
        where: { status: "pending" },
        order: { scheduledFor: "ASC" },
      });
      for (const run of pending) {
        if ((run.retryAt && run.retryAt > now) || (run.lockedUntil && run.lockedUntil > now)) {
          continue;
        }
        lease.assertHeld();
        try {
          await processRecurringInvoiceRun(run.id, { assertLeaseHeld: lease.assertHeld });
        } catch (err) {
          if (err instanceof SchedulerLeaseLostError) throw err;
          // eslint-disable-next-line no-console
          console.error(`[recurring-invoices] run ${run.id} could not be processed:`, err);
        }
      }
    });
  } finally {
    ticking = false;
  }
}

/** One heartbeat pass, run on demand (tests drive the scheduler with it). */
export function runRecurringInvoiceTick(): Promise<void> {
  return tick();
}

/**
 * Fill in `nextRunAt` for any active row that doesn't have one. Runs
 * on boot to handle rows created before this column existed, or rows
 * where a prior boot failed to compute a schedule. Computes from *now*
 * so we don't fabricate a missed history.
 */
async function initialSweep(): Promise<void> {
  const repo = AppDataSource.getRepository(RecurringInvoice);
  const orphans = await repo.find({
    where: { status: "active", nextRunAt: IsNull() },
  });
  if (orphans.length === 0) return;
  for (const r of orphans) {
    registerRecurringInvoice(r);
    await repo.save(r);
  }
}

/**
 * A SQLite install runs one process, so a run still held at boot belongs to
 * the process that just stopped. Release it so the catch-up pass resumes it
 * now rather than when the hold lapses. (On Postgres another replica may
 * really hold it; there the hold simply lapses.)
 */
async function releaseOrphanedRuns(): Promise<void> {
  if (AppDataSource.options.type === "postgres") return;
  await AppDataSource.getRepository(RecurringInvoiceRun)
    .createQueryBuilder()
    .update()
    .set({ lockedUntil: null })
    .where("status = :pending AND lockedUntil IS NOT NULL", { pending: "pending" })
    .execute();
}

export async function bootRecurringInvoices(): Promise<void> {
  await initialSweep();
  await releaseOrphanedRuns();
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = setInterval(() => {
    tick().catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[recurring-invoices] heartbeat failed:", err);
    });
  }, HEARTBEAT_INTERVAL_MS);
  // Kick an immediate pass so a just-rebooted server bills what came due
  // while it was down, and finishes what it was doing when it stopped,
  // without waiting a full heartbeat interval first.
  tick().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[recurring-invoices] initial tick failed:", err);
  });
}

// ──────────────────────────── Status helpers ───────────────────────────

/**
 * Apply a user-driven status change. Centralized so the route handler
 * doesn't have to know about side effects (clearing nextRunAt, capping
 * runs, etc.).
 */
export function applyRecurringInvoiceStatus(
  ri: RecurringInvoice,
  next: RecurringInvoiceStatus,
): void {
  ri.status = next;
  if (next === "active") {
    registerRecurringInvoice(ri);
  } else {
    ri.nextRunAt = null;
  }
}

// Re-export for the route layer.
export type { RecurringInvoiceStatus };
