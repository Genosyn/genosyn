import { In, Not } from "typeorm";
import { z } from "zod";
import { AppDataSource } from "../db/datasource.js";
import { Account } from "../db/entities/Account.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import {
  LedgerEntry,
  type LedgerEntrySource,
  type LedgerReviewStatus,
} from "../db/entities/LedgerEntry.js";
import { LedgerLine } from "../db/entities/LedgerLine.js";
import {
  ENTRY_CATEGORY_LOCK_REASON,
  type EntryCategoryLock,
  entryCategoryLockBySource,
  reversalKey,
} from "../../shared/entryCategory.js";
import { withIndefiniteArticle } from "../../shared/indefiniteArticle.js";
import { findClosedPeriodCovering, postLedgerEntry } from "./ledger.js";
import { andWhereTokens, tokenizeQuery } from "./likeSearch.js";
import {
  andWhereDateRange,
  asText,
  type DateRange,
  dateRange,
  decodeCursor,
  filterFingerprint,
  finishPage,
  type KeysetColumn,
  keysetRows,
  ListQueryError,
  type PageInfo,
  type PageLimits,
  pageLimit,
  pageQueryShape,
  type PageRequest,
} from "./listPaging.js";

export type LedgerReviewChange = {
  lineId: string;
  fromAccountId: string;
  toAccountId: string;
};

export type LedgerReviewChangeInput = {
  lineId: string;
  accountId: string;
};

export type HydratedLedgerEntry = LedgerEntry & {
  lines: LedgerLine[];
  totalCents: number;
  reviewChanges: LedgerReviewChange[];
  reviewedByEmployee: {
    id: string;
    name: string;
    slug: string;
  } | null;
  /** Why its categories can't be changed here, or null when they can. */
  categoryLock: EntryCategoryLock | null;
};

/**
 * What keeps Entry review from changing each entry's categories, if anything
 * (`shared/entryCategory.ts`): what posted the entry, or a reversal of it
 * posted since.
 */
async function categoryLocks(
  entries: ReadonlyArray<Pick<LedgerEntry, "id" | "companyId" | "source" | "sourceRefId">>,
): Promise<Map<string, EntryCategoryLock>> {
  const locks = new Map<string, EntryCategoryLock>();
  const keyOf = (companyId: string, source: string, sourceRefId: string | null) =>
    JSON.stringify([companyId, source, sourceRefId]);
  const awaitingReversal = new Map<string, string[]>();
  const sources = new Set<string>();
  const refs = new Set<string>();
  for (const entry of entries) {
    const lock = entryCategoryLockBySource(entry);
    if (lock) {
      locks.set(entry.id, lock);
      continue;
    }
    const reversal = reversalKey(entry);
    if (!reversal) continue;
    const key = keyOf(entry.companyId, reversal.source, reversal.sourceRefId);
    awaitingReversal.set(key, [...(awaitingReversal.get(key) ?? []), entry.id]);
    sources.add(reversal.source);
    refs.add(reversal.sourceRefId);
  }
  if (awaitingReversal.size === 0) return locks;
  const reversals = await AppDataSource.getRepository(LedgerEntry).find({
    where: {
      companyId: In([...new Set(entries.map((entry) => entry.companyId))]),
      source: In([...sources] as LedgerEntrySource[]),
      sourceRefId: In([...refs]),
    },
    select: ["companyId", "source", "sourceRefId"],
  });
  for (const reversal of reversals) {
    const key = keyOf(reversal.companyId, reversal.source, reversal.sourceRefId);
    for (const entryId of awaitingReversal.get(key) ?? []) locks.set(entryId, "reversed");
  }
  return locks;
}

function parseReviewChanges(raw: string | null): LedgerReviewChange[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (change): change is LedgerReviewChange =>
        !!change &&
        typeof change === "object" &&
        typeof (change as LedgerReviewChange).lineId === "string" &&
        typeof (change as LedgerReviewChange).fromAccountId === "string" &&
        typeof (change as LedgerReviewChange).toAccountId === "string",
    );
  } catch {
    return [];
  }
}

