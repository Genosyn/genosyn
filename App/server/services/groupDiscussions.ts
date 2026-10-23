import { randomUUID } from "node:crypto";
import { In, IsNull } from "typeorm";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Channel } from "../db/entities/Channel.js";
import { ChannelMember } from "../db/entities/ChannelMember.js";
import {
  ChannelMessage,
  type ChannelMessageDiscussionRole,
} from "../db/entities/ChannelMessage.js";
import { Company } from "../db/entities/Company.js";
import {
  GroupDiscussion,
  type GroupDiscussionEndReason,
  type GroupDiscussionPhase,
  type GroupDiscussionStatus,
} from "../db/entities/GroupDiscussion.js";
import { Membership } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import type { AgentTool, TurnUsage } from "./agent/types.js";
import { runRestrictedEmployeeAgent } from "./agent/runEmployee.js";
import {
  attachmentImageContextForMessages,
  historicalAttachmentSummaries,
  inlineAttachmentsForMessage,
} from "./attachmentText.js";
import { recordAudit } from "./audit.js";
import { streamChatWithEmployee, type ChatResult, type ChatTurn, type ChatOptions } from "./chat.js";
import { resolveChatModel } from "./models.js";
import { createNotifications } from "./notifications.js";
import { broadcastToCompany } from "./realtime.js";
import { workBlocked } from "./standdowns.js";
import {
  GROUP_DISCUSSION_LIMITS,
  benchParticipant,
  budgetStop,
  clampRounds,
  classifyMentions,
  completeRound,
  emptyDiscussionState,
  markInputSeen,
  maxTurnsFor,
  noteMemberInput,
  parseDiscussionState,
  parseParticipants,
  pickNextSpeaker,
  readTurn,
  recordTurn,
  type DiscussionState,
} from "./groupDiscussionPlan.js";
import {
  OUTCOME_TOOL_INPUT_SCHEMA,
  composeDiscussionBrief,
  composeFollowThroughBrief,
  composeOutcomeRequest,
  composeOutcomeSystemPrompt,
  composeTurnPrompt,
  describeEndReason,
  outcomeArgsSchema,
  renderOutcomeMarkdown,
  resolveOutcome,
  type DiscussionActionItem,
  type DiscussionOutcome,
  type PromptMember,
  type PromptPerson,
  type TranscriptLine,
} from "./groupDiscussionPrompts.js";
import {
  addChannelMembers,
  insertChannelMessage,
  startTypingBroadcast,
  userHasChannelAccess,
} from "./workspaceChat.js";

/**
 * Group discussions — several AI Employees working one Member's question out
 * together in a Workspace channel, and handing back one outcome.
 *
 * ## What happens
 *
 * A Member asks (in a group chat every Member message is a question to the
 * group; in any channel the Discuss button asks one explicitly). The AI
 * Employees then take turns in rounds: each reads everything said so far and
 * speaks for itself — its own Soul, Skills, Memory and Grants — building on,
 * challenging, or answering colleagues by `@handle`, or passing when it has
 * nothing to add. When a round adds nothing, or the rounds or a budget run
 * out, the lead writes the outcome — a summary, a recommendation, open
 * questions, and who will do what — in a restricted turn whose only tool
 * submits it. The Member gets a bell, reads the outcome card, and either
 * replies (which starts the next discussion, with this one in view) or
 * presses "Start the work".
 *
 * ## Why it is safe by construction
 *
 *  - **Talk only.** Every turn is a collaboration turn
 *    (`collaborationScope.ts`): read tools and nothing else, refused at the
 *    MCP seam too. No discussion can send, write, schedule, spend or delegate,
 *    so none is a path around an Approval, a Decision or a delivery limit.
 *  - **One authority.** Every turn runs under the Member who started it,
 *    intersected with the speaking employee's own Grants — re-checked before
 *    every turn. No employee borrows another's access, and a Member cannot
 *    reach through a group chat what they could not reach in a direct one.
 *  - **Bounded.** Rounds, a turn ceiling, a provider-reported usage budget and
 *    a wall clock (`GROUP_DISCUSSION_LIMITS`); passes, agreement and
 *    repetition end it early (`groupDiscussionPlan.ts`).
 *  - **Stoppable.** Stop aborts the turn in flight and ends it, from any
 *    replica (the driver polls its own row). A company Standdown ends it; an
 *    employee Standdown sits that employee out.
 *  - **Taint travels.** A turn that read a web page writes tainted messages;
 *    every later turn that replays one starts tainted, and so does the work a
 *    Member starts from the outcome — so its sinks still queue for review.
 *  - **The work is ordinary.** "Start the work" runs each owner's share as a
 *    normal chat turn under the pressing Member's authority: every gate a
 *    direct request meets, nothing more.
 *
 * The driver is in-process and single-writer: only it writes `stateJson`,
 * `participantsJson` and the counters, with targeted updates, so a Stop or a
 * Member's input landing mid-turn is never overwritten. Member input reaches
 * it as tagged messages it folds in on its next step. A restart leaves the
 * row `interrupted` (`sweepStaleGroupDiscussions`); writing again picks it up.
 */

// ───────────────────────────── DTOs ─────────────────────────────

export type DiscussionParticipantState =
  | "waiting"
  | "speaking"
  | "spoke"
  | "passed"
  | "skipped"
  | "benched"
  | "writing";

export type GroupDiscussionSummary = {
  id: string;
  channelId: string;
  status: GroupDiscussionStatus;
  phase: GroupDiscussionPhase;
  endReason: GroupDiscussionEndReason | null;
  endDetail: string | null;
  question: string;
  questionMessageId: string | null;
  startedBy: { id: string; name: string } | null;
  leadEmployeeId: string | null;
  participants: Array<{
    id: string;
    name: string;
    slug: string;
    role: string;
    avatarKey: string | null;
    state: DiscussionParticipantState;
  }>;
  round: number;
  /** Rounds in all, including any a Member's input added. */
  rounds: number;
  turnsTaken: number;
  maxTurns: number;
  tokensUsed: number;
  tokenBudget: number;
  currentEmployeeId: string | null;
  passes: DiscussionState["passes"];
  skipped: DiscussionState["skipped"];
  outcome: DiscussionOutcome | null;
  outcomeMessageId: string | null;
  followThrough: { startedAt: string; byUserId: string | null } | null;
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
};

export class GroupDiscussionError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409,
  ) {
    super(message);
    this.name = "GroupDiscussionError";
  }
}

// ───────────────────────────── seams ─────────────────────────────

export type DiscussionTurnRunner = (
  companyId: string,
  employeeId: string,
  message: string,
  history: ChatTurn[],
  onChunk: (chunk: string) => void,
  options: ChatOptions,
) => Promise<ChatResult>;

export type OutcomeWriterResult =
  | { ok: true; outcome: DiscussionOutcome }
  | { ok: false; error: string };

export type OutcomeWriter = (args: {
  companyId: string;
  lead: AIEmployee;
  system: string;
  request: string;
  people: { participants: PromptPerson[]; members: PromptMember[] };
  signal: AbortSignal;
  onUsage: (usage: TurnUsage) => void;
}) => Promise<OutcomeWriterResult>;

type Deps = {
  runTurn: DiscussionTurnRunner;
  writeOutcome: OutcomeWriter;
  /** How often a turn in flight checks for Stop and Standdowns. */
  pollIntervalMs: number;
  heartbeatMs: number;
  now: () => Date;
};

const defaultDeps: Deps = {
  runTurn: streamChatWithEmployee,
  writeOutcome: writeOutcomeWithModel,
  pollIntervalMs: 2_000,
  heartbeatMs: 15_000,
  now: () => new Date(),
};

let depsOverride: Partial<Deps> | null = null;

/** Replace model calls and timers in tests. Pass null to restore. */
export function setGroupDiscussionDepsForTests(deps: Partial<Deps> | null): void {
  depsOverride = deps;
}

function deps(): Deps {
  return { ...defaultDeps, ...(depsOverride ?? {}) };
}

/** A driver past this without a heartbeat died with its process. */
export const STALE_HEARTBEAT_MS = 3 * 60_000;

type LocalDriver = {
  /** Abort the turn in flight now (Stop pressed on this replica). */
  abortTurn: () => void;
  done: Promise<void>;
};

const localDrivers = new Map<string, LocalDriver>();
const followThroughsInFlight = new Set<string>();

/** Resolves once every discussion driven by this process has finished. Tests. */
export async function settleGroupDiscussionsForTests(): Promise<void> {
  for (;;) {
    const pending = [...localDrivers.values()].map((d) => d.done);
    if (pending.length === 0 && followThroughsInFlight.size === 0) return;
    await Promise.allSettled(pending);
    if (followThroughsInFlight.size > 0) await new Promise((r) => setTimeout(r, 10));
  }
}

// ───────────────────────────── repositories ─────────────────────────────

function repo() {
  return AppDataSource.getRepository(GroupDiscussion);
}

async function loadDiscussion(id: string): Promise<GroupDiscussion | null> {
  return repo().findOneBy({ id });
}

/** Write orchestrator-owned columns only, so a Stop or Wrap-up is never lost. */
async function patch(id: string, values: Partial<GroupDiscussion>): Promise<void> {
  await repo().update({ id }, values as never);
}

