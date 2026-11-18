import React from "react";
import { Link, Outlet, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import {
  Archive,
  ChevronDown,
  FileText,
  Inbox,
  Mail,
  PenSquare,
  RefreshCw,
  Send,
  ShieldAlert,
  Star,
  Tag,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import { Company } from "../lib/api";
import { errorMessage } from "../lib/errors";
import { ComposeInput, MailAccount, MailCounts, MailLabelInfo, mailApi } from "../lib/mail";
import { shouldIgnoreShortcut } from "../lib/keyboard";
import { type Command, useRegisterCommands } from "../components/CommandRegistry";
import { ContextualLayout, sidebarLinkClassName } from "../components/AppShell";
import {
  SectionRailHeader,
  SectionRailLinks,
  railHeadingClassName,
} from "../components/SectionRail";
import { ConnectMailboxForm } from "../components/mail/ConnectMailbox";
import { MailComposeModal } from "../components/mail/MailComposeModal";
import { activeMailAccountKey } from "../lib/mailAccountChoice";
import { useCompanySocketSubscription } from "../components/CompanySocket";
import { CountBadge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { useDialog } from "../components/ui/Dialog";
import { FormError } from "../components/ui/FormError";
import { Menu, MenuItem } from "../components/ui/Menu";
import { Spinner } from "../components/ui/Spinner";
import { useAskAiMailComposer } from "../components/askAi/AskAiProvider";

/**
 * Layout + sidebar for `/c/:slug/mail/*` — the Email section (M25).
 *
 * Owns the account roster, the active-mailbox selection (persisted per
 * company in localStorage), the folder/label rail with live counts, the
 * global Compose modal, and the no-mailbox onboarding. Children read
 * everything through Outlet context and re-fetch when `changeTick` bumps —
 * the server broadcasts a `mail.updated` websocket event after every sync
 * pass, write-through action, and handover status change.
 */

export type MailOutletCtx = {
  company: Company;
  accounts: MailAccount[];
  account: MailAccount;
  labels: MailLabelInfo[];
  counts: MailCounts;
  /** Bumps on every `mail.updated` websocket event for the active account. */
  changeTick: number;
  /** True while a user-requested sync is running for the active account. */
  syncing: boolean;
  /** Start a durable sync and follow its explicit server-side lifecycle. */
  syncNow: () => Promise<void>;
  refresh: () => Promise<void>;
  openCompose: (init?: Partial<ComposeInput>) => void;
};

/** Folders offered as ⌘K commands, in the order the sidebar lists them. */
const MAIL_COMMAND_VIEWS: Array<{ view: string; label: string; icon: LucideIcon }> = [
  { view: "inbox", label: "Inbox", icon: Inbox },
  { view: "starred", label: "Starred", icon: Star },
  { view: "drafts", label: "Drafts", icon: FileText },
  { view: "sent", label: "Sent", icon: Send },
  { view: "all", label: "All mail", icon: Archive },
  { view: "spam", label: "Spam", icon: ShieldAlert },
  { view: "trash", label: "Trash", icon: Trash2 },
];

export default function MailLayout({ company }: { company: Company }) {
  const dialog = useDialog();
  const [mailSearchParams, setMailSearchParams] = useSearchParams();
  const requestedAccountId = mailSearchParams.get("account");
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [accounts, setAccounts] = React.useState<MailAccount[]>([]);
  const [activeId, setActiveId] = React.useState<string | null>(() =>
    localStorage.getItem(activeMailAccountKey(company.id)),
  );
  React.useEffect(() => {
    if (!requestedAccountId || !accounts.some((account) => account.id === requestedAccountId))
      return;
    setActiveId(requestedAccountId);
    localStorage.setItem(activeMailAccountKey(company.id), requestedAccountId);
  }, [accounts, company.id, requestedAccountId]);
  const [labels, setLabels] = React.useState<MailLabelInfo[]>([]);
  const [labelError, setLabelError] = React.useState<string | null>(null);
  const [counts, setCounts] = React.useState<MailCounts>({
    inboxUnread: 0,
    drafts: 0,
    starred: 0,
  });
  const accountRequestSeq = React.useRef(0);
  const labelRequestSeq = React.useRef(0);
  const lastLabelRefreshAt = React.useRef(0);
  const [changeTick, setChangeTick] = React.useState(0);
  const [requestedSync, setRequestedSync] = React.useState<{
    accountId: string;
    attemptId: string;
  } | null>(null);
  const [syncSubmittingAccountIds, setSyncSubmittingAccountIds] = React.useState<Set<string>>(
    () => new Set(),
  );
  const [composeOpen, setComposeOpen] = React.useState(false);
  const [composeInit, setComposeInit] = React.useState<Partial<ComposeInput>>({});
  const [composeSession, setComposeSession] = React.useState(0);

  const account =
    accounts.find((a) => a.id === requestedAccountId) ??
    accounts.find((a) => a.id === activeId) ??
    accounts[0] ??
    null;

  const refreshAccounts = React.useCallback(async () => {
    const requestSeq = ++accountRequestSeq.current;
    const res = await mailApi.accounts(company.id);
    if (requestSeq === accountRequestSeq.current) setAccounts(res.accounts);
    return res.accounts;
  }, [company.id]);

  const refreshLabels = React.useCallback(
    async (accountId: string) => {
      const requestSeq = ++labelRequestSeq.current;
      lastLabelRefreshAt.current = Date.now();
      const res = await mailApi.labels(company.id, accountId);
      if (requestSeq !== labelRequestSeq.current) return;
      setLabels(res.labels);
      setCounts(res.counts);
    },
    [company.id],
  );

  const refresh = React.useCallback(async () => {
    const list = await refreshAccounts();
    const current = list.find((a) => a.id === activeId) ?? list[0];
    if (current) await refreshLabels(current.id);
  }, [refreshAccounts, refreshLabels, activeId]);

  const syncNow = React.useCallback(async () => {
    if (
      !account ||
      requestedSync?.accountId === account.id ||
      syncSubmittingAccountIds.has(account.id)
    ) {
      return;
    }
    if (account.status === "paused") {
      void dialog.error("Resume this mailbox before syncing.", {
        title: "Couldn’t sync this mailbox",
      });
      return;
    }
    if (account.syncState === "queued" || account.syncState === "running") return;

    const accountId = account.id;
    setSyncSubmittingAccountIds((current) => new Set(current).add(accountId));
    try {
      const { sync } = await mailApi.syncNow(company.id, account.id);
      setRequestedSync({ accountId: account.id, attemptId: sync.attemptId });
      void refreshAccounts().catch(() => {});
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t start the sync" });
    } finally {
      setSyncSubmittingAccountIds((current) => {
        const next = new Set(current);
        next.delete(accountId);
        return next;
      });
    }
  }, [account, company.id, dialog, refreshAccounts, requestedSync, syncSubmittingAccountIds]);

  const pollingSyncAccountId =
    requestedSync?.accountId ??
    (account && (account.syncState === "queued" || account.syncState === "running")
      ? account.id
      : null);

  // Websocket delivery normally refreshes the account immediately. Poll as
  // a fallback for both a manual request and an in-progress pass discovered
  // after reload, so a dropped socket cannot leave stale sync state on screen.
  React.useEffect(() => {
    if (!pollingSyncAccountId) return;
    const interval = window.setInterval(() => {
      void refreshAccounts().catch(() => {});
    }, 2_000);
    return () => window.clearInterval(interval);
  }, [pollingSyncAccountId, refreshAccounts]);

  React.useEffect(() => {
    if (!requestedSync) return;
    const syncedAccount = accounts.find((a) => a.id === requestedSync.accountId);
    if (!syncedAccount) {
      setRequestedSync(null);
      return;
    }
    if (syncedAccount.syncAttemptId !== requestedSync.attemptId) {
      if (
        syncedAccount.syncAttemptId &&
        (syncedAccount.syncState === "queued" || syncedAccount.syncState === "running")
      ) {
        setRequestedSync({
          accountId: syncedAccount.id,
          attemptId: syncedAccount.syncAttemptId,
        });
      } else {
        setRequestedSync(null);
      }
      return;
    }
    if (syncedAccount.syncState === "queued" || syncedAccount.syncState === "running") return;

    setRequestedSync(null);
    // A finished sync needs no announcement — the counts and the thread list
    // repaint from the same event. Only a failure has to be said out loud.
    if (syncedAccount.syncState === "failed" && syncedAccount.status !== "paused") {
      void dialog.error(syncedAccount.statusMessage, { title: "Mailbox sync failed" });
    }
  }, [accounts, dialog, requestedSync]);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError(null);
      setLabels([]);
      setLabelError(null);
      setCounts({ inboxUnread: 0, drafts: 0, starred: 0 });
      lastLabelRefreshAt.current = 0;
      try {
        const list = await refreshAccounts();
        const current =
          list.find((a) => a.id === requestedAccountId) ??
          list.find((a) => a.id === activeId) ??
          list[0];
        if (cancelled) return;

        // Account discovery is enough to paint the mailbox and start the
        // indexed thread query. Sidebar statistics can be expensive on a
        // large local mirror, so load them alongside the page instead of
        // holding the entire Email section behind its spinner.
        setLoading(false);
        if (current) {
          void refreshLabels(current.id).catch((err: unknown) => {
            if (!cancelled) setLabelError(errorMessage(err, "Could not load the folders"));
          });
        }
      } catch (err) {
        if (!cancelled) setLoadError(errorMessage(err, "Could not load your mailboxes"));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [company.id]);

  // Live refresh: any change to the active mailbox bumps the tick children
  // watch, and refreshes the sidebar counts.
  useCompanySocketSubscription((ev) => {
    if ((ev as { type?: string }).type !== "mail.updated") return;
    const mailEvent = ev as {
      accountId?: string;
      threadsChanged?: boolean;
    };
    const accountId = mailEvent.accountId;
    // Sync lifecycle belongs to the account roster, not only the mailbox that
    // happens to be open. Refresh every account so switching later cannot
    // reveal a stale terminal/error state from an event we ignored.
    void refreshAccounts().catch(() => {});
    if (!account || accountId !== account.id) return;
    if (mailEvent.threadsChanged !== false) {
      setChangeTick((t) => t + 1);
    }

    // A first mailbox import can emit progress after every page it reads. Each
    // sidebar refresh scans the mirrored thread labels, so cap those scans
    // while the import is growing; the thread list and progress counter stay
    // live on every event, and a completed mailbox still refreshes at once.
    const labelsAreStale = Date.now() - lastLabelRefreshAt.current >= 30_000;
    if (account.backfilledAt || labelsAreStale) {
      void refreshLabels(account.id).catch(() => {});
    }
  });

  const selectAccount = (id: string) => {
    // Keep a Home deep link in step with the picker; otherwise a live account
    // refresh would restore the mailbox named by the old URL.
    setMailSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.set("account", id);
        return next;
      },
      { replace: true },
    );
    setActiveId(id);
    localStorage.setItem(activeMailAccountKey(company.id), id);
    setLabels([]);
    setLabelError(null);
    setCounts({ inboxUnread: 0, drafts: 0, starred: 0 });
    lastLabelRefreshAt.current = 0;
    void refreshLabels(id).catch(() => {});
    setChangeTick((t) => t + 1);
  };

  const openCompose = React.useCallback((init: Partial<ComposeInput> = {}) => {
    setComposeInit(init);
    setComposeSession((current) => current + 1);
    setComposeOpen(true);
  }, []);

  // A "Reply" button an AI Employee suggested in Ask AI opens this composer.
  useAskAiMailComposer(openCompose);

  // `c` composes from anywhere in the mail section. It is the one mail shortcut
  // that is not list-scoped, so it belongs to the layout that owns the composer
  // rather than to whichever list happens to be on screen.
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (shouldIgnoreShortcut(event) || event.key !== "c") return;
      event.preventDefault();
      openCompose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openCompose]);

  // Section-wide ⌘K actions. Verbs that depend on what is selected belong to
  // the lists themselves; these are the ones that make sense anywhere in mail.
  const paletteNavigate = useNavigate();
  const mailCommands = React.useMemo<Command[]>(
    () => [
      {
        id: "mail.compose",
        label: "Compose email",
        hint: "C",
        icon: PenSquare,
        group: "Email",
        keywords: ["new", "write", "message", "send"],
        run: () => openCompose(),
      },
      {
        id: "mail.sync",
        label: "Sync mailbox now",
        icon: RefreshCw,
        group: "Email",
        keywords: ["refresh", "fetch", "update"],
        run: () => void syncNow(),
      },
      ...MAIL_COMMAND_VIEWS.map((entry) => ({
        id: `mail.go.${entry.view}`,
        label: `Go to ${entry.label}`,
        icon: entry.icon,
        group: "Email",
        keywords: ["mail", "folder", entry.label.toLowerCase()],
        run: () => paletteNavigate(`/c/${company.slug}/mail?view=${entry.view}`),
      })),
    ],
    [openCompose, syncNow, paletteNavigate, company.slug],
  );
  useRegisterCommands(mailCommands);

  if (loading) {
    return (
      <ContextualLayout>
        <div className="flex h-full items-center justify-center">
          <Spinner size={24} />
        </div>
      </ContextualLayout>
    );
  }

  // A roster we could not read is not the same as a company with no mailbox —
  // say so here rather than dropping the person into onboarding.
  if (loadError) {
    return (
      <ContextualLayout>
        <FormError message={loadError} className="m-6" />
      </ContextualLayout>
    );
  }

  if (!account) {
    return (
      <ContextualLayout>
        <MailOnboarding company={company} onConnected={refresh} />
      </ContextualLayout>
    );
  }

  const base = `/c/${company.slug}/mail`;
  const userLabels = labels.filter((l) => l.labelType === "user");

  const sidebar = (
    <div className="flex h-full flex-col">
      <SectionRailHeader section="mail" label="Email" />
      <div className="border-b border-slate-100 px-3 py-3 dark:border-slate-800">
        <Menu
          width={240}
          trigger={({ ref, onClick }) => (
            <button
              ref={ref}
              onClick={onClick}
              className="flex h-9 w-full items-center gap-2 rounded-lg border border-slate-300 px-2.5 text-left text-sm text-slate-700 shadow-sm hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              <span className="min-w-0 flex-1 truncate">{account.address}</span>
              <ChevronDown size={14} className="shrink-0 text-slate-400" />
            </button>
          )}
        >
          {(close) => (
            <>
              {accounts.map((a) => (
                <MenuItem
                  key={a.id}
                  label={a.address}
                  active={a.id === account.id}
                  onSelect={() => {
                    selectAccount(a.id);
                    close();
                  }}
                />
              ))}
            </>
          )}
        </Menu>
        {account.status === "error" && (
          <Link
            to={`${base}/settings`}
            className="mt-2 flex items-center gap-1.5 rounded-md bg-red-50 px-2 py-1.5 text-xs text-red-700 dark:bg-red-500/10 dark:text-red-300"
          >
            <ShieldAlert size={12} className="shrink-0" /> Sync error — open settings
          </Link>
        )}
        {account.status === "active" && !account.backfilledAt && (
          <div className="mt-2 flex items-center gap-1.5 rounded-md bg-indigo-50 px-2 py-1.5 text-xs text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300">
            <Spinner size={12} />
            {account.backfilledCount > 0
              ? `Importing your mail — ${account.backfilledCount.toLocaleString()} so far…`
              : "Importing your mailbox…"}
          </div>
        )}
        <Button className="mt-3 w-full" size="sm" onClick={() => openCompose()}>
          <PenSquare size={14} className="mr-1.5" /> Compose
        </Button>
      </div>
      <nav className="flex-1 overflow-y-auto p-2">
        <FormError message={labelError} className="mb-2" />
        <FolderLink
          base={base}
          view="inbox"
          icon={<Inbox size={14} />}
          label="Inbox"
          badge={counts.inboxUnread}
        />
        <FolderLink
          base={base}
          view="starred"
          icon={<Star size={14} />}
          label="Starred"
          badge={counts.starred}
        />
        <FolderLink base={base} view="sent" icon={<Send size={14} />} label="Sent" />
        <FolderLink
          base={base}
          view="drafts"
          icon={<FileText size={14} />}
          label="Drafts"
          badge={counts.drafts}
        />
        <FolderLink base={base} view="all" icon={<Archive size={14} />} label="All mail" />
        <FolderLink base={base} view="spam" icon={<ShieldAlert size={14} />} label="Spam" />
        <FolderLink base={base} view="trash" icon={<Trash2 size={14} />} label="Trash" />
        {userLabels.length > 0 && (
          <>
            <div className={`px-2 pb-1 pt-3 ${railHeadingClassName}`}>Labels</div>
            {userLabels.map((l) => (
              <LabelLink key={l.id} base={base} label={l} />
            ))}
          </>
        )}
        {/* Rules, AI handovers and Settings under "Automation", from the
            subpage catalogue (`lib/subpages.ts`) the ⌘K palette searches. The
            folders above are drawn here because they carry live counts; the
            catalogue lists them for the palette too. */}
        <SectionRailLinks section="mail" companySlug={company.slug} viewer={company} continued />
      </nav>
    </div>
  );

  const ctx: MailOutletCtx = {
    company,
    accounts,
    account,
    labels,
    counts,
    changeTick,
    syncing:
      syncSubmittingAccountIds.has(account.id) ||
      requestedSync?.accountId === account.id ||
      account.syncState === "queued" ||
      account.syncState === "running",
    syncNow,
    refresh,
    openCompose,
  };

  return (
    <ContextualLayout sidebar={sidebar}>
      <div className="h-full min-h-0 overflow-y-auto">
        <Outlet context={ctx} />
      </div>
      <MailComposeModal
        open={composeOpen}
        onClose={() => setComposeOpen(false)}
        onReopen={() => setComposeOpen(true)}
        company={company}
        account={account}
        init={composeInit}
        session={composeSession}
      />
    </ContextualLayout>
  );
}

