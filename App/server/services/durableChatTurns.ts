import { randomUUID } from "node:crypto";
import { IsNull, LessThanOrEqual } from "typeorm";

import { config } from "../../config.js";
import type { ModelEffort } from "../../shared/modelEffort.js";
import { parseTurnThinking, type TurnThinking } from "../../shared/thinkingLevels.js";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Attachment } from "../db/entities/Attachment.js";
import { Conversation } from "../db/entities/Conversation.js";
import { ConversationMessage, type MessageAction } from "../db/entities/ConversationMessage.js";
import { Membership } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import type { AgentProgress, ContextUsage } from "./agent/types.js";
import {
  CHAT_HARD_TIMEOUT_MS,
  type ChatResult,
  type ChatTurn,
  INTERRUPTED_BEFORE_REPLY,
  streamChatWithEmployee,
} from "./chat.js";
import type { ChatActivityEvent } from "../../shared/chatActivity.js";
import {
  ChatTurnActivityRecorder,
  lastChatActivity,
  nextChatActivityOrdinal,
  recordDetachedChatActivity,
  summarizeChatActivity,
  turnAcceptedAt,
} from "./chatTurnActivity.js";
import { createChatTurnContextUsageRecorder } from "./chatTurnContextUsage.js";
import { thinkingAfterRefusal, thinkingAfterRunTimeChange } from "./chatThinking.js";
import { openLiveTurn, releaseLiveTurn, type LiveTurn } from "./chatTurnLive.js";
import {
  createChatTurnProgressRecorder,
  createProgressRefreshNotifier,
  createReplyTextSnapshotter,
} from "./chatTurnProgress.js";
import {
  historicalAttachmentSummaries,
  inlineAttachmentsForMessage,
  attachmentImageContextForMessages,
} from "./attachmentText.js";
import { emitResourceChange } from "./resourceEvents.js";
import { captureTurnActionsForAuthority } from "./turnActions.js";
import { bindAttachmentsToMessage } from "./uploads.js";
import { EmployeeWorkloadBusyError, releaseChatWorkloadLeaseByOwner } from "./workloadLeases.js";
import { MODEL_WAIT_PROGRESS_LABEL } from "../../shared/modelAvailability.js";
import { MODEL_UNAVAILABLE_WAIT_CAUSE } from "../../shared/chatActivity.js";
import {
  isModelAvailable,
  modelAvailabilityState,
  onModelAvailabilityChange,
} from "./modelAvailability.js";
import { modelWaitingChatTurns } from "./modelOutageViews.js";
import { resolveChatModel } from "./models.js";

const MAX_REPLAY_TURNS = 20;
const TURN_LEASE_MS = 15_000;
const TURN_HEARTBEAT_MS = 5_000;
const RECOVERY_POLL_MS = 5_000;
const BUSY_RETRY_MS = 15_000;
const MAX_RECOVERIES_PER_SWEEP = 10;
const WORK_PROGRESS_EVENT_INTERVAL_MS = 30_000;
/**
 * The longest a reply waiting for its AI Model goes between looks. It looks
 * sooner when the model's next check is sooner, and at once when the model
 * answers again.
 */
const MODEL_WAIT_LOOK_MS = 30_000;
/** How often the reply's text so far is saved while it streams. */
const REPLY_SNAPSHOT_MS = 1_500;
/** The label a turn carries while it waits for another reply in its thread. */
const THREAD_BUSY_LABEL = "Waiting for another reply";
/** The label a turn carries between a Member's Retry and its worker starting. */
export const RETRY_PROGRESS_LABEL = "Starting again";
/** The label a turn cut short by an AI Model outage carries once its model is back. */
const MODEL_BACK_PROGRESS_LABEL = "Starting again now that the AI Model is back";

/**
 * Why a worker picked a turn up: the first time, after a restart, after a
 * Retry, or after an AI Model outage cut it short (`model_back`).
 */
export type TurnStartReason = "start" | "resume" | "retry" | "model_back";

export type DurableChatTurnCallbacks = {
  onChunk?: (chunk: string) => void;
  onProgress?: (progress: AgentProgress) => void;
  onContextUsage?: (usage: ContextUsage) => void;
  /** Each activity event as it is recorded — a tool call, a wait, a thought. */
  onActivity?: (event: ChatActivityEvent) => void;
  onFinal?: (result: {
    message: ConversationMessage;
    attachments: Attachment[];
    conversation: Conversation;
  }) => void;
};

export type DurableChatTurnOutcome = "completed" | "deferred" | "claimed_elsewhere";

/**
 * `not_running` means there was nothing left to stop — the turn had already
 * finalized, or another Member's browser stopped it first.
 */
export type InterruptDurableChatTurnOutcome = "interrupted" | "not_running";

type ClaimedTurn = {
  message: ConversationMessage;
  workerId: string;
  /** Read from the row before the claim overwrote its label. */
  reason: TurnStartReason;
};

let recoveryTimer: NodeJS.Timeout | null = null;
const locallyExecuting = new Set<string>();
const activeClaimAborters = new Map<string, () => void>();
/** Returns false when this process no longer owns the turn it registered for. */
const activeTurnInterrupters = new Map<string, () => boolean>();

/** The live and persisted activity of a turn this process is running. */
type TurnActivity = { recorder: ChatTurnActivityRecorder; live: LiveTurn };

/**
 * What a reply's thinking record says as an attempt starts. A refusal belongs
 * to the attempt the AI Model refused: a Retry, or a recovery, sends the level
 * again, so the record goes back to that level until this attempt says
 * otherwise.
 */
function thinkingBeforeAttempt(
  recorded: TurnThinking | null,
  effort: ModelEffort | null,
): TurnThinking | null {
  if (recorded?.adjusted !== "rejected") return recorded;
  return { level: recorded.refused ?? effort, requested: recorded.requested, adjusted: null };
}

/** Derive the sidebar title from the first accepted human message. */
function deriveTitle(message: string): string {
  const firstLine = message.split("\n")[0].trim();
  if (firstLine.length <= 60) return firstLine;
  return firstLine.slice(0, 57).trimEnd() + "…";
}

/**
 * Atomically persist everything needed to execute or recover a direct-chat
 * turn. A process can disappear immediately after this transaction commits
 * and the startup sweeper still has an unambiguous user/assistant pair plus
 * every uploaded input attachment.
 */
