import React from "react";
import { Link } from "react-router-dom";
import { AlertCircle, Check, ChevronDown, ChevronRight, RotateCcw, Search, Undo2 } from "lucide-react";
import {
  Account,
  AccountType,
  api,
  BankingBulkResult,
  BankTransaction,
  BankTransactionPayment,
  CardTransaction,
  Company,
  DepositInvoiceOptions,
  formatMoney,
  MatchCandidate,
  OpenInvoiceCandidate,
  OpenInvoiceSet,
  parseMoneyToCents,
} from "../lib/api";
import { errorMessage } from "../lib/errors";
import { ledgerSourceLabel } from "../lib/ledgerSources";
import { canWriteFinance } from "../lib/subpages";
import { Button } from "../components/ui/Button";
import { Checkbox } from "../components/ui/Checkbox";
import { useBackgroundAction, useDialog } from "../components/ui/Dialog";
import { FormError } from "../components/ui/FormError";
import { Select } from "../components/ui/Select";
import { ButtonSpinner, Spinner } from "../components/ui/Spinner";
import { clsx } from "../components/ui/clsx";

/**
 * One transaction on Banking. A bank transaction opens to the three ways it
 * can be explained — it paid one or more invoices, it is something already in
 * the books, or it gets a category — and, once explained, to what explains it
 * and an Undo. A card transaction is already in the books under its card's
 * default category, so its row is just that category, changeable in place;
 * while it waits for review, a check beside it keeps the category as it is.
 *
 * With Full finance access every row has a tick box for the bulk bar
 * (`FinanceBankingBulk.tsx`).
 */

/** A row's tick box for the bulk bar. */
export type RowSelection = {
  checked: boolean;
  /** Why the row can't be ticked, for its tooltip; null when it can. */
  disabledReason: string | null;
  onToggle: (extend: boolean) => void;
};

function RowCheckbox({ selection, label }: { selection: RowSelection; label: string }) {
  return (
    <span className="flex shrink-0 items-center self-stretch pl-4">
      <Checkbox
        checked={selection.checked}
        disabled={selection.disabledReason !== null}
        title={selection.disabledReason ?? undefined}
        // A shift-click ticks the run from the last row ticked.
        onChange={(event) => selection.onToggle((event.nativeEvent as MouseEvent).shiftKey)}
        label={label}
      />
    </span>
  );
}

/** A ticked row's wash, and the hover that keeps it. */
function rowTone(selection: RowSelection | undefined): string {
  return selection?.checked
    ? "bg-indigo-50/70 dark:bg-indigo-500/[0.08]"
    : "hover:bg-slate-50 dark:hover:bg-slate-800/40";
}

/** "Oct 18", or "Oct 18, 2025" outside this year. Bank dates are UTC midnights. */
export function transactionDate(iso: string): string {
  const date = new Date(iso);
  const thisYear = date.getUTCFullYear() === new Date().getUTCFullYear();
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: thisYear ? undefined : "numeric",
    timeZone: "UTC",
  });
}

/** Money in reads "+$1,200.00" in green; money out "−$84.12". */
export function SignedAmount({ cents, currency }: { cents: number; currency: string }) {
  const incoming = cents > 0;
  return (
    <span
      className={
        "whitespace-nowrap text-sm font-medium tabular-nums " +
        (incoming ? "text-emerald-700 dark:text-emerald-400" : "text-slate-900 dark:text-slate-100")
      }
    >
      {incoming ? "+" : "−"}
      {formatMoney(Math.abs(cents), currency)}
    </span>
  );
}

const GROUP_LABEL: Record<AccountType, string> = {
  revenue: "Income",
  expense: "Expenses",
  asset: "Assets",
  liability: "Liabilities",
  equity: "Equity",
};

/**
 * The categories a bank transaction can be filed under: money in leads with
 * Income, money out with Expenses, and the rest follow for transfers, loans,
 * and owner money. The account's own bank account is left out — a
 * transaction can't be its own explanation.
 *
 * Plain elements, not a component: `Select` builds its searchable list by
 * reading its children's `<optgroup>`s and `<option>`s, and can't see inside
 * a component.
 */
function categoryOptions(
  accounts: Account[],
  incoming: boolean,
  excludeId: string | undefined,
): React.ReactNode[] {
  const order: AccountType[] = incoming
    ? ["revenue", "asset", "liability", "equity", "expense"]
    : ["expense", "asset", "liability", "equity", "revenue"];
  const usable = accounts
    .filter((account) => !account.archivedAt && account.id !== excludeId)
    .sort((a, b) => a.code.localeCompare(b.code));
  return order.flatMap((type) => {
    const list = usable.filter((account) => account.type === type);
    if (list.length === 0) return [];
    return [
      <optgroup key={type} label={GROUP_LABEL[type]}>
        {list.map((account) => (
          <option key={account.id} value={account.id}>
            {account.code} {account.name}
          </option>
        ))}
      </optgroup>,
    ];
  });
}

function accountLabel(accounts: Account[], id: string | null | undefined): string {
  const account = accounts.find((item) => item.id === id);
  return account ? `${account.code} ${account.name}` : "a category";
}

