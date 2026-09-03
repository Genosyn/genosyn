import { randomUUID } from "node:crypto";
import { IsNull, LessThanOrEqual } from "typeorm";

import { config } from "../../config.js";
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
import { createChatTurnContextUsageRecorder } from "./chatTurnContextUsage.js";
import {
  createChatTurnProgressRecorder,
  createProgressRefreshNotifier,
} from "./chatTurnProgress.js";
import { historicalAttachmentSummaries, inlineAttachmentsForMessage } from "./attachmentText.js";
import { emitResourceChange } from "./resourceEvents.js";
import { captureTurnActionsForAuthority } from "./turnActions.js";
import { bindAttachmentsToMessage } from "./uploads.js";
import { EmployeeWorkloadBusyError, releaseChatWorkloadLeaseByOwner } from "./workloadLeases.js";

const MAX_REPLAY_TURNS = 20;
const TURN_LEASE_MS = 15_000;
const TURN_HEARTBEAT_MS = 5_000;
const RECOVERY_POLL_MS = 5_000;
const BUSY_RETRY_MS = 15_000;
const MAX_RECOVERIES_PER_SWEEP = 10;
const WORK_PROGRESS_EVENT_INTERVAL_MS = 30_000;

export type DurableChatTurnCallbacks = {
  onChunk?: (chunk: string) => void;
  onProgress?: (progress: AgentProgress) => void;
  onContextUsage?: (usage: ContextUsage) => void;
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
};

