import { randomUUID } from "node:crypto";
import { In, IsNull, LessThanOrEqual } from "typeorm";

import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Channel } from "../db/entities/Channel.js";
import { ChannelMessage } from "../db/entities/ChannelMessage.js";
import {
  ChannelTurn,
  type ChannelTurnAuthority,
  type ChannelTurnStatus,
  type ChannelTurnWait,
} from "../db/entities/ChannelTurn.js";
import { User } from "../db/entities/User.js";
import {
  MODEL_RESUMING_WAIT_CAUSE,
  MODEL_UNAVAILABLE_WAIT_CAUSE,
  type ChatActivityEvent,
} from "../../shared/chatActivity.js";
import type { AgentProgress } from "./agent/types.js";
import {
  CHAT_HARD_TIMEOUT_MS,
  INTERRUPTED_BEFORE_REPLY,
  stoodDownReply,
  streamChatWithEmployee,
  type ChatOptions,
  type ChatResult,
} from "./chat.js";
import {
  ChatTurnActivityRecorder,
  lastChatActivity,
  listChatActivity,
  nextChatActivityOrdinal,
  summarizeChatActivity,
} from "./chatTurnActivity.js";
import { followChatTurn, type FollowSource } from "./chatTurnFollow.js";
import { openLiveTurn, releaseLiveTurn, type LiveTurn } from "./chatTurnLive.js";
import { createReplyTextSnapshotter } from "./chatTurnProgress.js";
import {
  announceChannelTurn,
  channelTurnAuthority,
  runningChannelTurns,
  summarizeChannelTurns,
  type ChannelTurnSummary,
} from "./channelTurnViews.js";
import {
  activityEventFor,
  turnActivityAccess,
  type TurnActivityAccess,
} from "../../shared/turnActivityAccess.js";
import {
  isModelAvailable,
  keyWorkGate,
  modelAvailabilityKey,
  modelAvailabilityState,
  noteKeyWorkStarted,
  onModelAvailabilityChange,
} from "./modelAvailability.js";
import { resolveChatModel } from "./models.js";
import { workBlocked } from "./standdowns.js";
import { captureTurnActionsForAuthority } from "./turnActions.js";
import { EmployeeWorkloadBusyError, releaseChatWorkloadLeaseByOwner } from "./workloadLeases.js";
import {
  composeChannelReplyPrompt,
  getMessageSummary,
  insertChannelMessage,
  startTypingBroadcast,
  userHasChannelAccess,
} from "./workspaceChat.js";

/**
 * An AI Employee's turns in Workspace channels, DMs and group chats.
 *
 * ## Replies
 *
 * An @mention — or any message in a DM with an AI Employee — starts one reply
 * turn per AI Employee asked (`enqueueChannelReplies`), all at once. Each is a
 * {@link ChannelTurn} row, run here the way a direct chat runs a durable turn
 * (`durableChatTurns.ts`), with the same building blocks:
 *
 *   - the activity recorder (`chatTurnActivity.ts`) writes every tool call and
 *     result, thinking summary, milestone and reason to wait as the chat
 *     feed's rows, scoped to the channel, and hands each to the turn's live
 *     record (`chatTurnLive.ts`) in the same tick;
 *   - everyone who can read the room follows the turn over its own stream
 *     (`chatTurnFollow.ts`), seeing what `shared/turnActivityAccess.ts` lets
 *     them: the Member whose authority it runs under sees everything, the
 *     rest of the room sees the steps;
 *   - a worker claims it with a short lease it renews; a restart that cuts it
 *     off hands it to the next worker as a later attempt, told to check what
 *     the first one did.
 *
 * A reply is not a Member's private conversation, which is why it is not a
 * `ConversationMessage`: several people read it, it may run under a Member's
 * authority, an AI colleague's or nobody's, its history is the channel's own
 * transcript, and what it writes is a channel message.
 *
 * ## Waiting instead of failing
 *
 * While the reply's AI Model is unavailable (`modelAvailability.ts`) the turn
 * stays `working`, unclaimed, and says so in the room with the chat's
 * `model_unavailable` wait — the same words, the same cause. It is looked at
 * again at the model's next check (at most every 30 seconds) and at once when
 * the model answers again; replies that waited then start one at a time, on
 * the same recovery pacing Routine Runs follow (`keyWorkGate`). Another reply
 * of the same AI Employee in the same channel makes it wait its turn
 * (`thread_busy`) rather than answer "busy". A Standdown placed meanwhile
 * wins: the turn ends saying so and never reaches the AI Model. Stop cancels a
 * waiting reply like a running one.
 *
 * ## Discussion turns and follow-through shares
 *
 * A group discussion drives its own turns (`groupDiscussions.ts`), bounded
 * and stopped by the discussion. Each still gets a `ChannelTurn` here
 * (`beginDrivenChannelTurn`) so the room watches the speaker work exactly as
 * it watches a reply; its lease only says the driver is alive, and a turn
 * whose driver died with its process is closed by the sweep.
 */

const TURN_LEASE_MS = 15_000;
const TURN_HEARTBEAT_MS = 5_000;
const RECOVERY_POLL_MS = 5_000;
const BUSY_RETRY_MS = 15_000;
const MAX_RECOVERIES_PER_SWEEP = 10;
/** The longest a reply waiting for its AI Model goes between looks. */
const MODEL_WAIT_LOOK_MS = 30_000;
/** How often the reply's text so far is saved while it streams. */
const REPLY_SNAPSHOT_MS = 1_500;
/** A discussion's driver proves it is alive this often… */
const DRIVEN_HEARTBEAT_MS = 20_000;
/** …and a driven turn whose driver has not for this long died with it. */
const DRIVEN_LEASE_MS = 90_000;

export type ChannelTurnOutcome = "completed" | "deferred" | "claimed_elsewhere";

/** Why a worker picked a reply up. */
type StartReason = "start" | "resume" | "retry" | "model_back";

/** A request about a turn the server cannot honor, with the HTTP status that says why. */
export class ChannelTurnError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409,
  ) {
    super(message);
    this.name = "ChannelTurnError";
  }
}

let recoveryTimer: NodeJS.Timeout | null = null;
const locallyExecuting = new Set<string>();
const activeClaimAborters = new Map<string, () => void>();
/** Returns false when this process no longer owns the turn it registered for. */
const activeInterrupters = new Map<string, (byUserId: string, byName: string | null) => boolean>();
/** Every turn this process started, for tests that wait for the room to settle. */
const inFlight = new Set<Promise<unknown>>();

