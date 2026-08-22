import React from "react";
import {
  CalendarClock,
  Check,
  CheckCircle2,
  CornerDownLeft,
  FolderKanban,
  GitBranch,
  ListChecks,
  Lock,
  MessageSquare,
  MessagesSquare,
  Repeat,
  ShieldAlert,
  Sparkles,
  Trash2,
  X,
  Zap,
} from "lucide-react";

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
  visibleActions,
  workingMessage,
  type TldrActionKind,
  type TldrQuestion,
  type TldrQuestionMessage,
  type TldrQuestionsResponse,
  type TldrSuggestedAction,
} from "@/lib/tldrQuestions";

/**
 * Question cards on a TLDR — answered, actionable, and discussed on the same
 * page as the briefing.
 *
 * A card is not part of the brief. The recap says what happened; a card asks
 * one forward-looking question about it and keeps its own conversation, so
 * "what should we stop doing?" and "what needs a decision from me?" read as two
 * separate answers rather than one long thread.
 *
 * Cards arrive two ways and read identically. The company's standing questions
 * answer themselves the moment a brief is posted, so their cards are already
 * sitting under it — which is why this panel renders them whether or not
 * anybody opened the composer. A Member can still ask their own on top.
 *
 * Each answer carries its own buttons. Pressing one is not a shortcut around
 * anything: it sends the sentence printed beside the button back to the
 * employee as this Member's own instruction, under this Member's own access,
 * on exactly the seam a typed follow-up uses.
 *
 * The reply belongs to the server, not to this connection. Every turn is
 * persisted as a `working` row before the model starts, so a closed panel, a
 * dropped stream, or a reload picks the same turn back up by polling instead of
 * dead-ending — and nobody has to guess whether re-sending would duplicate the
 * work.
 */

/** How often a card that lost its stream re-reads its in-flight turn. */
const FOLLOW_POLL_MS = 2_000;

const ACTION_ICONS: Record<TldrActionKind, React.ComponentType<{ size?: number | string }>> = {
  routine: CalendarClock,
  todo: ListChecks,
  project: FolderKanban,
  decision: GitBranch,
  other: Zap,
};

type StreamState = { questionId: string | null; open: boolean };

