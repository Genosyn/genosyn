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
  streamChatWithEmployee,
} from "./chat.js";
import { createChatTurnContextUsageRecorder } from "./chatTurnContextUsage.js";
import { createChatTurnProgressRecorder } from "./chatTurnProgress.js";
import { historicalAttachmentSummaries, inlineAttachmentsForMessage } from "./attachmentText.js";
import { captureTurnActionsForAuthority } from "./turnActions.js";
import { bindAttachmentsToMessage } from "./uploads.js";
import { EmployeeWorkloadBusyError, WorkloadLimitError } from "./workloadLeases.js";

const MAX_REPLAY_TURNS = 20;
const TURN_LEASE_MS = 15_000;
const TURN_HEARTBEAT_MS = 5_000;
const RECOVERY_POLL_MS = 5_000;
const CAPACITY_RETRY_MS = 15_000;
const MAX_RECOVERIES_PER_SWEEP = 10;

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

type ClaimedTurn = {
  message: ConversationMessage;
  workerId: string;
};

let recoveryTimer: NodeJS.Timeout | null = null;
const locallyExecuting = new Set<string>();
const activeClaimAborters = new Map<string, () => void>();

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
  return AppDataSource.transaction(async (manager) => {
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
  let renewing = false;

  const loseClaim = () => {
    lostClaim = true;
    claimController.abort();
  };
  activeClaimAborters.set(claimedMessage.id, loseClaim);
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
        },
      );
    } catch (error) {
      if (lostClaim) return "claimed_elsewhere";
      if (error instanceof WorkloadLimitError || error instanceof EmployeeWorkloadBusyError) {
        await Promise.all([progressRecorder.flush(), contextUsageRecorder.flush()]);
        const label = "Waiting for AI workload capacity";
        const deferred = await messageRepo.update(
          {
            id: claimedMessage.id,
            status: "working",
            turnWorkerId: workerId,
          },
          {
            turnWorkerId: null,
            turnLeaseExpiresAt: new Date(Date.now() + CAPACITY_RETRY_MS),
            progressLabel: label,
          },
        );
        if (deferred.affected === 1) {
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
    if (lostClaim) return "claimed_elsewhere";
    await renewClaim();
    if (lostClaim) return "claimed_elsewhere";

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
        status: result.status,
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
    if (finalized.affected !== 1) return "claimed_elsewhere";

    context.conversation.updatedAt = new Date();
    await AppDataSource.getRepository(Conversation).save(context.conversation);
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
    clearInterval(heartbeat);
    activeClaimAborters.delete(claimedMessage.id);
  }
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
    return {
      role: message.role,
      content: note ? `${message.content}\n[attached: ${note}]` : message.content,
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
