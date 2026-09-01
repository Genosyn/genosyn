import React from "react";
import { Link, Outlet, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import {
  Archive,
  Bot,
  ChevronDown,
  FileText,
  Inbox,
  Mail,
  PenSquare,
  RefreshCw,
  Send,
  Settings as SettingsIcon,
  ShieldAlert,
  SlidersHorizontal,
  Star,
  Tag,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import { Company } from "../lib/api";
import { errorMessage } from "../lib/errors";
import {
  ComposeInput,
  MailAccount,
  MailCounts,
  MailLabelInfo,
  mailApi,
} from "../lib/mail";
import { shouldIgnoreShortcut } from "../lib/keyboard";
import { type Command, useRegisterCommands } from "../components/CommandRegistry";
import { ContextualLayout, SidebarLink } from "../components/AppShell";
import { AttachmentBar, useMailAttachments } from "../components/MailAttachments";
import { ConnectMailboxForm } from "../components/mail/ConnectMailbox";
import { useComposerFileDrop } from "../lib/fileDrop";
import { useCompanySocketSubscription } from "../components/CompanySocket";
import { Button } from "../components/ui/Button";
import { useDialog } from "../components/ui/Dialog";
import { FormError } from "../components/ui/FormError";
import { Input } from "../components/ui/Input";
import { Menu, MenuItem } from "../components/ui/Menu";
import { Modal } from "../components/ui/Modal";
import { Spinner } from "../components/ui/Spinner";
import { Textarea } from "../components/ui/Textarea";

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

const activeAccountKey = (companyId: string) => `genosyn.mail.account.${companyId}`;

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
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [accounts, setAccounts] = React.useState<MailAccount[]>([]);
  const [activeId, setActiveId] = React.useState<string | null>(() =>
    localStorage.getItem(activeAccountKey(company.id)),
  );
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

  const account = accounts.find((a) => a.id === activeId) ?? accounts[0] ?? null;

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
        const current = list.find((a) => a.id === activeId) ?? list[0];
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
    setActiveId(id);
    localStorage.setItem(activeAccountKey(company.id), id);
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
      <div className="border-b border-slate-100 px-3 py-3 dark:border-slate-800">
        <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
          <Mail size={14} /> Email
        </div>
        <Menu
          width={240}
          trigger={({ ref, onClick }) => (
            <button
              ref={ref}
              onClick={onClick}
              className="flex w-full items-center gap-2 rounded-md border border-slate-200 px-2.5 py-1.5 text-left text-sm text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
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
            <div className="px-2 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
              Labels
            </div>
            {userLabels.map((l) => (
              <LabelLink key={l.id} base={base} label={l} />
            ))}
          </>
        )}
        <div className="px-2 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
          Automation
        </div>
        <SidebarLink to={`${base}/rules`} icon={<SlidersHorizontal size={14} />} label="Rules" />
        <SidebarLink to={`${base}/handovers`} icon={<Bot size={14} />} label="AI handovers" />
        <SidebarLink to={`${base}/settings`} icon={<SettingsIcon size={14} />} label="Settings" />
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
      className={
        "flex items-center gap-2 rounded-md px-3 py-2 text-sm " +
        (isActive
          ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300"
          : "text-slate-700 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800")
      }
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {badge != null && badge > 0 && (
        <span className="rounded-full bg-indigo-100 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300">
          {badge}
        </span>
      )}
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
      className={
        "flex items-center gap-2 rounded-md px-3 py-2 text-sm " +
        (isActive
          ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300"
          : "text-slate-700 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800")
      }
    >
      <Tag size={14} style={label.color ? { color: label.color } : undefined} />
      <span className="min-w-0 flex-1 truncate">{label.name}</span>
      {label.threadCount > 0 && (
        <span className="text-[10px] tabular-nums text-slate-400">{label.threadCount}</span>
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
    <div className="mx-auto max-w-2xl px-6 py-16">
      <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
        <Mail size={14} /> Email
      </div>
      <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">
        Bring your inbox into Genosyn
      </h1>
      <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
        Connect a mailbox to read and answer mail here, hand threads to AI employees, and run rules
        on everything that arrives. Changes sync both ways. Gmail, Outlook, Fastmail, iCloud, your
        own mail server — anything that speaks IMAP.
      </p>

      <div className="mt-8 rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-950">
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

// ───────────────────────────── compose modal ─────────────────────────────

function MailComposeModal({
  open,
  onClose,
  onReopen,
  company,
  account,
  init,
  session,
}: {
  open: boolean;
  onClose: () => void;
  onReopen: () => void;
  company: Company;
  account: MailAccount;
  init: Partial<ComposeInput>;
  session: number;
}) {
  const dialog = useDialog();
  const navigate = useNavigate();
  const [to, setTo] = React.useState("");
  const [cc, setCc] = React.useState("");
  const [subject, setSubject] = React.useState("");
  const [body, setBody] = React.useState("");
  const [showCc, setShowCc] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const recovering = React.useRef(false);
  const activeSession = React.useRef(session);
  const initializedSession = React.useRef(-1);
  activeSession.current = session;
  const attach = useMailAttachments(company.id, account.id);
  const clearAttach = attach.clear;
  // Paste a screenshot or drop a file straight into the compose box.
  const { dragActive, onPaste, dragProps } = useComposerFileDrop((files) => attach.addFiles(files));

  React.useEffect(() => {
    if (!open) return;
    const sessionChanged = initializedSession.current !== session;
    initializedSession.current = session;
    if (recovering.current && !sessionChanged) {
      recovering.current = false;
      return;
    }
    recovering.current = false;
    setTo(init.to ?? "");
    setCc(init.cc ?? "");
    setShowCc(Boolean(init.cc));
    setSubject(init.subject ?? "");
    setBody(init.bodyText ?? "");
    setError(null);
    clearAttach();
  }, [open, init, clearAttach, session]);

  const submit = (kind: "send" | "draft") => {
    setError(null);
    if (kind === "send" && !to.trim()) {
      setError("Add at least one recipient.");
      return;
    }
    const input: ComposeInput = {
      to: to.trim(),
      cc: cc.trim() || undefined,
      subject: subject.trim(),
      bodyText: body,
      threadId: init.threadId,
      attachmentIds: attach.ids.length ? attach.ids : undefined,
    };
    const submittedSession = session;
    const title = kind === "send" ? "Couldn’t send the message" : "Couldn’t save the draft";
    recovering.current = true;
    onClose();
    const submitted =
      kind === "send"
        ? mailApi.send(company.id, account.id, input)
        : mailApi.createDraft(company.id, account.id, input);
    void submitted
      .then((result) => {
        if (activeSession.current !== submittedSession) return;
        recovering.current = false;
        clearAttach();
        if (kind === "draft") {
          navigate(`/c/${company.slug}/mail/t/${result.message.threadId}`);
        }
      })
      .catch((submitError: unknown) => {
        // Still the same composer: reopen it with everything intact and put
        // the reason above the Send button, not in a modal over the fields.
        if (activeSession.current === submittedSession) {
          setError(`${title}: ${errorMessage(submitError, "Request failed")}`);
          onReopen();
          return;
        }
        // The person has moved on to a newer draft, so there is no form left
        // to hold this and reopening would clobber what they are writing.
        void dialog.error(submitError, {
          title,
          message: `${errorMessage(submitError)} Your newer draft is untouched.`,
        });
      });
  };

  return (
    <Modal open={open} onClose={onClose} title={`New message — ${account.address}`} size="lg">
      <div className="space-y-3">
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <Input
              label="To"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="name@example.com, other@example.com"
            />
          </div>
          {!showCc && (
            <button
              className="pb-2 text-xs text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
              onClick={() => setShowCc(true)}
            >
              Cc
            </button>
          )}
        </div>
        {showCc && <Input label="Cc" value={cc} onChange={(e) => setCc(e.target.value)} />}
        <Input label="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
        <Textarea
          label="Message"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onPaste={onPaste}
          {...dragProps}
          rows={10}
          className={
            dragActive ? "border-indigo-500 ring-2 ring-indigo-200 dark:ring-indigo-900" : undefined
          }
        />
        <AttachmentBar
          items={attach.items}
          uploading={attach.uploading}
          onAdd={attach.addFiles}
          onRemove={attach.remove}
        />
        <FormError message={error} />
        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" disabled={attach.uploading} onClick={() => submit("draft")}>
            Save draft
          </Button>
          <Button disabled={attach.uploading} onClick={() => submit("send")}>
            Send
          </Button>
        </div>
      </div>
    </Modal>
  );
}
