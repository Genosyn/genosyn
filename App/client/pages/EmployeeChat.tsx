import React from "react";
import { Link, useOutletContext } from "react-router-dom";
import { marked } from "marked";
import DOMPurify from "dompurify";
import {
  AlertCircle,
  Archive,
  ArchiveRestore,
  Check,
  ChevronDown,
  ChevronRight,
  CircleSlash,
  MessageSquarePlus,
  Plug,
  Send,
  Sparkles,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import {
  ConversationMessage,
  ConversationSummary,
  MessageAction,
} from "../lib/api";
import { useEmployeeSession } from "../lib/chatSessions";
import { useToast } from "../components/ui/Toast";
import { useDialog } from "../components/ui/Dialog";
import type { EmployeeOutletCtx } from "./EmployeeLayout";

/**
 * Chat with the selected employee. Threads are persisted server-side; the
 * left rail lists them newest-first and the main panel shows the selected
 * thread. Durable state (messages, the in-flight streaming reply, the typed
 * input, the selected thread) lives in `ChatSessionsProvider` so navigating
 * to another page mid-conversation and returning keeps the turn intact.
 */

export default function EmployeeChat() {
  const { company, emp } = useOutletContext<EmployeeOutletCtx>();
  const { toast } = useToast();
  const dialog = useDialog();
  const { session, actions } = useEmployeeSession(emp.id);
  const {
    activeConvId,
    loadedConvId,
    messages,
    streamingReply,
    sending,
    input,
    convs,
    convsLoaded,
    convLoading,
  } = session;

  /** Action whose details are open in the logs modal; null when closed. */
  const [inspectAction, setInspectAction] =
    React.useState<MessageAction | null>(null);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLTextAreaElement>(null);

  // Fetch the conversation list for this employee the first time we mount.
  // `initEmployee` is a no-op once `convsLoaded` is true, so coming back to
  // this tab keeps whatever the user had selected.
  React.useEffect(() => {
    actions
      .initEmployee(company.id, emp.id)
      .catch((err) => toast((err as Error).message, "error"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emp.id]);

  // Load the selected conversation's messages whenever the pointer drifts
  // from what's loaded. Skipped if we already hold the messages for it.
  React.useEffect(() => {
    if (!activeConvId) return;
    if (loadedConvId === activeConvId) return;
    actions
      .selectConversation(company.id, emp.id, activeConvId)
      .catch((err) => toast((err as Error).message, "error"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConvId, loadedConvId, emp.id]);

  // Auto-scroll to bottom on new messages or while the reply streams in.
  React.useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, sending, streamingReply]);

  // Auto-grow the textarea as the user types, capped so it doesn't swallow
  // the conversation.
  React.useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
  }, [input]);

  async function handleNewClick() {
    try {
      await actions.newConversation(company.id, emp.id);
      inputRef.current?.focus();
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  async function handleDelete(convId: string) {
    const ok = await dialog.confirm({
      title: "Delete conversation?",
      message: "Every message in this thread will be permanently removed.",
      confirmLabel: "Delete",
      variant: "danger",
    });
    if (!ok) return;
    try {
      await actions.deleteConversation(company.id, emp.id, convId);
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  async function handleArchive(convId: string) {
    try {
      await actions.archiveConversation(company.id, emp.id, convId);
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  async function handleUnarchive(convId: string) {
    try {
      await actions.unarchiveConversation(company.id, emp.id, convId);
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  async function send(messageOverride?: string) {
    if (sending) return;
    const msg = (messageOverride ?? input).trim();
    if (!msg) return;
    const err = await actions.send(company.id, emp.id, msg, {
      clearInput: !messageOverride,
    });
    if (err) toast(err, "error");
    inputRef.current?.focus();
  }

  const activeConv = convs.find((c) => c.id === activeConvId) ?? null;
  // Show a skeleton while bootstrapping or while the active thread is still
  // loading — otherwise there's a visible EmptyState flash between the
  // conv-list fetch and the messages fetch.
  const isLoadingMessages =
    !convsLoaded ||
    convLoading ||
    (!!activeConvId && loadedConvId !== activeConvId);

  return (
    <div className="flex h-full min-h-0 overflow-hidden bg-white dark:bg-slate-950">
      <ConversationList
        convs={convs}
        archivedConvs={session.archivedConvs}
        archivedLoaded={session.archivedLoaded}
        activeId={activeConvId}
        onSelect={(id) => actions.update(emp.id, { activeConvId: id })}
        onDelete={handleDelete}
        onArchive={handleArchive}
        onUnarchive={handleUnarchive}
        onLoadArchived={() =>
          actions
            .loadArchived(company.id, emp.id)
            .catch((err) => toast((err as Error).message, "error"))
        }
        onNew={handleNewClick}
      />

      <section className="flex min-w-0 flex-1 flex-col">
        <ChatHeader
          empName={emp.name}
          empRole={emp.role}
          convTitle={activeConv?.title ?? null}
          onNew={handleNewClick}
        />

        <div
          ref={scrollRef}
          className="flex-1 overflow-y-auto bg-slate-50/50 px-4 py-6 dark:bg-slate-900/40 sm:px-8"
        >
          {isLoadingMessages ? (
            <MessageSkeleton />
          ) : messages.length === 0 ? (
            <EmptyState empName={emp.name} empRole={emp.role} onPick={(t) => send(t)} />
          ) : (
            <div className="mx-auto flex max-w-3xl flex-col gap-5">
              {messages.map((m, i) => (
                <TurnBubble
                  key={m.id}
                  message={m}
                  authorName={emp.name}
                  companySlug={company.slug}
                  employeeSlug={emp.slug}
                  showAvatar={i === 0 || messages[i - 1].role !== m.role}
                  onInspectAction={setInspectAction}
                />
              ))}
              {sending && streamingReply !== null && streamingReply.length > 0 && (
                <StreamingBubble
                  authorName={emp.name}
                  content={streamingReply}
                />
              )}
              {sending &&
                (streamingReply === null || streamingReply.length === 0) && (
                  <TypingIndicator authorName={emp.name} />
                )}
            </div>
          )}
        </div>

        <Composer
          inputRef={inputRef}
          value={input}
          onChange={(v) => actions.update(emp.id, { input: v })}
          onSubmit={() => send()}
          disabled={sending}
          empName={emp.name}
        />
      </section>

      {inspectAction && (
        <ActionDetailModal
          action={inspectAction}
          onClose={() => setInspectAction(null)}
        />
      )}
    </div>
  );
}

// ───────────────────────────── ConversationList ─────────────────────────────

function ConversationList({
  convs,
  archivedConvs,
  archivedLoaded,
  activeId,
  onSelect,
  onDelete,
  onArchive,
  onUnarchive,
  onLoadArchived,
  onNew,
}: {
  convs: ConversationSummary[];
  archivedConvs: ConversationSummary[];
  archivedLoaded: boolean;
  activeId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onArchive: (id: string) => void;
  onUnarchive: (id: string) => void;
  onLoadArchived: () => void;
  onNew: () => void;
}) {
  const [archivedOpen, setArchivedOpen] = React.useState(false);

  function toggleArchived() {
    const next = !archivedOpen;
    setArchivedOpen(next);
    // Fetch lazily — the archived list is a secondary view most people
    // won't open, so we don't want to pay for it on every Chat mount.
    if (next && !archivedLoaded) onLoadArchived();
  }

  return (
    <aside className="hidden w-64 shrink-0 flex-col border-r border-slate-200 bg-slate-50/60 dark:border-slate-800 dark:bg-slate-950 md:flex">
      <div className="flex items-center justify-between border-b border-slate-200 px-3 py-3 dark:border-slate-800">
        <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          Conversations
        </div>
        <button
          onClick={onNew}
          className="flex h-7 w-7 items-center justify-center rounded-md text-slate-500 hover:bg-slate-200/70 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
          aria-label="New conversation"
          title="New conversation"
        >
          <MessageSquarePlus size={15} />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {convs.length === 0 ? (
          <div className="px-2 pt-4 text-xs text-slate-500 dark:text-slate-400">
            No threads yet. Start typing and a new one will appear here.
          </div>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {convs.map((c) => (
              <ConversationRow
                key={c.id}
                conv={c}
                active={c.id === activeId}
                onSelect={onSelect}
                actions={
                  <button
                    onClick={() => onArchive(c.id)}
                    className="rounded p-1 text-slate-400 opacity-0 hover:bg-slate-200 hover:text-slate-700 group-hover:opacity-100 dark:text-slate-500 dark:hover:bg-slate-700 dark:hover:text-slate-200"
                    aria-label="Archive conversation"
                    title="Archive"
                  >
                    <Archive size={12} />
                  </button>
                }
              />
            ))}
          </ul>
        )}

        <div className="mt-3 border-t border-slate-200 pt-2 dark:border-slate-800">
          <button
            onClick={toggleArchived}
            className="flex w-full items-center gap-1 rounded-md px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500 hover:bg-slate-100 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200"
            aria-expanded={archivedOpen}
          >
            {archivedOpen ? (
              <ChevronDown size={12} />
            ) : (
              <ChevronRight size={12} />
            )}
            <span className="flex-1 text-left">Archived</span>
            {archivedLoaded && archivedConvs.length > 0 && (
              <span className="text-slate-400 dark:text-slate-500">
                {archivedConvs.length}
              </span>
            )}
          </button>
          {archivedOpen &&
            (!archivedLoaded ? (
              <div className="px-2 py-2 text-[11px] text-slate-400 dark:text-slate-500">
                Loading…
              </div>
            ) : archivedConvs.length === 0 ? (
              <div className="px-2 py-2 text-[11px] text-slate-400 dark:text-slate-500">
                Nothing archived.
              </div>
            ) : (
              <ul className="flex flex-col gap-0.5 pt-1">
                {archivedConvs.map((c) => (
                  <ConversationRow
                    key={c.id}
                    conv={c}
                    active={c.id === activeId}
                    onSelect={onSelect}
                    muted
                    actions={
                      <>
                        <button
                          onClick={() => onUnarchive(c.id)}
                          className="rounded p-1 text-slate-400 opacity-0 hover:bg-slate-200 hover:text-emerald-600 group-hover:opacity-100 dark:text-slate-500 dark:hover:bg-slate-700 dark:hover:text-emerald-400"
                          aria-label="Unarchive conversation"
                          title="Unarchive"
                        >
                          <ArchiveRestore size={12} />
                        </button>
                        <button
                          onClick={() => onDelete(c.id)}
                          className="rounded p-1 text-slate-400 opacity-0 hover:bg-slate-200 hover:text-rose-600 group-hover:opacity-100 dark:text-slate-500 dark:hover:bg-slate-700 dark:hover:text-rose-400"
                          aria-label="Delete conversation"
                          title="Delete"
                        >
                          <Trash2 size={12} />
                        </button>
                      </>
                    }
                  />
                ))}
              </ul>
            ))}
        </div>
      </div>
    </aside>
  );
}

function ConversationRow({
  conv,
  active,
  muted,
  onSelect,
  actions,
}: {
  conv: ConversationSummary;
  active: boolean;
  muted?: boolean;
  onSelect: (id: string) => void;
  actions: React.ReactNode;
}) {
  return (
    <li>
      <div
        className={
          "group flex items-center gap-1 rounded-md px-2 py-1.5 text-sm " +
          (active
            ? "bg-white text-slate-900 shadow-sm ring-1 ring-slate-200 dark:bg-slate-800 dark:text-slate-100 dark:ring-slate-700"
            : (muted
                ? "text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800/70"
                : "text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800/70"))
        }
      >
        <button
          onClick={() => onSelect(conv.id)}
          className="flex-1 min-w-0 text-left"
          title={conv.title ?? "New conversation"}
        >
          <div className="truncate text-[13px] font-medium">
            {conv.title ?? (
              <span className="italic text-slate-400 dark:text-slate-500">
                New conversation
              </span>
            )}
          </div>
          <div className="mt-0.5 truncate text-[11px] text-slate-400 dark:text-slate-500">
            {formatRelative(conv.lastMessageAt ?? conv.updatedAt)}
          </div>
        </button>
        {actions}
      </div>
    </li>
  );
}

// ───────────────────────────── ChatHeader ─────────────────────────────

function ChatHeader({
  empName,
  empRole,
  convTitle,
  onNew,
}: {
  empName: string;
  empRole: string;
  convTitle: string | null;
  onNew: () => void;
}) {
  return (
    <header className="flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-3 dark:border-slate-800 dark:bg-slate-950 sm:px-6">
      <Avatar name={empName} size={36} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <div className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">
            {empName}
          </div>
          <div className="hidden truncate text-xs text-slate-500 dark:text-slate-400 sm:block">
            {empRole}
          </div>
        </div>
        <div className="truncate text-[11px] text-slate-400 dark:text-slate-500">
          {convTitle ?? "New conversation"}
        </div>
      </div>
      <button
        onClick={onNew}
        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 text-xs font-medium text-slate-700 hover:bg-slate-50 md:hidden dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
        aria-label="New conversation"
      >
        <MessageSquarePlus size={13} /> New
      </button>
    </header>
  );
}

// ───────────────────────────── Messages ─────────────────────────────

function TurnBubble({
  message,
  authorName,
  companySlug,
  employeeSlug,
  showAvatar,
  onInspectAction,
}: {
  message: ConversationMessage;
  authorName: string;
  companySlug: string;
  employeeSlug: string;
  showAvatar: boolean;
  onInspectAction: (a: MessageAction) => void;
}) {
  const mine = message.role === "user";

  if (mine) {
    return (
      <div className="flex justify-end">
        <div className="group max-w-[85%] sm:max-w-[75%]">
          <div className="rounded-2xl rounded-br-md bg-indigo-600 px-3.5 py-2 text-sm leading-relaxed text-white shadow-sm">
            <div className="whitespace-pre-wrap break-words">{message.content}</div>
          </div>
          <div className="mt-1 pr-1 text-right text-[10px] text-slate-400 opacity-0 transition group-hover:opacity-100 dark:text-slate-500">
            {formatTime(message.createdAt)}
          </div>
        </div>
      </div>
    );
  }

  const isError = message.status === "error";
  const isSkipped = message.status === "skipped";

  return (
    <div className="flex justify-start gap-2.5">
      <div className={"w-9 shrink-0 " + (showAvatar ? "" : "invisible")}>
        <Avatar name={authorName} size={32} />
      </div>
      <div className="group min-w-0 max-w-[85%] sm:max-w-[75%]">
        {showAvatar && (
          <div className="mb-1 flex items-center gap-1.5 text-[11px]">
            <span className="font-medium text-slate-700 dark:text-slate-200">{authorName}</span>
            {isError && (
              <span className="inline-flex items-center gap-1 rounded-full bg-rose-50 px-1.5 py-0.5 text-[10px] font-medium text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">
                <AlertCircle size={10} /> error
              </span>
            )}
            {isSkipped && (
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">
                <CircleSlash size={10} /> not available
              </span>
            )}
          </div>
        )}
        <div
          className={
            "rounded-2xl rounded-tl-md px-3.5 py-2 text-sm leading-relaxed shadow-sm " +
            (isError
              ? "border border-rose-200 bg-rose-50 text-rose-900 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-100"
              : isSkipped
                ? "border border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100"
                : "border border-slate-200 bg-white text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100")
          }
        >
          {isError || isSkipped ? (
            <div className="whitespace-pre-wrap break-words">{message.content}</div>
          ) : (
            <ChatMarkdown content={message.content} />
          )}
        </div>
        {message.actions && message.actions.length > 0 && (
          <ActionPills
            actions={message.actions}
            companySlug={companySlug}
            employeeSlug={employeeSlug}
            onInspect={onInspectAction}
          />
        )}
        <div className="mt-1 pl-1 text-[10px] text-slate-400 opacity-0 transition group-hover:opacity-100 dark:text-slate-500">
          {formatTime(message.createdAt)}
        </div>
      </div>
    </div>
  );
}

function StreamingBubble({
  authorName,
  content,
}: {
  authorName: string;
  content: string;
}) {
  return (
    <div className="flex justify-start gap-2.5">
      <div className="w-9 shrink-0">
        <Avatar name={authorName} size={32} />
      </div>
      <div className="min-w-0 max-w-[85%] sm:max-w-[75%]">
        <div className="mb-1 text-[11px] font-medium text-slate-700 dark:text-slate-200">
          {authorName}
        </div>
        <div className="rounded-2xl rounded-tl-md border border-slate-200 bg-white px-3.5 py-2 text-sm leading-relaxed text-slate-900 shadow-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100">
          <ChatMarkdown content={content} />
          <span
            className="ml-0.5 inline-block h-3.5 w-1.5 translate-y-[2px] bg-indigo-500"
            style={{ animation: "chatCursor 1s steps(2) infinite" }}
          />
        </div>
      </div>
    </div>
  );
}

function TypingIndicator({ authorName }: { authorName: string }) {
  return (
    <div className="flex justify-start gap-2.5">
      <div className="w-9 shrink-0">
        <Avatar name={authorName} size={32} />
      </div>
      <div>
        <div className="mb-1 text-[11px] font-medium text-slate-700 dark:text-slate-200">
          {authorName}
        </div>
        <div className="inline-flex items-center gap-1 rounded-2xl rounded-tl-md border border-slate-200 bg-white px-3.5 py-2.5 shadow-sm dark:border-slate-700 dark:bg-slate-900">
          <Dot delay="0s" />
          <Dot delay="0.15s" />
          <Dot delay="0.3s" />
        </div>
      </div>
    </div>
  );
}

function Dot({ delay }: { delay: string }) {
  return (
    <span
      className="h-1.5 w-1.5 rounded-full bg-slate-400 dark:bg-slate-500"
      style={{
        animation: "chatDot 1.2s ease-in-out infinite",
        animationDelay: delay,
      }}
    />
  );
}

function MessageSkeleton() {
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5">
      <div className="flex justify-start gap-2.5">
        <div className="h-8 w-8 shrink-0 animate-pulse rounded-full bg-slate-200 dark:bg-slate-800" />
        <div className="flex flex-col gap-2">
          <div className="h-3 w-24 animate-pulse rounded bg-slate-200 dark:bg-slate-800" />
          <div className="h-10 w-64 animate-pulse rounded-2xl bg-slate-200 dark:bg-slate-800" />
        </div>
      </div>
      <div className="flex justify-end">
        <div className="h-10 w-56 animate-pulse rounded-2xl bg-slate-200 dark:bg-slate-800" />
      </div>
    </div>
  );
}

// ───────────────────────────── Empty state ─────────────────────────────

function EmptyState({
  empName,
  empRole,
  onPick,
}: {
  empName: string;
  empRole: string;
  onPick: (prompt: string) => void;
}) {
  const suggestions = [
    `What are you working on right now, ${empName.split(" ")[0]}?`,
    "Help me plan my week.",
    "Summarize what you'd do first on a new project.",
  ];
  return (
    <div className="mx-auto flex h-full min-h-[320px] max-w-2xl flex-col items-center justify-center text-center">
      <Avatar name={empName} size={56} />
      <h2 className="mt-4 text-lg font-semibold text-slate-900 dark:text-slate-100">
        {empName}
      </h2>
      <div className="text-sm text-slate-500 dark:text-slate-400">{empRole}</div>
      <p className="mt-3 max-w-md text-sm text-slate-500 dark:text-slate-400">
        Messages use {empName}'s Soul and Skills as context. Each send spawns the
        employee's CLI, so the first reply can take a few seconds.
      </p>
      <div className="mt-6 flex w-full flex-col gap-2">
        {suggestions.map((s) => (
          <button
            key={s}
            onClick={() => onPick(s)}
            className="group flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-left text-sm text-slate-700 shadow-sm transition hover:border-indigo-300 hover:bg-indigo-50/40 hover:text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:border-indigo-500/60 dark:hover:bg-indigo-500/10"
          >
            <Sparkles
              size={14}
              className="text-indigo-500 transition group-hover:scale-110"
            />
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

// ───────────────────────────── Composer ─────────────────────────────

function Composer({
  inputRef,
  value,
  onChange,
  onSubmit,
  disabled,
  empName,
}: {
  inputRef: React.RefObject<HTMLTextAreaElement>;
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  disabled: boolean;
  empName: string;
}) {
  const canSend = value.trim().length > 0 && !disabled;
  return (
    <form
      className="border-t border-slate-200 bg-white px-4 py-3 dark:border-slate-800 dark:bg-slate-950 sm:px-6"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <div
        className={
          "flex items-end gap-2 rounded-2xl border bg-white px-3 py-2 transition dark:bg-slate-900 " +
          "border-slate-300 focus-within:border-indigo-500 focus-within:ring-2 focus-within:ring-indigo-500/20 " +
          "dark:border-slate-700 dark:focus-within:border-indigo-500"
        }
      >
        <textarea
          ref={inputRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSubmit();
            }
          }}
          rows={1}
          placeholder={`Message ${empName}…`}
          className="flex-1 resize-none self-center bg-transparent px-1 py-1 text-sm leading-relaxed text-slate-900 placeholder:text-slate-400 focus:outline-none dark:text-slate-100"
          style={{ maxHeight: 200 }}
          disabled={disabled}
        />
        <button
          type="submit"
          disabled={!canSend}
          aria-label="Send message"
          className={
            "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition " +
            (canSend
              ? "bg-indigo-600 text-white hover:bg-indigo-700"
              : "bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-600")
          }
        >
          <Send size={14} />
        </button>
      </div>
      <div className="mt-1.5 flex items-center justify-between px-1 text-[11px] text-slate-400 dark:text-slate-500">
        <span>
          <kbd className="rounded border border-slate-200 bg-slate-50 px-1 font-sans dark:border-slate-700 dark:bg-slate-800">
            Enter
          </kbd>{" "}
          to send ·{" "}
          <kbd className="rounded border border-slate-200 bg-slate-50 px-1 font-sans dark:border-slate-700 dark:bg-slate-800">
            Shift+Enter
          </kbd>{" "}
          for newline
        </span>
        {disabled && <span className="italic">Waiting for reply…</span>}
      </div>
    </form>
  );
}

// ───────────────────────────── Action pills ─────────────────────────────

/**
 * Inline footer under an assistant bubble showing every tool-driven write
 * the employee performed during that turn (`routine.create`, `todo.create`,
 * ...). Without this the model's prose is the only signal that anything
 * happened, which is how we kept getting "Done — I set up a Routine" replies
 * with no real DB write to back them up. The pills are built from the
 * AuditEvent table server-side, so the evidence is authoritative: no
 * audit row, no pill.
 *
 * `integration.invoke` pills open a logs modal (args + result + status)
 * instead of navigating — there is no list page for tool calls, and the
 * audit metadata carries everything we can show.
 */
function ActionPills({
  actions,
  companySlug,
  employeeSlug,
  onInspect,
}: {
  actions: MessageAction[];
  companySlug: string;
  employeeSlug: string;
  onInspect: (a: MessageAction) => void;
}) {
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {actions.map((a, i) => (
        <ActionPill
          key={`${a.action}-${a.targetId ?? i}`}
          action={a}
          companySlug={companySlug}
          employeeSlug={employeeSlug}
          onInspect={onInspect}
        />
      ))}
    </div>
  );
}

function ActionPill({
  action,
  companySlug,
  employeeSlug,
  onInspect,
}: {
  action: MessageAction;
  companySlug: string;
  employeeSlug: string;
  onInspect: (a: MessageAction) => void;
}) {
  const isIntegration = action.action === "integration.invoke";
  const isError =
    isIntegration && action.metadata?.status === "error";
  const href = isIntegration
    ? null
    : hrefForAction(action, companySlug, employeeSlug);

  const palette = isError
    ? "border-rose-200 bg-rose-50 text-rose-700 hover:border-rose-300 hover:bg-rose-100 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300 dark:hover:border-rose-500/50 dark:hover:bg-rose-500/20"
    : "border-emerald-200 bg-emerald-50 text-emerald-700 hover:border-emerald-300 hover:bg-emerald-100 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300 dark:hover:border-emerald-500/50 dark:hover:bg-emerald-500/20";
  const base =
    "inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium transition";
  const className = `${base} ${palette}`;
  const title = buildPillTitle(action);

  const icon = isIntegration ? (
    isError ? (
      <AlertCircle size={11} strokeWidth={2.5} />
    ) : (
      <Zap size={11} strokeWidth={2.5} />
    )
  ) : (
    <Check size={11} strokeWidth={3} />
  );
  const content = (
    <>
      {icon}
      <span className="truncate max-w-[22rem]">{describeAction(action)}</span>
    </>
  );

  if (isIntegration) {
    return (
      <button
        type="button"
        onClick={() => onInspect(action)}
        title={title}
        className={`${className} cursor-pointer`}
      >
        {content}
      </button>
    );
  }
  if (href) {
    return (
      <Link to={href} title={title} className={className}>
        {content}
      </Link>
    );
  }
  // Action has no detail surface (e.g. unknown kind). Render a static chip.
  const staticClass = className.replace(
    /\s+hover:[^\s]+/g,
    "",
  );
  return (
    <span title={`${title} (no link available)`} className={staticClass}>
      {content}
    </span>
  );
}

function buildPillTitle(a: MessageAction): string {
  const parts: string[] = [a.action];
  if (a.targetLabel) parts.push(a.targetLabel);
  if (a.metadata?.status === "error" && a.metadata.error) {
    parts.push(`error: ${a.metadata.error}`);
  } else if (
    a.action === "integration.invoke" &&
    typeof a.metadata?.durationMs === "number"
  ) {
    parts.push(`${formatDuration(a.metadata.durationMs)}`);
  }
  return parts.join(" — ");
}

/**
 * Route the pill should deep-link to. Routines/journal are scoped to the
 * employee who took the action; project/todo live under the company-wide
 * Tasks section. We intentionally land on the list view rather than a
 * detail page — the new row is near the top, so it's easy to spot, and we
 * don't have to carry the project slug through the action payload.
 */
function hrefForAction(
  a: MessageAction,
  companySlug: string,
  employeeSlug: string,
): string | null {
  if (a.action.startsWith("routine.")) {
    return `/c/${companySlug}/employees/${employeeSlug}/routines`;
  }
  if (a.action === "journal.create" || a.action.startsWith("journal.")) {
    return `/c/${companySlug}/employees/${employeeSlug}/journal`;
  }
  if (a.action.startsWith("project.") || a.action.startsWith("todo.")) {
    return `/c/${companySlug}/tasks`;
  }
  return null;
}

/**
 * Human sentence for an action pill. Keeps it terse — the hover title
 * carries the raw action name for anyone who wants to see it.
 */
function describeAction(a: MessageAction): string {
  const label = a.targetLabel || a.targetType || "item";
  switch (a.action) {
    case "routine.create":
      return `Created routine "${label}"`;
    case "routine.update":
      return `Updated routine "${label}"`;
    case "project.create":
      return `Created project "${label}"`;
    case "todo.create":
      return `Created todo ${label}`;
    case "todo.update":
      return `Updated todo ${label}`;
    case "journal.create":
      return `Added journal entry "${label}"`;
    case "integration.invoke": {
      const tool = a.metadata?.toolName ?? "";
      const conn = a.metadata?.connectionLabel ?? a.metadata?.provider ?? "";
      if (tool && conn) return `${conn} · ${tool}`;
      if (tool) return tool;
      return label;
    }
    default:
      return `${a.action}${label ? ` — ${label}` : ""}`;
  }
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.round((ms % 60_000) / 1000);
  return `${mins}m ${secs}s`;
}

// ───────────────────────────── Action detail modal ─────────────────────────────

/**
 * Tool-call inspector. Opens when the user clicks an `integration.invoke`
 * pill. Shows the connection we dispatched to, the exact args the AI
 * supplied, and the raw response (or error). This is the "complete
 * visibility" guarantee — if a pill claims the Metabase revenue dashboard
 * was fetched, the human can verify by reading the same JSON the AI saw.
 */
function ActionDetailModal({
  action,
  onClose,
}: {
  action: MessageAction;
  onClose: () => void;
}) {
  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const meta = action.metadata ?? {};
  const isError = meta.status === "error";
  const isIntegration = action.action === "integration.invoke";
  const providerLabel =
    meta.connectionLabel ?? meta.provider ?? action.targetLabel ?? "Tool call";
  const toolName = meta.toolName ?? null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/40 p-4 dark:bg-black/60"
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        onMouseDown={(e) => e.stopPropagation()}
        className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl dark:border-slate-700 dark:bg-slate-900"
      >
        <div className="flex items-start gap-3 border-b border-slate-100 px-5 py-4 dark:border-slate-800">
          <div
            className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${
              isError
                ? "bg-rose-100 text-rose-600 dark:bg-rose-500/15 dark:text-rose-300"
                : "bg-indigo-100 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300"
            }`}
          >
            {isIntegration ? <Plug size={18} /> : <Zap size={18} />}
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-base font-semibold text-slate-900 dark:text-slate-100">
              {providerLabel}
              {toolName && (
                <span className="text-slate-400 dark:text-slate-500">
                  {" · "}
                  <span className="font-mono text-[13px] font-medium text-slate-700 dark:text-slate-300">
                    {toolName}
                  </span>
                </span>
              )}
            </h2>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-slate-500 dark:text-slate-400">
              <StatusChip status={meta.status} />
              {meta.provider && (
                <span>
                  Provider{" "}
                  <span className="font-medium text-slate-700 dark:text-slate-300">
                    {meta.provider}
                  </span>
                </span>
              )}
              {typeof meta.durationMs === "number" && (
                <span>
                  Took{" "}
                  <span className="font-medium text-slate-700 dark:text-slate-300">
                    {formatDuration(meta.durationMs)}
                  </span>
                </span>
              )}
              {meta.via && (
                <span>
                  via{" "}
                  <span className="font-medium text-slate-700 dark:text-slate-300">
                    {meta.via}
                  </span>
                </span>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:text-slate-500 dark:hover:bg-slate-800 dark:hover:text-slate-200"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
          <LogSection
            title="Arguments"
            body={meta.argsPreview ?? ""}
            empty="No arguments sent."
          />
          {isError ? (
            <LogSection
              title="Error"
              body={meta.error ?? "Integration call failed."}
              tone="error"
              empty=""
            />
          ) : (
            <LogSection
              title="Result"
              body={meta.resultPreview ?? ""}
              empty="The tool returned no body."
            />
          )}
        </div>
      </div>
    </div>
  );
}

function StatusChip({ status }: { status: "ok" | "error" | undefined }) {
  if (status === "ok") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">
        <Check size={10} strokeWidth={3} /> ok
      </span>
    );
  }
  if (status === "error") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-rose-50 px-1.5 py-0.5 text-[10px] font-medium text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">
        <AlertCircle size={10} /> error
      </span>
    );
  }
  return null;
}

function LogSection({
  title,
  body,
  empty,
  tone = "default",
}: {
  title: string;
  body: string;
  empty: string;
  tone?: "default" | "error";
}) {
  const pretty = formatJsonish(body);
  const show = pretty.trim().length > 0 ? pretty : empty;
  const frame =
    tone === "error"
      ? "border-rose-200 bg-rose-50/70 text-rose-900 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-100"
      : "border-slate-200 bg-slate-50 text-slate-800 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-200";
  return (
    <section>
      <div className="mb-1.5 flex items-center justify-between">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          {title}
        </h3>
      </div>
      <pre
        className={`max-h-64 overflow-auto rounded-lg border px-3 py-2 text-[12px] leading-relaxed ${frame} whitespace-pre-wrap break-words font-mono`}
      >
        {show}
      </pre>
    </section>
  );
}

/**
 * The server writes args/result as already-pretty-printed JSON strings,
 * but old rows (or single-string payloads like Stripe's error messages)
 * may be plain text. Try to re-parse + re-indent JSON for readability,
 * fall back to the raw text.
 */
function formatJsonish(raw: string): string {
  if (!raw) return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2);
    } catch {
      return raw;
    }
  }
  return raw;
}

// ───────────────────────────── Markdown ─────────────────────────────

/**
 * Render an assistant's reply as HTML. Models emit markdown (bold, lists,
 * links, fenced code) and showing the raw `**` markers alongside the prose
 * was the reason this got flagged — the chat bubble should read like a
 * polished message, not a diff.
 *
 * `breaks: true` keeps single-line newlines as `<br>`, matching the
 * whitespace-pre-wrap feel people are used to from chat. DOMPurify strips
 * anything scripty before we hand it to `dangerouslySetInnerHTML` — the CLI
 * output is ultimately user-controlled text, so we don't trust it.
 */
function ChatMarkdown({ content }: { content: string }) {
  const html = React.useMemo(() => {
    const raw = marked.parse(content ?? "", {
      async: false,
      gfm: true,
      breaks: true,
    }) as string;
    return DOMPurify.sanitize(raw);
  }, [content]);
  return (
    <div
      className="chat-md break-words"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

// ───────────────────────────── Helpers ─────────────────────────────

function Avatar({ name, size }: { name: string; size: number }) {
  const initials = getInitials(name);
  const gradient = gradientFor(name);
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-full font-semibold text-white shadow-sm"
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.4),
        background: gradient,
      }}
      aria-hidden
    >
      {initials}
    </div>
  );
}

function getInitials(s: string): string {
  const parts = s.trim().split(/\s+/);
  if (parts.length === 0 || !parts[0]) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * Deterministic pastel gradient per name, so the same employee always gets
 * the same avatar colors across reloads.
 */
function gradientFor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  const h1 = h;
  const h2 = (h + 40) % 360;
  return `linear-gradient(135deg, hsl(${h1} 70% 55%), hsl(${h2} 72% 45%))`;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function formatRelative(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const diff = Date.now() - d.getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
