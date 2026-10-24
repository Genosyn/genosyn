import React from "react";
import { CheckCircle2, Info, MessagesSquare, Play, Square } from "lucide-react";

import { ChatAuthorAvatar, MessageBody } from "@/components/workspace/MessageList";
import { Button } from "@/components/ui/Button";
import { FormError } from "@/components/ui/FormError";
import type { Company } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import {
  actionItemOwnerLabel,
  actionItemStatusLabel,
  canFinish,
  canStartWork,
  canStop,
  discussionStatusLine,
  endReasonLabel,
  participantStateLabel,
  usageLabel,
} from "@/lib/groupDiscussions";
import {
  workspaceApi,
  type DiscussionParticipantState,
  type GroupDiscussion,
  type Mentionable,
  type WorkspaceMessage,
} from "@/lib/workspace";

/**
 * What a Member sees of a group discussion: a live bar above the composer
 * while it runs — who is thinking, which round, how much it has spent, and
 * Stop and Wrap up — and, when it ends, the outcome as a card in the
 * transcript with "Start the work". Status text comes from
 * `lib/groupDiscussions.ts`, so what the bar says is unit-tested.
 */

const STATE_RING: Record<DiscussionParticipantState, string> = {
  speaking: "ring-2 ring-indigo-500 motion-safe:animate-pulse",
  writing: "ring-2 ring-amber-400 motion-safe:animate-pulse",
  spoke: "ring-2 ring-emerald-400",
  passed: "opacity-50",
  skipped: "opacity-40 grayscale",
  benched: "opacity-30 grayscale",
  waiting: "",
};

function ParticipantChip({
  participant,
  lead,
}: {
  participant: GroupDiscussion["participants"][number];
  lead: boolean;
}) {
  const label = `${participant.name} — ${participantStateLabel(participant.state)}${lead ? " (leads)" : ""}`;
  return (
    <li
      className="flex items-center gap-1.5"
      title={label}
      aria-label={label}
      data-participant-state={participant.state}
    >
      <span
        className={
          "flex h-6 w-6 items-center justify-center rounded-full bg-indigo-100 text-[10px] font-semibold text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-200 " +
          STATE_RING[participant.state]
        }
        aria-hidden="true"
      >
        {initialsOf(participant.name)}
      </span>
      <span
        className={
          "hidden text-xs sm:inline " +
          (participant.state === "speaking" || participant.state === "writing"
            ? "font-medium text-slate-900 dark:text-slate-100"
            : "text-slate-500 dark:text-slate-400")
        }
      >
        {participant.name}
      </span>
    </li>
  );
}

/** The live bar shown above the composer while a discussion runs. */
export function DiscussionBar({
  company,
  discussion,
  onChanged,
}: {
  company: Company;
  discussion: GroupDiscussion;
  onChanged: (next: GroupDiscussion) => void;
}) {
  const [pending, setPending] = React.useState<null | "stop" | "finish">(null);
  const [error, setError] = React.useState<string | null>(null);

  async function act(kind: "stop" | "finish") {
    setPending(kind);
    setError(null);
    try {
      const next =
        kind === "stop"
          ? await workspaceApi.stopDiscussion(company.id, discussion.id)
          : await workspaceApi.finishDiscussion(company.id, discussion.id);
      onChanged(next);
    } catch (e) {
      setError(errorMessage(e, kind === "stop" ? "Could not stop it" : "Could not wrap it up"));
    } finally {
      setPending(null);
    }
  }

  const wrappingUp = Boolean(discussion.phase === "discussing" && pending === "finish");
  return (
    <section
      aria-label="Group discussion"
      aria-live="polite"
      className="shrink-0 border-t border-indigo-100 bg-indigo-50/60 px-4 py-2 sm:px-6 dark:border-indigo-500/20 dark:bg-indigo-500/5"
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <ul className="flex items-center gap-2" aria-label="Taking part">
          {discussion.participants.map((p) => (
            <ParticipantChip key={p.id} participant={p} lead={p.id === discussion.leadEmployeeId} />
          ))}
        </ul>
        <div className="min-w-0 flex-1">
          <div
            className="flex items-center gap-1.5 truncate text-sm font-medium text-indigo-900 dark:text-indigo-100"
            role="status"
          >
            <MessagesSquare size={14} className="shrink-0" />
            <span className="truncate">{discussionStatusLine(discussion)}</span>
          </div>
          <div className="text-[11px] tabular-nums text-indigo-700/80 dark:text-indigo-300/80">
            {usageLabel(discussion)}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {canFinish(discussion) && (
            <Button
              size="sm"
              variant="secondary"
              loading={wrappingUp}
              disabled={pending !== null}
              onClick={() => void act("finish")}
              title="End the rounds after this turn and write the outcome now"
            >
              <CheckCircle2 size={14} />
              Wrap up
            </Button>
          )}
          {canStop(discussion) && (
            <Button
              size="sm"
              variant="danger"
              loading={pending === "stop"}
              disabled={pending !== null}
              onClick={() => void act("stop")}
              title="Stop now — no more turns, no outcome"
            >
              <Square size={12} />
              Stop
            </Button>
          )}
        </div>
      </div>
      <FormError message={error} className="mt-2" />
    </section>
  );
}

