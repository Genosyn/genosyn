import { randomUUID } from "node:crypto";
import { AppDataSource } from "../db/datasource.js";
import { Account } from "../db/entities/Account.js";
import { CardFeed } from "../db/entities/CardFeed.js";
import { type CardAccountingKind, CardTransaction } from "../db/entities/CardTransaction.js";
import { IntegrationConnection } from "../db/entities/IntegrationConnection.js";
import { LedgerEntry } from "../db/entities/LedgerEntry.js";
import {
  type BrexConfig,
  type BrexCardTransaction,
  getBrexCardTransactionsPage,
} from "../integrations/providers/brex.js";
import { convertCents, getFinanceSettings } from "./fx.js";
import { decryptConnectionConfig } from "./integrations.js";
import { postLedgerEntry } from "./ledger.js";

type CreateCardFeedInput = {
  companyId: string;
  name: string;
  connectionId: string;
  liabilityAccountId: string;
  defaultExpenseAccountId: string;
  paymentAccountId: string;
};

export type CardSyncResult = {
  inserted: number;
  posted: number;
  failed: number;
};

async function getBrexConfig(companyId: string, connectionId: string): Promise<BrexConfig> {
  const connection = await AppDataSource.getRepository(IntegrationConnection).findOneBy({
    id: connectionId,
    companyId,
    provider: "brex",
  });
  if (!connection) throw new Error("Brex Connection not found");
  const config = decryptConnectionConfig(connection) as Partial<BrexConfig>;
  if (!config.userToken || typeof config.userToken !== "string") {
    throw new Error("Brex Connection is missing its user token");
  }
  return { userToken: config.userToken };
}

async function requireMappedAccount(
  companyId: string,
  accountId: string,
  type: Account["type"],
  label: string,
): Promise<Account> {
  const account = await AppDataSource.getRepository(Account).findOneBy({
    id: accountId,
    companyId,
  });
  if (!account || account.archivedAt || account.type !== type) {
    throw new Error(label + " must be an active " + type + " account in this company");
  }
  return account;
}

export async function assertBrexCardConnection(
  companyId: string,
  connectionId: string,
): Promise<void> {
  const config = await getBrexConfig(companyId, connectionId);
  try {
    await getBrexCardTransactionsPage(config.userToken, { limit: 1 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      "Brex Card access failed. Grant transactions.card.readonly on the user token. " + message,
    );
  }
}

export async function createCardFeed(input: CreateCardFeedInput): Promise<CardFeed> {
  await Promise.all([
    requireMappedAccount(input.companyId, input.liabilityAccountId, "liability", "Card liability"),
    requireMappedAccount(
      input.companyId,
      input.defaultExpenseAccountId,
      "expense",
      "Default category",
    ),
    requireMappedAccount(input.companyId, input.paymentAccountId, "asset", "Payment account"),
    assertBrexCardConnection(input.companyId, input.connectionId),
  ]);
  const repo = AppDataSource.getRepository(CardFeed);
  return repo.save(
    repo.create({
      companyId: input.companyId,
      name: input.name,
      kind: "brex_card",
      connectionId: input.connectionId,
      liabilityAccountId: input.liabilityAccountId,
      defaultExpenseAccountId: input.defaultExpenseAccountId,
      paymentAccountId: input.paymentAccountId,
    }),
  );
}

function classifyCardTransaction(
  transaction: Pick<BrexCardTransaction, "type" | "amount">,
): CardAccountingKind {
  const type = (transaction.type ?? "").toUpperCase();
  if (type === "COLLECTION" || type === "PAYMENT" || type === "CARD_PAYMENT") {
    return "payment";
  }
  if ((transaction.amount?.amount ?? 0) < 0) return "refund";
  return "expense";
}

function parsePostedDate(value: string, transactionId: string): Date {
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? value + "T12:00:00.000Z" : value);
  if (Number.isNaN(date.getTime())) {
    throw new Error("Brex card transaction " + transactionId + " has an invalid posted date");
  }
  return date;
}