function repo() {
  return AppDataSource.getRepository(ChannelTurn);
}

function track<T>(work: Promise<T>): Promise<T> {
  inFlight.add(work);
  void work.finally(() => inFlight.delete(work)).catch(() => undefined);
  return work;
}

/** Resolves once every turn this process started has stopped running. Tests. */
export async function settleChannelTurnsForTests(): Promise<void> {
  while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
}

async function userName(userId: string | null): Promise<string | null> {
  if (!userId) return null;
  const user = await AppDataSource.getRepository(User).findOne({
    where: { id: userId },
    select: { id: true, name: true, email: true },
  });
  return user ? user.name || user.email : null;
}

// ───────────────────────────── starting ─────────────────────────────

/**
 * Start one reply turn per AI Employee asked to answer `trigger`, under the
 * authority the message carries. Returns once every turn is recorded and
 * announced; the turns run on in the background.
 */
export async function enqueueChannelReplies(args: {
  channel: Pick<Channel, "id" | "companyId">;
  trigger: Pick<ChannelMessage, "id">;
  employees: Array<Pick<AIEmployee, "id">>;
  authority: ChannelTurnAuthority;
  requester: { userId: string; sessionVersion: number } | null;
  /** A Retry of an earlier reply to the same message. */
  resumeAs?: "retry";
}): Promise<ChannelTurn[]> {
  const now = Date.now();
  const member = args.authority === "member" && args.requester !== null;
  const turns: ChannelTurn[] = [];
  for (const employee of args.employees) {
    turns.push(
      await repo().save(
        repo().create({
          companyId: args.channel.companyId,
          channelId: args.channel.id,
          employeeId: employee.id,
          kind: "reply",
          triggerMessageId: args.trigger.id,
          discussionId: null,
          round: null,
          authority: member ? "member" : args.authority === "member" ? "untrusted" : args.authority,
          requesterUserId: member ? args.requester!.userId : null,
          requesterSessionVersion: member ? args.requester!.sessionVersion : null,
          status: "working",
          waitingFor: null,
          resumeAs: args.resumeAs ?? null,
          workerId: null,
          leaseExpiresAt: null,
          attempt: 0,
          acceptedAt: new Date(now),
          deadlineAt: new Date(now + CHAT_HARD_TIMEOUT_MS),
          endedAt: null,
          stoppedByUserId: null,
          replyMessageId: null,
          tainted: false,
          replyText: "",
          activityJson: "",
        }),
      ),
    );
  }
  for (const turn of turns) await announceChannelTurn(turn);
  for (const turn of turns) runLocally(turn.id);
  return turns;
}

function runLocally(turnId: string): void {
  if (locallyExecuting.has(turnId)) return;
  locallyExecuting.add(turnId);
  void track(
    executeChannelTurn(turnId)
      .catch((error) => {
        // eslint-disable-next-line no-console
        console.error(`[channel-turns] turn ${turnId} failed:`, error);
      })
      .finally(() => locallyExecuting.delete(turnId)),
  );
}

// ───────────────────────────── running a reply ─────────────────────────────

type ClaimedTurn = { turn: ChannelTurn; workerId: string; reason: StartReason };

/**
 * Atomically claim one reply that is due. The short lease is renewed while it
 * runs; after a crash it lapses quickly and exactly one worker wins it back.
 */
export async function claimChannelTurn(
  turnId: string,
  now: Date = new Date(),
  workerId: string = randomUUID(),
): Promise<ClaimedTurn | null> {
  const claimed = await repo()
    .createQueryBuilder()
    .update(ChannelTurn)
    .set({
      workerId,
      leaseExpiresAt: new Date(now.getTime() + TURN_LEASE_MS),
      attempt: () => '"attempt" + 1',
    })
    .where("id = :turnId", { turnId })
    .andWhere("kind = :kind", { kind: "reply" })
    .andWhere("status = :status", { status: "working" })
    .andWhere('("leaseExpiresAt" IS NULL OR "leaseExpiresAt" <= :now)', { now })
    .execute();
  if (claimed.affected !== 1) return null;
  const turn = await repo().findOneBy({ id: turnId });
  if (!turn) return null;
  // `attempt` counts pickups that reached the AI Model — a wait that never got
  // there gives its pickup back — so anything past the first that is not a
  // Retry or a return from an outage was cut off by a restart.
  const reason: StartReason =
    turn.resumeAs === "retry"
      ? "retry"
      : turn.resumeAs === "model_back"
        ? "model_back"
        : turn.attempt > 1
          ? "resume"
          : "start";
  return { turn, workerId, reason };
}

/** The live and persisted activity of a turn this process is running. */
type TurnActivity = { recorder: ChatTurnActivityRecorder; live: LiveTurn };

/**
 * Run a reply under its renewable claim: from the first pickup, a recovery
 * after a restart, a look while it waits, or a Retry. All durable state
 * transitions are conditional on still holding the claim.
 */