// ───────────────────────────── reading ─────────────────────────────

export async function getGroupDiscussion(
  companyId: string,
  discussionId: string,
): Promise<GroupDiscussion | null> {
  return repo().findOneBy({ id: discussionId, companyId });
}

export async function listChannelDiscussions(
  companyId: string,
  channelId: string,
  limit = 20,
): Promise<GroupDiscussionSummary[]> {
  const rows = await repo().find({
    where: { companyId, channelId },
    order: { createdAt: "DESC" },
    take: Math.max(1, Math.min(50, limit)),
  });
  return summarizeDiscussions(rows);
}

export async function summarizeDiscussion(d: GroupDiscussion): Promise<GroupDiscussionSummary> {
  const [summary] = await summarizeDiscussions([d]);
  return summary;
}

export async function summarizeDiscussions(
  rows: GroupDiscussion[],
): Promise<GroupDiscussionSummary[]> {
  if (rows.length === 0) return [];
  const employeeIds = new Set<string>();
  const userIds = new Set<string>();
  for (const d of rows) {
    for (const id of parseParticipants(d.participantsJson)) employeeIds.add(id);
    if (d.startedByUserId) userIds.add(d.startedByUserId);
  }
  const [employees, users] = await Promise.all([
    employeeIds.size
      ? AppDataSource.getRepository(AIEmployee).findBy({ id: In([...employeeIds]) })
      : Promise.resolve([] as AIEmployee[]),
    userIds.size
      ? AppDataSource.getRepository(User).findBy({ id: In([...userIds]) })
      : Promise.resolve([] as User[]),
  ]);
  const empById = new Map(employees.map((e) => [e.id, e]));
  const userById = new Map(users.map((u) => [u.id, u]));
  return rows.map((d) => {
    const state = parseDiscussionState(d.stateJson);
    const participants = parseParticipants(d.participantsJson).flatMap((id) => {
      const e = empById.get(id);
      if (!e) return [];
      return [
        {
          id: e.id,
          name: e.name,
          slug: e.slug,
          role: e.role,
          avatarKey: e.avatarKey ?? null,
          state: participantState(d, state, e.id),
        },
      ];
    });
    const starter = d.startedByUserId ? userById.get(d.startedByUserId) : null;
    return {
      id: d.id,
      channelId: d.channelId,
      status: d.status,
      phase: d.phase,
      endReason: d.endReason,
      endDetail: d.endDetail,
      question: d.question,
      questionMessageId: d.questionMessageId,
      startedBy: starter ? { id: starter.id, name: starter.name || starter.email } : null,
      leadEmployeeId: d.leadEmployeeId,
      participants,
      round: d.round,
      rounds: d.maxRounds + state.extraRounds,
      turnsTaken: d.turnsTaken,
      maxTurns: d.maxTurns,
      tokensUsed: d.tokensUsed,
      tokenBudget: d.tokenBudget,
      currentEmployeeId: d.currentEmployeeId,
      passes: state.passes,
      skipped: state.skipped,
      outcome: parseOutcome(d.outcomeJson),
      outcomeMessageId: d.outcomeMessageId,
      followThrough: d.followThroughStartedAt
        ? {
            startedAt: d.followThroughStartedAt.toISOString(),
            byUserId: d.followThroughByUserId,
          }
        : null,
      createdAt: d.createdAt.toISOString(),
      updatedAt: d.updatedAt.toISOString(),
      endedAt: d.endedAt?.toISOString() ?? null,
    };
  });
}

function participantState(
  d: GroupDiscussion,
  state: DiscussionState,
  employeeId: string,
): DiscussionParticipantState {
  if (d.status === "running" && d.currentEmployeeId === employeeId) {
    return d.phase === "concluding" ? "writing" : "speaking";
  }
  if (state.benched.includes(employeeId)) return "benched";
  if (d.status !== "running") return "waiting";
  if (state.spoken.includes(employeeId)) {
    if (state.skipped.some((s) => s.employeeId === employeeId && s.round === d.round)) {
      return "skipped";
    }
    if (state.passes.some((p) => p.employeeId === employeeId && p.round === d.round)) {
      return "passed";
    }
    return "spoke";
  }
  return "waiting";
}

export function parseOutcome(raw: string | null): DiscussionOutcome | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as DiscussionOutcome;
    if (!parsed || typeof parsed.summary !== "string") return null;
    return {
      summary: parsed.summary,
      recommendation: typeof parsed.recommendation === "string" ? parsed.recommendation : "",
      openQuestions: Array.isArray(parsed.openQuestions) ? parsed.openQuestions : [],
      actionItems: Array.isArray(parsed.actionItems) ? parsed.actionItems : [],
      writtenByEmployeeId: parsed.writtenByEmployeeId ?? null,
    };
  } catch {
    return null;
  }
}

async function announce(discussionId: string): Promise<void> {
  const d = await loadDiscussion(discussionId);
  if (!d) return;
  const summary = await summarizeDiscussion(d);
  broadcastToCompany(d.companyId, {
    type: "discussion.update",
    channelId: d.channelId,
    discussion: summary,
  });
}

// ───────────────────────────── starting ─────────────────────────────

export type DiscussionRequester = { userId: string; sessionVersion: number };

/**
 * Start a discussion in a channel. `questionMessage` is the Member's message
 * when one already exists (a group chat post); otherwise the question is
 * posted here, as the Member, with any attachments.
 */
export async function startGroupDiscussion(params: {
  channel: Channel;
  requester: DiscussionRequester;
  question: string;
  questionMessage?: ChannelMessage | null;
  attachmentIds?: string[];
  /** Explicit roster, lead first. Omitted: every AI Employee in the channel. */
  participantIds?: string[] | null;
  maxRounds?: number | null;
  /** Fewest participants accepted. Explicit starts ask for two. */
  minParticipants?: number;
}): Promise<GroupDiscussionSummary> {
  const { channel, requester } = params;
  if (channel.kind === "dm") {
    throw new GroupDiscussionError("Start a group chat to discuss with several AI Employees.", 400);
  }
  if (channel.archivedAt) throw new GroupDiscussionError("Channel not found", 404);
  const allowed = await userHasChannelAccess({
    channelId: channel.id,
    userId: requester.userId,
    companyId: channel.companyId,
  });
  if (!allowed) throw new GroupDiscussionError("Channel not found", 404);

  const question = params.question.trim().slice(0, GROUP_DISCUSSION_LIMITS.maxQuestionChars);
  if (!question && !params.questionMessage) {
    throw new GroupDiscussionError("Ask a question for them to discuss.", 400);
  }

  const running = await runningDiscussionIn(channel.id);
  if (running) {
    throw new GroupDiscussionError(
      "A discussion is already running here. Write into it, or stop it first.",
      409,
    );
  }

  const roster = await resolveRoster(channel, params.participantIds ?? null);
  const min = params.minParticipants ?? 1;
  if (roster.length < min) {
    throw new GroupDiscussionError(
      min > 1
        ? `Choose at least ${min} AI Employees to discuss it.`
        : "Add an AI Employee to discuss it with.",
      400,
    );
  }
  if (roster.length > GROUP_DISCUSSION_LIMITS.maxParticipants) {
    throw new GroupDiscussionError(
      `A discussion can include at most ${GROUP_DISCUSSION_LIMITS.maxParticipants} AI Employees.`,
      400,
    );
  }
  // Everyone taking part has to be able to read the room they talk in.
  await addChannelMembers({
    channelId: channel.id,
    companyId: channel.companyId,
    userIds: [],
    employeeIds: roster.map((e) => e.id),
  });

  const maxRounds = clampRounds(params.maxRounds);
  const now = deps().now();
  const discussion = await repo().save(
    repo().create({
      companyId: channel.companyId,
      channelId: channel.id,
      startedByUserId: requester.userId,
      requesterSessionVersion: requester.sessionVersion,
      questionMessageId: params.questionMessage?.id ?? null,
      // A question asked with files alone still needs words for the prompts.
      question: question || "(The question is in the attached files.)",
      participantsJson: JSON.stringify(roster.map((e) => e.id)),
      leadEmployeeId: roster[0].id,
      status: "running",
      phase: "discussing",
      endReason: null,
      endDetail: null,
      round: 0,
      maxRounds,
      turnsTaken: 0,
      maxTurns: maxTurnsFor(roster.length, maxRounds),
      tokensUsed: 0,
      tokenBudget: GROUP_DISCUSSION_LIMITS.tokenBudget,
      currentEmployeeId: null,
      stateJson: JSON.stringify(emptyDiscussionState()),
      tainted: false,
      stopRequestedAt: null,
      stopRequestedByUserId: null,
      wrapUpRequestedAt: null,
      heartbeatAt: now,
      outcomeMessageId: null,
      outcomeJson: null,
      followThroughStartedAt: null,
      followThroughByUserId: null,
      endedAt: null,
    }),
  );

  if (params.questionMessage) {
    await AppDataSource.getRepository(ChannelMessage).update(
      { id: params.questionMessage.id },
      { discussionId: discussion.id, discussionRole: "question" },
    );
  } else {
    const { row } = await insertChannelMessage({
      channel,
      author: { kind: "user", userId: requester.userId },
      content: question,
      attachmentIds: params.attachmentIds,
      discussionId: discussion.id,
      discussionRole: "question",
      viewerUserId: requester.userId,
    });
    await patch(discussion.id, { questionMessageId: row.id });
  }

  await recordAudit({
    companyId: channel.companyId,
    actorUserId: requester.userId,
    action: "group_discussion.start",
    targetType: "group_discussion",
    targetId: discussion.id,
    targetLabel: clipLine(question || discussion.question, 120),
    metadata: {
      channelId: channel.id,
      channelKind: channel.kind,
      participantIds: roster.map((e) => e.id),
      maxRounds,
    },
  });

  void driveGroupDiscussion(discussion.id);
  const fresh = await loadDiscussion(discussion.id);
  const summary = await summarizeDiscussion(fresh ?? discussion);
  broadcastToCompany(channel.companyId, {
    type: "discussion.update",
    channelId: channel.id,
    discussion: summary,
  });
  return summary;
}

