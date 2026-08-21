import React from "react";
import { CornerDownLeft, ShieldAlert, Sparkles, Trash2 } from "lucide-react";

import { ChatMarkdown } from "@/components/ChatMarkdown";
import { useLiveRefetch } from "@/components/CompanySocket";
import { Avatar, employeeAvatarUrl } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { useDialog } from "@/components/ui/Dialog";
import { Spinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { clsx } from "@/components/ui/clsx";
import type { Company, TldrItem } from "@/lib/api";
import {
  mergeQuestions,
  TLDR_QUESTION_MESSAGE_MAX_CHARS,
  TLDR_QUESTION_PRESETS,
  TLDR_QUESTION_PROMPT_MAX_CHARS,
  tldrQuestionsApi,
  upsertQuestionMessage,
  workingMessage,
  type TldrQuestion,
  type TldrQuestionMessage,
  type TldrQuestionsResponse,
} from "@/lib/tldrQuestions";

/**
 * Question cards on a TLDR — asked, answered, and discussed on the same page
 * as the briefing.
 *
 * A card is not part of the brief. The recap says what happened; a card asks
 * one forward-looking question about it and keeps its own conversation, so
 * "what should we stop doing?" and "what needs a decision from me?" read as two
 * separate answers rather than one long thread.
 *
 * The reply belongs to the server, not to this connection. Every turn is
 * persisted as a `working` row before the model starts, so a closed panel, a
 * dropped stream, or a reload picks the same turn back up by polling instead of
 * dead-ending — and nobody has to guess whether re-sending would duplicate the
 * work.
 */

/** How often a card that lost its stream re-reads its in-flight turn. */
const FOLLOW_POLL_MS = 2_000;

type StreamState = { questionId: string | null; open: boolean };

export function TldrQuestions({
  company,
  item,
  open,
  onOpenChange,
}: {
  company: Pick<Company, "id" | "slug">;
  item: TldrItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { toast } = useToast();
  const dialog = useDialog();
  const [data, setData] = React.useState<TldrQuestionsResponse | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [stream, setStream] = React.useState<StreamState>({ questionId: null, open: false });
  const [reconnecting, setReconnecting] = React.useState(false);
  const abortRef = React.useRef<AbortController | null>(null);
  const askRef = React.useRef<HTMLTextAreaElement | null>(null);

  const reload = React.useCallback(async () => {
    try {
      const next = await tldrQuestionsApi.list(company.id, item.id);
      setData((current) =>
        current ? { ...next, questions: mergeQuestions(current.questions, next.questions) } : next,
      );
      setError(null);
      setReconnecting(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the questions on this TLDR.");
    }
  }, [company.id, item.id]);

  React.useEffect(() => {
    if (!open || data) return;
    void reload();
  }, [open, data, reload]);

  // Abort any in-flight stream when this card unmounts or the briefing changes,
  // or a slow reply keeps painting into a component nobody is looking at.
  React.useEffect(() => {
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [item.id]);

  useLiveRefetch("tldr_question", reload, item.id);

  const questions = data?.questions ?? [];
  const inFlight = questions.find((q) => workingMessage(q) !== null) ?? null;
  const workingId = inFlight ? workingMessage(inFlight)!.id : null;

  // Recovery: a persisted `working` row with no live stream behind it is a turn
  // this browser lost, not a lost reply. Poll the card list until it finalizes.
  // A failed poll keeps polling — boot recovery closes a truly abandoned row.
  React.useEffect(() => {
    if (!open || !workingId || stream.open) return;
    let cancelled = false;
    let timer: number | null = null;
    const tick = async () => {
      if (cancelled) return;
      try {
        const next = await tldrQuestionsApi.list(company.id, item.id);
        if (cancelled) return;
        setData((current) =>
          current
            ? { ...next, questions: mergeQuestions(current.questions, next.questions) }
            : next,
        );
        setReconnecting(false);
      } catch {
        if (!cancelled) setReconnecting(true);
      }
      if (!cancelled) timer = window.setTimeout(() => void tick(), FOLLOW_POLL_MS);
    };
    timer = window.setTimeout(() => void tick(), FOLLOW_POLL_MS);
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [open, workingId, stream.open, company.id, item.id]);

  const busy = stream.open || workingId !== null;

  /** Fold one SSE event into the card list. */
  function applyEvent(questionId: string | null, event: string, payload: unknown) {
    if (event === "question") {
      const question = payload as TldrQuestion;
      setData((current) =>
        current
          ? {
              ...current,
              questions: current.questions.some((q) => q.id === question.id)
                ? current.questions.map((q) => (q.id === question.id ? question : q))
                : [...current.questions, question],
            }
          : current,
      );
      return question.id;
    }
    if (event === "user" || event === "working" || event === "assistant") {
      const message = payload as TldrQuestionMessage;
      setData((current) =>
        current
          ? {
              ...current,
              questions: current.questions.map((q) =>
                q.id === message.questionId
                  ? { ...q, messages: upsertQuestionMessage(q.messages, message) }
                  : q,
              ),
            }
          : current,
      );
      return message.questionId;
    }
    if (event === "chunk" && questionId) {
      const text = (payload as { text?: string }).text ?? "";
      setData((current) =>
        current
          ? {
              ...current,
              questions: current.questions.map((q) => {
                if (q.id !== questionId) return q;
                const working = workingMessage(q);
                if (!working) return q;
                return {
                  ...q,
                  messages: upsertQuestionMessage(q.messages, {
                    ...working,
                    content: working.content + text,
                  }),
                };
              }),
            }
          : current,
      );
    }
    return questionId;
  }

  async function runTurn(
    start: (
      onEvent: (event: string, payload: unknown) => void,
      signal: AbortSignal,
    ) => Promise<void>,
    initialQuestionId: string | null,
  ) {
    if (busy) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setStream({ questionId: initialQuestionId, open: true });
    setError(null);

    let current = initialQuestionId;
    // A box rather than a plain binding: the server reports a refused turn as
    // an `error` event mid-stream, and the assignment happens inside a callback
    // the compiler cannot see through.
    const failure: { message: string | null } = { message: null };
    try {
      await start((event, payload) => {
        if (event === "error") {
          failure.message =
            (payload as { message?: string }).message ?? "This reply could not be started.";
          return;
        }
        current = applyEvent(current, event, payload);
      }, controller.signal);
      if (failure.message) setError(failure.message);
    } catch (err) {
      if (controller.signal.aborted) return;
      // The connection can die between the server persisting the in-flight row
      // and this stream hearing about it. Re-read before claiming nothing ran,
      // so a reply that is actually running isn't reported as a failure.
      await reload();
      setError(
        err instanceof Error
          ? `The connection to Genosyn dropped: ${err.message}`
          : "The connection to Genosyn dropped.",
      );
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setStream({ questionId: null, open: false });
    }
  }

  async function ask(prompt: string) {
    const clean = prompt.trim();
    if (!clean || busy) return;
    if (askRef.current) askRef.current.value = "";
    await runTurn(
      (onEvent, signal) =>
        tldrQuestionsApi.ask(company.id, item.id, { prompt: clean }, onEvent, signal),
      null,
    );
  }

  async function remove(question: TldrQuestion) {
    if (busy) return;
    if (
      !(await dialog.confirm({
        title: "Remove this question?",
        message:
          "The card and its whole conversation are deleted for everyone in the company. The briefing itself is untouched.",
        confirmLabel: "Remove question",
        variant: "danger",
      }))
    ) {
      return;
    }
    const previous = data;
    setData((current) =>
      current
        ? { ...current, questions: current.questions.filter((q) => q.id !== question.id) }
        : current,
    );
    try {
      await tldrQuestionsApi.remove(company.id, item.id, question.id);
    } catch (err) {
      setData(previous);
      toast(
        `Couldn’t remove the question: ${err instanceof Error ? err.message : "Unknown error"}`,
        "error",
      );
    }
  }

  const employeeName = item.employee.name || "the AI Employee";
  const asked = new Set(questions.map((q) => q.prompt.toLowerCase()));
  const presets = TLDR_QUESTION_PRESETS.filter((p) => !asked.has(p.toLowerCase()));
  const atCap = data ? questions.length >= data.maxQuestions : false;
  const canAsk = (data?.canAsk ?? item.employee.id !== null) && !atCap;

  // Collapsed, this panel is silent: the briefing card owns the single
  // "Discuss" affordance, and opening it is what loads the cards.
  if (!open) return null;

  return (
    <section className="mt-4 border-t border-slate-100 pt-4 dark:border-slate-800">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          <Sparkles size={13} /> Questions
        </h3>
        <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)}>
          Hide
        </Button>
      </div>

      {!data && !error ? (
        <div className="mt-3 flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
          <Spinner size={14} /> Loading questions…
        </div>
      ) : null}

      {error && (
        <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:border-rose-500/25 dark:bg-rose-500/10 dark:text-rose-200">
          {error}
        </div>
      )}

      {reconnecting && (
        <div className="mt-3 flex items-center gap-2 text-xs text-amber-700 dark:text-amber-300">
          <Spinner size={12} /> Reconnecting to the reply already running on the server…
        </div>
      )}

      {questions.length > 0 && (
        <div className="mt-3 space-y-3">
          {questions.map((question) => (
            <QuestionCard
              key={question.id}
              company={company}
              item={item}
              question={question}
              busy={busy}
              canDelegateAutomation={data?.canDelegateAutomation ?? false}
              onRemove={() => void remove(question)}
              onSend={(message) =>
                runTurn(
                  (onEvent, signal) =>
                    tldrQuestionsApi.send(
                      company.id,
                      item.id,
                      question.id,
                      { message },
                      onEvent,
                      signal,
                    ),
                  question.id,
                )
              }
            />
          ))}
        </div>
      )}

      {data && !data.canAsk && (
        <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
          {questions.length > 0
            ? "The AI Employee who wrote this briefing was removed, so no new questions can be asked about it."
            : "The AI Employee who wrote this briefing was removed, so questions about it are unavailable."}
        </p>
      )}

      {data && data.canAsk && atCap && (
        <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
          This briefing has all {data.maxQuestions} question cards. Remove one to ask another.
        </p>
      )}

      {canAsk && (
        <div className="mt-3">
          {presets.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {presets.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  disabled={busy}
                  onClick={() => void ask(preset)}
                  className="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[11px] text-slate-600 transition hover:border-indigo-200 hover:bg-indigo-50 hover:text-indigo-700 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:border-indigo-500/30 dark:hover:bg-indigo-500/10 dark:hover:text-indigo-300"
                >
                  {preset}
                </button>
              ))}
            </div>
          )}
          <Composer
            ref={askRef}
            placeholder={`Ask ${employeeName} anything about this briefing…`}
            maxLength={TLDR_QUESTION_PROMPT_MAX_CHARS}
            busy={busy}
            submitLabel="Ask"
            onSubmit={(value) => void ask(value)}
          />
        </div>
      )}
    </section>
  );
}