export async function executeChannelTurn(turnId: string): Promise<ChannelTurnOutcome> {
  const claimed = await claimChannelTurn(turnId);
  if (!claimed) return "claimed_elsewhere";
  const { turn, workerId, reason } = claimed;
  const controller = new AbortController();
  // Written from callbacks, read after awaits: held in one object so every
  // read sees the latest value.
  const run: {
    lostClaim: boolean;
    interrupted: boolean;
    stoppedBy: { userId: string; name: string | null } | null;
    workStarted: boolean;
    activity: TurnActivity | null;
    stopTyping: (() => void) | null;
    streamed: string;
  } = {
    lostClaim: false,
    interrupted: false,
    stoppedBy: null,
    workStarted: false,
    activity: null,
    stopTyping: null,
    streamed: "",
  };

  const loseClaim = () => {
    run.lostClaim = true;
    controller.abort();
  };
  // Not `loseClaim`: this worker keeps the claim so it can write what the
  // room already read. Reports whether it took effect: a worker that already
  // lost the turn cannot stop it.
  const interrupt = (byUserId: string, byName: string | null): boolean => {
    if (run.lostClaim) return false;
    run.interrupted = true;
    run.stoppedBy = { userId: byUserId, name: byName };
    run.activity?.recorder.stopped(byName);
    controller.abort();
    return true;
  };
  activeClaimAborters.set(turn.id, loseClaim);
  activeInterrupters.set(turn.id, interrupt);

  let renewing = false;
  const renewClaim = async () => {
    if (renewing || run.lostClaim) return;
    renewing = true;
    try {
      const renewed = await repo().update(
        { id: turn.id, status: "working", workerId },
        { leaseExpiresAt: new Date(Date.now() + TURN_LEASE_MS) },
      );
      if (renewed.affected !== 1) loseClaim();
    } catch {
      // Carrying on while the database cannot renew would let another worker
      // claim the same reply. Stop, and let recovery take it back.
      loseClaim();
    } finally {
      renewing = false;
    }
  };
  const heartbeat = setInterval(() => void renewClaim(), TURN_HEARTBEAT_MS);
  heartbeat.unref?.();

  const snapshot = createReplyTextSnapshotter({
    intervalMs: REPLY_SNAPSHOT_MS,
    save: (text) =>
      repo().update({ id: turn.id, status: "working", workerId }, { replyText: text }),
    onPersistenceError: (error) => {
      // eslint-disable-next-line no-console
      console.error(`[channel-turns] reply snapshot failed turn=${turn.id}`, error);
    },
  });

  const end = (outcome: ReplyOutcome) =>
    finalizeReply({
      turn,
      workerId,
      activity: run.activity,
      outcome,
      stoppedBy: run.stoppedBy,
      snapshot,
    });
  const endStopped = () =>
    end({ status: "interrupted", reply: run.streamed.trim() || INTERRUPTED_BEFORE_REPLY });
  const letGo = async (): Promise<ChannelTurnOutcome> => {
    await run.activity?.recorder.close();
    run.activity?.live.detach();
    return "claimed_elsewhere";
  };

  try {
    const [channel, employee, trigger] = await Promise.all([
      AppDataSource.getRepository(Channel).findOneBy({ id: turn.channelId }),
      AppDataSource.getRepository(AIEmployee).findOneBy({
        id: turn.employeeId,
        companyId: turn.companyId,
      }),
      turn.triggerMessageId
        ? AppDataSource.getRepository(ChannelMessage).findOneBy({ id: turn.triggerMessageId })
        : Promise.resolve(null),
    ]);
    const live = openLiveTurn(turn.id, turn.channelId);
    const recorder = new ChatTurnActivityRecorder(
      {
        companyId: turn.companyId,
        conversationId: turn.channelId,
        messageId: turn.id,
        attempt: Math.max(1, turn.attempt),
      },
      await nextChatActivityOrdinal(turn.id),
      { live },
    );
    const activity: TurnActivity = { recorder, live };
    run.activity = activity;
    if (run.interrupted) recorder.stopped(run.stoppedBy?.name ?? null);

    // Nobody can read the answer, or there is nothing left to answer.
    if (!channel || channel.archivedAt) {
      recorder.notice("ended", "The conversation was archived before the reply was written");
      return await end({ status: "interrupted", reply: null });
    }
    if (!employee) {
      recorder.notice("ended", "The AI Employee no longer exists");
      return await end({ status: "error", reply: null });
    }
    if (!trigger || trigger.deletedAt || trigger.channelId !== channel.id) {
      recorder.notice("ended", "The message it was answering was deleted");
      return await end({ status: "interrupted", reply: null });
    }
    if (run.interrupted) return await endStopped();

    // A Standdown placed while the reply waited wins over everything else:
    // the turn ends saying so, and never reaches the AI Model.
    const block = workBlocked(turn.companyId, { employeeId: employee.id });
    if (block.blocked) {
      return await end({ status: "error", reply: stoodDownReply(employee.name, block.reason) });
    }

    // The Member whose authority it runs under must still be able to read
    // the room it answers in. (Their membership and sign-in are re-checked
    // where every chat turn checks them.)
    if (turn.authority === "member" && turn.requesterUserId) {
      const allowed = await userHasChannelAccess({
        channelId: channel.id,
        userId: turn.requesterUserId,
        companyId: turn.companyId,
      });
      if (!allowed) {
        return await end({
          status: "error",
          reply: `${employee.name} didn't answer: the Member who asked can no longer read this conversation.`,
        });
      }
    }

    const waitFor = (waitingFor: ChannelTurnWait, lookAt: Date, started: boolean) =>
      defer({
        turn,
        workerId,
        activity,
        started,
        waitingFor,
        lookAt,
        isInterrupted: () => run.interrupted,
        onInterrupted: endStopped,
      });

    // The AI Model is unavailable: wait, saying so where the room is looking.
    const model = await resolveChatModel(employee.id);
    if (model && !isModelAvailable(model)) {
      return await waitFor("model_unavailable", nextModelLook(model), false);
    }
    // Back after an outage: the replies that waited start one at a time.
    if (model && (turn.waitingFor === "model_unavailable" || turn.waitingFor === "model_resuming")) {
      const key = modelAvailabilityKey(model);
      const gate = keyWorkGate(key);
      if (gate.gate === "paced") return await waitFor("model_resuming", new Date(gate.at), false);
      noteKeyWorkStarted(key);
    }

    const deadline = turn.deadlineAt ?? new Date(turn.acceptedAt.getTime() + CHAT_HARD_TIMEOUT_MS);
    const remainingMs = deadline.getTime() - Date.now();
    if (remainingMs <= 0) {
      return await end({
        status: "error",
        reply: `${employee.name} couldn't finish this reply within its six-hour limit.`,
      });
    }

    const built = await composeChannelReplyPrompt({
      channel,
      trigger,
      employeeId: employee.id,
    });
    const prompt =
      reason === "start" ? built.prompt : built.prompt + (await recoveryNote(turn, trigger));
    const tainted = turn.tainted || built.tainted;
    // Running now: no longer waiting, and the room is told.
    await repo().update({ id: turn.id, status: "working", workerId }, { waitingFor: null, tainted });
    turn.tainted = tainted;
    if (turn.waitingFor !== null) {
      turn.waitingFor = null;
      await announceChannelTurn(turn.id);
    }

    const base: Omit<ChatOptions, "requesterUserId" | "requesterSessionVersion" | "toolAuthority"> =
      {
        images: built.images,
        // One channel is one transcript, so that is what the reply serializes
        // on: a second reply of the same AI Employee here waits its turn,
        // while a colleague's runs alongside.
        workloadScope: `workspace-channel:${channel.id}`,
        workloadKey: turn.id,
        throwOnWorkloadUnavailable: true,
        // Replaying words a tainted turn wrote taints this one too.
        startTainted: tainted,
        timeoutMs: remainingMs,
        signal: controller.signal,
        wasInterrupted: () => run.interrupted,
        // The room is shown that the AI Model thought; only the asker sees
        // the words (`shared/turnActivityAccess.ts`).
        reasoningSummaries: true,
        onProgress: (progress: AgentProgress) => {
          recorder.progress(progress);
          live.progress(progress);
        },
        onWorkStarted: () => {
          run.workStarted = true;
          recorder.turnStarted(reason);
          run.stopTyping = startTypingBroadcast(channel, employee);
          if (turn.resumeAs) {
            void repo()
              .update({ id: turn.id, status: "working", workerId }, { resumeAs: null })
              .catch(() => undefined);
          }
        },
        onSensitiveValues: (values) => recorder.setSensitiveValues(values),
        onPayloadsWithheld: (why) => recorder.withholdPayloads(why),
        activity: recorderCallbacks(recorder),
      };
    const options: ChatOptions =
      turn.authority === "member" &&
      turn.requesterUserId &&
      typeof turn.requesterSessionVersion === "number"
        ? {
            ...base,
            requesterUserId: turn.requesterUserId,
            requesterSessionVersion: turn.requesterSessionVersion,
          }
        : { ...base, toolAuthority: turn.authority === "employee" ? "employee" : "untrusted" };

    let result: ChatResult;
    try {
      result = await streamChatWithEmployee(
        turn.companyId,
        employee.id,
        prompt,
        built.history,
        (chunk) => {
          run.streamed += chunk;
          live.appendText(chunk);
          snapshot.report(run.streamed);
        },
        options,
      );
    } catch (error) {
      // Checked ahead of claim loss and contention: a stop the room asked
      // for has to become terminal on every path.
      if (run.interrupted) return await endStopped();
      if (run.lostClaim) return await letGo();
      if (error instanceof EmployeeWorkloadBusyError) {
        return await waitFor("thread_busy", new Date(Date.now() + BUSY_RETRY_MS), false);
      }
      throw error;
    } finally {
      run.stopTyping?.();
      run.stopTyping = null;
    }

    await snapshot.flush();
    if (!run.lostClaim) await renewClaim();
    if (run.lostClaim && !run.interrupted) return await letGo();
    // The AI Model became unavailable mid-turn: the reply waits and is
    // written when it is back. A stop the room asked for still ends it.
    if (result.status === "error" && result.unavailable && !run.interrupted) {
      return await waitFor("model_unavailable", nextModelLook(model), run.workStarted);
    }
    if (run.interrupted) {
      return await end({
        status: "interrupted",
        reply: result.reply.trim() || run.streamed.trim() || INTERRUPTED_BEFORE_REPLY,
        attachmentIds: result.attachmentIds,
        tainted: tainted || result.tainted === true,
      });
    }
    return await end({
      status: result.status === "busy" ? "error" : result.status,
      reply: result.reply,
      attachmentIds: result.attachmentIds,
      tainted: tainted || result.tainted === true,
    });
  } catch (error) {
    if (run.interrupted) return endStopped();
    if (run.lostClaim) return letGo();
    // eslint-disable-next-line no-console
    console.error(`[channel-turns] reply failed turn=${turn.id}`, error);
    const detail = (error instanceof Error ? error.message : String(error))
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 300);
    return end({
      status: "error",
      reply: `Genosyn couldn't complete this reply. ${detail || "An unexpected error occurred."}`,
    });
  } finally {
    snapshot.cancel();
    run.stopTyping?.();
    clearInterval(heartbeat);
    activeClaimAborters.delete(turn.id);
    activeInterrupters.delete(turn.id);
    if (run.activity) {
      // Every path above ended the live record; this only covers a throw
      // between two of them, so no reader is left following a dead turn.
      run.activity.live.detach();
      releaseLiveTurn(run.activity.live);
    }
  }
}

