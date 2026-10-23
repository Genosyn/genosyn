import React from "react";
import { Bot, Check, Search, User as UserIcon, Users } from "lucide-react";

import { Button } from "@/components/ui/Button";
import { Disclosure } from "@/components/ui/Disclosure";
import { FormError } from "@/components/ui/FormError";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Select";
import { Spinner } from "@/components/ui/Spinner";
import { Textarea } from "@/components/ui/Textarea";
import type { Company } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import {
  GROUP_CHAT_LIMITS,
  groupChatDraftProblem,
  suggestGroupChatName,
  togglePick,
} from "@/lib/groupDiscussions";
import {
  workspaceApi,
  type GroupDiscussion,
  type WorkspaceChannel,
  type WorkspaceDirectory,
} from "@/lib/workspace";

/**
 * Start a group chat — or a discussion in a channel you are already in.
 *
 * The basics are who and what: the AI Employees to work it out (the first
 * picked leads and writes the outcome) and the question. Everything else —
 * a name, other Members, how many rounds — sits behind one Advanced
 * disclosure with sensible defaults, and its summary says what is set.
 *
 * Opened from the Workspace sidebar, the Workspace's empty state, a channel's
 * Discuss button and an AI Employee's own page, which pre-picks them.
 */

export type StartGroupChatMode =
  | { kind: "new" }
  | {
      kind: "channel";
      channelId: string;
      /** "#general" — named in the title. */
      channelLabel: string;
      /** AI Employees already in the channel, offered first. */
      memberEmployeeIds: string[];
    };

export type GroupChatStarted = {
  channelId: string;
  channel: WorkspaceChannel | null;
  discussion: GroupDiscussion | null;
};

