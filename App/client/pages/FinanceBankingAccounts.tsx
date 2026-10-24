import React from "react";
import { Link } from "react-router-dom";
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  CreditCard,
  Landmark,
  Layers,
  MoreHorizontal,
  Plug,
  RefreshCw,
  Trash2,
  Upload,
  Wallet,
} from "lucide-react";
import {
  Account,
  api,
  BankingAccount,
  Company,
  IntegrationConnection,
} from "../lib/api";
import {
  accountSubtitle,
  formatBalance,
  isCsvAccount,
  summarizeSync,
  syncAge,
  type SyncLine,
  type SyncTone,
} from "../lib/bankingSync";
import { errorMessage } from "../lib/errors";
import { canWriteFinance } from "../lib/subpages";
import { FinanceReadOnlyNote } from "../components/finance/FinanceReadOnly";
import { Button } from "../components/ui/Button";
import { FormError } from "../components/ui/FormError";
import { Menu, MenuItem, MenuSeparator } from "../components/ui/Menu";
import { Modal } from "../components/ui/Modal";
import { Select } from "../components/ui/Select";
import { ButtonSpinner, Spinner } from "../components/ui/Spinner";
import { clsx } from "../components/ui/clsx";

/**
 * Banking's account strip: one card per bank account and card, with what it
 * is, where it comes from, its balance when the provider reports one, what
 * waits for review, and how its sync is doing — plus the All accounts card
 * that sums them up. And the header above the transaction list for the
 * account that is open, with the actions that change it.
 *
 * A card is a button that opens its account, so the controls inside it —
 * Sync now, Reconnect — sit above that button rather than in it: a control
 * nested in a button is neither valid nor reachable by keyboard.
 */

/**
 * The strip's columns: as many cards of at least 15.5rem as the page has room
 * for — one on a phone, three beside the Finance rail on a laptop — so a name
 * and its provider line read in full instead of being cut to fit a fixed grid.
 */
export const ACCOUNT_GRID = "grid grid-cols-[repeat(auto-fill,minmax(15.5rem,1fr))] gap-3";

/** The key Banking keeps per-account state under: bank and card ids never collide. */
export function accountKey(account: BankingAccount): string {
  return `${account.kind}:${account.feed.id}`;
}

export function AccountIcon({
  account,
  size = 16,
}: {
  account: BankingAccount | null;
  size?: number;
}) {
  if (!account) return <Layers size={size} />;
  if (account.kind === "card") return <CreditCard size={size} />;
  if (account.feed.kind === "stripe_payouts") return <Wallet size={size} />;
  return <Landmark size={size} />;
}

function IconTile({ account, active }: { account: BankingAccount | null; active: boolean }) {
  return (
    <span
      className={clsx(
        "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg",
        active
          ? "bg-indigo-100 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300"
          : "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400",
      )}
    >
      <AccountIcon account={account} />
    </span>
  );
}

const TONE_TEXT: Record<SyncTone, string> = {
  ok: "text-slate-500 dark:text-slate-400",
  syncing: "text-indigo-600 dark:text-indigo-300",
  stale: "text-amber-700 dark:text-amber-300",
  error: "text-red-700 dark:text-red-300",
  muted: "text-slate-500 dark:text-slate-400",
};

/** The dot, spinner or mark before a sync line. */
export function SyncMark({ tone }: { tone: SyncTone }) {
  if (tone === "syncing") return <ButtonSpinner size={12} />;
  if (tone === "error") return <AlertCircle size={12} className="shrink-0" />;
  if (tone === "stale") return <Clock size={12} className="shrink-0" />;
  return (
    <span
      aria-hidden
      className={clsx(
        "h-1.5 w-1.5 shrink-0 rounded-full",
        tone === "ok" ? "bg-emerald-500" : "bg-slate-300 dark:bg-slate-600",
      )}
    />
  );
}

function ReviewCount({ count }: { count: number }) {
  return count > 0 ? (
    <span className="whitespace-nowrap rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold tabular-nums text-amber-800 dark:bg-amber-500/15 dark:text-amber-300">
      {count.toLocaleString()} to review
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 whitespace-nowrap text-xs text-emerald-700 dark:text-emerald-400">
      <CheckCircle2 size={12} /> All reviewed
    </span>
  );
}

function cardFrame(active: boolean): string {
  return clsx(
    "group relative flex min-w-0 flex-col rounded-xl border bg-white p-4 shadow-sm transition dark:bg-slate-900",
    active
      ? "border-indigo-300 ring-1 ring-indigo-200 dark:border-indigo-700 dark:ring-indigo-900/60"
      : "border-slate-200 hover:border-slate-300 dark:border-slate-700 dark:hover:border-slate-600",
  );
}

