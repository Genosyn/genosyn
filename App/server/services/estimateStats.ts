import { In } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { Estimate } from "../db/entities/Estimate.js";
import { addDays, clockName, dayOf, daysBetween, documentDay } from "../../shared/documentDays.js";
import {
  ESTIMATE_EXPIRING_DAYS,
  ESTIMATE_OUTCOMES,
  ESTIMATE_RECENT_DAYS,
  type EstimateOutcome,
  type EstimateStats,
  type StatsDocuments,
} from "../../shared/financeStats.js";
import { companyTimeZone } from "./companyTimeZone.js";
import {
  addDocument,
  currencyOf,
  emptyDocuments,
  largestCustomer,
  LeftOut,
} from "./financeStatsShared.js";
import { convertAtRate, rateHistory } from "./fx.js";
import { getReportingCurrency } from "./revenue/revenueData.js";

/**
 * The figures Finance → Estimates leads with: what is out with customers,
 * what is about to lapse, what was won but not yet billed, and how the recent
 * quotes went.
 *
 * - **Open is what customers can still say yes to.** Sent estimates within
 *   their valid-until date that nobody has accepted, declined or invoiced:
 *   their totals, tax included, since that is what the customer would be
 *   billed. An accepted estimate never lapses — its validity limited how long
 *   the customer had to accept — so it waits under "accepted, not yet
 *   invoiced" until someone converts it.
 * - **Recent figures follow one set of quotes.** The estimates issued in the
 *   last 90 days, by where each stands now: won (accepted, or converted to an
 *   invoice, which counts as accepted even when nobody marked it so), lost
 *   (declined, or past its valid-until date without an answer), or open. The
 *   acceptance rate is the share won of those decided; the undecided don't
 *   count against it.
 * - **Archived is filed away, not undone.** An archived estimate leaves what
 *   is open and what is waiting to be invoiced, but what its customer decided
 *   still counts in the recent figures. Drafts were never sent and a voided
 *   estimate was withdrawn, so neither counts anywhere.
 * - **One currency.** Estimates lock no exchange rate — they post nothing to
 *   the books — so one in another currency converts at the rate on file for
 *   its issue date, the rate an invoice issued that day would lock, or the
 *   latest rate when none is that old. A currency with no rate at all is left
 *   out and named rather than added at face value.
 * - **Days are the company's.** A valid-until or issue date is a calendar day
 *   (`shared/documentDays.ts`); today is the date on the company's clock. An
 *   estimate valid until the 24th can be accepted all of the 24th.
 *
 * Reads only, through the `(companyId, status)` index: the company's issued
 * estimates, never its drafts or voided ones.
 */

const UNCONVERTED = null;
type Rate = number | typeof UNCONVERTED;

type IssuedEstimate = Pick<
  Estimate,
  | "id"
  | "companyId"
  | "customerId"
  | "currency"
  | "issueDate"
  | "validUntil"
  | "status"
  | "totalCents"
  | "acceptedAt"
  | "invoiceId"
  | "archivedAt"
  | "number"
>;

/** Where an issued estimate stands on `today`. */
export function estimateOutcome(
  estimate: Pick<Estimate, "status" | "invoiceId" | "validUntil">,
  today: string,
): EstimateOutcome {
  if (estimate.invoiceId) return "invoiced";
  if (estimate.status === "accepted") return "accepted";
  if (estimate.status === "declined") return "declined";
  return documentDay(estimate.validUntil) < today ? "expired" : "open";
}