export function StartGroupChatModal({
  open,
  onClose,
  company,
  meId,
  mode,
  directory: directoryProp,
  initialEmployeeIds = [],
  onStarted,
}: {
  open: boolean;
  onClose: () => void;
  company: Company;
  meId: string;
  mode: StartGroupChatMode;
  /** The company directory, when the page already has it; fetched otherwise. */
  directory?: WorkspaceDirectory | null;
  initialEmployeeIds?: string[];
  onStarted: (started: GroupChatStarted) => void;
}) {
  const [directory, setDirectory] = React.useState<WorkspaceDirectory | null>(directoryProp ?? null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [picked, setPicked] = React.useState<string[]>([]);
  const [members, setMembers] = React.useState<string[]>([]);
  const [question, setQuestion] = React.useState("");
  const [name, setName] = React.useState("");
  const [rounds, setRounds] = React.useState<number>(GROUP_CHAT_LIMITS.defaultRounds);
  const [search, setSearch] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [attempted, setAttempted] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const inChannel = mode.kind === "channel";

  // Reset on every open, seeding the roster from the page that opened it.
  const seed = inChannel ? mode.memberEmployeeIds.join(",") : initialEmployeeIds.join(",");
  React.useEffect(() => {
    if (!open) return;
    setPicked(seed ? seed.split(",").slice(0, GROUP_CHAT_LIMITS.maxEmployees) : []);
    setMembers([]);
    setQuestion("");
    setName("");
    setRounds(GROUP_CHAT_LIMITS.defaultRounds);
    setSearch("");
    setAttempted(false);
    setError(null);
  }, [open, seed]);

  React.useEffect(() => {
    if (directoryProp) setDirectory(directoryProp);
  }, [directoryProp]);

  React.useEffect(() => {
    if (!open || directoryProp || directory) return;
    let cancelled = false;
    setLoadError(null);
    workspaceApi
      .directory(company.id)
      .then((dir) => {
        if (!cancelled) setDirectory(dir);
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoadError(errorMessage(e, "Could not load who works here"));
      });
    return () => {
      cancelled = true;
    };
  }, [open, directoryProp, directory, company.id]);

  const employees = directory?.employees ?? [];
  const people = (directory?.members ?? []).filter((m) => m.id !== meId);
  const q = search.trim().toLowerCase();
  const shown = employees.filter(
    (e) =>
      !q ||
      e.name.toLowerCase().includes(q) ||
      e.slug.toLowerCase().includes(q) ||
      e.role.toLowerCase().includes(q),
  );
  const pickedEmployees = picked
    .map((id) => employees.find((e) => e.id === id))
    .filter((e): e is NonNullable<typeof e> => Boolean(e));

  const problem = groupChatDraftProblem({
    employeeIds: picked,
    question,
    name,
    questionRequired: inChannel,
  });
  const advancedSummary = [
    `${rounds} round${rounds === 1 ? "" : "s"}`,
    ...(inChannel
      ? []
      : [
          name.trim() ? `named “${name.trim()}”` : "named after the question",
          members.length === 0
            ? "no other Members"
            : `${members.length} other Member${members.length === 1 ? "" : "s"}`,
        ]),
  ].join(" · ");

  async function submit(event?: React.FormEvent) {
    event?.preventDefault();
    if (submitting) return;
    setAttempted(true);
    if (problem) return;
    setSubmitting(true);
    setError(null);
    try {
      if (mode.kind === "channel") {
        const discussion = await workspaceApi.startDiscussion(company.id, mode.channelId, {
          question: question.trim(),
          employeeIds: picked,
          maxRounds: rounds,
        });
        onStarted({ channelId: mode.channelId, channel: null, discussion });
      } else {
        const result = await workspaceApi.createGroupChat(company.id, {
          employeeIds: picked,
          memberUserIds: members,
          ...(name.trim() ? { name: name.trim() } : {}),
          ...(question.trim() ? { question: question.trim() } : {}),
          maxRounds: rounds,
        });
        onStarted({
          channelId: result.channel.id,
          channel: result.channel,
          discussion: result.discussion,
        });
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSubmitting(false);
    }
  }

  const submitLabel = inChannel
    ? "Start discussion"
    : question.trim()
      ? "Start discussion"
      : "Open group chat";

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={inChannel ? `Discuss in ${mode.channelLabel}` : "Start a group chat"}
      description={
        inChannel
          ? "The AI Employees you pick talk it through here in rounds, then come back with an outcome."
          : "Pick AI Employees to work something out together. They talk it through in rounds, then come back to you with an outcome."
      }
      onSubmit={submit}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={submitting} disabled={attempted && Boolean(problem)}>
            <Users size={14} />
            {submitLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <section aria-labelledby="group-chat-employees" className="space-y-2">
          <div className="flex items-baseline justify-between gap-2">
            <h3
              id="group-chat-employees"
              className="text-sm font-medium text-slate-700 dark:text-slate-300"
            >
              AI Employees
            </h3>
            <span className="text-xs tabular-nums text-slate-500 dark:text-slate-400">
              {picked.length} of {GROUP_CHAT_LIMITS.maxEmployees}
            </span>
          </div>
          {pickedEmployees.length > 0 && (
            <ol className="flex flex-wrap gap-1.5" aria-label="Taking part, in speaking order">
              {pickedEmployees.map((e, index) => (
                <li
                  key={e.id}
                  className="inline-flex items-center gap-1 rounded-full border border-indigo-200 bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-700 dark:border-indigo-500/40 dark:bg-indigo-500/10 dark:text-indigo-200"
                >
                  <Bot size={12} />
                  {e.name}
                  {index === 0 && (
                    <span className="rounded bg-indigo-600 px-1 text-[10px] font-semibold uppercase tracking-wide text-white dark:bg-indigo-500">
                      Leads
                    </span>
                  )}
                </li>
              ))}
            </ol>
          )}
          <label className="relative block">
            <span className="sr-only">Search AI Employees</span>
            <Search
              size={14}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
            />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name or role"
              className="w-full rounded-lg border border-slate-200 bg-white py-2 pl-8 pr-3 text-sm outline-none focus:border-indigo-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
            />
          </label>
          <FormError message={loadError} />
          {!directory && !loadError ? (
            <div className="flex items-center gap-2 py-3 text-sm text-slate-500" role="status">
              <Spinner size={14} /> Loading AI Employees…
            </div>
          ) : (
            <ul
              className="max-h-56 space-y-0.5 overflow-y-auto rounded-lg border border-slate-200 p-1 dark:border-slate-700"
              aria-label="AI Employees"
            >
              {shown.map((e) => {
                const on = picked.includes(e.id);
                const full = !on && picked.length >= GROUP_CHAT_LIMITS.maxEmployees;
                return (
                  <li key={e.id}>
                    <button
                      type="button"
                      aria-pressed={on}
                      disabled={full}
                      onClick={() => setPicked((prev) => togglePick(prev, e.id))}
                      className={
                        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm disabled:cursor-not-allowed disabled:opacity-50 " +
                        (on
                          ? "bg-indigo-50 text-indigo-800 dark:bg-indigo-500/10 dark:text-indigo-200"
                          : "text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800")
                      }
                    >
                      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-indigo-100 text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-300">
                        <Bot size={12} />
                      </span>
                      <span className="min-w-0 flex-1 truncate">
                        <span className="font-medium">{e.name}</span>{" "}
                        <span className="ml-1 text-xs text-slate-500 dark:text-slate-400">
                          {e.role}
                        </span>
                      </span>
                      {on && <Check size={14} className="shrink-0 text-indigo-600" />}
                    </button>
                  </li>
                );
              })}
              {shown.length === 0 && (
                <li className="px-2 py-4 text-center text-sm text-slate-500">
                  {employees.length === 0 ? "No AI Employees yet." : "No matches."}
                </li>
              )}
            </ul>
          )}
        </section>

        <Textarea
          label={inChannel ? "What should they discuss?" : "What should they work out?"}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
          rows={4}
          className="min-h-[96px]"
          maxLength={GROUP_CHAT_LIMITS.maxQuestionChars}
          placeholder="Should we raise the Pro plan to $49? Weigh churn against margin and tell me what to do."
          hint={
            inChannel
              ? "Each one reads what the others say and answers in turn; the lead writes the outcome."
              : "Optional — leave it empty to open the chat and ask later. Each one reads what the others say; the lead writes the outcome."
          }
        />

        <Disclosure title="Advanced" summary={advancedSummary}>
          <div className="space-y-4 pt-3">
            {!inChannel && (
              <Input
                label="Name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={GROUP_CHAT_LIMITS.maxNameChars}
                placeholder={suggestGroupChatName(question) || "Named after the people in it"}
              />
            )}
            <div className="flex flex-col gap-1">
              <Select
                id="group-chat-rounds"
                label="Rounds"
                value={String(rounds)}
                onChange={(e) => setRounds(Number(e.target.value))}
                containerClassName="w-40"
              >
                {Array.from({ length: GROUP_CHAT_LIMITS.maxRounds }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>
                    {n} round{n === 1 ? "" : "s"}
                  </option>
                ))}
              </Select>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Each round, everyone speaks once or passes. It ends early when a round adds
                nothing new.
              </p>
            </div>
            {!inChannel && people.length > 0 && (
              <div className="space-y-1">
                <div className="text-sm font-medium text-slate-700 dark:text-slate-300">
                  Other Members
                </div>
                <ul className="flex flex-wrap gap-1.5" aria-label="Other Members">
                  {people.map((p) => {
                    const on = members.includes(p.id);
                    return (
                      <li key={p.id}>
                        <button
                          type="button"
                          aria-pressed={on}
                          onClick={() => setMembers((prev) => togglePick(prev, p.id))}
                          className={
                            "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs " +
                            (on
                              ? "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-200"
                              : "border-slate-200 text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800")
                          }
                        >
                          <UserIcon size={12} />
                          {p.name}
                          {on && <Check size={12} />}
                        </button>
                      </li>
                    );
                  })}
                </ul>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  They can read the chat and add to it. The AI Employees answer with your access.
                </p>
              </div>
            )}
          </div>
        </Disclosure>

        <FormError message={error ?? (attempted ? problem : null)} />
      </div>
    </Modal>
  );
}
