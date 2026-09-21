import React from "react";
import { Send, Sparkles } from "lucide-react";
import { api, streamPost, type RunStatus } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { isRunError } from "@/lib/runStatus";
import { ChatMarkdown } from "@/components/ChatMarkdown";
import { Button } from "@/components/ui/Button";
import { FormError } from "@/components/ui/FormError";
import { Select } from "@/components/ui/Select";
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
export function RunExplanation({ companyId, runId }: { companyId: string; runId: string }) {
  const [options, setOptions] = React.useState<ExplanationOptions | null>(null);
  const [employeeId, setEmployeeId] = React.useState("");
  const [messages, setMessages] = React.useState<ChatMessage[]>([]);
  const [draft, setDraft] = React.useState("");
  const [pendingMessage, setPendingMessage] = React.useState("");
  const [retryMessage, setRetryMessage] = React.useState("");
  const [busy, setBusy] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const requestId = React.useRef(0);
  const activeRequest = React.useRef<AbortController | null>(null);
  const base = `/api/companies/${companyId}/runs/${runId}/explanation`;
  const employee = options?.employees.find((entry) => entry.id === employeeId);
  const selectId = React.useId();
  const composerId = React.useId();
  const replyEnd = React.useRef<HTMLDivElement>(null);

  const explain = React.useCallback(
    async (selectedId: string, request: number, message = "", previous: ChatMessage[] = []) => {
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
            employeeId: selectedId,
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
      setEmployeeId(result.defaultEmployeeId ?? "");
      if (result.defaultEmployeeId) {
        await explain(result.defaultEmployeeId, request);
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
    if (messages.length > 1) replyEnd.current?.scrollIntoView({ block: "nearest" });
  }, [messages]);

  function sendMessage(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !employeeId || !draft.trim()) return;
    void explain(employeeId, ++requestId.current, draft.trim(), messages);
  }

  return (
    <section aria-label="Run explanation" className="min-w-0 space-y-4 py-1">
      {options && options.employees.length > 0 && (
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-0 basis-full sm:max-w-xs sm:flex-1 sm:basis-auto">
            <label
              htmlFor={selectId}
              className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300"
            >
              AI Employee
            </label>
            <Select
              id={selectId}
              aria-label="AI Employee"
              value={employeeId}
              disabled={busy}
              onChange={(event) => setEmployeeId(event.target.value)}
              searchPlaceholder="Search AI Employees…"
            >
              {options.employees.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </Select>
          </div>
          {!busy && (
            <Button
              variant="secondary"
              onClick={() =>
                void explain(employeeId, ++requestId.current, error ? retryMessage : "", messages)
              }
              disabled={!employeeId}
            >
              <Sparkles size={14} /> {error ? "Try again" : "Ask AI Employee"}
            </Button>
          )}
        </div>
      )}
      {messages.length > 0 && (
        <div className="min-w-0 space-y-5" aria-label="Conversation about this Run">
          {messages.map((message, index) => (
            <div
              key={index}
              className={
                message.role === "user"
                  ? "rounded-xl bg-slate-100 p-3 dark:bg-slate-800"
                  : "min-w-0 space-y-2"
              }
            >
              <p className="mb-1 text-xs font-medium text-slate-500 dark:text-slate-400">
                {message.role === "user"
                  ? "You"
                  : `Explanation by ${message.employee?.name ?? "AI Employee"}`}
              </p>
              {message.role === "user" ? (
                <p className="whitespace-pre-wrap break-words text-sm">{message.content}</p>
              ) : (
                <ChatMarkdown content={message.content} />
              )}
            </div>
          ))}
          <div ref={replyEnd} />
        </div>
      )}
      {pendingMessage && (
        <div className="rounded-xl bg-slate-100 p-3 dark:bg-slate-800">
          <p className="mb-1 text-xs font-medium text-slate-500 dark:text-slate-400">You</p>
          <p className="whitespace-pre-wrap break-words text-sm">{pendingMessage}</p>
        </div>
      )}
      {busy && (
        <div
          role="status"
          className="flex items-center gap-2 py-8 text-sm text-slate-600 dark:text-slate-300"
        >
          <Spinner size={16} />
          {employee
            ? pendingMessage
              ? `${employee.name} is replying…`
              : `${employee.name} is reading this Run’s logs…`
            : "Finding an AI Employee…"}
        </div>
      )}
      {error && (
        <div className="space-y-3">
          <FormError message={error} />
          {!options && (
            <Button variant="secondary" onClick={() => void load()}>
              Try again
            </Button>
          )}
          {options && (
            <p className="text-xs text-slate-500 dark:text-slate-400">
              You can choose another AI Employee and try again.
            </p>
          )}
        </div>
      )}
      {!busy && options?.employees.length === 0 && (
        <p className="py-4 text-sm text-slate-600 dark:text-slate-300">
          Connect an AI Model to an AI Employee to explain this Run. You can still read the Run log.
        </p>
      )}
      {options && options.employees.length > 0 && (
        <form
          onSubmit={sendMessage}
          className="space-y-2 border-t border-slate-200 pt-4 dark:border-slate-800"
        >
          <label
            htmlFor={composerId}
            className="block text-sm font-medium text-slate-700 dark:text-slate-200"
          >
            Message AI Employee
          </label>
          <textarea
            id={composerId}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Ask about the cause, evidence, or next steps…"
            maxLength={4000}
            rows={3}
            disabled={busy}
            className="w-full resize-y rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 disabled:opacity-60 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
          />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="max-w-md text-xs text-slate-500 dark:text-slate-400">
              Discuss this Run&apos;s recorded evidence and possible fixes. This chat does not retry
              the Routine or make changes.
            </p>
            <Button type="submit" disabled={busy || !employeeId || !draft.trim()}>
              <Send size={14} /> Send
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
