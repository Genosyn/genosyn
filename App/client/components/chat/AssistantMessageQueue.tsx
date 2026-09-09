import React from "react";
import { Clock, Loader2, Paperclip, Play, X } from "lucide-react";
import type { AssistantQueuedMessage } from "@/lib/assistantChatSessions";
import { FormError } from "@/components/ui/FormError";

/** Stays beside the input even when the Member scrolls away from the reply. */
export function AssistantWorkStatus({
  name,
  startedAt,
  reconnecting,
}: {
  name: string;
  startedAt?: string;
  reconnecting: boolean;
}) {
  const [now, setNow] = React.useState(Date.now);
  React.useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  const seconds = startedAt ? Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1_000)) : 0;
  const elapsed = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;

  return (
    <div
      role="status"
      className="mb-2 flex items-start gap-2.5 rounded-xl border border-indigo-200 bg-indigo-50 px-3 py-2.5 dark:border-indigo-500/30 dark:bg-indigo-500/10"
    >
      <Loader2
        size={16}
        aria-hidden="true"
        className="mt-0.5 shrink-0 motion-safe:animate-spin text-indigo-600 dark:text-indigo-300"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2 text-xs font-medium text-indigo-900 dark:text-indigo-100">
          <span>{reconnecting ? "Reconnecting to the reply…" : `${name} is working`}</span>
          {Number.isFinite(seconds) && seconds > 0 && (
            <span
              aria-hidden="true"
              className="shrink-0 font-normal tabular-nums text-indigo-600 dark:text-indigo-300"
            >
              {elapsed}
            </span>
          )}
        </div>
        <p className="mt-0.5 text-[11px] leading-relaxed text-indigo-700 dark:text-indigo-200">
          {reconnecting
            ? "Checking the reply’s status. Your follow-ups will wait."
            : "You can add a follow-up. It will send after this reply."}
        </p>
      </div>
    </div>
  );
}

export function AssistantMessageQueue({
  messages,
  paused,
  onRemove,
  onResume,
}: {
  messages: AssistantQueuedMessage[];
  paused: string | null;
  onRemove: (id: string) => void;
  onResume: () => void;
}) {
  if (messages.length === 0 && !paused) return null;
  return (
    <section
      aria-label="Queued messages"
      className="mb-2 overflow-hidden rounded-xl border border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-900"
    >
      <div className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-600 dark:text-slate-300">
        <Clock size={13} aria-hidden="true" />
        <span>{messages.length} queued</span>
        {!paused && (
          <span className="ml-auto text-[11px] font-normal text-slate-500">Sent in order</span>
        )}
      </div>
      {messages.length > 0 && (
        <ol className="max-h-36 overflow-y-auto border-t border-slate-200 dark:border-slate-700">
          {messages.map((item, index) => (
            <li
              key={item.id}
              className="flex items-start gap-2 border-b border-slate-200 px-3 py-2 last:border-b-0 dark:border-slate-700"
            >
              <span className="pt-0.5 text-[11px] tabular-nums text-slate-400">{index + 1}</span>
              <div className="min-w-0 flex-1 text-xs text-slate-700 dark:text-slate-200">
                {item.message && (
                  <p className="line-clamp-2 break-words whitespace-pre-wrap">{item.message}</p>
                )}
                {item.attachments.map((file) => (
                  <div
                    key={file.id}
                    className="mt-0.5 flex items-center gap-1 text-[11px] text-slate-500 dark:text-slate-400"
                  >
                    <Paperclip size={11} className="shrink-0" aria-hidden="true" />
                    <span className="truncate">{file.filename}</span>
                  </div>
                ))}
              </div>
              <button
                type="button"
                onClick={() => onRemove(item.id)}
                aria-label={`Remove queued message ${index + 1}`}
                title="Remove queued message"
                className="shrink-0 rounded p-1 text-slate-400 hover:bg-slate-200 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
              >
                <X size={13} />
              </button>
            </li>
          ))}
        </ol>
      )}
      {paused && (
        <div className="border-t border-slate-200 px-3 py-2 dark:border-slate-700">
          <FormError message={paused} />
          {messages.length > 0 && (
            <button
              type="button"
              onClick={onResume}
              className="mt-1 flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-100 dark:text-indigo-300 dark:hover:bg-indigo-500/20"
            >
              <Play size={12} aria-hidden="true" /> Resume queue
            </button>
          )}
        </div>
      )}
    </section>
  );
}