/** The outcome, rendered in place of the outcome message. */
export function DiscussionOutcomeCard({
  company,
  message,
  discussion,
  mentionables,
  onChanged,
}: {
  company: Company;
  message: WorkspaceMessage;
  discussion: GroupDiscussion;
  mentionables: Mentionable[];
  onChanged: (next: GroupDiscussion) => void;
}) {
  const [starting, setStarting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const outcome = discussion.outcome;
  if (!outcome) return null;
  const writer = discussion.participants.find((p) => p.id === outcome.writtenByEmployeeId);

  async function startWork() {
    setStarting(true);
    setError(null);
    try {
      onChanged(await workspaceApi.startDiscussionWork(company.id, discussion.id));
    } catch (e) {
      setError(errorMessage(e, "Could not start the work"));
    } finally {
      setStarting(false);
    }
  }

  return (
    <article
      className="mt-3 flex gap-3 rounded-md px-2 py-1"
      aria-label="Discussion outcome"
      data-discussion-outcome={discussion.id}
    >
      <div className="w-10 shrink-0">
        <ChatAuthorAvatar author={message.author} />
      </div>
      <div className="min-w-0 flex-1 rounded-xl border border-emerald-200 bg-white p-4 shadow-sm dark:border-emerald-500/30 dark:bg-slate-900">
        <header className="mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="inline-flex items-center gap-1 text-sm font-semibold text-emerald-800 dark:text-emerald-200">
            <CheckCircle2 size={14} /> Outcome
          </span>
          <span className="text-xs text-slate-500 dark:text-slate-400">
            {writer ? `Written by ${writer.name}` : "Written by the lead"} ·{" "}
            {endReasonLabel(discussion.endReason)} · {discussion.turnsTaken} turn
            {discussion.turnsTaken === 1 ? "" : "s"}
          </span>
        </header>
        <MessageBody content={outcome.summary} mentionables={mentionables} />

        <h4 className="text-xs font-medium mt-3 text-slate-500 dark:text-slate-400">
          Recommendation
        </h4>
        <MessageBody content={outcome.recommendation} mentionables={mentionables} />

        {outcome.openQuestions.length > 0 && (
          <>
            <h4 className="text-xs font-medium mt-3 text-slate-500 dark:text-slate-400">
              Open questions
            </h4>
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-slate-700 dark:text-slate-200">
              {outcome.openQuestions.map((q) => (
                <li key={q}>{q}</li>
              ))}
            </ul>
          </>
        )}

        {outcome.actionItems.length > 0 && (
          <>
            <h4 className="text-xs font-medium mt-3 text-slate-500 dark:text-slate-400">
              Who does what
            </h4>
            <ul className="mt-1 space-y-1" aria-label="Who does what">
              {outcome.actionItems.map((item, index) => {
                const status = actionItemStatusLabel(item.status);
                return (
                  <li
                    key={`${item.ownerLabel}-${index}`}
                    className="flex flex-wrap items-start gap-2 text-sm text-slate-700 dark:text-slate-200"
                  >
                    <span
                      className={
                        "shrink-0 rounded px-1.5 py-0.5 text-xs font-medium " +
                        (item.owner?.kind === "ai"
                          ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300"
                          : item.owner?.kind === "user"
                            ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300"
                            : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300")
                      }
                    >
                      {actionItemOwnerLabel(item)}
                    </span>
                    <span className="min-w-0 flex-1">{item.action}</span>
                    {status && (
                      <span
                        className={
                          "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium " +
                          (item.status === "done"
                            ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-200"
                            : item.status === "failed"
                              ? "bg-red-100 text-red-800 dark:bg-red-500/15 dark:text-red-200"
                              : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300")
                        }
                        title={item.detail}
                      >
                        {status}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        )}

        <footer className="mt-4 flex flex-wrap items-center gap-3">
          {canStartWork(discussion) && (
            <Button size="sm" loading={starting} onClick={() => void startWork()}>
              <Play size={14} />
              Start the work
            </Button>
          )}
          <span className="text-xs text-slate-500 dark:text-slate-400">
            {discussion.followThrough
              ? "The work has started — each AI Employee reports back here."
              : "Reply to keep discussing."}
          </span>
        </footer>
        <FormError message={error} className="mt-2" />
      </div>
    </article>
  );
}

/** A discussion's quiet system line: someone joined, sat out, or it stopped. */
export function DiscussionNote({ message }: { message: WorkspaceMessage }) {
  return (
    <div
      className="my-2 flex items-start justify-center gap-1.5 px-6 text-center text-xs text-slate-500 dark:text-slate-400"
      role="note"
    >
      <Info size={12} className="mt-0.5 shrink-0" />
      <span>{message.content}</span>
    </div>
  );
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
