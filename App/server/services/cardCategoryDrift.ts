import { In } from "typeorm";
import { CARD_CATEGORY_SOURCES } from "../../shared/cardCategory.js";
import { AppDataSource } from "../db/datasource.js";
import { Account, type AccountType } from "../db/entities/Account.js";
import { CardFeed } from "../db/entities/CardFeed.js";
import { CardTransaction } from "../db/entities/CardTransaction.js";
import { LedgerEntry } from "../db/entities/LedgerEntry.js";
import { LedgerLine } from "../db/entities/LedgerLine.js";

/**
 * Card purchases whose category drifted while Entry review could still change
 * it.
 *
 * Banking is now the one place a card purchase's category changes
 * (`shared/cardCategory.ts`). Before that, Entry review could move one too: it
 * posted an approved `ledger_reclass` against the entry it showed — the
 * purchase's own posting, or a reclassification Banking had posted for it —
 * and the purchase never heard of it. Banking moves a purchase out of the
 * category the purchase remembers (`CardTransaction.expenseAccountId`), so two
 * kinds of purchase were left behind:
 *
 * - `banking_out_of_date`: the books hold the purchase under one category and
 *   Banking shows another, so Banking's next change would move it out of a
 *   category that doesn't hold it;
 * - `split_in_books`: both pages moved it, so the books hold it under several
 *   categories, and one of them is usually negative.
 *
 * A purchase is judged by its own entries — its posting, every
 * reclassification Banking posted for it, and every change Entry review
 * approved on either — and only purchases Entry review changed are looked at.
 * A journal entry someone posted by hand to correct one is not among them.
 *
 * This only reads. `repair` says what would put each purchase right, and
 * `cardCategoryRepair.ts` applies it. A repair only ever moves an amount
 * between expense categories, so total expenses stay as they are: a purchase
 * filed under anything else is `unrecognized`, with no repair, like one whose
 * entries don't add up.
 */

export type CardCategoryDriftKind = "banking_out_of_date" | "split_in_books" | "unrecognized";

/** Debits minus credits on one category: positive for a purchase, negative for a refund. */
export type FiledAmount = { accountId: string; cents: number };

/** One line of a correcting entry: exactly one of the two amounts is non-zero. */
export type CategoryLine = { accountId: string; debitCents: number; creditCents: number };

export type CardCategoryRepair =
  /** Banking shows the category the books already hold the purchase under. */
  | { kind: "show_category"; accountId: string }
  /** One reclassification leaves the purchase under the category Banking shows, and nowhere else. */
  | { kind: "reclassify"; lines: CategoryLine[] };

export type CardCategoryDrift = {
  kind: CardCategoryDriftKind;
  transaction: Pick<
    CardTransaction,
    | "id"
    | "feedId"
    | "description"
    | "postedAt"
    | "amountCents"
    | "currency"
    | "accountingKind"
    | "expenseAccountId"
    | "ledgerEntryId"
  >;
  feedName: string;
  /** What the purchase's posting put on its category, in the home currency. */
  bookedCents: number;
  /** Where the books hold the purchase now, largest first, zeros left out. */
  filed: FiledAmount[];
  /** The changes Entry review approved on the purchase's entries, oldest first. */
  reviewEntryIds: string[];
  /** Null for an `unrecognized` purchase, whose entries don't add up to a card purchase's. */
  repair: CardCategoryRepair | null;
  /** Why an `unrecognized` purchase has no repair. */
  problem: string | null;
};

const POSTING_SOURCES = ["brex_card_expense", "brex_card_refund"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID_CHUNK = 500;

/** Rows for many ids, a bounded `IN` list at a time. */
async function byIds<T>(ids: string[], load: (part: string[]) => Promise<T[]>): Promise<T[]> {
  const rows: T[] = [];
  for (let start = 0; start < ids.length; start += ID_CHUNK) {
    rows.push(...(await load(ids.slice(start, start + ID_CHUNK))));
  }
  return rows;
}

/** Distinct ids, leaving out anything a uuid column would refuse. */
function uniqueIds(values: Array<string | null>): string[] {
  return [...new Set(values.filter((value): value is string => !!value && UUID.test(value)))];
}

/** The purchase an entry files. Banking keys its reclassifications `<purchase id>:<uuid>`. */
function purchaseIdOf(entry: Pick<LedgerEntry, "source" | "sourceRefId">): string | null {
  const ref = entry.sourceRefId ?? "";
  return (entry.source === "brex_card_reclass" ? ref.split(":")[0] : ref) || null;
}

function groupBy<T>(items: T[], key: (item: T) => string | null): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    if (k === null) continue;
    const group = groups.get(k);
    if (group) group.push(item);
    else groups.set(k, [item]);
  }
  return groups;
}

