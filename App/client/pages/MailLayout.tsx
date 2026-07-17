import React from "react";
import {
  Link,
  Outlet,
  useLocation,
  useNavigate,
  useSearchParams,
} from "react-router-dom";
import {
  Archive,
  Bot,
  CheckCircle2,
  ChevronDown,
  FileText,
  Inbox,
  Mail,
  PenSquare,
  Send,
  Settings as SettingsIcon,
  ShieldAlert,
  SlidersHorizontal,
  Sparkles,
  Star,
  Tag,
  Trash2,
} from "lucide-react";
import { Company } from "../lib/api";
import {
  ComposeInput,
  MailAccount,
  MailConnectCandidate,
  MailCounts,
  MailLabelInfo,
  mailApi,
} from "../lib/mail";
import { ContextualLayout, SidebarLink } from "../components/AppShell";
import { MailAssistant } from "./MailAssistant";
import { AttachmentBar, useMailAttachments } from "../components/MailAttachments";
import { useCompanySocketSubscription } from "../components/CompanySocket";
import { Button } from "../components/ui/Button";
import { EmptyState } from "../components/ui/EmptyState";
import { FormError } from "../components/ui/FormError";
import { Input } from "../components/ui/Input";
import { Menu, MenuItem } from "../components/ui/Menu";
import { Modal } from "../components/ui/Modal";
import { Spinner } from "../components/ui/Spinner";
import { Textarea } from "../components/ui/Textarea";
import { useToast } from "../components/ui/Toast";

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
  refresh: () => Promise<void>;
  openCompose: (init?: Partial<ComposeInput>) => void;
  /** Open the AI assistant panel (no-op if already open). */
  openAssistant: () => void;
};

const activeAccountKey = (companyId: string) => `genosyn.mail.account.${companyId}`;
const assistantOpenKey = (companyId: string) =>
  `genosyn.mail.assistant.${companyId}`;