function QuestionCard({
  company,
  item,
  question,
  busy,
  canDelegateAutomation,
  onRemove,
  onSend,
}: {
  company: Pick<Company, "id" | "slug">;
  item: TldrItem;
  question: TldrQuestion;
  busy: boolean;
  canDelegateAutomation: boolean;
  onRemove: () => void;
  onSend: (message: string) => Promise<void>;
}) {
  const employee = question.employee;
  const avatar = employee.id
    ? employeeAvatarUrl(company.id, employee.id, employee.avatarKey)
    : null;
  const working = workingMessage(question);
  const answered = question.messages.some((m) => m.role === "assistant" && m.status !== "working");

  return (
    <article className="rounded-lg border border-slate-200 bg-slate-50/60 p-3 dark:border-slate-800 dark:bg-slate-900/40">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h4 className="text-sm font-semibold leading-5 text-slate-900 dark:text-slate-100">
            {question.prompt}
          </h4>
          <div className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
            Answered by {employee.name || "AI Employee"}
          </div>
        </div>
        <button
          type="button"
          onClick={onRemove}
          disabled={busy}
          aria-label={`Remove the question “${question.prompt}”`}
          title={
            busy
              ? "Wait for the reply to finish before removing this question"
              : "Remove this question"
          }
          className="shrink-0 rounded-md p-1 text-slate-400 transition hover:bg-rose-50 hover:text-rose-600 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-slate-400 dark:hover:bg-rose-500/10 dark:hover:text-rose-300"
        >
          <Trash2 size={13} />
        </button>
      </div>

      <div className="mt-2.5 space-y-2.5">
        {question.messages.map((message) => (
          <Bubble
            key={message.id}
            company={company}
            message={message}
            employeeName={employee.name}
            avatar={avatar}
          />
        ))}
      </div>

      {answered && item.employee.id !== null && (
        <>
          {!canDelegateAutomation && (
            <p className="mt-2.5 flex items-start gap-1.5 text-[11px] leading-4 text-slate-400 dark:text-slate-500">
              <ShieldAlert size={12} className="mt-px shrink-0" />
              Scheduling or changing a Routine is an owner or admin action. {employee.name ||
                "The AI Employee"}{" "}
              can write the proposal here, but cannot make the change for you.
            </p>
          )}
          <Composer
            placeholder={`Reply to ${employee.name || "the AI Employee"} — ask them to act on this…`}
            maxLength={TLDR_QUESTION_MESSAGE_MAX_CHARS}
            busy={busy}
            submitLabel="Send"
            onSubmit={(value) => void onSend(value)}
          />
        </>
      )}

      {working && !working.content && (
        <div className="mt-2.5 flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
          <Spinner size={13} /> {employee.name || "The AI Employee"} is thinking…
        </div>
      )}
    </article>
  );
}