export async function enqueueDurableChatTurn(args: {
  companyId: string;
  employeeId: string;
  conversationId: string;
  message: string;
  attachmentIds: string[];
  modelId?: string | null;
  /**
   * The thinking level to send `modelId`, resolved from the conversation's
   * level (`chatThinking.ts`); null or omitted keeps the AI Model's default.
   */
  effort?: ModelEffort | null;
  /** The level the reply runs at, as the reply will show it. */
  thinking?: TurnThinking | null;
  /** Authenticated Member who submitted this browser chat turn. */
  requesterUserId: string;
  /** Auth epoch carried by the browser session that submitted this turn. */
  requesterSessionVersion: number;
}): Promise<{
  conversation: Conversation;
  userMessage: ConversationMessage;
  assistantMessage: ConversationMessage;
  userAttachments: Attachment[];
}> {
  const turn = await AppDataSource.transaction(async (manager) => {
    const conversationRepo = manager.getRepository(Conversation);
    const messageRepo = manager.getRepository(ConversationMessage);
    const [conversation, requester, membership] = await Promise.all([
      conversationRepo.findOneBy({
        id: args.conversationId,
        employeeId: args.employeeId,
        ownerUserId: args.requesterUserId,
      }),
      manager.getRepository(User).findOneBy({ id: args.requesterUserId }),
      manager.getRepository(Membership).findOneBy({
        companyId: args.companyId,
        userId: args.requesterUserId,
      }),
    ]);
    if (!conversation) throw new Error("Conversation not found");
    if (!requester || requester.sessionVersion !== args.requesterSessionVersion || !membership) {
      throw new Error("Member authority changed before the turn was accepted");
    }

    const userMessage = await messageRepo.save(
      messageRepo.create({
        conversationId: conversation.id,
        role: "user",
        content: args.message,
        status: null,
      }),
    );
    const userAttachments = await bindAttachmentsToMessage(
      args.attachmentIds,
      userMessage.id,
      args.companyId,
      manager,
    );

    if (!conversation.title) {
      const seed = args.message.trim() || userAttachments[0]?.filename || "";
      if (seed) conversation.title = deriveTitle(seed);
    }
    conversation.updatedAt = new Date();
    await conversationRepo.save(conversation);

    const assistantMessage = await messageRepo.save(
      messageRepo.create({
        conversationId: conversation.id,
        role: "assistant",
        content: "",
        status: "working",
        progressPercent: 1,
        progressLabel: "Starting work",
        modelId: args.modelId ?? null,
        effort: args.effort ?? null,
        thinkingJson: args.thinking ? JSON.stringify(args.thinking) : "",
        turnUserMessageId: userMessage.id,
        turnRequesterUserId: args.requesterUserId,
        turnRequesterSessionVersion: args.requesterSessionVersion,
        turnWorkerId: null,
        turnLeaseExpiresAt: null,
        turnAttempt: 0,
        turnDeadlineAt: new Date(Date.now() + CHAT_HARD_TIMEOUT_MS),
      }),
    );

    return {
      conversation,
      userMessage,
      assistantMessage,
      userAttachments,
    };
  });
  emitResourceChange(args.companyId, "employee_work", args.employeeId);
  return turn;
}

/** Best-effort live refresh for terminal paths that no longer hold the employee row. */
async function emitConversationWorkChange(conversationId: string): Promise<void> {
  try {
    const conversation = await AppDataSource.getRepository(Conversation).findOne({
      where: { id: conversationId },
      select: ["employeeId"],
    });
    if (!conversation) return;
    const employee = await AppDataSource.getRepository(AIEmployee).findOne({
      where: { id: conversation.employeeId },
      select: ["id", "companyId"],
    });
    if (employee) emitResourceChange(employee.companyId, "employee_work", employee.id);
  } catch {
    // The durable row is already final. A missed refresh heals on focus; it
    // must never turn completed employee work into a failed chat response.
  }
}

/**
 * Atomically claim one unfinished turn. The short lease is renewed while the
 * agent runs; after a crash it expires quickly and exactly one replacement
 * process wins this conditional update.
 */
export async function claimDurableChatTurn(
  messageId: string,
  now: Date = new Date(),
  workerId: string = randomUUID(),
): Promise<ClaimedTurn | null> {
  const repo = AppDataSource.getRepository(ConversationMessage);
  const leaseExpiresAt = new Date(now.getTime() + TURN_LEASE_MS);
  const claimed = await repo
    .createQueryBuilder()
    .update(ConversationMessage)
    .set({
      turnWorkerId: workerId,
      turnLeaseExpiresAt: leaseExpiresAt,
      turnAttempt: () => '"turnAttempt" + 1',
    })
    .where("id = :messageId", { messageId })
    .andWhere("role = :role", { role: "assistant" })
    .andWhere("status = :status", { status: "working" })
    .andWhere('("turnLeaseExpiresAt" IS NULL OR "turnLeaseExpiresAt" <= :now)', { now })
    .execute();
  if (claimed.affected !== 1) return null;

  const message = await repo.findOneBy({ id: messageId });
  if (!message) return null;
  // A turn that only ever waited for its thread never ran, so its next pickup
  // is still its start; a Retry says so on the row; one an AI Model outage cut
  // short comes back once the model answers (a turn that waited for its model
  // before it ever ran was given its attempt back, so it is still starting);
  // anything else that comes back for another attempt was cut off by a restart.
  const reason: TurnStartReason =
    message.progressLabel === RETRY_PROGRESS_LABEL
      ? "retry"
      : message.turnAttempt > 1 && message.progressLabel === MODEL_WAIT_PROGRESS_LABEL
        ? "model_back"
        : message.turnAttempt > 1 && message.progressLabel !== THREAD_BUSY_LABEL
          ? "resume"
          : "start";
  if (message.turnAttempt > 1) {
    message.progressLabel =
      reason === "retry"
        ? RETRY_PROGRESS_LABEL
        : reason === "model_back"
          ? MODEL_BACK_PROGRESS_LABEL
          : "Resuming durable work";
    await repo.update(
      { id: message.id, status: "working", turnWorkerId: workerId },
      { progressLabel: message.progressLabel },
    );
  }
  return { message, workerId, reason };
}

/**
 * Execute a persisted turn under its renewable claim. The function may be
 * awaited by the original SSE request or detached by startup recovery; all
 * durable state transitions are identical in both cases.
 */