async function postCardTransaction(feed: CardFeed, transaction: CardTransaction): Promise<boolean> {
  if (transaction.ledgerEntryId) return false;
  const magnitude = Math.abs(transaction.amountCents);
  if (!Number.isSafeInteger(magnitude) || magnitude === 0) {
    throw new Error("Card transaction amount must be a non-zero safe integer");
  }
  const settings = await getFinanceSettings(feed.companyId);
  const converted = await convertCents(
    feed.companyId,
    magnitude,
    transaction.currency,
    settings.homeCurrency,
    transaction.postedAt,
  );
  const description = transaction.description || "Brex card transaction " + transaction.externalId;

  let source: "brex_card_expense" | "brex_card_refund" | "brex_card_payment";
  let lines: Array<{
    accountId: string;
    debitCents?: number;
    creditCents?: number;
    description: string;
    origCurrency: string;
    origAmountCents: number;
    rate: number;
  }>;

  if (transaction.accountingKind === "payment") {
    source = "brex_card_payment";
    lines = [
      {
        accountId: feed.liabilityAccountId,
        debitCents: converted.converted,
        description,
        origCurrency: transaction.currency,
        origAmountCents: magnitude,
        rate: converted.rate,
      },
      {
        accountId: feed.paymentAccountId,
        creditCents: converted.converted,
        description,
        origCurrency: transaction.currency,
        origAmountCents: magnitude,
        rate: converted.rate,
      },
    ];
  } else {
    if (!transaction.expenseAccountId) {
      throw new Error("Card expense has no expense category");
    }
    if (transaction.accountingKind === "refund") {
      source = "brex_card_refund";
      lines = [
        {
          accountId: feed.liabilityAccountId,
          debitCents: converted.converted,
          description,
          origCurrency: transaction.currency,
          origAmountCents: magnitude,
          rate: converted.rate,
        },
        {
          accountId: transaction.expenseAccountId,
          creditCents: converted.converted,
          description,
          origCurrency: transaction.currency,
          origAmountCents: magnitude,
          rate: converted.rate,
        },
      ];
    } else {
      source = "brex_card_expense";
      lines = [
        {
          accountId: transaction.expenseAccountId,
          debitCents: converted.converted,
          description,
          origCurrency: transaction.currency,
          origAmountCents: magnitude,
          rate: converted.rate,
        },
        {
          accountId: feed.liabilityAccountId,
          creditCents: converted.converted,
          description,
          origCurrency: transaction.currency,
          origAmountCents: magnitude,
          rate: converted.rate,
        },
      ];
    }
  }

  const existingEntry = await AppDataSource.getRepository(LedgerEntry).findOneBy({
    companyId: feed.companyId,
    source,
    sourceRefId: transaction.id,
  });
  if (existingEntry) {
    transaction.ledgerEntryId = existingEntry.id;
    transaction.postingError = "";
    await AppDataSource.getRepository(CardTransaction).save(transaction);
    return true;
  }

  const { entry } = await postLedgerEntry({
    companyId: feed.companyId,
    date: transaction.postedAt,
    memo: "Brex card · " + description,
    source,
    sourceRefId: transaction.id,
    createdById: null,
    lines,
  });
  transaction.ledgerEntryId = entry.id;
  transaction.postingError = "";
  await AppDataSource.getRepository(CardTransaction).save(transaction);
  return true;
}

async function recordPostingResult(feed: CardFeed, transaction: CardTransaction): Promise<boolean> {
  try {
    return await postCardTransaction(feed, transaction);
  } catch (err) {
    transaction.postingError = err instanceof Error ? err.message : String(err);
    await AppDataSource.getRepository(CardTransaction).save(transaction);
    return false;
  }
}

export async function syncCardFeed(feed: CardFeed): Promise<CardSyncResult> {
  if (feed.kind !== "brex_card") {
    throw new Error("Feed is not a Brex Card feed");
  }
  const config = await getBrexConfig(feed.companyId, feed.connectionId);
  const transactionRepo = AppDataSource.getRepository(CardTransaction);
  const existing = await transactionRepo.find({
    where: { feedId: feed.id },
  });
  const byExternalId = new Map(
    existing.map((transaction) => [transaction.externalId, transaction]),
  );
  const seenCursors = new Set<string>();
  const pendingPosts = existing.filter((transaction) => !transaction.ledgerEntryId);
  let cursor: string | undefined;
  let inserted = 0;

  for (;;) {
    const page = await getBrexCardTransactionsPage(config.userToken, {
      cursor,
      limit: 100,
    });
    for (const remote of page.items ?? []) {
      if (byExternalId.has(remote.id)) continue;
      if (!remote.amount || !Number.isSafeInteger(remote.amount.amount)) {
        throw new Error("Brex card transaction " + remote.id + " has no safe integer amount");
      }
      const accountingKind = classifyCardTransaction(remote);
      const row = await transactionRepo.save(
        transactionRepo.create({
          companyId: feed.companyId,
          feedId: feed.id,
          externalId: remote.id,
          cardId: remote.card_id ?? null,
          postedAt: parsePostedDate(remote.posted_at_date, remote.id),
          amountCents: remote.amount.amount,
          currency: (remote.amount.currency ?? "USD").toUpperCase(),
          description: remote.description || "Brex card transaction",
          providerType: remote.type ?? "",
          accountingKind,
          expenseAccountId: accountingKind === "payment" ? null : feed.defaultExpenseAccountId,
          raw: JSON.stringify(remote),
        }),
      );
      byExternalId.set(remote.id, row);
      pendingPosts.push(row);
      inserted += 1;
    }
    const next = page.next_cursor ?? undefined;
    if (!next) break;
    if (seenCursors.has(next)) {
      throw new Error("Brex returned a repeated card transaction cursor");
    }
    seenCursors.add(next);
    cursor = next;
  }

  let posted = 0;
  for (const transaction of pendingPosts) {
    if (await recordPostingResult(feed, transaction)) posted += 1;
  }
  feed.lastSyncAt = new Date();
  await AppDataSource.getRepository(CardFeed).save(feed);
  return {
    inserted,
    posted,
    failed: pendingPosts.length - posted,
  };
}

