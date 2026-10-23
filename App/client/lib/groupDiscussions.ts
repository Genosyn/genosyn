import type {
  DiscussionActionItem,
  DiscussionParticipantState,
  GroupDiscussion,
  GroupDiscussionEndReason,
  WorkspaceChannel,
} from "./workspace";

/**
 * The client half of group discussions: what the status bar says, which
 * discussion a socket frame updates, who leads, what a group chat is called,
 * and whether a draft is ready to send. Pure list and string arithmetic, kept
 * out of the components so it is unit-tested without a DOM
 * (`groupDiscussions.test.ts`), like `workspaceMessages.ts` beside it.
 */

/** Mirrors `GROUP_DISCUSSION_LIMITS` on the server; the API enforces them. */
export const GROUP_CHAT_LIMITS = {
  minEmployees: 2,
  maxEmployees: 6,
  maxQuestionChars: 8_000,
  maxNameChars: 80,
  defaultRounds: 3,
  maxRounds: 5,
} as const;

/**
 * Fold one discussion into a channel's list, newest first. A frame older than
 * the copy already held is ignored: frames can overtake each other, and a
 * stale "running" must never paint over a discussion that already ended.
 */
export function mergeDiscussion(list: GroupDiscussion[], next: GroupDiscussion): GroupDiscussion[] {
  const index = list.findIndex((d) => d.id === next.id);
  if (index >= 0) {
    const current = list[index];
    if (Date.parse(next.updatedAt) < Date.parse(current.updatedAt)) return list;
    if (current.status !== "running" && next.status === "running") return list;
    const copy = list.slice();
    copy[index] = next;
    return copy;
  }
  return [next, ...list].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

/** The discussion still running in a channel, if any. There is at most one. */
export function runningDiscussion(list: GroupDiscussion[]): GroupDiscussion | null {
  return list.find((d) => d.status === "running") ?? null;
}

/** Outcome messages render as cards; this finds each one's discussion. */
export function discussionsByOutcomeMessage(list: GroupDiscussion[]): Map<string, GroupDiscussion> {
  const map = new Map<string, GroupDiscussion>();
  for (const d of list) if (d.outcomeMessageId) map.set(d.outcomeMessageId, d);
  return map;
}

export function endReasonLabel(reason: GroupDiscussionEndReason | null): string {
  switch (reason) {
    case "converged":
      return "everyone agreed";
    case "max_rounds":
      return "used every round";
    case "turn_budget":
      return "reached its turn limit";
    case "usage_budget":
      return "reached its usage budget";
    case "time_limit":
      return "reached its time limit";
    case "repetition":
      return "they began repeating each other";
    case "wrapped_up":
      return "wrapped up early";
    case "stopped":
      return "stopped";
    case "standdown":
      return "stood down";
    case "access_changed":
      return "access changed";
    case "channel_archived":
      return "conversation archived";
    case "no_participants":
      return "nobody could take part";
    case "restart":
      return "interrupted by a restart";
    case "error":
      return "something went wrong";
    default:
      return "ended";
  }
}

function nameOf(d: GroupDiscussion, employeeId: string | null): string | null {
  if (!employeeId) return null;
  return d.participants.find((p) => p.id === employeeId)?.name ?? null;
}

/** The one line the status bar shows. */
export function discussionStatusLine(d: GroupDiscussion): string {
  if (d.status === "running") {
    if (d.phase === "concluding") {
      const writer = nameOf(d, d.currentEmployeeId);
      return writer ? `${writer} is writing the outcome…` : "Writing the outcome…";
    }
    const round = Math.max(1, d.round);
    const speaker = nameOf(d, d.currentEmployeeId);
    return speaker
      ? `Discussing · round ${round} of ${d.rounds} · ${speaker} is thinking…`
      : `Discussing · round ${round} of ${d.rounds}`;
  }
  if (d.status === "concluded") return `Concluded · ${endReasonLabel(d.endReason)}`;
  if (d.status === "stopped") return d.endDetail || "Stopped";
  if (d.status === "failed") return d.endDetail || "Ended without an outcome";
  return d.endDetail || "Interrupted by a restart";
}

export function participantStateLabel(state: DiscussionParticipantState): string {
  switch (state) {
    case "speaking":
      return "thinking";
    case "writing":
      return "writing the outcome";
    case "spoke":
      return "spoke this round";
    case "passed":
      return "nothing to add";
    case "skipped":
      return "sat this round out";
    case "benched":
      return "can't take part";
    default:
      return "waiting";
  }
}

/** Wrap up now: only while turns are being taken, not once the outcome is being written. */
export function canFinish(d: GroupDiscussion): boolean {
  return d.status === "running" && d.phase === "discussing";
}

export function canStop(d: GroupDiscussion): boolean {
  return d.status === "running";
}

/** Action items an AI Employee in the discussion can be asked to start. */
export function assignableItems(d: GroupDiscussion): DiscussionActionItem[] {
  if (!d.outcome) return [];
  const inside = new Set(d.participants.map((p) => p.id));
  return d.outcome.actionItems.filter((i) => i.owner?.kind === "ai" && inside.has(i.owner.id));
}

export function canStartWork(d: GroupDiscussion): boolean {
  return d.status === "concluded" && !d.followThrough && assignableItems(d).length > 0;
}

export function actionItemOwnerLabel(item: DiscussionActionItem): string {
  if (item.owner?.kind === "ai") return item.owner.name;
  if (item.owner?.kind === "user") return item.owner.name;
  return item.ownerLabel.replace(/^@/, "");
}

export function actionItemStatusLabel(status: DiscussionActionItem["status"]): string | null {
  switch (status) {
    case "queued":
      return "Queued";
    case "working":
      return "Working";
    case "done":
      return "Done";
    case "failed":
      return "Couldn't finish";
    case "skipped":
      return "Skipped";
    default:
      return null;
  }
}

/** "Turn 4 of 12 · 210k tokens" — the cost guard, made visible. */
export function usageLabel(d: Pick<GroupDiscussion, "turnsTaken" | "maxTurns" | "tokensUsed">): string {
  const turns = `Turn ${Math.min(d.turnsTaken + 1, d.maxTurns)} of ${d.maxTurns}`;
  if (d.tokensUsed <= 0) return turns;
  return `${turns} · ${formatTokens(d.tokensUsed)} tokens`;
}

export function formatTokens(n: number): string {
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${Math.round(n / 1_000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/**
 * What a group chat is called: its name, or the people in it other than you,
 * AI Employees first since they are why it exists.
 */
export function groupChatTitle(
  channel: Pick<WorkspaceChannel, "name" | "members">,
  meId: string,
): string {
  if (channel.name?.trim()) return channel.name.trim();
  const others = channel.members.filter((m) => !(m.kind === "user" && m.id === meId));
  const ordered = [...others.filter((m) => m.kind === "ai"), ...others.filter((m) => m.kind !== "ai")];
  const names = ordered.map((m) => m.name).filter(Boolean);
  if (names.length === 0) return "Group chat";
  if (names.length <= 3) return names.join(", ");
  return `${names.slice(0, 3).join(", ")} +${names.length - 3}`;
}

/** The name a group chat would get from its question. Mirrors the server. */
export function suggestGroupChatName(question: string): string {
  const firstLine = question
    .split("\n")
    .map((line) => line.replace(/[#*_`>]/g, "").trim())
    .find(Boolean);
  if (!firstLine) return "";
  const oneLine = firstLine.replace(/\s+/g, " ");
  if (oneLine.length <= 60) return oneLine;
  const cut = oneLine.slice(0, 60);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 30 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * Toggle an AI Employee in the roster. Order is kept as picked, because the
 * first one picked leads the discussion and writes its outcome.
 */
export function togglePick(picked: string[], id: string): string[] {
  return picked.includes(id) ? picked.filter((p) => p !== id) : [...picked, id];
}

export type GroupChatDraft = {
  employeeIds: string[];
  question: string;
  name: string;
  /** Starting a discussion in an existing channel needs a question. */
  questionRequired: boolean;
};

/** Why a draft cannot be sent yet, or null when it can. */
export function groupChatDraftProblem(draft: GroupChatDraft): string | null {
  if (draft.employeeIds.length < GROUP_CHAT_LIMITS.minEmployees) {
    return `Choose at least ${GROUP_CHAT_LIMITS.minEmployees} AI Employees.`;
  }
  if (draft.employeeIds.length > GROUP_CHAT_LIMITS.maxEmployees) {
    return `Choose at most ${GROUP_CHAT_LIMITS.maxEmployees} AI Employees.`;
  }
  if (draft.questionRequired && !draft.question.trim()) {
    return "Say what they should work out.";
  }
  if (draft.question.length > GROUP_CHAT_LIMITS.maxQuestionChars) {
    return `Keep the question under ${GROUP_CHAT_LIMITS.maxQuestionChars.toLocaleString("en-US")} characters.`;
  }
  if (draft.name.trim().length > GROUP_CHAT_LIMITS.maxNameChars) {
    return `Keep the name under ${GROUP_CHAT_LIMITS.maxNameChars} characters.`;
  }
  return null;
}

/** "Ada", "Ada and Ben", "Ada, Ben and Cy", "Ada, Ben and 3 others". */
export function listNames(names: string[]): string {
  if (names.length <= 1) return names.join("");
  if (names.length <= 3) return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `${names.slice(0, 2).join(", ")} and ${names.length - 2} others`;
}

/**
 * What the composer invites, given the room and what is happening in it.
 * Null keeps the composer's own "Message …".
 */
export function composerPlaceholder(
  kind: WorkspaceChannel["kind"],
  aiNames: string[],
  running: GroupDiscussion | null,
): string | null {
  if (running) return "Add to the discussion — @mention someone to bring them in";
  if (kind === "group" && aiNames.length > 0) {
    return `Ask ${listNames(aiNames)} to work something out`;
  }
  return null;
}
