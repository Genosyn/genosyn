import { In } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { Account, AccountType } from "../db/entities/Account.js";
import { AccountingPeriod } from "../db/entities/AccountingPeriod.js";
import {
  LedgerEntry,
  LedgerEntrySource,
} from "../db/entities/LedgerEntry.js";
import { LedgerLine } from "../db/entities/LedgerLine.js";

/**
 * Ledger service. Phase B of the Finance milestone (M19) — see
 * ROADMAP.md.
 *
 * Three responsibilities:
 *   1. Seed the default chart of accounts on first use (idempotent).
 *   2. Post balanced double-entry transactions, with a service-layer
 *      check that `sum(debits) === sum(credits)` so callers can't
 *      poison the books even by accident.
 *   3. Reverse all entries written by a given source, used when an
 *      invoice is voided so the AR / Revenue / Tax Payable / Bank
 *      accounts unwind atomically.
 *
 * The ledger is the *system of record* once entries land. There is no
 * "edit a posted entry" — accountants delete and re-post, leaving
 * both rows in the audit trail. Only `manual` entries can be deleted
 * through the API; auto-posted entries are immutable and only get
 * cleared by the void-reversal flow.
 */

// ──────────────────────── Default chart of accounts ───────────────────

/**
 * Sane starter CoA for a small business. Auto-post hooks look these
 * codes up by name (`1100`, `1200`, `2100`, `4000`) so renaming is
 * fine but **deletion is blocked** at the route layer.
 *
 * Phase G (vendor side) will add `2200 Accounts Payable` and
 * `5000 Cost of Goods Sold` to the auto-post path.
 */
export const SYSTEM_ACCOUNTS: ReadonlyArray<{
  code: string;
  name: string;
  type: AccountType;
}> = [
  { code: "1100", name: "Bank", type: "asset" },
  { code: "1200", name: "Accounts Receivable", type: "asset" },
  { code: "2100", name: "Tax Payable", type: "liability" },
  { code: "2200", name: "Accounts Payable", type: "liability" },
  { code: "3000", name: "Owner's Equity", type: "equity" },
  { code: "3100", name: "Retained Earnings", type: "equity" },
  { code: "4000", name: "Sales Revenue", type: "revenue" },
  { code: "4900", name: "Other Income", type: "revenue" },
  { code: "5000", name: "Cost of Goods Sold", type: "expense" },
  { code: "6000", name: "General & Administrative", type: "expense" },
];

/**
 * Insert any system accounts that aren't already present for this
 * company. Safe to call on every ledger pageview — it's a single
 * SELECT plus zero-or-more inserts. Returns the freshly listed CoA.
 */
export async function seedChartOfAccounts(companyId: string): Promise<Account[]> {
  const repo = AppDataSource.getRepository(Account);
  const existing = await repo.find({
    where: { companyId },
    select: ["code"],
  });
  const have = new Set(existing.map((a) => a.code));
  const missing = SYSTEM_ACCOUNTS.filter((a) => !have.has(a.code));
  if (missing.length > 0) {
    await repo.save(
      missing.map((a) =>
        repo.create({
          companyId,
          code: a.code,
          name: a.name,
          type: a.type,
          isSystem: true,
        }),
      ),
    );
  }
  return repo.find({
    where: { companyId },
    order: { code: "ASC" },
  });
}

export async function accountByCode(
  companyId: string,
  code: string,
): Promise<Account | null> {
  return AppDataSource.getRepository(Account).findOneBy({ companyId, code });
}

/**
 * Look up several accounts at once and return a `code → Account` map.
 * Throws if any of the requested codes is missing — the caller (auto-
 * post code paths) needs all-or-nothing semantics so an invoice issue
 * doesn't half-post.
 */
export async function requireAccountsByCode(
  companyId: string,
  codes: ReadonlyArray<string>,
): Promise<Map<string, Account>> {
  // Make sure the system accounts exist before resolving — auto-post
  // can't proceed if the user has never touched the ledger UI but is
  // issuing their first invoice.
  await seedChartOfAccounts(companyId);
  const accounts = await AppDataSource.getRepository(Account).find({
    where: { companyId, code: In([...codes]) },
  });
  const byCode = new Map(accounts.map((a) => [a.code, a]));
  for (const c of codes) {
    if (!byCode.has(c)) {
      throw new Error(`Required account ${c} is missing — restore the system chart of accounts`);
    }
  }
  return byCode;
}

// ──────────────────────────── Posting ─────────────────────────────────

export type LedgerLineDraft = {
  accountId: string;
  debitCents?: number;
  creditCents?: number;
  description?: string;
  /** Multi-currency audit (Phase E). When the source transaction was
   *  in a foreign currency, set these so the line records the original
   *  picture. Defaults: empty / 0 / 0 = no conversion. */
  origCurrency?: string;
  origAmountCents?: number;
  rate?: number;
};

