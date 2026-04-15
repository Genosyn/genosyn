import React from "react";
import { useOutletContext } from "react-router-dom";
import { Loader2, Send } from "lucide-react";
import { api, ChatResult } from "../lib/api";
import { Button } from "../components/ui/Button";
import { TopBar } from "../components/AppShell";
import { useToast } from "../components/ui/Toast";
import type { EmployeeOutletCtx } from "./EmployeeLayout";

/**
 * Chat with the selected employee.
 *
 * No persistence in v1 — the transcript lives in component state and dies
 * on navigation. Each send ships the last ~20 turns as `history` so the
 * employee has recent context without us building a persisted Conversation
 * entity yet.
 */

type UiTurn = {
  role: "user" | "assistant";
  content: string;
  status?: "ok" | "skipped" | "error";
};

const MAX_HISTORY_TURNS = 20;

export default function EmployeeChat() {
  const { company, emp } = useOutletContext<EmployeeOutletCtx>();
  const [turns, setTurns] = React.useState<UiTurn[]>([]);
  const [input, setInput] = React.useState("");
  const [sending, setSending] = React.useState(false);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const { toast } = useToast();

  // Reset transcript when the selected employee changes so we never leak
  // one employee's messages into another's chat.
  React.useEffect(() => {
    setTurns([]);
    setInput("");
  }, [emp.id]);

  React.useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [turns, sending]);

  async function send() {
    const msg = input.trim();
    if (!msg || sending) return;
    setInput("");
    setSending(true);
    const nextTurns: UiTurn[] = [...turns, { role: "user", content: msg }];
    setTurns(nextTurns);
    try {
      const history = nextTurns
        .slice(-MAX_HISTORY_TURNS - 1, -1) // everything up to (not including) the message we're sending
        .map((t) => ({ role: t.role, content: t.content }));
      const result = await api.post<ChatResult>(
        `/api/companies/${company.id}/employees/${emp.id}/chat`,
        { message: msg, history },
      );
      setTurns((prev) => [
        ...prev,
        { role: "assistant", content: result.reply, status: result.status },
      ]);
    } catch (err) {
      const m = (err as Error).message;
      toast(m, "error");
      setTurns((prev) => [
        ...prev,
        { role: "assistant", content: m, status: "error" },
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
          turns.length > 0 ? (
            <Button variant="ghost" size="sm" onClick={() => setTurns([])}>
              Clear
            </Button>
          ) : null
        }
      />
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto rounded-xl border border-slate-200 bg-white p-4"
        style={{ minHeight: 360 }}
      >
        {turns.length === 0 ? (
          <div className="flex h-full min-h-[240px] items-center justify-center text-center text-sm text-slate-500">
            <div>
              <div className="font-medium text-slate-700">Start a conversation with {emp.name}</div>
              <div className="mt-1 text-xs">
                Messages use {emp.name}'s Soul and Skills as context — each send spawns the
                employee's CLI, so replies take a few seconds.
              </div>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {turns.map((t, i) => (
              <TurnBubble key={i} turn={t} authorName={emp.name} />
            ))}
            {sending && (
              <div className="flex items-center gap-2 text-xs text-slate-500">
                <Loader2 size={12} className="animate-spin" /> {emp.name} is thinking…
              </div>
            )}
          </div>
        )}
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
          className="flex-1 resize-none rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
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

function TurnBubble({ turn, authorName }: { turn: UiTurn; authorName: string }) {
  const mine = turn.role === "user";
  return (
    <div className={"flex " + (mine ? "justify-end" : "justify-start")}>
      <div
        className={
          "max-w-[min(680px,85%)] whitespace-pre-wrap rounded-xl px-3 py-2 text-sm " +
          (mine
            ? "bg-indigo-600 text-white"
            : turn.status === "error"
              ? "border border-rose-200 bg-rose-50 text-rose-900"
              : turn.status === "skipped"
                ? "border border-amber-200 bg-amber-50 text-amber-900"
                : "border border-slate-200 bg-slate-50 text-slate-900")
        }
      >
        {!mine && (
          <div
            className={
              "mb-1 text-[10px] font-semibold uppercase tracking-wide " +
              (turn.status === "error"
                ? "text-rose-700"
                : turn.status === "skipped"
                  ? "text-amber-700"
                  : "text-slate-500")
            }
          >
            {authorName}
            {turn.status === "skipped" && " · not available"}
            {turn.status === "error" && " · error"}
          </div>
        )}
        {turn.content}
      </div>
    </div>
  );
}
