import { In } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { Account, AccountType } from "../db/entities/Account.js";
import { LedgerEntry, LedgerEntrySource } from "../db/entities/LedgerEntry.js";
import { LedgerLine } from "../db/entities/LedgerLine.js";
import { seedChartOfAccounts } from "./ledger.js";

/**
 * Reports service. Phase C of the Finance milestone (M19) — see
 * ROADMAP.md.
 *
 * Three primary reports plus an account-activity drill-through:
 *   - Income Statement (P&L): revenue minus expenses over a period.
 *   - Balance Sheet: assets / liabilities / equity as of a date,
 *     with current-period retained earnings derived (Phase F's
 *     period-close will roll P&L into the equity account properly).
 *   - Cash Flow: bucketed Bank account activity over a period.
 *
 * Conventions:
 *   - All cent columns sum debits/credits per account, then resolve
 *     to a *signed* balance using the account's normal-balance rule
 *     (asset/expense = debit-positive; the rest = credit-positive).
 *     Negative values mean "abnormal" balances (e.g. a credit-
 *     balance asset = overdrawn bank).
 *   - Date filters are inclusive on both ends, with the upper bound
 *     normalized to end-of-day-UTC so a date-only input doesn't
 *     accidentally exclude entries posted later that day.
 *   - Comparison columns are produced by computing the report twice
 *     with two date ranges and returning {current, prior}.
 */

// ────────────────────────── Date helpers ─────────────────────────────

/** Treat the date as inclusive through 23:59:59.999 UTC. */
function endOfDay(d: Date): Date {
  const out = new Date(d.getTime());
  out.setUTCHours(23, 59, 59, 999);
  return out;
}

/** Treat the date as inclusive from 00:00:00.000 UTC. */
function startOfDay(d: Date): Date {
  const out = new Date(d.getTime());
  out.setUTCHours(0, 0, 0, 0);
  return out;
}

// ────────────────────── Aggregation primitives ───────────────────────

type AccountTotals = Map<string, { debit: number; credit: number }>;

/**
 * Sum debits + credits per account for entries dated within
 * [from, to] inclusive (or all entries if from/to are null).
 *
 * One scan over all lines for the company, filtered by the entry-id
 * set we want — cheap on the volumes Phase C will see (single-tenant
 * SQLite, ~thousands of lines per company per year).
 */
async function aggregateLines(
  companyId: string,
  from: Date | null,
  to: Date | null,
): Promise<AccountTotals> {
  const entries = await AppDataSource.getRepository(LedgerEntry).find({
    where: { companyId },
    select: ["id", "date"],
  });
  const fromMs = from ? startOfDay(from).getTime() : -Infinity;
  const toMs = to ? endOfDay(to).getTime() : Infinity;
  const eligible = new Set(
    entries
      .filter((e) => {
        const t = e.date.getTime();
        return t >= fromMs && t <= toMs;
      })
      .map((e) => e.id),
  );
  const lines = await AppDataSource.getRepository(LedgerLine).find({
    where: { companyId },
  });
  const totals: AccountTotals = new Map();
  for (const l of lines) {
    if (!eligible.has(l.ledgerEntryId)) continue;
    const t = totals.get(l.accountId) ?? { debit: 0, credit: 0 };
    t.debit += l.debitCents;
    t.credit += l.creditCents;
    totals.set(l.accountId, t);
  }
  return totals;
}

/** Signed balance using the account's normal-balance side. */
function signedBalance(type: AccountType, debit: number, credit: number): number {
  const debitNormal = type === "asset" || type === "expense";
  return debitNormal ? debit - credit : credit - debit;
}

// ────────────────────────── Income Statement ─────────────────────────

export type ReportRow = {
  account: Pick<Account, "id" | "code" | "name" | "type">;
  amountCents: number;
};

export type IncomeStatementReport = {
  from: string;
  to: string;
  revenue: ReportRow[];
  totalRevenue: number;
  expenses: ReportRow[];
  totalExpenses: number;
  netIncome: number;
};

