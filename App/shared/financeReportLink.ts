/**
 * A link that opens Finance → Reports on one report for one span of dates.
 *
 * The server writes it — a letter to the board links each money figure to the
 * report it was read from — and the Reports page reads it, so both sides share
 * this one definition of its shape rather than agreeing on it by convention.
 * Dates are calendar dates (`YYYY-MM-DD`), the way the ledger and the reports
 * already filter.
 */

export const FINANCE_REPORT_TABS = ["income", "balance", "cashflow"] as const;

export type FinanceReportTab = (typeof FINANCE_REPORT_TABS)[number];

export type FinanceReportLink = { report: FinanceReportTab; from: string; to: string };

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isCalendarDate(value: string): boolean {
  if (!CALENDAR_DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** The path, under `/c/<slug>`, of `report` for `from` … `to`. */
export function financeReportHref(report: FinanceReportTab, from: string, to: string): string {
  return `/finance/reports?${new URLSearchParams({ report, from, to }).toString()}`;
}

/** The report a link asks for, or null when it asks for nothing valid. */
export function parseFinanceReportLink(search: URLSearchParams | string): FinanceReportLink | null {
  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  const report = params.get("report");
  const from = params.get("from") ?? "";
  const to = params.get("to") ?? "";
  if (!FINANCE_REPORT_TABS.some((tab) => tab === report)) return null;
  if (!isCalendarDate(from) || !isCalendarDate(to) || from > to) return null;
  return { report: report as FinanceReportTab, from, to };
}