export async function executeDurableChatTurn(
  messageId: string,
  callbacks: DurableChatTurnCallbacks = {},
): Promise<DurableChatTurnOutcome> {
  const claimed = await claimDurableChatTurn(messageId);
  if (!claimed) return "claimed_elsewhere";

  const { message: claimedMessage, workerId, reason: startReason } = claimed;
  const messageRepo = AppDataSource.getRepository(ConversationMessage);
  const claimController = new AbortController();
  let lostClaim = false;
  let interrupted = false;
  let renewing = false;
  let workScope: { companyId: string; employeeId: string } | null = null;
  /** Created once the turn's company is known; a stop before then is written on creation. */
  let activity: TurnActivity | null = null;
  const workProgressEvents = createProgressRefreshNotifier({
    intervalMs: WORK_PROGRESS_EVENT_INTERVAL_MS,
    notify: () => {
      if (workScope) {
        emitResourceChange(workScope.companyId, "employee_work", workScope.employeeId);
      }
    },
  });

  const loseClaim = () => {
    lostClaim = true;
    claimController.abort();
  };
  /**
   * Put the turn back to wait for its AI Model, still `working`, unclaimed,
   * and looked at again when the model's next check is due or it answers.
   * Waiting is not work: the six-hour limit starts over from when it can run.
   * A turn that never reached the model is not a recovery attempt, so its
   * attempt count is given back; one the outage cut short keeps it, and its
   * next attempt is told to check what it already did.
   */
  const waitForModel = async (started: boolean): Promise<DurableChatTurnOutcome> => {
    await flushRecorders();
    if (activity) {
      // One line in the chat for the whole wait, however many times the turn
      // is picked up and finds its AI Model still unavailable.
      const last = activity.live.lastEvent ?? (await lastChatActivity(claimedMessage.id));
      const alreadyWaiting =
        last?.kind === "waiting" &&
        last.name === MODEL_UNAVAILABLE_WAIT_CAUSE &&
        (last.detail as { state?: string } | null)?.state === "waiting";
      if (!alreadyWaiting) activity.recorder.waiting(MODEL_UNAVAILABLE_WAIT_CAUSE);
      await activity.recorder.flush();
    }
    const now = Date.now();
    const model = await resolveChatModel(
      workScope?.employeeId ?? "",
      claimedMessage.modelId,
    ).catch(() => null);
    const state = model ? modelAvailabilityState(model) : { available: true as const };
    const lookAt = state.available
      ? now + BUSY_RETRY_MS
      : Math.min(Math.max(state.nextCheckAt.getTime(), now + 1_000), now + MODEL_WAIT_LOOK_MS);
    const deferred = await messageRepo.update(
      { id: claimedMessage.id, status: "working", turnWorkerId: workerId },
      {
        turnWorkerId: null,
        turnLeaseExpiresAt: new Date(lookAt),
        progressLabel: MODEL_WAIT_PROGRESS_LABEL,
        turnDeadlineAt: new Date(now + CHAT_HARD_TIMEOUT_MS),
        ...(started ? {} : { turnAttempt: Math.max(0, claimedMessage.turnAttempt - 1) }),
      },
    );
    if (deferred.affected !== 1) {
      await activity?.recorder.close();
      activity?.live.detach();
      return "claimed_elsewhere";
    }
    // A stop that landed inside that write still has to stick.
    if (interrupted) {
      return finalizeInterruptedTurn(
        claimedMessage,
        workerId,
        INTERRUPTED_BEFORE_REPLY,
        callbacks,
        activity,
      );
    }
    await activity?.recorder.close();
    activity?.live.detach();
    await emitConversationWorkChange(claimedMessage.conversationId);
    try {
      callbacks.onProgress?.({
        percent: claimedMessage.progressPercent ?? 1,
        label: MODEL_WAIT_PROGRESS_LABEL,
      });
    } catch {
      // A subscriber never owns the durable turn.
    }
    return "deferred";
  };
  // Deliberately not `loseClaim`: this process keeps the claim so it can write
  // the partial reply the human already read on screen. The agent stops either
  // way — both paths abort the same controller. Reports whether it actually
  // took effect: a worker that has already lost the turn cannot stop it, and
  // saying otherwise would leave the Member watching a reply they thought they
  // had cancelled.
  const interruptTurn = (): boolean => {
    if (lostClaim) return false;
    interrupted = true;
    activity?.recorder.stopped();
    claimController.abort();
    return true;
  };
  activeClaimAborters.set(claimedMessage.id, loseClaim);
  activeTurnInterrupters.set(claimedMessage.id, interruptTurn);
  const renewClaim = async () => {
    if (renewing || lostClaim) return;
    renewing = true;
    try {
      const renewed = await messageRepo.update(
        {
          id: claimedMessage.id,
          status: "working",
          turnWorkerId: workerId,
        },
        { turnLeaseExpiresAt: new Date(Date.now() + TURN_LEASE_MS) },
      );
      if (renewed.affected !== 1) loseClaim();
    } catch {
      // Continuing while the database cannot renew would allow another
      // process to claim the same work. Stop immediately and let recovery
      // retry once persistence is healthy.
      loseClaim();
    } finally {
      renewing = false;
    }
  };
  const heartbeat = setInterval(() => {
    void renewClaim();
  }, TURN_HEARTBEAT_MS);
  heartbeat.unref?.();

  const progressRecorder = createChatTurnProgressRecorder({
    repository: messageRepo,
    messageId: claimedMessage.id,
    workerId,
    onProgress: callbacks.onProgress,
    onPersisted: workProgressEvents.report,
    onPersistenceError: (error) => {
      // eslint-disable-next-line no-console
      console.error(
        `[chat] progress save failed conversation=${claimedMessage.conversationId} ` +
          `message=${claimedMessage.id}`,
        error,
      );
    },
  });
  const contextUsageRecorder = createChatTurnContextUsageRecorder({
    repository: messageRepo,
    messageId: claimedMessage.id,
    workerId,
    onContextUsage: callbacks.onContextUsage,
    onPersistenceError: (error) => {
      // eslint-disable-next-line no-console
      console.error(
        `[chat] context usage save failed conversation=${claimedMessage.conversationId} ` +
          `message=${claimedMessage.id}`,
        error,
      );
    },
  });
  // The reply so far, saved as it streams, so a browser that attaches later —
  // or a stop that lands on another replica — has the text already on screen.
  const replySnapshot = createReplyTextSnapshotter({
    repository: messageRepo,
    messageId: claimedMessage.id,
    workerId,
    intervalMs: REPLY_SNAPSHOT_MS,
    onPersistenceError: (error) => {
      // eslint-disable-next-line no-console
      console.error(`[chat] reply snapshot save failed message=${claimedMessage.id}`, error);
    },
  });
  const flushRecorders = () =>
    Promise.all([progressRecorder.flush(), contextUsageRecorder.flush(), replySnapshot.flush()]);

  try {
    const context = await loadTurnContext(claimedMessage, workerId);
    if (!context) {
      return await finalizeInfrastructureError(
        claimedMessage,
        workerId,
        "The conversation, employee, or triggering message no longer exists.",
        callbacks,
      );
    }
    workScope = {
      companyId: context.employee.companyId,
      employeeId: context.employee.id,
    };
    const live = openLiveTurn(claimedMessage.id, claimedMessage.conversationId);
    const recorder = new ChatTurnActivityRecorder(
      {
        companyId: context.employee.companyId,
        conversationId: claimedMessage.conversationId,
        messageId: claimedMessage.id,
        attempt: claimedMessage.turnAttempt,
      },
      await nextChatActivityOrdinal(claimedMessage.id),
      { live, onEvent: callbacks.onActivity },
    );
    activity = { recorder, live };
    if (interrupted) recorder.stopped();

    // The AI Model this turn runs on is unavailable: the message waits to be
    // answered, saying so where the Member is looking, instead of failing.
    const turnModel = await resolveChatModel(context.employee.id, claimedMessage.modelId);
    if (turnModel && !isModelAvailable(turnModel)) {
      return await waitForModel(false);
    }

    const deadline =
      claimedMessage.turnDeadlineAt ??
      new Date(claimedMessage.createdAt.getTime() + CHAT_HARD_TIMEOUT_MS);
    if (!claimedMessage.turnDeadlineAt) {
      await messageRepo.update(
        {
          id: claimedMessage.id,
          status: "working",
          turnWorkerId: workerId,
        },
        { turnDeadlineAt: deadline },
      );
    }
    const remainingMs = deadline.getTime() - Date.now();
    if (remainingMs <= 0) {
      return await finalizeInfrastructureError(
        claimedMessage,
        workerId,
        "This turn reached its six-hour limit, including time spent recovering from server restarts.",
        callbacks,
        activity,
      );
    }

    const { replay, prompt, images } = await buildTurnPrompt({
      companyId: context.employee.companyId,
      conversation: context.conversation,
      userMessage: context.userMessage,
      assistantMessage: claimedMessage,
      attempt: claimedMessage.turnAttempt,
    });

    // The thinking level the reply runs at, as recorded when it was accepted;
    // moved below if its model now allows another, or refuses it mid-turn.
    const recordedThinking = thinkingBeforeAttempt(
      parseTurnThinking(claimedMessage.thinkingJson),
      claimedMessage.effort,
    );
    let finalThinking: TurnThinking | null = recordedThinking;

    let result: ChatResult;
    try {
      const requesterAuthority =
        claimedMessage.turnRequesterUserId !== null &&
        claimedMessage.turnRequesterSessionVersion !== null
          ? {
              requesterUserId: claimedMessage.turnRequesterUserId,
              requesterSessionVersion: claimedMessage.turnRequesterSessionVersion,
            }
          : { toolAuthority: "untrusted" as const };
      let streamed = "";
      result = await streamChatWithEmployee(
        context.employee.companyId,
        context.employee.id,
        prompt,
        replay,
        (chunk) => {
          streamed += chunk;
          live.appendText(chunk);
          replySnapshot.report(streamed);
          try {
            callbacks.onChunk?.(chunk);
          } catch {
            // A disconnected browser is only a lost subscriber.
          }
        },
        {
          images,
          conversationId: context.conversation.id,
          modelId: claimedMessage.modelId,
          effort: claimedMessage.effort,
          // The activity shows what the AI Model considered, at any level.
          reasoningSummaries: true,
          onThinkingAdjusted: (resolved) => {
            finalThinking = thinkingAfterRunTimeChange(recordedThinking, resolved);
          },
          surface: context.conversation.source === "help" ? "help" : "chat",
          ...requesterAuthority,
          onProgress: (progress) => {
            progressRecorder.report(progress);
            recorder.progress(progress);
            live.progress(progress);
          },
          onContextUsage: (usage) => {
            contextUsageRecorder.report(usage);
            live.context(usage);
          },
          onWorkStarted: () => recorder.turnStarted(startReason),
          onSensitiveValues: (values) => recorder.setSensitiveValues(values),
          onPayloadsWithheld: (reason) => recorder.withholdPayloads(reason),
          activity: {
            onToolUse: (name, input, callId) => recorder.toolUse(name, input, callId),
            onToolResult: (name, toolResult, callId) =>
              recorder.toolResult(name, toolResult, callId),
            onReasoning: (delta, block) => recorder.reasoning(delta, block),
            onReasoningEnd: (block) => recorder.reasoningEnd(block),
            onModelRetry: (retry) => recorder.modelRetry(retry),
            onModelOutage: (outage) => recorder.modelOutage(outage),
            onRuntimeWait: (wait) => recorder.runtimeWait(wait),
            onCompact: (info) => recorder.compact(info),
            onApiKeyFailover: (change) => recorder.apiKeyFailover(change),
            onServedModelChange: (change) => recorder.servedModelChange(change),
            onBackgroundWork: (pending) => recorder.backgroundWork(pending),
            onThinkingFallback: (fallback) => {
              recorder.thinkingFallback(fallback);
              if (fallback.level) {
                finalThinking = thinkingAfterRefusal(finalThinking, fallback.level);
              }
            },
          },
          workloadKey: claimedMessage.id,
          throwOnWorkloadUnavailable: true,
          timeoutMs: remainingMs,
          signal: claimController.signal,
          wasInterrupted: () => interrupted,
        },
      );
    } catch (error) {
      // Checked ahead of both claim loss and the contention retry: re-queuing a
      // turn the Member just stopped would restart it in fifteen seconds, and
      // walking away as "claimed elsewhere" would leave it running under
      // whoever overtook us. A stop has to become terminal on every path.
      if (interrupted) {
        await flushRecorders();
        return finalizeInterruptedTurn(
          claimedMessage,
          workerId,
          INTERRUPTED_BEFORE_REPLY,
          callbacks,
          activity,
        );
      }
      if (lostClaim) {
        await recorder.close();
        live.detach();
        return "claimed_elsewhere";
      }
      if (error instanceof EmployeeWorkloadBusyError) {
        await flushRecorders();
        // One line for the whole wait, however many times the turn is picked
        // up and finds its thread still busy.
        const last = live.lastEvent ?? (await lastChatActivity(claimedMessage.id));
        const alreadyWaiting =
          last?.kind === "waiting" &&
          last.name === "thread_busy" &&
          (last.detail as { state?: string } | null)?.state === "waiting";
        if (!alreadyWaiting) recorder.waiting("thread_busy");
        await recorder.flush();
        const label = THREAD_BUSY_LABEL;
        const deferred = await messageRepo.update(
          {
            id: claimedMessage.id,
            status: "working",
            turnWorkerId: workerId,
          },
          {
            turnWorkerId: null,
            turnLeaseExpiresAt: new Date(Date.now() + BUSY_RETRY_MS),
            progressLabel: label,
          },
        );
        if (deferred.affected === 1) {
          // Re-read rather than trusting the check above: the deferral write is
          // a database round trip, and a stop that lands inside it would
          // otherwise be answered "interrupted" and then thrown away — the row
          // is back at `working` with a fifteen-second lease, so recovery would
          // re-run a request the Member had cancelled.
          if (interrupted) {
            return finalizeInterruptedTurn(
              claimedMessage,
              workerId,
              INTERRUPTED_BEFORE_REPLY,
              callbacks,
              activity,
            );
          }
          await recorder.close();
          live.detach();
          try {
            callbacks.onProgress?.({
              percent: claimedMessage.progressPercent ?? 1,
              label,
            });
          } catch {
            // A subscriber never owns the durable turn.
          }
          return "deferred";
        }
        await recorder.close();
        live.detach();
        return "claimed_elsewhere";
      }
      throw error;
    }

    await flushRecorders();
    if (!lostClaim) await renewClaim();
    if (lostClaim) {
      // Overtaken while the agent unwound. Ordinary claim loss is somebody
      // else's problem now, but a stop the Member asked for still has to stick
      // — `finalizeInterruptedTurn` writes it under whoever holds the row.
      if (interrupted) {
        return finalizeInterruptedTurn(claimedMessage, workerId, result.reply, callbacks, activity);
      }
      await recorder.close();
      live.detach();
      return "claimed_elsewhere";
    }
    // The AI Model became unavailable mid-turn: the message waits and is
    // answered when it is back, rather than ending in an error. A stop the
    // Member asked for still ends it, below.
    if (result.status === "error" && result.unavailable && !interrupted) {
      return await waitForModel(true);
    }

    let actions: MessageAction[] = [];
    try {
      actions = await captureTurnActionsForAuthority({
        companyId: context.employee.companyId,
        employeeId: context.employee.id,
        since: new Date(claimedMessage.createdAt.getTime() - 10),
        authority: "member",
      });
    } catch (error) {
      // The reply remains valuable if the auxiliary action-pill projection
      // fails; log it instead of converting completed work into an error.
      // eslint-disable-next-line no-console
      console.error(`[chat] action capture failed message=${claimedMessage.id}`, error);
    }

    const replyAttachments = result.attachmentIds.length
      ? await bindAttachmentsToMessage(
          result.attachmentIds,
          claimedMessage.id,
          context.employee.companyId,
        )
      : [];
    const finalContextUsage = contextUsageRecorder.latest();
    // A Member who stopped this turn asked for exactly what is on screen.
    // The agent's own status describes how the model unwound, which after
    // an abort is usually a transport error — not the answer to "did the
    // human get what they asked for".
    const finalStatus = interrupted ? "interrupted" : result.status;
    const summary = recorder.summarize({
      status: finalStatus,
      startedAt: turnAcceptedAt(claimedMessage),
    });
    const finalized = await messageRepo.update(
      {
        id: claimedMessage.id,
        status: "working",
        turnWorkerId: workerId,
      },
      {
        content: result.reply,
        status: finalStatus,
        progressPercent: null,
        progressLabel: null,
        // Unlike progress, the context gauge is not cleared on completion — it
        // describes the turn that just ran and is exactly what a Member wants
        // to read once the reply lands. Restated here rather than left to the
        // recorder's own writes because this conditional UPDATE is the last one
        // that can win: after it commits, `status` is no longer `working` and
        // every later recorder write is a no-op. Omitted entirely when this
        // attempt saw no provider count, so a recovery that dies before its
        // first model response cannot erase the previous attempt's reading.
        ...(finalContextUsage
          ? {
              contextTokens: finalContextUsage.promptTokens,
              contextWindow: finalContextUsage.contextWindow,
            }
          : {}),
        actionsJson: actions.length > 0 ? JSON.stringify(actions) : "",
        activityJson: JSON.stringify(summary),
        // The level the reply actually ran at, when this attempt moved it.
        ...(finalThinking && JSON.stringify(finalThinking) !== claimedMessage.thinkingJson
          ? { thinkingJson: JSON.stringify(finalThinking) }
          : {}),
        turnWorkerId: null,
        turnLeaseExpiresAt: null,
      },
    );
    if (finalized.affected !== 1) {
      // Overtaken between the stop and this write. The Member's stop still has
      // to stick, so fall through to the unconditional finalize rather than
      // walking away from a turn they already cancelled.
      if (interrupted) {
        return finalizeInterruptedTurn(claimedMessage, workerId, result.reply, callbacks, activity);
      }
      await recorder.close();
      live.detach();
      return "claimed_elsewhere";
    }
    await recorder.finish(summary);

    context.conversation.updatedAt = new Date();
    await AppDataSource.getRepository(Conversation).save(context.conversation);
    emitResourceChange(context.employee.companyId, "employee_work", context.employee.id);
    const finalMessage = await messageRepo.findOneByOrFail({
      id: claimedMessage.id,
    });
    live.finish();
    safeFinalCallback(callbacks, {
      message: finalMessage,
      attachments: replyAttachments,
      conversation: context.conversation,
    });
    return "completed";
  } catch (error) {
    if (lostClaim) {
      await activity?.recorder.close();
      activity?.live.detach();
      return "claimed_elsewhere";
    }
    // A stop the human asked for is not a failure, even when the abort tore
    // through a seam that had no partial reply to hand back.
    if (interrupted) {
      return finalizeInterruptedTurn(
        claimedMessage,
        workerId,
        INTERRUPTED_BEFORE_REPLY,
        callbacks,
        activity,
      );
    }
    // eslint-disable-next-line no-console
    console.error(
      `[chat] durable turn failed conversation=${claimedMessage.conversationId} ` +
        `message=${claimedMessage.id}`,
      error,
    );
    return finalizeInfrastructureError(
      claimedMessage,
      workerId,
      error instanceof Error ? error.message : String(error),
      callbacks,
      activity,
    );
  } finally {
    workProgressEvents.cancel();
    replySnapshot.cancel();
    clearInterval(heartbeat);
    activeClaimAborters.delete(claimedMessage.id);
    activeTurnInterrupters.delete(claimedMessage.id);
    if (activity) {
      // Every path above ended the live record; this only covers a throw
      // between two of them, so no reader is left following a dead turn.
      activity.live.detach();
      releaseLiveTurn(activity.live);
    }
  }
}