export default function MailLayout({ company }: { company: Company }) {
  const { toast } = useToast();
  const [loading, setLoading] = React.useState(true);
  const [accounts, setAccounts] = React.useState<MailAccount[]>([]);
  const [activeId, setActiveId] = React.useState<string | null>(() =>
    localStorage.getItem(activeAccountKey(company.id)),
  );
  const [labels, setLabels] = React.useState<MailLabelInfo[]>([]);
  const [counts, setCounts] = React.useState<MailCounts>({
    inboxUnread: 0,
    drafts: 0,
    starred: 0,
  });
  const labelRequestSeq = React.useRef(0);
  const lastLabelRefreshAt = React.useRef(0);
  const [changeTick, setChangeTick] = React.useState(0);
  const [composeOpen, setComposeOpen] = React.useState(false);
  const [composeInit, setComposeInit] = React.useState<Partial<ComposeInput>>({});
  const [assistantOpen, setAssistantOpen] = React.useState(
    () => localStorage.getItem(assistantOpenKey(company.id)) === "1",
  );
  const location = useLocation();
  // The thread the human is looking at, if any — the assistant injects it as
  // context so "summarize this" needs no ids.
  const viewedThreadId =
    location.pathname.match(/\/mail\/t\/([^/]+)/)?.[1] ?? null;

  const account =
    accounts.find((a) => a.id === activeId) ?? accounts[0] ?? null;

  const setAssistant = React.useCallback(
    (open: boolean) => {
      setAssistantOpen(open);
      localStorage.setItem(assistantOpenKey(company.id), open ? "1" : "0");
    },
    [company.id],
  );

  const refreshAccounts = React.useCallback(async () => {
    const res = await mailApi.accounts(company.id);
    setAccounts(res.accounts);
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

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLabels([]);
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
          void refreshLabels(current.id).catch((err) => {
            if (!cancelled) toast((err as Error).message, "error");
          });
        }
      } catch (err) {
        if (!cancelled) toast((err as Error).message, "error");
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
    const accountId = (ev as { accountId?: string }).accountId;
    if (!account || accountId !== account.id) return;
    setChangeTick((t) => t + 1);

    // A first mailbox import can emit progress after every Gmail page. Each
    // sidebar refresh scans the mirrored thread labels, so cap those scans
    // while the import is growing; the thread list and progress counter stay
    // live on every event, and a completed mailbox still refreshes at once.
    const labelsAreStale = Date.now() - lastLabelRefreshAt.current >= 30_000;
    if (account.backfilledAt || labelsAreStale) {
      void refreshLabels(account.id).catch(() => {});
    }
    void refreshAccounts().catch(() => {});
  });

  const selectAccount = (id: string) => {
    setActiveId(id);
    localStorage.setItem(activeAccountKey(company.id), id);
    setLabels([]);
    setCounts({ inboxUnread: 0, drafts: 0, starred: 0 });
    lastLabelRefreshAt.current = 0;
    void refreshLabels(id).catch(() => {});
    setChangeTick((t) => t + 1);
  };

  const openCompose = React.useCallback((init: Partial<ComposeInput> = {}) => {
    setComposeInit(init);
    setComposeOpen(true);
  }, []);

  if (loading) {
    return (
      <ContextualLayout>
        <div className="flex h-full items-center justify-center">
          <Spinner size={24} />
        </div>
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
            <ShieldAlert size={12} className="shrink-0" /> Sync error — open
            settings
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
        <Button
          className="mt-3 w-full"
          size="sm"
          onClick={() => openCompose()}
        >
          <PenSquare size={14} className="mr-1.5" /> Compose
        </Button>
        <Button
          className="mt-2 w-full"
          size="sm"
          variant="secondary"
          onClick={() => setAssistant(!assistantOpen)}
        >
          <Sparkles size={14} className="mr-1.5 text-violet-500" /> AI assistant
        </Button>
      </div>
      <nav className="flex-1 overflow-y-auto p-2">
        <FolderLink base={base} view="inbox" icon={<Inbox size={14} />} label="Inbox" badge={counts.inboxUnread} />
        <FolderLink base={base} view="starred" icon={<Star size={14} />} label="Starred" badge={counts.starred} />
        <FolderLink base={base} view="sent" icon={<Send size={14} />} label="Sent" />
        <FolderLink base={base} view="drafts" icon={<FileText size={14} />} label="Drafts" badge={counts.drafts} />
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
        <SidebarLink
          to={`${base}/rules`}
          icon={<SlidersHorizontal size={14} />}
          label="Rules"
        />
        <SidebarLink
          to={`${base}/handovers`}
          icon={<Bot size={14} />}
          label="AI handovers"
        />
        <SidebarLink
          to={`${base}/settings`}
          icon={<SettingsIcon size={14} />}
          label="Settings"
        />
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
    refresh,
    openCompose,
    openAssistant: () => setAssistant(true),
  };

  return (
    <ContextualLayout sidebar={sidebar}>
      <div className="flex h-full min-h-0 overflow-hidden">
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          <Outlet context={ctx} />
        </div>
        {assistantOpen && (
          <>
            {/* Mobile scrim — the panel overlays below lg and docks at lg+. */}
            <div
              className="fixed inset-0 z-40 bg-slate-900/40 lg:hidden"
              onClick={() => setAssistant(false)}
            />
            <aside className="fixed inset-y-0 right-0 z-40 flex w-[380px] max-w-[92vw] flex-col border-l border-slate-200 bg-white shadow-xl lg:static lg:z-auto lg:w-[380px] lg:max-w-none lg:shrink-0 lg:shadow-none dark:border-slate-800 dark:bg-slate-950">
              <MailAssistant
                company={company}
                account={account}
                threadId={viewedThreadId}
                onClose={() => setAssistant(false)}
                openCompose={openCompose}
              />
            </aside>
          </>
        )}
      </div>
      <MailComposeModal
        open={composeOpen}
        onClose={() => setComposeOpen(false)}
        company={company}
        account={account}
        init={composeInit}
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
  const isActive =
    onIndex && !params.get("q") && !params.get("label") && current === view;
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
  const isActive =
    onIndex && !params.get("q") && params.get("label") === label.gmailLabelId;
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
        <span className="text-[10px] tabular-nums text-slate-400">
          {label.threadCount}
        </span>
      )}
    </Link>
  );
}

// ───────────────────────────── onboarding ─────────────────────────────

