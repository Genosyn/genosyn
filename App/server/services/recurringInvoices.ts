import parser from "cron-parser";
import { In, IsNull, LessThanOrEqual } from "typeorm";
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
import { TaxRate } from "../db/entities/TaxRate.js";
import { computeLineTotals } from "../lib/money.js";
import {
  issueInvoice,
  recomputeInvoiceTotals,
  sendInvoiceEmail,
} from "./finance.js";

/**
 * Recurring invoices — schedule-driven invoice templates.
 *
 * Each `RecurringInvoice` carries a cron expression and a set of template
 * line items. The heartbeat (see `bootRecurringInvoices()` below) looks
 * for rows whose `nextRunAt` has come due, materializes a fresh `Invoice`
 * from the template, and advances the schedule.
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
export function nextRunForRecurring(
  cronExpr: string,
  from: Date = new Date(),
): Date | null {
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
  const monthsPer =
    frequency === "yearly" ? 12 : frequency === "quarterly" ? 3 : 1;
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
      const monthsPer =
        frequency === "yearly" ? 12 : frequency === "quarterly" ? 3 : 1;
      const elapsedMonths =
        (from.getFullYear() - anchor.getFullYear()) * 12 +
        (from.getMonth() - anchor.getMonth());
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
export function computeNextRun(
  ri: SchedulableFields,
  from: Date = new Date(),
): Date | null {
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

export type HydratedRecurringInvoice = RecurringInvoice & {
  customer: RecurringInvoiceCustomerStub | null;
  lines: RecurringInvoiceLineItem[];
};

export async function hydrateRecurringInvoices(
  companyId: string,
  rows: RecurringInvoice[],
): Promise<HydratedRecurringInvoice[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const customerIds = [...new Set(rows.map((r) => r.customerId))];
  const [customers, lines] = await Promise.all([
    AppDataSource.getRepository(Customer).find({
      where: { id: In(customerIds), companyId },
      select: ["id", "name", "slug", "email"],
    }),
    AppDataSource.getRepository(RecurringInvoiceLineItem).find({
      where: { recurringInvoiceId: In(ids) },
      order: { sortOrder: "ASC" },
    }),
  ]);
  const customerById = new Map(customers.map((c) => [c.id, c]));
  const linesByRi = new Map<string, RecurringInvoiceLineItem[]>();
  for (const l of lines) {
    const arr = linesByRi.get(l.recurringInvoiceId) ?? [];
    arr.push(l);
    linesByRi.set(l.recurringInvoiceId, arr);
  }
  return rows.map((r) => ({
    ...r,
    customer: customerById.get(r.customerId) ?? null,
    lines: linesByRi.get(r.id) ?? [],
  }));
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
): Promise<RecurringInvoiceLineItem[]> {
  const repo = AppDataSource.getRepository(RecurringInvoiceLineItem);
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

// ──────────────────────────── Generation ───────────────────────────────

/**
 * Materialize a fresh `Invoice` from the template. Returns the (possibly
 * already-issued, possibly already-sent) invoice plus the email send
 * result when `autoSend` is true.
 *
 * The invoice is created as a draft first so `replaceInvoiceLines` /
 * `recomputeInvoiceTotals` can run against it. We then walk it through
 * the same `issueInvoice` + `sendInvoiceEmail` paths a human would,
 * so the ledger and email log capture it identically.
 */
