import React from "react";
import { Link } from "react-router-dom";
import { AlertCircle, Check, ChevronDown, ChevronRight, RotateCcw, Search, Undo2 } from "lucide-react";
import {
  Account,
  AccountType,
  api,
  BankTransaction,
  CardTransaction,
  Company,
  formatMoney,
  MatchCandidate,
  OpenInvoiceCandidate,
} from "../lib/api";
import { errorMessage } from "../lib/errors";
import { ledgerSourceLabel } from "../lib/ledgerSources";
import { canWriteFinance } from "../lib/subpages";
import { Button } from "../components/ui/Button";
import { useBackgroundAction, useDialog } from "../components/ui/Dialog";
import { FormError } from "../components/ui/FormError";
import { Select } from "../components/ui/Select";
import { Spinner } from "../components/ui/Spinner";

/**
 * One transaction on Banking. A bank transaction opens to the three ways it
 * can be explained — it paid an invoice, it is something already in the
 * books, or it gets a category — and, once explained, to what explains it and
 * an Undo. A card transaction is already in the books under its card's
 * default category, so its row is just that category, changeable in place.
 */

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

/** What explains a bank transaction, in a few words for its row. */
function outcomeSummary(txn: BankTransaction, accounts: Account[]): string {
  const match = txn.match;
  if (!match) return "Matched";
  if (match.kind === "payment") return `Paid ${match.invoiceNumber}`;
  if (match.categoryAccountId) {
    return accounts.find((account) => account.id === match.categoryAccountId)?.name ?? "Categorized";
  }
  return ledgerSourceLabel(match.source, match.sourceRefId);
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
}) {
  const done = !!txn.reconciledAt;
  return (
    <li>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-slate-50 dark:hover:bg-slate-800/40"
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
          <span className="hidden rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-800 md:inline-flex dark:bg-amber-500/15 dark:text-amber-300">
            To review
          </span>
        )}
        <span className="w-28 shrink-0 text-right">
          <SignedAmount cents={txn.amountCents} currency={homeCurrency} />
        </span>
      </button>
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
      <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
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
  const incoming = txn.amountCents > 0;
  const [invoices, setInvoices] = React.useState<OpenInvoiceCandidate[] | null>(null);
  const [matches, setMatches] = React.useState<MatchCandidate[] | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [showAllInvoices, setShowAllInvoices] = React.useState(false);
  const [showAllMatches, setShowAllMatches] = React.useState(false);
  const [invoiceSearch, setInvoiceSearch] = React.useState("");
  const [category, setCategory] = React.useState("");
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let alive = true;
    Promise.all([
      incoming
        ? api.get<OpenInvoiceCandidate[]>(
            `/api/companies/${company.id}/bank-transactions/${txn.id}/open-invoices`,
          )
        : Promise.resolve([]),
      api.get<MatchCandidate[]>(`/api/companies/${company.id}/bank-transactions/${txn.id}/candidates`),
    ])
      .then(([open, recorded]) => {
        if (!alive) return;
        setInvoices(open);
        setMatches(recorded);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setInvoices([]);
        setMatches([]);
        setLoadError(errorMessage(err, "Couldn't load the suggestions"));
      });
    return () => {
      alive = false;
    };
  }, [company.id, incoming, txn.id]);

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

  function payInvoice(invoice: OpenInvoiceCandidate) {
    void run(`invoice:${invoice.invoiceId}`, () =>
      api.post(`/api/companies/${company.id}/bank-transactions/${txn.id}/pay-invoice`, {
        invoiceId: invoice.invoiceId,
      }),
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

  const needle = invoiceSearch.trim().toLowerCase();
  const shownInvoices = (invoices ?? [])
    .filter(
      (invoice) =>
        !needle ||
        `${invoice.number} ${invoice.customerName}`.toLowerCase().includes(needle),
    )
    .slice(0, showAllInvoices ? undefined : TOP_INVOICES);
  const sameAmount = (matches ?? []).filter(
    (candidate) => Math.abs(candidate.amountCents) === Math.abs(txn.amountCents),
  );
  const shownMatches = showAllMatches ? (matches ?? []) : sameAmount;
  const hiddenMatches = (matches ?? []).length - sameAmount.length;

  if (invoices === null || matches === null) {
    return (
      <div className="flex justify-center border-t border-slate-100 bg-slate-50 p-6 dark:border-slate-800 dark:bg-slate-800/30">
        <Spinner size={16} />
      </div>
    );
  }

  return (
    <div className="space-y-5 border-t border-slate-100 bg-slate-50 px-4 py-4 sm:pl-11 dark:border-slate-800 dark:bg-slate-800/30">
      {loadError && <FormError message={loadError} />}

      {incoming && (
        <PanelSection
          title="Did this pay an invoice?"
          hint={
            canWrite
              ? "Mark it paid: the deposit is recorded as the invoice's payment, on the day it arrived."
              : undefined
          }
        >
          {invoices.length === 0 ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">
              No invoices in {homeCurrency} are waiting for payment.
            </p>
          ) : (
            <>
              {showAllInvoices && (
                <label className="relative mb-2 block sm:w-72">
                  <Search size={14} className="pointer-events-none absolute left-3 top-2.5 text-slate-400" />
                  <input
                    value={invoiceSearch}
                    onChange={(event) => setInvoiceSearch(event.target.value)}
                    placeholder="Search invoice or customer"
                    aria-label="Search open invoices"
                    className="h-9 w-full rounded-lg border border-slate-200 bg-white pl-9 pr-3 text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 dark:border-slate-700 dark:bg-slate-950"
                  />
                </label>
              )}
              <ul
                className={
                  "space-y-1.5 " + (showAllInvoices ? "max-h-72 overflow-y-auto pr-1" : "")
                }
              >
                {shownInvoices.map((invoice) => (
                  <li
                    key={invoice.invoiceId}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-slate-200 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-900"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2 text-sm">
                        <Link
                          to={`/c/${company.slug}/finance/invoices/${invoice.slug}`}
                          className="font-mono text-xs font-semibold text-indigo-600 hover:underline dark:text-indigo-400"
                        >
                          {invoice.number}
                        </Link>
                        <span className="truncate text-slate-700 dark:text-slate-200">
                          {invoice.customerName}
                        </span>
                        {invoice.exactAmount && <Tag>Same amount</Tag>}
                        {invoice.mentioned && <Tag>Named in the description</Tag>}
                      </div>
                      <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                        {formatMoney(invoice.balanceCents, invoice.currency)} due · due{" "}
                        {transactionDate(invoice.dueDate)}
                        {invoice.exceedsBalance && (
                          <>
                            {" · "}
                            <span className="text-amber-700 dark:text-amber-400">
                              this deposit is more than what&apos;s due — record it on the invoice
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                    {canWrite && (
                      <Button
                        size="sm"
                        variant={invoice.exactAmount ? "primary" : "secondary"}
                        onClick={() => payInvoice(invoice)}
                        loading={busy === `invoice:${invoice.invoiceId}`}
                        disabled={busy !== null || invoice.exceedsBalance}
                      >
                        Mark paid
                      </Button>
                    )}
                  </li>
                ))}
                {shownInvoices.length === 0 && (
                  <li className="text-sm text-slate-500 dark:text-slate-400">No matching invoices.</li>
                )}
              </ul>
              {invoices.length > TOP_INVOICES && (
                <button
                  type="button"
                  onClick={() => setShowAllInvoices((value) => !value)}
                  className="mt-2 text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400"
                >
                  {showAllInvoices ? "Show fewer" : `Show all ${invoices.length} open invoices`}
                </button>
              )}
            </>
          )}
        </PanelSection>
      )}

      {(matches.length > 0 || !incoming) && (
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

      {canWrite && (
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
  const amount = formatMoney(Math.abs(txn.amountCents), homeCurrency);

  async function undo() {
    let title = "Undo this match?";
    let message: React.ReactNode =
      "The entry stays in your books, and this transaction goes back to To review.";
    if (match?.kind === "payment" && match.recordedHere) {
      title = `Take the payment off ${match.invoiceNumber}?`;
      message = `The ${formatMoney(match.amountCents, homeCurrency)} payment comes off ${match.invoiceNumber}, which will show that much due again, and this transaction goes back to To review.`;
    } else if (match?.kind === "payment") {
      message = `The payment stays on ${match.invoiceNumber}; only the link to this transaction is removed, and it goes back to To review.`;
    } else if (match?.kind === "ledger_entry" && match.categoryAccountId) {
      title = "Remove the category?";
      message = `Genosyn reverses the ${amount} it filed under ${accountLabel(accounts, match.categoryAccountId)}, and this transaction goes back to To review.`;
    }
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
        {match?.kind === "payment" ? (
          <>
            Paid{" "}
            <Link
              to={`/c/${company.slug}/finance/invoices/${match.invoiceSlug}`}
              className="font-mono text-xs font-semibold text-indigo-600 hover:underline dark:text-indigo-400"
            >
              {match.invoiceNumber}
            </Link>{" "}
            from {match.customerName}
            {match.amountCents !== Math.abs(txn.amountCents) && (
              <span className="text-slate-500 dark:text-slate-400">
                {" "}
                ({formatMoney(match.amountCents, homeCurrency)} of it)
              </span>
            )}
          </>
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
}: {
  company: Company;
  txn: CardTransaction;
  /** The card's name, shown when the list mixes several accounts. */
  accountName: string | null;
  accounts: Account[];
  onChanged: () => Promise<void>;
}) {
  const canWrite = canWriteFinance(company);
  const dialog = useDialog();
  const background = useBackgroundAction();
  const [category, setCategory] = React.useState(txn.expenseAccountId ?? "");
  const [retrying, setRetrying] = React.useState(false);

  React.useEffect(() => setCategory(txn.expenseAccountId ?? ""), [txn.expenseAccountId]);

  const expenseAccounts = accounts
    .filter((account) => account.type === "expense" && (!account.archivedAt || account.id === category))
    .sort((a, b) => a.code.localeCompare(b.code));
  const failed = !txn.ledgerEntryId;

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
        onError: () => setCategory(previous),
      },
    );
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

  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 sm:flex-nowrap">
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
      <span className="order-last w-full sm:order-none sm:w-56 sm:shrink-0">
        {txn.accountingKind === "payment" ? (
          <span className="text-xs text-slate-500 dark:text-slate-400">Card bill payment</span>
        ) : canWrite ? (
          <Select
            value={category}
            onChange={(event) => changeCategory(event.target.value)}
            aria-label={`Category for ${txn.description || "card transaction"}`}
            searchPlaceholder="Search expense categories"
            className="!h-8 text-xs"
          >
            {expenseAccounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.code} {account.name}
              </option>
            ))}
          </Select>
        ) : (
          <span className="text-xs text-slate-700 dark:text-slate-200">
            {accountLabel(accounts, category)}
          </span>
        )}
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
    </li>
  );
}
