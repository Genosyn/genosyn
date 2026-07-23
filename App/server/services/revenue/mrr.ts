import { roundHalfAway } from "../../lib/money.js";

/**
 * Recurring-revenue math.
 *
 * Everything here is pure: snapshots in, movement out. The DB work of building
 * a snapshot lives in `revenueData.ts`, so the arithmetic that founders will
 * quote to investors can be tested exhaustively without a database.
 *
 * Two conventions, stated once so they are not re-litigated per function:
 *
 * - **Money is integer minor units**, as everywhere else in Genosyn (M19).
 *   Normalization rounds half away from zero via {@link roundHalfAway}, the
 *   same helper invoice lines use, so a monthly-normalized annual plan and an
 *   invoice for the same plan round the same direction.
 * - **A snapshot entry of zero or less means "not a customer this month."**
 *   Carrying a zero would make churn and reactivation ambiguous: a customer
 *   sitting at 0 is indistinguishable from one who left. Callers may pass
 *   zeros; we treat them as absent.
 */

export type BillingInterval = "day" | "week" | "month" | "quarter" | "year";

/** Days in a year, and therefore in an average month. Using 365 (not 365.25) */
/** keeps a yearly plan divided by 12 exactly equal to its monthly form. */
const DAYS_PER_YEAR = 365;
const MONTHS_PER_YEAR = 12;
const DAYS_PER_MONTH = DAYS_PER_YEAR / MONTHS_PER_YEAR;

/**
 * Convert a recurring charge to its monthly-equivalent value.
 *
 * `intervalCount` is the Stripe-style multiplier — `{ interval: "month",
 * intervalCount: 3 }` is a quarterly plan. Both are needed because providers
 * disagree about which they use.
 *
 * Throws on nonsense rather than silently producing a wrong MRR: a report that
 * is quietly off by a factor of twelve is worse than one that fails loudly.
 * Callers reading DB rows are expected to sanitize first.
 */
export function normalizeToMonthlyCents(
  amountCents: number,
  interval: BillingInterval,
  intervalCount = 1,
): number {
  if (!Number.isFinite(amountCents)) {
    throw new Error("normalizeToMonthlyCents: amountCents must be finite");
  }
  if (!Number.isFinite(intervalCount) || intervalCount <= 0) {
    throw new Error("normalizeToMonthlyCents: intervalCount must be > 0");
  }

  // Months covered by one billing period.
  let monthsPerPeriod: number;
  switch (interval) {
    case "day":
      monthsPerPeriod = intervalCount / DAYS_PER_MONTH;
      break;
    case "week":
      monthsPerPeriod = (intervalCount * 7) / DAYS_PER_MONTH;
      break;
    case "month":
      monthsPerPeriod = intervalCount;
      break;
    case "quarter":
      monthsPerPeriod = intervalCount * 3;
      break;
    case "year":
      monthsPerPeriod = intervalCount * MONTHS_PER_YEAR;
      break;
    default:
      throw new Error(`normalizeToMonthlyCents: unknown interval ${String(interval)}`);
  }
  return roundHalfAway(amountCents / monthsPerPeriod);
}

/** Annual run rate. Trivial, but named so nobody writes `* 12` inline twice. */
export function arrCents(mrrCents: number): number {
  return mrrCents * MONTHS_PER_YEAR;
}

/** customerId → monthly recurring cents for one month. */
export type RevenueSnapshot = ReadonlyMap<string, number>;

export type MrrMovement = {
  startingCents: number;
  newCents: number;
  expansionCents: number;
  reactivationCents: number;
  /** Positive magnitudes — the sign is in the name, not the number. */
  contractionCents: number;
  churnCents: number;
  netCents: number;
  endingCents: number;
  counts: {
    new: number;
    expanded: number;
    reactivated: number;
    contracted: number;
    churned: number;
    retained: number;
  };
};

/** Zero, negative, and non-finite all read as "absent". */
function active(snapshot: RevenueSnapshot, id: string): number {
  const value = snapshot.get(id);
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
  return value;
}

/** Sum of the active entries in a snapshot. */
export function sumSnapshot(snapshot: RevenueSnapshot): number {
  let total = 0;
  for (const id of snapshot.keys()) total += active(snapshot, id);
  return total;
}