/** Folder rows are query-param links, so NavLink's path matching can't style
 * the active row — this checks `?view=` (and label absence) itself. */
function FolderLink({
  base,
  view,
  icon,
  label,
  badge,
}: {
  base: string;
  view: string;
  icon: React.ReactNode;
  label: string;
  badge?: number;
}) {
  const [params] = useSearchParams();
  const { pathname } = useLocation();
  const onIndex = pathname.replace(/\/$/, "") === base;
  const current = params.get("view") ?? "inbox";
  // An active search scopes to all mail server-side, so no folder row should
  // claim to be the thing being shown.
  const isActive = onIndex && !params.get("q") && !params.get("label") && current === view;
  return (
    <Link
      to={view === "inbox" ? base : `${base}?view=${view}`}
      className={sidebarLinkClassName(isActive)}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {badge != null && badge > 0 && <CountBadge count={badge} tone="accent" />}
    </Link>
  );
}

function LabelLink({ base, label }: { base: string; label: MailLabelInfo }) {
  const [params] = useSearchParams();
  const { pathname } = useLocation();
  const onIndex = pathname.replace(/\/$/, "") === base;
  const isActive = onIndex && !params.get("q") && params.get("label") === label.gmailLabelId;
  return (
    <Link
      to={`${base}?label=${encodeURIComponent(label.gmailLabelId)}`}
      className={sidebarLinkClassName(isActive)}
    >
      <Tag size={14} style={label.color ? { color: label.color } : undefined} />
      <span className="min-w-0 flex-1 truncate">{label.name}</span>
      {label.threadCount > 0 && (
        <span className="text-xs tabular-nums text-slate-500 dark:text-slate-400">
          {label.threadCount}
        </span>
      )}
    </Link>
  );
}

