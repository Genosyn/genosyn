import type {
  Account,
  AccountType,
  BankingBulkAction,
  BankingBulkResult,
  BankTransaction,
  CardTransaction,
} from "./api";

/**
 * What Banking's bulk bar can do with the transactions a person ticks, and
 * the words for it. The server applies the same rules row by row
 * (`server/services/bankingBulk.ts`); these decide what the bar offers, so it
 * never offers what could only be skipped.
 */

/** One row on Banking: a bank transaction or a card transaction. */
export type BankingRow =
  | { kind: "bank"; id: string; date: string; txn: BankTransaction }
  | { kind: "card"; id: string; date: string; txn: CardTransaction };

type BankRow = Extract<BankingRow, { kind: "bank" }>;

function isBank(row: BankingRow): row is BankRow {
  return row.kind === "bank";
}

/** Bank and card ids come from different tables, so a row is ticked by both. */
export function rowKey(row: Pick<BankingRow, "kind" | "id">): string {
  return `${row.kind}:${row.id}`;
}

/** Whether a card transaction waits in To review: for its category, or to be posted. */
export function cardWaits(txn: Pick<CardTransaction, "ledgerEntryId" | "needsReview">): boolean {
  return !txn.ledgerEntryId || txn.needsReview;
}

/**
 * The actions the bar can take on one row. A bank transaction in To review
 * takes a category, and a done one goes back to review — except a deposit
 * that paid invoices, whose own Undo says which payments come off them. A
 * card purchase always takes a category; one waiting can be kept as it is,
 * and a reviewed one sent back. A card bill payment has no category at all.
 */
export function bulkActionsFor(row: BankingRow): BankingBulkAction[] {
  if (isBank(row)) {
    const payments = row.txn.match?.kind === "payments" ? row.txn.match.payments : [];
    if (!row.txn.reconciledAt) return payments.length > 0 ? [] : ["categorize"];
    return payments.some((payment) => payment.recordedHere) ? [] : ["send_to_review"];
  }
  if (row.txn.accountingKind === "payment") return [];
  if (!row.txn.ledgerEntryId) return ["categorize"];
  return row.txn.needsReview ? ["categorize", "mark_reviewed"] : ["categorize", "send_to_review"];
}

/** Why a row's tick box is off, or null when it can be ticked. */
export function unselectableReason(row: BankingRow): string | null {
  if (bulkActionsFor(row).length > 0) return null;
  if (!isBank(row)) return "A card bill payment has no category";
  return row.txn.reconciledAt
    ? "It paid invoices. Open it to undo it on its own"
    : "Part of it paid invoices. Open it to finish or undo it";
}

export type BulkPlan = Record<BankingBulkAction, BankingRow[]>;

/** The ticked rows each action would act on, in the order they are shown. */
export function planFor(rows: readonly BankingRow[]): BulkPlan {
  const plan: BulkPlan = { categorize: [], mark_reviewed: [], send_to_review: [] };
  for (const row of rows) for (const action of bulkActionsFor(row)) plan[action].push(row);
  return plan;
}

const GROUP_LABEL: Record<AccountType, string> = {
  revenue: "Income",
  expense: "Expenses",
  asset: "Assets",
  liability: "Liabilities",
  equity: "Equity",
};

export type CategoryGroup = { type: AccountType; label: string; accounts: Account[] };

/**
 * The categories the rows Categorize would act on can be filed under. A card
 * purchase takes only an expense category, so card purchases alone are
 * offered expenses alone. Money in leads with Income and anything else with
 * Expenses, as on a bank transaction's own row. A bank account is left out
 * when every bank transaction in the selection is on it: a transaction can't
 * be its own explanation.
 */
export function categoryGroups(
  accounts: readonly Account[],
  rows: readonly BankingRow[],
  bankLedgerAccountOf: (feedId: string) => string | undefined,
): CategoryGroup[] {
  const bank = rows.filter(isBank);
  const order: AccountType[] =
    bank.length === 0
      ? ["expense"]
      : bank.length === rows.length && bank.every((row) => row.txn.amountCents > 0)
        ? ["revenue", "asset", "liability", "equity", "expense"]
        : ["expense", "asset", "liability", "equity", "revenue"];
  const own = new Set(bank.map((row) => bankLedgerAccountOf(row.txn.feedId)));
  const excluded = own.size === 1 ? [...own][0] : undefined;
  const usable = accounts
    .filter((account) => !account.archivedAt && account.id !== excluded)
    .sort((a, b) => a.code.localeCompare(b.code));
  return order
    .map((type) => ({
      type,
      label: GROUP_LABEL[type],
      accounts: usable.filter((account) => account.type === type),
    }))
    .filter((group) => group.accounts.length > 0);
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * What Send to review asks before it acts, or null when it need not ask: a
 * card purchase only goes back to the list, but a bank transaction is undone —
 * its category reversed in the books, or its match unlinked.
 */
export function sendToReviewConfirmation(
  rows: readonly BankingRow[],
): { title: string; message: string; confirmLabel: string } | null {
  const bank = rows.filter(isBank);
  if (bank.length === 0) return null;
  const categorized = bank.filter(
    (row) => row.txn.match?.kind === "ledger_entry" && !!row.txn.match.categoryAccountId,
  ).length;
  const matched = bank.length - categorized;
  const cards = rows.length - bank.length;
  const sentences: string[] = [];
  if (categorized > 0) {
    sentences.push(
      categorized === 1
        ? "The category of 1 bank transaction is reversed with an opposite entry."
        : `The categories of ${categorized} bank transactions are reversed with opposite entries.`,
    );
  }
  if (matched > 0) {
    sentences.push(
      matched === 1
        ? "1 bank transaction is unlinked from what it matched, which stays in your books."
        : `${matched} bank transactions are unlinked from what they matched, which stays in your books.`,
    );
  }
  if (cards > 0) {
    sentences.push(
      cards === 1
        ? "1 card purchase keeps its category."
        : `${cards} card purchases keep their categories.`,
    );
  }
  return {
    title:
      rows.length === 1
        ? "Send this transaction back to review?"
        : `Send ${rows.length} transactions back to review?`,
    message: sentences.join(" "),
    confirmLabel: "Send to review",
  };
}

/** What the bar says while an action runs: "Categorizing 100 of 412". */
export const BULK_PROGRESS: Record<BankingBulkAction, string> = {
  categorize: "Categorizing",
  mark_reviewed: "Marking reviewed",
  send_to_review: "Sending to review",
};

const BULK_DONE: Record<BankingBulkAction, string> = {
  categorize: "categorized",
  mark_reviewed: "marked reviewed",
  send_to_review: "sent back to review",
};

/**
 * Why some of a selection was left as it was: the title says how many, each
 * reason is listed once with how often it applied, and the rest says how
 * many went through.
 */
export function skippedSummary(
  skipped: BankingBulkResult["skipped"],
  action: BankingBulkAction,
  changed: number,
): { title: string; reasons: Array<{ reason: string; count: number }>; rest: string } {
  const counts = new Map<string, number>();
  for (const { reason } of skipped) {
    const text = reason.trim().replace(/\.+$/, "");
    counts.set(text, (counts.get(text) ?? 0) + 1);
  }
  const done = BULK_DONE[action];
  return {
    title: `${plural(skipped.length, "transaction")} ${skipped.length === 1 ? "wasn’t" : "weren’t"} ${done}`,
    reasons: [...counts].map(([reason, count]) => ({ reason, count })),
    rest:
      changed === 0
        ? ""
        : changed === 1
          ? `The other one was ${done}.`
          : `The other ${changed} were ${done}.`,
  };
}