export async function hydrateLedgerEntries(entries: LedgerEntry[]): Promise<HydratedLedgerEntry[]> {
  if (entries.length === 0) return [];
  const reviewerIds = [
    ...new Set(
      entries.map((entry) => entry.reviewedByEmployeeId).filter((id): id is string => !!id),
    ),
  ];
  const [lines, reviewers, locks] = await Promise.all([
    AppDataSource.getRepository(LedgerLine).find({
      where: { ledgerEntryId: In(entries.map((entry) => entry.id)) },
      order: { sortOrder: "ASC" },
    }),
    reviewerIds.length
      ? AppDataSource.getRepository(AIEmployee).find({
          where: { id: In(reviewerIds) },
          select: ["id", "name", "slug"],
        })
      : Promise.resolve([]),
    categoryLocks(entries),
  ]);
  const byEntry = new Map<string, LedgerLine[]>();
  for (const line of lines) {
    const existing = byEntry.get(line.ledgerEntryId) ?? [];
    existing.push(line);
    byEntry.set(line.ledgerEntryId, existing);
  }
  const reviewerById = new Map(reviewers.map((reviewer) => [reviewer.id, reviewer]));
  return entries.map((entry) => {
    const entryLines = byEntry.get(entry.id) ?? [];
    const reviewer = entry.reviewedByEmployeeId
      ? reviewerById.get(entry.reviewedByEmployeeId)
      : null;
    return {
      ...entry,
      lines: entryLines,
      totalCents: entryLines.reduce((sum, line) => sum + line.debitCents, 0),
      reviewChanges: parseReviewChanges(entry.reviewChangesJson),
      reviewedByEmployee: reviewer
        ? { id: reviewer.id, name: reviewer.name, slug: reviewer.slug }
        : null,
      categoryLock: locks.get(entry.id) ?? null,
    };
  });
}

export async function listLedgerEntriesForReview(args: {
  companyId: string;
  reviewStatus?: LedgerReviewStatus;
  source?: string;
  from?: Date;
  to?: Date;
  limit?: number;
}): Promise<HydratedLedgerEntry[]> {
  const qb = AppDataSource.getRepository(LedgerEntry)
    .createQueryBuilder("entry")
    .where("entry.companyId = :companyId", { companyId: args.companyId })
    .andWhere("entry.source != :reviewReclassSource", {
      reviewReclassSource: "ledger_reclass",
    })
    .orderBy("entry.date", "DESC")
    .addOrderBy("entry.createdAt", "DESC")
    .take(Math.min(Math.max(args.limit ?? 200, 1), 500));
  if (args.reviewStatus) {
    qb.andWhere("entry.reviewStatus = :reviewStatus", {
      reviewStatus: args.reviewStatus,
    });
  }
  if (args.source) qb.andWhere("entry.source = :source", { source: args.source });
  if (args.from) qb.andWhere("entry.date >= :from", { from: args.from });
  if (args.to) {
    const through = new Date(args.to.getTime());
    through.setUTCHours(23, 59, 59, 999);
    qb.andWhere("entry.date <= :to", { to: through });
  }
  return hydrateLedgerEntries(await qb.getMany());
}

/** 50 entries by default, at most 200 at once. */
export const LEDGER_REVIEW_PAGE: PageLimits = { defaultLimit: 50, maxLimit: 200 };

/** What narrows Entry review's list. Every field is optional and they combine. */
export type LedgerReviewFilter = {
  reviewStatus?: LedgerReviewStatus;
  /** What posted the entry: `manual`, `bank_categorization`, `brex_card_expense`, … */
  source?: string;
  /** Dated on or after this day (`YYYY-MM-DD`, UTC) or instant. */
  from?: string;
  /** Dated on or before this day (the whole day) or instant. */
  to?: string;
  /** Entries that post to this account: a line of their own, or a category change approved onto it. */
  accountId?: string;
  /** Words that must all appear in the memo. */
  q?: string;
  /** Smallest entry total (its debits), in cents. */
  minAmountCents?: number;
  /** Largest entry total (its debits), in cents. */
  maxAmountCents?: number;
};

