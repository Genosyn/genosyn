import React from "react";
import { useNavigate } from "react-router-dom";
import {
  AlertTriangle,
  Archive,
  ArrowUpRight,
  Bot,
  Check,
  ExternalLink,
  Inbox,
  Reply,
  Send,
  SlidersHorizontal,
  Sparkles,
  Star,
  Tag,
  Trash2,
  X,
} from "lucide-react";
import { Company, MessageAction } from "../lib/api";
import {
  ComposeInput,
  MailAccount,
  MailAssistantMessage,
  MailAssistantRosterEntry,
  MailSuggestion,
  mailApi,
} from "../lib/mail";
import { ChatMarkdown } from "../components/ChatMarkdown";
import { Avatar, employeeAvatarUrl } from "../components/ui/Avatar";
import { useDialog } from "../components/ui/Dialog";
import { Spinner } from "../components/ui/Spinner";
import { clsx } from "../components/ui/clsx";
import { useToast } from "../components/ui/Toast";

/**
 * The mail assistant panel — a chat rail beside the Email section where any
 * AI employee can be @-tagged and put to work on the mailbox. Replies come
 * back with action pills (what the employee did) and suggestion buttons
 * (what it proposes the human does next, executed here through the ordinary
 * mail routes with the human's own authority).
 *
 * One rolling conversation per mailbox, streamed over SSE like employee
 * chat. The employee the last reply came from stays "on the thread" until
 * somebody else is tagged.
 */

type Props = {
  company: Company;
  account: MailAccount;
  /** Local thread id the human is currently viewing, if any. */
  threadId: string | null;
  onClose: () => void;
  openCompose: (init?: Partial<ComposeInput>) => void;
};