/** The lines that move `filed` to the whole amount on one category and nothing anywhere else. */
function linesLeavingOnly(filed: FiledAmount[], accountId: string, cents: number): CategoryLine[] {
  const target = new Map(filed.map((amount) => [amount.accountId, 0]));
  target.set(accountId, cents);
  const current = new Map(filed.map((amount) => [amount.accountId, amount.cents]));
  const lines = [...target].flatMap(([id, wanted]) => {
    const delta = wanted - (current.get(id) ?? 0);
    if (delta === 0) return [];
    return [{ accountId: id, debitCents: Math.max(delta, 0), creditCents: Math.max(-delta, 0) }];
  });
  // Debits first, the way the rest of the ledger reads.
  return lines.sort(
    (a, b) => b.debitCents - a.debitCents || a.accountId.localeCompare(b.accountId),
  );
}

function judge(args: {
  transaction: CardCategoryDrift["transaction"];
  feed: CardFeed | undefined;
  own: LedgerEntry[];
  changes: LedgerEntry[];
  linesOf: Map<string, LedgerLine[]>;
  typeOf: Map<string, AccountType>;
}): CardCategoryDrift | null {
  const { transaction, feed, own, changes, linesOf, typeOf } = args;
  const liabilityId = feed?.liabilityAccountId ?? null;
  const postings = own.filter((entry) => entry.source !== "brex_card_reclass");
  const posting = postings.length === 1 ? postings[0] : null;
  const postingLines = (posting ? (linesOf.get(posting.id) ?? []) : []).filter(
    (line) => line.accountId !== liabilityId,
  );
  const changeLines = [...own.filter((entry) => entry !== posting), ...changes].flatMap(
    (entry) => linesOf.get(entry.id) ?? [],
  );

  const net = new Map<string, number>();
  for (const line of [...postingLines, ...changeLines]) {
    net.set(line.accountId, (net.get(line.accountId) ?? 0) + line.debitCents - line.creditCents);
  }
  const filed = [...net]
    .filter(([, cents]) => cents !== 0)
    .map(([accountId, cents]) => ({ accountId, cents }))
    .sort((a, b) => b.cents - a.cents || a.accountId.localeCompare(b.accountId));
  const bookedCents = postingLines.reduce(
    (sum, line) => sum + line.debitCents - line.creditCents,
    0,
  );
  const result = {
    transaction,
    feedName: feed?.name ?? "",
    bookedCents,
    filed,
    reviewEntryIds: changes.map((entry) => entry.id),
  };
  const unrecognized = (problem: string): CardCategoryDrift => ({
    ...result,
    kind: "unrecognized",
    repair: null,
    problem,
  });

  if (!feed) return unrecognized("Its card is no longer on Banking");
  if (postings.length !== 1) {
    return unrecognized(
      postings.length === 0 ? "It isn't in the books" : "It was added to the books more than once",
    );
  }
  if (posting!.id !== transaction.ledgerEntryId) {
    return unrecognized("Its entry in the books isn't the one the purchase points to");
  }
  if (changeLines.some((line) => line.accountId === liabilityId)) {
    return unrecognized("A category change moved money on the card's own account");
  }
  const sign = transaction.accountingKind === "refund" ? -1 : 1;
  if (bookedCents * sign <= 0) return unrecognized("Its entry puts no amount on a category");
  if (filed.reduce((sum, amount) => sum + amount.cents, 0) !== bookedCents) {
    return unrecognized("Its entries don't balance — some of their lines are missing");
  }
  const bankingId = transaction.expenseAccountId;
  if (!bankingId) return unrecognized("Banking shows no category for it");
  const categoryIds = [bankingId, ...filed.map((amount) => amount.accountId)];
  if (categoryIds.some((id) => typeOf.get(id) !== "expense")) {
    return unrecognized("It is filed under an account that isn't an expense category");
  }

  if (filed.length === 1) {
    if (filed[0].accountId === bankingId) return null;
    return {
      ...result,
      kind: "banking_out_of_date",
      repair: { kind: "show_category", accountId: filed[0].accountId },
      problem: null,
    };
  }
  return {
    ...result,
    kind: "split_in_books",
    repair: { kind: "reclassify", lines: linesLeavingOnly(filed, bankingId, bookedCents) },
    problem: null,
  };
}