/** How a reply ended. `reply: null` ends it without a message. */
type ReplyOutcome = {
  status: Exclude<ChannelTurnStatus, "working">;
  reply: string | null;
  attachmentIds?: string[];
  tainted?: boolean;
};

/** When a reply waiting for its AI Model is looked at next: its next check, within bounds. */
function nextModelLook(model: Awaited<ReturnType<typeof resolveChatModel>>): Date {
  const now = Date.now();
  const state = model ? modelAvailabilityState(model) : { available: true as const };
  return new Date(
    state.available
      ? now + BUSY_RETRY_MS
      : Math.min(Math.max(state.nextCheckAt.getTime(), now + 1_000), now + MODEL_WAIT_LOOK_MS),
  );
}

/** Every runtime callback a turn's activity listens to, wired into one recorder. */
function recorderCallbacks(recorder: ChatTurnActivityRecorder): NonNullable<ChatOptions["activity"]> {
  return {
    onToolUse: (name, input, callId) => recorder.toolUse(name, input, callId),
    onToolResult: (name, result, callId) => recorder.toolResult(name, result, callId),
    onReasoning: (delta, block) => recorder.reasoning(delta, block),
    onReasoningEnd: (block) => recorder.reasoningEnd(block),
    onModelRetry: (retry) => recorder.modelRetry(retry),
    onModelOutage: (outage) => recorder.modelOutage(outage),
    onRuntimeWait: (wait) => recorder.runtimeWait(wait),
    onCompact: (info) => recorder.compact(info),
    onApiKeyFailover: (change) => recorder.apiKeyFailover(change),
    onServedModelChange: (change) => recorder.servedModelChange(change),
    onBackgroundWork: (pending) => recorder.backgroundWork(pending),
    onThinkingFallback: (fallback) => recorder.thinkingFallback(fallback),
  };
}


/**
 * The note a later attempt gets: a previous one did not finish, and what it
 * changed. Counted from the message it answers, so a Retry — a new turn for
 * the same message — sees what every earlier turn for it did.
 */
async function recoveryNote(
  turn: ChannelTurn,
  trigger: Pick<ChannelMessage, "createdAt">,
): Promise<string> {
  let lines = "- No completed database mutations were recorded.";
  try {
    const actions = await captureTurnActionsForAuthority({
      companyId: turn.companyId,
      employeeId: turn.employeeId,
      since: new Date(trigger.createdAt.getTime() - 10),
      authority: turn.authority,
    });
    if (actions.length > 0) {
      lines = actions
        .slice(-20)
        .map((action) => `- ${action.action}: ${action.targetLabel || action.targetType}`)
        .join("\n");
    }
  } catch {
    // The note stands without the list.
  }
  return [
    "",
    "",
    "## Durable recovery note",
    `A previous attempt at this same request did not finish — the server restarted mid-turn, the AI Model became unavailable and the request waited for it, or it ended in an error and a Member asked for a retry. This is attempt ${Math.max(2, turn.attempt)}.`,
    "Inspect the current workspace and company state before changing anything. Continue completed work and do not repeat side effects.",
    "Recorded mutations from all attempts so far:",
    lines,
  ].join("\n");
}

