import React from "react";
import { MessagesSquare, Send } from "lucide-react";
import { ChatMarkdown } from "@/components/ChatMarkdown";
import { Avatar, employeeAvatarUrl } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { FormError } from "@/components/ui/FormError";
import { Spinner } from "@/components/ui/Spinner";
import { clsx } from "@/components/ui/clsx";
import type { ChatProgress, Company, ConversationMessage, Decision } from "@/lib/api";
import { ReviewTimelineItem } from "@/components/decisions/ReviewTimeline";
import { isWorkingMessage } from "@/components/decisions/discussionTranscript";
import { useDecisionDiscussion } from "@/components/decisions/useDecisionDiscussion";

/** The longest message the chat endpoint accepts. */
const MESSAGE_MAX_CHARS = 8_000;

/**
 * The discussion step of a Decision's timeline: a private conversation with
 * the AI Employee who asked, on the same card as the choice it is about.
 *
 * The employee reads the Decision's live context, options and outcome on every
 * turn and can do nothing but discuss them. Nothing said here answers,
 * dismisses or snoozes the Decision — the card's own controls still do that.
 */
export function DecisionDiscussion({
  id,
  company,
  decision,
  employee,
  autoFocus = false,
}: {
  id: string;
  company: Company;
  decision: Decision;
  employee: NonNullable<Decision["employee"]>;
  /** Move focus to the message box, when the Member just opened this. */
  autoFocus?: boolean;
}) {
  const discussion = useDecisionDiscussion(company.id, decision.id, employee.id);
  const [retrying, setRetrying] = React.useState(false);
  const avatar = employeeAvatarUrl(company.id, employee.id, employee.avatarKey);
  const pending = decision.status === "pending";

  async function retry() {
    setRetrying(true);
    try {
      await discussion.retry();
    } finally {
      setRetrying(false);
    }
  }

  return (
    <ReviewTimelineItem
      id={id}
      icon={MessagesSquare}
      title={`Discussion with ${employee.name}`}
      meta="Only you can see this"
      tone="accent"
    >
      <div
        role="log"
        aria-label={`Messages with ${employee.name}`}
        aria-live="polite"
        aria-busy={discussion.replying}
        className="space-y-3"
      >
        {discussion.messages.map((message) => (
          <DiscussionMessage
            key={message.id}
            message={message}
            employeeName={employee.name}
            avatar={avatar}
            streamingReply={
              message.id === discussion.streamingId ? discussion.streamingReply : null
            }
            progress={message.id === discussion.streamingId ? discussion.progress : null}
          />
        ))}
      </div>
      {discussion.load === "loading" && discussion.messages.length === 0 && (
        <p className="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
          <Spinner size={14} /> Loading the discussion…
        </p>
      )}
      {discussion.load === "error" && (
        <div className="mt-3 space-y-2">
          <FormError message={discussion.loadError} />
          <Button
            type="button"
            size="sm"
            variant="secondary"
            loading={retrying}
            onClick={() => void retry()}
          >
            Retry
          </Button>
        </div>
      )}
      {discussion.load === "ready" && discussion.messages.length === 0 && (
        <p className="text-sm leading-relaxed text-slate-500 dark:text-slate-400">
          {pending
            ? `Ask ${employee.name} why it recommends an option, what it has already checked, or what changes if you wait. Discussing does not answer the decision.`
            : `Ask ${employee.name} about this decision and what happened after it was resolved.`}
        </p>
      )}
      <DiscussionComposer
        employeeName={employee.name}
        placeholder={
          pending
            ? `Ask ${employee.name} about this decision…`
            : `Ask ${employee.name} about this outcome…`
        }
        sending={discussion.sending}
        replying={discussion.replying}
        autoFocus={autoFocus}
        onSend={discussion.send}
      />
    </ReviewTimelineItem>
  );
}