export async function incomeStatement(
  companyId: string,
  from: Date,
  to: Date,
): Promise<IncomeStatementReport> {
  const accounts = await seedChartOfAccounts(companyId);
  const totals = await aggregateLines(companyId, from, to);

  const revenue: ReportRow[] = [];
  const expenses: ReportRow[] = [];
  for (const a of accounts) {
    if (a.archivedAt) continue;
    const t = totals.get(a.id);
    if (!t) continue;
    const bal = signedBalance(a.type, t.debit, t.credit);
    if (bal === 0) continue;
    if (a.type === "revenue") {
      revenue.push({
        account: { id: a.id, code: a.code, name: a.name, type: a.type },
        amountCents: bal,
      });
    } else if (a.type === "expense") {
      expenses.push({
        account: { id: a.id, code: a.code, name: a.name, type: a.type },
        amountCents: bal,
      });
    }
  }
  revenue.sort((x, y) => x.account.code.localeCompare(y.account.code));
  expenses.sort((x, y) => x.account.code.localeCompare(y.account.code));
  const totalRevenue = revenue.reduce((s, r) => s + r.amountCents, 0);
  const totalExpenses = expenses.reduce((s, r) => s + r.amountCents, 0);
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    revenue,
    totalRevenue,
    expenses,
    totalExpenses,
    netIncome: totalRevenue - totalExpenses,
  };
}

// ────────────────────────── Balance Sheet ────────────────────────────

export type BalanceSheetReport = {
  asOf: string;
  assets: ReportRow[];
  totalAssets: number;
  liabilities: ReportRow[];
  totalLiabilities: number;
  equity: ReportRow[];
  /** Current-period earnings not yet closed to Retained Earnings.
   *  Surfaced as its own row in the equity section so the BS still
   *  balances before Phase F's period-close ships. */
  currentEarnings: number;
  totalEquity: number;
};

export async function balanceSheet(companyId: string, asOf: Date): Promise<BalanceSheetReport> {
  const accounts = await seedChartOfAccounts(companyId);
  const totals = await aggregateLines(companyId, null, asOf);

  const assets: ReportRow[] = [];
  const liabilities: ReportRow[] = [];
  const equity: ReportRow[] = [];
  let revenueTotal = 0;
  let expenseTotal = 0;

  for (const a of accounts) {
    if (a.archivedAt) continue;
    const t = totals.get(a.id);
    if (!t) continue;
    const bal = signedBalance(a.type, t.debit, t.credit);
    const row = {
      account: { id: a.id, code: a.code, name: a.name, type: a.type },
      amountCents: bal,
    };
    if (a.type === "asset" && bal !== 0) assets.push(row);
    else if (a.type === "liability" && bal !== 0) liabilities.push(row);
    else if (a.type === "equity" && bal !== 0) equity.push(row);
    else if (a.type === "revenue") revenueTotal += bal;
    else if (a.type === "expense") expenseTotal += bal;
  }
  assets.sort((x, y) => x.account.code.localeCompare(y.account.code));
  liabilities.sort((x, y) => x.account.code.localeCompare(y.account.code));
  equity.sort((x, y) => x.account.code.localeCompare(y.account.code));

  const currentEarnings = revenueTotal - expenseTotal;
  const totalAssets = assets.reduce((s, r) => s + r.amountCents, 0);
  const totalLiabilities = liabilities.reduce((s, r) => s + r.amountCents, 0);
  const totalEquity = equity.reduce((s, r) => s + r.amountCents, 0) + currentEarnings;
  return {
    asOf: asOf.toISOString(),
    assets,
    totalAssets,
    liabilities,
    totalLiabilities,
    equity,
    currentEarnings,
    totalEquity,
  };
}

// ────────────────────────── Cash Flow ────────────────────────────────