/** One line in the room for a whole wait, however many times the reply is looked at. */
async function recordWaitOnce(
  activity: TurnActivity,
  turnId: string,
  cause: string,
): Promise<void> {
  const last: ChatActivityEvent | null =
    activity.live.lastEvent ?? (await lastChatActivity(turnId));
  const already =
    last?.kind === "waiting" &&
    last.name === cause &&
    (last.detail as { state?: string } | null)?.state === "waiting";
  if (!already) activity.recorder.waiting(cause);
  await activity.recorder.flush();
}

/**
 * Put a reply back to wait, still `working`, unclaimed, looked at again at
 * `lookAt`. A pickup that never reached the AI Model is given back, so its
 * next is still its start; one an outage cut short keeps it, and starts
 * again told to check what it already did.
 */
async function defer(args: {
  turn: ChannelTurn;
  workerId: string;
  activity: TurnActivity;
  started: boolean;
  waitingFor: ChannelTurnWait;
  lookAt: Date;
  isInterrupted: () => boolean;
  onInterrupted: () => Promise<ChannelTurnOutcome>;
}): Promise<ChannelTurnOutcome> {
  const { turn, activity } = args;
  await recordWaitOnce(
    activity,
    turn.id,
    args.waitingFor === "model_unavailable"
      ? MODEL_UNAVAILABLE_WAIT_CAUSE
      : args.waitingFor === "model_resuming"
        ? MODEL_RESUMING_WAIT_CAUSE
        : "thread_busy",
  );
  const now = Date.now();
  const deferred = await repo().update(
    { id: turn.id, status: "working", workerId: args.workerId },
    {
      workerId: null,
      leaseExpiresAt: args.lookAt,
      waitingFor: args.waitingFor,
      // Waiting is not work: the six-hour limit starts over when it can run.
      ...(args.waitingFor === "model_unavailable"
        ? { deadlineAt: new Date(now + CHAT_HARD_TIMEOUT_MS) }
        : {}),
      ...(args.started
        ? // Nothing half-written is kept as the answer; the next attempt starts over.
          { resumeAs: "model_back" as const, replyText: "" }
        : { attempt: Math.max(0, turn.attempt - 1) }),
    },
  );
  if (deferred.affected !== 1) {
    await activity.recorder.close();
    activity.live.detach();
    return "claimed_elsewhere";
  }
  // A stop that landed inside that write still has to stick.
  if (args.isInterrupted()) return args.onInterrupted();
  await activity.recorder.close();
  activity.live.detach();
  if (turn.waitingFor !== args.waitingFor) {
    turn.waitingFor = args.waitingFor;
    await announceChannelTurn(turn.id);
  }
  return "deferred";
}

/**
 * End a reply: the row first, conditionally, so only the worker holding the
 * claim — or, for a stop, whoever is left — writes the end; then the
 * activity's summary; then the reply itself, into the room. `reply: null`
 * ends it without a message (the room is gone, or the message it answered).
 */
async function finalizeReply(args: {
  turn: ChannelTurn;
  workerId: string;
  activity: TurnActivity | null;
  outcome: ReplyOutcome;
  stoppedBy: { userId: string; name: string | null } | null;
  snapshot: { flush: () => Promise<void>; cancel: () => void };
}): Promise<ChannelTurnOutcome> {
  const { turn, activity, outcome } = args;
  args.snapshot.cancel();
  await args.snapshot.flush();
  const interrupted = outcome.status === "interrupted" && args.stoppedBy !== null;
  if (interrupted) activity?.recorder.stopped(args.stoppedBy?.name ?? null);
  const summary =
    activity?.recorder.summarize({ status: outcome.status, startedAt: turn.acceptedAt }) ?? null;
  const tainted = turn.tainted || outcome.tainted === true;
  const patch = {
    status: outcome.status,
    waitingFor: null,
    resumeAs: null,
    workerId: null,
    leaseExpiresAt: null,
    endedAt: new Date(),
    tainted,
    replyText: outcome.reply ?? "",
    stoppedByUserId: args.stoppedBy?.userId ?? null,
    ...(summary ? { activityJson: JSON.stringify(summary) } : {}),
  };
  let finalized = await repo().update(
    { id: turn.id, status: "working", workerId: args.workerId },
    patch,
  );
  // A stop has to become terminal even when this worker was overtaken.
  if (finalized.affected !== 1 && interrupted) {
    finalized = await repo().update({ id: turn.id, status: "working" }, patch);
  }
  if (finalized.affected !== 1) {
    await activity?.recorder.close();
    activity?.live.detach();
    return "claimed_elsewhere";
  }
  if (interrupted) await releaseChatWorkloadLeaseByOwner(turn.id);
  if (activity && summary) await activity.recorder.finish(summary);
  await postReply(turn, outcome.reply, outcome.attachmentIds ?? [], tainted);
  activity?.live.finish();
  await announceChannelTurn(turn.id);
  return "completed";
}

/** Write a turn's reply into its room, linked to the turn. Never fails the turn. */
async function postReply(
  turn: ChannelTurn,
  reply: string | null,
  attachmentIds: string[],
  tainted: boolean,
): Promise<void> {
  if (reply === null) return;
  try {
    const channel = await AppDataSource.getRepository(Channel).findOneBy({ id: turn.channelId });
    if (!channel || channel.archivedAt) return;
    await insertChannelMessage({
      channel,
      author: { kind: "ai", employeeId: turn.employeeId },
      content: reply,
      attachmentIds,
      tainted,
      turnId: turn.id,
    });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`[channel-turns] could not post the reply of turn ${turn.id}`, error);
  }
}

// ───────────────────────────── stopping and retrying ─────────────────────────────

/**
 * Stop a reply, running or waiting. Anyone who can read the room may — the
 * same as a group discussion's Stop — and the activity names who did. What
 * the room already read is kept as the reply; a reply that had not started
 * says so.
 */
