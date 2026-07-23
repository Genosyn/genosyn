import { Brackets, In, IsNull, type ObjectLiteral, type SelectQueryBuilder } from "typeorm";

import { AppDataSource } from "../../db/datasource.js";
import { AdSpendEvent } from "../../db/entities/AdSpendEvent.js";
import { CompanyFinanceSettings } from "../../db/entities/CompanyFinanceSettings.js";
import { Customer } from "../../db/entities/Customer.js";
import { Deal } from "../../db/entities/Deal.js";
import { DealStage } from "../../db/entities/DealStage.js";
import { Invoice } from "../../db/entities/Invoice.js";
import { InvoicePayment } from "../../db/entities/InvoicePayment.js";
import {
  RecurringInvoice,
  type RecurringInvoiceFrequency,
} from "../../db/entities/RecurringInvoice.js";
import { RecurringInvoiceLineItem } from "../../db/entities/RecurringInvoiceLineItem.js";
import { DEFAULT_CURRENCY, roundHalfAway } from "../../lib/money.js";
import type { FunnelDeal, StageLike } from "./funnel.js";
import { monthRange, normalizeToMonthlyCents, type BillingInterval } from "./mrr.js";

/**
 * The database half of the revenue metrics.
 *
 * `mrr.ts`, `funnel.ts` and `cac.ts` are pure and exhaustively tested without a
 * database; this file is the only place allowed to turn rows into their inputs.
 * It therefore contains **no arithmetic those modules own** — no `* 12`, no
 * probability weighting, no CAC division. What it does contain is every
 * judgement call about *which rows count*, which is the part people argue
 * about, so each one is written down rather than left in the shape of a WHERE
 * clause.
 *
 * Four conventions, stated once so they are not re-litigated per function:
 *
 * - **Money is integer minor units**, as everywhere else in Genosyn (M19), and
 *   division rounds half away from zero via {@link roundHalfAway} — the same
 *   helper invoice lines use, so a monthly-normalized annual plan and the
 *   invoice for that plan round the same direction.
 * - **Periods are half-open `[from, to)`**, matching `funnel.ts`. Consecutive
 *   periods must tile without double-counting a row that landed exactly on
 *   midnight, and that only works if one side is exclusive.
 * - **Bad data is dropped, never fatal.** An unparseable date, a non-finite
 *   amount, a schedule pointing at a deleted customer: all skipped. A revenue
 *   report that throws because one imported row is malformed is a report nobody
 *   can open, and these rows come from CSV imports and ad-platform webhooks.
 * - **Reads only.** Nothing here writes, not even the convenient lazy seeds the
 *   rest of the codebase does (`listDealStages` seeds a default ladder,
 *   `getFinanceSettings` creates a settings row). Opening a report must not
 *   mutate the company — see {@link collectStages} and
 *   {@link getReportingCurrency}.
 */

/** `YYYY-MM` → (customerId → monthly recurring cents). Feeds `mrr.ts`. */
export type MonthlyRevenueSnapshots = Map<string, Map<string, number>>;

/**
 * Bucket for spend or wins with no channel recorded.
 *
 * Named rather than dropped: unattributed wins are usually the largest single
 * row in a young company's CAC table, and silently omitting them would make
 * blended CAC look worse than it is while hiding the fact that attribution is
 * not wired up.
 */
export const UNATTRIBUTED_CHANNEL = "unattributed";

const MONTHS_PER_YEAR = 12;