/** The filters as an AI tool's body sends them; the REST twin reads the same from its query. */
export const ledgerReviewFilterShape = {
  reviewStatus: z.enum(["unreviewed", "ai_reviewed", "approved"]).optional(),
  source: z.string().min(1).max(80).optional(),
  from: z.string().min(1).max(40).optional(),
  to: z.string().min(1).max(40).optional(),
  accountId: z.string().uuid().optional(),
  q: z.string().trim().min(1).max(200).optional(),
  minAmountCents: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  maxAmountCents: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
};

export const ledgerReviewQuerySchema = z
  .object({
    reviewStatus: ledgerReviewFilterShape.reviewStatus.describe(
      "unreviewed still needs review; ai_reviewed holds a staged category change; approved is final.",
    ),
    source: ledgerReviewFilterShape.source.describe(
      "What posted the entry, e.g. manual, bank_categorization, brex_card_expense, invoice_issue.",
    ),
    from: ledgerReviewFilterShape.from.describe(
      "Dated on or after: YYYY-MM-DD is a calendar day in UTC; an ISO timestamp is that instant.",
    ),
    to: ledgerReviewFilterShape.to.describe(
      "Dated on or before: YYYY-MM-DD includes that whole day (UTC); an ISO timestamp is that instant.",
    ),
    accountId: ledgerReviewFilterShape.accountId.describe(
      "Entries that post to this chart-of-accounts account, including a category change approved onto it.",
    ),
    q: ledgerReviewFilterShape.q.describe("Words that must all appear in the memo."),
    minAmountCents: z.coerce
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER)
      .optional()
      .describe("Smallest entry total (its debits) in cents."),
    maxAmountCents: z.coerce
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER)
      .optional()
      .describe("Largest entry total (its debits) in cents."),
    ...pageQueryShape,
  })
  .strict();

const LEDGER_SCOPE = "finance.transactions";

const LEDGER_KEYS: KeysetColumn[] = [
  { column: "entry.date", direction: "DESC", type: "timestamp" },
  { column: "entry.id", direction: "DESC", type: "string" },
];

function ledgerReviewQuery(companyId: string, filter: LedgerReviewFilter, range: DateRange) {
  const q = (name: string) => AppDataSource.driver.escape(name);
  const col = (alias: string, name: string) => `${q(alias)}.${q(name)}`;
  const qb = AppDataSource.getRepository(LedgerEntry)
    .createQueryBuilder("entry")
    .where("entry.companyId = :companyId", { companyId })
    // A category change Entry review posted is shown on the entry it changed.
    .andWhere("entry.source != :reviewReclassSource", { reviewReclassSource: "ledger_reclass" });
  if (filter.reviewStatus) {
    qb.andWhere("entry.reviewStatus = :reviewStatus", { reviewStatus: filter.reviewStatus });
  }
  if (filter.source) qb.andWhere("entry.source = :source", { source: filter.source });
  andWhereDateRange(qb, "entry.date", range, "date");
  if (filter.q) andWhereTokens(qb, ["entry.memo"], tokenizeQuery(filter.q), "q");
  if (filter.accountId) {
    qb.andWhere(
      `EXISTS (SELECT 1 FROM ${q("ledger_lines")} ${q("l")} WHERE ${col("l", "companyId")} = entry.companyId AND ${col("l", "accountId")} = :accountId AND (${col("l", "ledgerEntryId")} = ${asText("entry.id")} OR ${col("l", "ledgerEntryId")} IN (SELECT ${asText(col("r", "id"))} FROM ${q("ledger_entries")} ${q("r")} WHERE ${col("r", "companyId")} = entry.companyId AND ${col("r", "source")} = 'ledger_reclass' AND ${col("r", "sourceRefId")} = ${asText("entry.id")})))`,
      { accountId: filter.accountId },
    );
  }
  const total = `(SELECT COALESCE(SUM(${col("t", "debitCents")}), 0) FROM ${q("ledger_lines")} ${q("t")} WHERE ${col("t", "ledgerEntryId")} = ${asText("entry.id")})`;
  if (filter.minAmountCents !== undefined) {
    qb.andWhere(`${total} >= :minAmount`, { minAmount: filter.minAmountCents });
  }
  if (filter.maxAmountCents !== undefined) {
    qb.andWhere(`${total} <= :maxAmount`, { maxAmount: filter.maxAmountCents });
  }
  return qb;
}

