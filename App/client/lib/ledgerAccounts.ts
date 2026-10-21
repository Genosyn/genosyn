import { formatMoney, type Account, type AccountType, type TrialBalanceRow } from "./api";

/**
 * What the ledger's accounts mean, in plain words, for the people who run a
 * company rather than keep its books. The Chart of accounts, the Trial
 * balance, and the account-activity panel all read it here.
 */

/** "Oct 21, 2026", from an ISO time or a `YYYY-MM-DD` day. Ledger dates are UTC midnights. */
export function ledgerDate(isoOrDay: string): string {
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(isoOrDay) ? `${isoOrDay}T00:00:00Z` : isoOrDay);
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** A balance with a true minus sign below zero, the way Banking writes money out. */
export function formatBalance(cents: number, currency: string): string {
  return cents < 0 ? `−${formatMoney(-cents, currency)}` : formatMoney(cents, currency);
}

/** What one entry did to a balance: "+$1,200.00" or "−$84.12". */
export function formatChange(cents: number, currency: string): string {
  if (cents === 0) return formatMoney(0, currency);
  return `${cents > 0 ? "+" : "−"}${formatMoney(Math.abs(cents), currency)}`;
}

/** The order accountants list the kinds of account in. */
export const ACCOUNT_TYPE_ORDER: AccountType[] = [
  "asset",
  "liability",
  "equity",
  "revenue",
  "expense",
];

/** A group of accounts as a heading names it. */
export const ACCOUNT_TYPE_PLURAL: Record<AccountType, string> = {
  asset: "Assets",
  liability: "Liabilities",
  equity: "Equity",
  // The type is `revenue` in the books; people call it income.
  revenue: "Income",
  expense: "Expenses",
};

/** What each kind of account holds, in a line. */
export const ACCOUNT_TYPE_MEANING: Record<AccountType, string> = {
  asset: "What the company owns — bank balances, and money customers owe you.",
  liability: "What the company owes — card balances, unpaid bills, tax collected.",
  equity: "What the owners put in, and the profit kept in the business.",
  revenue: "Money the company earns — sales, and income from anything else.",
  expense: "What the company spends money on. Most bank and card payments are filed here.",
};

/**
 * What each system account holds. Their codes never change — invoices, bills,
 * and banking find them by code — so a renamed one keeps its line. An account
 * someone added is described by its own name.
 */
const SYSTEM_ACCOUNT_MEANING: Record<string, string> = {
  "1100": "Money in the company's bank accounts.",
  "1200": "Invoices sent that customers haven't paid yet.",
  "1300": "Credits suppliers owe you, from returns or billing corrections.",
  "2100": "Sales tax collected that the company still owes the tax authority.",
  "2200": "Bills from suppliers that haven't been paid yet.",
  "2300": "What the company owes on its cards.",
  "2400": "Money owed back to customers: credit notes and overpayments.",
  "2500": "Payments customers made before they were invoiced.",
  "3000": "Money the owners put into the company.",
  "3100": "Profit from closed periods, kept in the business. Below zero after losses.",
  "4000": "What the company earned from sales.",
  "4100":
    "Refunds and discounts given after a sale. It takes away from sales, so it sits below zero.",
  "4900": "Income from anything other than sales.",
  "4910": "Gains when an exchange rate moves in the company's favor.",
  "5000": "What it cost to make or buy what was sold.",
  "6000": "Day-to-day running costs — software, rent, travel, and the like.",
  "6100": "Invoices written off because the customer won't pay.",
  "6900": "Losses when an exchange rate moves against the company.",
};

/** System accounts that normally sit below zero: each takes away from its group. */
const BELOW_ZERO_SYSTEM_CODES: ReadonlySet<string> = new Set(["4100"]);

type AccountKey = Pick<Account, "code" | "isSystem">;

/** A line on what the account holds, or null when its name has to say it. */
export function accountMeaning(account: AccountKey): string | null {
  return account.isSystem ? (SYSTEM_ACCOUNT_MEANING[account.code] ?? null) : null;
}

/** Whether a debit adds to this kind of account. Otherwise a credit does. */
export function debitAdds(type: AccountType): boolean {
  return type === "asset" || type === "expense";
}

/** An account's debits and credits as what added to its balance and what took away from it. */
export function addedAndTakenOff(
  type: AccountType,
  debitCents: number,
  creditCents: number,
): { addedCents: number; takenOffCents: number } {
  return debitAdds(type)
    ? { addedCents: debitCents, takenOffCents: creditCents }
    : { addedCents: creditCents, takenOffCents: debitCents };
}

