import { AppDataSource } from "../db/datasource.js";
import { AccountingPeriod } from "../db/entities/AccountingPeriod.js";
import { Account } from "../db/entities/Account.js";
import { LedgerEntry } from "../db/entities/LedgerEntry.js";
import { LedgerLine } from "../db/entities/LedgerLine.js";
import { postLedgerEntry, requireAccountsByCode } from "./ledger.js";

/**
 * Period close + period-lock service. Phase F of the Finance milestone
 * (M19) — see ROADMAP.md.
 *
 * Closing a period rolls every revenue and expense balance for the
 * period (and all earlier closed periods) into 3100 Retained Earnings,
 * then locks the window so no new entries can post inside it.
 */

/**
 * Returns the closed period (if any) that covers `date`. Used by
 * `postLedgerEntry` to reject writes that would land in a locked
 * window. Walks the per-company list in memory — companies have a
 * handful of periods at most.
 */
export async function findClosedPeriodCovering(
  companyId: string,
  date: Date,
): Promise<AccountingPeriod | null> {
  const periods = await AppDataSource.getRepository(AccountingPeriod).find({
    where: { companyId, status: "closed" },
  });
  const t = date.getTime();
  return (
    periods.find(
      (p) => p.startDate.getTime() <= t && p.endDate.getTime() >= t,
    ) ?? null
  );
}

/**
 * Aggregate revenue and expense net balances inside the window. Used
 * by the close routine to mint a single closing journal entry that
 * zeroes them into 3100 Retained Earnings.
 *
 * Returns the rows the closing entry needs:
 *   - For revenue accounts (credit-normal), sum(credit) - sum(debit) > 0
 *     means a credit balance we now DEBIT to clear.
 *   - For expense accounts (debit-normal), sum(debit) - sum(credit) > 0
 *     means a debit balance we now CREDIT to clear.
 *   - Net (revenue net minus expense net) is the offsetting credit
 *     (profit) or debit (loss) to Retained Earnings.
 */
async function aggregatePnLForPeriod(
  companyId: string,
  startDate: Date,
  endDate: Date,
): Promise<{
  byAccount: Map<string, { type: "revenue" | "expense"; balance: number }>;
  netIncome: number;
}> {
  const accounts = await AppDataSource.getRepository(Account).find({
    where: { companyId },
  });
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const entries = await AppDataSource.getRepository(LedgerEntry).find({
    where: { companyId },
    select: ["id", "date"],
  });
  const eligibleIds = new Set(
    entries
      .filter(
        (e) =>
          e.date.getTime() >= startDate.getTime() &&
          e.date.getTime() <= endDate.getTime(),
      )
      .map((e) => e.id),
  );
  const lines = await AppDataSource.getRepository(LedgerLine).find({
    where: { companyId },
  });
  const totals = new Map<string, { d: number; c: number }>();
  for (const l of lines) {
    if (!eligibleIds.has(l.ledgerEntryId)) continue;
    const t = totals.get(l.accountId) ?? { d: 0, c: 0 };
    t.d += l.debitCents;
    t.c += l.creditCents;
    totals.set(l.accountId, t);
  }
  const byAccount = new Map<
    string,
    { type: "revenue" | "expense"; balance: number }
  >();
  let revenueNet = 0;
  let expenseNet = 0;
  for (const [accountId, t] of totals) {
    const a = accountById.get(accountId);
    if (!a) continue;
    if (a.type === "revenue") {
      const balance = t.c - t.d; // positive = credit-normal balance
      if (balance !== 0) byAccount.set(accountId, { type: "revenue", balance });
      revenueNet += balance;
    } else if (a.type === "expense") {
      const balance = t.d - t.c; // positive = debit-normal balance
      if (balance !== 0) byAccount.set(accountId, { type: "expense", balance });
      expenseNet += balance;
    }
  }
  return { byAccount, netIncome: revenueNet - expenseNet };
}

/**
 * Close `period`, rolling P&L into Retained Earnings and locking the
 * window. Idempotent — calling close on an already-closed period
 * returns it unchanged.
 *
 * The closing entry is dated on the period's `endDate` so trial-balance
 * snapshots that include the closing date see the cleared revenue /
 * expense state.
 */
export async function closePeriod(
  period: AccountingPeriod,
  actorUserId: string | null,
): Promise<AccountingPeriod> {
  if (period.status === "closed") return period;
  const accounts = await requireAccountsByCode(period.companyId, ["3100"]);
  const re = accounts.get("3100")!;
  const { byAccount, netIncome } = await aggregatePnLForPeriod(
    period.companyId,
    period.startDate,
    period.endDate,
  );

  // Build the closing entry: zero each P&L account by posting the
  // opposite side; balance the entry against Retained Earnings.
  const lines: Array<{
    accountId: string;
    debitCents?: number;
    creditCents?: number;
    description?: string;
  }> = [];
  for (const [accountId, info] of byAccount) {
    if (info.balance === 0) continue;
    if (info.type === "revenue") {
      lines.push({
        accountId,
        debitCents: info.balance,
        description: `Close ${period.name}`,
      });
    } else {
      lines.push({
        accountId,
        creditCents: info.balance,
        description: `Close ${period.name}`,
      });
    }
  }
  if (netIncome !== 0) {
    if (netIncome > 0) {
      lines.push({
        accountId: re.id,
        creditCents: netIncome,
        description: `Net income — ${period.name}`,
      });
    } else {
      lines.push({
        accountId: re.id,
        debitCents: -netIncome,
        description: `Net loss — ${period.name}`,
      });
    }
  }

  let closingEntryId: string | null = null;
  if (lines.length >= 2) {
    const result = await postLedgerEntry({
      companyId: period.companyId,
      date: period.endDate,
      memo: `Close ${period.name}`,
      // Tag the closing entry with `manual` source so the period-lock
      // check that runs inside `postLedgerEntry` doesn't reject our
      // own close. We also pre-mark the period as closed only AFTER
      // the entry lands.
      source: "manual",
      sourceRefId: period.id,
      createdById: actorUserId,
      lines,
    });
    closingEntryId = result.entry.id;
  }

  period.status = "closed";
  period.closedAt = new Date();
  period.closedById = actorUserId;
  period.closingEntryId = closingEntryId;
  return AppDataSource.getRepository(AccountingPeriod).save(period);
}

/**
 * Re-open a closed period. Removes the closing entry so subsequent
 * P&L reports through the period reflect their original detail.
 */
export async function reopenPeriod(
  period: AccountingPeriod,
): Promise<AccountingPeriod> {
  if (period.status === "open") return period;
  if (period.closingEntryId) {
    await AppDataSource.getRepository(LedgerLine).delete({
      ledgerEntryId: period.closingEntryId,
    });
    await AppDataSource.getRepository(LedgerEntry).delete({
      id: period.closingEntryId,
    });
  }
  period.status = "open";
  period.closedAt = null;
  period.closedById = null;
  period.closingEntryId = null;
  return AppDataSource.getRepository(AccountingPeriod).save(period);
}