/**
 * Break the month-over-month change into the five movements every SaaS board
 * deck asks for.
 *
 * `everBefore` is the set of customers who had revenue in *any* earlier month.
 * Without it a returning customer is indistinguishable from a brand-new one,
 * which overstates new business — the single most common way this metric is
 * reported wrong. Omit it and reactivation folds into `new`, which is stated
 * behaviour rather than a bug.
 *
 * Guaranteed invariants (asserted in the tests):
 *   endingCents - startingCents === netCents
 *   netCents === new + expansion + reactivation - contraction - churn
 */
export function computeMrrMovement(
  previous: RevenueSnapshot,
  current: RevenueSnapshot,
  everBefore?: ReadonlySet<string>,
): MrrMovement {
  let newCents = 0;
  let expansionCents = 0;
  let reactivationCents = 0;
  let contractionCents = 0;
  let churnCents = 0;
  const counts = {
    new: 0,
    expanded: 0,
    reactivated: 0,
    contracted: 0,
    churned: 0,
    retained: 0,
  };

  const ids = new Set<string>([...previous.keys(), ...current.keys()]);
  for (const id of ids) {
    const before = active(previous, id);
    const after = active(current, id);

    if (before === 0 && after === 0) continue;

    if (before === 0) {
      if (everBefore?.has(id)) {
        reactivationCents += after;
        counts.reactivated += 1;
      } else {
        newCents += after;
        counts.new += 1;
      }
      continue;
    }

    if (after === 0) {
      churnCents += before;
      counts.churned += 1;
      continue;
    }

    counts.retained += 1;
    const delta = after - before;
    if (delta > 0) {
      expansionCents += delta;
      counts.expanded += 1;
    } else if (delta < 0) {
      contractionCents += -delta;
      counts.contracted += 1;
    }
  }

  const startingCents = sumSnapshot(previous);
  const endingCents = sumSnapshot(current);
  const netCents =
    newCents + expansionCents + reactivationCents - contractionCents - churnCents;

  return {
    startingCents,
    newCents,
    expansionCents,
    reactivationCents,
    contractionCents,
    churnCents,
    netCents,
    endingCents,
    counts,
  };
}

export type RetentionResult = {
  cohortSize: number;
  startingCents: number;
  /** What the cohort is worth now — expansion included. Drives NRR. */
  endingCents: number;
  /** Capped per customer at their starting value. Drives GRR. */
  retainedCents: number;
  churnedCount: number;
  /** Percentages to one decimal, or null when the cohort started at zero. */
  nrrPct: number | null;
  grrPct: number | null;
};

/**
 * Net and gross revenue retention for one cohort.
 *
 * NRR counts expansion, so it can exceed 100% — that is the number that says
 * whether the product grows without new logos. GRR caps each customer at what
 * they started at, so it can never exceed 100% and isolates pure leakage.
 *
 * Only customers in `cohort` are considered; anyone who appears in `later`
 * without being in the cohort is somebody else's new business.
 */
export function computeRetention(
  cohort: RevenueSnapshot,
  later: RevenueSnapshot,
): RetentionResult {
  let startingCents = 0;
  let endingCents = 0;
  let retainedCents = 0;
  let cohortSize = 0;
  let churnedCount = 0;

  for (const id of cohort.keys()) {
    const before = active(cohort, id);
    if (before === 0) continue;
    cohortSize += 1;
    const after = active(later, id);
    startingCents += before;
    endingCents += after;
    retainedCents += Math.min(before, after);
    if (after === 0) churnedCount += 1;
  }

  return {
    cohortSize,
    startingCents,
    endingCents,
    retainedCents,
    churnedCount,
    nrrPct: startingCents > 0 ? pct(endingCents / startingCents) : null,
    grrPct: startingCents > 0 ? pct(retainedCents / startingCents) : null,
  };
}

/** One decimal is the precision anybody actually reads. */
function pct(ratio: number): number {
  return Math.round(ratio * 1000) / 10;
}

/**
 * `YYYY-MM` bucket key, in UTC.
 *
 * Deliberately UTC rather than company-local: a monthly revenue series that
 * shifts when somebody edits their timezone setting is worse than one that is
 * consistently off by a few hours at the boundary.
 */
export function monthKey(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

/** Inclusive list of `YYYY-MM` keys, oldest first. */
export function monthRange(from: Date, to: Date): string[] {
  const keys: string[] = [];
  const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
  const end = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), 1));
  while (cursor <= end) {
    keys.push(monthKey(cursor));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return keys;
}