/**
 * Whether a balance is worth a second look. Below zero means more went against
 * the account than with it — a bank account paid out more than it took in, a
 * card paid off past what was charged. Equity is left alone, since a young
 * company's losses put Retained Earnings below zero as a matter of course, and
 * so are the accounts that normally sit below zero.
 */
export function isUnusualBalance(
  account: AccountKey & Pick<Account, "type">,
  balanceCents: number,
): boolean {
  if (balanceCents >= 0 || account.type === "equity") return false;
  return !(account.isSystem && BELOW_ZERO_SYSTEM_CODES.has(account.code));
}

/** What usually puts each system account below zero. */
const BELOW_ZERO_HINT: Record<string, string> = {
  "1100": "Usually a deposit or customer payment that isn't in the books yet.",
  "1200": "Usually an overpayment, or a payment recorded against the wrong invoice.",
  "2200": "Usually a bill payment recorded without its bill.",
  "2300": "Usually a card charge that isn't in the books yet.",
};

/**
 * Why an unusual balance is below zero, in a sentence or two, from what added
 * to it and what took away from it. `money` formats cents in the books'
 * currency.
 */
export function unusualBalanceNote(
  account: AccountKey & Pick<Account, "type">,
  debitCents: number,
  creditCents: number,
  money: (cents: number) => string,
): string {
  const { addedCents, takenOffCents } = addedAndTakenOff(account.type, debitCents, creditCents);
  const added = money(addedCents);
  const takenOff = money(takenOffCents);
  let note: string;
  switch (account.type) {
    case "asset":
      note = `More is recorded going out (${takenOff}) than coming in (${added}).`;
      break;
    case "liability":
      note = `More has been paid off (${takenOff}) than was owed (${added}).`;
      break;
    case "revenue":
      note = `More was given back (${takenOff}) than earned (${added}), through refunds, credit notes, or reversals.`;
      break;
    case "expense":
      note = `More came back (${takenOff}) than was spent (${added}), through refunds or spending moved to another account.`;
      break;
    default:
      note = `More was taken off (${takenOff}) than added (${added}).`;
  }
  const hint = account.isSystem ? BELOW_ZERO_HINT[account.code] : undefined;
  return hint ? `${note} ${hint}` : note;
}

/** Whether anything has been posted to the account. */
export function hasPostings(row: Pick<TrialBalanceRow, "debitCents" | "creditCents">): boolean {
  return row.debitCents > 0 || row.creditCents > 0;
}

/** One kind of account on the trial balance. */
export type TrialBalanceGroup = {
  type: AccountType;
  rows: TrialBalanceRow[];
  /** The group's balances added up, each signed by its normal side. */
  totalCents: number;
};

export type TrialBalanceSummary = {
  /** Every kind of account, in the order accountants list them. */
  groups: TrialBalanceGroup[];
  debitCents: number;
  creditCents: number;
  /** What the company owns: the assets' total. */
  ownCents: number;
  /** What it owes: the liabilities' total. */
  oweCents: number;
  /** What the owners put in and kept: the equity total. */
  stakeCents: number;
  incomeCents: number;
  expensesCents: number;
  /** Balances below zero worth a second look ({@link isUnusualBalance}). */
  unusual: TrialBalanceRow[];
  /** Accounts nothing has been posted to. */
  emptyCount: number;
};

/**
 * The trial balance as a reader takes it in: accounts grouped by kind, the
 * two column totals, and each group's total. The check in plain words — what
 * the company owns equals what it owes, plus the owners' stake, plus income
 * minus expenses — holds exactly when debits equal credits, so the two say
 * the same thing about whether the books add up.
 */
export function summarizeTrialBalance(rows: ReadonlyArray<TrialBalanceRow>): TrialBalanceSummary {
  const groups: TrialBalanceGroup[] = ACCOUNT_TYPE_ORDER.map((type) => ({
    type,
    rows: [],
    totalCents: 0,
  }));
  const byType = new Map(groups.map((group) => [group.type, group]));
  const unusual: TrialBalanceRow[] = [];
  let debitCents = 0;
  let creditCents = 0;
  let emptyCount = 0;
  for (const row of rows) {
    debitCents += row.debitCents;
    creditCents += row.creditCents;
    const group = byType.get(row.account.type);
    if (group) {
      group.rows.push(row);
      group.totalCents += row.balanceCents;
    }
    if (!hasPostings(row)) emptyCount += 1;
    if (isUnusualBalance(row.account, row.balanceCents)) unusual.push(row);
  }
  const total = (type: AccountType) => byType.get(type)?.totalCents ?? 0;
  return {
    groups,
    debitCents,
    creditCents,
    ownCents: total("asset"),
    oweCents: total("liability"),
    stakeCents: total("equity"),
    incomeCents: total("revenue"),
    expensesCents: total("expense"),
    unusual,
    emptyCount,
  };
}