export async function retryCardTransaction(transaction: CardTransaction): Promise<CardTransaction> {
  const feed = await AppDataSource.getRepository(CardFeed).findOneBy({
    id: transaction.feedId,
    companyId: transaction.companyId,
  });
  if (!feed) throw new Error("Card feed not found");
  try {
    await postCardTransaction(feed, transaction);
  } catch (err) {
    transaction.postingError = err instanceof Error ? err.message : String(err);
    await AppDataSource.getRepository(CardTransaction).save(transaction);
    throw err;
  }
  return transaction;
}

export async function reclassifyCardTransaction(
  transaction: CardTransaction,
  expenseAccountId: string,
  actorUserId: string | null,
): Promise<CardTransaction> {
  if (transaction.accountingKind === "payment") {
    throw new Error("Card payments do not have an expense category");
  }
  await requireMappedAccount(
    transaction.companyId,
    expenseAccountId,
    "expense",
    "Expense category",
  );
  if (transaction.expenseAccountId === expenseAccountId) return transaction;
  const oldExpenseAccountId = transaction.expenseAccountId;
  transaction.expenseAccountId = expenseAccountId;

  if (!transaction.ledgerEntryId || !oldExpenseAccountId) {
    await AppDataSource.getRepository(CardTransaction).save(transaction);
    await retryCardTransaction(transaction);
    return transaction;
  }

  const settings = await getFinanceSettings(transaction.companyId);
  const converted = await convertCents(
    transaction.companyId,
    Math.abs(transaction.amountCents),
    transaction.currency,
    settings.homeCurrency,
    transaction.postedAt,
  );
  const description = "Reclassify " + (transaction.description || transaction.externalId);
  const lines =
    transaction.accountingKind === "refund"
      ? [
          {
            accountId: oldExpenseAccountId,
            debitCents: converted.converted,
            description,
          },
          {
            accountId: expenseAccountId,
            creditCents: converted.converted,
            description,
          },
        ]
      : [
          {
            accountId: expenseAccountId,
            debitCents: converted.converted,
            description,
          },
          {
            accountId: oldExpenseAccountId,
            creditCents: converted.converted,
            description,
          },
        ];
  await postLedgerEntry({
    companyId: transaction.companyId,
    date: new Date(),
    memo: description,
    source: "brex_card_reclass",
    sourceRefId: transaction.id + ":" + randomUUID(),
    createdById: actorUserId,
    lines,
  });
  transaction.reclassifiedAt = new Date();
  transaction.postingError = "";
  return AppDataSource.getRepository(CardTransaction).save(transaction);
}

export async function loadCardFeed(companyId: string, feedId: string): Promise<CardFeed | null> {
  return AppDataSource.getRepository(CardFeed).findOneBy({
    id: feedId,
    companyId,
  });
}

export async function listCardTransactions(
  companyId: string,
  feedId?: string,
): Promise<CardTransaction[]> {
  const where = feedId ? { companyId, feedId } : { companyId };
  return AppDataSource.getRepository(CardTransaction).find({
    where,
    order: { postedAt: "DESC", createdAt: "DESC" },
    take: 500,
  });
}

export async function deleteEmptyCardFeed(feed: CardFeed): Promise<void> {
  const count = await AppDataSource.getRepository(CardTransaction).count({
    where: { feedId: feed.id },
  });
  if (count > 0) {
    throw new Error(
      "A synced card feed cannot be deleted because its ledger entries are part of the accounting audit trail",
    );
  }
  await AppDataSource.getRepository(CardFeed).delete({ id: feed.id });
}