function DiscussionMessage({
  message,
  employeeName,
  avatar,
  streamingReply,
  progress,
}: {
  message: ConversationMessage;
  employeeName: string;
  avatar: string | null;
  streamingReply: string | null;
  progress: ChatProgress | null;
}) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="min-w-0 max-w-[85%] rounded-2xl rounded-br-md bg-indigo-600 px-3.5 py-2 text-sm leading-relaxed text-white shadow-sm dark:bg-indigo-500 [&_a]:text-white [&_a]:underline">
          <span className="sr-only">You: </span>
          <ChatMarkdown content={message.content} />
        </div>
      </div>
    );
  }

  const working = isWorkingMessage(message);
  const failed = message.status === "error" || message.status === "skipped";
  return (
    <div className="flex items-start gap-2">
      <Avatar name={employeeName} src={avatar} kind="ai" size="sm" className="mt-1" />
      <div
        className={clsx(
          "min-w-0 max-w-[85%] rounded-2xl rounded-tl-md border px-3.5 py-2 text-sm leading-relaxed shadow-sm",
          message.status === "error"
            ? "border-rose-200 bg-rose-50 text-rose-900 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-100"
            : message.status === "skipped"
              ? "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100"
              : message.status === "interrupted"
                ? "border-dashed border-slate-300 bg-white text-slate-900 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
                : "border-slate-200 bg-white text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100",
        )}
      >
        <span className="sr-only">{employeeName}: </span>
        {working && !streamingReply ? (
          <span className="flex items-center gap-2 text-slate-500 dark:text-slate-400">
            <Spinner size={13} />
            {progress?.label ?? message.progress?.label ?? `${employeeName} is thinking…`}
          </span>
        ) : working ? (
          <>
            <ChatMarkdown content={streamingReply ?? ""} />
            <span
              aria-hidden="true"
              className="ml-0.5 inline-block h-3.5 w-[2px] animate-pulse bg-slate-400 align-middle"
            />
          </>
        ) : failed ? (
          <p className="whitespace-pre-wrap break-words">{message.content}</p>
        ) : (
          <ChatMarkdown content={message.content} />
        )}
      </div>
    </div>
  );
}

function DiscussionComposer({
  employeeName,
  placeholder,
  sending,
  replying,
  autoFocus,
  onSend,
}: {
  employeeName: string;
  placeholder: string;
  sending: boolean;
  replying: boolean;
  autoFocus: boolean;
  onSend: (text: string) => Promise<string | null>;
}) {
  const [value, setValue] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const inputRef = React.useRef<HTMLTextAreaElement>(null);
  const inputId = React.useId();
  const hintId = React.useId();

  React.useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  async function submit() {
    const text = value.trim();
    if (!text || replying) return;
    setError(null);
    setValue("");
    const failure = await onSend(text);
    if (failure) {
      setError(failure);
      // Give the words back unless the Member already started new ones.
      setValue((current) => current || text);
    }
  }

  return (
    <form
      className="mt-3"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <label htmlFor={inputId} className="sr-only">
        Message {employeeName}
      </label>
      <div className="rounded-lg border border-slate-200 bg-white shadow-sm focus-within:border-indigo-400 focus-within:ring-2 focus-within:ring-indigo-500/20 dark:border-slate-700 dark:bg-slate-900">
        <textarea
          ref={inputRef}
          id={inputId}
          rows={2}
          value={value}
          maxLength={MESSAGE_MAX_CHARS}
          placeholder={placeholder}
          aria-describedby={hintId}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void submit();
            }
          }}
          className="block max-h-48 min-h-[3.5rem] w-full resize-y bg-transparent px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none dark:text-slate-100 dark:placeholder:text-slate-500"
        />
        <div className="flex items-center justify-between gap-2 border-t border-slate-100 px-2 py-1.5 dark:border-slate-800">
          <span
            id={hintId}
            className="min-w-0 truncate pl-1 text-[11px] text-slate-400 dark:text-slate-500"
          >
            {replying
              ? `${employeeName} is replying…`
              : "Enter to send · Shift + Enter for a new line"}
          </span>
          <Button
            type="submit"
            size="sm"
            loading={sending}
            disabled={replying || !value.trim()}
            className="shrink-0"
          >
            <Send size={14} />
            Send
          </Button>
        </div>
      </div>
      <FormError message={error} className="mt-2" />
    </form>
  );
}