/** The whole card is the button that opens the account, under its content. */
function SelectLayer({
  label,
  active,
  onSelect,
}: {
  label: string;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      aria-label={label}
      className="absolute inset-0 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
    />
  );
}

export function AllAccountsCard({
  accounts,
  now,
  active,
  onSelect,
}: {
  accounts: BankingAccount[];
  now: Date;
  active: boolean;
  onSelect: () => void;
}) {
  const toReview = accounts.reduce((sum, account) => sum + account.toReview, 0);
  const health = summarizeSync(accounts, now);
  return (
    <div className={cardFrame(active)} data-testid="banking-account-all">
      <SelectLayer label="Show all accounts" active={active} onSelect={onSelect} />
      <div className="pointer-events-none flex items-start gap-3">
        <IconTile account={null} active={active} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">
            All accounts
          </div>
          <div className="truncate text-xs text-slate-500 dark:text-slate-400">
            {accounts.length} {accounts.length === 1 ? "account" : "accounts"}
          </div>
        </div>
      </div>
      <div className="pointer-events-none mt-4 flex items-baseline gap-1.5">
        <span className="text-xl font-semibold tabular-nums text-slate-900 dark:text-slate-100">
          {toReview.toLocaleString()}
        </span>
        <span className="text-xs text-slate-500 dark:text-slate-400">to review</span>
      </div>
      <div
        className={clsx(
          "pointer-events-none mt-auto flex items-center gap-1.5 pt-3 text-xs",
          TONE_TEXT[health.tone],
        )}
        data-testid="banking-sync-summary"
      >
        <SyncMark tone={health.tone} />
        <span className="truncate">{health.label}</span>
      </div>
    </div>
  );
}

export function AccountCard({
  account,
  line,
  now,
  active,
  canWrite,
  busy,
  requestError,
  onSelect,
  onSync,
  onImport,
  onChooseConnection,
}: {
  account: BankingAccount;
  line: SyncLine;
  now: Date;
  active: boolean;
  canWrite: boolean;
  /** This page asked for a sync that hasn't answered yet. */
  busy: boolean;
  /** Sync now itself couldn't be asked — the request never reached the sync. */
  requestError: string | null;
  onSelect: () => void;
  onSync: () => void;
  onImport: () => void;
  onChooseConnection: () => void;
}) {
  const name = account.feed.name;
  const balance = formatBalance(account);
  const csv = isCsvAccount(account);
  return (
    <div className={cardFrame(active)} data-testid={`banking-account-${account.feed.id}`}>
      <SelectLayer label={`Show ${name}`} active={active} onSelect={onSelect} />
      <div className="pointer-events-none flex items-start gap-3">
        <IconTile account={account} active={active} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">
            {name}
          </div>
          <div className="truncate text-xs text-slate-500 dark:text-slate-400">
            {accountSubtitle(account)}
          </div>
        </div>
        {canWrite &&
          (csv ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={onImport}
              title="Import CSV"
              aria-label={`Import a CSV into ${name}`}
              className="pointer-events-auto relative z-10 -mr-2 -mt-1 h-8 px-2"
            >
              <Upload size={14} />
            </Button>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              onClick={onSync}
              loading={busy}
              disabled={account.sync.syncing}
              title="Sync now"
              aria-label={`Sync ${name} now`}
              className="pointer-events-auto relative z-10 -mr-2 -mt-1 h-8 px-2"
            >
              <RefreshCw size={14} />
            </Button>
          ))}
      </div>

      <div className="pointer-events-none mt-4 min-h-[1.75rem]">
        {balance ? (
          <div className="flex items-baseline gap-1.5" title={`As of ${syncAge(account.balance!.at, now)}`}>
            <span className="text-xl font-semibold tabular-nums text-slate-900 dark:text-slate-100">
              {balance}
            </span>
            <span className="text-xs text-slate-400 dark:text-slate-500">balance</span>
          </div>
        ) : (
          <div className="flex items-baseline gap-1.5">
            <span className="text-xl font-semibold tabular-nums text-slate-900 dark:text-slate-100">
              {account.total.toLocaleString()}
            </span>
            <span className="text-xs text-slate-400 dark:text-slate-500">
              {account.total === 1 ? "transaction" : "transactions"}
            </span>
          </div>
        )}
      </div>

      <div className="pointer-events-none mt-auto flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 pt-3">
        <ReviewCount count={account.toReview} />
        <span
          className={clsx("inline-flex min-w-0 items-center gap-1.5 text-xs", TONE_TEXT[line.tone])}
          title={line.hint ?? undefined}
          data-testid="banking-sync-line"
        >
          <SyncMark tone={line.tone} />
          <span className="truncate">{line.label}</span>
        </span>
      </div>

      {line.reason && (
        <div
          className="relative z-10 mt-3 flex flex-wrap items-baseline gap-x-1.5 gap-y-1 rounded-lg bg-red-50 px-2.5 py-2 text-xs text-red-800 dark:bg-red-950/40 dark:text-red-200"
          data-testid="banking-sync-failure"
        >
          <span className="min-w-0">{line.reason}</span>
          {line.fix?.kind === "reconnect" && (
            <Link
              to={line.fix.href}
              className="whitespace-nowrap font-medium underline underline-offset-2 hover:text-red-950 dark:hover:text-red-100"
            >
              {line.fix.label}
            </Link>
          )}
          {line.fix?.kind === "choose_connection" && (
            <button
              type="button"
              onClick={onChooseConnection}
              className="whitespace-nowrap font-medium underline underline-offset-2 hover:text-red-950 dark:hover:text-red-100"
            >
              {line.fix.label}
            </button>
          )}
          {line.fix?.kind === "ask" && (
            <span className="text-red-700/80 dark:text-red-300/80">{line.fix.label}.</span>
          )}
        </div>
      )}
      {requestError && (
        <p className="relative z-10 mt-2 text-xs text-red-700 dark:text-red-300" role="alert">
          Couldn&apos;t start the sync: {requestError}
        </p>
      )}
    </div>
  );
}