/**
 * Stop a durable turn a Member asked Genosyn to abandon.
 *
 * The turn usually runs in this process, so the fast path aborts the agent
 * directly and lets the worker finalize its own row with whatever text the
 * human already read. When it doesn't — a turn another replica recovered —
 * finalizing here is both the answer to the Member and the stop signal: the
 * row leaves `working`, so the remote worker's next lease renewal fails and it
 * abandons the agent within a heartbeat. That path keeps the reply text the
 * worker last saved (it saves as it streams), which can trail the screen by a
 * second or two.
 */
export async function interruptDurableChatTurn(
  messageId: string,
): Promise<InterruptDurableChatTurnOutcome> {
  // A registered interrupter that declines has been overtaken by another
  // worker, so this falls through to the same path a turn running elsewhere
  // takes rather than reporting a stop that never happened.
  if (activeTurnInterrupters.get(messageId)?.()) return "interrupted";
  const repo = AppDataSource.getRepository(ConversationMessage);
  const current = await repo.findOne({
    where: { id: messageId, role: "assistant", status: "working" },
    select: ["id", "content", "conversationId", "createdAt", "turnAttempt", "turnDeadlineAt"],
  });
  if (!current) return "not_running";
  const kept = current.content.trim();
  const finalized = await repo.update(
    { id: messageId, role: "assistant", status: "working" },
    {
      content: kept || INTERRUPTED_BEFORE_REPLY,
      status: "interrupted",
      progressPercent: null,
      progressLabel: null,
      turnWorkerId: null,
      turnLeaseExpiresAt: null,
    },
  );
  if (finalized.affected !== 1) return "not_running";
  // Same reason as `finalizeInterruptedTurn`: this turn will never run again,
  // so the reply lease its worker acquired has to be dropped here or it blocks
  // the employee's chat until it expires. Deleting by owner key also releases
  // the lease of a worker that died mid-turn, which is exactly the state a
  // Member is usually reacting to when they reach for Stop.
  await releaseChatWorkloadLeaseByOwner(messageId);
  await recordStopOfTurnRunningElsewhere(current);
  await emitConversationWorkChange(current.conversationId);
  return "interrupted";
}

