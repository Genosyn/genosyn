import React from "react";
import { useOutletContext } from "react-router-dom";
import { AlertCircle, CheckCircle2, CreditCard, Plus, RefreshCw, Trash2 } from "lucide-react";
import {
  Account,
  api,
  CardFeed,
  CardSyncResult,
  CardTransaction,
  formatMoney,
  IntegrationConnection,
} from "../lib/api";
import { Breadcrumbs } from "../components/AppShell";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { Modal } from "../components/ui/Modal";
import { Select } from "../components/ui/Select";
import { Spinner } from "../components/ui/Spinner";
import { useDialog } from "../components/ui/Dialog";
import { useToast } from "../components/ui/Toast";
import { FinanceOutletCtx } from "./FinanceLayout";

export default function FinanceCardExpenses() {
  const { company } = useOutletContext<FinanceOutletCtx>();
  const { toast, background } = useToast();
  const dialog = useDialog();
  const [feeds, setFeeds] = React.useState<CardFeed[] | null>(null);
  const [accounts, setAccounts] = React.useState<Account[]>([]);
  const [activeFeedId, setActiveFeedId] = React.useState("");
  const [transactions, setTransactions] = React.useState<CardTransaction[] | null>(null);
  const [showNewFeed, setShowNewFeed] = React.useState(false);
  const [syncing, setSyncing] = React.useState(false);
  const [rowBusy, setRowBusy] = React.useState<string | null>(null);

  const reloadFeeds = React.useCallback(async () => {
    const [nextFeeds, nextAccounts] = await Promise.all([
      api.get<CardFeed[]>(`/api/companies/${company.id}/card-feeds`),
      api.get<Account[]>(`/api/companies/${company.id}/accounts`),
    ]);
    setFeeds(nextFeeds);
    setAccounts(nextAccounts);
    setActiveFeedId((current) => {
      if (current && nextFeeds.some((feed) => feed.id === current)) {
        return current;
      }
      return nextFeeds[0]?.id ?? "";
    });
  }, [company.id]);

  const reloadTransactions = React.useCallback(async () => {
    if (!activeFeedId) {
      setTransactions([]);
      return;
    }
    setTransactions(
      await api.get<CardTransaction[]>(
        `/api/companies/${company.id}/card-transactions?feedId=${encodeURIComponent(activeFeedId)}`,
      ),
    );
  }, [activeFeedId, company.id]);

  React.useEffect(() => {
    reloadFeeds().catch((err: Error) => {
      setFeeds([]);
      toast(err.message, "error");
    });
  }, [reloadFeeds, toast]);

  React.useEffect(() => {
    reloadTransactions().catch((err: Error) => {
      setTransactions([]);
      toast(err.message, "error");
    });
  }, [reloadTransactions, toast]);

  const activeFeed = feeds?.find((feed) => feed.id === activeFeedId) ?? null;
  const expenseAccounts = accounts.filter(
    (account) => account.type === "expense" && !account.archivedAt,
  );
  const accountById = new Map(accounts.map((account) => [account.id, account]));

  async function syncFeed() {
    if (!activeFeed) return;
    setSyncing(true);
    try {
      const result = await api.post<CardSyncResult>(
        `/api/companies/${company.id}/card-feeds/${activeFeed.id}/sync`,
      );
      toast(
        `Imported ${result.inserted}, posted ${result.posted}${
          result.failed ? `, ${result.failed} need attention` : ""
        }`,
        result.failed ? "info" : "success",
      );
      await Promise.all([reloadFeeds(), reloadTransactions()]);
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setSyncing(false);
    }
  }

  function changeCategory(transaction: CardTransaction, expenseAccountId: string) {
    setTransactions(
      (current) =>
        current?.map((item) =>
          item.id === transaction.id ? { ...item, expenseAccountId } : item,
        ) ?? current,
    );
    background(
      () =>
        api.patch<CardTransaction>(
          `/api/companies/${company.id}/card-transactions/${transaction.id}/category`,
          { expenseAccountId },
        ),
      {
        loading: "Reclassifying expense…",
        success: "Expense reclassified with an audit entry",
        error: (error) =>
          `Couldn\u2019t reclassify the expense: ${
            error instanceof Error ? error.message : "Unknown error"
          }. The previous category has been restored.`,
        onSuccess: (updated) => {
          setTransactions(
            (current) =>
              current?.map((item) => (item.id === updated.id ? updated : item)) ?? current,
          );
        },
        onError: () => {
          setTransactions(
            (current) =>
              current?.map((item) => (item.id === transaction.id ? transaction : item)) ?? current,
          );
        },
      },
    );
  }

  async function retryPosting(transaction: CardTransaction) {
    setRowBusy(transaction.id);
    try {
      await api.post(`/api/companies/${company.id}/card-transactions/${transaction.id}/retry`);
      toast("Accounting entry posted", "success");
      await reloadTransactions();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setRowBusy(null);
    }
  }

  async function deleteFeed() {
    if (!activeFeed) return;
    const confirmed = await dialog.confirm({
      title: `Delete ${activeFeed.name}?`,
      message:
        "Only feeds that have never synced can be deleted. Posted accounting entries are permanent.",
      confirmLabel: "Delete feed",
      variant: "danger",
    });
    if (!confirmed) return;
    try {
      await api.del(`/api/companies/${company.id}/card-feeds/${activeFeed.id}`);
      await reloadFeeds();
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  return (
    <div className="mx-auto max-w-6xl p-8">
      <div className="mb-6">
        <Breadcrumbs
          items={[
            { label: "Finance", to: `/c/${company.slug}/finance` },
            { label: "Card expenses" },
          ]}
        />
      </div>

      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">
            Card expenses
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-500 dark:text-slate-400">
            Sync settled Brex card activity and post purchases, refunds, and card payments against
            your expense, liability, and bank accounts.
          </p>
        </div>
        <Button onClick={() => setShowNewFeed(true)}>
          <Plus size={14} /> Connect card feed
        </Button>
      </div>

      {feeds === null ? (
        <div className="flex justify-center p-16">
          <Spinner size={20} />
        </div>
      ) : feeds.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-200 bg-white p-12 text-center dark:border-slate-700 dark:bg-slate-900">
          <CreditCard size={28} className="mx-auto text-slate-400 dark:text-slate-500" />
          <h3 className="mt-3 text-base font-semibold text-slate-900 dark:text-slate-100">
            No corporate card feed
          </h3>
          <p className="mx-auto mt-1 max-w-lg text-sm text-slate-500 dark:text-slate-400">
            Add a Brex Connection with Card Transactions access, then map its purchases to a
            liability account and a default expense category.
          </p>
          <Button className="mt-4" onClick={() => setShowNewFeed(true)}>
            <Plus size={14} /> Connect card feed
          </Button>
        </div>
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <Select
              value={activeFeedId}
              onChange={(event) => setActiveFeedId(event.target.value)}
              className="!h-9 !w-72"
            >
              {feeds.map((feed) => (
                <option key={feed.id} value={feed.id}>
                  {feed.name}
                </option>
              ))}
            </Select>
            <Button variant="secondary" onClick={syncFeed} disabled={syncing}>
              <RefreshCw size={14} className={syncing ? "animate-spin" : ""} /> Sync
            </Button>
            <Button variant="secondary" onClick={deleteFeed} disabled={syncing}>
              <Trash2 size={14} /> Delete feed
            </Button>
            {activeFeed?.lastSyncAt && (
              <span className="text-xs text-slate-500 dark:text-slate-400">
                Last sync: {new Date(activeFeed.lastSyncAt).toLocaleString()}
              </span>
            )}
          </div>

          {activeFeed && (
            <div className="mb-4 grid gap-3 sm:grid-cols-3">
              <MappingCard
                label="Card liability"
                value={accountById.get(activeFeed.liabilityAccountId)}
              />
              <MappingCard
                label="Default category"
                value={accountById.get(activeFeed.defaultExpenseAccountId)}
              />
              <MappingCard
                label="Payment account"
                value={accountById.get(activeFeed.paymentAccountId)}
              />
            </div>
          )}

          {transactions === null ? (
            <div className="flex justify-center p-16">
              <Spinner size={20} />
            </div>
          ) : transactions.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-200 bg-white p-12 text-center dark:border-slate-700 dark:bg-slate-900">
              <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                No settled card transactions
              </h3>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                Click Sync to pull the complete settled history from Brex.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500 dark:border-slate-700 dark:bg-slate-800/50 dark:text-slate-400">
                  <tr>
                    <th className="px-4 py-3 font-medium">Date</th>
                    <th className="px-4 py-3 font-medium">Merchant</th>
                    <th className="px-4 py-3 font-medium">Type</th>
                    <th className="px-4 py-3 font-medium">Category</th>
                    <th className="px-4 py-3 text-right font-medium">Amount</th>
                    <th className="px-4 py-3 font-medium">Accounting</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {transactions.map((transaction) => (
                    <tr key={transaction.id}>
                      <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-slate-500 dark:text-slate-400">
                        {transaction.postedAt.slice(0, 10)}
                      </td>
                      <td className="max-w-xs px-4 py-3">
                        <div className="truncate font-medium text-slate-800 dark:text-slate-100">
                          {transaction.description || "Brex card transaction"}
                        </div>
                        {transaction.cardId && (
                          <div className="font-mono text-[11px] text-slate-400">
                            Card …{transaction.cardId.slice(-6)}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span className="rounded-full bg-slate-100 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                          {transaction.accountingKind}
                        </span>
                      </td>
                      <td className="min-w-52 px-4 py-3">
                        {transaction.accountingKind === "payment" ? (
                          <span className="text-xs text-slate-500 dark:text-slate-400">
                            Liability payment
                          </span>
                        ) : (
                          <Select
                            value={transaction.expenseAccountId ?? ""}
                            onChange={(event) => changeCategory(transaction, event.target.value)}
                            disabled={rowBusy === transaction.id}
                            className="!h-8 text-xs"
                          >
                            {expenseAccounts.map((account) => (
                              <option key={account.id} value={account.id}>
                                {account.code} {account.name}
                              </option>
                            ))}
                          </Select>
                        )}
                      </td>
                      <td
                        className={
                          "whitespace-nowrap px-4 py-3 text-right font-medium tabular-nums " +
                          (transaction.amountCents > 0
                            ? "text-rose-600 dark:text-rose-400"
                            : "text-emerald-700 dark:text-emerald-400")
                        }
                      >
                        {formatMoney(transaction.amountCents, transaction.currency)}
                      </td>
                      <td className="px-4 py-3">
                        {transaction.ledgerEntryId ? (
                          <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 dark:text-emerald-400">
                            <CheckCircle2 size={13} /> Posted
                          </span>
                        ) : (
                          <div>
                            <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-700 dark:text-amber-400">
                              <AlertCircle size={13} /> Needs attention
                            </span>
                            {transaction.postingError && (
                              <div
                                className="mt-1 max-w-64 text-[11px] text-slate-500 dark:text-slate-400"
                                title={transaction.postingError}
                              >
                                {transaction.postingError}
                              </div>
                            )}
                            <Button
                              size="sm"
                              variant="secondary"
                              className="mt-2"
                              onClick={() => retryPosting(transaction)}
                              disabled={rowBusy === transaction.id}
                            >
                              Retry
                            </Button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {showNewFeed && (
        <NewCardFeedModal
          companyId={company.id}
          accounts={accounts}
          onClose={() => setShowNewFeed(false)}
          onSaved={async () => {
            setShowNewFeed(false);
            await reloadFeeds();
          }}
        />
      )}
    </div>
  );
}

function MappingCard({ label, value }: { label: string; value: Account | undefined }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-900">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
        {label}
      </div>
      <div className="mt-0.5 truncate text-sm text-slate-700 dark:text-slate-200">
        {value ? `${value.code} ${value.name}` : "Missing account"}
      </div>
    </div>
  );
}

function NewCardFeedModal({
  companyId,
  accounts,
  onClose,
  onSaved,
}: {
  companyId: string;
  accounts: Account[];
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const { toast } = useToast();
  const [connections, setConnections] = React.useState<IntegrationConnection[] | null>(null);
  const [name, setName] = React.useState("Brex corporate card");
  const [connectionId, setConnectionId] = React.useState("");
  const [liabilityAccountId, setLiabilityAccountId] = React.useState(
    accounts.find((account) => account.code === "2300")?.id ?? "",
  );
  const [defaultExpenseAccountId, setDefaultExpenseAccountId] = React.useState(
    accounts.find((account) => account.code === "6000")?.id ?? "",
  );
  const [paymentAccountId, setPaymentAccountId] = React.useState(
    accounts.find((account) => account.code === "1100")?.id ?? "",
  );
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    api
      .get<IntegrationConnection[]>(`/api/companies/${companyId}/integrations/connections`)
      .then((items) => {
        const brex = items.filter((connection) => connection.provider === "brex");
        setConnections(brex);
        setConnectionId(brex[0]?.id ?? "");
      })
      .catch(() => setConnections([]));
  }, [companyId]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await api.post(`/api/companies/${companyId}/card-feeds`, {
        name,
        connectionId,
        liabilityAccountId,
        defaultExpenseAccountId,
        paymentAccountId,
      });
      await onSaved();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  const liabilities = accounts.filter(
    (account) => account.type === "liability" && !account.archivedAt,
  );
  const expenses = accounts.filter((account) => account.type === "expense" && !account.archivedAt);
  const assets = accounts.filter((account) => account.type === "asset" && !account.archivedAt);

  return (
    <Modal open onClose={onClose} title="Connect Brex card">
      <form className="space-y-4" onSubmit={save}>
        <Input
          label="Feed name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
        />
        <Select
          label="Brex Connection"
          value={connectionId}
          onChange={(event) => setConnectionId(event.target.value)}
          required
          disabled={connections === null}
        >
          <option value="">
            {connections === null ? "Loading Connections…" : "— Pick a Connection —"}
          </option>
          {(connections ?? []).map((connection) => (
            <option key={connection.id} value={connection.id}>
              {connection.label}
            </option>
          ))}
        </Select>
        {connections?.length === 0 && (
          <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300">
            Create a Brex Connection under Settings → Integrations first. Its user token needs
            transactions.card.readonly.
          </p>
        )}
        <Select
          label="Card liability account"
          value={liabilityAccountId}
          onChange={(event) => setLiabilityAccountId(event.target.value)}
          required
        >
          <option value="">— Pick a liability —</option>
          {liabilities.map((account) => (
            <option key={account.id} value={account.id}>
              {account.code} {account.name}
            </option>
          ))}
        </Select>
        <Select
          label="Default expense category"
          value={defaultExpenseAccountId}
          onChange={(event) => setDefaultExpenseAccountId(event.target.value)}
          required
        >
          <option value="">— Pick an expense account —</option>
          {expenses.map((account) => (
            <option key={account.id} value={account.id}>
              {account.code} {account.name}
            </option>
          ))}
        </Select>
        <Select
          label="Card payment account"
          value={paymentAccountId}
          onChange={(event) => setPaymentAccountId(event.target.value)}
          required
        >
          <option value="">— Pick a bank asset —</option>
          {assets.map((account) => (
            <option key={account.id} value={account.id}>
              {account.code} {account.name}
            </option>
          ))}
        </Select>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={
              busy ||
              !connectionId ||
              !liabilityAccountId ||
              !defaultExpenseAccountId ||
              !paymentAccountId
            }
          >
            {busy ? <Spinner size={14} /> : <CreditCard size={14} />}
            Connect
          </Button>
        </div>
      </form>
    </Modal>
  );
}