/** Three quiet cards while the accounts load, the size the real ones will be. */
export function AccountStripSkeleton() {
  return (
    <div className={ACCOUNT_GRID} aria-busy aria-label="Loading your accounts">
      {[0, 1, 2].map((index) => (
        <div
          key={index}
          className="h-[156px] animate-pulse rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900"
        >
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-lg bg-slate-100 dark:bg-slate-800" />
            <div className="flex-1 space-y-2">
              <div className="h-3 w-2/3 rounded bg-slate-100 dark:bg-slate-800" />
              <div className="h-2.5 w-1/2 rounded bg-slate-100 dark:bg-slate-800" />
            </div>
          </div>
          <div className="mt-6 h-5 w-1/3 rounded bg-slate-100 dark:bg-slate-800" />
          <div className="mt-6 h-3 w-1/2 rounded bg-slate-100 dark:bg-slate-800" />
        </div>
      ))}
    </div>
  );
}

/**
 * What sits above the transaction list: the account open, what it does in the
 * books, how its sync is doing — in full, with the provider's details behind
 * View details when it failed — and the actions that change the account.
 */
export function AccountPanelHeader({
  account,
  accounts,
  ledger,
  line,
  canWrite,
  removing,
  onImport,
  onChooseConnection,
  onRemove,
}: {
  account: BankingAccount | null;
  accounts: BankingAccount[];
  ledger: Account[];
  line: SyncLine | null;
  canWrite: boolean;
  removing: boolean;
  onImport: () => void;
  onChooseConnection: () => void;
  onRemove: () => void;
}) {
  if (!account) {
    const toReview = accounts.reduce((sum, item) => sum + item.toReview, 0);
    return (
      <div className="border-b border-slate-100 px-4 py-3 dark:border-slate-800">
        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
          All transactions
        </h2>
        <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
          Across {accounts.length} {accounts.length === 1 ? "account" : "accounts"} ·{" "}
          {toReview.toLocaleString()} waiting for review
        </p>
      </div>
    );
  }
  const name = (id: string) => {
    const found = ledger.find((item) => item.id === id);
    return found ? `${found.code} ${found.name}` : "a missing account";
  };
  const books =
    account.kind === "bank"
      ? `Posts to ${name(account.feed.accountId)}`
      : `Files new purchases under ${name(account.feed.defaultExpenseAccountId)} · what you owe in ${name(account.feed.liabilityAccountId)}`;
  const csv = isCsvAccount(account);
  const through = account.connection
    ? `Through ${account.connection.label}`
    : csv
      ? null
      : "Its Connection was removed";
  return (
    <div className="border-b border-slate-100 px-4 py-3 dark:border-slate-800">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">
            {account.feed.name}
          </h2>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            {[books, through, line && !line.reason ? line.hint : null].filter(Boolean).join(" · ")}
          </p>
        </div>
        {canWrite && (
          <div className="flex shrink-0 items-center gap-2">
            {csv && (
              <Button size="sm" onClick={onImport} disabled={removing}>
                <Upload size={14} /> Import CSV
              </Button>
            )}
            <Menu
              align="right"
              width={220}
              trigger={({ ref, onClick, open }) => (
                <Button
                  ref={ref}
                  size="sm"
                  variant="secondary"
                  onClick={onClick}
                  loading={removing}
                  aria-haspopup="menu"
                  aria-expanded={open}
                  aria-label={`More for ${account.feed.name}`}
                  className="px-2"
                >
                  <MoreHorizontal size={14} />
                </Button>
              )}
            >
              {(close) => (
                <>
                  {!csv && (
                    <>
                      <MenuItem
                        icon={<Plug size={14} />}
                        label="Change Connection"
                        onSelect={() => {
                          close();
                          onChooseConnection();
                        }}
                      />
                      <MenuSeparator />
                    </>
                  )}
                  <MenuItem
                    icon={<Trash2 size={14} />}
                    label="Remove from Banking"
                    className="text-red-700 dark:text-red-300"
                    onSelect={() => {
                      close();
                      onRemove();
                    }}
                  />
                </>
              )}
            </Menu>
          </div>
        )}
      </div>
      {line?.reason && (
        <FormError
          className="mt-3"
          message={`${line.label} · ${line.reason}.${line.hint ? ` ${line.hint}` : ""}`}
          detail={line.detail}
        />
      )}
    </div>
  );
}