export type PostLedgerEntryInput = {
  companyId: string;
  date: Date;
  memo?: string;
  source?: LedgerEntrySource;
  sourceRefId?: string | null;
  createdById?: string | null;
  lines: LedgerLineDraft[];
};

/**
 * Post a balanced double-entry transaction. Validates:
 *   - At least 2 lines.
 *   - Each line has exactly one of debit / credit (the other is 0).
 *   - All amounts are non-negative integers.
 *   - All accounts belong to this company and are not archived.
 *   - sum(debits) === sum(credits).
 *
 * Returns the persisted entry + lines. Saves are not transactional in
 * sqlite mode (better-sqlite3 + TypeORM doesn't expose a clean
 * unit-of-work seam) — if the line save fails, the entry row is
 * left orphaned. We tolerate that for Phase B; Phase F's accountant
 * exports filter on `EXISTS (SELECT FROM ledger_lines WHERE ...)` to
 * skip orphans cleanly.
 */
export async function postLedgerEntry(
  input: PostLedgerEntryInput,
): Promise<{ entry: LedgerEntry; lines: LedgerLine[] }> {
  if (input.lines.length < 2) {
    throw new Error("A ledger entry needs at least two lines");
  }
  let totalDebit = 0;
  let totalCredit = 0;
  for (const l of input.lines) {
    const d = l.debitCents ?? 0;
    const c = l.creditCents ?? 0;
    if (!Number.isInteger(d) || !Number.isInteger(c) || d < 0 || c < 0) {
      throw new Error("Line amounts must be non-negative integers");
    }
    if ((d > 0 && c > 0) || (d === 0 && c === 0)) {
      throw new Error("Each line must have exactly one of debit or credit set");
    }
    totalDebit += d;
    totalCredit += c;
  }
  if (totalDebit !== totalCredit) {
    throw new Error(
      `Entry is unbalanced: debits ${totalDebit} ≠ credits ${totalCredit}`,
    );
  }
  // Phase F: refuse to post inside a closed `AccountingPeriod` so
  // accountants can rely on closed-period numbers staying frozen. The
  // closePeriod routine itself sets `sourceRefId` to the period id;
  // we let that one through (it's posting *into* the period it's
  // about to close, ahead of flipping status).
  const closed = await findClosedPeriodCovering(input.companyId, input.date);
  if (closed && closed.id !== input.sourceRefId) {
    throw new Error(
      `Cannot post into closed period "${closed.name}" (${closed.startDate
        .toISOString()
        .slice(0, 10)} – ${closed.endDate.toISOString().slice(0, 10)})`,
    );
  }
  // Validate accounts. One IN query, then check membership + company +
  // archived state. Cheaper than N FK lookups.
  const accountIds = [...new Set(input.lines.map((l) => l.accountId))];
  const accounts = await AppDataSource.getRepository(Account).find({
    where: { id: In(accountIds), companyId: input.companyId },
  });
  if (accounts.length !== accountIds.length) {
    throw new Error("One or more accounts are missing or belong to another company");
  }
  if (accounts.some((a) => a.archivedAt)) {
    throw new Error("Cannot post to an archived account");
  }

  const entryRepo = AppDataSource.getRepository(LedgerEntry);
  const entry = await entryRepo.save(
    entryRepo.create({
      companyId: input.companyId,
      date: input.date,
      memo: input.memo ?? "",
      source: input.source ?? "manual",
      sourceRefId: input.sourceRefId ?? null,
      createdById: input.createdById ?? null,
    }),
  );

  const lineRepo = AppDataSource.getRepository(LedgerLine);
  const lines = await lineRepo.save(
    input.lines.map((l, i) =>
      lineRepo.create({
        ledgerEntryId: entry.id,
        companyId: input.companyId,
        accountId: l.accountId,
        debitCents: l.debitCents ?? 0,
        creditCents: l.creditCents ?? 0,
        description: l.description ?? "",
        sortOrder: i,
        origCurrency: l.origCurrency ?? "",
        origAmountCents: l.origAmountCents ?? 0,
        rate: l.rate ?? 0,
      }),
    ),
  );
  return { entry, lines };
}

// ────────────────────── Idempotency + reversal ─────────────────────────

/**
 * Has an entry with this `(source, sourceRefId)` been posted? Used by
 * the invoice auto-post hooks before they post — keeps re-issuing,
 * re-paying, or rerunning the void path from double-counting the books.
 */
export async function hasEntryFor(
  companyId: string,
  source: LedgerEntrySource,
  sourceRefId: string,
): Promise<boolean> {
  const count = await AppDataSource.getRepository(LedgerEntry).count({
    where: { companyId, source, sourceRefId },
  });
  return count > 0;
}

/**
 * Reverse every entry tied to `(source, sourceRefId)` by writing a new
 * entry per original with debits and credits swapped. Original entries
 * are kept (audit trail) — accountants want to see the issue *and* the
 * void, not lose the original.
 *
 * Returns the count of entries reversed. Idempotent: if the source has
 * already been reversed (an entry with `source=reverseAs` exists), the
 * function returns 0 without writing anything new.
 */