/**
 * Write the stop and the turn's end for a turn another process was running,
 * so its activity reads the same as one stopped here. Never fails the stop.
 */
async function recordStopOfTurnRunningElsewhere(
  message: Pick<
    ConversationMessage,
    "id" | "conversationId" | "createdAt" | "turnAttempt" | "turnDeadlineAt"
  >,
): Promise<void> {
  try {
    const conversation = await AppDataSource.getRepository(Conversation).findOne({
      where: { id: message.conversationId },
      select: ["id", "employeeId"],
    });
    const employee = conversation
      ? await AppDataSource.getRepository(AIEmployee).findOne({
          where: { id: conversation.employeeId },
          select: ["id", "companyId"],
        })
      : null;
    if (!employee) return;
    const recorder = new ChatTurnActivityRecorder(
      {
        companyId: employee.companyId,
        conversationId: message.conversationId,
        messageId: message.id,
        attempt: Math.max(1, message.turnAttempt),
      },
      await nextChatActivityOrdinal(message.id),
    );
    recorder.stopped();
    await recorder.flush();
    const summary = await summarizeChatActivity({
      messageId: message.id,
      status: "interrupted",
      startedAt: turnAcceptedAt(message),
      endedAt: new Date(),
    });
    await AppDataSource.getRepository(ConversationMessage).update(
      { id: message.id, status: "interrupted" },
      { activityJson: JSON.stringify(summary) },
    );
    await recorder.finish(summary);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn(`[chat:activity] could not record the stop of message ${message.id}`, error);
  }
}

