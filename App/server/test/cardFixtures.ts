import { randomUUID } from "node:crypto";

import { AppDataSource } from "../db/datasource.js";
import { Account } from "../db/entities/Account.js";
import { CardFeed } from "../db/entities/CardFeed.js";
import { CardTransaction } from "../db/entities/CardTransaction.js";
import { LedgerEntry } from "../db/entities/LedgerEntry.js";
import { LedgerLine } from "../db/entities/LedgerLine.js";
import { reclassifyCardTransaction, retryCardTransaction } from "../services/cardExpenses.js";
import { accountByCode, postLedgerEntry, seedChartOfAccounts } from "../services/ledger.js";
import { insert } from "./dbHarness.js";

/**
 * Card purchases for service tests, and what Entry review used to do to them.
 *
 * Until Banking became the one place a card purchase's category changes, Entry
 * review could move one too. {@link legacyEntryReview} posts exactly what it
 * posted, so a test can rebuild the books an install may still carry.
 */

export const PURCHASE_DAY = new Date("2026-03-14T12:00:00Z");

/** A chart of accounts with four more expense categories, and a Brex card filing under 6000. */
export async function cardBooks(companyId: string) {
  await seedChartOfAccounts(companyId);
  const general = (await accountByCode(companyId, "6000"))!;
  const payable = (await accountByCode(companyId, "2300"))!;
  const bank = (await accountByCode(companyId, "1100"))!;
  const expense = (code: string, name: string) =>
    insert(Account, { companyId, code, name, type: "expense" });
  const travel = await expense("6200", "Travel");
  const software = await expense("6300", "Software");
  const meals = await expense("6400", "Meals");
  const office = await expense("6500", "Office");
  const feed = await insert(CardFeed, {
    companyId,
    name: "Brex card",
    kind: "brex_card",
    connectionId: "conn",
    liabilityAccountId: payable.id,
    defaultExpenseAccountId: general.id,
    paymentAccountId: bank.id,
  });
  return { companyId, general, payable, bank, travel, software, meals, office, feed };
}

export type CardBooks = Awaited<ReturnType<typeof cardBooks>>;

export async function reload<T extends { id: string }>(
  entity: new () => T,
  id: string,
): Promise<T> {
  return AppDataSource.getRepository(entity).findOneByOrFail({ id } as never);
}

/** A card purchase (or refund) synced and posted under the card's default category. */
export async function cardPurchase(
  feed: CardFeed,
  options: { kind?: "expense" | "refund"; cents: number; postedAt?: Date },
): Promise<{ card: CardTransaction; posting: LedgerEntry }> {
  const kind = options.kind ?? "expense";
  const card = await retryCardTransaction(
    await insert(CardTransaction, {
      companyId: feed.companyId,
      feedId: feed.id,
      externalId: randomUUID(),
      postedAt: options.postedAt ?? PURCHASE_DAY,
      // Brex counts a purchase as positive and a refund as negative.
      amountCents: kind === "refund" ? -options.cents : options.cents,
      currency: "USD",
      description: kind === "refund" ? "Refund: Delta Air Lines" : "Delta Air Lines",
      accountingKind: kind,
      expenseAccountId: feed.defaultExpenseAccountId,
    }),
  );
  return { card, posting: await reload(LedgerEntry, card.ledgerEntryId!) };
}

/** Banking moves the purchase, and returns the reclassification it posted. */
export async function moveOnBanking(card: CardTransaction, to: Account): Promise<LedgerEntry> {
  const reclasses = () =>
    AppDataSource.getRepository(LedgerEntry).find({
      where: { companyId: card.companyId, source: "brex_card_reclass" },
    });
  const before = new Set((await reclasses()).map((entry) => entry.id));
  await reclassifyCardTransaction(await reload(CardTransaction, card.id), to.id, "u1");
  return (await reclasses()).find((entry) => !before.has(entry.id))!;
}

/**
 * What Entry review did before it stopped changing card categories: approve
 * the entry with one line moved, posting an approved `ledger_reclass` against
 * the entry as it was shown. Line for line what `approveLedgerReview` posted.
 */
export async function legacyEntryReview(
  entry: LedgerEntry,
  from: Account,
  to: Account,
): Promise<LedgerEntry> {
  const line = (
    await AppDataSource.getRepository(LedgerLine).find({ where: { ledgerEntryId: entry.id } })
  ).find((candidate) => candidate.accountId === from.id)!;
  const amount = line.debitCents || line.creditCents;
  const description = `Reclassifies ${entry.id.slice(0, 8)}`;
  const { entry: reclass } = await postLedgerEntry({
    companyId: entry.companyId,
    date: entry.date,
    memo: `Approved category changes for ${entry.memo || entry.id.slice(0, 8)}`,
    source: "ledger_reclass",
    sourceRefId: entry.id,
    createdById: "u1",
    reviewStatus: "approved",
    lines:
      line.debitCents > 0
        ? [
            { accountId: to.id, debitCents: amount, description },
            { accountId: from.id, creditCents: amount, description },
          ]
        : [
            { accountId: from.id, debitCents: amount, description },
            { accountId: to.id, creditCents: amount, description },
          ],
  });
  await AppDataSource.getRepository(LedgerEntry).update(
    { id: entry.id },
    {
      reviewStatus: "approved",
      reviewChangesJson: JSON.stringify([
        { lineId: line.id, fromAccountId: from.id, toAccountId: to.id },
      ]),
      approvedById: "u1",
      approvedAt: new Date(),
    },
  );
  return reclass;
}

export async function accountCodes(companyId: string): Promise<Map<string, string>> {
  const accounts = await AppDataSource.getRepository(Account).find({ where: { companyId } });
  return new Map(accounts.map((account) => [account.id, account.code]));
}

/** Debits minus credits per account code across the company's ledger, zeros left out. */
export async function balancesByCode(companyId: string): Promise<Record<string, number>> {
  const [lines, codeOf] = await Promise.all([
    AppDataSource.getRepository(LedgerLine).find({ where: { companyId } }),
    accountCodes(companyId),
  ]);
  const net = new Map<string, number>();
  for (const line of lines) {
    const code = codeOf.get(line.accountId)!;
    net.set(code, (net.get(code) ?? 0) + line.debitCents - line.creditCents);
  }
  return Object.fromEntries([...net].filter(([, cents]) => cents !== 0));
}
