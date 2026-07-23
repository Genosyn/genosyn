import { roundHalfAway } from "../../lib/money.js";

/**
 * Customer-acquisition economics.
 *
 * Everything here is pure: spend and win counts in, CAC / LTV / payback out.
 * The DB work of bucketing ad spend and closed-won deals by channel belongs to
 * the callers, so the numbers a founder puts in front of an investor can be
 * tested exhaustively without a database or an ad-platform API key.
 *
 * Three conventions, stated once so they are not re-litigated per function:
 *
 * - **Money is integer minor units**, as everywhere else in Genosyn (M19).
 *   Division rounds half away from zero via {@link roundHalfAway}, the same
 *   helper invoice lines use.
 * - **A ratio that cannot be computed is `null` — never `Infinity`, never
 *   `NaN`.** Dividing spend by zero wins is the natural thing to do here and
 *   the wrong one: `Infinity` renders as "∞" in a board deck and reads as a
 *   rendering bug rather than as a fact about the channel, and `NaN` silently
 *   poisons every average downstream. Per-channel rows carry a `note` saying
 *   which impossible case they hit, so the UI can print "no wins yet" instead.
 * - **Zero, negative and non-finite inputs read as "nothing there"**, the same
 *   way a zero entry reads as "not a customer" in `mrr.ts`. A negative ad spend
 *   is a platform credit, and there is no honest place for it in a CAC.
 */

/**
 * Why a row could not produce a real CAC — or `"ok"` when it did.
 *
 * `"organic"` and `"no-wins"` are kept apart rather than collapsed into one
 * "n/a" because they mean opposite things to whoever reads the report: one is
 * free customers, the other is burned money.
 */
export type CacNote = "ok" | "no-wins" | "organic";

export type ChannelCac = {
  channel: string;
  spendCents: number;
  /** May be fractional — see {@link computeCacByChannel} on attribution. */
  wonCount: number;
  /** `null` only when `note === "no-wins"`. */
  cacCents: number | null;
  note: CacNote;
};

/** Zero, negative, and non-finite all read as "nothing there". */
function present(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
  return value;
}

/** Spend descending, then channel name ascending. */
function bySpendThenChannel(a: ChannelCac, b: ChannelCac): number {
  if (b.spendCents !== a.spendCents) return b.spendCents - a.spendCents;
  if (a.channel < b.channel) return -1;
  if (a.channel > b.channel) return 1;
  return 0;
}

/**
 * Cost to acquire one customer, per channel.
 *
 * Takes the **union** of both key sets: a channel with spend and no wins is the
 * most important row in the table, and a channel with wins and no spend is the
 * one everybody wants more of. Dropping either would flatter the report.
 *
 * Ordering is spend descending, then channel name ascending, so the money goes
 * at the top and the result is byte-stable for snapshot-style assertions. The
 * name tiebreak compares code units rather than using `localeCompare`, because
 * a sort order that shifts with the server's ICU version is not deterministic.
 *
 * `wonCount` is deliberately not forced to an integer. Multi-touch attribution
 * legitimately splits one deal across two channels as 0.5 each, and rounding
 * that to zero or one would quietly rewrite the attribution model.
 *
 * The three degenerate cases:
 * - spend, no wins  → `cacCents: null`, `note: "no-wins"`. Never `Infinity`.
 * - wins, no spend  → `cacCents: 0`, `note: "organic"`.
 * - neither         → the row is dropped entirely; a channel nobody spent on
 *                     and nobody came from is noise in a table this small.
 */
export function computeCacByChannel(
  spendByChannel: ReadonlyMap<string, number>,
  wonByChannel: ReadonlyMap<string, number>,
): ChannelCac[] {
  const rows: ChannelCac[] = [];
  const channels = new Set<string>([...spendByChannel.keys(), ...wonByChannel.keys()]);

  for (const channel of channels) {
    const spendCents = present(spendByChannel.get(channel));
    const wonCount = present(wonByChannel.get(channel));

    if (spendCents === 0 && wonCount === 0) continue;

    if (wonCount === 0) {
      rows.push({ channel, spendCents, wonCount, cacCents: null, note: "no-wins" });
      continue;
    }
    if (spendCents === 0) {
      rows.push({ channel, spendCents, wonCount, cacCents: 0, note: "organic" });
      continue;
    }
    rows.push({
      channel,
      spendCents,
      wonCount,
      cacCents: roundHalfAway(spendCents / wonCount),
      note: "ok",
    });
  }

  rows.sort(bySpendThenChannel);
  return rows;
}

/**
 * Total spend over total wins — the only CAC a CFO trusts.
 *
 * Counts spend from channels that produced *no* wins, which is the whole point:
 * per-channel CAC lets a dead channel hide behind a `null`, and blended does
 * not. Expect blended to sit above the best per-channel number, sometimes well
 * above; it only falls inside the per-channel range when every channel won
 * something.
 *
 * `null` when nothing was won anywhere — cost per customer is not a number when
 * there are no customers, and zero would read as "free".
 */