/** Reply states a Member can ask to run again. */
const RETRYABLE_STATUSES = new Set(["error", "skipped", "busy"]);

/** A Retry the server cannot honor, with the HTTP status that says why. */
export class ChatTurnRetryError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ChatTurnRetryError";
  }
}

/**
 * Run a failed reply again, in place.
 *
 * The reply row goes back to `working` under the Member who asked, keeping its
 * request, attachments and recorded activity; the next worker attempt sees it
 * as a later attempt, so its prompt carries the recovery note that tells the
 * employee to check what the failed attempt already changed before doing it
 * again. Only the newest reply in a thread with nothing running can be
 * retried: running an older one again would answer a question the thread has
 * moved past.
 */
export async function retryDurableChatTurn(args: {
  companyId: string;
  employeeId: string;
  conversationId: string;
  messageId: string;
  requesterUserId: string;
  requesterSessionVersion: number;
}): Promise<ConversationMessage> {
  const message = await AppDataSource.transaction(async (manager) => {
    const conversationRepo = manager.getRepository(Conversation);
    const repo = manager.getRepository(ConversationMessage);
    const [conversation, requester, membership] = await Promise.all([
      conversationRepo.findOneBy({
        id: args.conversationId,
        employeeId: args.employeeId,
        ownerUserId: args.requesterUserId,
      }),
      manager.getRepository(User).findOneBy({ id: args.requesterUserId }),
      manager.getRepository(Membership).findOneBy({
        companyId: args.companyId,
        userId: args.requesterUserId,
      }),
    ]);
    if (!conversation) throw new ChatTurnRetryError("Conversation not found", 404);
    if (!requester || requester.sessionVersion !== args.requesterSessionVersion || !membership) {
      throw new ChatTurnRetryError(
        "Your company access changed. Reopen the company and try again.",
        403,
      );
    }
    const target = await repo.findOneBy({
      id: args.messageId,
      conversationId: conversation.id,
      role: "assistant",
    });
    if (!target) throw new ChatTurnRetryError("Message not found", 404);
    if (!target.status || !RETRYABLE_STATUSES.has(target.status) || !target.turnUserMessageId) {
      throw new ChatTurnRetryError("Only a reply that failed can be retried.", 409);
    }
    const running = await repo.findOne({
      where: { conversationId: conversation.id, role: "assistant", status: "working" },
      select: ["id"],
    });
    if (running) {
      throw new ChatTurnRetryError("Wait for the reply in progress to finish, then retry.", 409);
    }
    const newest = await repo.findOne({
      where: { conversationId: conversation.id, role: "assistant" },
      order: { createdAt: "DESC" },
      select: ["id", "createdAt"],
    });
    if (newest && newest.id !== target.id && newest.createdAt > target.createdAt) {
      throw new ChatTurnRetryError("Only the newest reply in a conversation can be retried.", 409);
    }
    const reset = await repo.update(
      { id: target.id, status: target.status },
      {
        content: "",
        status: "working",
        progressPercent: 1,
        progressLabel: RETRY_PROGRESS_LABEL,
        turnWorkerId: null,
        turnLeaseExpiresAt: null,
        turnDeadlineAt: new Date(Date.now() + CHAT_HARD_TIMEOUT_MS),
        turnRequesterUserId: args.requesterUserId,
        turnRequesterSessionVersion: args.requesterSessionVersion,
        actionsJson: "",
        activityJson: "",
      },
    );
    if (reset.affected !== 1) {
      throw new ChatTurnRetryError("This reply changed meanwhile. Reload the conversation.", 409);
    }
    conversation.updatedAt = new Date();
    await conversationRepo.save(conversation);
    return repo.findOneByOrFail({ id: target.id });
  });
  try {
    await recordDetachedChatActivity(
      {
        companyId: args.companyId,
        conversationId: args.conversationId,
        messageId: message.id,
        attempt: message.turnAttempt + 1,
      },
      (recorder) => recorder.notice("retry_requested", "Retry requested by a Member"),
    );
  } catch {
    // The retry stands without its note.
  }
  emitResourceChange(args.companyId, "employee_work", args.employeeId);
  return message;
}

