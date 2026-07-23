import { weightedValueCents } from "./dealStage.js";

/**
 * Sales funnel and pipeline math.
 *
 * Everything here is pure: deals and stages in, numbers out. The DB work of
 * loading a pipeline lives in the deal service, so the metrics a founder will
 * put on a board slide can be tested exhaustively without a database — the
 * same split `mrr.ts` makes for recurring revenue.
 *
 * Four conventions, stated once so they are not re-litigated per function:
 *
 * - **Money is integer minor units**, as everywhere else in Genosyn (M19).
 *   Weighting is delegated to {@link weightedValueCents} in `dealStage.ts` so
 *   there is exactly one place that decides how a probability override beats a
 *   stage default; this file never multiplies an amount by a probability.
 * - **A {@link Period} is `[from, to)`** — inclusive at `from`, **exclusive**
 *   at `to`. Half-open ranges are the only way consecutive months tile without
 *   double-counting a deal that closed at midnight on the boundary. A bound
 *   that is an Invalid Date is treated as unbounded rather than throwing: a
 *   bad filter should widen the report, not break it.
 * - **Bad data is dropped, not fatal.** A non-finite `amountCents` counts as
 *   zero, an unparseable date counts as absent, a deal in an unknown stage is
 *   reported as orphaned. Pipelines are imported from CRMs and CSVs; a report
 *   that throws on one malformed row is useless. We throw only for programmer
 *   error — see {@link computePipelineCoverage}. The one throw we do *not*
 *   swallow is `dealStage`'s non-finite-probability guard: a NaN probability
 *   on a stage row is its call to make, and re-classifying it here would leave
 *   two modules disagreeing about what counts as corruption.
 * - **Percentages are rounded to one decimal**, coverage to two. One decimal
 *   is the precision anybody actually reads; coverage is quoted as a multiple
 *   ("3.25x") where the second digit still carries meaning.
 */

/** The shape of a pipeline stage this module needs. Deliberately structural */
/** so tests and the API layer can pass plain objects instead of entities. */
export type StageLike = {
  id: string;
  name: string;
  sortOrder: number;
  probability: number;
  kind: "open" | "won" | "lost";
};

/** The shape of a deal this module needs. `closedAt` is null while open. */
export type FunnelDeal = {
  id: string;
  stageId: string;
  amountCents: number;
  status: "open" | "won" | "lost";
  createdAt: Date;
  closedAt: Date | null;
  probabilityOverride: number | null;
};

/**
 * A half-open date range: **inclusive `from`, exclusive `to`**.
 *
 * Stated on the type because getting it wrong is silent — a deal closed at
 * exactly `to` would be counted in both this period and the next, and nobody
 * notices until two quarters do not add up to the year.
 */
export type Period = { from: Date; to: Date };

const MS_PER_DAY = 86_400_000;

/** One decimal is the precision anybody actually reads. */
function pct(ratio: number): number {
  return Math.round(ratio * 1000) / 10;
}