export async function interruptChannelTurn(args: {
  companyId: string;
  channelId: string;
  turnId: string;
  byUserId: string;
}): Promise<"interrupted" | "not_running"> {
  const allowed = await userHasChannelAccess({
    channelId: args.channelId,
    userId: args.byUserId,
    companyId: args.companyId,
  });
  const turn = allowed
    ? await repo().findOneBy({
        id: args.turnId,
        companyId: args.companyId,
        channelId: args.channelId,
      })
    : null;
  if (!turn) throw new ChannelTurnError("Reply not found", 404);
  if (turn.kind !== "reply") {
    throw new ChannelTurnError("Stop the discussion instead — it owns this turn.", 409);
  }
  const byName = await userName(args.byUserId);
  if (activeInterrupters.get(turn.id)?.(args.byUserId, byName)) return "interrupted";
  if (turn.status !== "working") return "not_running";

  const kept = turn.replyText.trim() || INTERRUPTED_BEFORE_REPLY;
  const recorder = new ChatTurnActivityRecorder(
    {
      companyId: turn.companyId,
      conversationId: turn.channelId,
      messageId: turn.id,
      attempt: Math.max(1, turn.attempt),
    },
    await nextChatActivityOrdinal(turn.id),
  );
  recorder.stopped(byName);
  await recorder.flush();
  const endedAt = new Date();
  const summary = await summarizeChatActivity({
    messageId: turn.id,
    status: "interrupted",
    startedAt: turn.acceptedAt,
    endedAt,
  });
  // Leaving `working` is also the stop signal to a worker on another replica:
  // its next lease renewal fails and it lets the reply go.
  const finalized = await repo().update(
    { id: turn.id, status: "working" },
    {
      status: "interrupted",
      waitingFor: null,
      resumeAs: null,
      workerId: null,
      leaseExpiresAt: null,
      endedAt,
      stoppedByUserId: args.byUserId,
      replyText: kept,
      activityJson: JSON.stringify(summary),
    },
  );
  if (finalized.affected !== 1) {
    await recorder.close();
    return "not_running";
  }
  await releaseChatWorkloadLeaseByOwner(turn.id);
  await recorder.finish(summary);
  await postReply({ ...turn, status: "interrupted" }, kept, [], turn.tainted);
  await announceChannelTurn(turn.id);
  return "interrupted";
}

/** Reply states the room can ask to run again. */
const RETRYABLE: ReadonlySet<ChannelTurnStatus> = new Set(["error", "skipped"]);

/**
 * Ask a failed reply again: a new reply turn for the same message, by the
 * same AI Employee, told that an earlier attempt did not finish. A turn that
 * ran under a Member's authority runs under the asker's now; one that ran
 * under an AI colleague's or nobody's keeps that — a Retry never lends a
 * Member's access to words no Member wrote. Only the newest reply to that
 * message can be retried, and not while that AI Employee is still replying
 * in the room.
 */
export async function retryChannelTurn(args: {
  companyId: string;
  channelId: string;
  turnId: string;
  requester: { userId: string; sessionVersion: number };
}): Promise<ChannelTurn> {
  const allowed = await userHasChannelAccess({
    channelId: args.channelId,
    userId: args.requester.userId,
    companyId: args.companyId,
  });
  const turn = allowed
    ? await repo().findOneBy({
        id: args.turnId,
        companyId: args.companyId,
        channelId: args.channelId,
      })
    : null;
  if (!turn || turn.kind !== "reply") throw new ChannelTurnError("Reply not found", 404);
  if (!RETRYABLE.has(turn.status)) {
    throw new ChannelTurnError("Only a reply that failed can be retried.", 409);
  }
  const newest = await repo().findOne({
    where: {
      channelId: turn.channelId,
      employeeId: turn.employeeId,
      triggerMessageId: turn.triggerMessageId ?? IsNull(),
      kind: "reply",
    },
    order: { acceptedAt: "DESC" },
    select: { id: true, acceptedAt: true },
  });
  if (newest && newest.id !== turn.id) {
    throw new ChannelTurnError("This reply was already retried.", 409);
  }
  const running = await repo().findOne({
    where: {
      channelId: turn.channelId,
      employeeId: turn.employeeId,
      kind: "reply",
      status: "working",
    },
    select: { id: true },
  });
  if (running) {
    throw new ChannelTurnError("Wait for the reply in progress to finish, then retry.", 409);
  }
  const [channel, trigger] = await Promise.all([
    AppDataSource.getRepository(Channel).findOneBy({ id: turn.channelId }),
    turn.triggerMessageId
      ? AppDataSource.getRepository(ChannelMessage).findOneBy({ id: turn.triggerMessageId })
      : Promise.resolve(null),
  ]);
  if (!channel || channel.archivedAt) throw new ChannelTurnError("Channel not found", 404);
  if (!trigger || trigger.deletedAt) {
    throw new ChannelTurnError("The message it answered was deleted.", 409);
  }
  const [created] = await enqueueChannelReplies({
    channel,
    trigger,
    employees: [{ id: turn.employeeId }],
    authority: turn.authority,
    requester: turn.authority === "member" ? args.requester : null,
    resumeAs: "retry",
  });
  try {
    const recorder = new ChatTurnActivityRecorder(
      {
        companyId: created.companyId,
        conversationId: created.channelId,
        messageId: created.id,
        attempt: 1,
      },
      await nextChatActivityOrdinal(created.id),
    );
    recorder.notice(
      "retry_requested",
      `Retry requested by ${(await userName(args.requester.userId)) ?? "a Member"}`,
    );
    await recorder.flush();
  } catch {
    // The retry stands without its note.
  }
  return created;
}

// ───────────────────────────── discussion turns ─────────────────────────────

/** A turn a group discussion drives, recorded so the room can watch it. */
export type DrivenChannelTurn = {
  turn: ChannelTurn;
  recorder: ChatTurnActivityRecorder;
  /** What wires the turn's activity into this record, for `streamChatWithEmployee`. */
  chatOptions: Pick<
    ChatOptions,
    | "activity"
    | "onWorkStarted"
    | "onSensitiveValues"
    | "onPayloadsWithheld"
    | "onProgress"
    | "reasoningSummaries"
  >;
  onChunk: (chunk: string) => void;
  /**
   * End the turn. Call before posting what it wrote (with `turnId`), so the
   * message carries how the turn went when the room sees it.
   */
  end: (args: {
    status: Exclude<ChannelTurnStatus, "working">;
    tainted?: boolean;
    stoppedBy?: { userId: string | null; name: string | null } | null;
  }) => Promise<void>;
};

/**
 * Open the record of one turn a group discussion drives — a speaker's turn
 * or an AI Employee's share of the work its outcome started. Never throws:
 * a discussion runs without its record rather than not at all.
 */