/** Every card purchase in the company whose category drifted, newest first. */
export async function findCardCategoryDrift(companyId: string): Promise<CardCategoryDrift[]> {
  const entries = AppDataSource.getRepository(LedgerEntry);
  const reviewChanges = await entries.find({
    where: { companyId, source: "ledger_reclass" },
    select: ["id", "source", "sourceRefId", "createdAt"],
  });
  const changed = await byIds(uniqueIds(reviewChanges.map((entry) => entry.sourceRefId)), (ids) =>
    entries.find({
      where: { companyId, id: In(ids), source: In([...CARD_CATEGORY_SOURCES]) },
      select: ["id", "source", "sourceRefId"],
    }),
  );
  const purchaseIds = uniqueIds(changed.map(purchaseIdOf));
  if (purchaseIds.length === 0) return [];

  const [transactions, postings, bankingReclasses] = await Promise.all([
    byIds(purchaseIds, (ids) =>
      AppDataSource.getRepository(CardTransaction).find({
        where: { companyId, id: In(ids) },
        select: [
          "id",
          "feedId",
          "description",
          "postedAt",
          "amountCents",
          "currency",
          "accountingKind",
          "expenseAccountId",
          "ledgerEntryId",
        ],
      }),
    ),
    byIds(purchaseIds, (ids) =>
      entries.find({
        where: { companyId, source: In([...POSTING_SOURCES]), sourceRefId: In(ids) },
        select: ["id", "source", "sourceRefId"],
      }),
    ),
    entries.find({
      where: { companyId, source: "brex_card_reclass" },
      select: ["id", "source", "sourceRefId"],
    }),
  ]);

  const wanted = new Set(purchaseIds);
  const ownEntries = groupBy([...postings, ...bankingReclasses], (entry) => {
    const purchaseId = purchaseIdOf(entry);
    return purchaseId && wanted.has(purchaseId) ? purchaseId : null;
  });
  const changesOf = groupBy(reviewChanges, (entry) => entry.sourceRefId);
  const entryIds = [...ownEntries.values()]
    .flat()
    .flatMap((entry) => [entry.id, ...(changesOf.get(entry.id) ?? []).map((change) => change.id)]);
  const [lines, feeds] = await Promise.all([
    byIds(entryIds, (ids) =>
      AppDataSource.getRepository(LedgerLine).find({
        where: { companyId, ledgerEntryId: In(ids) },
        select: ["id", "ledgerEntryId", "accountId", "debitCents", "creditCents"],
      }),
    ),
    AppDataSource.getRepository(CardFeed).find({
      where: { companyId, id: In(uniqueIds(transactions.map((t) => t.feedId))) },
    }),
  ]);
  const accountIds = uniqueIds([
    ...lines.map((line) => line.accountId),
    ...transactions.map((t) => t.expenseAccountId),
  ]);
  const accounts = await byIds(accountIds, (ids) =>
    AppDataSource.getRepository(Account).find({
      where: { companyId, id: In(ids) },
      select: ["id", "type"],
    }),
  );
  const linesOf = groupBy(lines, (line) => line.ledgerEntryId);
  const feedById = new Map(feeds.map((feed) => [feed.id, feed]));
  const typeOf = new Map(accounts.map((account) => [account.id, account.type]));

  const drifts: CardCategoryDrift[] = [];
  for (const transaction of transactions) {
    const own = ownEntries.get(transaction.id) ?? [];
    const changes = own
      .flatMap((entry) => changesOf.get(entry.id) ?? [])
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
    if (changes.length === 0) continue;
    const drift = judge({
      transaction,
      feed: feedById.get(transaction.feedId),
      own,
      changes,
      linesOf,
      typeOf,
    });
    if (drift) drifts.push(drift);
  }
  return drifts.sort(
    (a, b) =>
      b.transaction.postedAt.getTime() - a.transaction.postedAt.getTime() ||
      a.transaction.id.localeCompare(b.transaction.id),
  );
}
