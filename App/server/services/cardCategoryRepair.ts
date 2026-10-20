import { randomUUID } from "node:crypto";
import { AppDataSource } from "../db/datasource.js";
import { CardFeed } from "../db/entities/CardFeed.js";
import { CardTransaction } from "../db/entities/CardTransaction.js";
import { logRedactedError } from "../middleware/error.js";
import { recordAudit } from "./audit.js";
import {
  type CardCategoryDrift,
  type CategoryLine,
  findCardCategoryDrift,
} from "./cardCategoryDrift.js";
import { postLedgerEntry } from "./ledger.js";
import { withSchedulerLease } from "./schedulerLeases.js";

/**
 * Putting right the card purchases `cardCategoryDrift.ts` finds:
 *
 * - **Banking out of date** is fixed by itself, at boot. Banking shows the
 *   category the books already hold the purchase under. No entry is posted
 *   and no figure in any report moves; Banking's next change then moves the
 *   purchase out of the category that really holds it.
 * - **Split in the books** is fixed only when someone with full finance access
 *   asks, on Banking, after seeing the exact entry: one reclassification,
 *   dated today like Banking's own, that leaves the purchase under the
 *   category Banking shows. It posts to the books, and the finder can't see a
 *   journal entry someone already wrote by hand to correct one, so a person
 *   decides.
 *
 * Both are audited. A data repair can't be a migration (AGENTS.md §7), and the
 * boot pass needs no marker to run once: a purchase it fixed no longer drifts,
 * and Entry review can't make new ones.
 */

/**
 * Show one purchase on Banking under the category its books hold it under.
 *
 * Only while Banking still shows the category the finder saw, so a change
 * someone made since then stands — on Postgres another replica can be serving
 * Banking while this one boots. Returns whether it changed anything.
 */
export async function matchCategoryToBooks(
  companyId: string,
  drift: CardCategoryDrift,
): Promise<boolean> {
  const { repair, transaction } = drift;
  if (drift.kind !== "banking_out_of_date" || repair?.kind !== "show_category") return false;
  if (!transaction.expenseAccountId) return false;
  const result = await AppDataSource.getRepository(CardTransaction).update(
    { id: transaction.id, companyId, expenseAccountId: transaction.expenseAccountId },
    { expenseAccountId: repair.accountId },
  );
  if (!result.affected) return false;
  await recordAudit({
    companyId,
    actorKind: "system",
    action: "finance.card_transaction.category_matched_to_books",
    targetType: "card_transaction",
    targetId: transaction.id,
    targetLabel: transaction.description,
    metadata: {
      fromAccountId: transaction.expenseAccountId,
      toAccountId: repair.accountId,
      reviewEntryIds: drift.reviewEntryIds,
    },
  });
  return true;
}

/**
 * At boot: every purchase Banking is out of date on, in every company, shown
 * under the category its books hold. Never stops the app from starting — a
 * company it can't finish is logged and tried again on the next boot.
 */
export async function matchCardCategoriesToBooks(): Promise<void> {
  try {
    await withSchedulerLease("card-category-backfill", 30 * 60_000, async (lease) => {
      const feeds = await AppDataSource.getRepository(CardFeed).find({ select: ["companyId"] });
      for (const companyId of new Set(feeds.map((feed) => feed.companyId))) {
        lease.assertHeld();
        try {
          for (const drift of await findCardCategoryDrift(companyId)) {
            await matchCategoryToBooks(companyId, drift);
          }
        } catch (err) {
          logRedactedError("[finance] matching card categories to the books failed", err);
        }
      }
    });
  } catch (err) {
    logRedactedError("[finance] matching card categories to the books stopped", err);
  }
}

/** The drifted purchases Banking lists for a person: the ones only a person can fix. */
export async function cardCategoryFixesToReview(companyId: string): Promise<CardCategoryDrift[]> {
  return (await findCardCategoryDrift(companyId)).filter(
    (drift) => drift.kind !== "banking_out_of_date",
  );
}

/** A fix that can't go ahead, and the HTTP status that says why. */
export class CardCategoryFixError extends Error {
  constructor(
    message: string,
    readonly status: 404 | 409,
  ) {
    super(message);
  }
}

function sameLines(a: CategoryLine[], b: CategoryLine[]): boolean {
  const key = (lines: CategoryLine[]) =>
    lines
      .map((line) => `${line.accountId}:${line.debitCents}:${line.creditCents}`)
      .sort()
      .join("|");
  return key(a) === key(b);
}

/**
 * Purchases being fixed right now. A second request for one — a double click,
 * two people at once — would otherwise post the same correction twice.
 */
const fixing = new Set<string>();

/**
 * Fix one purchase that is split in the books, from Banking: post the
 * reclassification the finder proposes, which must be exactly the `lines` the
 * person was shown, so the purchase is filed under the category Banking shows
 * and nowhere else. Banking's category itself doesn't change.
 */
export async function fixSplitCardCategory(args: {
  companyId: string;
  transactionId: string;
  /** The entry the person was shown. */
  lines: CategoryLine[];
  actorUserId: string | null;
}): Promise<CardTransaction> {
  const repo = AppDataSource.getRepository(CardTransaction);
  const transaction = await repo.findOneBy({ id: args.transactionId, companyId: args.companyId });
  if (!transaction) throw new CardCategoryFixError("Card transaction not found", 404);
  if (fixing.has(transaction.id)) {
    throw new CardCategoryFixError("This purchase is already being fixed", 409);
  }
  fixing.add(transaction.id);
  try {
    const drift = (await findCardCategoryDrift(args.companyId)).find(
      (candidate) => candidate.transaction.id === transaction.id,
    );
    if (!drift || drift.kind === "banking_out_of_date") {
      throw new CardCategoryFixError(
        "There's nothing to fix: your books hold this purchase under one category",
        409,
      );
    }
    if (drift.kind === "unrecognized" || drift.repair?.kind !== "reclassify") {
      throw new CardCategoryFixError(`${drift.problem}. Correct it with a journal entry.`, 409);
    }
    if (!sameLines(drift.repair.lines, args.lines)) {
      throw new CardCategoryFixError(
        "This purchase changed since you opened it. Look at the entry again before you fix it.",
        409,
      );
    }
    const description = "Fix category of " + (transaction.description || transaction.externalId);
    const { entry } = await postLedgerEntry({
      companyId: args.companyId,
      // Today, like Banking's own changes: the books are right from now on,
      // and a period that was closed stays as it was closed.
      date: new Date(),
      memo: description,
      source: "brex_card_reclass",
      sourceRefId: transaction.id + ":" + randomUUID(),
      createdById: args.actorUserId,
      lines: drift.repair.lines.map((line) => ({ ...line, description })),
    });
    transaction.reclassifiedAt = new Date();
    const saved = await repo.save(transaction);
    await recordAudit({
      companyId: args.companyId,
      actorUserId: args.actorUserId,
      action: "finance.card_transaction.books_matched_to_category",
      targetType: "card_transaction",
      targetId: transaction.id,
      targetLabel: transaction.description,
      metadata: {
        entryId: entry.id,
        accountId: transaction.expenseAccountId,
        reviewEntryIds: drift.reviewEntryIds,
      },
    });
    return saved;
  } finally {
    fixing.delete(transaction.id);
  }
}