/**
 * A Member wrote in a group chat. Join the discussion already running there,
 * or start one — unless the message only speaks to other people.
 */
export async function discussGroupChatMessage(params: {
  channel: Channel;
  message: ChannelMessage;
  requester: DiscussionRequester;
}): Promise<GroupDiscussionSummary | null> {
  const { channel, message } = params;
  if (channel.kind !== "group" || channel.archivedAt) return null;
  const running = await runningDiscussionIn(channel.id);
  if (running && running.phase !== "concluding") {
    await addMemberInput(running, message);
    return summarizeDiscussion(running);
  }
  if (running) {
    // The outcome is being written; this message is a new question, so it
    // waits for that one to land and then starts the next discussion.
    const ended = await waitForDiscussionEnd(running.id, LATE_INPUT_WAIT_MS);
    if (!ended) {
      await postNote(
        running,
        "Your message arrived while the outcome was still being written. Send it again once the outcome is in.",
      );
      return null;
    }
  }

  const companyEmployees = await AppDataSource.getRepository(AIEmployee).findBy({
    companyId: channel.companyId,
  });
  const members = await AppDataSource.getRepository(ChannelMember).find({
    where: { channelId: channel.id },
    order: { createdAt: "ASC" },
  });
  const aiMemberIds = members.filter((m) => m.employeeId).map((m) => m.employeeId!);
  const aiMembers = aiMemberIds
    .map((id) => companyEmployees.find((e) => e.id === id))
    .filter((e): e is AIEmployee => Boolean(e));
  const { addressed, outsiders } = classifyMentions(message.content, aiMembers, companyEmployees);

  // "@sam, can you check this?" is for Sam, not the room.
  if (addressed.length === 0 && outsiders.length === 0 && mentionsOnlyPeople(message.content)) {
    return null;
  }
  // Whoever was named leads; then everyone else, in the order they joined.
  const ordered = [
    ...addressed,
    ...outsiders,
    ...aiMembers.map((e) => e.id).filter((id) => !addressed.includes(id)),
  ].slice(0, GROUP_DISCUSSION_LIMITS.maxParticipants);
  if (ordered.length === 0) return null;
  try {
    return await startGroupDiscussion({
      channel,
      requester: params.requester,
      question: message.content,
      questionMessage: message,
      participantIds: ordered,
    });
  } catch (error) {
    // A second message racing the first into a fresh discussion joins it.
    if (error instanceof GroupDiscussionError && error.status === 409) {
      const raced = await runningDiscussionIn(channel.id);
      if (raced) {
        await addMemberInput(raced, message);
        return summarizeDiscussion(raced);
      }
    }
    throw error;
  }
}

/** True when a message @mentions someone and none of them is an AI Employee. */
function mentionsOnlyPeople(content: string): boolean {
  return /(^|[\s(])@[a-z0-9]/i.test(content);
}

/** How long a message written during the outcome waits for it to land. */
const LATE_INPUT_WAIT_MS = 5 * 60_000;

/** Wait until a discussion is no longer running. False when time ran out. */
async function waitForDiscussionEnd(discussionId: string, timeoutMs: number): Promise<boolean> {
  const local = localDrivers.get(discussionId);
  const deadline = Date.now() + timeoutMs;
  if (local) {
    await Promise.race([local.done, new Promise((resolve) => setTimeout(resolve, timeoutMs))]);
  }
  for (;;) {
    const d = await loadDiscussion(discussionId);
    if (!d || d.status !== "running") return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, Math.min(1_000, deps().pollIntervalMs * 5)));
  }
}

async function addMemberInput(d: GroupDiscussion, message: ChannelMessage): Promise<void> {
  await AppDataSource.getRepository(ChannelMessage).update(
    { id: message.id },
    { discussionId: d.id, discussionRole: "input" },
  );
  // Anyone the Member named must be able to read the room; the driver brings
  // them into the discussion itself on its next step.
  const companyEmployees = await AppDataSource.getRepository(AIEmployee).findBy({
    companyId: d.companyId,
  });
  const participants = parseParticipants(d.participantsJson);
  const { outsiders } = classifyMentions(
    message.content,
    companyEmployees.filter((e) => participants.includes(e.id)),
    companyEmployees,
  );
  const room = GROUP_DISCUSSION_LIMITS.maxParticipants - participants.length;
  if (outsiders.length > 0 && room > 0) {
    await addChannelMembers({
      channelId: d.channelId,
      companyId: d.companyId,
      userIds: [],
      employeeIds: outsiders.slice(0, room),
    });
  }
  await announce(d.id);
}

async function runningDiscussionIn(channelId: string): Promise<GroupDiscussion | null> {
  return repo().findOne({ where: { channelId, status: "running" }, order: { createdAt: "DESC" } });
}

/** The roster: explicit ids in order, or the channel's AI Employees. */
async function resolveRoster(channel: Channel, explicit: string[] | null): Promise<AIEmployee[]> {
  const employees = AppDataSource.getRepository(AIEmployee);
  if (explicit && explicit.length > 0) {
    const ids = [...new Set(explicit)];
    const rows = await employees.findBy({ companyId: channel.companyId, id: In(ids) });
    if (rows.length !== ids.length) throw new GroupDiscussionError("Employee not found", 404);
    return ids.map((id) => rows.find((e) => e.id === id)!);
  }
  const members = await AppDataSource.getRepository(ChannelMember).find({
    where: { channelId: channel.id, memberKind: "ai" },
    order: { createdAt: "ASC" },
  });
  const ids = members.map((m) => m.employeeId!).filter(Boolean);
  if (ids.length === 0) return [];
  const rows = await employees.findBy({ companyId: channel.companyId, id: In(ids) });
  return ids.flatMap((id) => rows.filter((e) => e.id === id));
}

// ───────────────────────────── controls ─────────────────────────────

/** Stop now: the turn in flight is abandoned and nothing more is written. */
export async function stopGroupDiscussion(params: {
  companyId: string;
  discussionId: string;
  userId: string;
}): Promise<GroupDiscussionSummary> {
  const d = await getGroupDiscussion(params.companyId, params.discussionId);
  if (!d) throw new GroupDiscussionError("Discussion not found", 404);
  if (d.status !== "running") {
    throw new GroupDiscussionError("This discussion has already ended.", 409);
  }
  await repo().update(
    { id: d.id, status: "running" },
    { stopRequestedAt: deps().now(), stopRequestedByUserId: params.userId },
  );
  await recordAudit({
    companyId: d.companyId,
    actorUserId: params.userId,
    action: "group_discussion.stop",
    targetType: "group_discussion",
    targetId: d.id,
    targetLabel: clipLine(d.question, 120),
  });
  const local = localDrivers.get(d.id);
  if (local) {
    local.abortTurn();
    // Usually immediate; never hold the request hostage to a slow unwind.
    await Promise.race([local.done, new Promise((resolve) => setTimeout(resolve, 10_000))]);
  } else if (await heartbeatIsStale(d)) {
    // Nobody is driving it — a crashed process. End it here.
    await endWithoutOutcome(d.id, "stopped", "stopped", await stoppedByDetail(params.userId));
  }
  const fresh = await loadDiscussion(d.id);
  return summarizeDiscussion(fresh ?? d);
}

/** End the rounds after the turn in flight and write the outcome now. */
export async function wrapUpGroupDiscussion(params: {
  companyId: string;
  discussionId: string;
  userId: string;
}): Promise<GroupDiscussionSummary> {
  const d = await getGroupDiscussion(params.companyId, params.discussionId);
  if (!d) throw new GroupDiscussionError("Discussion not found", 404);
  if (d.status !== "running") {
    throw new GroupDiscussionError("This discussion has already ended.", 409);
  }
  if (!d.wrapUpRequestedAt) {
    await repo().update(
      { id: d.id, status: "running" },
      { wrapUpRequestedAt: deps().now() },
    );
    await recordAudit({
      companyId: d.companyId,
      actorUserId: params.userId,
      action: "group_discussion.wrap_up",
      targetType: "group_discussion",
      targetId: d.id,
      targetLabel: clipLine(d.question, 120),
    });
  }
  await announce(d.id);
  const fresh = await loadDiscussion(d.id);
  return summarizeDiscussion(fresh ?? d);
}