/** Epoch millis, or null for null / absent / Invalid Date. */
function timeOf(date: Date | null | undefined): number | null {
  if (!(date instanceof Date)) return null;
  const ms = date.getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** The half-open UTC bounds of one `YYYY-MM` key. */
type MonthWindow = { key: string; startMs: number; endExclusiveMs: number };

function monthWindow(key: string): MonthWindow {
  const year = Number(key.slice(0, 4));
  const month = Number(key.slice(5, 7));
  return {
    key,
    startMs: Date.UTC(year, month - 1, 1),
    endExclusiveMs: Date.UTC(year, month, 1),
  };
}

/** When a revenue source started and (if it has) stopped. `endMs: null` = live. */
type LiveWindow = { startMs: number; endMs: number | null };

/**
 * `frequency` → the `BillingInterval` vocabulary `mrr.ts` normalizes with.
 *
 * A `Record` rather than a switch so an unknown value from a hand-written
 * migration or an `as` cast lands as `undefined` and gets skipped, instead of
 * falling into a `default:` branch that would have to invent a cadence.
 */
const FREQUENCY_TO_INTERVAL: Record<RecurringInvoiceFrequency, BillingInterval> = {
  daily: "day",
  weekly: "week",
  monthly: "month",
  quarterly: "quarter",
  yearly: "year",
};

/**
 * Sum a recurring template's lines, tax excluded.
 *
 * **Tax is deliberately not included in MRR.** Sales tax is collected on behalf
 * of a government and remitted to it; counting it as recurring revenue inflates
 * MRR by the local VAT rate and makes two customers on the same plan in
 * different countries look like different sized accounts. `RecurringInvoiceLineItem`
 * stores no computed totals precisely because rates are snapshotted at
 * generation time, so there is nothing to include here even if we wanted to.
 *
 * A line with a non-finite quantity or unit price contributes zero rather than
 * poisoning the schedule's total with NaN.
 */
function lineCents(quantity: number, unitPriceCents: number): number {
  if (!Number.isFinite(quantity) || !Number.isFinite(unitPriceCents)) return 0;
  return roundHalfAway(quantity * unitPriceCents);
}

/**
 * The monthly-equivalent value of one schedule, or `null` when the row cannot
 * be read as a cadence at all.
 *
 * **How a cron becomes a monthly number, and why it is approximate.** A
 * `RecurringInvoice` stores both a `cronExpr` and a `frequency` /
 * `intervalCount` pair, and the entity is explicit that the cron alone drives
 * the schedule when `intervalCount` is 1. We normalize from `frequency` and
 * `intervalCount` and **never parse the cron**, for two reasons: inferring a
 * period from an arbitrary cron is not well defined (`0 9 1,15 * *` fires twice
 * a month and has no single interval), and pulling `cron-parser` — a scheduling
 * dependency — into a reporting path would mean a malformed expression could
 * break the revenue page. The cost is real and worth stating: if somebody edits
 * `cronExpr` to weekly and leaves `frequency` at monthly, MRR is wrong by ~4.3x
 * for that customer. The fix belongs at the write boundary (validate the two
 * against each other when a schedule is saved), not in a guess here.
 *
 * An unrecognized `frequency` returns `null` — the schedule is unusable and the
 * customer falls through to the ACV fallback, which is at least a number
 * somebody typed on purpose. Inventing "monthly" for a corrupt row would be the
 * most aggressive possible guess.
 *
 * `intervalCount` is clamped to a whole number `>= 1` rather than passed
 * through: `normalizeToMonthlyCents` throws on a non-positive count, and a
 * report must not throw because an `int` column holds a 0.
 */
function monthlyCentsForSchedule(
  schedule: RecurringInvoice,
  templateCents: number,
): number | null {
  const interval = FREQUENCY_TO_INTERVAL[schedule.frequency];
  if (interval === undefined) return null;
  if (!Number.isFinite(templateCents)) return null;

  const raw = schedule.intervalCount;
  const intervalCount = Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 1;
  return normalizeToMonthlyCents(templateCents, interval, intervalCount);
}

/**
 * The months a schedule was actually billing.
 *
 * **"Active" means active *in that month*, not `status === "active"` today.**
 * Filtering on the current status is the obvious reading and the wrong one: a
 * customer who churned in March would keep their revenue in every historical
 * month (or lose it in all of them), and either way the MRR series would show a
 * churn that never happened or hide one that did. Since churn is the whole
 * reason the series exists, the window has to be historical.
 *
 * - Start is `anchorAt ?? createdAt`. `anchorAt` is the first base cron
 *   occurrence and can legitimately be *after* creation — a schedule set up in
 *   December to start in January bills from January, and using `createdAt`
 *   would credit December with revenue nobody was charged.
 * - An `active` schedule is open-ended unless `endsOn` says otherwise. `endsOn`
 *   is honoured even when it has already elapsed and the heartbeat has not yet
 *   flipped the row to `ended`: the cutoff the user set beats the cron's lag.
 * - A `paused` or `ended` schedule closes at `endsOn ?? lastRunAt ?? updatedAt`.
 *   `lastRunAt` is the last invoice it really produced, which is the honest end
 *   of billing; `updatedAt` is the fallback for a row paused before it ever
 *   fired, and is when somebody touched it. Deliberately not modelled: the gap
 *   between a pause and a resume. `RecurringInvoice` keeps no pause history, so
 *   a resumed schedule reads as continuous — recovering the gap needs an audit
 *   trail this entity does not have.
 *
 * Returns null when the row has no usable start date at all.
 */
function scheduleWindow(schedule: RecurringInvoice): LiveWindow | null {
  const startMs = timeOf(schedule.anchorAt) ?? timeOf(schedule.createdAt);
  if (startMs === null) return null;

  const endsOnMs = timeOf(schedule.endsOn);
  if (schedule.status === "active") return { startMs, endMs: endsOnMs };

  const endMs = endsOnMs ?? timeOf(schedule.lastRunAt) ?? timeOf(schedule.updatedAt) ?? startMs;
  return { startMs, endMs };
}

/**
 * Add `monthlyCents` to every month the source overlapped.
 *
 * Overlap, not month-end occupancy: a customer who signed on the 3rd and
 * cancelled on the 20th counts for that month. The alternative (live at the
 * last instant of the month) is the stricter definition and would erase them
 * entirely — they would never appear as new and never appear as churn, and the
 * quarter would silently miss a logo. Overlap makes them show up as new then
 * churned, which is what happened.
 */
function creditMonths(
  snapshots: MonthlyRevenueSnapshots,
  windows: readonly MonthWindow[],
  customerId: string,
  monthlyCents: number,
  live: LiveWindow,
): void {
  for (const window of windows) {
    // Started on or before the month ended…
    if (live.startMs >= window.endExclusiveMs) continue;
    // …and did not end before the month began.
    if (live.endMs !== null && live.endMs < window.startMs) continue;
    const snapshot = snapshots.get(window.key);
    if (snapshot === undefined) continue;
    snapshot.set(customerId, (snapshot.get(customerId) ?? 0) + monthlyCents);
  }
}

/**
 * Monthly recurring revenue per customer per month — the input `mrr.ts` turns
 * into movement, retention and ARR.
 *
 * **The assumptions, in full, because this is the number people argue about:**
 *
 * 1. **Recurring invoices win; ACV is the fallback.** A customer with at least
 *    one readable `RecurringInvoice` is priced from their schedules (summed, so
 *    a customer on a base plan plus an add-on retainer counts as both). A
 *    customer with *no* schedule at all falls back to
 *    `annualContractValueCents / 12`. The fallback is per *customer*, not per
 *    month: once a customer is schedule-priced, the month their schedule ends
 *    goes to zero rather than reverting to ACV. That is the whole point —
 *    reverting would mean no schedule-driven customer could ever churn.
 * 2. **A month counts if the source overlapped it** — see {@link creditMonths}.
 * 3. **Months are UTC**, per `mrr.ts`'s `monthKey`. A series that shifts when
 *    somebody edits their timezone setting is worse than one consistently off
 *    by a few hours at the boundary.
 * 4. **Tax is excluded, cron is not parsed** — see {@link lineCents} and
 *    {@link monthlyCentsForSchedule}.
 * 5. **A customer whose total is zero or less is absent from the month.**
 *    `mrr.ts` reads a zero entry as "not a customer", and writing one anyway
 *    would make churn and reactivation ambiguous.
 * 6. **Schedules pointing at a customer row that no longer exists are dropped.**
 *    Their revenue belongs to nobody, and keeping it would put an id in the
 *    snapshot that no other report can resolve to a name.
 *
 * **Deliberately not done:** issued invoices are not consulted. Actual billing
 * is lumpy — an annual plan invoiced in January is not twelve times January's
 * MRR — and reconstructing a run rate from invoice history is a different, much
 * larger job (`collectCollectedRevenue` is the cash-basis counterpart, and the
 * two are *supposed* to disagree). Currency is also not converted: a company
 * billing in EUR and USD gets a total that mixes both, which the reporting
 * currency label makes visible but does not fix.
 *
 * Every month in `[from, to]` is present in the result, empty ones included, so
 * a caller can chart the range without patching holes.
 */
export async function buildMonthlyRevenueSnapshots(
  companyId: string,
  from: Date,
  to: Date,
): Promise<MonthlyRevenueSnapshots> {
  const keys = monthRange(from, to);
  const snapshots: MonthlyRevenueSnapshots = new Map(
    keys.map((key) => [key, new Map<string, number>()]),
  );
  if (keys.length === 0) return snapshots;

  // Whole rows rather than a projection: a company has hundreds of customers,
  // not millions, and the projection would have to be kept in step with every
  // field the window logic reads.
  const customers = await AppDataSource.getRepository(Customer).findBy({ companyId });
  if (customers.length === 0) return snapshots;
  const customerIds = new Set(customers.map((c) => c.id));

  const schedules = await AppDataSource.getRepository(RecurringInvoice).findBy({ companyId });
  const templateCents = await sumTemplateLines(schedules.map((s) => s.id));

  const windows = keys.map(monthWindow);
  /** Customers priced from a schedule — these do *not* get the ACV fallback. */
  const scheduled = new Set<string>();

  for (const schedule of schedules) {
    if (!customerIds.has(schedule.customerId)) continue;
    const monthlyCents = monthlyCentsForSchedule(
      schedule,
      templateCents.get(schedule.id) ?? 0,
    );
    // An unreadable cadence does not suppress the fallback: ACV is a worse
    // number than a real schedule but a better one than nothing.
    if (monthlyCents === null) continue;
    const live = scheduleWindow(schedule);
    if (live === null) continue;
    scheduled.add(schedule.customerId);
    creditMonths(snapshots, windows, schedule.customerId, monthlyCents, live);
  }

  for (const customer of customers) {
    if (scheduled.has(customer.id)) continue;
    const acv = customer.annualContractValueCents;
    if (!Number.isFinite(acv) || acv <= 0) continue;
    const startMs = timeOf(customer.createdAt);
    if (startMs === null) continue;
    creditMonths(snapshots, windows, customer.id, roundHalfAway(acv / MONTHS_PER_YEAR), {
      startMs,
      // Archiving is this codebase's soft delete; an archived customer stops
      // paying us on the day they were archived.
      endMs: timeOf(customer.archivedAt),
    });
  }

  // One sweep at the end rather than a guard at each add: a customer can be on
  // two schedules that cancel out, and only the total is meaningful.
  for (const snapshot of snapshots.values()) {
    for (const [id, cents] of snapshot) {
      if (!Number.isFinite(cents) || cents <= 0) snapshot.delete(id);
    }
  }

  return snapshots;
}

/** Template value per schedule id, in one query rather than one per schedule. */
async function sumTemplateLines(scheduleIds: string[]): Promise<Map<string, number>> {
  const totals = new Map<string, number>();
  // `In([])` renders as `IN ()`, which is a syntax error on Postgres.
  if (scheduleIds.length === 0) return totals;

  const lines = await AppDataSource.getRepository(RecurringInvoiceLineItem).findBy({
    recurringInvoiceId: In(scheduleIds),
  });
  for (const line of lines) {
    const cents = lineCents(line.quantity, line.unitPriceCents);
    totals.set(line.recurringInvoiceId, (totals.get(line.recurringInvoiceId) ?? 0) + cents);
  }
  return totals;
}

/**
 * Customers who had revenue in any month *before* `month`.
 *
 * This is what lets `computeMrrMovement` tell a returning customer from a new
 * one. Without it every reactivation is counted as new business, which is the
 * single most common way a SaaS board deck overstates growth.
 *
 * Comparison is a plain string compare, which is chronological because
 * `YYYY-MM` is fixed-width and zero-padded — the reason `mrr.ts` chose that
 * shape over a `{year, month}` pair.
 *
 * **The limitation, stated because it is invisible otherwise:** "ever before"
 * means "ever before *within the snapshots handed in*". A customer who churned
 * two years before the window starts reads as new when they come back. Widening
 * the loaded range is the only fix, and it is the caller's call to make —
 * loading a company's entire history to label one month is not a trade this
 * function gets to make on their behalf.
 */
export function buildEverBeforeSet(
  snapshots: ReadonlyMap<string, ReadonlyMap<string, number>>,
  month: string,
): Set<string> {
  const out = new Set<string>();
  for (const [key, snapshot] of snapshots) {
    if (key >= month) continue;
    for (const [customerId, cents] of snapshot) {
      if (Number.isFinite(cents) && cents > 0) out.add(customerId);
    }
  }
  return out;
}

/** Both bounds optional; an Invalid Date reads as that side being unbounded. */
export type DealWindow = { from?: Date; to?: Date };

/** Apply a half-open `[from, to)` filter, skipping bounds that are not real dates. */
function applyPeriod<T extends ObjectLiteral>(
  qb: SelectQueryBuilder<T>,
  column: string,
  from?: Date,
  to?: Date,
): void {
  if (timeOf(from) !== null) qb.andWhere(`${column} >= :periodFrom`, { periodFrom: from });
  if (timeOf(to) !== null) qb.andWhere(`${column} < :periodTo`, { periodTo: to });
}

/**
 * Deals shaped for `funnel.ts`, scoped to the company.
 *
 * **Open deals ignore the period; closed deals respect it.** The two halves of
 * the funnel report ask different questions: win rate and sales cycle are
 * "what happened in Q3", while the stage funnel and pipeline coverage are
 * "what is live right now". Filtering open deals by `createdAt` would make
 * coverage collapse to whatever was created inside the window, which is not a
 * pipeline. `funnel.ts` re-filters on `closedAt` itself, so this query is
 * deliberately the *superset* it needs — narrowing further here would silently
 * change numbers the pure module is responsible for.
 *
 * Archived deals are excluded everywhere. Archiving is how this codebase hides
 * a mistake or a duplicate, and a metric that counts them is a metric people
 * learn to distrust.
 *
 * Ordered by `createdAt` so a report built twice from the same rows is
 * byte-identical, which matters more than it sounds: half these numbers end up
 * in snapshot assertions.
 */
export async function collectFunnelDeals(
  companyId: string,
  window: DealWindow = {},
): Promise<FunnelDeal[]> {
  const qb = AppDataSource.getRepository(Deal)
    .createQueryBuilder("d")
    .where("d.companyId = :companyId", { companyId })
    .andWhere("d.archivedAt IS NULL");

  const bounded = timeOf(window.from) !== null || timeOf(window.to) !== null;
  if (bounded) {
    qb.andWhere(
      new Brackets((outer) => {
        outer.where("d.status = :openStatus", { openStatus: "open" });
        outer.orWhere(
          new Brackets((closed) => {
            closed.where("d.closedAt IS NOT NULL");
            if (timeOf(window.from) !== null) {
              closed.andWhere("d.closedAt >= :closedFrom", { closedFrom: window.from });
            }
            if (timeOf(window.to) !== null) {
              closed.andWhere("d.closedAt < :closedTo", { closedTo: window.to });
            }
          }),
        );
      }),
    );
  }

  const rows = await qb.orderBy("d.createdAt", "ASC").addOrderBy("d.id", "ASC").getMany();

  return rows.map((row) => ({
    id: row.id,
    stageId: row.stageId,
    amountCents: row.amountCents,
    status: row.status,
    createdAt: row.createdAt,
    closedAt: row.closedAt,
    probabilityOverride: row.probabilityOverride,
  }));
}

/**
 * The company's live stages, in board order, shaped for `funnel.ts`.
 *
 * Deliberately **not** `listDealStages` from `stages.ts`, which seeds a default
 * ladder when it finds none. Seeding is the right behaviour when somebody opens
 * the board; it is the wrong behaviour when a cron renders a weekly report, and
 * a read path that writes seven rows into a company nobody has ever visited is
 * a surprise nobody wants to debug. A company with no stages gets an empty
 * funnel, which is the honest answer.
 *
 * Archived stages are excluded, so an open deal still sitting in one lands in
 * `funnel.ts`'s `orphanedCount` instead of a column the board no longer shows.
 * That is a signal, not a loss: a nonzero orphan count means somebody archived
 * a stage with live deals in it.
 */
export async function collectStages(companyId: string): Promise<StageLike[]> {
  const rows = await AppDataSource.getRepository(DealStage).find({
    where: { companyId, archivedAt: IsNull() },
    order: { sortOrder: "ASC", createdAt: "ASC" },
  });
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    sortOrder: row.sortOrder,
    probability: row.probability,
    kind: row.kind,
  }));
}