export type LedgerReviewPage = PageInfo & { transactions: HydratedLedgerEntry[] };

/**
 * Entry review's journal, newest first, one page at a time — every entry
 * reachable by following `nextCursor` with the same filters. The AI tool
 * `list_finance_transactions` and `GET /finance/transactions` both read it.
 */
export async function pageLedgerEntriesForReview(
  companyId: string,
  filter: LedgerReviewFilter,
  page: PageRequest & { budgetChars?: number } = {},
): Promise<LedgerReviewPage> {
  if (
    filter.minAmountCents !== undefined &&
    filter.maxAmountCents !== undefined &&
    filter.minAmountCents > filter.maxAmountCents
  ) {
    throw new ListQueryError("minAmountCents must not be more than maxAmountCents");
  }
  const range = dateRange(filter.from, filter.to);
  const fingerprint = filterFingerprint(companyId, {
    reviewStatus: filter.reviewStatus,
    source: filter.source,
    range,
    accountId: filter.accountId,
    q: filter.q ? tokenizeQuery(filter.q).map((token) => token.raw) : undefined,
    minAmountCents: filter.minAmountCents,
    maxAmountCents: filter.maxAmountCents,
  });
  const after = page.cursor ? decodeCursor(LEDGER_SCOPE, fingerprint, page.cursor) : null;
  if (filter.accountId) {
    const exists = await AppDataSource.getRepository(Account).existsBy({
      id: filter.accountId,
      companyId,
    });
    if (!exists) {
      throw new ListQueryError(
        "No chart-of-accounts account with that accountId. List them with list_finance_accounts.",
        404,
      );
    }
  }
  const limit = pageLimit(page.limit, LEDGER_REVIEW_PAGE);
  const [total, fetched] = await Promise.all([
    ledgerReviewQuery(companyId, filter, range).getCount(),
    keysetRows(ledgerReviewQuery(companyId, filter, range), {
      keys: LEDGER_KEYS,
      after,
      limit,
      prefix: "entry",
    }),
  ]);
  const hydrated = await hydrateLedgerEntries(fetched.slice(0, limit).map((entry) => entry.row));
  const byId = new Map(hydrated.map((entry) => [entry.id, entry]));
  const { rows, ...info } = finishPage({
    fetched,
    limit,
    total,
    noun: "transactions",
    scope: LEDGER_SCOPE,
    fingerprint,
    present: (entry: LedgerEntry) => byId.get(entry.id)!,
    budgetChars: page.budgetChars,
  });
  return { ...info, transactions: rows };
}

export async function getLedgerEntryForReview(
  companyId: string,
  entryId: string,
): Promise<HydratedLedgerEntry | null> {
  const entry = await AppDataSource.getRepository(LedgerEntry).findOneBy({
    id: entryId,
    companyId,
  });
  if (!entry) return null;
  const [hydrated] = await hydrateLedgerEntries([entry]);
  return hydrated ?? null;
}

export async function ledgerReviewSummary(companyId: string): Promise<{
  unreviewed: number;
  aiReviewed: number;
  approved: number;
}> {
  const repo = AppDataSource.getRepository(LedgerEntry);
  const [unreviewed, aiReviewed, approved] = await Promise.all([
    repo.count({
      where: { companyId, reviewStatus: "unreviewed", source: Not("ledger_reclass") },
    }),
    repo.count({
      where: { companyId, reviewStatus: "ai_reviewed", source: Not("ledger_reclass") },
    }),
    repo.count({
      where: { companyId, reviewStatus: "approved", source: Not("ledger_reclass") },
    }),
  ]);
  return { unreviewed, aiReviewed, approved };
}