export async function reverseLedgerEntriesForSources(args: {
  companyId: string;
  sources: ReadonlyArray<LedgerEntrySource>;
  sourceRefIds: ReadonlyArray<string>;
  reverseAs: LedgerEntrySource;
  reverseRefId: string;
  date: Date;
  memo: string;
  createdById: string | null;
}): Promise<number> {
  if (args.sourceRefIds.length === 0) return 0;
  const entries = await AppDataSource.getRepository(LedgerEntry).find({
    where: {
      companyId: args.companyId,
      source: In([...args.sources]),
      sourceRefId: In([...args.sourceRefIds]),
    },
  });
  if (entries.length === 0) return 0;

  // Idempotency: don't reverse twice for the same `reverseRefId`.
  const alreadyReversed = await AppDataSource.getRepository(LedgerEntry).count({
    where: {
      companyId: args.companyId,
      source: args.reverseAs,
      sourceRefId: args.reverseRefId,
    },
  });
  if (alreadyReversed > 0) return 0;

  const allLines = await AppDataSource.getRepository(LedgerLine).find({
    where: { ledgerEntryId: In(entries.map((e) => e.id)) },
    order: { sortOrder: "ASC" },
  });
  const linesByEntry = new Map<string, LedgerLine[]>();
  for (const l of allLines) {
    const arr = linesByEntry.get(l.ledgerEntryId) ?? [];
    arr.push(l);
    linesByEntry.set(l.ledgerEntryId, arr);
  }

  let reversed = 0;
  for (const orig of entries) {
    const origLines = linesByEntry.get(orig.id) ?? [];
    if (origLines.length === 0) continue;
    await postLedgerEntry({
      companyId: args.companyId,
      date: args.date,
      memo: `${args.memo} (reverses ${orig.id.slice(0, 8)})`,
      source: args.reverseAs,
      sourceRefId: args.reverseRefId,
      createdById: args.createdById,
      lines: origLines.map((l) => ({
        accountId: l.accountId,
        debitCents: l.creditCents,
        creditCents: l.debitCents,
        description: l.description ? `Reversal: ${l.description}` : "",
      })),
    });
    reversed += 1;
  }
  return reversed;
}

// ────────────────────────── Trial balance ──────────────────────────────

export type TrialBalanceRow = {
  account: Pick<Account, "id" | "code" | "name" | "type">;
  debitCents: number;
  creditCents: number;
  balanceCents: number;
};

/**
 * Sum every ledger line up through `asOf` (inclusive), grouped by
 * account. The "balance" column is debit-positive for asset/expense
 * accounts and credit-positive for liability/equity/revenue, matching
 * the conventional trial-balance presentation.
 *
 * Asset/expense balance = debits − credits.
 * Liability/equity/revenue balance = credits − debits.
 *
 * Phase C (reports) builds Income Statement and Balance Sheet on top of
 * this; Phase D's reconciliation page reads the Bank account's balance
 * and compares to the bank feed.
 */
export async function trialBalance(
  companyId: string,
  asOf: Date,
): Promise<TrialBalanceRow[]> {
  const accounts = await seedChartOfAccounts(companyId);
  // Treat the asOf as inclusive through end-of-day. A date-only input
  // ("2026-05-04") parses as midnight UTC otherwise, which would
  // exclude entries posted later in the same day.
  const cutoff = new Date(asOf.getTime());
  cutoff.setUTCHours(23, 59, 59, 999);
  const entries = await AppDataSource.getRepository(LedgerEntry).find({
    where: { companyId },
    select: ["id", "date"],
  });
  const eligibleEntryIds = new Set(
    entries.filter((e) => e.date.getTime() <= cutoff.getTime()).map((e) => e.id),
  );
  const lines = await AppDataSource.getRepository(LedgerLine).find({
    where: { companyId },
  });
  const totals = new Map<string, { d: number; c: number }>();
  for (const l of lines) {
    if (!eligibleEntryIds.has(l.ledgerEntryId)) continue;
    const t = totals.get(l.accountId) ?? { d: 0, c: 0 };
    t.d += l.debitCents;
    t.c += l.creditCents;
    totals.set(l.accountId, t);
  }
  return accounts
    .filter((a) => !a.archivedAt)
    .map((a) => {
      const t = totals.get(a.id) ?? { d: 0, c: 0 };
      const debitNormal = a.type === "asset" || a.type === "expense";
      const balance = debitNormal ? t.d - t.c : t.c - t.d;
      return {
        account: { id: a.id, code: a.code, name: a.name, type: a.type },
        debitCents: t.d,
        creditCents: t.c,
        balanceCents: balance,
      };
    });
}

/**
 * Local lookup so ledger.ts doesn't have to import periods.ts (which
 * imports back into ledger.ts for `postLedgerEntry`). One small
 * duplication beats a circular dep.
 */
async function findClosedPeriodCovering(
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