export function computeBlendedCac(
  spendByChannel: ReadonlyMap<string, number>,
  wonByChannel: ReadonlyMap<string, number>,
): number | null {
  let totalSpend = 0;
  for (const value of spendByChannel.values()) totalSpend += present(value);

  let totalWon = 0;
  for (const value of wonByChannel.values()) totalWon += present(value);

  if (totalWon <= 0) return null;
  return roundHalfAway(totalSpend / totalWon);
}

/** Throwing is for programmer error only; data conditions return `null`. */
function requireFinite(fn: string, name: string, value: number): void {
  if (!Number.isFinite(value)) throw new Error(`${fn}: ${name} must be finite`);
}

/**
 * Lifetime value of a customer, in cents.
 *
 * `LTV = ARPA × (margin/100) ÷ (churn/100)`. The two hundredths cancel, so we
 * divide margin by churn directly — one division instead of two, and no
 * intermediate rounding step to argue about.
 *
 * The formula assumes a **constant monthly churn rate**, which makes the
 * expected lifetime `1/churn` months. Real cohorts churn hardest in month one
 * and flatten out afterwards, so this overstates LTV for young companies. It is
 * still the number every investor asks for, and a cohort-decay model needs
 * cohort data this function deliberately does not take.
 *
 * `null` when:
 * - `monthlyChurnPct <= 0` — zero churn means infinite lifetime, and `Infinity`
 *   is not a number a board deck can use. A negative churn rate is nonsense
 *   data, not negative-value customers.
 * - `grossMarginPct` is outside `0..100` — a margin above 100% or below 0% is a
 *   unit error upstream (a fraction passed where a percentage was expected is
 *   the usual one), and quietly computing on it produces a confident wrong LTV.
 *
 * A negative `averageMonthlyRevenueCents` is passed through to a negative LTV
 * rather than nulled: unlike the two above it is arithmetically meaningful
 * (customers who cost more than they pay) and the caller can see the sign.
 */
export function computeLtvCents(
  averageMonthlyRevenueCents: number,
  grossMarginPct: number,
  monthlyChurnPct: number,
): number | null {
  requireFinite("computeLtvCents", "averageMonthlyRevenueCents", averageMonthlyRevenueCents);
  requireFinite("computeLtvCents", "grossMarginPct", grossMarginPct);
  requireFinite("computeLtvCents", "monthlyChurnPct", monthlyChurnPct);

  if (grossMarginPct < 0 || grossMarginPct > 100) return null;
  if (monthlyChurnPct <= 0) return null;

  return roundHalfAway((averageMonthlyRevenueCents * grossMarginPct) / monthlyChurnPct);
}

/** One decimal is the precision anybody actually reads. */
function oneDecimal(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * The `3.0` on the slide — LTV as a multiple of what it cost to acquire.
 *
 * Takes `null`s straight from {@link computeLtvCents} and
 * {@link computeCacByChannel} so callers can chain without a guard at every
 * step; a missing input propagates as a missing ratio rather than as a zero
 * that would read as "this channel loses money".
 *
 * `null` when `cacCents <= 0` too. A free customer has an infinite return and
 * the honest thing to print is "n/a", not a number that dwarfs every real
 * channel and wrecks the axis on the chart next to it.
 */
export function computeLtvToCac(
  ltvCents: number | null,
  cacCents: number | null,
): number | null {
  if (ltvCents === null || cacCents === null) return null;
  requireFinite("computeLtvToCac", "ltvCents", ltvCents);
  requireFinite("computeLtvToCac", "cacCents", cacCents);
  if (cacCents <= 0) return null;
  return oneDecimal(ltvCents / cacCents);
}

/**
 * Months of gross profit needed to earn back the acquisition cost.
 *
 * Gross profit, not revenue — paying back CAC out of revenue ignores the cost
 * of serving the customer and understates payback by exactly the margin.
 *
 * Assumes flat monthly profit, so it is a straight division rather than a
 * cumulative walk down a cohort curve. Expansion revenue would shorten the real
 * payback; this function has no way to know about it and does not pretend to.
 *
 * `null` when `monthlyGrossProfitCents <= 0`: an unprofitable customer never
 * pays the CAC back, and "never" is not a month count. A zero CAC returns `0`,
 * which is correct and not the same thing.
 */
export function computePaybackMonths(
  cacCents: number,
  monthlyGrossProfitCents: number,
): number | null {
  requireFinite("computePaybackMonths", "cacCents", cacCents);
  requireFinite("computePaybackMonths", "monthlyGrossProfitCents", monthlyGrossProfitCents);
  if (monthlyGrossProfitCents <= 0) return null;
  return oneDecimal(cacCents / monthlyGrossProfitCents);
}