/**
 * Ad spend per platform for `cac.ts`.
 *
 * # THIS IS NOT ACTUAL SPEND.
 *
 * `AdSpendEvent` is an append-only ledger of **authorized budget changes** —
 * one row each time an AI employee raised a budget, lowered it, enabled or
 * paused a campaign. It exists to enforce the rolling spend caps in
 * `integrations/providers/ads-shared.ts`, not to account for money that left a
 * bank account. A budget of $1,000/day authorized on the 1st and paused on the
 * 2nd reads as $1,000 here and cost $30 in reality; a campaign running all
 * month on an untouched budget reads as $0 here and cost thousands.
 *
 * So the CAC computed from this is a **proxy**, and every caller must say so —
 * the report objects in `reports.ts` carry a `spendIsProxy` flag for exactly
 * that reason. A future version should read realized spend from each platform's
 * reporting API (Google Ads `customer_client.metrics.cost_micros`, Meta's
 * Insights API) and keep this ledger for what it is good at, which is caps.
 *
 * Only **positive** deltas are summed, matching how `services/adSpend.ts`
 * computes the caps. Netting a later decrease against an earlier increase would
 * let a campaign that ran for three weeks and was then zeroed out report as
 * near-free, which is the exact opposite of what a CAC table is for.
 *
 * `amountMinor` is denominated in *each ad account's own* currency and is summed
 * without conversion. A company running a EUR and a USD ad account gets a
 * meaningless total, and there is no FX rate on these rows to fix it with — the
 * platform currency belongs on the connection, and converting it is a separate
 * job with `ExchangeRate`.
 */