export async function beginDrivenChannelTurn(args: {
  channel: Pick<Channel, "id" | "companyId">;
  employeeId: string;
  kind: "discussion" | "follow_through";
  discussionId: string;
  round: number | null;
  triggerMessageId: string | null;
  requester: { userId: string; sessionVersion: number } | null;
}): Promise<DrivenChannelTurn | null> {
  try {
    const now = Date.now();
    const workerId = randomUUID();
    const turn = await repo().save(
      repo().create({
        companyId: args.channel.companyId,
        channelId: args.channel.id,
        employeeId: args.employeeId,
        kind: args.kind,
        triggerMessageId: args.triggerMessageId,
        discussionId: args.discussionId,
        round: args.round,
        authority: args.requester ? "member" : "employee",
        requesterUserId: args.requester?.userId ?? null,
        requesterSessionVersion: args.requester?.sessionVersion ?? null,
        status: "working",
        waitingFor: null,
        resumeAs: null,
        workerId,
        leaseExpiresAt: new Date(now + DRIVEN_LEASE_MS),
        attempt: 1,
        acceptedAt: new Date(now),
        deadlineAt: null,
        endedAt: null,
        stoppedByUserId: null,
        replyMessageId: null,
        tainted: false,
        replyText: "",
        activityJson: "",
      }),
    );
    const live = openLiveTurn(turn.id, turn.channelId);
    const recorder = new ChatTurnActivityRecorder(
      {
        companyId: turn.companyId,
        conversationId: turn.channelId,
        messageId: turn.id,
        attempt: 1,
      },
      1,
      { live },
    );
    const heartbeat = setInterval(() => {
      void repo()
        .update(
          { id: turn.id, status: "working", workerId },
          { leaseExpiresAt: new Date(Date.now() + DRIVEN_LEASE_MS) },
        )
        .catch(() => undefined);
    }, DRIVEN_HEARTBEAT_MS);
    heartbeat.unref?.();
    let streamed = "";
    const snapshot = createReplyTextSnapshotter({
      intervalMs: REPLY_SNAPSHOT_MS,
      save: (text) =>
        repo().update({ id: turn.id, status: "working", workerId }, { replyText: text }),
    });
    let ended = false;
    await announceChannelTurn(turn);
    return {
      turn,
      recorder,
      chatOptions: {
        reasoningSummaries: true,
        onProgress: (progress) => {
          recorder.progress(progress);
          live.progress(progress);
        },
        onWorkStarted: () => recorder.turnStarted("start"),
        onSensitiveValues: (values) => recorder.setSensitiveValues(values),
        onPayloadsWithheld: (why) => recorder.withholdPayloads(why),
        activity: recorderCallbacks(recorder),
      },
      onChunk: (chunk) => {
        streamed += chunk;
        live.appendText(chunk);
        snapshot.report(streamed);
      },
      end: async ({ status, tainted, stoppedBy }) => {
        if (ended) return;
        ended = true;
        clearInterval(heartbeat);
        snapshot.cancel();
        try {
          await snapshot.flush();
          if (status === "interrupted" && stoppedBy) recorder.stopped(stoppedBy.name);
          const summary = recorder.summarize({ status, startedAt: turn.acceptedAt });
          const finalized = await repo().update(
            { id: turn.id, status: "working" },
            {
              status,
              workerId: null,
              leaseExpiresAt: null,
              endedAt: new Date(),
              tainted: tainted === true,
              replyText: "",
              stoppedByUserId: stoppedBy?.userId ?? null,
              activityJson: JSON.stringify(summary),
            },
          );
          if (finalized.affected === 1) await recorder.finish(summary);
          else await recorder.close();
        } catch (error) {
          // eslint-disable-next-line no-console
          console.warn(`[channel-turns] could not end discussion turn ${turn.id}`, error);
        } finally {
          live.finish();
          releaseLiveTurn(live);
          await announceChannelTurn(turn.id);
        }
      },
    };
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn("[channel-turns] could not open a discussion turn's record", error);
    return null;
  }
}

/** A driven turn whose driver died with its process: closed, saying so. */
async function closeAbandonedDrivenTurn(turn: ChannelTurn): Promise<void> {
  const recorder = new ChatTurnActivityRecorder(
    {
      companyId: turn.companyId,
      conversationId: turn.channelId,
      messageId: turn.id,
      attempt: Math.max(1, turn.attempt),
    },
    await nextChatActivityOrdinal(turn.id),
  );
  recorder.notice("restart", "The server restarted before this turn finished");
  await recorder.flush();
  const endedAt = new Date();
  const summary = await summarizeChatActivity({
    messageId: turn.id,
    status: "interrupted",
    startedAt: turn.acceptedAt,
    endedAt,
  });
  const closed = await repo().update(
    { id: turn.id, status: "working", workerId: turn.workerId ?? IsNull() },
    {
      status: "interrupted",
      workerId: null,
      leaseExpiresAt: null,
      endedAt,
      replyText: "",
      activityJson: JSON.stringify(summary),
    },
  );
  if (closed.affected !== 1) {
    await recorder.close();
    return;
  }
  await recorder.finish(summary);
  await announceChannelTurn(turn.id);
}

// ───────────────────────────── recovery ─────────────────────────────

/**
 * Pick up the replies that are due — never picked up, cut off by a restart,
 * or waiting and at their next look — and close the discussion turns whose
 * driver went quiet.
 */
export async function recoverChannelTurns(): Promise<void> {
  const now = new Date();
  const due = await repo().find({
    where: [
      { kind: "reply", status: "working", leaseExpiresAt: IsNull() },
      { kind: "reply", status: "working", leaseExpiresAt: LessThanOrEqual(now) },
    ],
    order: { acceptedAt: "ASC" },
    take: MAX_RECOVERIES_PER_SWEEP,
    select: { id: true },
  });
  for (const turn of due) runLocally(turn.id);

  const abandoned = await repo().find({
    where: {
      kind: In(["discussion", "follow_through"]),
      status: "working",
      leaseExpiresAt: LessThanOrEqual(now),
    },
    take: MAX_RECOVERIES_PER_SWEEP,
  });
  for (const turn of abandoned) {
    await closeAbandonedDrivenTurn(turn).catch((error) => {
      // eslint-disable-next-line no-console
      console.warn(`[channel-turns] could not close abandoned turn ${turn.id}`, error);
    });
  }
}

/**
 * When an AI Model answers again, the replies waiting for it are looked at
 * now rather than at their next look. Those whose model is still down simply
 * wait again; the rest start one at a time (`keyWorkGate`).
 */