async function heartbeatIsStale(d: GroupDiscussion): Promise<boolean> {
  const beat = d.heartbeatAt ?? d.createdAt;
  return deps().now().getTime() - beat.getTime() > STALE_HEARTBEAT_MS;
}

// ───────────────────────────── the driver ─────────────────────────────

/**
 * Drive a discussion to its end in this process. Idempotent per process:
 * a second call while one is driving returns the first one's completion.
 */
export function driveGroupDiscussion(discussionId: string): Promise<void> {
  const existing = localDrivers.get(discussionId);
  if (existing) return existing.done;
  let abortTurn: () => void = () => {};
  const driver: LocalDriver = {
    abortTurn: () => abortTurn(),
    done: Promise.resolve(),
  };
  driver.done = (async () => {
    const heartbeat = setInterval(() => {
      void patch(discussionId, { heartbeatAt: deps().now() }).catch(() => undefined);
    }, deps().heartbeatMs);
    heartbeat.unref?.();
    try {
      await runDiscussion(discussionId, (abort) => {
        abortTurn = abort;
      });
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(`[group-discussion] ${discussionId} failed:`, error);
      await endWithoutOutcome(
        discussionId,
        "failed",
        "error",
        `Something went wrong running the discussion: ${errorText(error)}`,
      ).catch(() => undefined);
    } finally {
      clearInterval(heartbeat);
      localDrivers.delete(discussionId);
    }
  })();
  localDrivers.set(discussionId, driver);
  return driver.done;
}

type EndVerdict =
  | { kind: "stop"; status: "stopped" | "failed"; reason: GroupDiscussionEndReason; detail: string }
  | { kind: "conclude"; reason: GroupDiscussionEndReason };

async function runDiscussion(
  discussionId: string,
  onTurnAbort: (abort: () => void) => void,
): Promise<void> {
  for (;;) {
    const d = await loadDiscussion(discussionId);
    if (!d || d.status !== "running") return;

    const verdict = await checkBeforeTurn(d);
    if (verdict?.kind === "stop") {
      await endWithoutOutcome(d.id, verdict.status, verdict.reason, verdict.detail);
      return;
    }
    if (verdict?.kind === "conclude") {
      await conclude(d.id, verdict.reason, onTurnAbort);
      return;
    }

    let state = parseDiscussionState(d.stateJson);
    let participants = parseParticipants(d.participantsJson);
    const round = d.round === 0 ? 1 : d.round;

    // Fold in what Members wrote since the last step.
    const folded = await foldMemberInput(d, state, participants, round);
    state = folded.state;
    participants = folded.participants;

    // Who cannot speak right now. A stood-down employee sits the round out
    // (once noted per discussion); an employee benched for having no AI
    // Model never comes back.
    const unavailable = new Set<string>();
    for (const id of participants) {
      if (state.benched.includes(id)) continue;
      const block = workBlocked(d.companyId, { employeeId: id });
      if (!block.blocked) continue;
      unavailable.add(id);
      if (!state.spoken.includes(id)) {
        const alreadyNoted = state.skipped.some(
          (s) => s.employeeId === id && s.reason === "standdown",
        );
        state = recordTurn(state, {
          speaker: id,
          round,
          kind: "skipped",
          skip: { reason: "standdown", detail: block.reason },
        });
        if (!alreadyNoted) {
          const emp = await AppDataSource.getRepository(AIEmployee).findOneBy({ id });
          await postNote(d, `${emp?.name ?? "An AI Employee"} is stood down and is sitting this discussion out.`);
        }
      }
    }

    if (participants.every((id) => state.benched.includes(id) || unavailable.has(id))) {
      await patch(d.id, { stateJson: JSON.stringify(state), round, participantsJson: JSON.stringify(participants) });
      const anyContent = await discussionHasTurns(d.id);
      if (anyContent) {
        await conclude(d.id, "max_rounds", onTurnAbort);
        return;
      }
      const allStoodDown = participants.some((id) => unavailable.has(id));
      await endWithoutOutcome(
        d.id,
        allStoodDown ? "stopped" : "failed",
        allStoodDown ? "standdown" : "no_participants",
        allStoodDown
          ? "Every AI Employee in the discussion is stood down."
          : "None of the AI Employees in the discussion could take a turn.",
      );
      return;
    }

    const speaker = pickNextSpeaker(participants, state, unavailable);
    if (!speaker) {
      const decision = completeRound(state, round, d.maxRounds);
      if (decision.next === "end") {
        await patch(d.id, { stateJson: JSON.stringify(decision.state), round });
        await conclude(d.id, decision.reason, onTurnAbort);
        return;
      }
      await patch(d.id, { stateJson: JSON.stringify(decision.state), round: round + 1 });
      await announce(d.id);
      continue;
    }

    await patch(d.id, {
      round,
      currentEmployeeId: speaker,
      stateJson: JSON.stringify(state),
      participantsJson: JSON.stringify(participants),
    });
    await announce(d.id);
    await takeTurn(d.id, speaker, onTurnAbort);
  }
}

/** Ends a discussion must meet before any turn, in order of precedence. */
async function checkBeforeTurn(d: GroupDiscussion): Promise<EndVerdict | null> {
  if (d.stopRequestedAt) {
    return {
      kind: "stop",
      status: "stopped",
      reason: "stopped",
      detail: await stoppedByDetail(d.stopRequestedByUserId),
    };
  }
  const company = workBlocked(d.companyId);
  if (company.blocked) {
    return {
      kind: "stop",
      status: "stopped",
      reason: "standdown",
      detail: `Company AI work is stood down: ${company.reason}`,
    };
  }
  const authority = await requesterAuthorityProblem(d);
  if (authority) return { kind: "stop", status: "stopped", reason: "access_changed", detail: authority };
  const channel = await AppDataSource.getRepository(Channel).findOneBy({ id: d.channelId });
  if (!channel || channel.archivedAt) {
    return {
      kind: "stop",
      status: "stopped",
      reason: "channel_archived",
      detail: "The conversation was archived.",
    };
  }
  if (d.wrapUpRequestedAt) return { kind: "conclude", reason: "wrapped_up" };
  const budget = budgetStop({
    turnsTaken: d.turnsTaken,
    maxTurns: d.maxTurns,
    tokensUsed: d.tokensUsed,
    tokenBudget: d.tokenBudget,
    startedAt: d.createdAt,
    now: deps().now(),
  });
  if (budget) return { kind: "conclude", reason: budget };
  return null;
}

/**
 * Why the starting Member's authority no longer holds, or null when it does.
 * Every turn runs on it, so a removed Member, a password reset (new session
 * version) or a lost channel ends the discussion.
 */
async function requesterAuthorityProblem(d: GroupDiscussion): Promise<string | null> {
  if (!d.startedByUserId) return "The Member who started this discussion no longer has an account.";
  const [user, membership] = await Promise.all([
    AppDataSource.getRepository(User).findOneBy({ id: d.startedByUserId }),
    AppDataSource.getRepository(Membership).findOneBy({
      companyId: d.companyId,
      userId: d.startedByUserId,
    }),
  ]);
  if (!user || !membership) {
    return "The Member who started this discussion no longer has access to the company.";
  }
  if (user.sessionVersion !== d.requesterSessionVersion) {
    return "The Member who started this discussion signed in again, so it stopped. Ask again to restart it.";
  }
  const access = await userHasChannelAccess({
    channelId: d.channelId,
    userId: d.startedByUserId,
    companyId: d.companyId,
  });
  if (!access) return "The Member who started this discussion left the conversation.";
  return null;
}

async function stoppedByDetail(userId: string | null): Promise<string> {
  if (!userId) return "Stopped.";
  const user = await AppDataSource.getRepository(User).findOneBy({ id: userId });
  return `Stopped by ${user?.name || user?.email || "a Member"}.`;
}

/**
 * Fold Member messages written into the discussion since the last step: the
 * people they named speak next (and join if new), and a final round gains one
 * more so the input is answered — within `noteMemberInput`'s cap.
 */
async function foldMemberInput(
  d: GroupDiscussion,
  state: DiscussionState,
  participants: string[],
  round: number,
): Promise<{ state: DiscussionState; participants: string[] }> {
  const inputs = await AppDataSource.getRepository(ChannelMessage).find({
    where: { discussionId: d.id, discussionRole: "input" },
    order: { createdAt: "ASC" },
  });
  const fresh = inputs.filter((m) => !state.inputsSeen.includes(m.id) && !m.deletedAt);
  if (fresh.length === 0) return { state, participants };
  const companyEmployees = await AppDataSource.getRepository(AIEmployee).findBy({
    companyId: d.companyId,
  });
  let next = state;
  const roster = [...participants];
  for (const message of fresh) {
    const { addressed, outsiders } = classifyMentions(
      message.content,
      companyEmployees.filter((e) => roster.includes(e.id)),
      companyEmployees,
    );
    for (const id of outsiders) {
      if (roster.length >= GROUP_DISCUSSION_LIMITS.maxParticipants) break;
      if (roster.includes(id)) continue;
      roster.push(id);
      next = { ...next, added: [...next.added, { employeeId: id, by: null, round }] };
      const emp = companyEmployees.find((e) => e.id === id);
      await postNote(d, `${emp?.name ?? "An AI Employee"} joined the discussion.`);
    }
    for (const id of [...addressed, ...outsiders.filter((o) => roster.includes(o))]) {
      if (next.spoken.includes(id)) {
        if (!next.carry.includes(id)) next = { ...next, carry: [...next.carry, id] };
      } else if (!next.queue.includes(id)) {
        next = { ...next, queue: [...next.queue, id] };
      }
    }
    next = noteMemberInput(next, round, d.maxRounds);
    next = markInputSeen(next, message.id);
  }
  if (roster.length !== participants.length) {
    await patch(d.id, { maxTurns: maxTurnsFor(roster.length, d.maxRounds) });
  }
  return { state: next, participants: roster };
}