export async function collectSpendByChannel(
  companyId: string,
  from: Date,
  to: Date,
): Promise<Map<string, number>> {
  const qb = AppDataSource.getRepository(AdSpendEvent)
    .createQueryBuilder("e")
    .select("e.platform", "platform")
    .addSelect("SUM(e.amountMinor)", "total")
    .where("e.companyId = :companyId", { companyId })
    .andWhere("e.amountMinor > 0")
    .groupBy("e.platform");
  applyPeriod(qb, "e.createdAt", from, to);

  const rows = await qb.getRawMany<{ platform: string | null; total: string | number | null }>();

  const out = new Map<string, number>();
  for (const row of rows) {
    // Postgres returns SUM(int) as a bigint string; sqlite returns a number.
    const total = Number(row.total ?? 0);
    if (!Number.isFinite(total) || total <= 0) continue;
    const channel = row.platform || UNATTRIBUTED_CHANNEL;
    out.set(channel, (out.get(channel) ?? 0) + total);
  }
  return out;
}

/**
 * Won-deal counts per `Deal.source`, for the other half of `cac.ts`.
 *
 * Keyed on `closedAt` and the `won` status, so it lines up with the win rate in
 * the same report rather than describing a different set of deals. Deals closed
 * outside the period are excluded even if they were created inside it: CAC pairs
 * spend in a window against customers acquired in that window, and cohorting the
 * wins by creation date instead would compare this quarter's money against last
 * quarter's outcomes.
 *
 * A deal with an empty `source` is counted under {@link UNATTRIBUTED_CHANNEL}
 * rather than dropped. Dropping it would quietly shrink the denominator of
 * blended CAC and make every channel look more expensive than it is.
 *
 * Counts are whole deals. `cac.ts` accepts fractional win counts for multi-touch
 * attribution, and this function deliberately does not do that: `Deal.source` is
 * a single varchar, so there is no second touch to split against. Splitting a
 * deal across channels needs an attribution table, not a guess here.
 */