async function loadTurnContext(
  assistantMessage: ConversationMessage,
  workerId: string,
): Promise<{
  conversation: Conversation;
  employee: AIEmployee;
  userMessage: ConversationMessage;
} | null> {
  const conversation = await AppDataSource.getRepository(Conversation).findOneBy({
    id: assistantMessage.conversationId,
  });
  if (!conversation) return null;
  if (
    !assistantMessage.turnRequesterUserId ||
    typeof assistantMessage.turnRequesterSessionVersion !== "number" ||
    conversation.ownerUserId !== assistantMessage.turnRequesterUserId
  ) {
    return null;
  }
  const employee = await AppDataSource.getRepository(AIEmployee).findOneBy({
    id: conversation.employeeId,
  });
  if (!employee) return null;

  let userMessage = assistantMessage.turnUserMessageId
    ? await AppDataSource.getRepository(ConversationMessage).findOneBy({
        id: assistantMessage.turnUserMessageId,
        conversationId: conversation.id,
        role: "user",
      })
    : null;
  if (!userMessage) {
    // Compatibility for a `working` row created by v1.75.0 immediately before
    // this migration was installed. New turns always carry the explicit link.
    const candidates = await AppDataSource.getRepository(ConversationMessage).find({
      where: { conversationId: conversation.id, role: "user" },
      order: { createdAt: "DESC" },
    });
    userMessage =
      candidates.find((candidate) => candidate.createdAt <= assistantMessage.createdAt) ?? null;
    if (userMessage) {
      assistantMessage.turnUserMessageId = userMessage.id;
      await AppDataSource.getRepository(ConversationMessage).update(
        {
          id: assistantMessage.id,
          status: "working",
          turnWorkerId: workerId,
        },
        { turnUserMessageId: userMessage.id },
      );
    }
  }
  return userMessage ? { conversation, employee, userMessage } : null;
}

async function buildTurnPrompt(args: {
  companyId: string;
  conversation: Conversation;
  userMessage: ConversationMessage;
  assistantMessage: ConversationMessage;
  attempt: number;
}): Promise<{ replay: ChatTurn[]; prompt: string; images?: ChatTurn["images"] }> {
  const allMessages = await AppDataSource.getRepository(ConversationMessage).find({
    where: { conversationId: args.conversation.id },
    order: { createdAt: "ASC" },
  });
  const userIndex = allMessages.findIndex((message) => message.id === args.userMessage.id);
  const prior = (userIndex >= 0 ? allMessages.slice(0, userIndex) : allMessages)
    .filter((message) => message.status !== "working")
    .slice(-MAX_REPLAY_TURNS);
  const imageContext = await attachmentImageContextForMessages(
    [
      ...prior.filter((message) => message.role === "user").map((message) => message.id),
      args.userMessage.id,
    ],
    args.companyId,
  );
  const priorAttachmentNotes = await historicalAttachmentSummaries(
    prior.map((message) => message.id),
    args.companyId,
  );
  const replay: ChatTurn[] = prior.map((message) => {
    const note = priorAttachmentNotes.get(message.id);
    const content = note ? `${message.content}\n[attached: ${note}]` : message.content;
    // A stopped reply is replayed because it is genuinely what the employee
    // said, but it stops mid-thought. Unmarked, the next turn reads it as a
    // finished answer and can carry on as though it had delivered something it
    // never did — so say plainly that the Member cut it off.
    return {
      role: message.role,
      images: message.role === "user" ? imageContext.get(message.id) : undefined,
      content:
        message.status === "interrupted"
          ? `${content}\n[This reply was cut short — the Member stopped it here.]`
          : content,
    };
  });

  const attachmentBlock = await inlineAttachmentsForMessage(args.userMessage.id, args.companyId);
  let prompt = attachmentBlock
    ? args.userMessage.content.trim()
      ? `${args.userMessage.content}\n\n${attachmentBlock}`
      : attachmentBlock
    : args.userMessage.content;

  if (args.attempt > 1) {
    let recordedActions: MessageAction[] = [];
    try {
      recordedActions = await captureTurnActionsForAuthority({
        companyId: args.companyId,
        employeeId: args.conversation.employeeId,
        since: new Date(args.assistantMessage.createdAt.getTime() - 10),
        authority: "member",
      });
    } catch {
      recordedActions = [];
    }
    const actionSummary =
      recordedActions.length > 0
        ? recordedActions
            .slice(-20)
            .map((action) => `- ${action.action}: ${action.targetLabel || action.targetType}`)
            .join("\n")
        : "- No completed database mutations were recorded.";
    prompt += [
      "",
      "",
      "## Durable recovery note",
      `A previous attempt at this same request did not finish — the server restarted mid-turn, the AI Model became unavailable and the request waited for it, or it ended in an error and the Member asked for a retry. This is attempt ${args.attempt}.`,
      `Last persisted progress: ${args.assistantMessage.progressPercent ?? 1}% — ${args.assistantMessage.progressLabel ?? "work in progress"}.`,
      "Inspect the current workspace and company state before changing anything. Continue completed work, do not repeat side effects, and use the progress control as you resume.",
      "Recorded mutations from all attempts so far:",
      actionSummary,
    ].join("\n");
  }

  return { replay, prompt, images: imageContext.get(args.userMessage.id) };
}

/**
 * Write down a stopped turn.
 *
 * Used for aborts that unwound through a seam holding no partial reply, and as
 * the backstop when the reply-bearing finalize loses its conditional write.
 *
 * The retry without the worker criterion is the point of this function. A stop
 * a Member asked for has to become terminal even if this process was overtaken
 * a moment earlier: leaving the row `working` would let the new claimant carry
 * on answering a question that has already been withdrawn. Taking it out of
 * `working` under that claimant is also how it learns — its next lease renewal
 * fails and it abandons the agent within a heartbeat.
 */