async function validateReviewChanges(
  companyId: string,
  entry: LedgerEntry,
  changes: LedgerReviewChangeInput[],
): Promise<LedgerReviewChange[]> {
  if (changes.length === 0) return [];
  // A change here posts a reclass keyed on this entry, which the entry's
  // reversal takes back with it. Not on a locked entry: Banking changes a bank
  // or card transaction's category from where it is filed now and would never
  // hear of it, a reversal's categories are those of the entry it reverses,
  // and once an entry is reversed nothing would take the change back. Even a
  // "change" to the posted category is refused there — the money may sit
  // somewhere else by now, so it would not do what it says.
  const lock = (await categoryLocks([entry])).get(entry.id);
  if (lock) throw new Error(ENTRY_CATEGORY_LOCK_REASON[lock]);
  const lineIds = changes.map((change) => change.lineId);
  if (new Set(lineIds).size !== lineIds.length) {
    throw new Error("Each ledger line can have only one category change");
  }
  const lines = await AppDataSource.getRepository(LedgerLine).find({
    where: { id: In(lineIds), ledgerEntryId: entry.id, companyId },
  });
  if (lines.length !== lineIds.length) {
    throw new Error("One or more proposed ledger lines do not belong to this transaction");
  }
  const lineById = new Map(lines.map((line) => [line.id, line]));
  const accountIds = [
    ...new Set([
      ...lines.map((line) => line.accountId),
      ...changes.map((change) => change.accountId),
    ]),
  ];
  const accounts = await AppDataSource.getRepository(Account).find({
    where: { id: In(accountIds), companyId },
  });
  if (accounts.length !== accountIds.length) {
    throw new Error("One or more proposed categories are missing or belong to another company");
  }
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const validated: LedgerReviewChange[] = [];
  for (const change of changes) {
    const line = lineById.get(change.lineId)!;
    if (line.accountId === change.accountId) continue;
    const from = accountById.get(line.accountId)!;
    const to = accountById.get(change.accountId)!;
    if (from.type !== "expense" && from.type !== "revenue") {
      throw new Error("Only expense and revenue category lines can be reclassified here");
    }
    if (from.type !== to.type) {
      const kind = withIndefiniteArticle(from.type, { capitalized: true });
      throw new Error(`${kind} line can only move to another ${from.type} account`);
    }
    if (to.archivedAt) throw new Error(`Category ${to.code} ${to.name} is archived`);
    validated.push({
      lineId: line.id,
      fromAccountId: line.accountId,
      toAccountId: to.id,
    });
  }
  return validated;
}

/**
 * Approve a transaction's categories, applying any changes. An owner or admin
 * approves from Entry review; an AI Employee with full Finance access approves
 * through `review_finance_transaction`, and its approval is just as final —
 * the reclassification posts and the entry locks. An AI approval leaves
 * `approvedById` null and names the employee in `reviewedByEmployeeId`.
 */