/**
 * Cash Flow buckets. Phase C maps the small set of sources we have
 * today (invoice_payment, invoice_void, manual) to the standard
 * three statement sections. Phase G (vendors) and Phase D
 * (reconciliation) will introduce richer mappings.
 */
export type CashFlowSection = {
  label: string;
  lines: { description: string; cents: number; entryId: string }[];
  total: number;
};

export type CashFlowReport = {
  from: string;
  to: string;
  openingBalance: number;
  operating: CashFlowSection;
  investing: CashFlowSection;
  financing: CashFlowSection;
  netChange: number;
  closingBalance: number;
};

const OPERATING: ReadonlySet<LedgerEntrySource> = new Set([
  "invoice_payment",
  "invoice_void",
  "manual",
  "brex_card_payment",
  // Every source below can move 1100 Bank. The bucketing further down is a
  // bare `OPERATING.has(entry.source) ? operating : investing` with no
  // financing branch, so ANY cash-touching source left out of this set
  // silently files real operating cash under Investing activities. Add new
  // bank-touching sources here at the same time you introduce them.
  "credit_note_issue",
  "credit_note_void",
  "customer_refund",
  "customer_refund_void",
]);

export async function cashFlow(companyId: string, from: Date, to: Date): Promise<CashFlowReport> {
  const accounts = await seedChartOfAccounts(companyId);
  const bank = accounts.find((a) => a.code === "1100");
  if (!bank) {
    // Defensive — `seedChartOfAccounts` plants 1100 every time. If it's
    // gone we'd rather report a zero report than crash the page.
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      openingBalance: 0,
      operating: { label: "Operating activities", lines: [], total: 0 },
      investing: { label: "Investing activities", lines: [], total: 0 },
      financing: { label: "Financing activities", lines: [], total: 0 },
      netChange: 0,
      closingBalance: 0,
    };
  }

  // Opening balance: bank net up to (but not including) `from`.
  const beforeFrom = new Date(startOfDay(from).getTime() - 1);
  const openingTotals = await aggregateLines(companyId, null, beforeFrom);
  const openingT = openingTotals.get(bank.id) ?? { debit: 0, credit: 0 };
  const openingBalance = openingT.debit - openingT.credit;

  // In-period entries that touch the bank.
  const fromMs = startOfDay(from).getTime();
  const toMs = endOfDay(to).getTime();
  const allEntries = await AppDataSource.getRepository(LedgerEntry).find({
    where: { companyId },
  });
  const periodEntries = allEntries.filter((e) => {
    const t = e.date.getTime();
    return t >= fromMs && t <= toMs;
  });
  const lines = await AppDataSource.getRepository(LedgerLine).find({
    where: {
      companyId,
      accountId: bank.id,
      ledgerEntryId: In(periodEntries.map((e) => e.id)),
    },
  });
  const entriesById = new Map(periodEntries.map((e) => [e.id, e]));

  const operating: CashFlowSection = {
    label: "Operating activities",
    lines: [],
    total: 0,
  };
  const investing: CashFlowSection = {
    label: "Investing activities",
    lines: [],
    total: 0,
  };
  const financing: CashFlowSection = {
    label: "Financing activities",
    lines: [],
    total: 0,
  };

  for (const l of lines) {
    const entry = entriesById.get(l.ledgerEntryId);
    if (!entry) continue;
    const cents = l.debitCents - l.creditCents; // + = cash in, − = cash out
    const description = entry.memo || l.description || "(no memo)";
    const target = OPERATING.has(entry.source) ? operating : investing;
    target.lines.push({ description, cents, entryId: entry.id });
    target.total += cents;
  }

  // Sort each section by largest absolute amount first so the most
  // material moves rise to the top.
  for (const sec of [operating, investing, financing]) {
    sec.lines.sort((a, b) => Math.abs(b.cents) - Math.abs(a.cents));
  }

  const netChange = operating.total + investing.total + financing.total;
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    openingBalance,
    operating,
    investing,
    financing,
    netChange,
    closingBalance: openingBalance + netChange,
  };
}

