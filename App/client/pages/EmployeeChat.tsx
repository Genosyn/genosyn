import React from "react";
import { useOutletContext } from "react-router-dom";
import { Loader2, MessageSquarePlus, Send, Trash2 } from "lucide-react";
import {
  api,
  ConversationDetail,
  ConversationMessage,
  ConversationSummary,
  SendMessageResult,
} from "../lib/api";
import { Button } from "../components/ui/Button";
import { TopBar } from "../components/AppShell";
import { useToast } from "../components/ui/Toast";
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

  const [convs, setConvs] = React.useState<ConversationSummary[]>([]);
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const [messages, setMessages] = React.useState<ConversationMessage[]>([]);
  const [input, setInput] = React.useState("");
  const [sending, setSending] = React.useState(false);
  const [loadingConv, setLoadingConv] = React.useState(false);
  const scrollRef = React.useRef<HTMLDivElement>(null);

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

  React.useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, sending]);

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
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  async function handleDelete(convId: string) {
    if (!confirm("Delete this conversation? Messages will be lost.")) return;
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

  async function send() {
    const msg = input.trim();
    if (!msg || sending) return;
    setInput("");
    setSending(true);

    // Optimistic user bubble. The server returns the persisted row; we'll
    // swap this temp entry out on response.
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

    try {
      // Lazily create a conversation on first send so the sidebar stays
      // empty for employees you've never chatted with.
      let convId = activeId;
      if (!convId) {
        const created = await createConversation();
        convId = created.id;
        setActiveId(convId);
      }
      const result = await api.post<SendMessageResult>(
        `${base}/conversations/${convId}/messages`,
        { message: msg },
      );
      setMessages((prev) => [
        ...prev.filter((m) => m.id !== tempId),
        result.userMessage,
        result.assistantMessage,
      ]);
      setConvs((prev) => {
        const idx = prev.findIndex((c) => c.id === result.conversation.id);
        const next = [...prev];
        if (idx >= 0) next.splice(idx, 1);
        return [result.conversation, ...next];
      });
    } catch (err) {
      const m = (err as Error).message;
      toast(m, "error");
      setMessages((prev) => [
        ...prev.filter((x) => x.id !== tempId),
        tempUser,
        {
          id: `err-${Date.now()}`,
          conversationId: activeId ?? "",
          role: "assistant",
          content: m,
          status: "error",
          createdAt: new Date().toISOString(),
        },
      ]);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <TopBar
        title={`Chat with ${emp.name}`}
        right={
          <Button size="sm" variant="secondary" onClick={handleNewClick}>
            <MessageSquarePlus size={14} /> New
          </Button>
        }
      />
      <div className="flex flex-1 gap-3 overflow-hidden" style={{ minHeight: 360 }}>
        <aside className="hidden w-56 shrink-0 overflow-y-auto rounded-xl border border-slate-200 bg-white p-2 md:block dark:bg-slate-900 dark:border-slate-700">
          {convs.length === 0 ? (
            <div className="p-3 text-xs text-slate-500 dark:text-slate-400">
              No conversations yet. Click <span className="font-medium">New</span> or just
              start typing.
            </div>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {convs.map((c) => (
                <li key={c.id}>
                  <div
                    className={
                      "group flex items-center gap-1 rounded-md px-2 py-1.5 text-sm " +
                      (c.id === activeId
                        ? "bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-slate-100"
                        : "text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800")
                    }
                  >
                    <button
                      onClick={() => setActiveId(c.id)}
                      className="flex-1 truncate text-left"
                      title={c.title ?? "New conversation"}
                    >
                      {c.title ?? <span className="italic text-slate-400 dark:text-slate-500">New conversation</span>}
                    </button>
                    <button
                      onClick={() => handleDelete(c.id)}
                      className="rounded p-1 text-slate-400 opacity-0 hover:bg-slate-200 hover:text-slate-700 group-hover:opacity-100 dark:text-slate-500 dark:hover:text-slate-200"
                      aria-label="Delete conversation"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </aside>
        <div
          ref={scrollRef}
          className="flex-1 overflow-y-auto rounded-xl border border-slate-200 bg-white p-4 dark:bg-slate-900 dark:border-slate-700"
        >
          {loadingConv ? (
            <div className="flex h-full min-h-[240px] items-center justify-center text-xs text-slate-400 dark:text-slate-500">
              <Loader2 size={14} className="mr-2 animate-spin" /> Loading…
            </div>
          ) : messages.length === 0 ? (
            <div className="flex h-full min-h-[240px] items-center justify-center text-center text-sm text-slate-500 dark:text-slate-400">
              <div>
                <div className="font-medium text-slate-700 dark:text-slate-200">
                  Start a conversation with {emp.name}
                </div>
                <div className="mt-1 text-xs">
                  Messages use {emp.name}'s Soul and Skills as context — each send spawns
                  the employee's CLI, so replies take a few seconds.
                </div>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {messages.map((m) => (
                <TurnBubble key={m.id} message={m} authorName={emp.name} />
              ))}
              {sending && (
                <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                  <Loader2 size={12} className="animate-spin" /> {emp.name} is thinking…
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <form
        className="mt-3 flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            // Enter to send, Shift+Enter for newline.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          rows={2}
          placeholder={`Message ${emp.name}…`}
          className="flex-1 resize-none rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:bg-slate-900 dark:border-slate-600"
          disabled={sending}
        />
        <Button type="submit" disabled={sending || input.trim().length === 0}>
          {sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
          Send
        </Button>
      </form>
    </div>
  );
}

function TurnBubble({
  message,
  authorName,
}: {
  message: ConversationMessage;
  authorName: string;
}) {
  const mine = message.role === "user";
  return (
    <div className={"flex " + (mine ? "justify-end" : "justify-start")}>
      <div
        className={
          "max-w-[min(680px,85%)] whitespace-pre-wrap rounded-xl px-3 py-2 text-sm " +
          (mine
            ? "bg-indigo-600 text-white"
            : message.status === "error"
              ? "border border-rose-200 bg-rose-50 text-rose-900"
              : message.status === "skipped"
                ? "border border-amber-200 bg-amber-50 text-amber-900 dark:bg-amber-950"
                : "border border-slate-200 bg-slate-50 text-slate-900 dark:bg-slate-900 dark:border-slate-700 dark:text-slate-100")
        }
      >
        {!mine && (
          <div
            className={
              "mb-1 text-[10px] font-semibold uppercase tracking-wide " +
              (message.status === "error"
                ? "text-rose-700"
                : message.status === "skipped"
                  ? "text-amber-700 dark:text-amber-300"
                  : "text-slate-500 dark:text-slate-400")
            }
          >
            {authorName}
            {message.status === "skipped" && " · not available"}
            {message.status === "error" && " · error"}
          </div>
        )}
        {message.content}
      </div>
    </div>
  );
}