function MailOnboarding({
  company,
  onConnected,
}: {
  company: Company;
  onConnected: () => Promise<void>;
}) {
  const { toast } = useToast();
  const [candidates, setCandidates] = React.useState<MailConnectCandidate[] | null>(
    null,
  );
  const [connecting, setConnecting] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    mailApi
      .connectCandidates(company.id)
      .then((res) => {
        if (!cancelled) setCandidates(res.candidates);
      })
      .catch((err) => {
        if (!cancelled) toast((err as Error).message, "error");
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [company.id]);

  const connect = async (connectionId: string) => {
    setConnecting(connectionId);
    try {
      await mailApi.connectAccount(company.id, connectionId);
      toast("Mailbox connected — first sync started", "success");
      await onConnected();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setConnecting(null);
    }
  };

  const usable = (candidates ?? []).filter(
    (c) => c.hasGmailScope && !c.linkedAccountId,
  );

  return (
    <div className="mx-auto max-w-2xl px-6 py-16">
      <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
        <Mail size={14} /> Email
      </div>
      <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">
        Bring your inbox into Genosyn
      </h1>
      <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
        Connect a Gmail account to read and answer mail here, hand threads to
        AI employees, and run rules on everything that arrives. Changes sync
        both ways.
      </p>

      {candidates === null ? (
        <div className="mt-10 flex justify-center">
          <Spinner size={20} />
        </div>
      ) : usable.length > 0 ? (
        <div className="mt-8 space-y-2">
          <div className="text-sm font-medium text-slate-700 dark:text-slate-300">
            Pick a Google connection
          </div>
          {usable.map((c) => (
            <div
              key={c.connectionId}
              className="flex items-center justify-between rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm dark:border-slate-800 dark:bg-slate-950"
            >
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                  {c.accountHint || c.label}
                </div>
                <div className="truncate text-xs text-slate-500">{c.label}</div>
              </div>
              <Button
                size="sm"
                disabled={connecting !== null}
                onClick={() => connect(c.connectionId)}
              >
                {connecting === c.connectionId ? (
                  <Spinner size={14} />
                ) : (
                  <>
                    <CheckCircle2 size={14} className="mr-1.5" /> Connect
                  </>
                )}
              </Button>
            </div>
          ))}
        </div>
      ) : (
        <div className="mt-8">
          <EmptyState
            title="No Gmail-capable Google connection yet"
            description={
              'Add a Google connection with the "Gmail" product selected under Settings → Integrations, then come back here.'
            }
            action={
              <Link to={`/c/${company.slug}/settings/integrations`}>
                <Button size="sm">Open Integrations</Button>
              </Link>
            }
          />
          {(candidates ?? []).some((c) => !c.hasGmailScope) && (
            <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
              You have Google connections, but none were authorized with the
              Gmail scope — reconnect one and tick the Gmail product on the
              consent screen.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ───────────────────────────── compose modal ─────────────────────────────

function MailComposeModal({
  open,
  onClose,
  company,
  account,
  init,
}: {
  open: boolean;
  onClose: () => void;
  company: Company;
  account: MailAccount;
  init: Partial<ComposeInput>;
}) {
  const { toast } = useToast();
  const navigate = useNavigate();
  const [to, setTo] = React.useState("");
  const [cc, setCc] = React.useState("");
  const [subject, setSubject] = React.useState("");
  const [body, setBody] = React.useState("");
  const [showCc, setShowCc] = React.useState(false);
  const [busy, setBusy] = React.useState<"send" | "draft" | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const attach = useMailAttachments(company.id, account.id);
  const clearAttach = attach.clear;

  React.useEffect(() => {
    if (!open) return;
    setTo(init.to ?? "");
    setCc(init.cc ?? "");
    setShowCc(Boolean(init.cc));
    setSubject(init.subject ?? "");
    setBody(init.bodyText ?? "");
    setError(null);
    setBusy(null);
    clearAttach();
  }, [open, init, clearAttach]);

  const submit = async (kind: "send" | "draft") => {
    setError(null);
    if (kind === "send" && !to.trim()) {
      setError("Add at least one recipient.");
      return;
    }
    setBusy(kind);
    try {
      const input: ComposeInput = {
        to: to.trim(),
        cc: cc.trim() || undefined,
        subject: subject.trim(),
        bodyText: body,
        threadId: init.threadId,
        attachmentIds: attach.ids.length ? attach.ids : undefined,
      };
      if (kind === "send") {
        await mailApi.send(company.id, account.id, input);
        toast("Sent", "success");
      } else {
        const res = await mailApi.createDraft(company.id, account.id, input);
        toast("Draft saved", "success");
        navigate(`/c/${company.slug}/mail/t/${res.message.threadId}`);
      }
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
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
        {showCc && (
          <Input label="Cc" value={cc} onChange={(e) => setCc(e.target.value)} />
        )}
        <Input
          label="Subject"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
        />
        <Textarea
          label="Message"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={10}
        />
        <AttachmentBar
          items={attach.items}
          uploading={attach.uploading}
          onAdd={attach.addFiles}
          onRemove={attach.remove}
        />
        <FormError message={error} />
        <div className="flex items-center justify-end gap-2">
          <Button
            variant="secondary"
            disabled={busy !== null || attach.uploading}
            onClick={() => submit("draft")}
          >
            {busy === "draft" ? <Spinner size={14} /> : "Save draft"}
          </Button>
          <Button
            disabled={busy !== null || attach.uploading}
            onClick={() => submit("send")}
          >
            {busy === "send" ? <Spinner size={14} /> : "Send"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