export async function estimateStats(
  companyId: string,
  now: Date = new Date(),
): Promise<EstimateStats> {
  const home = (await getReportingCurrency(companyId)).toUpperCase();
  const zone = await companyTimeZone(companyId);
  const today = dayOf(now, zone);
  const recentFrom = addDays(today, -(ESTIMATE_RECENT_DAYS - 1));

  const issued: IssuedEstimate[] = await AppDataSource.getRepository(Estimate).find({
    where: { companyId, status: In(["sent", "accepted", "declined"]) },
    select: [
      "id",
      "companyId",
      "customerId",
      "currency",
      "issueDate",
      "validUntil",
      "status",
      "totalCents",
      "acceptedAt",
      "invoiceId",
      "archivedAt",
      "number",
    ],
  });
  // Soonest valid-until first, so every list of ids reads most urgent first.
  issued.sort(
    (a, b) =>
      a.validUntil.getTime() - b.validUntil.getTime() ||
      a.number.localeCompare(b.number) ||
      a.id.localeCompare(b.id),
  );

  const rateFor = issueDayRates(companyId, home, now, issued);
  const leftOut = new LeftOut();
  const converted = new Set<string>();

  const open = emptyDocuments();
  const byCustomer = new Map<string, StatsDocuments>();
  const expiringSoon = emptyDocuments();
  let firstValidUntil: string | null = null;
  const acceptedNotInvoiced = emptyDocuments();
  let oldestDaysWaiting: number | null = null;
  const outcomes = new Map<EstimateOutcome, StatsDocuments>(
    ESTIMATE_OUTCOMES.map((outcome) => [outcome, emptyDocuments()]),
  );

  for (const estimate of issued) {
    const outcome = estimateOutcome(estimate, today);
    const filed = estimate.archivedAt !== null;
    const issueDay = documentDay(estimate.issueDate);
    // What is still in play — open, or won and waiting to be billed — leaves
    // with archiving. What a customer decided stays decided, so an archived
    // estimate still counts among the recent quotes unless it was left open.
    const inPlay = !filed && (outcome === "open" || outcome === "accepted");
    const recent =
      issueDay >= recentFrom && issueDay <= today && (!filed || outcome !== "open");
    if (!inPlay && !recent) continue;

    const code = currencyOf(estimate.currency, home);
    const rate = await rateFor(code, estimate.issueDate);
    if (rate === UNCONVERTED) {
      leftOut.add(code, estimate.id);
      continue;
    }
    if (code !== home) converted.add(code);
    const amount = convertAtRate(estimate.totalCents, rate);

    if (recent) addDocument(outcomes.get(outcome)!, estimate.id, amount);
    if (!inPlay) continue;
    if (outcome === "open") {
      addDocument(open, estimate.id, amount);
      const customer = byCustomer.get(estimate.customerId) ?? emptyDocuments();
      addDocument(customer, estimate.id, amount);
      byCustomer.set(estimate.customerId, customer);
      const validDay = documentDay(estimate.validUntil);
      if (daysBetween(today, validDay) <= ESTIMATE_EXPIRING_DAYS) {
        addDocument(expiringSoon, estimate.id, amount);
        // Sorted by valid-until, so the first one expiring is the soonest.
        firstValidUntil ??= validDay;
      }
    } else if (outcome === "accepted") {
      addDocument(acceptedNotInvoiced, estimate.id, amount);
      if (estimate.acceptedAt) {
        const waiting = Math.max(0, daysBetween(dayOf(estimate.acceptedAt, zone), today));
        if (oldestDaysWaiting === null || waiting > oldestDaysWaiting) oldestDaysWaiting = waiting;
      }
    }
  }

  const won = [outcomes.get("invoiced")!, outcomes.get("accepted")!];
  const lost = [outcomes.get("expired")!, outcomes.get("declined")!];
  const accepted = won.reduce((sum, group) => sum + group.count, 0);
  const lostCount = lost.reduce((sum, group) => sum + group.count, 0);

  return {
    currency: home,
    timeZone: clockName(zone),
    today,
    issuedEstimates: issued.length,
    open: { ...open, customers: byCustomer.size },
    expiringSoon: { ...expiringSoon, days: ESTIMATE_EXPIRING_DAYS, firstValidUntil },
    acceptedNotInvoiced: { ...acceptedNotInvoiced, oldestDaysWaiting },
    recent: {
      days: ESTIMATE_RECENT_DAYS,
      outcomes: ESTIMATE_OUTCOMES.map((outcome) => ({ outcome, ...outcomes.get(outcome)! })),
      acceptance: {
        accepted,
        decided: accepted + lostCount,
        ids: [...won, ...lost].flatMap((group) => group.ids),
      },
      lost: {
        count: lostCount,
        amountCents: lost.reduce((sum, group) => sum + group.amountCents, 0),
        ids: lost.flatMap((group) => group.ids),
        declined: outcomes.get("declined")!.count,
        expired: outcomes.get("expired")!.count,
      },
    },
    largestCustomer: await largestCustomer(companyId, byCustomer),
    converted: [...converted].sort(),
    unconverted: leftOut
      .list()
      .map(({ currency, documents }) => ({ currency, estimates: documents })),
  };
}

/**
 * The rate an estimate in another currency converts at: the one on file for
 * its issue date, or the latest when none is that old. Each currency's rates
 * are read once (`rateHistory`), however many days the estimates span.
 */
function issueDayRates(
  companyId: string,
  home: string,
  now: Date,
  estimates: IssuedEstimate[],
): (code: string, issueDate: Date) => Promise<Rate> {
  const latestAsked = estimates.reduce(
    (latest, estimate) => Math.max(latest, estimate.issueDate.getTime()),
    now.getTime(),
  );
  const histories = new Map<string, Promise<(date: Date) => number | null>>();
  return async (code, issueDate) => {
    if (code === home) return 1;
    let history = histories.get(code);
    if (!history) {
      history = rateHistory(companyId, code, home, new Date(latestAsked));
      histories.set(code, history);
    }
    const rateOn = await history;
    return rateOn(issueDate) ?? rateOn(now) ?? UNCONVERTED;
  };
}
