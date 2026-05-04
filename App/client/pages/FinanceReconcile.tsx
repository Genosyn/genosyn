import React from "react";
import { useOutletContext } from "react-router-dom";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Plus,
  RefreshCw,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  Account,
  api,
  BankFeed,
  BankFeedKind,
  BankTransaction,
  formatMoney,
  IntegrationConnection,
  MatchCandidate,
} from "../lib/api";
import { Breadcrumbs } from "../components/AppShell";
import { Button } from "../components/ui/Button";
import { Spinner } from "../components/ui/Spinner";
import { Modal } from "../components/ui/Modal";
import { Input } from "../components/ui/Input";
import { Select } from "../components/ui/Select";
import { useToast } from "../components/ui/Toast";
import { useDialog } from "../components/ui/Dialog";
import { FinanceOutletCtx } from "./FinanceLayout";

/**
 * Bank reconciliation. Phase D of the Finance milestone (M19).
 *
 * Single-feed view: the user picks which feed they're reconciling at
 * the top, then triages bank transactions in chronological order.
 * Each unmatched row expands inline to show candidate `InvoicePayment`s
 * scored by amount-equality + date-proximity. Matched rows show the
 * invoice they were attached to with an unmatch escape.
 */
export default function FinanceReconcile() {
  const { company } = useOutletContext<FinanceOutletCtx>();
  const { toast } = useToast();
  const dialog = useDialog();

  const [feeds, setFeeds] = React.useState<BankFeed[] | null>(null);
  const [accounts, setAccounts] = React.useState<Account[]>([]);
  const [activeFeedId, setActiveFeedId] = React.useState<string | "">("");
  const [txns, setTxns] = React.useState<BankTransaction[] | null>(null);
  const [filter, setFilter] = React.useState<"all" | "unmatched" | "matched">("unmatched");
  const [showNewFeed, setShowNewFeed] = React.useState(false);
  const [showImport, setShowImport] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const reloadFeeds = React.useCallback(async () => {
    const [fs, as] = await Promise.all([
      api.get<BankFeed[]>(`/api/companies/${company.id}/bank-feeds`),
      api.get<Account[]>(`/api/companies/${company.id}/accounts`),
    ]);
    setFeeds(fs);
    setAccounts(as);
    if (!activeFeedId && fs.length > 0) setActiveFeedId(fs[0].id);
  }, [company.id, activeFeedId]);

  const reloadTxns = React.useCallback(async () => {
    if (!activeFeedId) {
      setTxns([]);
      return;
    }
    const list = await api.get<BankTransaction[]>(
      `/api/companies/${company.id}/bank-transactions?feedId=${activeFeedId}`,
    );
    setTxns(list);
  }, [company.id, activeFeedId]);

  React.useEffect(() => {
    reloadFeeds().catch(() => setFeeds([]));
  }, [reloadFeeds]);
  React.useEffect(() => {
    reloadTxns().catch(() => setTxns([]));
  }, [reloadTxns]);

  const activeFeed = React.useMemo(
    () => feeds?.find((f) => f.id === activeFeedId) ?? null,
    [feeds, activeFeedId],
  );
  const accountById = React.useMemo(
    () => new Map(accounts.map((a) => [a.id, a])),
    [accounts],
  );

  const filteredTxns = React.useMemo(() => {
    if (!txns) return null;
    if (filter === "unmatched") return txns.filter((t) => !t.reconciledAt);
    if (filter === "matched") return txns.filter((t) => !!t.reconciledAt);
    return txns;
  }, [txns, filter]);

  async function syncFeed() {
    if (!activeFeed) return;
    setBusy(true);
    try {
      const r = await api.post<{ inserted: number; matched: number }>(
        `/api/companies/${company.id}/bank-feeds/${activeFeed.id}/sync`,
      );
      toast(
        `Pulled ${r.inserted} new transaction${r.inserted === 1 ? "" : "s"}, auto-matched ${r.matched}`,
        "success",
      );
      reloadTxns();
      reloadFeeds();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function deleteFeed() {
    if (!activeFeed) return;
    const ok = await dialog.confirm({
      title: `Delete ${activeFeed.name}?`,
      message: "This deletes the feed and every bank transaction on it.",
      variant: "danger",
      confirmLabel: "Delete",
    });
    if (!ok) return;
    try {
      await api.del(`/api/companies/${company.id}/bank-feeds/${activeFeed.id}`);
      setActiveFeedId("");
      reloadFeeds();
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
            { label: "Reconciliation" },
          ]}
        />
      </div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">
            Reconciliation
          </h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Match bank lines to recorded invoice payments. Auto-matches
            anything where the amount and date line up; you confirm the
            rest.
          </p>
        </div>
        <Button onClick={() => setShowNewFeed(true)}>
          <Plus size={14} /> New feed
        </Button>
      </div>

      {feeds === null ? (
        <div className="flex justify-center p-16">
          <Spinner size={20} />
        </div>
      ) : feeds.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-200 bg-white p-12 text-center dark:border-slate-700 dark:bg-slate-900">
          <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            No bank feeds yet
          </h3>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Connect Stripe payouts or upload a bank CSV to start
            reconciling.
          </p>
          <div className="mt-4">
            <Button onClick={() => setShowNewFeed(true)}>
              <Plus size={14} /> New feed
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <Select
              value={activeFeedId}
              onChange={(e) => setActiveFeedId(e.target.value)}
              className="!h-9 !w-72"
            >
              {feeds.map((f) => {
                const a = accountById.get(f.accountId);
                return (
                  <option key={f.id} value={f.id}>
                    {f.name} · {f.kind === "stripe_payouts" ? "Stripe" : "CSV"} ·{" "}
                    {a?.code ?? "—"} {a?.name ?? ""}
                  </option>
                );
              })}
            </Select>
            {activeFeed?.kind === "stripe_payouts" && (
              <Button variant="secondary" onClick={syncFeed} disabled={busy}>
                <RefreshCw size={14} className={busy ? "animate-spin" : ""} /> Sync
              </Button>
            )}
            {activeFeed?.kind === "csv" && (
              <Button variant="secondary" onClick={() => setShowImport(true)} disabled={busy}>
                <Upload size={14} /> Import CSV
              </Button>
            )}
            {activeFeed && (
              <Button variant="secondary" onClick={deleteFeed} disabled={busy}>
                <Trash2 size={14} /> Delete feed
              </Button>
            )}
            {activeFeed?.lastSyncAt && (
              <span className="text-xs text-slate-500 dark:text-slate-400">
                Last sync: {new Date(activeFeed.lastSyncAt).toLocaleString()}
              </span>
            )}
          </div>

          <div className="mb-3 flex flex-wrap gap-1 rounded-lg border border-slate-200 bg-white p-1 dark:border-slate-700 dark:bg-slate-900">
            {(["unmatched", "matched", "all"] as const).map((f) => {
              const count =
                f === "all"
                  ? txns?.length ?? 0
                  : f === "unmatched"
                    ? (txns ?? []).filter((t) => !t.reconciledAt).length
                    : (txns ?? []).filter((t) => !!t.reconciledAt).length;
              return (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className={
                    "rounded-md px-3 py-1.5 text-xs font-medium transition " +
                    (filter === f
                      ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300"
                      : "text-slate-500 hover:bg-slate-50 dark:text-slate-400 dark:hover:bg-slate-800")
                  }
                >
                  {f.charAt(0).toUpperCase() + f.slice(1)}{" "}
                  <span className="ml-1 text-[10px] tabular-nums text-slate-400">{count}</span>
                </button>
              );
            })}
          </div>

          {filteredTxns === null ? (
            <div className="flex justify-center p-16">
              <Spinner size={20} />
            </div>
          ) : filteredTxns.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-200 bg-white p-12 text-center dark:border-slate-700 dark:bg-slate-900">
              <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                {filter === "unmatched"
                  ? "Nothing to reconcile"
                  : "No transactions"}
              </h3>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                {filter === "unmatched"
                  ? "Every bank line on this feed has been matched."
                  : "Pull or import to populate this feed."}
              </p>
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
              <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                {filteredTxns.map((t) => (
                  <TxnRow
                    key={t.id}
                    companyId={company.id}
                    companySlug={company.slug}
                    txn={t}
                    onChanged={reloadTxns}
                  />
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      {showNewFeed && (
        <NewFeedModal
          companyId={company.id}
          accounts={accounts}
          onClose={() => setShowNewFeed(false)}
          onSaved={() => {
            setShowNewFeed(false);
            reloadFeeds();
          }}
        />
      )}
      {showImport && activeFeed && (
        <ImportCsvModal
          companyId={company.id}
          feed={activeFeed}
          onClose={() => setShowImport(false)}
          onSaved={(r) => {
            setShowImport(false);
            toast(
              `Imported ${r.inserted}, skipped ${r.skipped}, auto-matched ${r.matched}`,
              "success",
            );
            reloadTxns();
            reloadFeeds();
          }}
        />
      )}
    </div>
  );
}

// ────────────────────────── Transaction row ───────────────────────────

function TxnRow({
  companyId,
  companySlug,
  txn,
  onChanged,
}: {
  companyId: string;
  companySlug: string;
  txn: BankTransaction;
  onChanged: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [candidates, setCandidates] = React.useState<MatchCandidate[] | null>(null);
  const [busy, setBusy] = React.useState(false);
  const { toast } = useToast();

  const matched = !!txn.reconciledAt;

  async function ensureCandidates() {
    if (candidates !== null) return;
    try {
      const c = await api.get<MatchCandidate[]>(
        `/api/companies/${companyId}/bank-transactions/${txn.id}/candidates`,
      );
      setCandidates(c);
    } catch (err) {
      toast((err as Error).message, "error");
      setCandidates([]);
    }
  }

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next && !matched) ensureCandidates();
  }

  async function match(paymentId: string) {
    setBusy(true);
    try {
      await api.post(`/api/companies/${companyId}/bank-transactions/${txn.id}/match`, {
        paymentId,
      });
      onChanged();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function unmatchTxn() {
    setBusy(true);
    try {
      await api.post(`/api/companies/${companyId}/bank-transactions/${txn.id}/unmatch`);
      onChanged();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggle();
          }
        }}
        className="flex w-full cursor-pointer items-center gap-3 px-4 py-3 hover:bg-slate-50 dark:hover:bg-slate-800/40"
      >
        <span className="text-slate-400">
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
        <span className="w-24 font-mono text-xs text-slate-500 dark:text-slate-400">
          {txn.date.slice(0, 10)}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm text-slate-700 dark:text-slate-200">
          {txn.description}
        </span>
        <span
          className={
            "tabular-nums text-sm font-medium " +
            (txn.amountCents < 0
              ? "text-rose-600 dark:text-rose-400"
              : "text-emerald-700 dark:text-emerald-400")
          }
        >
          {formatMoney(txn.amountCents, "USD")}
        </span>
        {matched ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
            <Check size={10} /> Matched
          </span>
        ) : (
          <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">
            Unmatched
          </span>
        )}
      </div>
      {open && (
        <div className="border-t border-slate-100 bg-slate-50 px-4 py-3 dark:border-slate-800 dark:bg-slate-800/30">
          {matched && txn.match ? (
            <div className="flex items-center justify-between gap-3 text-sm">
              <div>
                {txn.match.kind === "payment" ? (
                  <>
                    Matched to{" "}
                    <a
                      href={`/c/${companySlug}/finance/invoices/${txn.match.invoiceSlug}`}
                      className="font-mono font-semibold text-indigo-600 hover:underline dark:text-indigo-400"
                    >
                      {txn.match.invoiceNumber}
                    </a>{" "}
                    · {txn.match.customerName}
                  </>
                ) : (
                  <>
                    Matched to manual journal entry: <em>{txn.match.memo || "(no memo)"}</em>
                  </>
                )}
                {txn.reconciledAt && (
                  <div className="text-xs text-slate-500 dark:text-slate-400">
                    Reconciled {new Date(txn.reconciledAt).toLocaleString()}
                  </div>
                )}
              </div>
              <Button variant="secondary" onClick={unmatchTxn} disabled={busy}>
                <X size={14} /> Unmatch
              </Button>
            </div>
          ) : candidates === null ? (
            <div className="flex justify-center p-4">
              <Spinner size={16} />
            </div>
          ) : candidates.length === 0 ? (
            <div className="text-sm text-slate-500 dark:text-slate-400">
              No payment candidates within the matching window. Record the
              corresponding invoice payment first, then come back.
            </div>
          ) : (
            <ul className="space-y-1.5">
              {candidates.map((c) => (
                <li
                  key={c.paymentId}
                  className="flex items-center justify-between gap-3 rounded-md border border-slate-200 bg-white p-2 text-sm dark:border-slate-700 dark:bg-slate-900"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs font-semibold text-indigo-600 dark:text-indigo-400">
                        {c.invoiceNumber}
                      </span>
                      <span className="truncate text-slate-700 dark:text-slate-200">
                        {c.customerName}
                      </span>
                    </div>
                    <div className="text-xs text-slate-500 dark:text-slate-400">
                      {c.paidAt.slice(0, 10)} · {c.method} · score{" "}
                      {(c.score * 100).toFixed(0)}%
                    </div>
                  </div>
                  <div className="tabular-nums text-sm text-slate-900 dark:text-slate-100">
                    {formatMoney(c.amountCents, "USD")}
                  </div>
                  <Button onClick={() => match(c.paymentId)} disabled={busy} size="sm">
                    Match
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}

// ────────────────────────── New feed modal ────────────────────────────

function NewFeedModal({
  companyId,
  accounts,
  onClose,
  onSaved,
}: {
  companyId: string;
  accounts: Account[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [name, setName] = React.useState("");
  const [kind, setKind] = React.useState<BankFeedKind>("csv");
  const [accountId, setAccountId] = React.useState(
    accounts.find((a) => a.code === "1100")?.id ?? "",
  );
  const [connectionId, setConnectionId] = React.useState("");
  const [stripeConns, setStripeConns] = React.useState<IntegrationConnection[]>([]);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    api
      .get<IntegrationConnection[]>(`/api/companies/${companyId}/integrations/connections`)
      .then((cs) => setStripeConns(cs.filter((c) => c.provider === "stripe")))
      .catch(() => setStripeConns([]));
  }, [companyId]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post(`/api/companies/${companyId}/bank-feeds`, {
        name: name.trim(),
        kind,
        accountId,
        connectionId: kind === "stripe_payouts" ? connectionId || null : null,
      });
      onSaved();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="New bank feed">
      <form onSubmit={save} className="space-y-4">
        <Input
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Chase #4567 or Stripe payouts"
          required
        />
        <Select label="Source" value={kind} onChange={(e) => setKind(e.target.value as BankFeedKind)}>
          <option value="csv">CSV upload</option>
          <option value="stripe_payouts">Stripe payouts</option>
        </Select>
        <Select
          label="Reconciles to account"
          value={accountId}
          onChange={(e) => setAccountId(e.target.value)}
          required
        >
          <option value="">— Pick an account —</option>
          {accounts
            .filter((a) => a.type === "asset" && !a.archivedAt)
            .map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} {a.name}
              </option>
            ))}
        </Select>
        {kind === "stripe_payouts" && (
          <Select
            label="Stripe connection"
            value={connectionId}
            onChange={(e) => setConnectionId(e.target.value)}
            required
          >
            <option value="">— Pick a Stripe connection —</option>
            {stripeConns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </Select>
        )}
        {kind === "stripe_payouts" && stripeConns.length === 0 && (
          <p className="rounded-md bg-amber-50 p-3 text-xs text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">
            No Stripe connection found. Add one under Settings → Integrations
            first.
          </p>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy || !name.trim() || !accountId}>
            Create feed
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ────────────────────────── Import CSV modal ──────────────────────────

function ImportCsvModal({
  companyId,
  feed,
  onClose,
  onSaved,
}: {
  companyId: string;
  feed: BankFeed;
  onClose: () => void;
  onSaved: (r: { inserted: number; skipped: number; matched: number }) => void;
}) {
  const { toast } = useToast();
  const [file, setFile] = React.useState<File | null>(null);
  const [busy, setBusy] = React.useState(false);

  async function upload(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(
        `/api/companies/${companyId}/bank-feeds/${feed.id}/import`,
        { method: "POST", credentials: "same-origin", body: fd },
      );
      const text = await res.text();
      const data = text ? JSON.parse(text) : null;
      if (!res.ok) throw new Error((data && data.error) || res.statusText);
      onSaved(data);
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={`Import CSV — ${feed.name}`}>
      <form onSubmit={upload} className="space-y-4">
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Pick a CSV exported from your bank. Common header names work
          (Date, Amount, Description, Reference). Duplicates are skipped
          on the (date, amount, description) triple.
        </p>
        <input
          type="file"
          accept=".csv,text/csv"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="block w-full text-sm text-slate-700 file:mr-3 file:rounded-md file:border-0 file:bg-indigo-50 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-indigo-700 dark:text-slate-200 dark:file:bg-indigo-500/10 dark:file:text-indigo-300"
        />
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy || !file}>
            <Upload size={14} /> Import
          </Button>
        </div>
      </form>
    </Modal>
  );
}

