import React from "react";
import { Link } from "react-router-dom";
import { AlertCircle, CircleHelp, Code2, MessageSquarePlus, Send, Sparkles } from "lucide-react";
import { ContextualLayout } from "@/components/AppShell";
import { ChatMarkdown } from "@/components/ChatMarkdown";
import { Avatar, employeeAvatarUrl } from "@/components/ui/Avatar";
import { Spinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import {
  api,
  type Company,
  type ConversationDetail,
  type ConversationMessage,
  type ConversationSummary,
  type Employee,
} from "@/lib/api";

const SUGGESTIONS = [
  "How do I create and schedule a Routine?",
  "Why can’t an AI Employee access a Connection?",
  "Where is AI Model configuration implemented?",
  "How does Genosyn keep credentials safe?",
];

export default function Help({ company }: { company: Company }) {
  const { toast } = useToast();
  const [employees, setEmployees] = React.useState<Employee[] | null>(null);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [conversations, setConversations] = React.useState<ConversationSummary[]>([]);
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const [loadedId, setLoadedId] = React.useState<string | null>(null);
  const [messages, setMessages] = React.useState<ConversationMessage[]>([]);
  const [loadingConversations, setLoadingConversations] = React.useState(false);
  const [loadingMessages, setLoadingMessages] = React.useState(false);
  const [input, setInput] = React.useState("");
  const [sending, setSending] = React.useState(false);
  const [streamingReply, setStreamingReply] = React.useState("");
  const inputRef = React.useRef<HTMLTextAreaElement>(null);
  const scrollRef = React.useRef<HTMLDivElement>(null);

  const selected = employees?.find((employee) => employee.id === selectedId) ?? null;

  React.useEffect(() => {
    let cancelled = false;
    api
      .get<Employee[]>(`/api/companies/${company.id}/employees`)
      .then((list) => {
        if (cancelled) return;
        setEmployees(list);
        setSelectedId(
          (current) =>
            (current && list.some((employee) => employee.id === current) ? current : null) ??
            list.find((employee) => employee.model?.status === "connected")?.id ??
            list[0]?.id ??
            null,
        );
      })
      .catch((error) => {
        if (cancelled) return;
        setEmployees([]);
        toast((error as Error).message, "error");
      });
    return () => {
      cancelled = true;
    };
  }, [company.id, toast]);

  React.useEffect(() => {
    if (!selectedId) {
      setConversations([]);
      setActiveId(null);
      setLoadedId(null);
      setMessages([]);
      return;
    }
    let cancelled = false;
    setLoadingConversations(true);
    setConversations([]);
    setActiveId(null);
    setLoadedId(null);
    setMessages([]);
    api
      .get<ConversationSummary[]>(
        `/api/companies/${company.id}/employees/${selectedId}/conversations?surface=help`,
      )
      .then((list) => {
        if (cancelled) return;
        setConversations(list);
        setActiveId(list[0]?.id ?? null);
      })
      .catch((error) => {
        if (!cancelled) toast((error as Error).message, "error");
      })
      .finally(() => {
        if (!cancelled) setLoadingConversations(false);
      });
    return () => {
      cancelled = true;
    };
  }, [company.id, selectedId, toast]);

  React.useEffect(() => {
    if (!selectedId || !activeId || loadedId === activeId) return;
    let cancelled = false;
    setLoadingMessages(true);
    api
      .get<ConversationDetail>(
        `/api/companies/${company.id}/employees/${selectedId}/conversations/${activeId}`,
      )
      .then((detail) => {
        if (cancelled) return;
        setMessages(detail.messages);
        setLoadedId(activeId);
      })
      .catch((error) => {
        if (!cancelled) toast((error as Error).message, "error");
      })
      .finally(() => {
        if (!cancelled) setLoadingMessages(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeId, company.id, loadedId, selectedId, toast]);

  React.useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, streamingReply, sending]);

  React.useEffect(() => {
    const textarea = inputRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`;
  }, [input]);

  async function newConversation(): Promise<ConversationSummary | null> {
    if (!selectedId || sending) return null;
    try {
      const created = await api.post<ConversationSummary>(
        `/api/companies/${company.id}/employees/${selectedId}/conversations`,
        { surface: "help" },
      );
      setConversations((current) => [
        created,
        ...current.filter((conversation) => conversation.id !== created.id),
      ]);
      setActiveId(created.id);
      setLoadedId(created.id);
      setMessages([]);
      window.setTimeout(() => inputRef.current?.focus(), 0);
      return created;
    } catch (error) {
      toast((error as Error).message, "error");
      return null;
    }
  }

  function selectConversation(id: string) {
    if (sending || id === activeId) return;
    setActiveId(id);
    setLoadedId(null);
    setMessages([]);
  }

  async function sendMessage() {
    const content = input.trim();
    if (!content || !selectedId || !selected || sending) return;
    let conversationId = activeId;
    if (!conversationId) {
      const created = await newConversation();
      if (!created) return;
      conversationId = created.id;
    }

    const tempId = `help-user-${Date.now()}`;
    const optimistic: ConversationMessage = {
      id: tempId,
      conversationId,
      role: "user",
      content,
      status: null,
      createdAt: new Date().toISOString(),
    };
    setInput("");
    setMessages((current) => [...current, optimistic]);
    setSending(true);
    setStreamingReply("");
    let accumulated = "";
    let receivedAssistant = false;

    try {
      await api.stream(
        `/api/companies/${company.id}/employees/${selectedId}/conversations/${conversationId}/messages`,
        { message: content, attachmentIds: [] },
        (event, data) => {
          if (event === "user") {
            const persisted = data as ConversationMessage;
            setMessages((current) =>
              current.map((message) => (message.id === tempId ? persisted : message)),
            );
          } else if (event === "chunk") {
            accumulated += (data as { text?: string } | null)?.text ?? "";
            setStreamingReply(accumulated);
          } else if (event === "assistant") {
            receivedAssistant = true;
            setMessages((current) => [...current, data as ConversationMessage]);
            setStreamingReply("");
          } else if (event === "conversation") {
            const updated = data as ConversationSummary;
            setConversations((current) => [
              updated,
              ...current.filter((conversation) => conversation.id !== updated.id),
            ]);
          } else if (event === "error") {
            throw new Error(
              (data as { message?: string } | null)?.message ?? "Help response failed",
            );
          }
        },
      );
      if (!receivedAssistant && accumulated.trim()) {
        setMessages((current) => [
          ...current,
          {
            id: `help-local-${Date.now()}`,
            conversationId,
            role: "assistant",
            content: accumulated,
            status: "ok",
            createdAt: new Date().toISOString(),
          },
        ]);
      }
    } catch (error) {
      const detail = (error as Error).message || "Unknown error";
      setMessages((current) => [
        ...current,
        {
          id: `help-error-${Date.now()}`,
          conversationId,
          role: "assistant",
          content: `Genosyn couldn’t complete this Help response.\n\n${detail}`,
          status: "error",
          createdAt: new Date().toISOString(),
        },
      ]);
    } finally {
      setSending(false);
      setStreamingReply("");
      window.setTimeout(() => inputRef.current?.focus(), 0);
    }
  }

  return (
    <ContextualLayout>
      <div className="flex h-full min-h-0 bg-white dark:bg-slate-950">
        <aside className="hidden w-72 shrink-0 flex-col border-r border-slate-200 bg-slate-50/60 lg:flex dark:border-slate-800 dark:bg-slate-950">
          <div className="border-b border-slate-200 p-4 dark:border-slate-800">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              Ask an AI Employee
            </div>
            <div className="mt-3 flex flex-col gap-1">
              {employees?.map((employee) => (
                <button
                  key={employee.id}
                  type="button"
                  disabled={sending}
                  onClick={() => setSelectedId(employee.id)}
                  className={
                    "flex items-center gap-2 rounded-lg px-2.5 py-2 text-left transition " +
                    (employee.id === selectedId
                      ? "bg-white text-slate-900 shadow-sm ring-1 ring-slate-200 dark:bg-slate-800 dark:text-slate-100 dark:ring-slate-700"
                      : "text-slate-600 hover:bg-white dark:text-slate-300 dark:hover:bg-slate-800")
                  }
                >
                  <Avatar
                    name={employee.name}
                    kind="ai"
                    size="md"
                    src={employeeAvatarUrl(company.id, employee.id, employee.avatarKey)}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{employee.name}</span>
                    <span className="block truncate text-[11px] text-slate-400">
                      {employee.role}
                    </span>
                  </span>
                  <span
                    className={
                      "h-2 w-2 shrink-0 rounded-full " +
                      (employee.model?.status === "connected"
                        ? "bg-emerald-500"
                        : "bg-slate-300 dark:bg-slate-600")
                    }
                    title={
                      employee.model?.status === "connected"
                        ? "AI Model connected"
                        : "AI Model required"
                    }
                  />
                </button>
              ))}
            </div>
          </div>

          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex items-center justify-between px-4 py-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                Help conversations
              </div>
              <button
                type="button"
                onClick={() => void newConversation()}
                disabled={!selected || sending}
                className="flex h-7 w-7 items-center justify-center rounded-md text-slate-500 hover:bg-slate-200/70 hover:text-slate-900 disabled:opacity-40 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
                aria-label="New Help conversation"
                title="New Help conversation"
              >
                <MessageSquarePlus size={15} />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
              {loadingConversations ? (
                <div className="flex justify-center py-6">
                  <Spinner />
                </div>
              ) : conversations.length === 0 ? (
                <p className="px-2 py-4 text-xs text-slate-400 dark:text-slate-500">
                  Your Help questions with this AI Employee will appear here.
                </p>
              ) : (
                <div className="flex flex-col gap-0.5">
                  {conversations.map((conversation) => (
                    <button
                      key={conversation.id}
                      type="button"
                      disabled={sending}
                      onClick={() => selectConversation(conversation.id)}
                      className={
                        "rounded-md px-3 py-2 text-left text-[13px] transition " +
                        (conversation.id === activeId
                          ? "bg-white font-medium text-slate-900 shadow-sm ring-1 ring-slate-200 dark:bg-slate-800 dark:text-slate-100 dark:ring-slate-700"
                          : "text-slate-600 hover:bg-white dark:text-slate-300 dark:hover:bg-slate-800")
                      }
                    >
                      <span className="block truncate">
                        {conversation.title ?? "New Help conversation"}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </aside>

        <section className="flex min-w-0 flex-1 flex-col">
          <header className="border-b border-slate-200 bg-white px-4 py-3 dark:border-slate-800 dark:bg-slate-950 sm:px-6">
            <div className="flex items-center gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-300">
                <CircleHelp size={18} />
              </span>
              <div className="min-w-0 flex-1">
                <h1 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  Genosyn Help
                </h1>
                <p className="truncate text-xs text-slate-500 dark:text-slate-400">
                  Ask how the product works. Your AI Employee can inspect this release&apos;s
                  source.
                </p>
              </div>
              <button
                type="button"
                onClick={() => void newConversation()}
                disabled={!selected || sending}
                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40 lg:hidden dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
              >
                <MessageSquarePlus size={13} /> New
              </button>
            </div>

            {employees && employees.length > 0 && (
              <div className="mt-3 flex gap-2 lg:hidden">
                <select
                  aria-label="AI Employee"
                  value={selectedId ?? ""}
                  disabled={sending}
                  onChange={(event) => setSelectedId(event.target.value)}
                  className="h-9 min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                >
                  {employees.map((employee) => (
                    <option key={employee.id} value={employee.id}>
                      {employee.name} — {employee.role}
                    </option>
                  ))}
                </select>
                {conversations.length > 0 && (
                  <select
                    aria-label="Help conversation"
                    value={activeId ?? ""}
                    disabled={sending}
                    onChange={(event) => selectConversation(event.target.value)}
                    className="h-9 min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                  >
                    {conversations.map((conversation) => (
                      <option key={conversation.id} value={conversation.id}>
                        {conversation.title ?? "New Help conversation"}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            )}
          </header>

          <div
            ref={scrollRef}
            className="min-h-0 flex-1 overflow-y-auto bg-slate-50/50 px-4 py-6 dark:bg-slate-900/40 sm:px-8"
          >
            {employees === null || loadingMessages ? (
              <div className="flex h-full items-center justify-center">
                <Spinner size={22} />
              </div>
            ) : employees.length === 0 ? (
              <div className="mx-auto flex h-full max-w-lg flex-col items-center justify-center text-center">
                <CircleHelp size={30} className="text-slate-300 dark:text-slate-600" />
                <h2 className="mt-4 text-lg font-semibold text-slate-900 dark:text-slate-100">
                  Hire an AI Employee first
                </h2>
                <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
                  Help is answered by one of your AI Employees, using their AI Model plus the
                  complete Genosyn product and source context.
                </p>
                <Link
                  to={`/c/${company.slug}/employees/new`}
                  className="mt-5 inline-flex h-10 items-center justify-center rounded-lg bg-indigo-600 px-4 text-sm font-medium text-white transition hover:bg-indigo-700"
                >
                  Hire AI Employee
                </Link>
              </div>
            ) : !selected ? (
              <div className="flex h-full items-center justify-center text-sm text-slate-500">
                Select an AI Employee to ask for help.
              </div>
            ) : messages.length === 0 && !sending ? (
              <div className="mx-auto flex h-full max-w-2xl flex-col items-center justify-center text-center">
                <Avatar
                  name={selected.name}
                  kind="ai"
                  size="xl"
                  src={employeeAvatarUrl(company.id, selected.id, selected.avatarKey)}
                />
                <h2 className="mt-4 text-lg font-semibold text-slate-900 dark:text-slate-100">
                  Ask {selected.name} about Genosyn
                </h2>
                <p className="mt-2 max-w-lg text-sm leading-relaxed text-slate-500 dark:text-slate-400">
                  {selected.name} receives Genosyn&apos;s product vocabulary, roadmap,
                  documentation, and a read-only snapshot of the full codebase shipped with this
                  version.
                </p>
                {selected.model?.status !== "connected" && (
                  <Link
                    to={`/c/${company.slug}/employees/${selected.slug}/settings/model`}
                    className="mt-4 inline-flex items-center gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200"
                  >
                    <AlertCircle size={13} /> Connect an AI Model before asking
                  </Link>
                )}
                <div className="mt-6 grid w-full gap-2 sm:grid-cols-2">
                  {SUGGESTIONS.map((suggestion) => (
                    <button
                      key={suggestion}
                      type="button"
                      onClick={() => {
                        setInput(suggestion);
                        inputRef.current?.focus();
                      }}
                      className="flex items-start gap-2 rounded-xl border border-slate-200 bg-white px-3 py-3 text-left text-sm text-slate-700 shadow-sm transition hover:border-indigo-300 hover:bg-indigo-50/40 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:border-indigo-500/60 dark:hover:bg-indigo-500/10"
                    >
                      <Sparkles size={14} className="mt-0.5 shrink-0 text-indigo-500" />
                      {suggestion}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="mx-auto flex max-w-3xl flex-col gap-5">
                {messages.map((message, index) => (
                  <HelpBubble
                    key={message.id}
                    message={message}
                    employee={selected}
                    companyId={company.id}
                    showAvatar={index === 0 || messages[index - 1].role !== message.role}
                  />
                ))}
                {sending && streamingReply && (
                  <div className="flex items-start gap-2.5">
                    <Avatar name={selected.name} kind="ai" size="md" />
                    <div className="max-w-[85%] rounded-2xl rounded-tl-md border border-slate-200 bg-white px-3.5 py-2 text-sm leading-relaxed text-slate-900 shadow-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100">
                      <ChatMarkdown content={streamingReply} />
                    </div>
                  </div>
                )}
                {sending && !streamingReply && (
                  <div className="flex items-center gap-2.5 text-sm text-slate-500">
                    <Avatar name={selected.name} kind="ai" size="md" />
                    <span className="inline-flex items-center gap-2 rounded-2xl rounded-tl-md border border-slate-200 bg-white px-3.5 py-2 dark:border-slate-700 dark:bg-slate-900">
                      <Spinner /> Inspecting Genosyn…
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>

          <form
            className="border-t border-slate-200 bg-white px-4 py-3 dark:border-slate-800 dark:bg-slate-950 sm:px-6"
            onSubmit={(event) => {
              event.preventDefault();
              void sendMessage();
            }}
          >
            <div className="mx-auto max-w-3xl">
              <div className="flex items-end gap-2 rounded-2xl border border-slate-300 bg-white px-3 py-2 focus-within:border-indigo-500 focus-within:ring-2 focus-within:ring-indigo-500/20 dark:border-slate-700 dark:bg-slate-900">
                <Code2 size={16} className="mb-2 shrink-0 text-slate-400" />
                <textarea
                  ref={inputRef}
                  value={input}
                  disabled={!selected || sending}
                  rows={1}
                  maxLength={8000}
                  placeholder={
                    selected ? `Ask ${selected.name} about Genosyn…` : "Select an AI Employee"
                  }
                  onChange={(event) => setInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void sendMessage();
                    }
                  }}
                  className="max-h-[180px] min-h-8 flex-1 resize-none bg-transparent py-1.5 text-sm text-slate-900 outline-none placeholder:text-slate-400 disabled:opacity-60 dark:text-slate-100"
                />
                <button
                  type="submit"
                  disabled={!selected || sending || !input.trim()}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-indigo-600 text-white transition hover:bg-indigo-700 disabled:bg-slate-200 disabled:text-slate-400 dark:disabled:bg-slate-800 dark:disabled:text-slate-600"
                  aria-label="Ask for Help"
                >
                  {sending ? <Spinner size={14} /> : <Send size={15} />}
                </button>
              </div>
              <p className="mt-1.5 px-1 text-[11px] text-slate-400 dark:text-slate-500">
                Help source access is read-only. Use ordinary Chat when you want this AI Employee to
                take action in your company.
              </p>
            </div>
          </form>
        </section>
      </div>
    </ContextualLayout>
  );
}

function HelpBubble({
  message,
  employee,
  companyId,
  showAvatar,
}: {
  message: ConversationMessage;
  employee: Employee;
  companyId: string;
  showAvatar: boolean;
}) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-indigo-600 px-3.5 py-2 text-sm leading-relaxed text-white shadow-sm sm:max-w-[75%]">
          <ChatMarkdown content={message.content} />
        </div>
      </div>
    );
  }

  const isError = message.status === "error";
  const isUnavailable = message.status === "skipped" || message.status === "busy";
  return (
    <div className="flex items-start gap-2.5">
      <div className={showAvatar ? "" : "invisible"}>
        <Avatar
          name={employee.name}
          kind="ai"
          size="md"
          src={employeeAvatarUrl(companyId, employee.id, employee.avatarKey)}
        />
      </div>
      <div
        className={
          "max-w-[85%] rounded-2xl rounded-tl-md px-3.5 py-2 text-sm leading-relaxed shadow-sm sm:max-w-[75%] " +
          (isError
            ? "border border-rose-200 bg-rose-50 text-rose-900 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-100"
            : isUnavailable
              ? "border border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100"
              : "border border-slate-200 bg-white text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100")
        }
      >
        {isError ? (
          <div className="whitespace-pre-wrap break-words">{message.content}</div>
        ) : (
          <ChatMarkdown content={message.content} />
        )}
      </div>
    </div>
  );
}