export function TldrQuestions({
  company,
  item,
  open,
  onOpenChange,
}: {
  company: Pick<Company, "id" | "slug">;
  item: TldrItem;
  /** Whether the "ask another question" composer is showing. */
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

  // Cards exist before anybody asks for them, so this panel loads whenever the
  // briefing has any — the composer being open is a separate question.
  const wanted = open || item.questionCount > 0;

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
    if (!wanted || data) return;
    void reload();
  }, [wanted, data, reload]);

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
    if (!wanted || !workingId || stream.open) return;
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
  }, [wanted, workingId, stream.open, company.id, item.id]);

  const busy = stream.open || workingId !== null;
  // Read through a ref inside `runTurn`, because pressing a button goes through
  // an await (the confirm dialog) before it starts: by then the closure's
  // `busy` describes a render that may be several turns old, and acting on it
  // would abort a reply somebody else is watching arrive.
  const busyRef = React.useRef(busy);
  busyRef.current = busy;

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
    // Buttons arrive after the answer they belong to, because proposing them is
    // a second model turn — holding the finished answer back to wait for it
    // would trade a visible reply for a longer spinner.
    if (event === "suggested_actions") {
      const actions = (payload as { actions?: TldrSuggestedAction[] }).actions ?? [];
      if (actions.length > 0) {
        const target = actions[0].questionId;
        setData((current) =>
          current
            ? {
                ...current,
                questions: current.questions.map((q) => {
                  if (q.id !== target) return q;
                  // Keyed rather than appended: a poll or a live refetch can
                  // land between the server persisting these and this stream
                  // hearing about them, and the card would otherwise show each
                  // button twice.
                  const known = new Set(q.suggestedActions.map((a) => a.id));
                  return {
                    ...q,
                    suggestedActions: [
                      ...q.suggestedActions,
                      ...actions.filter((a) => !known.has(a.id)),
                    ],
                  };
                }),
              }
            : current,
        );
      }
      return questionId;
    }
    // Fires twice per press: once when the server claims the button, once when
    // the turn settles it. The second frame is what turns the spinner back
    // into a button or into a tick — without it a press reads as permanently
    // in flight.
    if (event === "action") {
      const update = payload as { id: string; status: TldrSuggestedAction["status"] };
      setData((current) =>
        current
          ? {
              ...current,
              questions: current.questions.map((q) => ({
                ...q,
                suggestedActions: q.suggestedActions.map((a) =>
                  a.id === update.id ? { ...a, status: update.status } : a,
                ),
              })),
            }
          : current,
      );
      return questionId;
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
    if (busyRef.current) return;
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
      if (failure.message) {
        setError(failure.message);
        // A refusal can land after the button was optimistically claimed, so
        // re-read rather than leaving it spinning on a turn that never ran.
        await reload();
      }
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

  /**
   * Press a button.
   *
   * The confirm step is not ceremony: it is where the Member reads the whole
   * sentence they are about to send, which is the entire reason a proposal
   * written by a model that saw untrusted source data is safe to offer as one
   * click.
   */
  async function runAction(question: TldrQuestion, action: TldrSuggestedAction) {
    if (busy) return;
    if (
      !(await dialog.confirm({
        title: action.label,
        message: (
          <span>
            <span className="block text-slate-700 dark:text-slate-300">{action.intent}</span>
            <span className="mt-2 block text-xs text-slate-500 dark:text-slate-400">
              {question.employee.name || "The AI Employee"} carries this out with your access, not
              theirs, and reports back on this card.
            </span>
          </span>
        ),
        confirmLabel: "Do it now",
      }))
    ) {
      return;
    }
    await runTurn(
      (onEvent, signal) =>
        tldrQuestionsApi.runAction(company.id, item.id, question.id, action.id, onEvent, signal),
      question.id,
    );
  }

  async function dismissAction(question: TldrQuestion, action: TldrSuggestedAction) {
    const previous = data;
    setData((current) =>
      current
        ? {
            ...current,
            questions: current.questions.map((q) =>
              q.id === question.id
                ? {
                    ...q,
                    suggestedActions: q.suggestedActions.map((a) =>
                      a.id === action.id ? { ...a, status: "dismissed" as const } : a,
                    ),
                  }
                : q,
            ),
          }
        : current,
    );
    try {
      await tldrQuestionsApi.dismissAction(company.id, item.id, question.id, action.id);
    } catch (err) {
      setData(previous);
      toast(
        `Couldn’t dismiss that suggestion: ${err instanceof Error ? err.message : "Unknown error"}`,
        "error",
      );
    }
  }

  async function remove(question: TldrQuestion) {
    if (busy) return;
    if (
      !(await dialog.confirm({
        title: "Remove this question?",
        message:
          question.origin === "standing"
            ? "The card, its suggestions, and its whole conversation are deleted for everyone in the company. The standing question itself stays in TLDR settings and will be answered on the next briefing."
            : "The card, its suggestions, and its whole conversation are deleted for everyone in the company. The briefing itself is untouched.",
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

  // Nothing to load and nothing to ask with: stay silent rather than render a
  // heading over an empty region.
  if (!wanted) return null;

  return (
    <section className="mt-5 border-t border-slate-100 pt-4 dark:border-slate-800">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          <Sparkles size={13} className="text-violet-500 dark:text-violet-400" />
          Answers
          {questions.length > 0 && (
            <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-slate-500 dark:bg-slate-800 dark:text-slate-400">
              {questions.length}
            </span>
          )}
        </h3>
        {open && (
          <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        )}
      </div>

      {!data && !error ? (
        <div className="mt-3 flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
          <Spinner size={14} /> Loading answers…
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
        <div className="mt-3 space-y-2.5">
          {questions.map((question) => (
            <QuestionCard
              key={question.id}
              company={company}
              item={item}
              question={question}
              busy={busy}
              canDelegateAutomation={data?.canDelegateAutomation ?? false}
              onRemove={() => void remove(question)}
              onRunAction={(action) => void runAction(question, action)}
              onDismissAction={(action) => void dismissAction(question, action)}
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

      {canAsk && open && (
        <div className="mt-3">
          {presets.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {presets.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  disabled={busy}
                  onClick={() => void ask(preset)}
                  className="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[11px] text-slate-600 transition hover:border-violet-200 hover:bg-violet-50 hover:text-violet-700 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:border-violet-500/30 dark:hover:bg-violet-500/10 dark:hover:text-violet-300"
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

      {canAsk && !open && (
        <button
          type="button"
          onClick={() => onOpenChange(true)}
          className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-dashed border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-500 transition hover:border-violet-300 hover:bg-violet-50/60 hover:text-violet-700 dark:border-slate-700 dark:text-slate-400 dark:hover:border-violet-500/30 dark:hover:bg-violet-500/10 dark:hover:text-violet-300"
        >
          <MessagesSquare size={13} /> Ask {employeeName} something else
        </button>
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
  onRunAction,
  onDismissAction,
  onSend,
}: {
  company: Pick<Company, "id" | "slug">;
  item: TldrItem;
  question: TldrQuestion;
  busy: boolean;
  canDelegateAutomation: boolean;
  onRemove: () => void;
  onRunAction: (action: TldrSuggestedAction) => void;
  onDismissAction: (action: TldrSuggestedAction) => void;
  onSend: (message: string) => Promise<void>;
}) {
  const employee = question.employee;
  const avatar = employee.id
    ? employeeAvatarUrl(company.id, employee.id, employee.avatarKey)
    : null;

  // The card's own content is its first answer; everything after it is the
  // conversation, which stays folded until somebody chooses to have one.
  const answer = question.messages.find((m) => m.role === "assistant") ?? null;
  const thread = question.messages.filter((m) => m.id !== answer?.id);
  const threadWorking = thread.some((m) => m.status === "working");
  const [discussing, setDiscussing] = React.useState(false);
  // A running turn opens the thread whether or not this browser started it, so
  // the reply lands somewhere visible instead of behind a closed toggle.
  //
  // Latched, not derived: deriving it would snap the thread shut the instant
  // the reply finalized, taking the answer the Member was waiting for with it,
  // and would leave the toggle inert for as long as a turn was in flight.
  React.useEffect(() => {
    if (threadWorking) setDiscussing(true);
  }, [threadWorking]);

  const answering = answer?.status === "working";
  const answered = answer !== null && answer.status !== "working";
  const actions = visibleActions(question);
  const canReply = answered && item.employee.id !== null;
  const gated = actions.some((a) => a.kind === "routine") && !canDelegateAutomation;

  return (
    <article
      className={clsx(
        "overflow-hidden rounded-xl border bg-white transition-colors dark:bg-slate-950/60",
        question.origin === "standing"
          ? "border-slate-200 border-l-[3px] border-l-violet-400 dark:border-slate-800 dark:border-l-violet-500/60"
          : "border-slate-200 dark:border-slate-800",
      )}
    >
      <div className="flex items-start gap-2 px-3.5 pt-3">
        <div className="min-w-0 flex-1">
          <h4 className="text-[13px] font-semibold leading-5 text-slate-900 dark:text-slate-100">
            {question.prompt}
          </h4>
          <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] text-slate-500 dark:text-slate-400">
            <span>{employee.name || "AI Employee"}</span>
            {question.origin === "standing" && (
              <>
                <span aria-hidden="true">·</span>
                <span
                  className="inline-flex items-center gap-1 rounded-full bg-violet-50 px-1.5 py-0.5 font-medium text-violet-700 dark:bg-violet-500/10 dark:text-violet-300"
                  title="Asked automatically on every briefing. Change the list in TLDR settings."
                >
                  <Repeat size={9} /> Always asked
                </span>
              </>
            )}
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
          className="shrink-0 rounded-md p-1 text-slate-300 transition hover:bg-rose-50 hover:text-rose-600 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-slate-300 dark:text-slate-600 dark:hover:bg-rose-500/10 dark:hover:text-rose-300"
        >
          <Trash2 size={13} />
        </button>
      </div>

      <div className="px-3.5 pb-3 pt-2">
        {answering && !answer?.content && (
          <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
            <Spinner size={13} /> {employee.name || "The AI Employee"} is working on this…
          </div>
        )}

        {answer && answer.content && (
          <Answer message={answer} company={company} />
        )}

        {(actions.length > 0 || canReply) && (
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            {actions.map((action) => (
              <ActionButton
                key={action.id}
                action={action}
                busy={busy}
                onRun={() => onRunAction(action)}
                onDismiss={() => onDismissAction(action)}
              />
            ))}
            {canReply && (
              <button
                type="button"
                onClick={() => setDiscussing((current) => !current)}
                aria-expanded={discussing}
                className={clsx(
                  "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[11px] font-medium transition",
                  discussing
                    ? "border-slate-300 bg-slate-100 text-slate-700 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200"
                    : "border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800",
                )}
              >
                <MessageSquare size={12} />
                {discussing ? "Hide discussion" : "Discuss"}
                {thread.length > 0 && (
                  <span className="tabular-nums text-slate-400 dark:text-slate-500">
                    {thread.filter((m) => m.role === "user").length}
                  </span>
                )}
              </button>
            )}
          </div>
        )}

        {gated && (
          <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-4 text-slate-400 dark:text-slate-500">
            <ShieldAlert size={12} className="mt-px shrink-0" />
            Scheduling or changing a Routine is an owner or admin action, so that button is theirs
            to press.
          </p>
        )}

        {discussing && (
          <div className="mt-3 border-t border-slate-100 pt-3 dark:border-slate-800">
            {thread.length > 0 && (
              <div className="space-y-2.5">
                {thread.map((message) => (
                  <Bubble
                    key={message.id}
                    company={company}
                    message={message}
                    employeeName={employee.name}
                    avatar={avatar}
                  />
                ))}
              </div>
            )}
            {canReply && (
              <>
                {!canDelegateAutomation && (
                  <p className="mt-2.5 flex items-start gap-1.5 text-[11px] leading-4 text-slate-400 dark:text-slate-500">
                    <ShieldAlert size={12} className="mt-px shrink-0" />
                    Scheduling or changing a Routine is an owner or admin action.{" "}
                    {employee.name || "The AI Employee"} can write the proposal here, but cannot
                    make the change for you.
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
          </div>
        )}
      </div>
    </article>
  );
}

/**
 * One suggested action.
 *
 * Four states, and each one has to read as itself at a glance: offered,
 * offered-but-not-yours, running, and done. A done action stops being a button
 * — nothing good comes of a card where "Pause the nightly scrape" still looks
 * pressable after somebody paused it.
 */
function ActionButton({
  action,
  busy,
  onRun,
  onDismiss,
}: {
  action: TldrSuggestedAction;
  busy: boolean;
  onRun: () => void;
  onDismiss: () => void;
}) {
  const Icon = ACTION_ICONS[action.kind] ?? Zap;

  if (action.status === "done") {
    return (
      <span
        className="inline-flex h-7 items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 text-[11px] font-medium text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300"
        title={action.intent}
      >
        <CheckCircle2 size={12} /> {action.label}
      </span>
    );
  }

  if (action.status === "running") {
    return (
      <span className="inline-flex h-7 items-center gap-1.5 rounded-full border border-violet-200 bg-violet-50 px-2.5 text-[11px] font-medium text-violet-700 dark:border-violet-500/30 dark:bg-violet-500/10 dark:text-violet-300">
        <Spinner size={11} /> {action.label}
      </span>
    );
  }

  const blocked = !action.runnable;
  // The dismiss control is dimmed rather than hidden: a hover-only affordance
  // does not exist on a touch screen, and clearing a suggestion nobody wants
  // is not a power feature — it is how the card stays worth reading.
  return (
    <span className="group/action inline-flex items-center">
      <button
        type="button"
        onClick={onRun}
        disabled={busy || blocked}
        title={
          blocked
            ? `${action.intent} — an owner or admin has to press this.`
            : action.intent
        }
        className={clsx(
          "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[11px] font-medium transition",
          blocked
            ? "cursor-not-allowed border-slate-200 bg-slate-50 text-slate-400 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-600"
            : "border-violet-200 bg-violet-50 text-violet-700 hover:border-violet-300 hover:bg-violet-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-violet-500/30 dark:bg-violet-500/10 dark:text-violet-300 dark:hover:bg-violet-500/20",
        )}
      >
        {blocked ? <Lock size={11} /> : <Icon size={12} />}
        {action.label}
      </button>
      <button
        type="button"
        onClick={onDismiss}
        aria-label={`Dismiss the suggestion “${action.label}”`}
        title="Not worth doing — clear this suggestion"
        className="ml-0.5 rounded-full p-0.5 text-slate-300 opacity-60 transition hover:bg-slate-100 hover:text-slate-500 hover:opacity-100 focus:opacity-100 group-hover/action:opacity-100 dark:text-slate-600 dark:hover:bg-slate-800 dark:hover:text-slate-400"
      >
        <X size={11} />
      </button>
    </span>
  );
}

/** The card's headline answer: no avatar, no bubble — it is the card's body. */
function Answer({
  message,
  company,
}: {
  message: TldrQuestionMessage;
  company: Pick<Company, "id" | "slug">;
}) {
  const failed = message.status === "error" || message.status === "skipped";
  if (failed) {
    return (
      <p className="whitespace-pre-wrap rounded-lg bg-rose-50 px-3 py-2 text-[13px] leading-6 text-rose-900 dark:bg-rose-500/10 dark:text-rose-200">
        {message.content}
      </p>
    );
  }
  return (
    <div className="text-[13px] leading-6 text-slate-700 dark:text-slate-300">
      <ChatMarkdown content={message.content} />
      {message.status === "working" && (
        <span
          aria-hidden="true"
          className="ml-0.5 inline-block h-3.5 w-[2px] animate-pulse bg-slate-400 align-middle"
        />
      )}
      <ActionPills message={message} company={company} />
    </div>
  );
}

function ActionPills({
  message,
  company,
}: {
  message: TldrQuestionMessage;
  company: Pick<Company, "id" | "slug">;
}) {
  if (message.actions.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {message.actions.map((action, index) => (
        <span
          key={`${action.action}-${action.targetId ?? index}`}
          className="inline-flex items-center gap-1 rounded-md bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300"
          title={`${action.action} · ${company.slug}`}
        >
          <Check size={9} />
          {action.targetLabel || action.action}
        </span>
      ))}
    </div>
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
      <div
        className={clsx(
          "ml-6 rounded-lg px-3 py-2 text-[13px] leading-6",
          // A pressed button reads as a request, because it was one — but it
          // says so, rather than looking like something somebody typed out.
          message.actionId
            ? "border border-violet-200 bg-violet-50 text-violet-900 dark:border-violet-500/25 dark:bg-violet-500/10 dark:text-violet-100"
            : "bg-indigo-50 text-indigo-900 dark:bg-indigo-500/10 dark:text-indigo-100",
        )}
      >
        {message.actionId && (
          <div className="mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-violet-600 dark:text-violet-300">
            <Zap size={10} /> Requested with one click
          </div>
        )}
        <span className="whitespace-pre-wrap">{message.content}</span>
      </div>
    );
  }

  // A `working` row with text in it is a live stream; with none it is the
  // spinner the card renders separately.
  if (message.status === "working" && !message.content) {
    return (
      <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
        <Spinner size={13} /> {employeeName || "The AI Employee"} is working…
      </div>
    );
  }

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
          "min-w-0 flex-1 rounded-lg px-3 py-2 text-[13px] leading-6",
          failed
            ? "bg-rose-50 text-rose-900 dark:bg-rose-500/10 dark:text-rose-200"
            : "bg-slate-50 text-slate-700 dark:bg-slate-900 dark:text-slate-300",
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
        <ActionPills message={message} company={company} />
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
    <div className="mt-2 rounded-lg border border-slate-200 bg-white focus-within:border-violet-300 dark:border-slate-700 dark:bg-slate-950 dark:focus-within:border-violet-500/40">
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