async function lookAtWaitingReplies(): Promise<void> {
  const waiting = await repo().find({
    where: {
      kind: "reply",
      status: "working",
      waitingFor: In(["model_unavailable", "model_resuming"]),
      workerId: IsNull(),
    },
    select: { id: true },
  });
  if (waiting.length === 0) return;
  const now = new Date();
  for (const turn of waiting) {
    await repo().update(
      { id: turn.id, status: "working", workerId: IsNull() },
      { leaseExpiresAt: now },
    );
  }
  await recoverChannelTurns();
}

onModelAvailabilityChange((change) => {
  if (!change.available || !recoveryTimer) return;
  void lookAtWaitingReplies().catch((error) => {
    // eslint-disable-next-line no-console
    console.error("[channel-turns] could not resume replies waiting for an AI Model", error);
  });
});

/**
 * Start recovery after migrations. SQLite is one process, so every claim it
 * inherited is dead and every driven turn's driver with it. Postgres may have
 * live sibling replicas, so it waits for leases to lapse.
 */
export async function bootChannelTurnRecovery(): Promise<void> {
  if (recoveryTimer) clearInterval(recoveryTimer);
  if (config.db.driver !== "postgres") {
    await repo().update(
      { kind: "reply", status: "working" },
      { workerId: null, leaseExpiresAt: null },
    );
    await repo().update(
      { kind: In(["discussion", "follow_through"]), status: "working" },
      { leaseExpiresAt: new Date(0) },
    );
  }
  await recoverChannelTurns();
  recoveryTimer = setInterval(() => {
    void recoverChannelTurns().catch((error) => {
      // eslint-disable-next-line no-console
      console.error("[channel-turns] sweep failed", error);
    });
  }, RECOVERY_POLL_MS);
  recoveryTimer.unref?.();
}

/** Test/restore seam; normal shutdown simply lets the timer disappear. */
export function stopChannelTurnRecovery(): void {
  if (recoveryTimer) clearInterval(recoveryTimer);
  recoveryTimer = null;
  for (const abort of activeClaimAborters.values()) abort();
}

// ───────────────────────────── reading ─────────────────────────────

/**
 * A turn in a room the Member can read, with what they may see of its
 * activity. A room they cannot read, or a turn in another one, reads exactly
 * like one that does not exist.
 */
async function readableTurn(args: {
  companyId: string;
  channelId: string;
  turnId: string;
  viewerUserId: string;
}): Promise<{ turn: ChannelTurn; access: TurnActivityAccess }> {
  const allowed = await userHasChannelAccess({
    channelId: args.channelId,
    userId: args.viewerUserId,
    companyId: args.companyId,
  });
  const turn = allowed
    ? await repo().findOneBy({
        id: args.turnId,
        companyId: args.companyId,
        channelId: args.channelId,
      })
    : null;
  if (!turn) throw new ChannelTurnError("Reply not found", 404);
  return {
    turn,
    access: turnActivityAccess({
      // A Workspace channel is read only by the company's own Members.
      audience: "internal",
      authority: channelTurnAuthority(turn),
      viewer: { kind: "member", userId: args.viewerUserId },
    }),
  };
}

/** The running turns in a room the Member can read, as the room sees them. */
export async function listChannelTurnsForViewer(args: {
  companyId: string;
  channelId: string;
  viewerUserId: string;
}): Promise<ChannelTurnSummary[]> {
  const allowed = await userHasChannelAccess({
    channelId: args.channelId,
    userId: args.viewerUserId,
    companyId: args.companyId,
  });
  if (!allowed) throw new ChannelTurnError("Channel not found", 404);
  return summarizeChannelTurns(await runningChannelTurns(args.companyId, args.channelId));
}

/** One page of a turn's activity, as this Member may see it. */
export async function readChannelTurnActivity(args: {
  companyId: string;
  channelId: string;
  turnId: string;
  viewerUserId: string;
  after: number;
  limit: number;
}): Promise<{
  events: ChatActivityEvent[];
  more: boolean;
  status: ChannelTurnStatus;
  access: TurnActivityAccess;
}> {
  const { turn, access } = await readableTurn(args);
  const rows = await listChatActivity(turn.id, args.after, args.limit + 1);
  return {
    events: rows
      .slice(0, args.limit)
      .map((event) => activityEventFor(event, access))
      .filter((event): event is ChatActivityEvent => event !== null),
    more: rows.length > args.limit,
    status: turn.status,
    access,
  };
}

/**
 * Follow a turn from any browser, from the reader's cursor to its end
 * (`followChatTurn`), showing this Member what they may see of it. It closes
 * with `final`: the turn as it ended and the reply it wrote.
 */
export async function followChannelTurn(args: {
  companyId: string;
  channelId: string;
  turnId: string;
  viewerUserId: string;
  after: number;
  send: (event: string, data: unknown) => void;
  signal: AbortSignal;
  pollMs?: number;
  heartbeatMs?: number;
}): Promise<void> {
  const { turn, access } = await readableTurn(args);
  const source: FollowSource = {
    async read() {
      const row = await repo().findOneBy({ id: turn.id });
      if (!row) return null;
      return {
        id: row.id,
        status: row.status,
        text: row.replyText,
        startedAt: row.acceptedAt,
        attempt: row.attempt,
        // Milestones ride the activity feed, where a reader on any replica
        // reads them.
        progress: null,
        extra: { kind: row.kind, employeeId: row.employeeId, waitingFor: row.waitingFor, access },
      };
    },
    async finalFrames() {
      const row = await repo().findOneBy({ id: turn.id });
      if (!row) return [];
      const [summary] = await summarizeChannelTurns([row]);
      const message = row.replyMessageId
        ? await getMessageSummary(row.replyMessageId, args.viewerUserId)
        : null;
      return [{ event: "final", data: { turn: summary, message } }];
    },
  };
  await followChatTurn({
    messageId: turn.id,
    after: args.after,
    send: args.send,
    signal: args.signal,
    source,
    present: (event) => activityEventFor(event, access),
    presentProgress: (progress) =>
      access === "full" ? progress : { percent: progress.percent, label: "In progress" },
    pollMs: args.pollMs,
    heartbeatMs: args.heartbeatMs,
  });
}

/** The replies waiting for an AI Model, for the AI Models page's count of what waits. */
export async function modelWaitingChannelReplies(): Promise<
  Pick<ChannelTurn, "id" | "employeeId" | "companyId">[]
> {
  return repo().find({
    where: {
      kind: "reply",
      status: "working",
      waitingFor: In(["model_unavailable", "model_resuming"]),
    },
    select: { id: true, employeeId: true, companyId: true },
  });
}
