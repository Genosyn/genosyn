import React from "react";
import { Sparkles, Send, X, Bot, AlertTriangle } from "lucide-react";
import { api, Base, BaseAssistantResult, BaseTable } from "../lib/api";
import { Spinner } from "../components/ui/Spinner";
import { clsx } from "../components/ui/clsx";

type Message =
  | { role: "user"; text: string }
  | {
      role: "assistant";
      text: string;
      status: BaseAssistantResult["status"];
      employeeName?: string;
    };

/**
 * Right-side slide-over that lets the user chat with a Base Assistant. The
 * server routes the prompt through the first AI Employee with a connected
 * model, loaded with this base's schema. For now the assistant *suggests*
 * changes in prose — applying them is on the user. Keeps the blast radius
 * small while the feature ships.
 */
export function BaseAssistant({
  companyId,
  base,
  currentTable,
  onClose,
}: {
  companyId: string;
  base: Base;
  currentTable: BaseTable | null;
  onClose: () => void;
}) {
  const [messages, setMessages] = React.useState<Message[]>([]);
  const [draft, setDraft] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const scrollerRef = React.useRef<HTMLDivElement>(null);

  async function send() {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    const userMsg: Message = { role: "user", text };
    setMessages((prev) => [...prev, userMsg]);
    setDraft("");
    try {
      const result = await api.post<BaseAssistantResult>(
        `/api/companies/${companyId}/bases/${base.slug}/ai`,
        {
          prompt: text,
          tableId: currentTable?.id,
        },
      );
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          text: result.reply,
          status: result.status,
          employeeName: result.employee?.name,
        },
      ]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          text: (err as Error).message,
          status: "error",
        },
      ]);
    } finally {
      setBusy(false);
      requestAnimationFrame(() => {
        scrollerRef.current?.scrollTo({
          top: scrollerRef.current.scrollHeight,
          behavior: "smooth",
        });
      });
    }
  }

  return (
    <aside className="flex w-[380px] shrink-0 flex-col border-l border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
      <div className="flex items-center gap-2 border-b border-slate-200 px-4 py-3 dark:border-slate-700">
        <div className="flex h-7 w-7 items-center justify-center rounded-md bg-violet-500/15 text-violet-700 dark:text-violet-300">
          <Sparkles size={14} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">
            Base Assistant
          </div>
          <div className="truncate text-[11px] text-slate-500 dark:text-slate-400">
            {currentTable ? `Focused on ${currentTable.name}` : `${base.name}`}
          </div>
        </div>
        <button
          onClick={onClose}
          className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:text-slate-500 dark:hover:bg-slate-800 dark:hover:text-slate-200"
          aria-label="Close"
        >
          <X size={16} />
        </button>
      </div>

      <div
        ref={scrollerRef}
        className="flex-1 space-y-3 overflow-y-auto px-4 py-4"
      >
        {messages.length === 0 ? (
          <IntroTips
            onPick={(p) => {
              setDraft(p);
            }}
          />
        ) : (
          messages.map((m, i) => <MessageRow key={i} message={m} />)
        )}
        {busy && (
          <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
            <Spinner size={12} /> Thinking…
          </div>
        )}
      </div>

      <div className="border-t border-slate-200 p-3 dark:border-slate-700">
        <div className="flex items-end gap-2 rounded-lg border border-slate-200 bg-white focus-within:border-indigo-400 dark:border-slate-700 dark:bg-slate-900">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                send();
              }
            }}
            rows={2}
            placeholder="Ask anything about this base…"
            className="min-w-0 flex-1 resize-none rounded-lg bg-transparent px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none dark:text-slate-100"
          />
          <button
            onClick={send}
            disabled={!draft.trim() || busy}
            className="m-1 flex h-8 w-8 items-center justify-center rounded-md bg-indigo-600 text-white disabled:bg-indigo-300 dark:disabled:bg-indigo-900"
            title="Send (⌘⏎)"
          >
            <Send size={14} />
          </button>
        </div>
      </div>
    </aside>
  );
}

function IntroTips({ onPick }: { onPick: (p: string) => void }) {
  const prompts = [
    "Summarize this base for a new teammate.",
    "What fields should I add to this table?",
    "Suggest 5 sample rows I should enter to test things out.",
    "What's a good next table to add, and what fields should it have?",
  ];
  return (
    <div className="rounded-lg border border-dashed border-slate-200 p-4 dark:border-slate-700">
      <div className="flex items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-200">
        <Bot size={14} className="text-violet-500" /> Ask your AI employees
      </div>
      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
        The first employee with a connected model reads this base's schema and
        answers. Try:
      </p>
      <div className="mt-3 flex flex-col gap-1">
        {prompts.map((p) => (
          <button
            key={p}
            onClick={() => onPick(p)}
            className="rounded-md border border-slate-200 bg-white px-2 py-1.5 text-left text-xs text-slate-700 hover:border-indigo-300 hover:bg-indigo-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:border-indigo-700 dark:hover:bg-indigo-500/10"
          >
            {p}
          </button>
        ))}
      </div>
    </div>
  );
}

function MessageRow({ message }: { message: Message }) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-lg bg-indigo-600 px-3 py-2 text-sm text-white dark:bg-indigo-500">
          {message.text}
        </div>
      </div>
    );
  }
  const skipped = message.status === "skipped";
  const errored = message.status === "error";
  return (
    <div className="flex items-start gap-2">
      <div
        className={clsx(
          "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full",
          errored
            ? "bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300"
            : "bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300",
        )}
      >
        {errored ? <AlertTriangle size={12} /> : <Bot size={12} />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[11px] text-slate-500 dark:text-slate-400">
          {message.employeeName ?? (skipped ? "Base Assistant (skipped)" : "Base Assistant")}
        </div>
        <div
          className={clsx(
            "mt-0.5 whitespace-pre-wrap break-words rounded-lg px-3 py-2 text-sm",
            errored
              ? "bg-rose-50 text-rose-900 dark:bg-rose-500/10 dark:text-rose-200"
              : skipped
                ? "bg-amber-50 text-amber-900 dark:bg-amber-500/10 dark:text-amber-200"
                : "bg-slate-50 text-slate-800 dark:bg-slate-800 dark:text-slate-100",
          )}
        >
          {message.text}
        </div>
      </div>
    </div>
  );
}