/** "A", "A and B", "A, B and C". */
function listOf(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** The payments a transaction is linked to — its invoices, paid from it. */
function paymentsOf(txn: BankTransaction): BankTransactionPayment[] {
  return txn.match?.kind === "payments" ? txn.match.payments : [];
}

/** What explains a bank transaction, in a few words for its row. */
function outcomeSummary(txn: BankTransaction, accounts: Account[]): string {
  const match = txn.match;
  if (!match) return "Matched";
  if (match.kind === "payments") {
    return match.payments.length === 1
      ? `Paid ${match.payments[0].invoiceNumber}`
      : `Paid ${match.payments.length} invoices`;
  }
  if (match.categoryAccountId) {
    return accounts.find((account) => account.id === match.categoryAccountId)?.name ?? "Categorized";
  }
  return ledgerSourceLabel(match.source, match.sourceRefId);
}

/**
 * What Undo is about to do, said before it does it: payments Banking recorded
 * come off their invoices, a category is reversed, and a plain match only
 * unlinks.
 */
function undoConfirmation(
  txn: BankTransaction,
  accounts: Account[],
  homeCurrency: string,
): { title: string; message: string } {
  const money = (cents: number) => formatMoney(cents, homeCurrency);
  const match = txn.match;
  const after = txn.reconciledAt
    ? "this transaction goes back to To review"
    : "this transaction stays in To review";
  if (match?.kind === "payments") {
    const removed = match.payments.filter((payment) => payment.recordedHere);
    const kept = match.payments.filter((payment) => !payment.recordedHere);
    const stays =
      kept.length === 0
        ? ""
        : kept.length === 1
          ? ` The payment on ${kept[0].invoiceNumber} stays; only its link to this transaction goes.`
          : ` The payments on ${listOf(kept.map((p) => p.invoiceNumber))} stay; only their links to this transaction go.`;
    if (removed.length === 0) {
      return {
        title: "Undo this match?",
        message:
          kept.length === 1
            ? `The payment stays on ${kept[0].invoiceNumber}; only the link to this transaction is removed, and ${after}.`
            : `The payments stay on their invoices; only their links to this transaction are removed, and ${after}.`,
      };
    }
    if (removed.length === 1) {
      return {
        title: `Take the payment off ${removed[0].invoiceNumber}?`,
        message: `The ${money(removed[0].amountCents)} payment comes off ${removed[0].invoiceNumber}, which will show that much due again, and ${after}.${stays}`,
      };
    }
    const parts = removed.map(
      (payment, i) =>
        `${money(payment.amountCents)}${i === 0 ? " comes" : ""} off ${payment.invoiceNumber}`,
    );
    return {
      title: `Take the payments off ${removed.length} invoices?`,
      message: `${listOf(parts)}, and each will show that much due again. Then ${after}.${stays}`,
    };
  }
  if (match?.kind === "ledger_entry" && match.categoryAccountId) {
    return {
      title: "Remove the category?",
      message: `Genosyn reverses the ${money(Math.abs(txn.amountCents))} it filed under ${accountLabel(accounts, match.categoryAccountId)}, and ${after}.`,
    };
  }
  return {
    title: "Undo this match?",
    message: `The entry stays in your books, and ${after}.`,
  };
}

// ─────────────────────────────── Bank rows ────────────────────────────────

export function BankTransactionRow({
  company,
  txn,
  accountName,
  bankLedgerAccountId,
  homeCurrency,
  accounts,
  open,
  onToggle,
  onChanged,
  selection,
}: {
  company: Company;
  txn: BankTransaction;
  /** The bank account's name, shown when the list mixes several accounts. */
  accountName: string | null;
  /** The ledger account the transaction's bank account posts to. */
  bankLedgerAccountId: string | undefined;
  homeCurrency: string;
  accounts: Account[];
  open: boolean;
  onToggle: () => void;
  onChanged: () => Promise<void>;
  /** Absent for a Member who can't change finances. */
  selection?: RowSelection;
}) {
  const done = !!txn.reconciledAt;
  return (
    <li>
      <div className={clsx("flex items-stretch", rowTone(selection))}>
        {selection && (
          <RowCheckbox
            selection={selection}
            label={`Select ${txn.description || "bank transaction"}`}
          />
        )}
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className={clsx(
            "flex min-w-0 flex-1 items-center gap-3 py-3 pr-4 text-left",
            selection ? "pl-3" : "pl-4",
          )}
        >
          <span className="text-slate-400">
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </span>
          <span className="hidden w-24 shrink-0 text-xs text-slate-500 sm:block dark:text-slate-400">
            {transactionDate(txn.date)}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm text-slate-800 dark:text-slate-100">
              {txn.description || "Bank transaction"}
            </span>
            <span className="mt-0.5 block truncate text-xs text-slate-500 dark:text-slate-400">
              <span className="sm:hidden">{transactionDate(txn.date)} · </span>
              {accountName ?? "Bank account"}
            </span>
          </span>
          {done ? (
            <span className="hidden max-w-[14rem] items-center gap-1 truncate text-xs text-slate-600 md:inline-flex dark:text-slate-300">
              <Check size={12} className="shrink-0 text-emerald-600 dark:text-emerald-400" />
              <span className="truncate">{outcomeSummary(txn, accounts)}</span>
            </span>
          ) : (
            <span className="hidden rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 md:inline-flex dark:bg-amber-500/15 dark:text-amber-300 inline-block first-letter:uppercase">
              {paymentsOf(txn).length > 0 ? "Part paid" : "To review"}
            </span>
          )}
          <span className="w-28 shrink-0 text-right">
            <SignedAmount cents={txn.amountCents} currency={homeCurrency} />
          </span>
        </button>
      </div>
      {open &&
        (done ? (
          <DonePanel company={company} txn={txn} accounts={accounts} homeCurrency={homeCurrency} onChanged={onChanged} />
        ) : (
          <ReviewPanel
            company={company}
            txn={txn}
            bankLedgerAccountId={bankLedgerAccountId}
            homeCurrency={homeCurrency}
            accounts={accounts}
            onChanged={onChanged}
          />
        ))}
    </li>
  );
}

function PanelSection({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h3 className="text-xs font-medium text-slate-500 dark:text-slate-400">
        {title}
      </h3>
      {hint && <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{hint}</p>}
      <div className="mt-2">{children}</div>
    </section>
  );
}

/** How many open invoices show before "Show all". */
const TOP_INVOICES = 3;

function ReviewPanel({
  company,
  txn,
  bankLedgerAccountId,
  homeCurrency,
  accounts,
  onChanged,
}: {
  company: Company;
  txn: BankTransaction;
  bankLedgerAccountId: string | undefined;
  homeCurrency: string;
  accounts: Account[];
  onChanged: () => Promise<void>;
}) {
  const canWrite = canWriteFinance(company);
  const dialog = useDialog();
  const incoming = txn.amountCents > 0;
  // Part of the deposit already paid invoices, and one of those payments was
  // deleted since: what is left can only go on invoices, or be undone.
  const partlyPaid = paymentsOf(txn).length > 0;
  const [options, setOptions] = React.useState<DepositInvoiceOptions | null>(null);
  const [matches, setMatches] = React.useState<MatchCandidate[] | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [showAllMatches, setShowAllMatches] = React.useState(false);
  const [category, setCategory] = React.useState("");
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let alive = true;
    const none: DepositInvoiceOptions = { remainingCents: 0, invoices: [], sets: [] };
    Promise.all([
      incoming
        ? api.get<DepositInvoiceOptions>(
            `/api/companies/${company.id}/bank-transactions/${txn.id}/open-invoices`,
          )
        : Promise.resolve(none),
      partlyPaid
        ? Promise.resolve([])
        : api.get<MatchCandidate[]>(
            `/api/companies/${company.id}/bank-transactions/${txn.id}/candidates`,
          ),
    ])
      .then(([open, recorded]) => {
        if (!alive) return;
        setOptions(open);
        setMatches(recorded);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setOptions(none);
        setMatches([]);
        setLoadError(errorMessage(err, "Couldn't load the suggestions"));
      });
    return () => {
      alive = false;
    };
  }, [company.id, incoming, partlyPaid, txn.id]);

  async function run(key: string, work: () => Promise<unknown>) {
    setBusy(key);
    setError(null);
    try {
      await work();
      await onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  function payInvoices(shares: Array<{ invoiceId: string; amountCents: number }>) {
    void run("pay", () =>
      api.post(`/api/companies/${company.id}/bank-transactions/${txn.id}/pay-invoices`, {
        invoices: shares,
      }),
    );
  }

  async function undo() {
    const { title, message } = undoConfirmation(txn, accounts, homeCurrency);
    if (!(await dialog.confirm({ title, message, confirmLabel: "Undo" }))) return;
    void run("undo", () =>
      api.post(`/api/companies/${company.id}/bank-transactions/${txn.id}/unmatch`),
    );
  }

  function match(candidate: MatchCandidate) {
    const body =
      candidate.kind === "payment"
        ? { paymentId: candidate.paymentId }
        : { ledgerEntryId: candidate.ledgerEntryId };
    void run(`match:${candidateKey(candidate)}`, () =>
      api.post(`/api/companies/${company.id}/bank-transactions/${txn.id}/match`, body),
    );
  }

  function categorize() {
    if (!category) return;
    void run("categorize", () =>
      api.post(`/api/companies/${company.id}/bank-transactions/${txn.id}/categorize`, {
        accountId: category,
      }),
    );
  }

  if (options === null || matches === null) {
    return (
      <div className="flex justify-center border-t border-slate-100 bg-slate-50 p-6 dark:border-slate-800 dark:bg-slate-800/30">
        <Spinner size={16} />
      </div>
    );
  }

  const sameAmount = matches.filter(
    (candidate) => Math.abs(candidate.amountCents) === Math.abs(txn.amountCents),
  );
  const shownMatches = showAllMatches ? matches : sameAmount;
  const hiddenMatches = matches.length - sameAmount.length;

  return (
    <div className="space-y-5 border-t border-slate-100 bg-slate-50 px-4 py-4 sm:pl-11 dark:border-slate-800 dark:bg-slate-800/30">
      {loadError && <FormError message={loadError} />}

      {incoming && (
        <PanelSection
          title="Did this pay an invoice?"
          hint={
            canWrite
              ? "Tick the invoices it paid — one, or several a customer settled with one transfer. Each is marked paid with its share, on the day the money arrived."
              : undefined
          }
        >
          <PayInvoices
            company={company}
            txn={txn}
            options={options}
            homeCurrency={homeCurrency}
            canWrite={canWrite}
            busy={busy}
            onPay={payInvoices}
            onUndo={undo}
          />
        </PanelSection>
      )}

      {!partlyPaid && (matches.length > 0 || !incoming) && (
        <PanelSection
          title="Is it already in your books?"
          hint="A payment, bill payment, or entry someone already recorded for this money."
        >
          {shownMatches.length === 0 ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">
              {matches.length === 0
                ? "Nothing recorded around this date for this amount."
                : "Nothing recorded for exactly this amount."}
            </p>
          ) : (
            <ul className="space-y-1.5">
              {shownMatches.map((candidate) => (
                <li
                  key={candidateKey(candidate)}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-slate-200 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-900"
                >
                  <div className="min-w-0 flex-1 text-sm">
                    {candidate.kind === "payment" ? (
                      <>
                        <div className="text-slate-700 dark:text-slate-200">
                          Payment on{" "}
                          <Link
                            to={`/c/${company.slug}/finance/invoices/${candidate.invoiceSlug}`}
                            className="font-mono text-xs font-semibold text-indigo-600 hover:underline dark:text-indigo-400"
                          >
                            {candidate.invoiceNumber}
                          </Link>{" "}
                          · {candidate.customerName}
                        </div>
                        <div className="text-xs text-slate-500 dark:text-slate-400">
                          Recorded for {transactionDate(candidate.paidAt)}
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="text-slate-700 dark:text-slate-200">
                          {ledgerSourceLabel(candidate.source, candidate.sourceRefId)} ·{" "}
                          <span className="text-slate-500 dark:text-slate-400">{candidate.memo}</span>
                        </div>
                        <div className="text-xs text-slate-500 dark:text-slate-400">
                          {transactionDate(candidate.date)}
                        </div>
                      </>
                    )}
                  </div>
                  <span className="text-sm tabular-nums text-slate-700 dark:text-slate-200">
                    {formatMoney(Math.abs(candidate.amountCents), homeCurrency)}
                  </span>
                  {canWrite && (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => match(candidate)}
                      loading={busy === `match:${candidateKey(candidate)}`}
                      disabled={busy !== null}
                    >
                      Match
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {hiddenMatches > 0 && (
            <button
              type="button"
              onClick={() => setShowAllMatches((value) => !value)}
              className="mt-2 text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400"
            >
              {showAllMatches
                ? "Show only the same amount"
                : `Show ${hiddenMatches} more around this date`}
            </button>
          )}
        </PanelSection>
      )}

      {canWrite && !partlyPaid && (
        <PanelSection
          title={incoming || matches.length > 0 ? "Or give it a category" : "Give it a category"}
          hint={
            incoming
              ? "Income, a loan, money the owners put in — whatever this money was."
              : "An expense, a transfer to another account, a loan repayment — whatever this money paid for."
          }
        >
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-0 flex-1 sm:max-w-sm">
              <Select
                value={category}
                onChange={(event) => setCategory(event.target.value)}
                aria-label="Category"
                searchPlaceholder="Search categories"
              >
                <option value="">Choose a category…</option>
                {categoryOptions(accounts, incoming, bankLedgerAccountId)}
              </Select>
            </div>
            <Button
              onClick={categorize}
              loading={busy === "categorize"}
              disabled={busy !== null || !category}
            >
              Categorize
            </Button>
          </div>
        </PanelSection>
      )}

      <FormError message={error} />
    </div>
  );
}

/** "1200.00" — how a share's amount is written in its box. */
function amountText(cents: number): string {
  return (cents / 100).toFixed(2);
}

/**
 * The invoices a deposit could have paid, to tick: each ticked invoice gets
 * a share of the deposit — what is still due on it, or what is left of the
 * deposit when that is less — which can be changed, and the total runs
 * against the deposit until they match and Mark paid records them all.
 */
function PayInvoices({
  company,
  txn,
  options,
  homeCurrency,
  canWrite,
  busy,
  onPay,
  onUndo,
}: {
  company: Company;
  txn: BankTransaction;
  options: DepositInvoiceOptions;
  homeCurrency: string;
  canWrite: boolean;
  busy: string | null;
  onPay: (shares: Array<{ invoiceId: string; amountCents: number }>) => void;
  onUndo: () => void;
}) {
  const { invoices, sets, remainingCents } = options;
  const money = (cents: number) => formatMoney(cents, homeCurrency);
  const already = paymentsOf(txn);
  const whole = already.length === 0;
  const byId = new Map(invoices.map((invoice) => [invoice.invoiceId, invoice]));
  // An invoice whose amount due is exactly the deposit and that the bank's
  // description names starts ticked — when it is the only one.
  const [picked, setPicked] = React.useState<Map<string, string>>(() => {
    const sure = invoices.filter((invoice) => invoice.exactAmount && invoice.mentioned);
    return new Map(
      canWrite && sure.length === 1 ? [[sure[0].invoiceId, amountText(sure[0].balanceCents)]] : [],
    );
  });
  const [showAll, setShowAll] = React.useState(false);
  const [search, setSearch] = React.useState("");

  const shares = invoices
    .filter((invoice) => picked.has(invoice.invoiceId))
    .map((invoice) => ({
      invoice,
      cents: parseMoneyToCents(picked.get(invoice.invoiceId) ?? ""),
    }));
  const total = shares.reduce((sum, share) => sum + share.cents, 0);
  const left = remainingCents - total;
  const ready =
    shares.length > 0 &&
    left === 0 &&
    shares.every((share) => share.cents > 0 && share.cents <= share.invoice.balanceCents);
  // Everything the ticked customers owe is ticked in full and money is still
  // left: the customer paid more than it owed.
  const tickedCustomers = new Set(shares.map((share) => share.invoice.customerName));
  const overpaid =
    left > 0 &&
    shares.length > 0 &&
    shares.every((share) => share.cents === share.invoice.balanceCents) &&
    invoices.every(
      (invoice) => picked.has(invoice.invoiceId) || !tickedCustomers.has(invoice.customerName),
    );

  function toggle(invoice: OpenInvoiceCandidate) {
    setPicked((previous) => {
      const next = new Map(previous);
      if (next.delete(invoice.invoiceId)) return next;
      const placed = [...next.values()].reduce(
        (sum, text) => sum + Math.max(parseMoneyToCents(text), 0),
        0,
      );
      const open = remainingCents - placed;
      next.set(
        invoice.invoiceId,
        amountText(open > 0 ? Math.min(invoice.balanceCents, open) : invoice.balanceCents),
      );
      return next;
    });
  }

  function setAmount(invoiceId: string, text: string) {
    setPicked((previous) => new Map(previous).set(invoiceId, text));
  }

  function tickSet(set: OpenInvoiceSet) {
    setPicked(
      new Map(
        set.invoiceIds.flatMap((id): Array<[string, string]> => {
          const invoice = byId.get(id);
          return invoice ? [[id, amountText(invoice.balanceCents)]] : [];
        }),
      ),
    );
  }

  function isTicked(set: OpenInvoiceSet): boolean {
    return (
      set.invoiceIds.length === picked.size &&
      set.invoiceIds.every(
        (id) => parseMoneyToCents(picked.get(id) ?? "") === byId.get(id)?.balanceCents,
      )
    );
  }

  const needle = search.trim().toLowerCase();
  const listed = invoices.filter(
    (invoice, index) =>
      picked.has(invoice.invoiceId) ||
      (showAll
        ? !needle || `${invoice.number} ${invoice.customerName}`.toLowerCase().includes(needle)
        : index < TOP_INVOICES),
  );

  return (
    <>
      {!whole && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
          <span className="min-w-0 flex-1">
            {money(already.reduce((sum, payment) => sum + payment.amountCents, 0))} of this deposit
            already paid {listOf(already.map((payment) => payment.invoiceNumber))}.{" "}
            {!canWrite
              ? remainingCents > 0
                ? `The other ${money(remainingCents)} isn't on an invoice yet.`
                : ""
              : remainingCents > 0
                ? `Tick what the other ${money(remainingCents)} paid, or undo it to start over.`
                : "Undo it to start over."}
          </span>
          {canWrite && (
            <Button
              size="sm"
              variant="secondary"
              onClick={onUndo}
              loading={busy === "undo"}
              disabled={busy !== null}
            >
              <Undo2 size={14} /> Undo
            </Button>
          )}
        </div>
      )}

      {invoices.length === 0 ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">
          No invoices in {homeCurrency} are waiting for payment.
        </p>
      ) : (
        <>
          {canWrite && sets.length > 0 && (
            <ul className="mb-2 space-y-1.5">
              {sets.map((set) => (
                <li
                  key={set.invoiceIds.join(",")}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-emerald-200 bg-emerald-50/60 px-3 py-2 text-sm dark:border-emerald-500/30 dark:bg-emerald-500/10"
                >
                  <span className="min-w-0 flex-1 text-slate-700 dark:text-slate-200">
                    {set.customerName}&apos;s{" "}
                    {listOf(set.invoiceIds.map((id) => byId.get(id)?.number ?? "invoice"))} add up
                    to exactly {whole ? "this deposit" : "what is left of it"}.
                  </span>
                  {isTicked(set) ? (
                    <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 dark:text-emerald-400">
                      <Check size={12} /> Ticked
                    </span>
                  ) : (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => tickSet(set)}
                      disabled={busy !== null}
                    >
                      Tick these
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {showAll && (
            <label className="relative mb-2 block sm:w-72">
              <Search
                size={14}
                className="pointer-events-none absolute left-3 top-2.5 text-slate-400"
              />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search invoice or customer"
                aria-label="Search open invoices"
                className="h-9 w-full rounded-lg border border-slate-200 bg-white pl-9 pr-3 text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 dark:border-slate-700 dark:bg-slate-950"
              />
            </label>
          )}
          <ul className={"space-y-1.5 " + (showAll ? "max-h-80 overflow-y-auto pr-1" : "")}>
            {listed.map((invoice) => {
              const text = picked.get(invoice.invoiceId);
              const cents = text === undefined ? 0 : parseMoneyToCents(text);
              return (
                <li
                  key={invoice.invoiceId}
                  className={
                    "flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border px-3 py-2 " +
                    (text === undefined
                      ? "border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900"
                      : "border-indigo-200 bg-indigo-50/50 dark:border-indigo-500/40 dark:bg-indigo-500/10")
                  }
                >
                  <label
                    className={
                      "flex min-w-0 flex-1 items-start gap-3 " + (canWrite ? "cursor-pointer" : "")
                    }
                  >
                    {canWrite && (
                      <Checkbox
                        checked={text !== undefined}
                        onChange={() => toggle(invoice)}
                        disabled={busy !== null}
                        label={`${invoice.number} was paid by this deposit`}
                        className="mt-0.5"
                      />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2 text-sm">
                        <Link
                          to={`/c/${company.slug}/finance/invoices/${invoice.slug}`}
                          className="font-mono text-xs font-semibold text-indigo-600 hover:underline dark:text-indigo-400"
                        >
                          {invoice.number}
                        </Link>
                        <span className="truncate text-slate-700 dark:text-slate-200">
                          {invoice.customerName}
                        </span>
                        {invoice.exactAmount && (
                          <Tag>{whole ? "Same amount" : "Same as what is left"}</Tag>
                        )}
                        {invoice.mentioned && <Tag>Named in the description</Tag>}
                      </span>
                      <span className="mt-0.5 block text-xs text-slate-500 dark:text-slate-400">
                        {money(invoice.balanceCents)} due · due {transactionDate(invoice.dueDate)}
                      </span>
                    </span>
                  </label>
                  {text !== undefined && (
                    <div className="w-full pl-7 sm:w-auto sm:pl-0">
                      <input
                        value={text}
                        onChange={(event) => setAmount(invoice.invoiceId, event.target.value)}
                        inputMode="decimal"
                        disabled={busy !== null}
                        aria-label={`Amount paid on ${invoice.number}`}
                        className="h-8 w-28 rounded-lg border border-slate-200 bg-white px-2 text-right text-sm tabular-nums outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 dark:border-slate-700 dark:bg-slate-950"
                      />
                      {cents > invoice.balanceCents && (
                        <p className="mt-0.5 text-xs text-amber-700 sm:text-right dark:text-amber-400">
                          More than the {money(invoice.balanceCents)} due
                        </p>
                      )}
                      {cents <= 0 && (
                        <p className="mt-0.5 text-xs text-amber-700 sm:text-right dark:text-amber-400">
                          Enter an amount
                        </p>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
            {listed.length === 0 && (
              <li className="text-sm text-slate-500 dark:text-slate-400">No matching invoices.</li>
            )}
          </ul>
          {invoices.length > TOP_INVOICES && (
            <button
              type="button"
              onClick={() => setShowAll((value) => !value)}
              className="mt-2 text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400"
            >
              {showAll ? "Show fewer" : `Show all ${invoices.length} open invoices`}
            </button>
          )}
          {canWrite && (
            <div className="mt-3 border-t border-slate-200 pt-3 dark:border-slate-700">
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
                <p className="text-sm">
                  {shares.length === 0 ? (
                    <span className="text-slate-500 dark:text-slate-400">
                      Tick the invoices {whole ? "this deposit" : "the rest of it"} paid.
                    </span>
                  ) : (
                    <>
                      <span className="font-medium tabular-nums text-slate-800 dark:text-slate-100">
                        {money(total)}
                      </span>
                      <span className="text-slate-500 dark:text-slate-400">
                        {" "}
                        of the {money(remainingCents)} {whole ? "deposit" : "left"}
                      </span>
                      {left > 0 && (
                        <span className="text-slate-500 dark:text-slate-400">
                          {" "}
                          · {money(left)} not on an invoice yet
                        </span>
                      )}
                      {left < 0 && (
                        <span className="text-amber-700 dark:text-amber-400">
                          {" "}
                          · {money(-left)} more than {whole ? "the deposit" : "what is left"}
                        </span>
                      )}
                      {left === 0 && (
                        <span className="text-emerald-700 dark:text-emerald-400"> · adds up</span>
                      )}
                    </>
                  )}
                </p>
                <Button
                  size="sm"
                  onClick={() =>
                    onPay(
                      shares.map((share) => ({
                        invoiceId: share.invoice.invoiceId,
                        amountCents: share.cents,
                      })),
                    )
                  }
                  loading={busy === "pay"}
                  disabled={busy !== null || !ready}
                >
                  Mark paid
                </Button>
              </div>
              {overpaid && (
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  That is {money(left)} more than these invoices owe. To keep the extra as a
                  customer credit, record the payment on the invoice, then match it here.
                </p>
              )}
            </div>
          )}
        </>
      )}
    </>
  );
}

function candidateKey(candidate: MatchCandidate): string {
  return candidate.kind === "payment" ? candidate.paymentId : candidate.ledgerEntryId;
}

function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">
      {children}
    </span>
  );
}

/** The invoices a deposit paid, each linked, with its share when there are several. */
function PaidInvoices({
  company,
  txn,
  payments,
  homeCurrency,
}: {
  company: Company;
  txn: BankTransaction;
  payments: BankTransactionPayment[];
  homeCurrency: string;
}) {
  const invoiceLink = (payment: BankTransactionPayment) => (
    <Link
      to={`/c/${company.slug}/finance/invoices/${payment.invoiceSlug}`}
      className="font-mono text-xs font-semibold text-indigo-600 hover:underline dark:text-indigo-400"
    >
      {payment.invoiceNumber}
    </Link>
  );
  if (payments.length === 1) {
    const [payment] = payments;
    return (
      <>
        Paid {invoiceLink(payment)} from {payment.customerName}
        {payment.amountCents !== Math.abs(txn.amountCents) && (
          <span className="text-slate-500 dark:text-slate-400">
            {" "}
            ({formatMoney(payment.amountCents, homeCurrency)} of it)
          </span>
        )}
      </>
    );
  }
  const customers = [...new Set(payments.map((payment) => payment.customerName))];
  return (
    <>
      Paid {payments.length} invoices{customers.length === 1 ? ` from ${customers[0]}` : ""}
      <ul className="mt-1 space-y-0.5">
        {payments.map((payment) => (
          <li key={payment.paymentId} className="flex items-baseline gap-2 text-xs">
            {invoiceLink(payment)}
            {customers.length > 1 && (
              <span className="text-slate-500 dark:text-slate-400">{payment.customerName}</span>
            )}
            <span className="tabular-nums text-slate-600 dark:text-slate-300">
              {formatMoney(payment.amountCents, homeCurrency)}
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}

function DonePanel({
  company,
  txn,
  accounts,
  homeCurrency,
  onChanged,
}: {
  company: Company;
  txn: BankTransaction;
  accounts: Account[];
  homeCurrency: string;
  onChanged: () => Promise<void>;
}) {
  const canWrite = canWriteFinance(company);
  const dialog = useDialog();
  const [busy, setBusy] = React.useState(false);
  const match = txn.match;

  async function undo() {
    const { title, message } = undoConfirmation(txn, accounts, homeCurrency);
    if (!(await dialog.confirm({ title, message, confirmLabel: "Undo" }))) return;
    setBusy(true);
    try {
      await api.post(`/api/companies/${company.id}/bank-transactions/${txn.id}/unmatch`);
      await onChanged();
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t undo it" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 bg-slate-50 px-4 py-4 sm:pl-11 dark:border-slate-800 dark:bg-slate-800/30">
      <div className="text-sm text-slate-700 dark:text-slate-200">
        {match?.kind === "payments" ? (
          <PaidInvoices
            company={company}
            txn={txn}
            payments={match.payments}
            homeCurrency={homeCurrency}
          />
        ) : match?.kind === "ledger_entry" && match.categoryAccountId ? (
          <>Categorized as {accountLabel(accounts, match.categoryAccountId)}</>
        ) : match?.kind === "ledger_entry" ? (
          <>
            Matched to {ledgerSourceLabel(match.source, match.sourceRefId).toLowerCase()}:{" "}
            <span className="text-slate-500 dark:text-slate-400">{match.memo || "no memo"}</span>
          </>
        ) : (
          <>Matched</>
        )}
        {txn.reconciledAt && (
          <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            Done {new Date(txn.reconciledAt).toLocaleDateString()}
            {txn.reconciledById ? "" : " · matched automatically"}
          </div>
        )}
      </div>
      {canWrite && (
        <Button variant="secondary" size="sm" onClick={undo} loading={busy}>
          <Undo2 size={14} /> Undo
        </Button>
      )}
    </div>
  );
}

// ─────────────────────────────── Card rows ────────────────────────────────

export function CardTransactionRow({
  company,
  txn,
  accountName,
  accounts,
  onChanged,
  selection,
}: {
  company: Company;
  txn: CardTransaction;
  /** The card's name, shown when the list mixes several accounts. */
  accountName: string | null;
  accounts: Account[];
  onChanged: () => Promise<void>;
  /** Absent for a Member who can't change finances. */
  selection?: RowSelection;
}) {
  const canWrite = canWriteFinance(company);
  const dialog = useDialog();
  const background = useBackgroundAction();
  const [category, setCategory] = React.useState(txn.expenseAccountId ?? "");
  const [retrying, setRetrying] = React.useState(false);
  const [keeping, setKeeping] = React.useState(false);

  React.useEffect(() => setCategory(txn.expenseAccountId ?? ""), [txn.expenseAccountId]);

  const expenseAccounts = accounts
    .filter((account) => account.type === "expense" && (!account.archivedAt || account.id === category))
    .sort((a, b) => a.code.localeCompare(b.code));
  const failed = !txn.ledgerEntryId;
  const payment = txn.accountingKind === "payment";
  // In the books and waiting for someone to keep its category or pick another.
  const waiting = !payment && !failed && txn.needsReview;

  // Picking a category reviews the purchase, so one waiting leaves To review.
  function changeCategory(next: string) {
    const previous = category;
    setCategory(next);
    background(
      () =>
        api.patch<CardTransaction>(
          `/api/companies/${company.id}/card-transactions/${txn.id}/category`,
          { expenseAccountId: next },
        ),
      {
        title: "Couldn’t change the category",
        error: (err) => `${errorMessage(err)} The previous category has been restored.`,
        onSuccess: () => {
          if (waiting || failed) void onChanged();
        },
        onError: () => setCategory(previous),
      },
    );
  }

  async function keep() {
    setKeeping(true);
    try {
      const result = await api.post<BankingBulkResult>(
        `/api/companies/${company.id}/banking/bulk`,
        { action: "mark_reviewed", cardTransactionIds: [txn.id] },
      );
      if (result.skipped.length > 0) throw new Error(`${result.skipped[0].reason}.`);
      await onChanged();
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t mark it reviewed" });
    } finally {
      setKeeping(false);
    }
  }

  async function retry() {
    setRetrying(true);
    try {
      await api.post(`/api/companies/${company.id}/card-transactions/${txn.id}/retry`);
      await onChanged();
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t add it to the books" });
    } finally {
      setRetrying(false);
    }
  }

  const label = txn.description || "card transaction";
  return (
    <li className={clsx("flex items-stretch", rowTone(selection))}>
      {selection && <RowCheckbox selection={selection} label={`Select ${label}`} />}
      <div
        className={clsx(
          "flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-2 py-3 pr-4 sm:flex-nowrap",
          selection ? "pl-3" : "pl-4",
        )}
      >
        <span className="hidden w-[14px] sm:block" aria-hidden="true" />
        <span className="hidden w-24 shrink-0 text-xs text-slate-500 sm:block dark:text-slate-400">
          {transactionDate(txn.postedAt)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-slate-800 dark:text-slate-100">
            {txn.description || "Card transaction"}
          </span>
          <span className="mt-0.5 block truncate text-xs text-slate-500 dark:text-slate-400">
            <span className="sm:hidden">{transactionDate(txn.postedAt)} · </span>
            {accountName ?? "Card"}
            {txn.cardId ? ` · card …${txn.cardId.slice(-4)}` : ""}
            {txn.accountingKind === "refund" ? " · refund" : ""}
          </span>
          {failed && (
            <span className="mt-1 flex items-start gap-1 text-xs text-amber-700 dark:text-amber-400">
              <AlertCircle size={12} className="mt-0.5 shrink-0" />
              <span>
                Couldn&apos;t add this to the books
                {txn.postingError ? `: ${txn.postingError}` : "."}
              </span>
            </span>
          )}
        </span>
        {/* The check sits left of the category, so categories line up whether
            or not a row is waiting. */}
        <span className="order-last flex w-full items-center gap-1.5 sm:order-none sm:w-auto sm:shrink-0">
          {waiting && canWrite && (
            <button
              type="button"
              onClick={() => void keep()}
              disabled={keeping}
              aria-label={`Keep ${accountLabel(accounts, category)} for ${label}`}
              title="Keep this category and mark it reviewed"
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-amber-200 bg-white text-amber-600 shadow-sm transition hover:border-emerald-300 hover:bg-emerald-50 hover:text-emerald-700 disabled:cursor-progress dark:border-amber-500/30 dark:bg-slate-900 dark:text-amber-400 dark:hover:border-emerald-500/40 dark:hover:bg-emerald-500/10 dark:hover:text-emerald-300"
            >
              {keeping ? <ButtonSpinner /> : <Check size={14} />}
            </button>
          )}
          <span className="min-w-0 flex-1 sm:w-56 sm:flex-none">
            {payment ? (
              <span className="text-xs text-slate-500 dark:text-slate-400">Card bill payment</span>
            ) : canWrite ? (
              <Select
                value={category}
                onChange={(event) => changeCategory(event.target.value)}
                aria-label={`Category for ${label}`}
                searchPlaceholder="Search expense categories"
                className={clsx(
                  "!h-8 text-xs",
                  waiting &&
                    "!border-amber-300 !bg-amber-50/70 dark:!border-amber-500/40 dark:!bg-amber-500/10",
                )}
              >
                {expenseAccounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.code} {account.name}
                  </option>
                ))}
              </Select>
            ) : (
              <span className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-200">
                <span className="truncate">{accountLabel(accounts, category)}</span>
                {waiting && (
                  <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-500/15 dark:text-amber-300 inline-block first-letter:uppercase">
                    To review
                  </span>
                )}
              </span>
            )}
          </span>
        </span>
        <span className="w-28 shrink-0 text-right">
          {/* Brex counts a purchase as positive; on Banking money out is negative. */}
          <SignedAmount cents={-txn.amountCents} currency={txn.currency} />
        </span>
        {failed && canWrite && (
          <Button size="sm" variant="secondary" onClick={retry} loading={retrying}>
            <RotateCcw size={13} /> Retry
          </Button>
        )}
      </div>
    </li>
  );
}
