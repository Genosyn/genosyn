import React from "react";
import { Link, useOutletContext, useSearchParams } from "react-router-dom";
import {
  CheckCircle2,
  CreditCard,
  Landmark,
  Layers,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  Wallet,
} from "lucide-react";
import {
  Account,
  api,
  BankFeed,
  BankingAccount,
  BankingStatus,
  BankTransaction,
  BrexCashAccount,
  CardFeed,
  CardSyncResult,
  CardTransaction,
  Company,
  CompanyFinanceSettings,
  formatMoney,
  IntegrationConnection,
} from "../lib/api";
import { errorMessage } from "../lib/errors";
import { canWriteFinance } from "../lib/subpages";
import { Breadcrumbs } from "../components/AppShell";
import { useLiveRefetch } from "../components/CompanySocket";
import { Button } from "../components/ui/Button";
import { useDialog } from "../components/ui/Dialog";
import { Disclosure } from "../components/ui/Disclosure";
import { FormError, FormSuccess } from "../components/ui/FormError";
import { Input } from "../components/ui/Input";
import { Modal } from "../components/ui/Modal";
import { Select } from "../components/ui/Select";
import { Spinner } from "../components/ui/Spinner";
import { clsx } from "../components/ui/clsx";
import { FinanceOutletCtx } from "./FinanceLayout";
import { BankTransactionRow, CardTransactionRow } from "./FinanceBankingTransaction";

/**
 * Banking — the company's bank accounts and cards, and every transaction on
 * them, at `/finance/banking`.
 *
 * The accounts sit across the top; picking one narrows the list to it. The
 * list opens on To review: the bank transactions nothing explains yet, plus
 * any card purchase that couldn't be added to the books. Explaining one is a
 * choice between three plain answers — it paid an invoice, it is already in
 * the books, or it gets a category — and Undo takes any of them back. Bank
 * and card accounts are `BankFeed`s and `CardFeed`s underneath; this page
 * replaced Reconciliation and Card expenses, which showed each kind alone.
 *
 * A read-only Member sees every account and transaction, without the
 * controls that add accounts, import, sync, explain, or undo.
 */

type Tab = BankingStatus | "all";

type Row =
  | { kind: "bank"; id: string; date: string; txn: BankTransaction }
  | { kind: "card"; id: string; date: string; txn: CardTransaction };

/** What kind of account this is, in a few words. */
function accountKindLabel(account: BankingAccount): string {
  if (account.kind === "card") return "Brex card";
  if (account.feed.kind === "brex_cash") return "Brex business account";
  if (account.feed.kind === "stripe_payouts") return "Stripe payouts";
  return "Bank account · CSV uploads";
}

function AccountIcon({ account, size = 16 }: { account: BankingAccount | null; size?: number }) {
  if (!account) return <Layers size={size} />;
  if (account.kind === "card") return <CreditCard size={size} />;
  if (account.feed.kind === "stripe_payouts") return <Wallet size={size} />;
  return <Landmark size={size} />;
}

function lastUpdated(iso: string | null): string {
  if (!iso) return "Not updated yet";
  return `Updated ${new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })}`;
}