export async function approveLedgerReview(args: {
  companyId: string;
  entryId: string;
  /** The approving Member, or null when an AI Employee approves. */
  userId: string | null;
  /** The approving AI Employee, when one approves. */
  employeeId?: string;
  changes?: LedgerReviewChangeInput[];
  note?: string;
}): Promise<HydratedLedgerEntry> {
  const repo = AppDataSource.getRepository(LedgerEntry);
  const entry = await repo.findOneBy({ id: args.entryId, companyId: args.companyId });
  if (!entry) throw new Error("Transaction not found");
  if (entry.reviewStatus === "approved") {
    return (await getLedgerEntryForReview(args.companyId, entry.id))!;
  }
  const staged = parseReviewChanges(entry.reviewChangesJson).map((change) => ({
    lineId: change.lineId,
    accountId: change.toAccountId,
  }));
  const changes = await validateReviewChanges(args.companyId, entry, args.changes ?? staged);

  if (changes.length > 0) {
    const alreadyPosted = await AppDataSource.getRepository(LedgerEntry).findOneBy({
      companyId: args.companyId,
      source: "ledger_reclass",
      sourceRefId: entry.id,
    });
    if (!alreadyPosted) {
      const lines = await AppDataSource.getRepository(LedgerLine).find({
        where: { id: In(changes.map((change) => change.lineId)) },
      });
      const lineById = new Map(lines.map((line) => [line.id, line]));
      await postLedgerEntry({
        companyId: args.companyId,
        // A category correction belongs to the same accounting period as the
        // transaction it corrects, so historical statements remain accurate.
        date: entry.date,
        memo: `Approved category changes for ${entry.memo || entry.id.slice(0, 8)}`,
        source: "ledger_reclass",
        sourceRefId: entry.id,
        createdById: args.userId,
        reviewStatus: "approved",
        lines: changes.flatMap((change) => {
          const line = lineById.get(change.lineId)!;
          const amount = line.debitCents || line.creditCents;
          const description = `Reclassifies ${entry.id.slice(0, 8)}`;
          return line.debitCents > 0
            ? [
                { accountId: change.toAccountId, debitCents: amount, description },
                { accountId: change.fromAccountId, creditCents: amount, description },
              ]
            : [
                { accountId: change.fromAccountId, debitCents: amount, description },
                { accountId: change.toAccountId, creditCents: amount, description },
              ];
        }),
      });
    }
  }

  const now = new Date();
  entry.reviewStatus = "approved";
  entry.reviewChangesJson = JSON.stringify(changes);
  if (args.note !== undefined) entry.reviewNote = args.note.trim() || null;
  entry.approvedById = args.userId;
  entry.approvedAt = now;
  if (args.employeeId) {
    entry.reviewedByEmployeeId = args.employeeId;
    entry.reviewedAt = now;
  }
  await repo.save(entry);
  return (await getLedgerEntryForReview(args.companyId, entry.id))!;
}

export async function returnLedgerReview(args: {
  companyId: string;
  entryId: string;
  note?: string;
}): Promise<HydratedLedgerEntry> {
  const repo = AppDataSource.getRepository(LedgerEntry);
  const entry = await repo.findOneBy({ id: args.entryId, companyId: args.companyId });
  if (!entry) throw new Error("Transaction not found");
  if (entry.reviewStatus === "approved") {
    throw new Error("An approved transaction cannot be returned to the review queue");
  }
  entry.reviewStatus = "unreviewed";
  entry.reviewChangesJson = null;
  entry.reviewNote = args.note?.trim() || null;
  entry.reviewedByEmployeeId = null;
  entry.reviewedAt = null;
  await repo.save(entry);
  return (await getLedgerEntryForReview(args.companyId, entry.id))!;
}

export type BulkReviewAction = "approve" | "return" | "delete" | "recategorize";

export type BulkReviewResult = {
  action: BulkReviewAction;
  succeeded: string[];
  skipped: Array<{ id: string; reason: string }>;
};

/**
 * Apply one review action to a batch of transactions. Each entry is handled
 * independently: a failure on one (already approved, wrong line shape, …)
 * records a skip reason and never aborts the rest of the batch. Approve,
 * return, and recategorize all post through the single-entry helpers so the
 * ledger side effects and validation stay identical to the one-at-a-time flow.
 */
export async function bulkLedgerReview(args: {
  companyId: string;
  /** The Member acting, or null when an AI Employee acts. */
  userId: string | null;
  /** The AI Employee acting, when one does. */
  employeeId?: string;
  action: BulkReviewAction;
  entryIds: string[];
  toAccountId?: string;
  note?: string;
}): Promise<BulkReviewResult> {
  const ids = [...new Set(args.entryIds)];
  const succeeded: string[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];

  if (args.action === "recategorize") {
    return recategorizeBatch({ ...args, entryIds: ids });
  }

  for (const id of ids) {
    try {
      if (args.action === "approve") {
        await approveLedgerReview({
          companyId: args.companyId,
          entryId: id,
          userId: args.userId,
          employeeId: args.employeeId,
          note: args.note,
        });
      } else if (args.action === "return") {
        await returnLedgerReview({ companyId: args.companyId, entryId: id, note: args.note });
      } else {
        await deleteLedgerEntry(args.companyId, id);
      }
      succeeded.push(id);
    } catch (err) {
      skipped.push({ id, reason: (err as Error).message || "Could not update transaction" });
    }
  }
  return { action: args.action, succeeded, skipped };
}