export async function generateInvoiceFromRecurring(
  ri: RecurringInvoice,
  actorUserId: string | null,
): Promise<{
  invoice: Invoice;
  emailStatus: "sent" | "skipped" | "failed" | "not_attempted";
  emailError: string;
}> {
  const customer = await AppDataSource.getRepository(Customer).findOneBy({
    id: ri.customerId,
    companyId: ri.companyId,
  });
  if (!customer) {
    throw new Error("Customer for this recurring schedule no longer exists");
  }
  const templateLines = await AppDataSource.getRepository(
    RecurringInvoiceLineItem,
  ).find({
    where: { recurringInvoiceId: ri.id },
    order: { sortOrder: "ASC" },
  });
  if (templateLines.length === 0) {
    throw new Error("Recurring schedule has no line items to bill");
  }

  const invRepo = AppDataSource.getRepository(Invoice);
  const slug = await uniqueDraftInvoiceSlug(ri.companyId);
  const issueDate = new Date();
  const dueDate = new Date(
    issueDate.getTime() + ri.daysUntilDue * 24 * 60 * 60 * 1000,
  );
  let draft = invRepo.create({
    companyId: ri.companyId,
    customerId: ri.customerId,
    slug,
    numberSeq: 0,
    number: "",
    status: "draft",
    issueDate,
    dueDate,
    currency: ri.currency || customer.currency || "USD",
    notes: ri.notes,
    footer: ri.footer,
    createdById: actorUserId,
  });
  draft = await invRepo.save(draft);

  // Snapshot tax for each template line, then save into the invoice.
  // Mirrors `replaceInvoiceLines` in finance.ts but reads from the
  // template line set instead of fresh user input.
  const lineRepo = AppDataSource.getRepository(InvoiceLineItem);
  const taxRepo = AppDataSource.getRepository(TaxRate);
  const newLines: InvoiceLineItem[] = [];
  for (let i = 0; i < templateLines.length; i += 1) {
    const t = templateLines[i];
    let taxRateId: string | null = null;
    let taxName = "";
    let taxPercent = 0;
    let taxInclusive = false;
    if (t.taxRateId) {
      const rate = await taxRepo.findOneBy({
        id: t.taxRateId,
        companyId: ri.companyId,
      });
      if (rate) {
        taxRateId = rate.id;
        taxName = rate.name;
        taxPercent = rate.ratePercent;
        taxInclusive = rate.inclusive;
      }
    }
    const totals = computeLineTotals({
      quantity: t.quantity,
      unitPriceCents: t.unitPriceCents,
      taxPercent,
      taxInclusive,
    });
    newLines.push(
      lineRepo.create({
        invoiceId: draft.id,
        productId: t.productId,
        description: t.description,
        quantity: t.quantity,
        unitPriceCents: t.unitPriceCents,
        taxRateId,
        taxName,
        taxPercent,
        taxInclusive,
        ...totals,
        sortOrder: t.sortOrder ?? i,
      }),
    );
  }
  await lineRepo.save(newLines);
  let invoice = await recomputeInvoiceTotals(draft);

  // Walk through the same lifecycle the user would. `autoSend` implies
  // "issue and email"; otherwise the invoice stays as a fresh draft and
  // the user can review before sending.
  let emailStatus: "sent" | "skipped" | "failed" | "not_attempted" =
    "not_attempted";
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

// ──────────────────────────── Heartbeat ────────────────────────────────

/**
 * Fire one recurring schedule. Re-fetches the row so edits applied
 * between heartbeats take effect, generates the invoice, increments
 * `runsCreated`, and re-registers `nextRunAt` (or flips to `ended` if
 * the cap is now reached).
 *
 * Catches and logs errors so a single broken schedule doesn't block
 * the rest of the heartbeat.
 */
async function tickRecurringInvoice(id: string): Promise<void> {
  const repo = AppDataSource.getRepository(RecurringInvoice);
  const fresh = await repo.findOneBy({ id });
  if (!fresh || fresh.status !== "active") return;
  try {
    const { invoice } = await generateInvoiceFromRecurring(fresh, null);
    fresh.runsCreated += 1;
    fresh.lastRunAt = new Date();
    fresh.lastInvoiceSlug = invoice.slug;
    registerRecurringInvoice(fresh);
    await repo.save(fresh);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[recurring-invoices] tick ${id} failed:`, err);
  }
}

/**
 * One heartbeat pass. Finds active rows whose `nextRunAt` has come due,
 * advances them past now (fire-at-most-once — matches the routines
 * scheduler), saves, and fires each generation in the background.
 *
 * The `ticking` guard prevents overlapping passes if a heartbeat
 * interval fires while the previous pass is still writing rows.
 */
async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const repo = AppDataSource.getRepository(RecurringInvoice);
    const now = new Date();
    const due = await repo.find({
      where: { status: "active", nextRunAt: LessThanOrEqual(now) },
    });
    for (const r of due) {
      // Advance BEFORE firing so a slow generation doesn't re-trigger
      // on the next heartbeat. Compute from `now` (not r.nextRunAt) so
      // missed slots collapse into a single catch-up run.
      const next = computeNextRun(r, now);
      r.nextRunAt = next;
      await repo.save(r);
      tickRecurringInvoice(r.id).catch((err) => {
        // eslint-disable-next-line no-console
        console.error(`[recurring-invoices] ${r.id} failed:`, err);
      });
    }
  } finally {
    ticking = false;
  }
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

export async function bootRecurringInvoices(): Promise<void> {
  await initialSweep();
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = setInterval(() => {
    tick().catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[recurring-invoices] heartbeat failed:", err);
    });
  }, HEARTBEAT_INTERVAL_MS);
  // Kick an immediate pass so a just-rebooted server catches up without
  // waiting a full heartbeat interval first.
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