// ───────────────────────────── onboarding ─────────────────────────────

/**
 * The first screen of the Email section, for a company with no mailbox yet.
 *
 * It used to be a picker over Google Connections that had to exist already,
 * which put the real first step — a Google Cloud project — somewhere else
 * entirely, and left this page saying "no Gmail-capable Google connection yet"
 * to somebody who had never been told they needed one. Now the page asks for
 * an email address, and {@link ConnectMailboxForm} works out the rest.
 */
function MailOnboarding({
  company,
  onConnected,
}: {
  company: Company;
  onConnected: () => Promise<void>;
}) {
  return (
    <div className="mx-auto max-w-2xl px-4 py-10 sm:px-6 sm:py-16">
      <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-sky-100 text-sky-600 dark:bg-sky-500/15 dark:text-sky-300">
        <Mail size={20} aria-hidden="true" />
      </div>
      <h1 className="text-xl font-semibold tracking-tight text-slate-900 sm:text-2xl dark:text-slate-50">
        Bring your inbox into Genosyn
      </h1>
      <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-400">
        Connect a mailbox to read and answer mail here, hand threads to AI employees, and run rules
        on everything that arrives. Changes sync both ways. Gmail, Outlook, Fastmail, iCloud, your
        own mail server — anything that speaks IMAP.
      </p>

      <div className="mt-8 rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <ConnectMailboxForm
          companyId={company.id}
          canConnect={company.role === "owner" || company.role === "admin"}
          autoFocus
          onConnected={async () => {
            // No confirmation needed: onConnected swaps this whole screen for
            // the mailbox, with the first sync already running in the sidebar.
            await onConnected();
          }}
        />
      </div>

      <p className="mt-4 text-xs text-slate-500 dark:text-slate-400">
        Already have a connection set up?{" "}
        <Link
          to={`/c/${company.slug}/mail/integrations`}
          className="underline hover:text-slate-700 dark:hover:text-slate-200"
        >
          Open Integrations
        </Link>
        .
      </p>
    </div>
  );
}