export default function FinanceBanking() {
  const { company } = useOutletContext<FinanceOutletCtx>();
  const canWrite = canWriteFinance(company);
  const dialog = useDialog();
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedId = searchParams.get("account") ?? "";
  const rawTab = searchParams.get("status");
  const tab: Tab = rawTab === "done" || rawTab === "all" ? rawTab : "review";

  const [accounts, setAccounts] = React.useState<BankingAccount[] | null>(null);
  const [ledger, setLedger] = React.useState<Account[]>([]);
  const [homeCurrency, setHomeCurrency] = React.useState("USD");
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [bankTxns, setBankTxns] = React.useState<BankTransaction[] | null>(null);
  const [cardTxns, setCardTxns] = React.useState<CardTransaction[] | null>(null);
  const [listError, setListError] = React.useState<string | null>(null);
  const [search, setSearch] = React.useState("");
  const [openId, setOpenId] = React.useState<string | null>(null);
  const [adding, setAdding] = React.useState(false);
  const [importing, setImporting] = React.useState<BankFeed | null>(null);
  const [syncing, setSyncing] = React.useState(false);
  const [removing, setRemoving] = React.useState(false);
  const [notice, setNotice] = React.useState<string | null>(null);

  const reloadAccounts = React.useCallback(async () => {
    try {
      const [list, chart, settings] = await Promise.all([
        api.get<BankingAccount[]>(`/api/companies/${company.id}/banking/accounts`),
        api.get<Account[]>(`/api/companies/${company.id}/accounts`),
        api.get<CompanyFinanceSettings>(`/api/companies/${company.id}/finance-settings`),
      ]);
      setAccounts(list);
      setLedger(chart);
      setHomeCurrency(settings.homeCurrency);
      setLoadError(null);
    } catch (err) {
      setAccounts([]);
      setLoadError(errorMessage(err, "Couldn't load your accounts"));
    }
  }, [company.id]);

  React.useEffect(() => {
    void reloadAccounts();
  }, [reloadAccounts]);

  const selected = accounts?.find((account) => account.feed.id === selectedId) ?? null;
  const accountsLoaded = accounts !== null;
  // Which lists to load: the selected account's kind, or every kind there is.
  const wantBank = selected ? selected.kind === "bank" : !!accounts?.some((a) => a.kind === "bank");
  const wantCard = selected ? selected.kind === "card" : !!accounts?.some((a) => a.kind === "card");
  const feedId = selected?.feed.id ?? "";

  const reloadTransactions = React.useCallback(async () => {
    if (!accountsLoaded) return;
    const query = new URLSearchParams();
    if (feedId) query.set("feedId", feedId);
    if (tab !== "all") query.set("status", tab);
    const qs = query.toString() ? `?${query.toString()}` : "";
    try {
      const [bank, card] = await Promise.all([
        wantBank
          ? api.get<BankTransaction[]>(`/api/companies/${company.id}/bank-transactions${qs}`)
          : Promise.resolve([]),
        wantCard
          ? api.get<CardTransaction[]>(`/api/companies/${company.id}/card-transactions${qs}`)
          : Promise.resolve([]),
      ]);
      setBankTxns(bank);
      setCardTxns(card);
      setListError(null);
    } catch (err) {
      setBankTxns([]);
      setCardTxns([]);
      setListError(errorMessage(err, "Couldn't load the transactions"));
    }
  }, [accountsLoaded, company.id, feedId, tab, wantBank, wantCard]);

  React.useEffect(() => {
    setBankTxns(null);
    setCardTxns(null);
    setOpenId(null);
    void reloadTransactions();
  }, [reloadTransactions]);

  const reloadAll = React.useCallback(async () => {
    await Promise.all([reloadAccounts(), reloadTransactions()]);
  }, [reloadAccounts, reloadTransactions]);

  useLiveRefetch(["reconcile", "cardexpense"], () => void reloadAll());
  useLiveRefetch("financeaccount", () => void reloadAccounts());

  // A sync or import summary is about one account — drop it when the view moves.
  React.useEffect(() => setNotice(null), [selectedId]);

  function select(feedId: string) {
    const next = new URLSearchParams(searchParams);
    if (feedId) next.set("account", feedId);
    else next.delete("account");
    setSearchParams(next);
  }

  function pickTab(next: Tab) {
    const params = new URLSearchParams(searchParams);
    if (next === "review") params.delete("status");
    else params.set("status", next);
    setSearchParams(params);
  }

  const nameById = React.useMemo(
    () => new Map((accounts ?? []).map((account) => [account.feed.id, account.feed.name])),
    [accounts],
  );
  const bankAccountOf = React.useMemo(
    () =>
      new Map(
        (accounts ?? [])
          .filter((account) => account.kind === "bank")
          .map((account) => [account.feed.id, (account.feed as BankFeed).accountId]),
      ),
    [accounts],
  );

  const rows = React.useMemo<Row[] | null>(() => {
    if (bankTxns === null || cardTxns === null) return null;
    const merged: Row[] = [
      ...bankTxns.map((txn) => ({ kind: "bank" as const, id: txn.id, date: txn.date, txn })),
      ...cardTxns.map((txn) => ({ kind: "card" as const, id: txn.id, date: txn.postedAt, txn })),
    ].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    const needle = search.trim().toLowerCase();
    if (!needle) return merged;
    const accountName = (id: string | null | undefined) =>
      ledger.find((account) => account.id === id)?.name ?? "";
    return merged.filter((row) => {
      const text =
        row.kind === "bank"
          ? [
              row.txn.description,
              row.txn.reference,
              nameById.get(row.txn.feedId),
              row.txn.match?.kind === "payments"
                ? row.txn.match.payments
                    .map((payment) => `${payment.invoiceNumber} ${payment.customerName}`)
                    .join(" ")
                : accountName(row.txn.match?.categoryAccountId),
              formatMoney(Math.abs(row.txn.amountCents), homeCurrency),
            ]
          : [
              row.txn.description,
              nameById.get(row.txn.feedId),
              accountName(row.txn.expenseAccountId),
              formatMoney(Math.abs(row.txn.amountCents), row.txn.currency),
            ];
      return text.join(" ").toLowerCase().includes(needle);
    });
  }, [bankTxns, cardTxns, homeCurrency, ledger, nameById, search]);

  const scope = selected ? [selected] : (accounts ?? []);
  const toReview = scope.reduce((sum, account) => sum + account.toReview, 0);
  const total = scope.reduce((sum, account) => sum + account.total, 0);
  const counts: Record<Tab, number> = { review: toReview, done: total - toReview, all: total };

  async function sync(account: BankingAccount) {
    setSyncing(true);
    setNotice(null);
    try {
      if (account.kind === "bank") {
        const result = await api.post<{ inserted: number; matched: number }>(
          `/api/companies/${company.id}/bank-feeds/${account.feed.id}/sync`,
        );
        setNotice(
          `${plural(result.inserted, "new transaction")}` +
            (result.matched ? ` · ${result.matched} matched to payments already recorded` : ""),
        );
      } else {
        const result = await api.post<CardSyncResult>(
          `/api/companies/${company.id}/card-feeds/${account.feed.id}/sync`,
        );
        setNotice(
          `${plural(result.inserted, "new transaction")}` +
            (result.failed ? ` · ${result.failed} couldn't be added to the books` : ""),
        );
      }
      await reloadAll();
    } catch (err) {
      void dialog.error(err, { title: `Couldn’t update ${account.feed.name}` });
    } finally {
      setSyncing(false);
    }
  }

  async function remove(account: BankingAccount) {
    const ok = await dialog.confirm({
      title: `Remove ${account.feed.name}?`,
      message:
        account.kind === "bank"
          ? "Its transactions leave Banking. What they already put in your books — invoice payments and categories — stays."
          : "A card can be removed only before its first update: once its purchases are in your books, they stay.",
      variant: "danger",
      confirmLabel: "Remove",
    });
    if (!ok) return;
    setRemoving(true);
    try {
      await api.del(
        account.kind === "bank"
          ? `/api/companies/${company.id}/bank-feeds/${account.feed.id}`
          : `/api/companies/${company.id}/card-feeds/${account.feed.id}`,
      );
      select("");
      await reloadAccounts();
    } catch (err) {
      void dialog.error(err, { title: `Couldn’t remove ${account.feed.name}` });
    } finally {
      setRemoving(false);
    }
  }

  return (
    <div className="page-shell p-4 sm:p-8">
      <div className="mb-6">
        <Breadcrumbs
          items={[{ label: "Finance", to: `/c/${company.slug}/finance` }, { label: "Banking" }]}
        />
      </div>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">Banking</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-500 dark:text-slate-400">
            Your bank accounts and cards, and every transaction on them. Go through the ones waiting
            for review: say which invoices a deposit paid, or what a payment was for.
          </p>
        </div>
        {canWrite && (
          <Button onClick={() => setAdding(true)}>
            <Plus size={14} /> Add account
          </Button>
        )}
      </div>

      {loadError ? (
        <FormError message={loadError} />
      ) : accounts === null ? (
        <div className="flex justify-center p-16">
          <Spinner size={20} />
        </div>
      ) : accounts.length === 0 ? (
        <NoAccounts canWrite={canWrite} onAdd={() => setAdding(true)} />
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <AccountCard
              title="All accounts"
              subtitle={plural(accounts.length, "account")}
              account={null}
              toReview={accounts.reduce((sum, account) => sum + account.toReview, 0)}
              active={!selected}
              onClick={() => select("")}
            />
            {accounts.map((account) => (
              <AccountCard
                key={account.feed.id}
                title={account.feed.name}
                subtitle={accountKindLabel(account)}
                account={account}
                toReview={account.toReview}
                active={selected?.feed.id === account.feed.id}
                onClick={() => select(account.feed.id)}
              />
            ))}
          </div>

          {selected && (
            <AccountToolbar
              account={selected}
              ledger={ledger}
              canWrite={canWrite}
              syncing={syncing}
              removing={removing}
              onSync={() => void sync(selected)}
              onImport={() => setImporting(selected.feed as BankFeed)}
              onRemove={() => void remove(selected)}
            />
          )}
          <FormSuccess message={notice} className="mt-3" />

          <div className="mt-6 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
            <div className="flex flex-col gap-3 border-b border-slate-100 p-3 sm:flex-row sm:items-center sm:justify-between dark:border-slate-800">
              <div className="flex gap-1" role="tablist" aria-label="Transactions">
                {(
                  [
                    ["review", "To review"],
                    ["done", "Done"],
                    ["all", "All"],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    role="tab"
                    aria-selected={tab === value}
                    onClick={() => pickTab(value)}
                    className={clsx(
                      "rounded-md px-3 py-1.5 text-sm font-medium transition",
                      tab === value
                        ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300"
                        : "text-slate-500 hover:bg-slate-50 dark:text-slate-400 dark:hover:bg-slate-800",
                    )}
                  >
                    {label}
                    <span className="ml-1.5 text-xs tabular-nums text-slate-400">{counts[value]}</span>
                  </button>
                ))}
              </div>
              <label className="relative block sm:w-72">
                <Search
                  size={14}
                  className="pointer-events-none absolute left-3 top-2.5 text-slate-400"
                />
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  aria-label="Search transactions"
                  placeholder="Search description, amount, invoice…"
                  className="h-9 w-full rounded-lg border border-slate-200 bg-white pl-9 pr-3 text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 dark:border-slate-700 dark:bg-slate-950"
                />
              </label>
            </div>

            {listError ? (
              <FormError message={listError} className="m-4" />
            ) : rows === null ? (
              <div className="flex justify-center p-16">
                <Spinner size={20} />
              </div>
            ) : rows.length === 0 ? (
              <EmptyList
                tab={tab}
                searching={!!search.trim()}
                selected={selected}
                canWrite={canWrite}
              />
            ) : (
              <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                {rows.map((row) =>
                  row.kind === "bank" ? (
                    <BankTransactionRow
                      key={row.id}
                      company={company}
                      txn={row.txn}
                      accountName={nameById.get(row.txn.feedId) ?? null}
                      bankLedgerAccountId={bankAccountOf.get(row.txn.feedId)}
                      homeCurrency={homeCurrency}
                      accounts={ledger}
                      open={openId === row.id}
                      onToggle={() => setOpenId((current) => (current === row.id ? null : row.id))}
                      onChanged={async () => {
                        setOpenId(null);
                        await reloadAll();
                      }}
                    />
                  ) : (
                    <CardTransactionRow
                      key={row.id}
                      company={company}
                      txn={row.txn}
                      accountName={nameById.get(row.txn.feedId) ?? null}
                      accounts={ledger}
                      onChanged={reloadAll}
                    />
                  ),
                )}
              </ul>
            )}
          </div>
          {rows && rows.length >= 500 && (
            <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
              Showing the newest 500 of each kind. Pick an account or search to narrow the list.
            </p>
          )}
        </>
      )}

      {adding && (
        <AddAccountModal
          company={company}
          ledger={ledger}
          onClose={() => setAdding(false)}
          onAdded={async (feed, kind) => {
            setAdding(false);
            await reloadAccounts();
            select(feed.id);
            if (kind === "csv") setImporting(feed as BankFeed);
          }}
        />
      )}
      {importing && (
        <ImportCsvModal
          companyId={company.id}
          feed={importing}
          onClose={() => setImporting(null)}
          onImported={async (result) => {
            setImporting(null);
            setNotice(
              `${plural(result.inserted, "new transaction")}` +
                (result.skipped ? ` · ${result.skipped} skipped (already imported or unreadable)` : "") +
                (result.matched ? ` · ${result.matched} matched to payments already recorded` : ""),
            );
            await reloadAll();
          }}
        />
      )}
    </div>
  );
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function AccountCard({
  title,
  subtitle,
  account,
  toReview,
  active,
  onClick,
}: {
  title: string;
  subtitle: string;
  account: BankingAccount | null;
  toReview: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={clsx(
        "rounded-xl border p-4 text-left shadow-sm transition",
        active
          ? "border-indigo-300 bg-indigo-50 ring-1 ring-indigo-200 dark:border-indigo-700 dark:bg-indigo-500/10 dark:ring-indigo-900"
          : "border-slate-200 bg-white hover:border-slate-300 dark:border-slate-700 dark:bg-slate-900 dark:hover:border-slate-600",
      )}
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 text-slate-400 dark:text-slate-500">
          <AccountIcon account={account} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-slate-900 dark:text-slate-100">
            {title}
          </span>
          <span className="block truncate text-xs text-slate-500 dark:text-slate-400">
            {subtitle}
          </span>
        </span>
      </div>
      <div className="mt-3 flex items-center justify-between gap-2 text-xs">
        {toReview > 0 ? (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 font-semibold text-amber-800 dark:bg-amber-500/15 dark:text-amber-300">
            {toReview} to review
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400">
            <CheckCircle2 size={12} /> All reviewed
          </span>
        )}
        {account && (
          <span className="truncate text-slate-400 dark:text-slate-500">
            {lastUpdated(account.feed.lastSyncAt)}
          </span>
        )}
      </div>
    </button>
  );
}

function AccountToolbar({
  account,
  ledger,
  canWrite,
  syncing,
  removing,
  onSync,
  onImport,
  onRemove,
}: {
  account: BankingAccount;
  ledger: Account[];
  canWrite: boolean;
  syncing: boolean;
  removing: boolean;
  onSync: () => void;
  onImport: () => void;
  onRemove: () => void;
}) {
  const name = (id: string) => {
    const found = ledger.find((item) => item.id === id);
    return found ? `${found.code} ${found.name}` : "a missing account";
  };
  const books =
    account.kind === "bank"
      ? `Posts to ${name(account.feed.accountId)} in your books`
      : `Purchases are filed under ${name(account.feed.defaultExpenseAccountId)} until you change them · card balance in ${name(account.feed.liabilityAccountId)}`;
  const csv = account.kind === "bank" && account.feed.kind === "csv";
  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm dark:border-slate-700 dark:bg-slate-900">
      <div className="min-w-0">
        <div className="font-medium text-slate-900 dark:text-slate-100">{account.feed.name}</div>
        <div className="text-xs text-slate-500 dark:text-slate-400">
          {books} · {lastUpdated(account.feed.lastSyncAt)}
        </div>
      </div>
      {canWrite && (
        <div className="flex flex-wrap gap-2">
          {csv ? (
            <Button size="sm" onClick={onImport} disabled={removing}>
              <Upload size={14} /> Import CSV
            </Button>
          ) : (
            <Button size="sm" onClick={onSync} loading={syncing} disabled={removing}>
              <RefreshCw size={14} /> Update now
            </Button>
          )}
          <Button size="sm" variant="secondary" onClick={onRemove} loading={removing} disabled={syncing}>
            <Trash2 size={14} /> Remove
          </Button>
        </div>
      )}
    </div>
  );
}