/** Epoch millis, or null for null/absent/Invalid Date. */
function timeOf(date: Date | null | undefined): number | null {
  if (!(date instanceof Date)) return null;
  const ms = date.getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * `[from, to)` membership. An omitted period matches everything; a bound that
 * is an Invalid Date is treated as that side being unbounded.
 */
function inPeriod(ms: number, period: Period | undefined): boolean {
  if (period === undefined) return true;
  const from = timeOf(period.from);
  const to = timeOf(period.to);
  if (from !== null && ms < from) return false;
  if (to !== null && ms >= to) return false;
  return true;
}

/**
 * Non-finite amounts read as zero, the same way `mrr.ts` reads them as absent.
 *
 * The zeroing happens on a *copy of the deal* rather than at each use site so
 * that `dealStage.ts` never sees a NaN amount either — otherwise the row value
 * would be sanitized while the weighted value silently became NaN and poisoned
 * the whole column.
 */
function sanitized(deal: FunnelDeal): FunnelDeal {
  if (Number.isFinite(deal.amountCents)) return deal;
  return { ...deal, amountCents: 0 };
}

export type WinRateResult = {
  won: number;
  lost: number;
  /** null when nothing closed — a 0% win rate and no deals are not the same. */
  winRatePct: number | null;
};

/**
 * Win rate over deals that **closed** in the period.
 *
 * Keyed on `closedAt`, not `createdAt`, because that is the question being
 * asked: of the deals we finished this quarter, how many did we win? Cohorting
 * by creation date answers a different (also useful, also slower to converge)
 * question and would leave every recent cohort permanently incomplete.
 *
 * Still-open deals are excluded entirely rather than counted as losses —
 * counting live pipeline as lost is the classic way to make a healthy quarter
 * look terrible. Deals with a null `closedAt` are excluded for the same
 * reason, and a deal whose status is still `open` is excluded even if it
 * somehow carries a `closedAt` (a reopened deal): status is the authority on
 * whether the outcome is known.
 *
 * `winRatePct` is null rather than 0 when nothing closed, so a caller can
 * render "—" instead of a discouraging and meaningless zero.
 */
export function computeWinRate(
  deals: readonly FunnelDeal[],
  period: Period,
): WinRateResult {
  let won = 0;
  let lost = 0;

  for (const deal of deals) {
    if (deal.status !== "won" && deal.status !== "lost") continue;
    const closed = timeOf(deal.closedAt);
    if (closed === null) continue;
    if (!inPeriod(closed, period)) continue;
    if (deal.status === "won") {
      won += 1;
    } else {
      lost += 1;
    }
  }

  const total = won + lost;
  return { won, lost, winRatePct: total > 0 ? pct(won / total) : null };
}

/**
 * **Median** days from creation to close, for won deals only.
 *
 * Median rather than mean, deliberately: one 2-year enterprise deal in a book
 * of 30 two-week SMB deals drags the mean into fiction, and the mean is the
 * number people then use to forecast. The median moves only when the typical
 * deal moves, which is what "our sales cycle" is supposed to mean. Even counts
 * average the two middle values, the standard definition.
 *
 * Lost deals are excluded because a lost deal's clock usually stops when
 * somebody finally marked it dead, not when the buyer decided — including them
 * measures CRM hygiene, not sales velocity. Open deals have no end date at all.
 *
 * A close timestamp before the create timestamp (clock skew, or a backdated
 * import) clamps to 0 days rather than being dropped: a negative cycle is
 * nonsense, but silently shrinking the sample is worse than one fast outlier.
 *
 * `period` is optional and filters on `closedAt`, matching {@link
 * computeWinRate} so the two numbers describe the same set of deals. Returns
 * null for an empty set — never a divide-by-zero, never a misleading 0.
 */
export function computeSalesCycleDays(
  deals: readonly FunnelDeal[],
  period?: Period,
): number | null {
  const durations: number[] = [];

  for (const deal of deals) {
    if (deal.status !== "won") continue;
    const closed = timeOf(deal.closedAt);
    const created = timeOf(deal.createdAt);
    if (closed === null || created === null) continue;
    if (!inPeriod(closed, period)) continue;
    durations.push(Math.max(0, closed - created) / MS_PER_DAY);
  }

  if (durations.length === 0) return null;

  durations.sort((a, b) => a - b);
  const mid = Math.floor(durations.length / 2);
  const median =
    durations.length % 2 === 1
      ? durations[mid]
      : (durations[mid - 1] + durations[mid]) / 2;

  return Math.round(median * 10) / 10;
}

export type StageFunnelRow = {
  stage: StageLike;
  count: number;
  valueCents: number;
  weightedValueCents: number;
};

export type StageFunnelResult = {
  rows: StageFunnelRow[];
  /** Open deals pointing at a stage id that is not in `stages`. */
  orphanedCount: number;
};

/**
 * Deal count and value per stage, for the funnel chart.
 *
 * Open deals only. Won and lost deals belong to {@link computeWinRate}; mixing
 * them in makes the funnel grow forever and turns the widest column into "all
 * business we have ever done".
 *
 * Every stage passed in gets a row, including stages holding nothing — an
 * empty column is information ("nothing in Negotiation") and a funnel whose
 * columns appear and disappear between refreshes is unreadable. Which stages
 * to pass is the caller's call: this function does not filter on `stage.kind`,
 * so a caller who wants a strictly open-pipeline funnel passes only open
 * stages, and one who wants won/lost columns can have them.
 *
 * Rows are ordered by `sortOrder`. Ties keep the input order (Array#sort is
 * stable), so a caller that pre-sorted by name keeps that tiebreak. Duplicate
 * stage ids are tolerated: deals land in the first such stage in sorted order
 * and the later duplicates render as empty rows, which makes the
 * misconfiguration visible instead of silently doubling a column.
 *
 * Deals in an unknown stage are dropped from the rows but surfaced as
 * `orphanedCount` — the sum of the columns is then trustworthy, and a nonzero
 * orphan count tells the caller their stage list is stale rather than letting
 * a chunk of pipeline vanish without a trace.
 */
export function computeStageFunnel(
  deals: readonly FunnelDeal[],
  stages: readonly StageLike[],
): StageFunnelResult {
  const ordered = [...stages].sort((a, b) => a.sortOrder - b.sortOrder);

  const rows: StageFunnelRow[] = [];
  const byStageId = new Map<string, StageFunnelRow>();
  for (const stage of ordered) {
    const row: StageFunnelRow = {
      stage,
      count: 0,
      valueCents: 0,
      weightedValueCents: 0,
    };
    rows.push(row);
    if (!byStageId.has(stage.id)) byStageId.set(stage.id, row);
  }

  let orphanedCount = 0;
  for (const deal of deals) {
    if (deal.status !== "open") continue;
    const row = byStageId.get(deal.stageId);
    if (row === undefined) {
      orphanedCount += 1;
      continue;
    }
    const clean = sanitized(deal);
    row.count += 1;
    row.valueCents += clean.amountCents;
    row.weightedValueCents += weightedValueCents(clean, row.stage);
  }

  return { rows, orphanedCount };
}

export type PipelineCoverageResult = {
  openCents: number;
  weightedCents: number;
  /** Multiples, not percentages. null when the target is not positive. */
  coverage: number | null;
  weightedCoverage: number | null;
};

/**
 * Pipeline coverage against a target.
 *
 * Coverage is conventionally quoted as a **multiple**, not a percentage: sales
 * leaders say "we have 3x coverage", meaning open pipeline is three times the
 * number we have to close. Returning 300 here would invite somebody to render
 * it as "300%" beside a win rate and make the two look comparable, which they
 * are not. Two decimals, because the second digit of a multiple still reads.
 *
 * Both a raw and a weighted multiple are returned because they answer
 * different questions: raw coverage is the standard 3x-4x rule of thumb, while
 * weighted coverage against the same target is roughly "are we going to hit
 * it" and should be near or above 1x.
 *
 * Deals whose stage is unknown are skipped entirely — they cannot be weighted,
 * and counting them in `openCents` while omitting them from `weightedCents`
 * would quietly depress the weighted multiple. Non-open deals passed in are
 * ignored too, so a caller who hands over their whole book still gets pipeline
 * rather than pipeline plus bookings.
 *
 * A target of zero or less returns null coverage rather than Infinity: "no
 * target set" and "infinite coverage" must not render the same. A non-finite
 * target throws, because that is a caller bug, not data.
 */
export function computePipelineCoverage(
  openDeals: readonly FunnelDeal[],
  stages: readonly StageLike[],
  targetCents: number,
): PipelineCoverageResult {
  if (!Number.isFinite(targetCents)) {
    throw new Error("computePipelineCoverage: targetCents must be finite");
  }

  const byStageId = new Map<string, StageLike>();
  for (const stage of stages) {
    if (!byStageId.has(stage.id)) byStageId.set(stage.id, stage);
  }

  let openCents = 0;
  let weightedCents = 0;
  for (const deal of openDeals) {
    if (deal.status !== "open") continue;
    const stage = byStageId.get(deal.stageId);
    if (stage === undefined) continue;
    const clean = sanitized(deal);
    openCents += clean.amountCents;
    weightedCents += weightedValueCents(clean, stage);
  }

  const multiple = (value: number): number | null =>
    targetCents > 0 ? Math.round((value / targetCents) * 100) / 100 : null;

  return {
    openCents,
    weightedCents,
    coverage: multiple(openCents),
    weightedCoverage: multiple(weightedCents),
  };
}

/** Only the two fields conversion needs, so any row-shaped object works. */
export type StageCountLike = { stage: StageLike; count: number };

export type StageConversionRow = {
  fromStage: StageLike;
  toStage: StageLike;
  /** null when the from-stage is empty — 0/0 is undefined, not 0%. */
  conversionPct: number | null;
};

/**
 * Step-to-step conversion between consecutive funnel rows.
 *
 * This is a **snapshot ratio**, not a cohort conversion: it compares how many
 * deals are sitting in stage N+1 right now against how many are sitting in
 * stage N right now. It is what a funnel chart draws, and it is cheap, but it
 * is not "x% of deals that reached Demo went on to Proposal" — answering that
 * honestly needs stage-transition history, which this module deliberately does
 * not take. Consequently a value above 100% is legitimate and left uncapped: a
 * late stage can hold more deals than the one feeding it after a bulk import
 * or a slow quarter, and clamping to 100 would hide that.
 *
 * Rows are consumed in the order given — pass {@link computeStageFunnel}'s
 * `rows` untouched. Fewer than two rows yields an empty array rather than a
 * synthetic self-conversion.
 *
 * A from-stage count of zero yields null, never a divide-by-zero and never a
 * 0% that would read as "everything drops out here".
 */
export function computeStageConversion(
  rows: readonly StageCountLike[],
): StageConversionRow[] {
  const out: StageConversionRow[] = [];
  for (let i = 0; i + 1 < rows.length; i += 1) {
    const from = rows[i];
    const to = rows[i + 1];
    out.push({
      fromStage: from.stage,
      toStage: to.stage,
      conversionPct: from.count > 0 ? pct(to.count / from.count) : null,
    });
  }
  return out;
}
