import React from "react";
import { Link, useOutletContext, useSearchParams } from "react-router-dom";
import {
  CheckCircle2,
  ChevronDown,
  CreditCard,
  Inbox,
  Landmark,
  Plus,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Upload,
  Wallet,
} from "lucide-react";
import {
  Account,
  api,
  ApiError,
  BankFeed,
  BankingAccount,
  BrexCashAccount,
  CardCategoryDrift,
  CardFeed,
  Company,
  CompanyFinanceSettings,
  FeedSyncResponse,
  formatMoney,
  IntegrationConnection,
  MercuryAccountChoice,
  WiseBalanceChoice,
} from "../lib/api";
import {
  appliedFilterCount,
  type BankingFilters,
  bankingListQuery,
  type BankingPageResponse,
  bankingPageUrl,
  type BankingTab,
  createBankingList,
  describeFilters,
  filterProblems,
  NO_FILTERS,
  narrowedBy,
  panelFiltersActive,
} from "../lib/bankingPages";
import { describeSync, isCsvAccount, syncNotice, type SyncViewer } from "../lib/bankingSync";
import { errorMessage } from "../lib/errors";
import { canWriteFinance } from "../lib/subpages";
import { useNow } from "../lib/useNow";
import { Breadcrumbs } from "../components/AppShell";
import { useLiveRefetch } from "../components/CompanySocket";
import { CountBadge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { useDialog } from "../components/ui/Dialog";
import { Disclosure } from "../components/ui/Disclosure";
import { FormError, FormSuccess } from "../components/ui/FormError";
import { Input } from "../components/ui/Input";
import { Modal } from "../components/ui/Modal";
import { Select } from "../components/ui/Select";
import { Spinner } from "../components/ui/Spinner";
import { clsx } from "../components/ui/clsx";
import { type BankingRow, rowKey, unselectableReason } from "../lib/bankingBulk";
import { FinanceOutletCtx } from "./FinanceLayout";
import {
  ACCOUNT_GRID,
  AccountCard,
  accountKey,
  AccountPanelHeader,
  AccountStripSkeleton,
  AllAccountsCard,
  ChangeConnectionModal,
} from "./FinanceBankingAccounts";
import { BankingBulkBar, BankingSelectAll, useBankingBulk } from "./FinanceBankingBulk";
import { CardCategoryFixes } from "./FinanceBankingCardFixes";
import { BankTransactionRow, CardTransactionRow } from "./FinanceBankingTransaction";

/**
 * Banking — the company's bank accounts and cards, and every transaction on
 * them, at `/finance/banking`.
 *
 * The accounts sit across the top as cards: what each is and where it comes
 * from, its balance when the provider reports one, what waits for review, and
 * how its sync is doing — "Synced 4 min ago", "Syncing…", or "Sync failed"
 * with the reason and what fixes it. Connected accounts sync on their own in
 * the background (`server/services/bankingSync.ts`); Sync now on a card syncs
 * it at once. The All accounts card sums up what waits and whether every
 * account is keeping up.
 *
 * Picking an account narrows the list below to it. The list opens on To
 * review: the bank transactions nothing explains yet, the card purchases
 * waiting for someone to keep their category or pick another, and any card
 * purchase that couldn't be added to the books. Explaining a bank transaction
 * is a choice between three plain answers — it paid an invoice, it is already
 * in the books, or it gets a category — and Undo takes any of them back.
 * Ticking several opens the bulk bar, which categorizes, marks reviewed, or
 * sends back to review all of them at once. Bank and card accounts are
 * `BankFeed`s and `CardFeed`s underneath.
 *
 * Every transaction is reachable, however old: the list comes a page at a
 * time from `GET …/banking/transactions` — the list, filters and cursors an
 * AI Employee's `list_banking_transactions` reads — and Load older follows the
 * cursor to the next page (`lib/bankingPages.ts`). The search box and Filters
 * (dates, money in or out, amount, category) narrow it on the server.
 *
 * A read-only Member sees every account, its sync status and every
 * transaction, without the controls that add accounts, sync, import, explain,
 * tick, or undo.
 */

type Tab = BankingTab;

type Row = BankingRow;

/** One empty list while the transactions load, so the selection isn't recomputed each render. */
const NO_ROWS: Row[] = [];

/** How long the search box and the filters wait for typing to pause before reading the list. */
const FILTER_DEBOUNCE_MS = 300;

/** `value`, once it has stopped changing for `ms`. */
function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = React.useState(value);
  React.useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/** How often the page looks again while an account it shows is syncing. */
const SYNC_POLL_MS = 4_000;

/** What `Sync now` needs to know about an account. */
type SyncTarget = { kind: "bank" | "card"; id: string; name: string };

function targetOf(account: BankingAccount): SyncTarget {
  return { kind: account.kind, id: account.feed.id, name: account.feed.name };
}

const keyOfTarget = (target: SyncTarget) => `${target.kind}:${target.id}`;

export default function FinanceBanking() {
  const { company } = useOutletContext<FinanceOutletCtx>();
  const canWrite = canWriteFinance(company);
  const dialog = useDialog();
  const now = useNow(30_000);
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedId = searchParams.get("account") ?? "";
  const rawTab = searchParams.get("status");
  const tab: Tab = rawTab === "done" || rawTab === "all" ? rawTab : "review";

  const [accounts, setAccounts] = React.useState<BankingAccount[] | null>(null);
  const [ledger, setLedger] = React.useState<Account[]>([]);
  const [homeCurrency, setHomeCurrency] = React.useState("USD");
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [retrying, setRetrying] = React.useState(false);
  const list = React.useMemo(
    () =>
      createBankingList({
        describeError: (err) => errorMessage(err, "Couldn't load the transactions"),
      }),
    [],
  );
  const listState = React.useSyncExternalStore(list.subscribe, list.getSnapshot, list.getSnapshot);
  /** The search box and Filters as typed; the list reads them once typing pauses. */
  const [filters, setFilters] = React.useState<BankingFilters>(NO_FILTERS);
  const applied = useSettled(filters, FILTER_DEBOUNCE_MS);
  const [filtersOpen, setFiltersOpen] = React.useState(false);
  const [openId, setOpenId] = React.useState<string | null>(null);
  /** The Add account form, open on this kind of account. */
  const [adding, setAdding] = React.useState<NewAccountKind | null>(null);
  const [importing, setImporting] = React.useState<BankFeed | null>(null);
  const [changingConnection, setChangingConnection] = React.useState<BankingAccount | null>(null);
  /** Accounts whose Sync now hasn't answered yet, by `accountKey`. */
  const [pending, setPending] = React.useState<ReadonlySet<string>>(() => new Set());
  /** A Sync now that couldn't be asked at all — not a sync that ran and failed. */
  const [requestErrors, setRequestErrors] = React.useState<Readonly<Record<string, string>>>({});
  const [removing, setRemoving] = React.useState(false);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [cardFixes, setCardFixes] = React.useState<CardCategoryDrift[]>([]);

  const reloadAccounts = React.useCallback(async () => {
    try {
      const [found, chart, settings] = await Promise.all([
        api.get<BankingAccount[]>(`/api/companies/${company.id}/banking/accounts`),
        api.get<Account[]>(`/api/companies/${company.id}/accounts`),
        api.get<CompanyFinanceSettings>(`/api/companies/${company.id}/finance-settings`),
      ]);
      setAccounts(found);
      setLedger(chart);
      setHomeCurrency(settings.homeCurrency);
      setLoadError(null);
    } catch (err) {
      // Once the accounts are on screen a reload that fails — a poll while one
      // syncs, a live refresh — keeps them there; the next one tries again.
      setAccounts((current) => {
        if (current === null) setLoadError(errorMessage(err, "Couldn't load your accounts"));
        return current;
      });
    }
  }, [company.id]);

  React.useEffect(() => {
    void reloadAccounts();
  }, [reloadAccounts]);

  const selected = accounts?.find((account) => account.feed.id === selectedId) ?? null;
  const feedId = selected?.feed.id ?? "";
  const hasAccounts = !!accounts?.length;

  // The list's query: the account, the tab and the settled filters. Another
  // one is another view, read from its first page.
  const listQuery = React.useMemo(
    () => bankingListQuery({ feedId, tab, filters: applied }).toString(),
    [feedId, tab, applied],
  );
  React.useEffect(() => {
    if (!hasAccounts) return;
    setOpenId(null);
    const query = new URLSearchParams(listQuery);
    void list.show((request) =>
      api.get<BankingPageResponse>(bankingPageUrl(company.id, query, request)),
    );
  }, [list, hasAccounts, company.id, listQuery]);

  // After anything changes, the rows on screen are read again from the top, so
  // they and the cursor to what follows come from one reading.
  const reloadTransactions = React.useCallback(() => list.refresh(), [list]);

  const reloadAll = React.useCallback(async () => {
    await Promise.all([reloadAccounts(), reloadTransactions()]);
  }, [reloadAccounts, reloadTransactions]);

  // Card purchases Entry review moved before Banking was the one place their
  // category changes, still filed under more than one category. Only a notice:
  // if the list can't load, the rest of Banking works as it always does.
  const hasCards = !!accounts?.some((account) => account.kind === "card");
  const reloadCardFixes = React.useCallback(async () => {
    if (!hasCards) {
      setCardFixes([]);
      return;
    }
    try {
      setCardFixes(
        await api.get<CardCategoryDrift[]>(
          `/api/companies/${company.id}/card-transactions/category-drift`,
        ),
      );
    } catch {
      setCardFixes([]);
    }
  }, [company.id, hasCards]);

  React.useEffect(() => {
    void reloadCardFixes();
  }, [reloadCardFixes]);

  useLiveRefetch(["reconcile", "cardexpense"], () => void reloadAll());
  useLiveRefetch("cardexpense", () => void reloadCardFixes());
  useLiveRefetch("financeaccount", () => void reloadAccounts());

  // While an account syncs — the background sync's or a Sync now's — look
  // again every few seconds: the live refresh says when it is done, and this
  // still does where the live connection can't reach. When the last one
  // finishes, the list may have new transactions.
  const anySyncing = pending.size > 0 || !!accounts?.some((account) => account.sync.syncing);
  React.useEffect(() => {
    if (!anySyncing) return;
    const timer = window.setInterval(() => void reloadAccounts(), SYNC_POLL_MS);
    return () => window.clearInterval(timer);
  }, [anySyncing, reloadAccounts]);
  const wasSyncing = React.useRef(false);
  React.useEffect(() => {
    if (wasSyncing.current && !anySyncing) void reloadTransactions();
    wasSyncing.current = anySyncing;
  }, [anySyncing, reloadTransactions]);

  // A sync or import summary is about one account — drop it when the view moves.
  React.useEffect(() => setNotice(null), [selectedId]);

  function select(id: string) {
    const next = new URLSearchParams(searchParams);
    if (id) next.set("account", id);
    else next.delete("account");
    setSearchParams(next);
  }

  function pickTab(next: Tab) {
    const params = new URLSearchParams(searchParams);
    if (next === "review") params.delete("status");
    else params.set("status", next);
    setSearchParams(params);
  }

  const viewer: SyncViewer = { companySlug: company.slug, role: company.role, canWrite };
  // A Sync now this page is waiting on shows as syncing at once — on its card
  // and in the All accounts summary — before the server's own mark arrives.
  const shown = React.useMemo(
    () =>
      accounts?.map((account) =>
        pending.has(accountKey(account)) && !account.sync.syncing
          ? { ...account, sync: { ...account.sync, syncing: true } }
          : account,
      ) ?? null,
    [accounts, pending],
  );
  const lineOf = (account: BankingAccount) => describeSync(account, now, viewer);

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

  // The rows on screen: the pages read so far, newest first, narrowed on the
  // server by the account, the tab, the search box and Filters.
  const rows = listState.rows;
  const narrowed = narrowedBy(applied);

  const bulk = useBankingBulk({
    company,
    rows: rows ?? NO_ROWS,
    loaded: rows ?? NO_ROWS,
    // Another account, tab, search or filter is a fresh selection.
    view: `${selectedId}|${listQuery}`,
    onChanged: reloadAll,
  });
  const ticking = bulk.enabled;
  const showBulkBar = ticking && bulk.selected.length > 0;

  const scope = selected ? [selected] : (accounts ?? []);
  // On one account only its own purchases; a bank account has none.
  const visibleCardFixes = selected
    ? cardFixes.filter((drift) => drift.transaction.feedId === selected.feed.id)
    : cardFixes;
  const toReview = scope.reduce((sum, account) => sum + account.toReview, 0);
  const total = scope.reduce((sum, account) => sum + account.total, 0);
  const counts: Record<Tab, number> = { review: toReview, done: total - toReview, all: total };

  async function syncNow(target: SyncTarget) {
    const key = keyOfTarget(target);
    setPending((current) => new Set(current).add(key));
    setRequestErrors(({ [key]: _previous, ...rest }) => rest);
    setNotice(null);
    try {
      const response = await api.post<FeedSyncResponse>(
        target.kind === "bank"
          ? `/api/companies/${company.id}/bank-feeds/${target.id}/sync`
          : `/api/companies/${company.id}/card-feeds/${target.id}/sync`,
      );
      const said = syncNotice(response);
      if (said) setNotice(`${target.name}: ${said}`);
    } catch (err) {
      // A sync that ran and failed is on the account now, and its card says
      // why. Only a request that never reached the sync is said here.
      const recorded = err instanceof ApiError && [400, 404, 409].includes(err.status);
      if (!recorded) {
        setRequestErrors((current) => ({ ...current, [key]: errorMessage(err) }));
      }
    } finally {
      setPending((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
      await reloadAll();
    }
  }

  async function remove(account: BankingAccount) {
    const ok = await dialog.confirm({
      title: `Remove ${account.feed.name}?`,
      message:
        account.kind === "bank"
          ? "Its transactions leave Banking. What they already put in your books — invoice payments and categories — stays."
          : "A card can be removed only before its first sync: once its purchases are in your books, they stay.",
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

  async function retryLoad() {
    setRetrying(true);
    await reloadAccounts();
    setRetrying(false);
  }

  const shownSelected = shown?.find((account) => account.feed.id === selectedId) ?? null;
  const selectedLine = shownSelected ? lineOf(shownSelected) : null;

  return (
    <div className={clsx("page-shell p-4 sm:p-8", showBulkBar && "pb-28 sm:pb-28")}>
      <div className="mb-5">
        <Breadcrumbs
          items={[{ label: "Finance", to: `/c/${company.slug}/finance` }, { label: "Banking" }]}
        />
      </div>
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight text-slate-900 sm:text-2xl dark:text-slate-100">Banking</h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Your bank accounts and cards, and every transaction on them.
          </p>
        </div>
        {/* Up front for anyone who can write, as on every Finance page — but
            not beside the empty state, which offers it itself. */}
        {canWrite && accounts?.length !== 0 && (
          <Button onClick={() => setAdding("csv")}>
            <Plus size={14} /> Add account
          </Button>
        )}
      </header>

      {loadError ? (
        <div className="space-y-3">
          <FormError message={loadError} />
          <Button variant="secondary" onClick={() => void retryLoad()} loading={retrying}>
            <RefreshCw size={14} /> Try again
          </Button>
        </div>
      ) : accounts === null ? (
        <>
          <AccountStripSkeleton />
          <ListSkeleton className="mt-6" />
        </>
      ) : shown === null || shown.length === 0 ? (
        <NoAccounts canWrite={canWrite} onAdd={(kind) => setAdding(kind)} />
      ) : (
        <>
          <section aria-label="Accounts" className={ACCOUNT_GRID}>
            <AllAccountsCard
              accounts={shown}
              now={now}
              active={!selected}
              onSelect={() => select("")}
            />
            {shown.map((account) => (
              <AccountCard
                key={accountKey(account)}
                account={account}
                line={lineOf(account)}
                now={now}
                active={selected?.feed.id === account.feed.id}
                canWrite={canWrite}
                busy={pending.has(accountKey(account))}
                requestError={requestErrors[accountKey(account)] ?? null}
                onSelect={() => select(account.feed.id)}
                onSync={() => void syncNow(targetOf(account))}
                onImport={() => setImporting(account.feed as BankFeed)}
                onChooseConnection={() => setChangingConnection(account)}
              />
            ))}
          </section>

          <FormSuccess message={notice} className="mt-3" />
          <CardCategoryFixes
            company={company}
            drifts={visibleCardFixes}
            accounts={ledger}
            homeCurrency={homeCurrency}
            onFixed={async () => {
              await Promise.all([reloadCardFixes(), reloadAll()]);
            }}
          />

          <section
            aria-label="Transactions"
            className="mt-6 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900"
          >
            <AccountPanelHeader
              account={shownSelected}
              accounts={shown}
              ledger={ledger}
              line={selectedLine}
              canWrite={canWrite}
              removing={removing}
              onImport={() => selected && setImporting(selected.feed as BankFeed)}
              onChooseConnection={() => selected && setChangingConnection(selected)}
              onRemove={() => selected && void remove(selected)}
            />
            <div className="flex flex-col gap-3 border-b border-slate-100 p-3 sm:flex-row sm:items-center sm:justify-between dark:border-slate-800">
              <div className="-mx-1 flex gap-1 overflow-x-auto px-1" role="tablist" aria-label="Transactions">
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
                      "whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition",
                      tab === value
                        ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300"
                        : "text-slate-500 hover:bg-slate-50 dark:text-slate-400 dark:hover:bg-slate-800",
                    )}
                  >
                    {label}
                    <span className="ml-1.5 text-xs tabular-nums text-slate-400">
                      {counts[value].toLocaleString()}
                    </span>
                  </button>
                ))}
              </div>
              <div className="flex gap-2 sm:w-auto">
                <label className="relative block min-w-0 flex-1 sm:w-72 sm:flex-none">
                  <Search
                    size={14}
                    className="pointer-events-none absolute left-3 top-2.5 text-slate-400"
                  />
                  <input
                    type="search"
                    value={filters.q}
                    onChange={(event) => setFilters((current) => ({ ...current, q: event.target.value }))}
                    aria-label="Search transactions"
                    placeholder="Search description or reference"
                    maxLength={200}
                    className="h-9 w-full rounded-lg border border-slate-200 bg-white pl-9 pr-3 text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 dark:border-slate-700 dark:bg-slate-950"
                  />
                </label>
                <FiltersToggle
                  open={filtersOpen}
                  count={appliedFilterCount(filters)}
                  onToggle={() => setFiltersOpen((current) => !current)}
                />
              </div>
            </div>
            <FiltersPanel
              open={filtersOpen}
              filters={filters}
              ledger={ledger}
              homeCurrency={homeCurrency}
              onChange={(patch) => setFilters((current) => ({ ...current, ...patch }))}
              onClear={() => setFilters((current) => ({ ...NO_FILTERS, q: current.q }))}
            />

            {listState.error && (rows === null || rows.length === 0) ? (
              <div className="space-y-3 p-4">
                <FormError message={listState.error} />
                <Button size="sm" variant="secondary" onClick={() => void list.retry()}>
                  <RefreshCw size={14} /> Try again
                </Button>
              </div>
            ) : rows === null ? (
              <ListSkeleton />
            ) : rows.length === 0 ? (
              <EmptyList
                tab={tab}
                narrowed={narrowed}
                selected={selected}
                syncing={!!selected && (selected.sync.syncing || pending.has(accountKey(selected)))}
                canWrite={canWrite}
              />
            ) : (
              <>
                {listState.error && (
                  // A refresh that failed: the last good reading stays on screen.
                  <div className="flex flex-col gap-2 border-b border-slate-100 p-3 sm:flex-row sm:items-center dark:border-slate-800">
                    <FormError
                      message={`${listState.error.replace(/\.?$/, ".")} What’s shown may be out of date.`}
                      className="flex-1"
                    />
                    <Button size="sm" variant="secondary" onClick={() => void list.retry()}>
                      <RefreshCw size={14} /> Try again
                    </Button>
                  </div>
                )}
                {ticking && (
                  <BankingSelectAll
                    bulk={bulk}
                    searching={narrowed !== null}
                    partial={listState.hasMore}
                  />
                )}
                <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                  {rows.map((row) => {
                    const selection = ticking
                      ? {
                          checked: bulk.keys.has(rowKey(row)),
                          disabledReason: unselectableReason(row),
                          onToggle: (extend: boolean) => bulk.toggle(row, extend),
                        }
                      : undefined;
                    return row.kind === "bank" ? (
                      <BankTransactionRow
                        key={rowKey(row)}
                        company={company}
                        txn={row.txn}
                        accountName={nameById.get(row.txn.feedId) ?? null}
                        bankLedgerAccountId={bankAccountOf.get(row.txn.feedId)}
                        homeCurrency={homeCurrency}
                        accounts={ledger}
                        open={openId === row.id}
                        onToggle={() =>
                          setOpenId((current) => (current === row.id ? null : row.id))
                        }
                        onChanged={async () => {
                          setOpenId(null);
                          await reloadAll();
                        }}
                        selection={selection}
                      />
                    ) : (
                      <CardTransactionRow
                        key={rowKey(row)}
                        company={company}
                        txn={row.txn}
                        accountName={nameById.get(row.txn.feedId) ?? null}
                        accounts={ledger}
                        onChanged={reloadAll}
                        selection={selection}
                      />
                    );
                  })}
                </ul>
                <ListFooter
                  shown={rows.length}
                  total={listState.total}
                  hasMore={listState.hasMore}
                  narrowed={narrowed !== null}
                  loading={listState.loadingOlder}
                  error={listState.olderError}
                  onLoadOlder={() => void list.loadOlder()}
                />
              </>
            )}
          </section>
        </>
      )}

      {showBulkBar && (
        <BankingBulkBar
          bulk={bulk}
          accounts={ledger}
          bankLedgerAccountOf={(id) => bankAccountOf.get(id)}
        />
      )}

      {adding && (
        <AddAccountModal
          company={company}
          ledger={ledger}
          initialKind={adding}
          onClose={() => setAdding(null)}
          onAdded={async (feed, kind) => {
            setAdding(null);
            await reloadAccounts();
            select(feed.id);
            if (kind === "csv") setImporting(feed as BankFeed);
            // Its first sync starts now rather than at the next background pass.
            else {
              void syncNow({
                kind: isCardKind(kind) ? "card" : "bank",
                id: feed.id,
                name: feed.name,
              });
            }
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
      {changingConnection && (
        <ChangeConnectionModal
          company={company}
          account={changingConnection}
          onClose={() => setChangingConnection(null)}
          onChanged={async () => {
            const target = targetOf(changingConnection);
            setChangingConnection(null);
            await reloadAccounts();
            // Try the new Connection straight away.
            void syncNow(target);
          }}
        />
      )}
    </div>
  );
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Quiet rows while the transactions load. */
function ListSkeleton({ className }: { className?: string }) {
  return (
    <div
      className={clsx(
        "divide-y divide-slate-100 dark:divide-slate-800",
        className &&
          "overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900",
        className,
      )}
      aria-busy
      aria-label="Loading transactions"
    >
      {[0, 1, 2, 3, 4].map((index) => (
        <div key={index} className="flex animate-pulse items-center gap-4 px-4 py-3.5">
          <div className="h-3 w-14 rounded bg-slate-100 dark:bg-slate-800" />
          <div className="h-3 flex-1 rounded bg-slate-100 dark:bg-slate-800" />
          <div className="h-3 w-20 rounded bg-slate-100 dark:bg-slate-800" />
        </div>
      ))}
    </div>
  );
}

/** The toolbar button that opens Filters, with how many are set. */
function FiltersToggle({
  open,
  count,
  onToggle,
}: {
  open: boolean;
  count: number;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-controls="banking-filters"
      className={clsx(
        "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border px-3 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
        open || count > 0
          ? "border-indigo-200 bg-indigo-50 text-indigo-700 dark:border-indigo-500/30 dark:bg-indigo-500/10 dark:text-indigo-300"
          : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200 dark:hover:bg-slate-800",
      )}
    >
      <SlidersHorizontal size={14} aria-hidden="true" />
      Filters
      {count > 0 && <CountBadge count={count} tone="accent" />}
      <ChevronDown
        size={14}
        aria-hidden="true"
        className={clsx("transition-transform", open && "rotate-180")}
      />
    </button>
  );
}

function FieldProblem({ children }: { children: React.ReactNode }) {
  return <p className="mt-1 text-xs text-red-600 dark:text-red-400">{children}</p>;
}

/**
 * Filters: the dates, money in or out, amount and category the list is
 * narrowed by on the server. Closed, it still says what is set — "Filtered by
 * Jan 1 – Mar 31, 2023 · Money out" — so a filter is never applied unseen.
 */
function FiltersPanel({
  open,
  filters,
  ledger,
  homeCurrency,
  onChange,
  onClear,
}: {
  open: boolean;
  filters: BankingFilters;
  ledger: Account[];
  homeCurrency: string;
  onChange: (patch: Partial<BankingFilters>) => void;
  onClear: () => void;
}) {
  // Something typed, so there is something to clear — applied or not.
  const typed = panelFiltersActive(filters);
  const summary = describeFilters(filters, { homeCurrency, ledger });
  const problems = filterProblems(filters);
  if (!open) {
    // Closed, it names what narrows the list — or that something typed there
    // narrows nothing yet, so no setting is ever hidden.
    if (!typed) return null;
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-slate-100 px-4 py-2 text-xs dark:border-slate-800">
        {appliedFilterCount(filters) > 0 ? (
          <span className="min-w-0 text-slate-700 dark:text-slate-200">
            <span className="text-slate-500 dark:text-slate-400">Filtered by </span>
            {summary}
          </span>
        ) : (
          <span className="min-w-0 text-amber-700 dark:text-amber-400">
            A filter can&apos;t be applied as typed. Open Filters to fix it.
          </span>
        )}
        <button
          type="button"
          onClick={onClear}
          className="touch-target relative font-medium text-indigo-600 hover:underline dark:text-indigo-400"
        >
          Clear filters
        </button>
      </div>
    );
  }
  const categories = [...ledger].sort((a, b) => a.code.localeCompare(b.code));
  return (
    <div
      id="banking-filters"
      role="group"
      aria-label="Filters"
      className="border-b border-slate-100 bg-slate-50/60 p-4 dark:border-slate-800 dark:bg-slate-800/20"
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Input
          type="date"
          label="From"
          value={filters.from}
          max={filters.to || undefined}
          onChange={(event) => onChange({ from: event.target.value })}
        />
        <div>
          <Input
            type="date"
            label="To"
            value={filters.to}
            min={filters.from || undefined}
            invalid={!!problems.to}
            onChange={(event) => onChange({ to: event.target.value })}
          />
          {problems.to && <FieldProblem>{problems.to}</FieldProblem>}
        </div>
        <Select
          label="Money in or out"
          value={filters.direction}
          onChange={(event) =>
            onChange({ direction: event.target.value as BankingFilters["direction"] })
          }
        >
          <option value="">In and out</option>
          <option value="in">Money in</option>
          <option value="out">Money out</option>
        </Select>
        <div>
          <Input
            label={`Smallest amount (${homeCurrency})`}
            inputMode="decimal"
            placeholder="0.00"
            value={filters.minAmount}
            invalid={!!problems.minAmount}
            onChange={(event) => onChange({ minAmount: event.target.value })}
          />
          {problems.minAmount && <FieldProblem>{problems.minAmount}</FieldProblem>}
        </div>
        <div>
          <Input
            label={`Largest amount (${homeCurrency})`}
            inputMode="decimal"
            placeholder="Any"
            value={filters.maxAmount}
            invalid={!!problems.maxAmount}
            onChange={(event) => onChange({ maxAmount: event.target.value })}
          />
          {problems.maxAmount && <FieldProblem>{problems.maxAmount}</FieldProblem>}
        </div>
        <Select
          label="Category"
          value={filters.categoryAccountId}
          onChange={(event) => onChange({ categoryAccountId: event.target.value })}
          searchPlaceholder="Search categories"
        >
          <option value="">Any category</option>
          {categories.map((account) => (
            <option key={account.id} value={account.id}>
              {account.code} {account.name}
              {account.archivedAt ? " (archived)" : ""}
            </option>
          ))}
        </Select>
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Days are calendar days in UTC, as the list shows them. An amount matches money in and
          out alike.
        </p>
        <Button size="sm" variant="ghost" onClick={onClear} disabled={!typed}>
          Clear filters
        </Button>
      </div>
    </div>
  );
}

/**
 * Under the list: how much of it is on screen, and Load older for the next
 * page. A Load older that fails says so here, beside the button that retries.
 */
function ListFooter({
  shown,
  total,
  hasMore,
  narrowed,
  loading,
  error,
  onLoadOlder,
}: {
  shown: number;
  total: number;
  hasMore: boolean;
  narrowed: boolean;
  loading: boolean;
  error: string | null;
  onLoadOlder: () => void;
}) {
  if (!hasMore && !(narrowed && shown > 0)) return null;
  return (
    <div className="flex flex-col gap-2 border-t border-slate-100 px-4 py-3 sm:flex-row sm:items-center sm:justify-between dark:border-slate-800">
      <p
        className="text-xs tabular-nums text-slate-500 dark:text-slate-400"
        aria-live="polite"
        data-testid="banking-list-count"
      >
        {hasMore
          ? `Showing ${shown.toLocaleString()} of ${total.toLocaleString()}`
          : `${total.toLocaleString()} matching`}
      </p>
      {hasMore && (
        <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center">
          <FormError message={error} />
          <Button size="sm" variant="secondary" loading={loading} onClick={onLoadOlder}>
            {error ? <RefreshCw size={14} /> : <ChevronDown size={14} />}
            {error ? "Try again" : "Load older"}
          </Button>
        </div>
      )}
    </div>
  );
}

/** Where a company usually starts, each opening Add account on that kind. */
const STARTING_POINTS: ReadonlyArray<{
  kind: NewAccountKind;
  icon: React.ReactNode;
  title: string;
  description: string;
}> = [
  {
    kind: "csv",
    icon: <Upload size={16} />,
    title: "Any bank",
    description: "Upload the CSV statements it lets you download.",
  },
  {
    kind: "brex_cash",
    icon: <Landmark size={16} />,
    title: "Brex, Mercury or Wise",
    description: "Connect once; transactions sync on their own.",
  },
  {
    kind: "brex_card",
    icon: <CreditCard size={16} />,
    title: "Brex or Ramp card",
    description: "Purchases arrive filed under a category you can change.",
  },
  {
    kind: "stripe_payouts",
    icon: <Wallet size={16} />,
    title: "Stripe payouts",
    description: "The payouts Stripe sends to your bank.",
  },
];

function NoAccounts({
  canWrite,
  onAdd,
}: {
  canWrite: boolean;
  onAdd: (kind: NewAccountKind) => void;
}) {
  return (
    <div className="rounded-xl border border-dashed border-slate-200 bg-white px-6 py-10 text-center dark:border-slate-700 dark:bg-slate-900">
      <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400">
        <Landmark size={20} />
      </span>
      <h2 className="mt-3 text-base font-semibold text-slate-900 dark:text-slate-100">
        Add your bank accounts and cards
      </h2>
      <p className="mx-auto mt-1 max-w-xl text-sm text-slate-500 dark:text-slate-400">
        {canWrite
          ? "Bring every transaction into one list, then mark which invoices each deposit paid and give everything else a category."
          : "No bank accounts or cards have been added yet. Someone with full Finance access can add them."}
      </p>
      {canWrite && (
        <>
          <ul className="mx-auto mt-6 grid max-w-3xl gap-2 text-left sm:grid-cols-2 lg:grid-cols-4">
            {STARTING_POINTS.map((point) => (
              <li key={point.title}>
                <button
                  type="button"
                  onClick={() => onAdd(point.kind)}
                  className="h-full w-full rounded-lg border border-slate-200 p-3 text-left transition hover:border-indigo-300 hover:bg-indigo-50/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus dark:border-slate-700 dark:hover:border-indigo-700 dark:hover:bg-indigo-500/5"
                >
                  <span className="text-slate-400 dark:text-slate-500">{point.icon}</span>
                  <span className="mt-2 block text-sm font-medium text-slate-900 dark:text-slate-100">
                    {point.title}
                  </span>
                  <span className="mt-0.5 block text-xs text-slate-500 dark:text-slate-400">
                    {point.description}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <Button className="mt-6" onClick={() => onAdd("csv")}>
            <Plus size={14} /> Add account
          </Button>
        </>
      )}
    </div>
  );
}

function EmptyList({
  tab,
  narrowed,
  selected,
  syncing,
  canWrite,
}: {
  tab: Tab;
  /** What narrowed the list to nothing: the search box, or Filters too. */
  narrowed: "search" | "filters" | null;
  selected: BankingAccount | null;
  syncing: boolean;
  canWrite: boolean;
}) {
  let icon = <CheckCircle2 size={26} className="mx-auto text-slate-300 dark:text-slate-600" />;
  let title = "No transactions yet";
  let description = "";
  if (narrowed) {
    icon = <Search size={24} className="mx-auto text-slate-300 dark:text-slate-600" />;
    title =
      narrowed === "filters"
        ? "No transactions match these filters"
        : "No transactions match your search";
    description = tab === "all" ? "" : "Only this tab is searched. All includes every transaction.";
  } else if (syncing && selected && selected.total === 0) {
    icon = <Spinner size={22} />;
    title = `Bringing in ${selected.feed.name}'s transactions`;
    description = "The first sync walks its whole history, so it can take a minute.";
  } else if (tab === "review") {
    title = "You're all caught up";
    description = "Every transaction is explained. New ones show up here as they sync.";
  } else if (tab === "done") {
    icon = <Inbox size={24} className="mx-auto text-slate-300 dark:text-slate-600" />;
    title = "Nothing done yet";
    description = "Transactions you match, categorize or review move here.";
  } else if (selected) {
    icon = <Inbox size={24} className="mx-auto text-slate-300 dark:text-slate-600" />;
    description =
      isCsvAccount(selected)
        ? canWrite
          ? "Import a CSV from your bank to bring its transactions in."
          : "Someone with full Finance access can import its transactions."
        : "They show up here after its first sync.";
  }
  return (
    <div className="px-6 py-14 text-center">
      <div className="flex justify-center">{icon}</div>
      <p className="mt-3 text-sm font-medium text-slate-700 dark:text-slate-200">{title}</p>
      {description && (
        <p className="mx-auto mt-1 max-w-sm text-xs text-slate-500 dark:text-slate-400">
          {description}
        </p>
      )}
    </div>
  );
}

// ───────────────────────────── Add an account ──────────────────────────────

type NewAccountKind =
  | "csv"
  | "brex_cash"
  | "mercury_account"
  | "wise_balance"
  | "brex_card"
  | "ramp_card"
  | "stripe_payouts";

/** A card, posted to the books as it syncs, rather than a bank account. */
function isCardKind(kind: NewAccountKind): boolean {
  return kind === "brex_card" || kind === "ramp_card";
}

type AccountProvider = "brex" | "mercury" | "ramp" | "wise" | "stripe";

const PROVIDER_NAMES: Record<AccountProvider, string> = {
  brex: "Brex",
  mercury: "Mercury",
  ramp: "Ramp",
  wise: "Wise",
  stripe: "Stripe",
};

const NEW_ACCOUNT_KINDS: ReadonlyArray<{
  kind: NewAccountKind;
  title: string;
  description: string;
  defaultName: string;
  provider: AccountProvider | null;
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
    kind: "mercury_account",
    title: "Mercury account",
    description: "Bring in a Mercury checking or savings account's transactions automatically.",
    defaultName: "Mercury",
    provider: "mercury",
  },
  {
    kind: "wise_balance",
    title: "Wise balance",
    description: "Bring in a Wise balance's transactions automatically.",
    defaultName: "Wise",
    provider: "wise",
  },
  {
    kind: "brex_card",
    title: "Brex card",
    description: "Bring in card purchases automatically, each filed under a category you can change.",
    defaultName: "Brex card",
    provider: "brex",
  },
  {
    kind: "ramp_card",
    title: "Ramp card",
    description:
      "Bring in Ramp card purchases, bill payments and cashback, each purchase filed under a category you can change.",
    defaultName: "Ramp card",
    provider: "ramp",
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
  initialKind,
  onClose,
  onAdded,
}: {
  company: Company;
  ledger: Account[];
  /** The kind the form opens on — the starting point someone picked. */
  initialKind: NewAccountKind;
  onClose: () => void;
  onAdded: (feed: BankFeed | CardFeed, kind: NewAccountKind) => Promise<void>;
}) {
  const byCode = (code: string) => ledger.find((account) => account.code === code)?.id ?? "";
  const [kind, setKind] = React.useState<NewAccountKind>(initialKind);
  const [name, setName] = React.useState(
    () => NEW_ACCOUNT_KINDS.find((item) => item.kind === initialKind)!.defaultName,
  );
  const [nameTouched, setNameTouched] = React.useState(false);
  const [connections, setConnections] = React.useState<IntegrationConnection[] | null>(null);
  const [connectionId, setConnectionId] = React.useState("");
  const [cashAccounts, setCashAccounts] = React.useState<BrexCashAccount[] | null>([]);
  const [cashAccountId, setCashAccountId] = React.useState("");
  const [cashError, setCashError] = React.useState<string | null>(null);
  const [mercuryAccounts, setMercuryAccounts] = React.useState<MercuryAccountChoice[] | null>([]);
  const [mercuryAccountId, setMercuryAccountId] = React.useState("");
  const [mercuryError, setMercuryError] = React.useState<string | null>(null);
  const [wiseBalances, setWiseBalances] = React.useState<WiseBalanceChoice[] | null>([]);
  const [wiseBalanceId, setWiseBalanceId] = React.useState("");
  const [wiseError, setWiseError] = React.useState<string | null>(null);
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

  React.useEffect(() => {
    if (kind !== "mercury_account" || !connectionId) {
      setMercuryAccounts([]);
      setMercuryAccountId("");
      setMercuryError(null);
      return;
    }
    let alive = true;
    setMercuryAccounts(null);
    setMercuryError(null);
    api
      .get<MercuryAccountChoice[]>(
        `/api/companies/${company.id}/bank-feeds/mercury-accounts?connectionId=${encodeURIComponent(connectionId)}`,
      )
      .then((list) => {
        if (!alive) return;
        setMercuryAccounts(list);
        // The first account that can be added, so the common case is no choice.
        setMercuryAccountId(list.find((item) => !item.unavailableReason)?.id ?? "");
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setMercuryAccounts([]);
        setMercuryAccountId("");
        setMercuryError(errorMessage(err));
      });
    return () => {
      alive = false;
    };
  }, [company.id, connectionId, kind]);

  React.useEffect(() => {
    if (kind !== "wise_balance" || !connectionId) {
      setWiseBalances([]);
      setWiseBalanceId("");
      setWiseError(null);
      return;
    }
    let alive = true;
    setWiseBalances(null);
    setWiseError(null);
    api
      .get<WiseBalanceChoice[]>(
        `/api/companies/${company.id}/bank-feeds/wise-balances?connectionId=${encodeURIComponent(connectionId)}`,
      )
      .then((list) => {
        if (!alive) return;
        setWiseBalances(list);
        // The first balance that can be added — usually the only one in the
        // books' currency, so the common case is no choice.
        setWiseBalanceId(list.find((item) => !item.unavailableReason)?.id ?? "");
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setWiseBalances([]);
        setWiseBalanceId("");
        setWiseError(errorMessage(err));
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
    isCardKind(kind)
      ? `Purchases filed under ${named(defaultExpenseAccountId)} · card balance in ${named(liabilityAccountId)}`
      : `Posts to ${named(bankAccountId)}`;

  const ready =
    !!name.trim() &&
    !!bankAccountId &&
    (!option.provider || !!connectionId) &&
    (kind !== "brex_cash" || !!cashAccountId) &&
    (kind !== "mercury_account" || !!mercuryAccountId) &&
    (kind !== "wise_balance" || !!wiseBalanceId) &&
    (!isCardKind(kind) || (!!liabilityAccountId && !!defaultExpenseAccountId));

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      // A card's provider follows from its Connection, so Brex and Ramp cards
      // are added the same way.
      const feed =
        isCardKind(kind)
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
              externalAccountId:
                kind === "brex_cash"
                  ? cashAccountId
                  : kind === "mercury_account"
                    ? mercuryAccountId
                    : kind === "wise_balance"
                      ? wiseBalanceId
                      : null,
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
            Connect {PROVIDER_NAMES[option.provider]} first, then come back to add this account.{" "}
            <Link
              to={`/c/${company.slug}/finance/integrations`}
              className="font-medium underline"
            >
              Open Finance integrations
            </Link>
            {kind === "brex_card" && (
              <> The Brex token needs permission to read card transactions.</>
            )}
            {kind === "ramp_card" && (
              <> The Ramp app needs permission to read transactions, transfers and cashback.</>
            )}
          </p>
        ) : option.provider ? (
          <Select
            label={`${PROVIDER_NAMES[option.provider]} Connection`}
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

        {kind === "mercury_account" && connectionId && (
          <>
            {mercuryAccounts === null ? (
              <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                <Spinner size={14} /> Loading your Mercury accounts…
              </div>
            ) : (
              <Select
                label="Mercury account"
                value={mercuryAccountId}
                onChange={(event) => setMercuryAccountId(event.target.value)}
                required
              >
                <option value="">Choose an account</option>
                {mercuryAccounts.map((account) => (
                  <option key={account.id} value={account.id} disabled={!!account.unavailableReason}>
                    {account.name}
                    {account.accountNumberLast4 ? ` · •••• ${account.accountNumberLast4}` : ""}
                    {account.currentCents === null
                      ? ""
                      : ` · ${formatMoney(account.currentCents, "USD")}`}
                    {account.unavailableReason ? ` — ${account.unavailableReason}` : ""}
                  </option>
                ))}
              </Select>
            )}
            <FormError message={mercuryError} />
          </>
        )}

        {kind === "wise_balance" && connectionId && (
          <>
            {wiseBalances === null ? (
              <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                <Spinner size={14} /> Loading your Wise balances…
              </div>
            ) : (
              <Select
                label="Wise balance"
                value={wiseBalanceId}
                onChange={(event) => setWiseBalanceId(event.target.value)}
                required
              >
                <option value="">Choose a balance</option>
                {wiseBalances.map((balance) => (
                  <option key={balance.id} value={balance.id} disabled={!!balance.unavailableReason}>
                    {balance.profileName} · {balance.currency}
                    {balance.availableCents === null
                      ? ""
                      : ` · ${formatMoney(balance.availableCents, balance.currency)}`}
                    {balance.unavailableReason ? ` — ${balance.unavailableReason}` : ""}
                  </option>
                ))}
              </Select>
            )}
            <FormError message={wiseError} />
          </>
        )}

        <Disclosure title="Advanced" summary={advancedSummary}>
          <div className="space-y-4">
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Where this account&apos;s money shows up in your books. The defaults suit most
              companies; a company with several bank accounts can give each its own.
            </p>
            {isCardKind(kind) ? (
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