let recoveryTimer: NodeJS.Timeout | null = null;
const locallyExecuting = new Set<string>();
const activeClaimAborters = new Map<string, () => void>();
/** Returns false when this process no longer owns the turn it registered for. */
const activeTurnInterrupters = new Map<string, () => boolean>();

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
  if (message.turnAttempt > 1) {
    message.progressLabel = "Resuming durable work";
    await repo.update(
      { id: message.id, status: "working", turnWorkerId: workerId },
      { progressLabel: message.progressLabel },
    );
  }
  return { message, workerId };
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

  const { message: claimedMessage, workerId } = claimed;
  const messageRepo = AppDataSource.getRepository(ConversationMessage);
  const claimController = new AbortController();
  let lostClaim = false;
  let interrupted = false;
  let renewing = false;
  let workScope: { companyId: string; employeeId: string } | null = null;
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
  // Deliberately not `loseClaim`: this process keeps the claim so it can write
  // the partial reply the human already read on screen. The agent stops either
  // way — both paths abort the same controller. Reports whether it actually
  // took effect: a worker that has already lost the turn cannot stop it, and
  // saying otherwise would leave the Member watching a reply they thought they
  // had cancelled.
  const interruptTurn = (): boolean => {
    if (lostClaim) return false;
    interrupted = true;
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
      );
    }

    const { replay, prompt } = await buildTurnPrompt({
      companyId: context.employee.companyId,
      conversation: context.conversation,
      userMessage: context.userMessage,
      assistantMessage: claimedMessage,
      attempt: claimedMessage.turnAttempt,
    });

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
      result = await streamChatWithEmployee(
        context.employee.companyId,
        context.employee.id,
        prompt,
        replay,
        (chunk) => {
          try {
            callbacks.onChunk?.(chunk);
          } catch {
            // A disconnected browser is only a lost subscriber.
          }
        },
        {
          conversationId: context.conversation.id,
          modelId: claimedMessage.modelId,
          surface: context.conversation.source === "help" ? "help" : "chat",
          ...requesterAuthority,
          onProgress: progressRecorder.report,
          onContextUsage: contextUsageRecorder.report,
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
        await Promise.all([progressRecorder.flush(), contextUsageRecorder.flush()]);
        return finalizeInterruptedTurn(
          claimedMessage,
          workerId,
          INTERRUPTED_BEFORE_REPLY,
          callbacks,
        );
      }
      if (lostClaim) return "claimed_elsewhere";
      if (error instanceof EmployeeWorkloadBusyError) {
        await Promise.all([progressRecorder.flush(), contextUsageRecorder.flush()]);
        const label = "Waiting for another reply";
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
            );
          }
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
        return "claimed_elsewhere";
      }
      throw error;
    }

    await Promise.all([progressRecorder.flush(), contextUsageRecorder.flush()]);
    if (!lostClaim) await renewClaim();
    if (lostClaim) {
      // Overtaken while the agent unwound. Ordinary claim loss is somebody
      // else's problem now, but a stop the Member asked for still has to stick
      // — `finalizeInterruptedTurn` writes it under whoever holds the row.
      if (interrupted) {
        return finalizeInterruptedTurn(claimedMessage, workerId, result.reply, callbacks);
      }
      return "claimed_elsewhere";
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
    const finalized = await messageRepo.update(
      {
        id: claimedMessage.id,
        status: "working",
        turnWorkerId: workerId,
      },
      {
        content: result.reply,
        // A Member who stopped this turn asked for exactly what is on screen.
        // The agent's own status describes how the model unwound, which after
        // an abort is usually a transport error — not the answer to "did the
        // human get what they asked for".
        status: interrupted ? "interrupted" : result.status,
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
        turnWorkerId: null,
        turnLeaseExpiresAt: null,
      },
    );
    if (finalized.affected !== 1) {
      // Overtaken between the stop and this write. The Member's stop still has
      // to stick, so fall through to the unconditional finalize rather than
      // walking away from a turn they already cancelled.
      if (interrupted) {
        return finalizeInterruptedTurn(claimedMessage, workerId, result.reply, callbacks);
      }
      return "claimed_elsewhere";
    }

    context.conversation.updatedAt = new Date();
    await AppDataSource.getRepository(Conversation).save(context.conversation);
    emitResourceChange(context.employee.companyId, "employee_work", context.employee.id);
    const finalMessage = await messageRepo.findOneByOrFail({
      id: claimedMessage.id,
    });
    safeFinalCallback(callbacks, {
      message: finalMessage,
      attachments: replyAttachments,
      conversation: context.conversation,
    });
    return "completed";
  } catch (error) {
    if (lostClaim) return "claimed_elsewhere";
    // A stop the human asked for is not a failure, even when the abort tore
    // through a seam that had no partial reply to hand back.
    if (interrupted) {
      return finalizeInterruptedTurn(claimedMessage, workerId, INTERRUPTED_BEFORE_REPLY, callbacks);
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
    );
  } finally {
    workProgressEvents.cancel();
    clearInterval(heartbeat);
    activeClaimAborters.delete(claimedMessage.id);
    activeTurnInterrupters.delete(claimedMessage.id);
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
 * abandons the agent within a heartbeat. That path cannot keep the partial
 * reply, because the text only exists in the other process's memory.
 */
export async function interruptDurableChatTurn(
  messageId: string,
): Promise<InterruptDurableChatTurnOutcome> {
  // A registered interrupter that declines has been overtaken by another
  // worker, so this falls through to the same path a turn running elsewhere
  // takes rather than reporting a stop that never happened.
  if (activeTurnInterrupters.get(messageId)?.()) return "interrupted";
  const repo = AppDataSource.getRepository(ConversationMessage);
  const finalized = await repo.update(
    { id: messageId, role: "assistant", status: "working" },
    {
      content: INTERRUPTED_BEFORE_REPLY,
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
  const message = await repo.findOne({ where: { id: messageId }, select: ["conversationId"] });
  if (message) await emitConversationWorkChange(message.conversationId);
  return "interrupted";
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
}): Promise<{ replay: ChatTurn[]; prompt: string }> {
  const allMessages = await AppDataSource.getRepository(ConversationMessage).find({
    where: { conversationId: args.conversation.id },
    order: { createdAt: "ASC" },
  });
  const userIndex = allMessages.findIndex((message) => message.id === args.userMessage.id);
  const prior = (userIndex >= 0 ? allMessages.slice(0, userIndex) : allMessages)
    .filter((message) => message.status !== "working")
    .slice(-MAX_REPLAY_TURNS);
  const priorAttachmentNotes = await historicalAttachmentSummaries(
    prior.map((message) => message.id),
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
      `The prior process was interrupted while handling this same request. This is recovery attempt ${args.attempt}.`,
      `Last persisted progress: ${args.assistantMessage.progressPercent ?? 1}% — ${args.assistantMessage.progressLabel ?? "work in progress"}.`,
      "Inspect the current workspace and company state before changing anything. Continue completed work, do not repeat side effects, and use the progress control as you resume.",
      "Recorded mutations from all attempts so far:",
      actionSummary,
    ].join("\n");
  }

  return { replay, prompt };
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
): Promise<DurableChatTurnOutcome> {
  const repo = AppDataSource.getRepository(ConversationMessage);
  const patch = {
    content,
    status: "interrupted" as const,
    progressPercent: null,
    progressLabel: null,
    turnWorkerId: null,
    turnLeaseExpiresAt: null,
  };
  let finalized = await repo.update(
    { id: message.id, status: "working", turnWorkerId: workerId },
    patch,
  );
  if (finalized.affected !== 1) {
    finalized = await repo.update({ id: message.id, role: "assistant", status: "working" }, patch);
  }
  if (finalized.affected !== 1) return "claimed_elsewhere";
  // The row is terminal now, so nothing will ever re-acquire under this key and
  // trigger the lazy purge. Left behind, the employee reads as busy to every
  // later chat turn until a six-hour TTL runs out.
  await releaseChatWorkloadLeaseByOwner(message.id);

  const conversation = await AppDataSource.getRepository(Conversation).findOneBy({
    id: message.conversationId,
  });
  if (!conversation) return "completed";
  conversation.updatedAt = new Date();
  await AppDataSource.getRepository(Conversation).save(conversation);
  await emitConversationWorkChange(conversation.id);
  const finalMessage = await repo.findOneByOrFail({ id: message.id });
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
  const finalized = await repo.update(
    { id: message.id, status: "working", turnWorkerId: workerId },
    {
      content,
      status: "error",
      progressPercent: null,
      progressLabel: null,
      turnWorkerId: null,
      turnLeaseExpiresAt: null,
    },
  );
  if (finalized.affected !== 1) return "claimed_elsewhere";

  const conversation = await AppDataSource.getRepository(Conversation).findOneBy({
    id: message.conversationId,
  });
  if (!conversation) return "completed";
  conversation.updatedAt = new Date();
  await AppDataSource.getRepository(Conversation).save(conversation);
  await emitConversationWorkChange(conversation.id);
  const finalMessage = await repo.findOneByOrFail({ id: message.id });
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
