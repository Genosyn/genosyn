import React from "react";
import { useOutletContext } from "react-router-dom";
import { marked } from "marked";
import DOMPurify from "dompurify";
import {
  AlertCircle,
  CircleSlash,
  MessageSquarePlus,
  Send,
  Sparkles,
  Trash2,
} from "lucide-react";
import {
  api,
  ConversationDetail,
  ConversationMessage,
  ConversationSummary,
} from "../lib/api";
import { useToast } from "../components/ui/Toast";
import { useDialog } from "../components/ui/Dialog";
import type { EmployeeOutletCtx } from "./EmployeeLayout";

/**
 * Chat with the selected employee. Threads are persisted server-side as
 * {@link ConversationSummary} rows; the left rail lists them newest-first
 * and the main panel shows the selected thread. A "New" button creates an
 * empty conversation locally (not persisted until first send) so switching
 * employees never lands on a stale thread.
 */

export default function EmployeeChat() {
  const { company, emp } = useOutletContext<EmployeeOutletCtx>();
  const base = `/api/companies/${company.id}/employees/${emp.id}`;
  const { toast } = useToast();
  const dialog = useDialog();

  const [convs, setConvs] = React.useState<ConversationSummary[]>([]);
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const [messages, setMessages] = React.useState<ConversationMessage[]>([]);
  const [input, setInput] = React.useState("");
  const [sending, setSending] = React.useState(false);
  /** Running text for the reply currently streaming in. `null` = no stream. */
  const [streamingReply, setStreamingReply] = React.useState<string | null>(null);
  const [loadingConv, setLoadingConv] = React.useState(false);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLTextAreaElement>(null);

  // Load the conversation list whenever the selected employee changes.
  React.useEffect(() => {
    setActiveId(null);
    setMessages([]);
    setInput("");
    (async () => {
      try {
        const list = await api.get<ConversationSummary[]>(`${base}/conversations`);
        setConvs(list);
        if (list.length > 0) {
          setActiveId(list[0].id);
        }
      } catch (err) {
        toast((err as Error).message, "error");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emp.id]);

  // Load the active conversation's messages whenever the selection changes.
  React.useEffect(() => {
    if (!activeId) {
      setMessages([]);
      return;
    }
    setLoadingConv(true);
    (async () => {
      try {
        const detail = await api.get<ConversationDetail>(
          `${base}/conversations/${activeId}`,
        );
        setMessages(detail.messages);
      } catch (err) {
        toast((err as Error).message, "error");
      } finally {
        setLoadingConv(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

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

  async function createConversation(): Promise<ConversationSummary> {
    const created = await api.post<ConversationSummary>(`${base}/conversations`, {});
    setConvs((prev) => [created, ...prev]);
    return created;
  }

  async function handleNewClick() {
    try {
      const created = await createConversation();
      setActiveId(created.id);
      setMessages([]);
      setInput("");
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
      await api.del(`${base}/conversations/${convId}`);
      setConvs((prev) => prev.filter((c) => c.id !== convId));
      if (activeId === convId) {
        setActiveId(null);
        setMessages([]);
      }
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  async function send(messageOverride?: string) {
    const msg = (messageOverride ?? input).trim();
    if (!msg || sending) return;
    if (!messageOverride) setInput("");
    setSending(true);
    setStreamingReply("");

    // Optimistic user bubble. The server sends back the persisted row as the
    // first SSE event; we swap this temp entry out at that point.
    const tempId = `temp-${Date.now()}`;
    const tempUser: ConversationMessage = {
      id: tempId,
      conversationId: activeId ?? "",
      role: "user",
      content: msg,
      status: null,
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, tempUser]);

    let accumulated = "";
    let gotAssistant = false;
    try {
      // Lazily create a conversation on first send so the sidebar stays
      // empty for employees you've never chatted with.
      let convId = activeId;
      if (!convId) {
        const created = await createConversation();
        convId = created.id;
        setActiveId(convId);
      }

      await api.stream(
        `${base}/conversations/${convId}/messages`,
        { message: msg },
        (event, data) => {
          if (event === "user") {
            const userMsg = data as ConversationMessage;
            setMessages((prev) =>
              prev.map((m) => (m.id === tempId ? userMsg : m)),
            );
          } else if (event === "chunk") {
            const text = (data as { text?: string } | null)?.text ?? "";
            accumulated += text;
            setStreamingReply(accumulated);
          } else if (event === "assistant") {
            const assistantMsg = data as ConversationMessage;
            gotAssistant = true;
            setMessages((prev) => [...prev, assistantMsg]);
            setStreamingReply(null);
          } else if (event === "conversation") {
            const conv = data as ConversationSummary;
            setConvs((prev) => {
              const idx = prev.findIndex((c) => c.id === conv.id);
              const next = [...prev];
              if (idx >= 0) next.splice(idx, 1);
              return [conv, ...next];
            });
          } else if (event === "error") {
            throw new Error(
              ((data as { message?: string } | null)?.message) ||
                "Chat stream failed",
            );
          }
          // "done" is a no-op — the reader loop exits when the server closes
          // the stream.
        },
      );

      // If the server closed the stream without sending an assistant event
      // (shouldn't happen in the normal path), synthesize a fallback from
      // what we accumulated so the user isn't left staring at a ghost bubble.
      if (!gotAssistant) {
        setMessages((prev) => [
          ...prev,
          {
            id: `local-${Date.now()}`,
            conversationId: activeId ?? "",
            role: "assistant",
            content: accumulated.trim() || "(no reply)",
            status: accumulated.trim() ? "ok" : "error",
            createdAt: new Date().toISOString(),
          },
        ]);
        setStreamingReply(null);
      }
    } catch (err) {
      const m = (err as Error).message;
      toast(m, "error");
      setStreamingReply(null);
      setMessages((prev) => [
        ...prev.filter((x) => x.id !== tempId),
        tempUser,
        {
          id: `err-${Date.now()}`,
          conversationId: activeId ?? "",
          role: "assistant",
          content: accumulated.trim() ? accumulated + "\n\n" + m : m,
          status: "error",
          createdAt: new Date().toISOString(),
        },
      ]);
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  }

  const activeConv = convs.find((c) => c.id === activeId) ?? null;

  return (
    <div className="flex h-full min-h-0 overflow-hidden bg-white dark:bg-slate-950">
      <ConversationList
        convs={convs}
        activeId={activeId}
        onSelect={setActiveId}
        onDelete={handleDelete}
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
          {loadingConv ? (
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
                  showAvatar={i === 0 || messages[i - 1].role !== m.role}
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
          onChange={setInput}
          onSubmit={() => send()}
          disabled={sending}
          empName={emp.name}
        />
      </section>
    </div>
  );
}

// ───────────────────────────── ConversationList ─────────────────────────────

function ConversationList({
  convs,
  activeId,
  onSelect,
  onDelete,
  onNew,
}: {
  convs: ConversationSummary[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onNew: () => void;
}) {
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
              <li key={c.id}>
                <div
                  className={
                    "group flex items-center gap-1 rounded-md px-2 py-1.5 text-sm " +
                    (c.id === activeId
                      ? "bg-white text-slate-900 shadow-sm ring-1 ring-slate-200 dark:bg-slate-800 dark:text-slate-100 dark:ring-slate-700"
                      : "text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800/70")
                  }
                >
                  <button
                    onClick={() => onSelect(c.id)}
                    className="flex-1 min-w-0 text-left"
                    title={c.title ?? "New conversation"}
                  >
                    <div className="truncate text-[13px] font-medium">
                      {c.title ?? (
                        <span className="italic text-slate-400 dark:text-slate-500">
                          New conversation
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 truncate text-[11px] text-slate-400 dark:text-slate-500">
                      {formatRelative(c.lastMessageAt ?? c.updatedAt)}
                    </div>
                  </button>
                  <button
                    onClick={() => onDelete(c.id)}
                    className="rounded p-1 text-slate-400 opacity-0 hover:bg-slate-200 hover:text-rose-600 group-hover:opacity-100 dark:text-slate-500 dark:hover:bg-slate-700 dark:hover:text-rose-400"
                    aria-label="Delete conversation"
                    title="Delete"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
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
  showAvatar,
}: {
  message: ConversationMessage;
  authorName: string;
  showAvatar: boolean;
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