const PROVIDER_OF: Record<string, string> = { brex: "Brex", wise: "Wise", stripe: "Stripe" };

/**
 * Point the account at another Connection of the same provider — how an
 * account whose Connection was removed starts syncing again, without losing
 * its transactions by removing and re-adding it.
 *
 * That is a finance write, so a Member with read-only Finance access is told
 * why they can't make it instead of being offered a form the server refuses.
 * The page offers them no way here; this holds even if a new one does.
 */
export function ChangeConnectionModal({
  company,
  account,
  onClose,
  onChanged,
}: {
  company: Company;
  account: BankingAccount;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const canWrite = canWriteFinance(company);
  const provider = account.provider ?? "brex";
  const providerLabel = PROVIDER_OF[provider] ?? provider;
  const [connections, setConnections] = React.useState<IntegrationConnection[] | null>(null);
  const [connectionId, setConnectionId] = React.useState("");
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (!canWrite) return;
    let alive = true;
    api
      .get<IntegrationConnection[]>(`/api/companies/${company.id}/integrations/connections`)
      .then((list) => {
        if (!alive) return;
        const matching = list.filter((connection) => connection.provider === provider);
        setConnections(matching);
        // The one it uses now, if it still exists; otherwise the first other one.
        setConnectionId(
          matching.find((connection) => connection.id === account.feed.connectionId)?.id ??
            matching[0]?.id ??
            "",
        );
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setConnections([]);
        setLoadError(errorMessage(err, "Couldn't load your Connections"));
      });
    return () => {
      alive = false;
    };
  }, [account.feed.connectionId, canWrite, company.id, provider]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!connectionId) return;
    setSaving(true);
    setError(null);
    try {
      await api.patch(
        account.kind === "bank"
          ? `/api/companies/${company.id}/bank-feeds/${account.feed.id}`
          : `/api/companies/${company.id}/card-feeds/${account.feed.id}`,
        { connectionId },
      );
      await onChanged();
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  }

  const unchanged = connectionId === account.feed.connectionId;
  if (!canWrite) {
    return (
      <Modal open onClose={onClose} title={`Change the Connection for ${account.feed.name}`}>
        <div className="space-y-4">
          <FinanceReadOnlyNote />
          <div className="flex justify-end">
            <Button type="button" variant="secondary" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
      </Modal>
    );
  }
  return (
    <Modal open onClose={onClose} title={`Change the Connection for ${account.feed.name}`}>
      <form onSubmit={save} className="space-y-4">
        <p className="text-sm text-slate-600 dark:text-slate-300">
          {account.feed.name} reads its transactions through a {providerLabel} Connection. Pick
          the one to use — it has to reach the same account. Its transactions and everything in
          your books stay as they are.
        </p>
        {connections === null ? (
          <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
            <Spinner size={14} /> Loading your {providerLabel} Connections…
          </div>
        ) : connections.length === 0 ? (
          <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300">
            There&apos;s no {providerLabel} Connection yet.{" "}
            {company.role === "owner" || company.role === "admin" ? (
              <Link to={`/c/${company.slug}/finance/integrations`} className="font-medium underline">
                Connect {providerLabel}
              </Link>
            ) : (
              <>Ask an owner or admin to connect {providerLabel}</>
            )}
            , then come back to choose it.
          </p>
        ) : (
          <Select
            label={`${providerLabel} Connection`}
            value={connectionId}
            onChange={(event) => setConnectionId(event.target.value)}
            required
          >
            {connections.map((connection) => (
              <option key={connection.id} value={connection.id}>
                {connection.label}
                {connection.status === "connected" ? "" : ` — ${connection.status}`}
              </option>
            ))}
          </Select>
        )}
        <FormError message={loadError ?? error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" loading={saving} disabled={!connectionId || unchanged}>
            Use this Connection
          </Button>
        </div>
      </form>
    </Modal>
  );
}
