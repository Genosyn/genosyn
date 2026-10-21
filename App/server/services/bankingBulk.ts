import { In } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { Account } from "../db/entities/Account.js";
import { BankTransaction } from "../db/entities/BankTransaction.js";
import { CardTransaction } from "../db/entities/CardTransaction.js";
import { linkedPaymentsByTransaction } from "./bankPaymentLinks.js";
import { recordedFromBanking, undoBankTransaction } from "./banking.js";
import { reclassifyCardTransaction, setCardTransactionsReview } from "./cardExpenses.js";
import { categorizeBankTransaction } from "./reconcile.js";

/**
 * Banking's bulk bar: one action over many bank and card transactions at once.
 *
 *   - `categorize` files each one under one category. A bank transaction in
 *     To review is categorized as its own Categorize would, and a card
 *     purchase moves to it with a reclassification, in review or done.
 *   - `mark_reviewed` keeps the categories card purchases are filed under and
 *     moves them to Done.
 *   - `send_to_review` puts done transactions back in To review. A card
 *     purchase keeps its category. A bank transaction is undone as its own
 *     Undo would: a category is reversed and a match unlinked. A deposit
 *     that paid invoices is left for its own Undo, which says which payments
 *     come off them, rather than taking them off in a sweep.
 *
 * Each transaction goes through the helper its own row uses, under that row's
 * rules, and one that can't take the action — already done, in a closed
 * period, a card bill payment — is skipped with a reason instead of failing
 * the rest. What went through stays done.
 */

export type BankingBulkAction = "categorize" | "mark_reviewed" | "send_to_review";

/** How many transactions one request takes, bank and card together. */
export const BANKING_BULK_MAX = 200;

export type BankingBulkResult = {
  action: BankingBulkAction;
  /** Now in the state the action asked for. */
  succeeded: { bank: string[]; card: string[] };
  skipped: Array<{ kind: "bank" | "card"; id: string; reason: string }>;
};

type Outcome = BankingBulkResult & {
  /** The bank transactions categorized here, for their audit rows. */
  categorized: BankTransaction[];
};

export async function bulkBanking(args: {
  companyId: string;
  actorUserId: string | null;
  action: BankingBulkAction;
  accountId?: string;
  bankTransactionIds: string[];
  cardTransactionIds: string[];
}): Promise<Outcome> {
  const outcome: Outcome = {
    action: args.action,
    succeeded: { bank: [], card: [] },
    skipped: [],
    categorized: [],
  };
  const bankIds = [...new Set(args.bankTransactionIds)];
  const cardIds = [...new Set(args.cardTransactionIds)];
  const [bankRows, cardRows] = await Promise.all([
    bankIds.length
      ? AppDataSource.getRepository(BankTransaction).findBy({
          companyId: args.companyId,
          id: In(bankIds),
        })
      : Promise.resolve([]),
    cardIds.length
      ? AppDataSource.getRepository(CardTransaction).findBy({
          companyId: args.companyId,
          id: In(cardIds),
        })
      : Promise.resolve([]),
  ]);
  const bankById = new Map(bankRows.map((txn) => [txn.id, txn]));
  const cardById = new Map(cardRows.map((txn) => [txn.id, txn]));
  const skip = (kind: "bank" | "card", id: string, reason: string) =>
    outcome.skipped.push({ kind, id, reason });

  if (args.action === "categorize") {
    const category = args.accountId
      ? await AppDataSource.getRepository(Account).findOneBy({
          id: args.accountId,
          companyId: args.companyId,
        })
      : null;
    if (!category) throw new Error("Category not found");
    if (category.archivedAt) {
      throw new Error(`${category.code} ${category.name} is archived`);
    }
    for (const id of bankIds) {
      const txn = bankById.get(id);
      if (!txn) {
        skip("bank", id, "Transaction not found");
      } else if (txn.reconciledAt) {
        skip("bank", id, "It's already done, so send it back to review to file it somewhere else");
      } else {
        try {
          outcome.categorized.push(
            await categorizeBankTransaction(txn, category.id, args.actorUserId),
          );
          outcome.succeeded.bank.push(id);
        } catch (err) {
          skip("bank", id, reasonOf(err));
        }
      }
    }
    for (const id of cardIds) {
      const txn = cardById.get(id);
      if (!txn) {
        skip("card", id, "Transaction not found");
      } else if (txn.accountingKind === "payment") {
        skip("card", id, "A card bill payment has no category");
      } else if (category.type !== "expense") {
        skip("card", id, "A card purchase is filed under an expense category");
      } else {
        try {
          await reclassifyCardTransaction(txn, category.id, args.actorUserId);
          outcome.succeeded.card.push(id);
        } catch (err) {
          skip("card", id, reasonOf(err));
        }
      }
    }
    return outcome;
  }

  if (args.action === "mark_reviewed") {
    for (const id of bankIds) {
      const txn = bankById.get(id);
      if (!txn) skip("bank", id, "Transaction not found");
      else if (txn.reconciledAt) outcome.succeeded.bank.push(id);
      else skip("bank", id, "A bank transaction needs an invoice, a match or a category");
    }
  } else {
    const linked = await linkedPaymentsByTransaction(bankRows);
    for (const id of bankIds) {
      const txn = bankById.get(id);
      if (!txn) {
        skip("bank", id, "Transaction not found");
      } else if (!txn.reconciledAt) {
        outcome.succeeded.bank.push(id);
      } else if ((linked.get(id) ?? []).some(recordedFromBanking)) {
        skip(
          "bank",
          id,
          "It paid invoices, so open it and use Undo to see which payments come off",
        );
      } else {
        try {
          await undoBankTransaction(txn, args.actorUserId);
          outcome.succeeded.bank.push(id);
        } catch (err) {
          skip("bank", id, reasonOf(err));
        }
      }
    }
  }
  const cards = await setCardTransactionsReview(
    args.companyId,
    cardIds,
    args.action === "send_to_review",
  );
  outcome.succeeded.card.push(...cards.done);
  for (const { id, reason } of cards.skipped) skip("card", id, reason);
  return outcome;
}

function reasonOf(err: unknown): string {
  return (err instanceof Error && err.message) || "Couldn't change it";
}
