import React from "react";
import { ArrowUp, MessageSquare, RotateCcw, Sparkles } from "lucide-react";
import { api, streamPost, type RunStatus } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { isRunError } from "@/lib/runStatus";
import { ChatMarkdown } from "@/components/ChatMarkdown";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { FormError } from "@/components/ui/FormError";
import { Spinner } from "@/components/ui/Spinner";

type ExplainingEmployee = { id: string; name: string; slug: string };
type ExplanationOptions = {
  employees: ExplainingEmployee[];
  defaultEmployeeId: string | null;
};
type Explanation = { explanation: string; employee: ExplainingEmployee };
type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  employee?: ExplainingEmployee;
};

/** Preserve recent conversational context within the API's evidence budget. */
function recentHistory(messages: ChatMessage[]) {
  const history: { role: "user" | "assistant"; content: string }[] = [];
  let remaining = 32_000;
  for (const message of messages.slice(-12).reverse()) {
    const content = message.content.slice(0, Math.min(8000, remaining));
    if (!content) break;
    history.unshift({ role: message.role, content });
    remaining -= content.length;
  }
  return history;
}

export function runExplanationLabel(status: RunStatus): string {
  return isRunError(status) ? "Why did it error?" : "Why did it fail?";
}

/** Mounted once per opened Run, so switching to the log keeps the answer. */
export function RunExplanation({
  companyId,
  runId,
  active = true,
}: {
  companyId: string;
  runId: string;
  active?: boolean;
}) {
  const [options, setOptions] = React.useState<ExplanationOptions | null>(null);
  const [messages, setMessages] = React.useState<ChatMessage[]>([]);
  const [draft, setDraft] = React.useState("");
  const [pendingMessage, setPendingMessage] = React.useState("");
  const [retryMessage, setRetryMessage] = React.useState("");
  const [busy, setBusy] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const requestId = React.useRef(0);
  const activeRequest = React.useRef<AbortController | null>(null);
  const base = `/api/companies/${companyId}/runs/${runId}/explanation`;
  const employee = options?.employees.find((entry) => entry.id === options.defaultEmployeeId);
  const composerId = React.useId();
  const transcriptRef = React.useRef<HTMLDivElement>(null);
  const lastVisibleContent = React.useRef({ messages, pendingMessage });

  const explain = React.useCallback(
    async (request: number, message = "", previous: ChatMessage[] = []) => {
      setBusy(true);
      setError(null);
      setPendingMessage(message);
      const controller = new AbortController();
      activeRequest.current?.abort();
      activeRequest.current = controller;
      try {
        let result: Explanation | null = null;
        let responseError: string | null = null;
        await streamPost(
          base,
          {
            ...(message ? { message } : {}),
            ...(previous.length ? { history: recentHistory(previous) } : {}),
          },
          (event, data) => {
            if (event === "explanation") result = data as Explanation;
            if (event === "error") responseError = (data as { error: string }).error;
          },
          { signal: controller.signal },
        );
        if (request !== requestId.current) return;
        if (responseError) throw new Error(responseError);
        if (!result)
          throw new Error("The reply ended before an explanation arrived. Please try again.");
        // The stream callback assigns the completed response.
        const reply = result as Explanation;
        setMessages([
          ...previous,
          ...(message ? [{ role: "user" as const, content: message }] : []),
          { role: "assistant", content: reply.explanation, employee: reply.employee },
        ]);
        if (message) setDraft((current) => (current.trim() === message ? "" : current));
        setRetryMessage("");
      } catch (err) {
        if (request === requestId.current) {
          setError(errorMessage(err));
          setRetryMessage(message);
        }
      } finally {
        if (request === requestId.current) {
          setBusy(false);
          setPendingMessage("");
          activeRequest.current = null;
        }
      }
    },
    [base],
  );

  const load = React.useCallback(async () => {
    const request = ++requestId.current;
    setBusy(true);
    setError(null);
    try {
      const result = await api.get<ExplanationOptions>(base);
      if (request !== requestId.current) return;
      setOptions(result);
      if (result.defaultEmployeeId) {
        await explain(request);
      } else {
        setBusy(false);
      }
    } catch (err) {
      if (request !== requestId.current) return;
      setError(errorMessage(err));
      setBusy(false);
    }
  }, [base, explain]);

  const cancelRequest = React.useCallback(() => {
    requestId.current++;
    activeRequest.current?.abort();
  }, []);

  React.useEffect(() => {
    void load();
    return cancelRequest;
  }, [load, cancelRequest]);

  React.useEffect(() => {
    const transcript = transcriptRef.current;
    if (!active || !transcript) return;
    const changed =
      lastVisibleContent.current.messages !== messages ||
      lastVisibleContent.current.pendingMessage !== pendingMessage;
    lastVisibleContent.current = { messages, pendingMessage };
    // Follow new replies, including one that arrived while reading the log.
    // Switching tabs by itself must preserve the reader's place.
    if (changed && (messages.length > 1 || pendingMessage)) {
      transcript.scrollTop = transcript.scrollHeight;
    }
  }, [messages, pendingMessage, active]);

  function sendMessage(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !employee || !draft.trim()) return;
    void explain(++requestId.current, draft.trim(), messages);
  }

  return (
    <section aria-label="Run explanation" className="flex h-full min-h-0 min-w-0 flex-col">
      <div
        ref={transcriptRef}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5 sm:px-6 sm:py-6"
        aria-label="Conversation about this Run"
        tabIndex={0}
      >
        <div className="mx-auto flex min-h-full max-w-3xl flex-col gap-6">
          {messages.map((message, index) => (
            <ExplanationMessage key={index} message={message} />
          ))}
          {pendingMessage && (
            <ExplanationMessage message={{ role: "user", content: pendingMessage }} />
          )}
          {busy &&
            (messages.length === 0 ? (
              <div className="flex flex-1 items-center justify-center py-4">
                <div className="w-full max-w-sm rounded-xl border border-slate-200 bg-slate-50/70 p-5 sm:p-6 dark:border-slate-700 dark:bg-slate-800/40">
                  <div className="mb-4 flex items-center gap-3">
                    {employee ? (
                      <Avatar name={employee.name} kind="ai" size="lg" />
                    ) : (
                      <span className="flex h-10 w-10 items-center justify-center rounded-full bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-300">
                        <Sparkles size={18} aria-hidden="true" />
                      </span>
                    )}
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-slate-800 dark:text-slate-100">
                        {employee?.name ?? "Run explanation"}
                      </p>
                      <p
                        role="status"
                        className="mt-1 flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400"
                      >
                        <Spinner size={12} />
                        {employee ? "Reviewing this Run…" : "Loading this Run’s AI Employee…"}
                      </p>
                    </div>
                  </div>
                  <p className="text-sm leading-6 text-slate-600 dark:text-slate-300">
                    Reading the recorded logs to explain what happened and help you decide what to
                    do next.
                  </p>
                  <div aria-hidden="true" className="mt-5 space-y-2 motion-safe:animate-pulse">
                    <div className="h-2 w-full rounded-full bg-slate-200 dark:bg-slate-700" />
                    <div className="h-2 w-5/6 rounded-full bg-slate-200 dark:bg-slate-700" />
                    <div className="h-2 w-3/5 rounded-full bg-slate-200 dark:bg-slate-700" />
                  </div>
                </div>
              </div>
            ) : (
              <div
                role="status"
                className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400"
              >
                <Spinner size={14} /> {employee?.name ?? "AI Employee"} is replying…
              </div>
            ))}
          {error && (
            <div className="space-y-3">
              <FormError message={error} />
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() =>
                  employee ? void explain(++requestId.current, retryMessage, messages) : void load()
                }
              >
                <RotateCcw size={13} /> Try again
              </Button>
            </div>
          )}
          {!busy && !error && options && !employee && (
            <div className="flex flex-1 flex-col items-center justify-center py-8 text-center">
              <span className="mb-3 rounded-xl bg-slate-100 p-3 text-slate-400 dark:bg-slate-800">
                <MessageSquare size={22} aria-hidden="true" />
              </span>
              <p className="text-sm font-medium text-slate-800 dark:text-slate-100">
                An explanation is unavailable
              </p>
              <p className="mt-2 max-w-sm text-sm leading-6 text-slate-500 dark:text-slate-400">
                The AI Employee who ran this Routine needs a connected AI Model to explain this Run.
                You can still read the Run log.
              </p>
            </div>
          )}
        </div>
      </div>
      {employee && (
        <form
          onSubmit={sendMessage}
          className="shrink-0 border-t border-slate-200/80 bg-slate-50/60 px-4 py-3 sm:px-6 sm:py-4 dark:border-slate-800 dark:bg-slate-950/30"
        >
          <div className="mx-auto max-w-3xl">
            <div className="rounded-xl border border-slate-300 bg-white shadow-sm transition focus-within:border-indigo-400 focus-within:ring-2 focus-within:ring-indigo-500/10 dark:border-slate-700 dark:bg-slate-900 dark:focus-within:border-indigo-500">
              <label
                htmlFor={composerId}
                className="block px-3 pt-3 text-xs font-medium text-slate-700 dark:text-slate-200"
              >
                Message {employee.name}
              </label>
              <textarea
                id={composerId}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    (event.metaKey || event.ctrlKey) &&
                    !event.nativeEvent.isComposing
                  ) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
                placeholder="Ask about the cause, evidence, or next steps…"
                maxLength={4000}
                rows={2}
                aria-describedby={`${composerId}-hint`}
                className="block w-full resize-none border-0 bg-transparent px-3 py-2 text-sm leading-6 text-slate-900 placeholder:text-slate-400 focus:ring-0 focus-visible:outline-none dark:text-slate-100 dark:placeholder:text-slate-500"
              />
              <div className="flex items-center justify-between gap-2 px-3 pb-2">
                <span className="text-[11px] text-slate-400 dark:text-slate-500">
                  <span className="hidden sm:inline">⌘ / Ctrl + Enter to send</span>
                  {draft.length > 3500 && (
                    <span className="ml-2 tabular-nums">
                      {draft.length.toLocaleString()} / 4,000
                    </span>
                  )}
                </span>
                <Button type="submit" size="sm" disabled={busy || !draft.trim()}>
                  <ArrowUp size={14} /> Send
                </Button>
              </div>
            </div>
            <p
              id={`${composerId}-hint`}
              className="mt-2 text-[11px] leading-4 text-slate-500 dark:text-slate-400"
            >
              Discussion only. This chat does not retry the Routine or make changes.
            </p>
          </div>
        </form>
      )}
    </section>
  );
}

function ExplanationMessage({ message }: { message: ChatMessage }) {
  if (message.role === "user") {
    return (
      <div className="ml-auto max-w-[90%] rounded-xl rounded-tr-sm bg-slate-100 px-4 py-3 dark:bg-slate-800">
        <p className="mb-1 text-[11px] font-medium text-slate-500 dark:text-slate-400">You</p>
        <p className="whitespace-pre-wrap break-words text-sm leading-6 text-slate-800 dark:text-slate-100">
          {message.content}
        </p>
      </div>
    );
  }
  const name = message.employee?.name ?? "AI Employee";
  return (
    <div className="flex min-w-0 gap-3">
      <Avatar name={name} kind="ai" size="md" className="mt-0.5 hidden sm:inline-flex" />
      <div className="min-w-0 flex-1 text-sm leading-6 text-slate-700 dark:text-slate-200">
        <p className="mb-2 flex flex-wrap items-center gap-2 text-xs font-semibold text-slate-800 dark:text-slate-100">
          <span>{name}</span>
          <span className="text-[10px] font-normal text-slate-400 dark:text-slate-500">
            AI Employee
          </span>
        </p>
        <ChatMarkdown content={message.content} />
      </div>
    </div>
  );
}