export async function collectWonDealsByChannel(
  companyId: string,
  from: Date,
  to: Date,
): Promise<Map<string, number>> {
  const qb = AppDataSource.getRepository(Deal)
    .createQueryBuilder("d")
    .select("d.source", "source")
    .addSelect("COUNT(*)", "count")
    .where("d.companyId = :companyId", { companyId })
    .andWhere("d.archivedAt IS NULL")
    .andWhere("d.status = :won", { won: "won" })
    .andWhere("d.closedAt IS NOT NULL")
    .groupBy("d.source");
  applyPeriod(qb, "d.closedAt", from, to);

  const rows = await qb.getRawMany<{ source: string | null; count: string | number | null }>();

  const out = new Map<string, number>();
  for (const row of rows) {
    const count = Number(row.count ?? 0);
    if (!Number.isFinite(count) || count <= 0) continue;
    const channel = row.source || UNATTRIBUTED_CHANNEL;
    out.set(channel, (out.get(channel) ?? 0) + count);
  }
  return out;
}

/**
 * Cash actually collected in the period, in cents.
 *
 * The cash-basis counterpart to MRR, and it is *supposed* to disagree with it:
 * MRR is a normalized run rate, this is money that arrived. An annual plan
 * shows as one big number in the month it was paid and nothing for eleven
 * months; MRR shows a twelfth of it every month. Showing both beside each other
 * is the point — a company whose collected revenue keeps falling short of MRR
 * has a collections problem that a run rate cannot see.
 *
 * `InvoicePayment` carries no `companyId` (it hangs off an invoice), so the
 * scoping is an inner join on `invoices` — the company filter has to be in the
 * WHERE clause, not applied afterwards in JS, or a bug in the period filter
 * becomes a cross-tenant leak.
 *
 * Payments against **voided** invoices are included. Voiding an invoice is an
 * accounting correction to the document; it does not un-receive the money, and
 * a refund is recorded as its own negative payment or by deleting the row. The
 * currency caveat from the snapshots applies here too: amounts are summed
 * without FX conversion.
 */