function NoAccounts({ canWrite, onAdd }: { canWrite: boolean; onAdd: () => void }) {
  return (
    <div className="rounded-xl border border-dashed border-slate-200 bg-white p-10 text-center dark:border-slate-700 dark:bg-slate-900">
      <Landmark size={28} className="mx-auto text-slate-400 dark:text-slate-500" />
      <h2 className="mt-3 text-base font-semibold text-slate-900 dark:text-slate-100">
        Add your bank accounts and cards
      </h2>
      <p className="mx-auto mt-1 max-w-xl text-sm text-slate-500 dark:text-slate-400">
        {canWrite
          ? "Upload your bank's CSV statements, or connect Brex or Stripe to bring transactions in automatically. Then mark which invoices each deposit paid, and give everything else a category."
          : "No bank accounts or cards have been added yet. Someone with full Finance access can add them."}
      </p>
      {canWrite && (
        <Button className="mt-4" onClick={onAdd}>
          <Plus size={14} /> Add account
        </Button>
      )}
    </div>
  );
}

function EmptyList({
  tab,
  searching,
  selected,
  canWrite,
}: {
  tab: Tab;
  searching: boolean;
  selected: BankingAccount | null;
  canWrite: boolean;
}) {
  let title = "No transactions yet";
  let description = "";
  if (searching) {
    title = "No transactions match your search";
  } else if (tab === "review") {
    title = "You're all caught up";
    description = "Every transaction is explained. New ones show up here as they come in.";
  } else if (tab === "done") {
    title = "Nothing done yet";
    description = "Transactions you match or categorize move here.";
  } else if (canWrite && selected) {
    description =
      selected.kind === "bank" && selected.feed.kind === "csv"
        ? "Import a CSV from your bank to bring its transactions in."
        : "Click Update now to bring its transactions in.";
  }
  return (
    <div className="p-12 text-center">
      <CheckCircle2 size={26} className="mx-auto text-slate-300 dark:text-slate-600" />
      <p className="mt-3 text-sm font-medium text-slate-700 dark:text-slate-200">{title}</p>
      {description && <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{description}</p>}
    </div>
  );
}