function Bubble({
  company,
  message,
  employeeName,
  avatar,
}: {
  company: Pick<Company, "id" | "slug">;
  message: TldrQuestionMessage;
  employeeName: string;
  avatar: string | null;
}) {
  if (message.role === "user") {
    return (
      <div className="ml-6 rounded-lg bg-indigo-50 px-3 py-2 text-sm leading-6 text-indigo-900 dark:bg-indigo-500/10 dark:text-indigo-100">
        <span className="whitespace-pre-wrap">{message.content}</span>
      </div>
    );
  }

  // A `working` row with text in it is a live stream; with none it is the
  // spinner the card renders separately.
  if (message.status === "working" && !message.content) return null;

  const failed = message.status === "error" || message.status === "skipped";
  return (
    <div className="flex items-start gap-2">
      <Avatar
        name={employeeName || "AI Employee"}
        src={avatar}
        kind="ai"
        size="xs"
        className="mt-0.5 shrink-0"
      />
      <div
        className={clsx(
          "min-w-0 flex-1 rounded-lg px-3 py-2 text-sm leading-6",
          failed
            ? "bg-rose-50 text-rose-900 dark:bg-rose-500/10 dark:text-rose-200"
            : "bg-white text-slate-700 dark:bg-slate-950 dark:text-slate-300",
        )}
      >
        {failed ? (
          <span className="whitespace-pre-wrap">{message.content}</span>
        ) : (
          <ChatMarkdown content={message.content} />
        )}
        {message.status === "working" && (
          <span
            aria-hidden="true"
            className="ml-0.5 inline-block h-3.5 w-[2px] animate-pulse bg-slate-400 align-middle"
          />
        )}
        {message.actions.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {message.actions.map((action, index) => (
              <span
                key={`${action.action}-${action.targetId ?? index}`}
                className="inline-flex items-center rounded-md bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300"
                title={`${action.action} · ${company.slug}`}
              >
                {action.targetLabel || action.action}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * A chat composer. A raw `<textarea>` inside a bordered box rather than the
 * `Textarea` primitive, whose `min-h-[160px]` base is meant for form fields and
 * would tower over a two-line reply.
 */
const Composer = React.forwardRef<
  HTMLTextAreaElement,
  {
    placeholder: string;
    maxLength: number;
    busy: boolean;
    submitLabel: string;
    onSubmit: (value: string) => void;
  }
>(function Composer({ placeholder, maxLength, busy, submitLabel, onSubmit }, ref) {
  const inner = React.useRef<HTMLTextAreaElement | null>(null);
  const [value, setValue] = React.useState("");

  function submit() {
    const clean = value.trim();
    if (!clean || busy) return;
    setValue("");
    onSubmit(clean);
  }

  return (
    <div className="mt-2 rounded-lg border border-slate-200 bg-white focus-within:border-indigo-300 dark:border-slate-700 dark:bg-slate-950 dark:focus-within:border-indigo-500/40">
      <textarea
        ref={(node) => {
          inner.current = node;
          if (typeof ref === "function") ref(node);
          else if (ref) ref.current = node;
        }}
        rows={2}
        value={value}
        maxLength={maxLength}
        disabled={busy}
        placeholder={placeholder}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        className="w-full resize-none bg-transparent px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none disabled:opacity-60 dark:text-slate-200 dark:placeholder:text-slate-500"
      />
      <div className="flex items-center justify-between gap-2 border-t border-slate-100 px-2 py-1.5 dark:border-slate-800">
        <span className="text-[10px] text-slate-400 dark:text-slate-500">
          Enter to send · Shift + Enter for a new line
        </span>
        <Button size="sm" variant="secondary" disabled={busy || !value.trim()} onClick={submit}>
          {busy ? <Spinner size={12} /> : <CornerDownLeft size={12} />}
          {busy ? "Working…" : submitLabel}
        </Button>
      </div>
    </div>
  );
});