// ─────────────────────── Financial trend charts ──────────────────────

export type FinancialTrendPoint = {
  label: string;
  from: string;
  to: string;
  revenue: number;
  expenses: number;
  netIncome: number;
  assets: number;
  liabilities: number;
  equity: number;
  operatingCash: number;
  investingCash: number;
  financingCash: number;
  netCash: number;
  closingCash: number;
};

export type FinancialTrendsReport = {
  from: string;
  to: string;
  truncated: boolean;
  points: FinancialTrendPoint[];
};

/**
 * Build month-by-month chart data from the same signed-balance and cash-source
 * conventions used by the statement tables. Accounts, entries, and lines are
 * loaded once, rather than re-running three reports for every plotted month.
 * Custom ranges longer than 24 months show the most recent 24 points so labels
 * remain legible.
 */
export async function financialTrends(
  companyId: string,
  from: Date,
  to: Date,
): Promise<FinancialTrendsReport> {
  const start = startOfDay(from);
  const end = endOfDay(to);
  if (start.getTime() > end.getTime()) {
    throw new Error("from must be on or before to");
  }
  const months: Array<{ from: Date; to: Date; label: string }> = [];
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  while (cursor.getTime() <= end.getTime()) {
    const monthStart = new Date(cursor.getTime());
    const monthEnd = new Date(
      Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0, 23, 59, 59, 999),
    );
    months.push({
      from: new Date(Math.max(monthStart.getTime(), start.getTime())),
      to: new Date(Math.min(monthEnd.getTime(), end.getTime())),
      label: monthStart.toLocaleDateString("en", {
        month: "short",
        year: "2-digit",
        timeZone: "UTC",
      }),
    });
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  const visible = months.slice(-24);
  const [accounts, entries, lines] = await Promise.all([
    seedChartOfAccounts(companyId),
    AppDataSource.getRepository(LedgerEntry).find({ where: { companyId } }),
    AppDataSource.getRepository(LedgerLine).find({ where: { companyId } }),
  ]);
  const accountById = new Map(
    accounts.filter((account) => !account.archivedAt).map((account) => [account.id, account]),
  );
  const entryById = new Map(entries.map((entry) => [entry.id, entry]));
  const bank = accounts.find((account) => account.code === "1100");

  const points = visible.map((month) => {
    const fromMs = startOfDay(month.from).getTime();
    const toMs = endOfDay(month.to).getTime();
    let revenue = 0;
    let expenses = 0;
    let cumulativeRevenue = 0;
    let cumulativeExpenses = 0;
    let assets = 0;
    let liabilities = 0;
    let baseEquity = 0;
    let operatingCash = 0;
    let investingCash = 0;
    const financingCash = 0;
    let closingCash = 0;

    for (const line of lines) {
      const entry = entryById.get(line.ledgerEntryId);
      const account = accountById.get(line.accountId);
      if (!entry || !account || entry.date.getTime() > toMs) continue;
      const amount = signedBalance(account.type, line.debitCents, line.creditCents);
      if (account.type === "asset") assets += amount;
      else if (account.type === "liability") liabilities += amount;
      else if (account.type === "equity") baseEquity += amount;
      else if (account.type === "revenue") cumulativeRevenue += amount;
      else if (account.type === "expense") cumulativeExpenses += amount;

      if (bank && line.accountId === bank.id) {
        const cashAmount = line.debitCents - line.creditCents;
        closingCash += cashAmount;
        if (entry.date.getTime() >= fromMs) {
          if (OPERATING.has(entry.source)) operatingCash += cashAmount;
          else investingCash += cashAmount;
        }
      }
      if (entry.date.getTime() < fromMs) continue;
      if (account.type === "revenue") revenue += amount;
      else if (account.type === "expense") expenses += amount;
    }

    const netIncome = revenue - expenses;
    const equity = baseEquity + cumulativeRevenue - cumulativeExpenses;
    const netCash = operatingCash + investingCash + financingCash;
    return {
      label: month.label,
      from: month.from.toISOString(),
      to: month.to.toISOString(),
      revenue,
      expenses,
      netIncome,
      assets,
      liabilities,
      equity,
      operatingCash,
      investingCash,
      financingCash,
      netCash,
      closingCash,
    } satisfies FinancialTrendPoint;
  });
  return {
    from: start.toISOString(),
    to: end.toISOString(),
    truncated: months.length > visible.length,
    points,
  };
}