// ───────────────────────────── Add an account ──────────────────────────────

type NewAccountKind = "csv" | "brex_cash" | "brex_card" | "stripe_payouts";

const NEW_ACCOUNT_KINDS: ReadonlyArray<{
  kind: NewAccountKind;
  title: string;
  description: string;
  defaultName: string;
  provider: "brex" | "stripe" | null;
}> = [
  {
    kind: "csv",
    title: "Bank account",
    description: "Upload the CSV statements your bank lets you download. Works with any bank.",
    defaultName: "Business checking",
    provider: null,
  },
  {
    kind: "brex_cash",
    title: "Brex business account",
    description: "Bring in a Brex cash account's transactions automatically.",
    defaultName: "Brex Cash",
    provider: "brex",
  },
  {
    kind: "brex_card",
    title: "Brex card",
    description: "Bring in card purchases automatically, each filed under a category you can change.",
    defaultName: "Brex card",
    provider: "brex",
  },
  {
    kind: "stripe_payouts",
    title: "Stripe payouts",
    description: "Bring in the payouts Stripe sends to your bank.",
    defaultName: "Stripe payouts",
    provider: "stripe",
  },
];

function AddAccountModal({
  company,
  ledger,
  onClose,
  onAdded,
}: {
  company: Company;
  ledger: Account[];
  onClose: () => void;
  onAdded: (feed: BankFeed | CardFeed, kind: NewAccountKind) => Promise<void>;
}) {
  const byCode = (code: string) => ledger.find((account) => account.code === code)?.id ?? "";
  const [kind, setKind] = React.useState<NewAccountKind>("csv");
  const [name, setName] = React.useState(NEW_ACCOUNT_KINDS[0].defaultName);
  const [nameTouched, setNameTouched] = React.useState(false);
  const [connections, setConnections] = React.useState<IntegrationConnection[] | null>(null);
  const [connectionId, setConnectionId] = React.useState("");
  const [cashAccounts, setCashAccounts] = React.useState<BrexCashAccount[] | null>([]);
  const [cashAccountId, setCashAccountId] = React.useState("");
  const [cashError, setCashError] = React.useState<string | null>(null);
  const [bankAccountId, setBankAccountId] = React.useState(byCode("1100"));
  const [liabilityAccountId, setLiabilityAccountId] = React.useState(byCode("2300"));
  const [defaultExpenseAccountId, setDefaultExpenseAccountId] = React.useState(byCode("6000"));
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // The chart of accounts may still be loading when the modal opens; fill the
  // defaults in once it arrives, without overriding a choice already made.
  React.useEffect(() => {
    const code = (wanted: string) => ledger.find((account) => account.code === wanted)?.id ?? "";
    setBankAccountId((current) => current || code("1100"));
    setLiabilityAccountId((current) => current || code("2300"));
    setDefaultExpenseAccountId((current) => current || code("6000"));
  }, [ledger]);

  const option = NEW_ACCOUNT_KINDS.find((item) => item.kind === kind)!;
  const providerConnections = (connections ?? []).filter(
    (connection) => connection.provider === option.provider,
  );

  React.useEffect(() => {
    api
      .get<IntegrationConnection[]>(`/api/companies/${company.id}/integrations/connections`)
      .then(setConnections)
      .catch(() => setConnections([]));
  }, [company.id]);

  // Default to the only Connection there is, so the common case is no choice.
  React.useEffect(() => {
    if (!option.provider || connections === null) return;
    const matching = connections.filter((connection) => connection.provider === option.provider);
    setConnectionId((current) =>
      matching.some((connection) => connection.id === current) ? current : (matching[0]?.id ?? ""),
    );
  }, [connections, option.provider]);

  React.useEffect(() => {
    if (kind !== "brex_cash" || !connectionId) {
      setCashAccounts([]);
      setCashAccountId("");
      setCashError(null);
      return;
    }
    let alive = true;
    setCashAccounts(null);
    setCashError(null);
    api
      .get<BrexCashAccount[]>(
        `/api/companies/${company.id}/bank-feeds/brex-accounts?connectionId=${encodeURIComponent(connectionId)}`,
      )
      .then((list) => {
        if (!alive) return;
        setCashAccounts(list);
        setCashAccountId((list.find((item) => item.primary) ?? list[0])?.id ?? "");
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setCashAccounts([]);
        setCashAccountId("");
        setCashError(errorMessage(err));
      });
    return () => {
      alive = false;
    };
  }, [company.id, connectionId, kind]);

  function pickKind(next: NewAccountKind) {
    setKind(next);
    setError(null);
    if (!nameTouched) setName(NEW_ACCOUNT_KINDS.find((item) => item.kind === next)!.defaultName);
  }

  const assets = ledger.filter((account) => account.type === "asset" && !account.archivedAt);
  const liabilities = ledger.filter((account) => account.type === "liability" && !account.archivedAt);
  const expenses = ledger.filter((account) => account.type === "expense" && !account.archivedAt);
  const named = (id: string) => {
    const account = ledger.find((item) => item.id === id);
    return account ? `${account.code} ${account.name}` : "—";
  };
  const advancedSummary =
    kind === "brex_card"
      ? `Purchases filed under ${named(defaultExpenseAccountId)} · card balance in ${named(liabilityAccountId)}`
      : `Posts to ${named(bankAccountId)}`;

  const ready =
    !!name.trim() &&
    !!bankAccountId &&
    (!option.provider || !!connectionId) &&
    (kind !== "brex_cash" || !!cashAccountId) &&
    (kind !== "brex_card" || (!!liabilityAccountId && !!defaultExpenseAccountId));

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const feed =
        kind === "brex_card"
          ? await api.post<CardFeed>(`/api/companies/${company.id}/card-feeds`, {
              name: name.trim(),
              connectionId,
              liabilityAccountId,
              defaultExpenseAccountId,
              paymentAccountId: bankAccountId,
            })
          : await api.post<BankFeed>(`/api/companies/${company.id}/bank-feeds`, {
              name: name.trim(),
              kind,
              accountId: bankAccountId,
              connectionId: kind === "csv" ? null : connectionId,
              externalAccountId: kind === "brex_cash" ? cashAccountId : null,
            });
      await onAdded(feed, kind);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="Add an account" size="lg">
      <form onSubmit={submit} className="space-y-5">
        <fieldset>
          <legend className="mb-2 text-sm font-medium text-slate-700 dark:text-slate-200">
            What kind of account?
          </legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {NEW_ACCOUNT_KINDS.map((item) => (
              <label
                key={item.kind}
                className={clsx(
                  "flex cursor-pointer gap-3 rounded-lg border p-3 text-sm transition",
                  kind === item.kind
                    ? "border-indigo-300 bg-indigo-50 ring-1 ring-indigo-200 dark:border-indigo-700 dark:bg-indigo-500/10 dark:ring-indigo-900"
                    : "border-slate-200 hover:border-slate-300 dark:border-slate-700 dark:hover:border-slate-600",
                )}
              >
                <input
                  type="radio"
                  name="account-kind"
                  value={item.kind}
                  aria-label={item.title}
                  checked={kind === item.kind}
                  onChange={() => pickKind(item.kind)}
                  className="mt-0.5 accent-indigo-600"
                />
                <span>
                  <span className="block font-medium text-slate-900 dark:text-slate-100">
                    {item.title}
                  </span>
                  <span className="mt-0.5 block text-xs text-slate-500 dark:text-slate-400">
                    {item.description}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <Input
          label="Name"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            setNameTouched(true);
          }}
          placeholder="e.g. Chase checking"
          required
          maxLength={120}
        />

        {option.provider && connections !== null && providerConnections.length === 0 ? (
          <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300">
            Connect {option.provider === "brex" ? "Brex" : "Stripe"} first, then come back to add
            this account.{" "}
            <Link
              to={`/c/${company.slug}/finance/integrations`}
              className="font-medium underline"
            >
              Open Finance integrations
            </Link>
            {kind === "brex_card" && (
              <> The Brex token needs permission to read card transactions.</>
            )}
          </p>
        ) : option.provider ? (
          <Select
            label={option.provider === "brex" ? "Brex Connection" : "Stripe Connection"}
            value={connectionId}
            onChange={(event) => setConnectionId(event.target.value)}
            disabled={connections === null}
            required
          >
            <option value="">{connections === null ? "Loading…" : "Choose a Connection"}</option>
            {providerConnections.map((connection) => (
              <option key={connection.id} value={connection.id}>
                {connection.label}
              </option>
            ))}
          </Select>
        ) : null}

        {kind === "brex_cash" && connectionId && (
          <>
            {cashAccounts === null ? (
              <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                <Spinner size={14} /> Loading your Brex cash accounts…
              </div>
            ) : (
              <Select
                label="Brex cash account"
                value={cashAccountId}
                onChange={(event) => setCashAccountId(event.target.value)}
                required
              >
                <option value="">Choose an account</option>
                {cashAccounts.map((cash) => (
                  <option key={cash.id} value={cash.id}>
                    {cash.name} · •••• {cash.accountNumberLast4} ·{" "}
                    {formatMoney(cash.currentBalance.amount, cash.currentBalance.currency ?? "USD")}
                  </option>
                ))}
              </Select>
            )}
            <FormError message={cashError} />
          </>
        )}

        <Disclosure title="Advanced" summary={advancedSummary}>
          <div className="space-y-4">
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Where this account&apos;s money shows up in your books. The defaults suit most
              companies; a company with several bank accounts can give each its own.
            </p>
            {kind === "brex_card" ? (
              <>
                <Select
                  label="Card balance (what you owe on the card)"
                  value={liabilityAccountId}
                  onChange={(event) => setLiabilityAccountId(event.target.value)}
                  required
                >
                  {liabilities.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.code} {account.name}
                    </option>
                  ))}
                </Select>
                <Select
                  label="Default category for purchases"
                  value={defaultExpenseAccountId}
                  onChange={(event) => setDefaultExpenseAccountId(event.target.value)}
                  required
                >
                  {expenses.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.code} {account.name}
                    </option>
                  ))}
                </Select>
                <Select
                  label="Bank account the card bill is paid from"
                  value={bankAccountId}
                  onChange={(event) => setBankAccountId(event.target.value)}
                  required
                >
                  {assets.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.code} {account.name}
                    </option>
                  ))}
                </Select>
              </>
            ) : (
              <Select
                label="Account in your books"
                value={bankAccountId}
                onChange={(event) => setBankAccountId(event.target.value)}
                required
              >
                {assets.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.code} {account.name}
                  </option>
                ))}
              </Select>
            )}
          </div>
        </Disclosure>

        <FormError message={error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" loading={busy} disabled={!ready}>
            Add account
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function ImportCsvModal({
  companyId,
  feed,
  onClose,
  onImported,
}: {
  companyId: string;
  feed: BankFeed;
  onClose: () => void;
  onImported: (result: { inserted: number; skipped: number; matched: number }) => Promise<void>;
}) {
  const [file, setFile] = React.useState<File | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function upload(event: React.FormEvent) {
    event.preventDefault();
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch(`/api/companies/${companyId}/bank-feeds/${feed.id}/import`, {
        method: "POST",
        credentials: "same-origin",
        body: form,
      });
      const text = await res.text();
      const data = text ? JSON.parse(text) : null;
      if (!res.ok) throw new Error((data && data.error) || res.statusText);
      await onImported(data);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={`Import transactions into ${feed.name}`}>
      <form onSubmit={upload} className="space-y-4">
        <p className="text-sm text-slate-600 dark:text-slate-300">
          Download your transactions as a CSV from your bank&apos;s website, then upload the file
          here. Genosyn reads the date, amount, and description columns, and skips anything it
          has already imported — so uploading an overlapping statement is safe.
        </p>
        <input
          type="file"
          accept=".csv,text/csv"
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          aria-label="CSV file"
          className="block w-full text-sm text-slate-700 file:mr-3 file:rounded-md file:border-0 file:bg-indigo-50 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-indigo-700 dark:text-slate-200 dark:file:bg-indigo-500/10 dark:file:text-indigo-300"
        />
        <FormError message={error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
            {feed.lastSyncAt ? "Cancel" : "Later"}
          </Button>
          <Button type="submit" loading={busy} disabled={!file}>
            <Upload size={14} /> Import
          </Button>
        </div>
      </form>
    </Modal>
  );
}