/** Mirrors the single-entry DELETE guard: only unapproved, manually posted
 *  transactions can be removed; everything else must be voided at the source. */
async function deleteLedgerEntry(companyId: string, entryId: string): Promise<void> {
  const repo = AppDataSource.getRepository(LedgerEntry);
  const entry = await repo.findOneBy({ id: entryId, companyId });
  if (!entry) throw new Error("Transaction not found");
  if (entry.reviewStatus === "approved") {
    throw new Error("Approved transactions are locked — post a reversing entry instead");
  }
  // See the single-entry DELETE route: a `manual` entry with a sourceRefId is
  // an auto-post overload (bill issue/payment, period close), not a hand-posted
  // journal, so it must not be bulk-deletable either.
  if (entry.source !== "manual" || entry.sourceRefId) {
    throw new Error("Auto-posted entries cannot be deleted — void the source instead");
  }
  const closed = await findClosedPeriodCovering(companyId, entry.date);
  if (closed) {
    throw new Error(
      `This entry is in the closed period "${closed.name}" and can't be deleted. Reopen the period first.`,
    );
  }
  await AppDataSource.getRepository(LedgerLine).delete({ ledgerEntryId: entry.id });
  await repo.delete({ id: entry.id });
}

/** Move every selected transaction's single expense/revenue line to one target
 *  category and approve it in the same step (posting a reclass is itself the
 *  sign-off). Transactions whose editable line does not match the target
 *  account type, or that carry more than one such line, are skipped so the
 *  owner can open them and decide by hand. Entries whose categories can't
 *  change here — bank and card transactions, reversals, and entries reversed
 *  since — are skipped too (`shared/entryCategory.ts`). */
async function recategorizeBatch(args: {
  companyId: string;
  userId: string | null;
  employeeId?: string;
  entryIds: string[];
  toAccountId?: string;
  note?: string;
}): Promise<BulkReviewResult> {
  const succeeded: string[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  if (!args.toAccountId) {
    return { action: "recategorize", succeeded, skipped };
  }
  const target = await AppDataSource.getRepository(Account).findOneBy({
    id: args.toAccountId,
    companyId: args.companyId,
  });
  if (!target) throw new Error("Target category not found");
  if (target.type !== "expense" && target.type !== "revenue") {
    throw new Error("Only expense and revenue categories can be applied in bulk");
  }
  if (target.archivedAt) throw new Error(`Category ${target.code} ${target.name} is archived`);

  const accounts = await AppDataSource.getRepository(Account).find({
    where: { companyId: args.companyId },
  });
  const accountById = new Map(accounts.map((account) => [account.id, account]));

  for (const id of args.entryIds) {
    try {
      const entry = await getLedgerEntryForReview(args.companyId, id);
      if (!entry) throw new Error("Transaction not found");
      if (entry.reviewStatus === "approved") {
        throw new Error("Already approved — locked");
      }
      // Ahead of the line count, so a locked entry with two such lines (a
      // reclassification Banking posted) is not sent to be opened and picked
      // by hand.
      if (entry.categoryLock) throw new Error(ENTRY_CATEGORY_LOCK_REASON[entry.categoryLock]);
      const candidates = entry.lines.filter(
        (line) => accountById.get(line.accountId)?.type === target.type,
      );
      if (candidates.length === 0) {
        throw new Error(`No ${target.type} line to recategorize`);
      }
      if (candidates.length > 1) {
        throw new Error(`Has ${candidates.length} ${target.type} lines — open it to choose`);
      }
      await approveLedgerReview({
        companyId: args.companyId,
        entryId: id,
        userId: args.userId,
        employeeId: args.employeeId,
        changes: [{ lineId: candidates[0].id, accountId: target.id }],
        note: args.note,
      });
      succeeded.push(id);
    } catch (err) {
      skipped.push({ id, reason: (err as Error).message || "Could not recategorize" });
    }
  }
  return { action: "recategorize", succeeded, skipped };
}