/** One AI Employee's turn, start to finish. */
async function takeTurn(
  discussionId: string,
  speakerId: string,
  onTurnAbort: (abort: () => void) => void,
): Promise<void> {
  const d = await loadDiscussion(discussionId);
  if (!d || d.status !== "running") return;
  const channel = await AppDataSource.getRepository(Channel).findOneBy({ id: d.channelId });
  if (!channel) return;
  const participants = parseParticipants(d.participantsJson);
  const employees = await AppDataSource.getRepository(AIEmployee).findBy({
    companyId: d.companyId,
  });
  const speaker = employees.find((e) => e.id === speakerId);
  if (!speaker) {
    let state = parseDiscussionState(d.stateJson);
    state = benchParticipant(
      recordTurn(state, { speaker: speakerId, round: d.round, kind: "skipped", skip: { reason: "unavailable" } }),
      speakerId,
    );
    await patch(d.id, { stateJson: JSON.stringify(state), currentEmployeeId: null });
    return;
  }
  const people = participants
    .map((id) => employees.find((e) => e.id === id))
    .filter((e): e is AIEmployee => Boolean(e));
  const lead = people.find((p) => p.id === d.leadEmployeeId) ?? people[0] ?? speaker;
  const starter = await starterName(d);
  const transcript = await discussionTranscript(d, speaker.id, employees);
  let state = parseDiscussionState(d.stateJson);

  const brief = composeDiscussionBrief({
    self: person(speaker),
    colleagues: people.filter((p) => p.id !== speaker.id).map(person),
    starter,
    question: d.question,
    lead: person(lead),
    attachments: transcript.questionAttachments,
  });
  const rounds = d.maxRounds + state.extraRounds;
  const prompt = composeTurnPrompt({
    self: person(speaker),
    round: d.round,
    rounds,
    addressedBy: transcript.addressedBy,
    newMemberInput: transcript.newMemberInput,
    firstTurn: !transcript.speakerHasSpoken,
  });

  const controller = new AbortController();
  let stoppedReason: "stop" | "standdown" | null = null;
  onTurnAbort(() => {
    stoppedReason = "stop";
    controller.abort();
  });
  const poll = setInterval(() => {
    void (async () => {
      if (controller.signal.aborted) return;
      if (
        workBlocked(d.companyId).blocked ||
        workBlocked(d.companyId, { employeeId: speaker.id }).blocked
      ) {
        stoppedReason = "standdown";
        controller.abort();
        return;
      }
      const row = await repo().findOne({
        where: { id: d.id },
        select: { id: true, stopRequestedAt: true },
      });
      if (row?.stopRequestedAt) {
        stoppedReason = "stop";
        controller.abort();
      }
    })().catch(() => undefined);
  }, deps().pollIntervalMs);
  poll.unref?.();

  let tokens = 0;
  const stopTyping = startTypingBroadcast(channel, speaker);
  let result: ChatResult;
  try {
    result = await deps().runTurn(d.companyId, speaker.id, prompt, transcript.turns, () => {}, {
      requesterUserId: d.startedByUserId!,
      requesterSessionVersion: d.requesterSessionVersion,
      collaboration: { kind: "discussion", id: d.id },
      startTainted: transcript.tainted,
      extraSystem: brief,
      images: transcript.questionImages,
      workloadScope: `group-discussion:${d.id}`,
      maxSteps: GROUP_DISCUSSION_LIMITS.turnMaxSteps,
      timeoutMs: GROUP_DISCUSSION_LIMITS.turnTimeoutMs,
      signal: controller.signal,
      wasInterrupted: () => stoppedReason !== null,
      onUsage: (usage) => {
        tokens += Math.max(0, usage.inputTokens) + Math.max(0, usage.outputTokens);
      },
    });
  } catch (error) {
    result = {
      status: "error",
      reply: errorText(error),
      attachmentIds: [],
      sidecars: {},
    };
  } finally {
    clearInterval(poll);
    stopTyping();
    onTurnAbort(() => {});
  }

  // Re-read: a Stop, a Wrap-up or Member input may have landed meanwhile, and
  // the counters must add to what is there now.
  const now = await loadDiscussion(d.id);
  if (!now) return;
  state = parseDiscussionState(now.stateJson);
  const counters = {
    turnsTaken: now.turnsTaken + 1,
    tokensUsed: now.tokensUsed + tokens,
    tainted: now.tainted || result.tainted === true,
  };

  if (stoppedReason) {
    // Stop and Standdown both mean "no more": the half-written turn is
    // dropped, and the next step ends the discussion (or sits the employee
    // out, for an employee Standdown).
    if (stoppedReason === "standdown" && !workBlocked(d.companyId).blocked) {
      state = recordTurn(state, {
        speaker: speaker.id,
        round: now.round,
        kind: "skipped",
        skip: { reason: "standdown" },
      });
    }
    await patch(d.id, { ...counters, stateJson: JSON.stringify(state), currentEmployeeId: null });
    return;
  }

  if (result.status === "skipped") {
    // No AI Model: this employee cannot speak again in this discussion.
    state = benchParticipant(
      recordTurn(state, {
        speaker: speaker.id,
        round: now.round,
        kind: "skipped",
        skip: { reason: "no_model" },
      }),
      speaker.id,
    );
    await postNote(now, `${speaker.name} has no AI Model connected and is sitting this discussion out.`);
  } else if (result.status !== "ok") {
    const standdown = workBlocked(d.companyId, { employeeId: speaker.id }).blocked;
    state = recordTurn(state, {
      speaker: speaker.id,
      round: now.round,
      kind: "skipped",
      skip: {
        reason: standdown ? "standdown" : "error",
        detail: clipLine(result.reply, 300),
      },
    });
    if (!standdown) {
      await postNote(now, `${speaker.name} couldn't take their turn: ${clipLine(result.reply, 300)}`);
    }
  } else {
    const earlier = transcript.turnTexts;
    const reading = readTurn(result.reply, earlier);
    if (reading.kind === "spoke") {
      const { addressed, outsiders } = classifyMentions(
        reading.text,
        people,
        employees,
      );
      const roster = [...participants];
      const brought: AIEmployee[] = [];
      for (const id of outsiders) {
        if (roster.length >= GROUP_DISCUSSION_LIMITS.maxParticipants) break;
        if (roster.includes(id)) continue;
        const emp = employees.find((e) => e.id === id);
        if (!emp) continue;
        roster.push(id);
        brought.push(emp);
      }
      await insertChannelMessage({
        channel,
        author: { kind: "ai", employeeId: speaker.id },
        content: reading.clipped
          ? `${reading.text}\n\n_(Clipped to ${GROUP_DISCUSSION_LIMITS.maxTurnChars.toLocaleString("en-US")} characters.)_`
          : reading.text,
        attachmentIds: result.attachmentIds,
        discussionId: d.id,
        discussionRole: "turn",
        tainted: result.tainted === true,
      });
      if (brought.length > 0) {
        await addChannelMembers({
          channelId: channel.id,
          companyId: d.companyId,
          userIds: [],
          employeeIds: brought.map((e) => e.id),
        });
        for (const emp of brought) {
          state = {
            ...state,
            added: [...state.added, { employeeId: emp.id, by: speaker.id, round: now.round }],
          };
          await postNote(now, `${speaker.name} brought ${emp.name} into the discussion.`);
        }
        await patch(d.id, {
          participantsJson: JSON.stringify(roster),
          maxTurns: maxTurnsFor(roster.length, now.maxRounds),
        });
      }
      state = recordTurn(state, {
        speaker: speaker.id,
        round: now.round,
        kind: "spoke",
        addressed: [...addressed, ...brought.map((e) => e.id)],
      });
    } else {
      state = recordTurn(state, { speaker: speaker.id, round: now.round, kind: reading.kind });
    }
  }

  await patch(d.id, { ...counters, stateJson: JSON.stringify(state), currentEmployeeId: null });
  await announce(d.id);
}

// ───────────────────────────── transcripts ─────────────────────────────

/** Messages a turn replays: the room's last words before the question, then the discussion. */
const PRIOR_CONTEXT_MESSAGES = 8;
/** The most recent this-many discussion messages replay in full; older ones clipped. */
const FULL_RECENT_MESSAGES = 14;
const OLDER_MESSAGE_CHARS = 1_500;
const ATTACHMENT_TEXT_CHARS = 20_000;