async function finalizeInterruptedTurn(
  message: ConversationMessage,
  workerId: string,
  content: string,
  callbacks: DurableChatTurnCallbacks,
  activity?: TurnActivity | null,
): Promise<DurableChatTurnOutcome> {
  const repo = AppDataSource.getRepository(ConversationMessage);
  // An abort that tore through a seam holding no reply still leaves whatever
  // this attempt streamed on the Member's screen; keep that rather than say
  // nothing was written.
  const streamed = activity?.live.text.trim() ?? "";
  const kept = content === INTERRUPTED_BEFORE_REPLY && streamed ? streamed : content;
  activity?.recorder.stopped();
  const summary =
    activity?.recorder.summarize({ status: "interrupted", startedAt: turnAcceptedAt(message) }) ??
    null;
  const patch = {
    content: kept,
    status: "interrupted" as const,
    progressPercent: null,
    progressLabel: null,
    turnWorkerId: null,
    turnLeaseExpiresAt: null,
    ...(summary ? { activityJson: JSON.stringify(summary) } : {}),
  };
  let finalized = await repo.update(
    { id: message.id, status: "working", turnWorkerId: workerId },
    patch,
  );
  if (finalized.affected !== 1) {
    finalized = await repo.update({ id: message.id, role: "assistant", status: "working" }, patch);
  }
  if (finalized.affected !== 1) {
    await activity?.recorder.close();
    activity?.live.detach();
    return "claimed_elsewhere";
  }
  // The row is terminal now, so nothing will ever re-acquire under this key and
  // trigger the lazy purge. Left behind, the employee reads as busy to every
  // later chat turn until a six-hour TTL runs out.
  await releaseChatWorkloadLeaseByOwner(message.id);
  if (activity && summary) await activity.recorder.finish(summary);

  const conversation = await AppDataSource.getRepository(Conversation).findOneBy({
    id: message.conversationId,
  });
  if (!conversation) {
    activity?.live.finish();
    return "completed";
  }
  conversation.updatedAt = new Date();
  await AppDataSource.getRepository(Conversation).save(conversation);
  await emitConversationWorkChange(conversation.id);
  const finalMessage = await repo.findOneByOrFail({ id: message.id });
  activity?.live.finish();
  safeFinalCallback(callbacks, {
    message: finalMessage,
    attachments: [],
    conversation,
  });
  return "completed";
}

async function finalizeInfrastructureError(
  message: ConversationMessage,
  workerId: string,
  detail: string,
  callbacks: DurableChatTurnCallbacks,
  activity?: TurnActivity | null,
): Promise<DurableChatTurnOutcome> {
  const cleanDetail = detail.replace(/\s+/g, " ").trim().slice(0, 1_000) || "Unknown server error";
  const content = [
    "Genosyn couldn’t complete this chat turn.",
    "",
    `Conversation: ${message.conversationId}`,
    `Details: ${cleanDetail}`,
    "",
    "The durable worker exhausted its recovery path. Check the Genosyn server logs for the [chat] entry with this conversation ID, then retry.",
  ].join("\n");
  const repo = AppDataSource.getRepository(ConversationMessage);
  const summary =
    activity?.recorder.summarize({ status: "error", startedAt: turnAcceptedAt(message) }) ?? null;
  const finalized = await repo.update(
    { id: message.id, status: "working", turnWorkerId: workerId },
    {
      content,
      status: "error",
      progressPercent: null,
      progressLabel: null,
      turnWorkerId: null,
      turnLeaseExpiresAt: null,
      ...(summary ? { activityJson: JSON.stringify(summary) } : {}),
    },
  );
  if (finalized.affected !== 1) {
    await activity?.recorder.close();
    activity?.live.detach();
    return "claimed_elsewhere";
  }
  if (activity && summary) await activity.recorder.finish(summary);

  const conversation = await AppDataSource.getRepository(Conversation).findOneBy({
    id: message.conversationId,
  });
  if (!conversation) {
    activity?.live.finish();
    return "completed";
  }
  conversation.updatedAt = new Date();
  await AppDataSource.getRepository(Conversation).save(conversation);
  await emitConversationWorkChange(conversation.id);
  const finalMessage = await repo.findOneByOrFail({ id: message.id });
  activity?.live.finish();
  safeFinalCallback(callbacks, {
    message: finalMessage,
    attachments: [],
    conversation,
  });
  return "completed";
}

function safeFinalCallback(
  callbacks: DurableChatTurnCallbacks,
  result: {
    message: ConversationMessage;
    attachments: Attachment[];
    conversation: Conversation;
  },
): void {
  try {
    callbacks.onFinal?.(result);
  } catch {
    // The database is final even when an SSE subscriber has gone away.
  }
}

async function recoverAvailableTurns(): Promise<void> {
  const now = new Date();
  const candidates = await AppDataSource.getRepository(ConversationMessage).find({
    where: [
      {
        role: "assistant",
        status: "working",
        turnLeaseExpiresAt: IsNull(),
      },
      {
        role: "assistant",
        status: "working",
        turnLeaseExpiresAt: LessThanOrEqual(now),
      },
    ],
    order: { createdAt: "ASC" },
    take: MAX_RECOVERIES_PER_SWEEP,
  });
  for (const candidate of candidates) {
    if (locallyExecuting.has(candidate.id)) continue;
    locallyExecuting.add(candidate.id);
    void executeDurableChatTurn(candidate.id)
      .then((outcome) => {
        if (outcome === "completed") {
          // eslint-disable-next-line no-console
          console.log(
            `[chat:recovery] completed conversation=${candidate.conversationId} ` +
              `message=${candidate.id}`,
          );
        }
      })
      .catch((error) => {
        // eslint-disable-next-line no-console
        console.error(`[chat:recovery] message=${candidate.id}`, error);
      })
      .finally(() => locallyExecuting.delete(candidate.id));
  }
}

/**
 * When an AI Model answers again, the replies waiting for it are looked at
 * now rather than at their next look: each is due at once, and a sweep runs.
 * A reply whose own model is still down simply waits again.
 */
async function lookAtWaitingReplies(): Promise<void> {
  const waiting = await modelWaitingChatTurns();
  if (waiting.length === 0) return;
  const now = new Date();
  for (const message of waiting) {
    await AppDataSource.getRepository(ConversationMessage).update(
      { id: message.id, status: "working", turnWorkerId: IsNull() },
      { turnLeaseExpiresAt: now },
    );
  }
  await recoverAvailableTurns();
}

onModelAvailabilityChange((change) => {
  if (!change.available || !recoveryTimer) return;
  void lookAtWaitingReplies().catch((error) => {
    // eslint-disable-next-line no-console
    console.error("[chat:recovery] could not resume replies waiting for an AI Model", error);
  });
});

/**
 * Start crash recovery after migrations. SQLite is single-process, so every
 * inherited claim is immediately known dead. Postgres may have live sibling
 * replicas, so it waits for the renewable 15-second claim to expire.
 */
export async function bootDurableChatTurnRecovery(): Promise<void> {
  if (recoveryTimer) clearInterval(recoveryTimer);
  if (config.db.driver !== "postgres") {
    await AppDataSource.getRepository(ConversationMessage).update(
      { role: "assistant", status: "working" },
      { turnWorkerId: null, turnLeaseExpiresAt: null },
    );
  }
  await recoverAvailableTurns();
  recoveryTimer = setInterval(() => {
    void recoverAvailableTurns().catch((error) => {
      // eslint-disable-next-line no-console
      console.error("[chat:recovery] sweep failed", error);
    });
  }, RECOVERY_POLL_MS);
  recoveryTimer.unref?.();
}

/** Test/restore seam; normal server shutdown simply lets the timer disappear. */
export function stopDurableChatTurnRecovery(): void {
  if (recoveryTimer) clearInterval(recoveryTimer);
  recoveryTimer = null;
  for (const abort of activeClaimAborters.values()) abort();
}