export function MailAssistant({
  company,
  account,
  threadId,
  onClose,
  openCompose,
}: Props) {
  const { toast } = useToast();
  const navigate = useNavigate();
  const [messages, setMessages] = React.useState<MailAssistantMessage[] | null>(
    null,
  );
  const [roster, setRoster] = React.useState<MailAssistantRosterEntry[]>([]);
  const [draft, setDraft] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [streaming, setStreaming] = React.useState<string | null>(null);
  const [target, setTarget] = React.useState<{
    id: string;
    name: string;
    slug: string;
  } | null>(null);
  const scrollerRef = React.useRef<HTMLDivElement | null>(null);
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);
  // In-flight SSE turn — aborted when the mailbox changes or the panel
  // unmounts, so a slow reply can't paint into the wrong conversation.
  const streamAbortRef = React.useRef<AbortController | null>(null);

  // ── mention picker state ──
  const [mentionQuery, setMentionQuery] = React.useState<string | null>(null);
  const [mentionIndex, setMentionIndex] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;
    setMessages(null);
    setTarget(null);
    setStreaming(null);
    setBusy(false);
    mailApi
      .assistant(company.id, account.id)
      .then((res) => {
        if (cancelled) return;
        // Merge rather than replace: a message sent while the bootstrap was
        // in flight must survive (its optimistic bubble isn't in `res`).
        setMessages((prev) => {
          if (!prev || prev.length === 0) return res.messages;
          const known = new Set(res.messages.map((m) => m.id));
          return [...res.messages, ...prev.filter((m) => !known.has(m.id))];
        });
        setRoster(res.roster);
        const lastAnswered = [...res.messages]
          .reverse()
          .find((m) => m.role === "assistant" && m.employeeId);
        if (lastAnswered?.employeeId) {
          const emp = res.roster.find((r) => r.id === lastAnswered.employeeId);
          if (emp) {
            setTarget((cur) => cur ?? { id: emp.id, name: emp.name, slug: emp.slug });
          }
        }
      })
      .catch((err) => {
        if (!cancelled) toast((err as Error).message, "error");
      });
    return () => {
      cancelled = true;
      streamAbortRef.current?.abort();
      streamAbortRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [company.id, account.id]);

  const scrollToBottom = React.useCallback(() => {
    requestAnimationFrame(() => {
      const el = scrollerRef.current;
      if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    });
  }, []);

  React.useEffect(() => {
    scrollToBottom();
  }, [messages?.length, streaming, scrollToBottom]);

  const send = React.useCallback(
    async (text: string) => {
      const message = text.trim();
      if (!message || busy) return;
      setBusy(true);
      setDraft("");
      setMentionQuery(null);
      // Optimistic bubble; swapped for the persisted row on the `user` event.
      const temp: MailAssistantMessage = {
        id: `temp-${Date.now()}`,
        accountId: account.id,
        threadId,
        role: "user",
        employeeId: null,
        content: message,
        status: null,
        actions: [],
        suggestions: [],
        createdAt: new Date().toISOString(),
      };
      setMessages((prev) => [...(prev ?? []), temp]);
      let sawAssistant = false;
      let accumulated = "";
      const controller = new AbortController();
      streamAbortRef.current?.abort();
      streamAbortRef.current = controller;
      try {
        await mailApi.assistantSend(
          company.id,
          account.id,
          {
            message,
            threadId: threadId ?? undefined,
            employeeId: target?.id,
          },
          (event, data) => {
            if (event === "user") {
              const row = data as MailAssistantMessage;
              setMessages((prev) =>
                (prev ?? []).map((m) => (m.id === temp.id ? row : m)),
              );
            } else if (event === "target") {
              const emp = (
                data as {
                  employee: { id: string; name: string; slug: string } | null;
                }
              ).employee;
              setTarget(emp);
            } else if (event === "chunk") {
              accumulated += (data as { text: string }).text;
              setStreaming(accumulated);
            } else if (event === "assistant") {
              sawAssistant = true;
              setStreaming(null);
              setMessages((prev) => [...(prev ?? []), data as MailAssistantMessage]);
            } else if (event === "error") {
              throw new Error((data as { message: string }).message);
            }
          },
          { signal: controller.signal },
        );
      } catch (err) {
        // A deliberate cancel (mailbox switch, unmount) is not an error the
        // human needs a bubble for.
        const aborted = (err as Error).name === "AbortError" || controller.signal.aborted;
        if (!sawAssistant && !aborted) {
          setMessages((prev) => [
            ...(prev ?? []),
            {
              ...temp,
              id: `temp-err-${Date.now()}`,
              role: "assistant",
              status: "error",
              content: accumulated
                ? `${accumulated}\n\n${(err as Error).message}`
                : (err as Error).message,
            },
          ]);
        }
      } finally {
        if (streamAbortRef.current === controller) streamAbortRef.current = null;
        setStreaming(null);
        setBusy(false);
        scrollToBottom();
      }
    },
    [busy, company.id, account.id, threadId, target, scrollToBottom],
  );

  const markExecuted = React.useCallback(
    (updated: MailAssistantMessage) => {
      setMessages((prev) =>
        (prev ?? []).map((m) => (m.id === updated.id ? updated : m)),
      );
    },
    [],
  );

  const clearConversation = async () => {
    try {
      await mailApi.assistantClear(company.id, account.id);
      setMessages([]);
      setTarget(null);
    } catch (err) {
      toast((err as Error).message, "error");
    }
  };

  // ── mention picker mechanics ──

  const mentionCandidates = React.useMemo(() => {
    if (mentionQuery === null) return [];
    const q = mentionQuery.toLowerCase();
    return roster
      .filter((r) => r.slug.includes(q) || r.name.toLowerCase().includes(q))
      .slice(0, 6);
  }, [mentionQuery, roster]);

  const refreshMentionState = (value: string, caret: number) => {
    const upToCaret = value.slice(0, caret);
    const match = /(^|[\s(])@([a-z0-9-]*)$/i.exec(upToCaret);
    setMentionQuery(match ? match[2] : null);
    setMentionIndex(0);
  };

  const insertMention = (emp: MailAssistantRosterEntry) => {
    const el = textareaRef.current;
    const caret = el ? el.selectionStart : draft.length;
    const upToCaret = draft.slice(0, caret);
    // The picker can outlive the caret (it only re-syncs on change/select
    // events) — if there's no @token at the caret anymore, just close it
    // rather than splicing a mention into the wrong place.
    if (!/@([a-z0-9-]*)$/i.test(upToCaret)) {
      setMentionQuery(null);
      return;
    }
    const replaced = upToCaret.replace(/@([a-z0-9-]*)$/i, `@${emp.slug} `);
    const next = replaced + draft.slice(caret);
    setDraft(next);
    setMentionQuery(null);
    setTarget({ id: emp.id, name: emp.name, slug: emp.slug });
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(replaced.length, replaced.length);
    });
  };

  const onComposerKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentionQuery !== null && mentionCandidates.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionIndex((i) => (i + 1) % mentionCandidates.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionIndex(
          (i) => (i - 1 + mentionCandidates.length) % mentionCandidates.length,
        );
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        insertMention(mentionCandidates[mentionIndex]);
        return;
      }
      if (e.key === "Escape") {
        setMentionQuery(null);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send(draft);
    }
  };

  const quickPrompts = threadId
    ? [
        "Summarize this thread and what it needs from me.",
        "Draft a reply to this thread.",
        "Triage this — label it and archive if nothing is needed.",
      ]
    : [
        "What needs my attention in the inbox?",
        "Which threads are still waiting on a reply from us?",
        "Find newsletters cluttering the inbox and propose a rule.",
      ];

  return (
    <div className="flex h-full flex-col bg-white dark:bg-slate-950">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-slate-200 px-3 py-2.5 dark:border-slate-800">
        <div className="flex h-7 w-7 items-center justify-center rounded-md bg-violet-500/15">
          <Sparkles size={14} className="text-violet-600 dark:text-violet-300" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            Mail assistant
          </div>
          <div className="truncate text-[11px] text-slate-500 dark:text-slate-400">
            {target ? `Talking to ${target.name}` : "Tag an AI employee with @"}
          </div>
        </div>
        {messages !== null && messages.length > 0 && (
          <button
            onClick={() => void clearConversation()}
            className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800 dark:hover:text-slate-300"
            title="Clear conversation"
          >
            <Trash2 size={14} />
          </button>
        )}
        <button
          onClick={onClose}
          className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800 dark:hover:text-slate-300"
          title="Close"
        >
          <X size={15} />
        </button>
      </div>

      {/* Messages */}
      <div ref={scrollerRef} className="flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {messages === null ? (
          <div className="flex h-full items-center justify-center">
            <Spinner size={18} />
          </div>
        ) : messages.length === 0 && !streaming ? (
          <IntroTips
            roster={roster}
            companyId={company.id}
            prompts={quickPrompts}
            onPick={(p) => {
              setDraft(p);
              textareaRef.current?.focus();
            }}
          />
        ) : (
          <>
            {messages.map((m) => (
              <MessageRow
                key={m.id}
                message={m}
                company={company}
                account={account}
                roster={roster}
                openCompose={openCompose}
                navigate={(to) => navigate(to)}
                onExecuted={markExecuted}
              />
            ))}
          </>
        )}
        {busy && streaming === null && (
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <Spinner size={12} />
            {target ? `${target.name} is thinking…` : "Thinking…"}
          </div>
        )}
        {streaming !== null && (
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-800 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200">
            <ChatMarkdown content={streaming} />
            <span className="ml-0.5 inline-block h-3.5 w-[2px] animate-pulse bg-slate-400 align-middle" />
          </div>
        )}
      </div>

      {/* Composer */}
      <div className="relative border-t border-slate-200 p-3 dark:border-slate-800">
        {mentionQuery !== null && mentionCandidates.length > 0 && (
          <div className="absolute bottom-full left-3 right-3 z-10 mb-1 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-lg dark:border-slate-700 dark:bg-slate-900">
            {mentionCandidates.map((r, i) => (
              <button
                key={r.id}
                onMouseDown={(e) => {
                  e.preventDefault();
                  insertMention(r);
                }}
                className={clsx(
                  "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm",
                  i === mentionIndex
                    ? "bg-indigo-50 dark:bg-indigo-500/10"
                    : "hover:bg-slate-50 dark:hover:bg-slate-800",
                )}
              >
                <Avatar
                  name={r.name}
                  src={employeeAvatarUrl(company.id, r.id, r.avatarKey)}
                  kind="ai"
                  size="sm"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-slate-900 dark:text-slate-100">
                    {r.name}
                  </span>
                  <span className="block truncate text-[11px] text-slate-500">
                    @{r.slug}
                    {!r.hasModel
                      ? " · no model connected"
                      : r.accessLevel
                        ? ` · ${r.accessLevel} access`
                        : " · no mailbox access"}
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2 rounded-lg border border-slate-200 bg-white px-2.5 py-2 focus-within:border-indigo-400 dark:border-slate-700 dark:bg-slate-900">
          <textarea
            ref={textareaRef}
            value={draft}
            rows={2}
            placeholder={`Ask about ${account.address} — @ to tag an employee`}
            onChange={(e) => {
              setDraft(e.target.value);
              refreshMentionState(e.target.value, e.target.selectionStart);
            }}
            onSelect={(e) => {
              // Caret moves (arrows, clicks) must re-sync the picker so a
              // stale Enter can't insert a mention at the wrong spot.
              const el = e.currentTarget;
              refreshMentionState(el.value, el.selectionStart);
            }}
            onBlur={() => setMentionQuery(null)}
            onKeyDown={onComposerKeyDown}
            className="max-h-40 min-h-[2.5rem] flex-1 resize-none bg-transparent text-sm text-slate-900 outline-none placeholder:text-slate-400 dark:text-slate-100"
          />
          <button
            onClick={() => void send(draft)}
            disabled={!draft.trim() || busy}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-indigo-600 text-white transition-opacity hover:bg-indigo-500 disabled:opacity-40"
            title="Send (Enter)"
          >
            <Send size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}

// ───────────────────────────── empty state ─────────────────────────────

function IntroTips({
  roster,
  companyId,
  prompts,
  onPick,
}: {
  roster: MailAssistantRosterEntry[];
  companyId: string;
  prompts: string[];
  onPick: (p: string) => void;
}) {
  const taggable = roster.filter((r) => r.hasModel);
  return (
    <div className="rounded-xl border border-dashed border-slate-200 p-4 dark:border-slate-800">
      <div className="mb-2 flex items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-300">
        <Bot size={15} className="text-violet-500" /> Put your AI employees on
        this inbox
      </div>
      <p className="mb-3 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
        Tag anyone with <code className="rounded bg-slate-100 px-1 dark:bg-slate-800">@</code> and
        ask them to summarize, draft, triage, or clean up. They&apos;ll act
        within their mailbox access and hand you buttons for anything that
        needs your sign-off.
      </p>
      {taggable.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-1.5">
          {taggable.slice(0, 5).map((r) => (
            <button
              key={r.id}
              onClick={() => onPick(`@${r.slug} `)}
              className="flex items-center gap-1.5 rounded-full border border-slate-200 py-0.5 pl-0.5 pr-2 text-xs text-slate-600 hover:border-indigo-300 hover:text-indigo-600 dark:border-slate-700 dark:text-slate-300 dark:hover:border-indigo-500/50 dark:hover:text-indigo-300"
            >
              <Avatar
                name={r.name}
                src={employeeAvatarUrl(companyId, r.id, r.avatarKey)}
                kind="ai"
                size="xs"
              />
              {r.name}
            </button>
          ))}
        </div>
      )}
      <div className="space-y-1.5">
        {prompts.map((p) => (
          <button
            key={p}
            onClick={() => onPick(p)}
            className="block w-full rounded-md border border-slate-200 px-2.5 py-1.5 text-left text-xs text-slate-600 hover:border-indigo-300 hover:bg-indigo-50/50 hover:text-indigo-700 dark:border-slate-800 dark:text-slate-400 dark:hover:border-indigo-500/40 dark:hover:bg-indigo-500/5 dark:hover:text-indigo-300"
          >
            {p}
          </button>
        ))}
      </div>
    </div>
  );
}

// ───────────────────────────── message row ─────────────────────────────

function MessageRow({
  message,
  company,
  account,
  roster,
  openCompose,
  navigate,
  onExecuted,
}: {
  message: MailAssistantMessage;
  company: Company;
  account: MailAccount;
  roster: MailAssistantRosterEntry[];
  openCompose: (init?: Partial<ComposeInput>) => void;
  navigate: (to: string) => void;
  onExecuted: (updated: MailAssistantMessage) => void;
}) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-lg bg-indigo-600 px-3 py-2 text-sm text-white">
          {message.content}
        </div>
      </div>
    );
  }

  const emp = message.employeeId
    ? roster.find((r) => r.id === message.employeeId)
    : undefined;
  const isError = message.status === "error";
  const isSkipped = message.status === "skipped";

  return (
    <div className="flex items-start gap-2">
      {emp ? (
        <Avatar
          name={emp.name}
          src={employeeAvatarUrl(company.id, emp.id, emp.avatarKey)}
          kind="ai"
          size="sm"
          className="mt-0.5"
        />
      ) : (
        <div
          className={clsx(
            "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full",
            isError
              ? "bg-rose-100 dark:bg-rose-500/15"
              : "bg-violet-100 dark:bg-violet-500/15",
          )}
        >
          {isError ? (
            <AlertTriangle size={12} className="text-rose-600 dark:text-rose-300" />
          ) : (
            <Bot size={12} className="text-violet-600 dark:text-violet-300" />
          )}
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="mb-0.5 text-[11px] text-slate-400 dark:text-slate-500">
          {emp?.name ?? "Mail assistant"}
          {isSkipped ? " · skipped" : ""}
        </div>
        <div
          className={clsx(
            "rounded-lg px-3 py-2 text-sm",
            isError
              ? "bg-rose-50 text-rose-900 dark:bg-rose-500/10 dark:text-rose-200"
              : isSkipped
                ? "bg-amber-50 text-amber-900 dark:bg-amber-500/10 dark:text-amber-200"
                : "bg-slate-50 text-slate-800 dark:bg-slate-900 dark:text-slate-200",
          )}
        >
          {isError || isSkipped ? (
            <div className="whitespace-pre-wrap break-words">{message.content}</div>
          ) : (
            <ChatMarkdown content={message.content} />
          )}
        </div>
        {message.actions.length > 0 && <ActionPills actions={message.actions} />}
        {message.suggestions.length > 0 && (
          <SuggestionButtons
            message={message}
            company={company}
            account={account}
            openCompose={openCompose}
            navigate={navigate}
            onExecuted={onExecuted}
          />
        )}
      </div>
    </div>
  );
}

/** Compact "what the employee did" chips — evidence from AuditEvents. */
function ActionPills({ actions }: { actions: MessageAction[] }) {
  return (
    <div className="mt-1.5 flex flex-wrap gap-1">
      {actions.map((a, i) => (
        <span
          key={i}
          className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[11px] text-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400"
          title={a.targetLabel ?? a.action}
        >
          <Check size={10} className="text-emerald-500" />
          <span className="max-w-[180px] truncate">
            {describeAction(a)}
          </span>
        </span>
      ))}
    </div>
  );
}

function describeAction(a: MessageAction): string {
  const label = a.targetLabel ? ` "${a.targetLabel}"` : "";
  switch (a.action) {
    case "mail.draft.create":
      return `Drafted${label}`;
    case "mail.send":
      return `Sent${label}`;
    case "mail.thread.action":
      return `Triaged${label}`;
    case "mail.handover.create":
      return `Handed over${label}`;
    default:
      return `${a.action}${label}`;
  }
}

// ───────────────────────────── suggestion buttons ─────────────────────────────

const SUGGESTION_ICONS: Record<MailSuggestion["kind"], React.ReactNode> = {
  reply: <Reply size={12} />,
  send_draft: <Send size={12} />,
  thread_action: <Tag size={12} />,
  open_thread: <ExternalLink size={12} />,
  hand_over: <Bot size={12} />,
  create_rule: <SlidersHorizontal size={12} />,
};

function iconForSuggestion(s: MailSuggestion): React.ReactNode {
  if (s.kind === "thread_action") {
    switch (s.action) {
      case "archive":
        return <Archive size={12} />;
      case "star":
      case "unstar":
        return <Star size={12} />;
      case "trash":
        return <Trash2 size={12} />;
      case "moveToInbox":
        return <Inbox size={12} />;
      default:
        return <Tag size={12} />;
    }
  }
  return SUGGESTION_ICONS[s.kind] ?? <ArrowUpRight size={12} />;
}

/**
 * The one-click buttons an employee proposed. Consuming actions
 * (send/triage/handover/rule) are stamped executed server-side so a reload
 * can't re-arm them; opening a composer or a thread stays repeatable.
 */
function SuggestionButtons({
  message,
  company,
  account,
  openCompose,
  navigate,
  onExecuted,
}: {
  message: MailAssistantMessage;
  company: Company;
  account: MailAccount;
  openCompose: (init?: Partial<ComposeInput>) => void;
  navigate: (to: string) => void;
  onExecuted: (updated: MailAssistantMessage) => void;
}) {
  const { toast } = useToast();
  const dialog = useDialog();
  const [busyId, setBusyId] = React.useState<string | null>(null);

  const markExecuted = async (s: MailSuggestion) => {
    try {
      const res = await mailApi.assistantMarkExecuted(company.id, message.id, s.id);
      onExecuted(res.message);
    } catch {
      // Non-fatal: the action itself succeeded; the stamp is bookkeeping.
    }
  };

  const run = async (s: MailSuggestion) => {
    if (busyId || s.executedAt) return;
    setBusyId(s.id);
    try {
      switch (s.kind) {
        case "reply": {
          // The tool contract lets a reply carry just threadId + bodyText;
          // resolve the recipients the same way ReplyComposer does so the
          // composer opens sendable.
          let to = s.to;
          let cc = s.cc;
          if (s.threadId && !to) {
            const rec = await mailApi
              .replyRecipients(company.id, s.threadId)
              .catch(() => null);
            to = rec?.to;
            cc = cc ?? (rec?.cc || undefined);
          }
          openCompose({
            to,
            cc,
            subject: s.subject,
            bodyText: s.bodyText ?? "",
            threadId: s.threadId,
          });
          break;
        }
        case "open_thread":
          navigate(`/c/${company.slug}/mail/t/${s.threadId}`);
          break;
        case "send_draft": {
          // The button label is model-authored; the recipient/subject shown
          // here are the server-verified snapshot. Mail leaves the building
          // only after the human has seen where it's going.
          const ok = await dialog.confirm({
            title: "Send this draft?",
            message: (
              <span className="block whitespace-pre-wrap">
                {`To: ${s.targetTo || "(no recipients)"}\nSubject: ${s.targetSubject || "(no subject)"}`}
              </span>
            ),
            confirmLabel: "Send",
          });
          if (!ok) break;
          await mailApi.sendDraft(company.id, s.messageId!);
          toast("Sent", "success");
          await markExecuted(s);
          break;
        }
        case "thread_action": {
          if (s.action === "trash") {
            const ok = await dialog.confirm({
              title: "Move thread to trash?",
              message: s.targetSubject || "(no subject)",
              confirmLabel: "Trash",
              variant: "danger",
            });
            if (!ok) break;
          }
          await mailApi.threadAction(company.id, s.threadId!, s.action!, {
            labelName: s.labelName,
          });
          toast("Done", "success");
          await markExecuted(s);
          break;
        }
        case "hand_over":
          await mailApi.createHandover(company.id, s.threadId!, {
            employeeId: s.employeeId!,
            instruction: s.instruction ?? "",
            mode: s.mode ?? "draft",
          });
          toast("Handover started", "success");
          await markExecuted(s);
          break;
        case "create_rule":
          await mailApi.createRule(company.id, s.accountId ?? account.id, {
            name: s.rule!.name,
            enabled: true,
            conditions: s.rule!.conditions,
            actions: s.rule!.actions,
          });
          toast("Rule created — see Automation → Rules", "success");
          await markExecuted(s);
          break;
      }
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {message.suggestions.map((s) => {
        const spent = Boolean(s.executedAt);
        const verified = verifiedTarget(s);
        return (
          <button
            key={s.id}
            disabled={spent || busyId !== null}
            onClick={() => void run(s)}
            title={spent ? "Already done" : suggestionHint(s)}
            className={clsx(
              "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-left text-xs font-medium transition-colors",
              spent
                ? "cursor-default border-slate-200 text-slate-400 line-through dark:border-slate-800 dark:text-slate-600"
                : "border-indigo-200 bg-indigo-50/60 text-indigo-700 hover:bg-indigo-100 dark:border-indigo-500/30 dark:bg-indigo-500/10 dark:text-indigo-300 dark:hover:bg-indigo-500/20",
            )}
          >
            {busyId === s.id ? (
              <Spinner size={12} />
            ) : spent ? (
              <Check size={12} />
            ) : (
              iconForSuggestion(s)
            )}
            <span className="min-w-0">
              <span className="block">{s.label}</span>
              {verified && !spent && (
                <span className="block max-w-[220px] truncate text-[10px] font-normal text-indigo-500/80 dark:text-indigo-300/70">
                  {verified}
                </span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * Server-verified context shown under the model-authored label, so the
 * human approves the checked target — not the label's claim about it.
 */
function verifiedTarget(s: MailSuggestion): string | null {
  switch (s.kind) {
    case "send_draft":
      return s.targetTo ? `to ${s.targetTo}` : null;
    case "thread_action":
    case "open_thread":
      return s.targetSubject ? `"${s.targetSubject}"` : null;
    case "hand_over":
      return s.targetEmployeeName
        ? `${s.targetEmployeeName}${s.targetSubject ? ` · "${s.targetSubject}"` : ""}`
        : null;
    case "reply":
      return s.targetSubject ? `"${s.targetSubject}"` : null;
    default:
      return null;
  }
}

function suggestionHint(s: MailSuggestion): string {
  switch (s.kind) {
    case "reply":
      return "Opens the composer pre-filled — nothing sends until you do";
    case "send_draft":
      return "Sends the draft immediately";
    case "thread_action":
      return "Applies the triage action to the thread";
    case "open_thread":
      return "Opens the thread";
    case "hand_over":
      return "Hands the thread to an AI employee";
    case "create_rule":
      return "Creates the inbox rule";
    default:
      return s.label;
  }
}