// ─────────────────── Account activity (drill-through) ────────────────

export type AccountActivityRow = {
  entryId: string;
  date: string;
  source: LedgerEntrySource;
  memo: string;
  description: string;
  debitCents: number;
  creditCents: number;
  /** Running balance after this row, signed by the account's
   *  normal-balance rule (debit-normal positive for asset/expense). */
  runningBalanceCents: number;
};

export type AccountActivityReport = {
  account: Pick<Account, "id" | "code" | "name" | "type">;
  from: string | null;
  to: string | null;
  openingBalance: number;
  rows: AccountActivityRow[];
  closingBalance: number;
};

export async function accountActivity(
  companyId: string,
  accountId: string,
  from: Date | null,
  to: Date | null,
): Promise<AccountActivityReport | null> {
  const account = await AppDataSource.getRepository(Account).findOneBy({
    id: accountId,
    companyId,
  });
  if (!account) return null;

  // Opening: everything before `from`.
  const opening = from
    ? signedFromTotals(
        account.type,
        await aggregateLines(companyId, null, new Date(startOfDay(from).getTime() - 1)),
        accountId,
      )
    : 0;

  // In-period rows for this account, sorted by entry date.
  const entries = await AppDataSource.getRepository(LedgerEntry).find({
    where: { companyId },
  });
  const fromMs = from ? startOfDay(from).getTime() : -Infinity;
  const toMs = to ? endOfDay(to).getTime() : Infinity;
  const eligible = entries.filter((e) => e.date.getTime() >= fromMs && e.date.getTime() <= toMs);
  eligible.sort((a, b) => a.date.getTime() - b.date.getTime());
  const eligibleIds = eligible.map((e) => e.id);
  const lines = eligibleIds.length
    ? await AppDataSource.getRepository(LedgerLine).find({
        where: {
          companyId,
          accountId,
          ledgerEntryId: In(eligibleIds),
        },
      })
    : [];
  const linesByEntry = new Map<string, LedgerLine[]>();
  for (const l of lines) {
    const arr = linesByEntry.get(l.ledgerEntryId) ?? [];
    arr.push(l);
    linesByEntry.set(l.ledgerEntryId, arr);
  }

  const rows: AccountActivityRow[] = [];
  let running = opening;
  for (const entry of eligible) {
    const entryLines = linesByEntry.get(entry.id) ?? [];
    for (const l of entryLines) {
      const debitNormal = account.type === "asset" || account.type === "expense";
      const delta = debitNormal ? l.debitCents - l.creditCents : l.creditCents - l.debitCents;
      running += delta;
      rows.push({
        entryId: entry.id,
        date: entry.date.toISOString(),
        source: entry.source,
        memo: entry.memo,
        description: l.description,
        debitCents: l.debitCents,
        creditCents: l.creditCents,
        runningBalanceCents: running,
      });
    }
  }

  return {
    account: {
      id: account.id,
      code: account.code,
      name: account.name,
      type: account.type,
    },
    from: from ? from.toISOString() : null,
    to: to ? to.toISOString() : null,
    openingBalance: opening,
    rows,
    closingBalance: running,
  };
}

function signedFromTotals(type: AccountType, totals: AccountTotals, accountId: string): number {
  const t = totals.get(accountId);
  if (!t) return 0;
  return signedBalance(type, t.debit, t.credit);
}