async function discussionTranscript(
  d: GroupDiscussion,
  speakerId: string,
  employees: AIEmployee[],
): Promise<{
  turns: ChatTurn[];
  turnTexts: string[];
  tainted: boolean;
  addressedBy: string[];
  newMemberInput: boolean;
  speakerHasSpoken: boolean;
  questionAttachments: string;
  questionImages?: NonNullable<ChatTurn["images"]>;
}> {
  const recent = await AppDataSource.getRepository(ChannelMessage).find({
    where: { channelId: d.channelId },
    order: { createdAt: "DESC" },
    take: 160,
  });
  recent.reverse();
  const mine = recent.filter((m) => m.discussionId === d.id && !m.deletedAt);
  const questionAt = mine.find((m) => m.discussionRole === "question")?.createdAt ?? d.createdAt;
  const prior = recent
    .filter(
      (m) =>
        m.discussionId !== d.id &&
        !m.deletedAt &&
        m.createdAt <= questionAt &&
        m.discussionRole !== "note" &&
        m.authorKind !== "system",
    )
    .slice(-PRIOR_CONTEXT_MESSAGES);
  const spoken = mine.filter((m) => m.discussionRole !== "note");

  const userIds = [...new Set([...prior, ...spoken].map((m) => m.authorUserId).filter(Boolean))] as string[];
  const users = userIds.length
    ? await AppDataSource.getRepository(User).findBy({ id: In(userIds) })
    : [];
  const userName = new Map(users.map((u) => [u.id, u.name || u.email]));
  const empById = new Map(employees.map((e) => [e.id, e]));

  const questionMessage = spoken.find((m) => m.discussionRole === "question") ?? null;
  const attachmentNotes = await historicalAttachmentSummaries(
    [...prior, ...spoken].filter((m) => m.id !== questionMessage?.id).map((m) => m.id),
    d.companyId,
  );
  const questionImages = questionMessage
    ? (await attachmentImageContextForMessages([questionMessage.id], d.companyId)).get(
        questionMessage.id,
      )
    : undefined;
  const questionAttachments = questionMessage
    ? clipText(await inlineAttachmentsForMessage(questionMessage.id, d.companyId), ATTACHMENT_TEXT_CHARS)
    : "";

  const label = (m: ChannelMessage): string => {
    if (m.authorKind === "ai" && m.authorEmployeeId) {
      const e = empById.get(m.authorEmployeeId);
      return e ? `${e.name} (@${e.slug}, ${e.role})` : "A former AI colleague";
    }
    if (m.authorKind === "user" && m.authorUserId) {
      return `${userName.get(m.authorUserId) ?? "A Member"} (Member)`;
    }
    return m.authorName || "System";
  };
  const annotate = (m: ChannelMessage, body: string) => {
    const note = attachmentNotes.get(m.id);
    return note ? `${body}\n[attached: ${note}]` : body;
  };

  const turns: ChatTurn[] = [];
  for (const m of prior) {
    turns.push({
      role: "user",
      content: annotate(m, `[Earlier in this conversation] ${label(m)}: ${clipText(m.content, OLDER_MESSAGE_CHARS)}`),
    });
  }
  spoken.forEach((m, index) => {
    const full = index >= spoken.length - FULL_RECENT_MESSAGES;
    const text = full ? m.content : clipText(m.content, OLDER_MESSAGE_CHARS);
    if (m.authorKind === "ai" && m.authorEmployeeId === speakerId) {
      turns.push({ role: "assistant", content: annotate(m, text) });
    } else {
      const prefix =
        m.discussionRole === "question"
          ? "[The question] "
          : m.discussionRole === "input"
            ? "[Added to the discussion] "
            : m.discussionRole === "outcome"
              ? "[Earlier outcome] "
              : "";
      turns.push({
        role: "user",
        content: annotate(m, `${prefix}${label(m)}: ${text}`),
        images: m.id === questionMessage?.id ? questionImages : undefined,
      });
    }
  });

  // Who addressed the speaker since its own last turn, and whether a Member
  // wrote in since then.
  const speaker = empById.get(speakerId);
  let lastOwn = -1;
  spoken.forEach((m, i) => {
    if (m.authorKind === "ai" && m.authorEmployeeId === speakerId) lastOwn = i;
  });
  const since = spoken.slice(lastOwn + 1);
  const addressedBy: string[] = [];
  if (speaker) {
    const handle = new RegExp(`(^|[\\s(])@${escapeRegExp(speaker.slug)}\\b`, "i");
    for (const m of since) {
      if (m.discussionRole !== "turn" || !handle.test(m.content)) continue;
      const author = m.authorEmployeeId ? empById.get(m.authorEmployeeId) : null;
      if (author && !addressedBy.includes(author.name)) addressedBy.push(author.name);
    }
  }
  return {
    turns,
    turnTexts: spoken.filter((m) => m.discussionRole === "turn").map((m) => m.content),
    tainted: [...prior, ...spoken].some((m) => m.tainted),
    addressedBy,
    newMemberInput: lastOwn >= 0 && since.some((m) => m.discussionRole === "input"),
    speakerHasSpoken: lastOwn >= 0,
    questionAttachments,
    questionImages,
  };
}

async function discussionHasTurns(discussionId: string): Promise<boolean> {
  const count = await AppDataSource.getRepository(ChannelMessage).count({
    where: { discussionId, discussionRole: "turn" },
  });
  return count > 0;
}

// ───────────────────────────── concluding ─────────────────────────────

async function conclude(
  discussionId: string,
  reason: GroupDiscussionEndReason,
  onTurnAbort: (abort: () => void) => void,
): Promise<void> {
  const d = await loadDiscussion(discussionId);
  if (!d || d.status !== "running") return;
  const company = workBlocked(d.companyId);
  if (company.blocked) {
    await endWithoutOutcome(d.id, "stopped", "standdown", `Company AI work is stood down: ${company.reason}`);
    return;
  }
  const channel = await AppDataSource.getRepository(Channel).findOneBy({ id: d.channelId });
  const co = await AppDataSource.getRepository(Company).findOneBy({ id: d.companyId });
  if (!channel || !co) return;
  const participants = parseParticipants(d.participantsJson);
  const employees = await AppDataSource.getRepository(AIEmployee).findBy({
    companyId: d.companyId,
  });
  const people = participants
    .map((id) => employees.find((e) => e.id === id))
    .filter((e): e is AIEmployee => Boolean(e));
  const state = parseDiscussionState(d.stateJson);
  const writers = [
    ...people.filter((p) => p.id === d.leadEmployeeId),
    ...people.filter((p) => p.id !== d.leadEmployeeId),
  ].filter(
    (p) => !state.benched.includes(p.id) && !workBlocked(d.companyId, { employeeId: p.id }).blocked,
  );
  const starter = await starterName(d);
  const members = await channelMembersForPrompt(d.channelId);
  const transcript = await outcomeTranscript(d, employees);
  const request = composeOutcomeRequest({
    question: d.question,
    starter,
    participants: people.map(person),
    members,
    transcript,
    endedBecause: describeEndReason(reason),
  });

  let failure = writers.length === 0 ? "nobody could write it" : "";
  for (const writer of writers.slice(0, 2)) {
    const latest = await loadDiscussion(d.id);
    if (!latest || latest.status !== "running") return;
    if (latest.stopRequestedAt) {
      await endWithoutOutcome(d.id, "stopped", "stopped", await stoppedByDetail(latest.stopRequestedByUserId));
      return;
    }
    await patch(d.id, { phase: "concluding", currentEmployeeId: writer.id });
    await announce(d.id);

    const controller = new AbortController();
    onTurnAbort(() => controller.abort());
    const poll = setInterval(() => {
      void (async () => {
        if (workBlocked(d.companyId).blocked) controller.abort();
        const row = await repo().findOne({
          where: { id: d.id },
          select: { id: true, stopRequestedAt: true },
        });
        if (row?.stopRequestedAt) controller.abort();
      })().catch(() => undefined);
    }, deps().pollIntervalMs);
    poll.unref?.();
    const stopTyping = startTypingBroadcast(channel, writer);
    let tokens = 0;
    let written: OutcomeWriterResult;
    try {
      written = await deps().writeOutcome({
        companyId: d.companyId,
        lead: writer,
        system: composeOutcomeSystemPrompt({
          companyName: co.name,
          lead: person(writer),
          soul: writer.soulBody,
          starter,
        }),
        request,
        people: { participants: people.map(person), members },
        signal: controller.signal,
        onUsage: (usage) => {
          tokens += Math.max(0, usage.inputTokens) + Math.max(0, usage.outputTokens);
        },
      });
    } catch (error) {
      written = { ok: false, error: errorText(error) };
    } finally {
      clearInterval(poll);
      stopTyping();
      onTurnAbort(() => {});
    }
    const after = await loadDiscussion(d.id);
    if (!after) return;
    await patch(d.id, { tokensUsed: after.tokensUsed + tokens });
    if (after.stopRequestedAt || controller.signal.aborted) {
      if (workBlocked(d.companyId).blocked) {
        await endWithoutOutcome(d.id, "stopped", "standdown", "Company AI work was stood down.");
      } else {
        await endWithoutOutcome(d.id, "stopped", "stopped", await stoppedByDetail(after.stopRequestedByUserId));
      }
      return;
    }
    if (written.ok) {
      const outcome: DiscussionOutcome = { ...written.outcome, writtenByEmployeeId: writer.id };
      const { row } = await insertChannelMessage({
        channel,
        author: { kind: "ai", employeeId: writer.id },
        content: renderOutcomeMarkdown(outcome),
        discussionId: d.id,
        discussionRole: "outcome",
        // Distilled from the transcript: if any turn read outside content, so
        // has the outcome.
        tainted: after.tainted,
      });
      const endedAt = deps().now();
      await patch(d.id, {
        status: "concluded",
        phase: "done",
        endReason: reason,
        endDetail: null,
        currentEmployeeId: null,
        outcomeJson: JSON.stringify(outcome),
        outcomeMessageId: row.id,
        endedAt,
      });
      await recordAudit({
        companyId: d.companyId,
        actorEmployeeId: writer.id,
        action: "group_discussion.conclude",
        targetType: "group_discussion",
        targetId: d.id,
        targetLabel: clipLine(d.question, 120),
        metadata: {
          endReason: reason,
          turnsTaken: after.turnsTaken,
          tokensUsed: after.tokensUsed + tokens,
          actionItems: outcome.actionItems.length,
        },
      });
      await notifyStarter(d, channel, `Your group discussion is done`, outcome.summary);
      await announce(d.id);
      return;
    }
    failure = written.error;
  }
  await endWithoutOutcome(
    d.id,
    "failed",
    reason,
    `The discussion ended because ${describeEndReason(reason)}, but no outcome could be written: ${clipLine(failure, 300)}`,
  );
  const ch = await AppDataSource.getRepository(Channel).findOneBy({ id: d.channelId });
  if (ch) await notifyStarter(d, ch, "Your group discussion ended without an outcome", failure);
}