export async function collectCollectedRevenue(
  companyId: string,
  from: Date,
  to: Date,
): Promise<number> {
  const qb = AppDataSource.getRepository(InvoicePayment)
    .createQueryBuilder("p")
    .innerJoin(Invoice, "i", "i.id = p.invoiceId")
    .select("SUM(p.amountCents)", "total")
    .where("i.companyId = :companyId", { companyId });
  applyPeriod(qb, "p.paidAt", from, to);

  const row = await qb.getRawOne<{ total: string | number | null }>();
  const total = Number(row?.total ?? 0);
  return Number.isFinite(total) ? total : 0;
}

/**
 * The company's reporting currency — a label, not a conversion.
 *
 * Read directly instead of through `getFinanceSettings`, which creates the
 * settings row on first call. A report is a read; a company that has never
 * opened Finance should not acquire a row because somebody looked at a chart.
 * The fallback is the same `DEFAULT_CURRENCY` that entity column defaults to,
 * so the answer is identical either way — only the write is skipped.
 */
export async function getReportingCurrency(companyId: string): Promise<string> {
  const row = await AppDataSource.getRepository(CompanyFinanceSettings).findOne({
    where: { companyId },
    select: ["homeCurrency"],
  });
  return row?.homeCurrency || DEFAULT_CURRENCY;
}