async function outcomeTranscript(
  d: GroupDiscussion,
  employees: AIEmployee[],
): Promise<TranscriptLine[]> {
  const rows = await AppDataSource.getRepository(ChannelMessage).find({
    where: { discussionId: d.id },
    order: { createdAt: "ASC" },
  });
  const userIds = [...new Set(rows.map((m) => m.authorUserId).filter(Boolean))] as string[];
  const users = userIds.length
    ? await AppDataSource.getRepository(User).findBy({ id: In(userIds) })
    : [];
  const userName = new Map(users.map((u) => [u.id, u.name || u.email]));
  const empById = new Map(employees.map((e) => [e.id, e]));
  return rows
    .filter(
      (m) =>
        !m.deletedAt &&
        (m.discussionRole === "question" || m.discussionRole === "input" || m.discussionRole === "turn"),
    )
    .map((m) => {
      if (m.authorKind === "ai" && m.authorEmployeeId) {
        const e = empById.get(m.authorEmployeeId);
        return { speaker: e ? `${e.name} (@${e.slug})` : "A former AI colleague", role: e?.role ?? "", text: m.content };
      }
      return {
        speaker: `${(m.authorUserId && userName.get(m.authorUserId)) || "A Member"}`,
        role: m.discussionRole === "question" ? "Member, asked the question" : "Member",
        text: m.content,
      };
    });
}

async function channelMembersForPrompt(channelId: string): Promise<PromptMember[]> {
  const rows = await AppDataSource.getRepository(ChannelMember).find({
    where: { channelId, memberKind: "user" },
  });
  const ids = rows.map((r) => r.userId!).filter(Boolean);
  if (ids.length === 0) return [];
  const users = await AppDataSource.getRepository(User).findBy({ id: In(ids) });
  return users.map((u) => ({ id: u.id, name: u.name || u.email, handle: u.handle ?? null }));
}

/** The default outcome writer: the lead's own AI Model, one tool, no company access. */
async function writeOutcomeWithModel(args: Parameters<OutcomeWriter>[0]): Promise<OutcomeWriterResult> {
  const model = await resolveChatModel(args.lead.id);
  if (!model) return { ok: false, error: `${args.lead.name} has no AI Model connected.` };
  const box: { outcome: DiscussionOutcome | null; lastError: string } = {
    outcome: null,
    lastError: "",
  };
  const tool = createOutcomeTool(args.people, args.lead.id, box);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OUTCOME_TIMEOUT_MS);
  const forward = () => controller.abort();
  if (args.signal.aborted) controller.abort();
  else args.signal.addEventListener("abort", forward, { once: true });
  try {
    const result = await runRestrictedEmployeeAgent({
      model,
      employeeId: args.lead.id,
      system: args.system,
      messages: [{ role: "user", content: [{ type: "text", text: args.request }] }],
      tools: [tool],
      maxSteps: 3,
      signal: controller.signal,
      callbacks: { onUsage: args.onUsage },
    });
    if (box.outcome) return { ok: true, outcome: box.outcome };
    if (result.status === "error") return { ok: false, error: result.error };
    return {
      ok: false,
      error: box.lastError || `${args.lead.name} did not submit an outcome.`,
    };
  } finally {
    clearTimeout(timeout);
    args.signal.removeEventListener("abort", forward);
  }
}

/** Wall-clock ceiling on writing the outcome. */
const OUTCOME_TIMEOUT_MS = 4 * 60_000;

/**
 * The outcome writer's one tool. Exported so the tool's validation is pinned
 * by a test without a model in the loop.
 */
export function createOutcomeTool(
  people: { participants: PromptPerson[]; members: PromptMember[] },
  writerId: string,
  box: { outcome: DiscussionOutcome | null; lastError: string },
): AgentTool {
  return {
    name: "submit_discussion_outcome",
    description:
      "Submit the discussion's outcome for the Member: summary, recommendation, open questions, and who will do what. Call it exactly once.",
    inputSchema: OUTCOME_TOOL_INPUT_SCHEMA as unknown as Record<string, unknown>,
    run: async (input) => {
      const parsed = outcomeArgsSchema.safeParse(input);
      if (!parsed.success) {
        box.lastError = parsed.error.issues
          .map((i) => `${i.path.join(".") || "outcome"}: ${i.message}`)
          .join("; ");
        return {
          content: `The outcome was not accepted: ${box.lastError}. Fix it and call again.`,
          isError: true,
        };
      }
      box.outcome = resolveOutcome(parsed.data, people, writerId);
      return { content: "Outcome recorded." };
    },
  };
}

// ───────────────────────────── endings ─────────────────────────────

async function endWithoutOutcome(
  discussionId: string,
  status: "stopped" | "failed" | "interrupted",
  reason: GroupDiscussionEndReason,
  detail: string,
): Promise<void> {
  const result = await repo().update(
    { id: discussionId, status: "running" },
    {
      status,
      phase: "done",
      endReason: reason,
      endDetail: clipLine(detail, 480),
      currentEmployeeId: null,
      endedAt: deps().now(),
    },
  );
  if (!result.affected) return;
  const d = await loadDiscussion(discussionId);
  if (!d) return;
  await postNote(d, detail);
  await recordAudit({
    companyId: d.companyId,
    actorKind: "system",
    action: `group_discussion.${status}`,
    targetType: "group_discussion",
    targetId: d.id,
    targetLabel: clipLine(d.question, 120),
    metadata: { endReason: reason, turnsTaken: d.turnsTaken, tokensUsed: d.tokensUsed },
  });
  await announce(d.id);
}

/**
 * Close discussions whose driver died with its process. A discussion's
 * heartbeat is refreshed every few seconds while a process drives it, so one
 * gone quiet for minutes has nobody behind it; the next Member message in a
 * group chat starts a fresh one with this transcript in view.
 */
export async function sweepStaleGroupDiscussions(): Promise<number> {
  const running = await repo().find({ where: { status: "running" } });
  let closed = 0;
  for (const d of running) {
    if (localDrivers.has(d.id)) continue;
    if (!(await heartbeatIsStale(d))) continue;
    await endWithoutOutcome(
      d.id,
      "interrupted",
      "restart",
      d.round > 0
        ? `The discussion was cut off by a restart in round ${d.round}. Write again to pick it up.`
        : "The discussion was cut off by a restart before it began. Write again to start it.",
    );
    closed += 1;
  }
  return closed;
}

let sweepTimer: NodeJS.Timeout | null = null;

/** Close what a previous process left running, then keep sweeping. */
export async function bootGroupDiscussions(): Promise<void> {
  await sweepStaleGroupDiscussions().catch((error: unknown) => {
    // eslint-disable-next-line no-console
    console.error("[group-discussion] boot sweep failed:", error);
  });
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    void sweepStaleGroupDiscussions().catch(() => undefined);
  }, 60_000);
  sweepTimer.unref();
}

// ───────────────────────────── follow-through ─────────────────────────────

/**
 * "Start the work": every AI Employee the outcome gave something does its
 * share now, as an ordinary chat turn under the pressing Member's authority —
 * every Approval, review and delivery limit a direct request meets, and
 * tainted from the start when the discussion read outside content.
 */
export async function startDiscussionFollowThrough(params: {
  companyId: string;
  discussionId: string;
  requester: DiscussionRequester;
}): Promise<GroupDiscussionSummary> {
  const d = await getGroupDiscussion(params.companyId, params.discussionId);
  if (!d) throw new GroupDiscussionError("Discussion not found", 404);
  const access = await userHasChannelAccess({
    channelId: d.channelId,
    userId: params.requester.userId,
    companyId: d.companyId,
  });
  if (!access) throw new GroupDiscussionError("Discussion not found", 404);
  const outcome = parseOutcome(d.outcomeJson);
  if (d.status !== "concluded" || !outcome) {
    throw new GroupDiscussionError("There is no outcome to act on yet.", 409);
  }
  const participants = new Set(parseParticipants(d.participantsJson));
  const assignable = outcome.actionItems.filter(
    (item) => item.owner?.kind === "ai" && participants.has(item.owner.id),
  );
  if (assignable.length === 0) {
    throw new GroupDiscussionError("The outcome gives no AI Employee anything to do.", 409);
  }
  const claim = await repo().update(
    { id: d.id, followThroughStartedAt: IsNull() },
    { followThroughStartedAt: deps().now(), followThroughByUserId: params.requester.userId },
  );
  if (!claim.affected) {
    throw new GroupDiscussionError("The work has already been started.", 409);
  }
  const channel = await AppDataSource.getRepository(Channel).findOneBy({ id: d.channelId });
  if (!channel) throw new GroupDiscussionError("Discussion not found", 404);

  const items: DiscussionActionItem[] = outcome.actionItems.map((item) => ({
    ...item,
    status:
      item.owner?.kind === "ai" && participants.has(item.owner.id)
        ? "queued"
        : item.owner?.kind === "ai"
          ? "skipped"
          : undefined,
    ...(item.owner?.kind === "ai" && !participants.has(item.owner.id)
      ? { detail: "Not in the discussion." }
      : {}),
  }));
  await patch(d.id, { outcomeJson: JSON.stringify({ ...outcome, actionItems: items }) });

  const requester = await AppDataSource.getRepository(User).findOneBy({
    id: params.requester.userId,
  });
  const requesterName = requester?.name || requester?.email || "A Member";
  const owners = [
    ...new Set(items.filter((i) => i.status === "queued").map((i) => i.owner?.name ?? i.ownerLabel)),
  ];
  await postNote(d, `${requesterName} started the work for ${joinNames(owners)}.`);
  await recordAudit({
    companyId: d.companyId,
    actorUserId: params.requester.userId,
    action: "group_discussion.follow_through",
    targetType: "group_discussion",
    targetId: d.id,
    targetLabel: clipLine(d.question, 120),
    metadata: { owners: [...new Set(assignable.map((i) => i.owner!.id))] },
  });
  await announce(d.id);

  followThroughsInFlight.add(d.id);
  void runFollowThrough(d.id, channel, params.requester, requesterName).finally(() => {
    followThroughsInFlight.delete(d.id);
  });
  const fresh = await loadDiscussion(d.id);
  return summarizeDiscussion(fresh ?? d);
}

async function runFollowThrough(
  discussionId: string,
  channel: Channel,
  requester: DiscussionRequester,
  requesterName: string,
): Promise<void> {
  const d = await loadDiscussion(discussionId);
  if (!d) return;
  const outcome = parseOutcome(d.outcomeJson);
  if (!outcome) return;
  const owners = [
    ...new Set(
      outcome.actionItems
        .filter((i) => i.status === "queued" && i.owner?.kind === "ai")
        .map((i) => i.owner!.id),
    ),
  ];
  const employees = await AppDataSource.getRepository(AIEmployee).findBy({
    companyId: d.companyId,
    id: In(owners),
  });
  // Different employees work at once; each one's share is one turn.
  await Promise.all(
    owners.map(async (ownerId) => {
      const emp = employees.find((e) => e.id === ownerId);
      const mine = outcome.actionItems.filter(
        (i) => i.owner?.kind === "ai" && i.owner.id === ownerId && i.status === "queued",
      );
      if (!emp) {
        await setItemStatus(d.id, ownerId, "skipped", "No longer in the company.");
        return;
      }
      const block = workBlocked(d.companyId, { employeeId: emp.id });
      if (block.blocked) {
        await setItemStatus(d.id, ownerId, "skipped", `Stood down: ${block.reason}`);
        return;
      }
      await setItemStatus(d.id, ownerId, "working");
      const stopTyping = startTypingBroadcast(channel, emp);
      let result: ChatResult;
      try {
        const history = await followThroughHistory(d, emp.id);
        result = await deps().runTurn(
          d.companyId,
          emp.id,
          composeFollowThroughBrief({
            self: person(emp),
            requester: requesterName,
            question: d.question,
            outcome,
            items: mine,
          }),
          history,
          () => {},
          {
            requesterUserId: requester.userId,
            requesterSessionVersion: requester.sessionVersion,
            startTainted: d.tainted,
            workloadScope: `group-discussion-work:${d.id}:${emp.id}`,
          },
        );
      } catch (error) {
        result = { status: "error", reply: errorText(error), attachmentIds: [], sidecars: {} };
      } finally {
        stopTyping();
      }
      if (result.status === "ok") {
        await insertChannelMessage({
          channel,
          author: { kind: "ai", employeeId: emp.id },
          content: result.reply,
          attachmentIds: result.attachmentIds,
          discussionId: d.id,
          discussionRole: "follow_through",
          tainted: result.tainted === true || d.tainted,
        });
      } else {
        await postNote(d, `${emp.name} couldn't start on the work: ${clipLine(result.reply, 300)}`);
      }
      await setItemStatus(
        d.id,
        ownerId,
        result.status === "ok" ? "done" : "failed",
        result.status === "ok" ? undefined : clipLine(result.reply, 200),
      );
    }),
  );
}

/** Serialize item-status writes so parallel owners cannot overwrite each other. */
let itemStatusLane: Promise<void> = Promise.resolve();

function setItemStatus(
  discussionId: string,
  ownerId: string,
  status: NonNullable<DiscussionActionItem["status"]>,
  detail?: string,
): Promise<void> {
  itemStatusLane = itemStatusLane.then(async () => {
    const d = await loadDiscussion(discussionId);
    const outcome = d ? parseOutcome(d.outcomeJson) : null;
    if (!d || !outcome) return;
    const items = outcome.actionItems.map((item) =>
      item.owner?.kind === "ai" && item.owner.id === ownerId && item.status !== "skipped"
        ? { ...item, status, ...(detail ? { detail } : { detail: undefined }) }
        : item,
    );
    await patch(d.id, { outcomeJson: JSON.stringify({ ...outcome, actionItems: items }) });
    await announce(d.id);
  }).catch(() => undefined);
  return itemStatusLane;
}

async function followThroughHistory(d: GroupDiscussion, employeeId: string): Promise<ChatTurn[]> {
  const employees = await AppDataSource.getRepository(AIEmployee).findBy({
    companyId: d.companyId,
  });
  const lines = await outcomeTranscript(d, employees);
  const own = employees.find((e) => e.id === employeeId);
  return lines.slice(-FULL_RECENT_MESSAGES).map((line) =>
    own && line.speaker.startsWith(`${own.name} (@${own.slug})`)
      ? { role: "assistant" as const, content: line.text }
      : { role: "user" as const, content: `${line.speaker}: ${clipText(line.text, OLDER_MESSAGE_CHARS)}` },
  );
}

// ───────────────────────────── helpers ─────────────────────────────

async function postNote(d: GroupDiscussion, text: string): Promise<void> {
  const channel = await AppDataSource.getRepository(Channel).findOneBy({ id: d.channelId });
  if (!channel) return;
  await insertChannelMessage({
    channel,
    author: { kind: "system", name: "Genosyn" },
    content: text,
    discussionId: d.id,
    discussionRole: "note" satisfies ChannelMessageDiscussionRole,
  });
}

async function notifyStarter(
  d: GroupDiscussion,
  channel: Channel,
  title: string,
  body: string,
): Promise<void> {
  if (!d.startedByUserId) return;
  const company = await AppDataSource.getRepository(Company).findOneBy({ id: d.companyId });
  if (!company) return;
  await createNotifications([
    {
      companyId: d.companyId,
      userId: d.startedByUserId,
      kind: "group_discussion",
      title: `${title}: ${clipLine(d.question, 80)}`,
      body: clipLine(body, 200),
      link: `/c/${company.slug}/workspace/${channel.id}`,
      actorKind: "system",
      actorId: null,
      entityKind: "group_discussion",
      entityId: d.id,
    },
  ]).catch(() => undefined);
}

async function starterName(d: GroupDiscussion): Promise<string> {
  if (!d.startedByUserId) return "A Member";
  const user = await AppDataSource.getRepository(User).findOneBy({ id: d.startedByUserId });
  return user?.name || user?.email || "A Member";
}

function person(e: AIEmployee): PromptPerson {
  return { id: e.id, name: e.name, slug: e.slug, role: e.role };
}

function clipLine(text: string, max: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
}

function clipText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** For tests: whether this process is driving a discussion right now. */
export function isDrivingGroupDiscussion(discussionId: string): boolean {
  return localDrivers.has(discussionId);
}

/** For tests: a fresh id that is not any discussion's. */
export function unusedDiscussionId(): string {
  return randomUUID();
}
