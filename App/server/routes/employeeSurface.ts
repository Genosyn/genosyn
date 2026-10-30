import { ParallelWorkerResult } from "../db/entities/ParallelWorkerResult.js";
import { Router, type Request } from "express";
import { z } from "zod";
import { In, IsNull, Not } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { Conversation, type ConversationSource } from "../db/entities/Conversation.js";
import { ConversationMessage } from "../db/entities/ConversationMessage.js";
import { JournalEntry } from "../db/entities/JournalEntry.js";
import { EmployeeMemory } from "../db/entities/EmployeeMemory.js";
import {
  onRoutePaths,
  requireAuth,
  requireBrowserSession,
  requireCompanyMember,
} from "../middleware/auth.js";
import { validateBody, validateParams, validateQuery } from "../middleware/validate.js";
import { ConversationActivityEvent } from "../db/entities/ConversationActivityEvent.js";
import { listChatActivity, turnAcceptedAt } from "../services/chatTurnActivity.js";
import { followChatTurn } from "../services/chatTurnFollow.js";
import { lastChatModelChoice, lastChatModelChoices } from "../services/conversationModels.js";
import {
  serializeConversation,
  serializeConversationDetail,
  serializeMessage,
  summarizeAttachment,
} from "../services/conversationSerialization.js";
import {
  ChatTurnRetryError,
  enqueueDurableChatTurn,
  executeDurableChatTurn,
  interruptDurableChatTurn,
  retryDurableChatTurn,
} from "../services/durableChatTurns.js";
import {
  chatTurnThinking,
  conversationEffortForMessage,
  setConversationEffort,
} from "../services/chatThinking.js";
import { resolveChatModel } from "../services/models.js";
import {
  attachmentsForMessages,
  recordAttachment,
  resolveAttachmentFile,
  uploadMiddleware,
} from "../services/uploads.js";
import { MODEL_EFFORT_VALUES } from "../../shared/modelEffort.js";

/**
 * Chat + per-employee surface endpoints. Split from `employees.ts` to keep
 * the employee CRUD file focused — these reach into the runner seam (chat
 * streaming) and the journal/memory tables.
 */
export const employeeSurfaceRouter = Router({ mergeParams: true });
employeeSurfaceRouter.use(requireAuth);
employeeSurfaceRouter.use(requireCompanyMember);
// Direct web/help conversations carry a human Member's delegated authority.
// API keys are automation credentials and cannot read, mutate, or launch
// these private browser conversations. Journal and memory routes remain
// available to documented API automation.
employeeSurfaceRouter.use(
  onRoutePaths([/^\/[^/]+\/(?:conversations|chat-attachments)(?:\/|$)/], requireBrowserSession),
);

// Hydrate `req.company` from the URL `cid` so the multer destination
// callback (which runs before any handler) can compute the per-company
// attachments dir. Scoped to the upload: the other routes here load the
// company with their employee, and the routers mounted after this one at
// `/api/companies/:cid/employees` have no use for it.
employeeSurfaceRouter.use(
  onRoutePaths([/^\/[^/]+\/chat-attachments$/], async (req, res, next) => {
    const cid = (req.params as Record<string, string>).cid;
    if (!cid) return next();
    let co: Company | null;
    try {
      co = await AppDataSource.getRepository(Company).findOneBy({ id: cid });
    } catch (error) {
      // Express 4 drops a rejected promise; answer through the error handler.
      return next(error);
    }
    if (!co) return res.status(404).json({ error: "Company not found" });
    (req as unknown as { company: Company }).company = co;
    next();
  }),
);

async function loadEmpAndCompany(
  cid: string,
  eid: string,
): Promise<{ emp: AIEmployee; co: Company } | null> {
  const emp = await AppDataSource.getRepository(AIEmployee).findOneBy({
    id: eid,
    companyId: cid,
  });
  if (!emp) return null;
  const co = await AppDataSource.getRepository(Company).findOneBy({ id: cid });
  if (!co) return null;
  return { emp, co };
}

// ---------- Conversations ----------

/**
 * How often the streamed-send endpoint emits an SSE keepalive comment while a
 * turn is in flight. A single agent turn can spend well over a minute between
 * visible `chunk` events — the model "thinks" before its first token, and
 * tools (bash, browser, MCP) run silently in between. During those gaps no
 * bytes flow, and any idle reverse proxy in front of a self-hosted Genosyn
 * (nginx `proxy_read_timeout` 60s, Caddy, cloud load balancers at 30–100s)
 * resets the connection — which surfaces in the browser as a mid-stream
 * `network error`. A comment line every 15s stays under those idle timers.
 */
const CHAT_STREAM_HEARTBEAT_MS = 10_000;

function canManageLegacyConversations(req: Request): boolean {
  return req.companyRole === "owner" || req.companyRole === "admin";
}

async function findAccessibleConversation(args: {
  req: Request;
  employeeId: string;
  conversationId: string;
}): Promise<Conversation | null> {
  const repo = AppDataSource.getRepository(Conversation);
  const owned = await repo.findOneBy({
    id: args.conversationId,
    employeeId: args.employeeId,
    ownerUserId: args.req.userId!,
  });
  if (owned || !canManageLegacyConversations(args.req)) return owned;
  return repo.findOneBy({
    id: args.conversationId,
    employeeId: args.employeeId,
    ownerUserId: IsNull(),
    source: In(["web", "help"]),
  });
}

function formatChatInfrastructureError(error: unknown, conversationId: string): string {
  const raw = error instanceof Error ? error.message : String(error);
  const detail = raw.replace(/\s+/g, " ").trim().slice(0, 1_000) || "Unknown server error";
  return [
    "Genosyn couldn’t complete this chat turn.",
    "",
    `Conversation: ${conversationId}`,
    `Details: ${detail}`,
    "",
    "Check the Genosyn server logs for the [chat] entry with this conversation ID. If this employee uses Browser or company MCP servers, confirm those processes and endpoints are reachable, then retry.",
  ].join("\n");
}

const conversationSurfaceSchema = z.enum(["web", "help"]);
const conversationListQuerySchema = z.object({
  archived: z.enum(["0", "1"]).optional().default("0"),
  surface: conversationSurfaceSchema.optional().default("web"),
});
/** A conversation's thinking level: how hard the AI Model thinks; null is Default. */
const conversationEffortSchema = z.enum(MODEL_EFFORT_VALUES).nullable();
const createConversationSchema = z.object({
  surface: conversationSurfaceSchema.optional().default("web"),
  /** The thinking level the new conversation starts at; omitted is Default. */
  effort: conversationEffortSchema.optional(),
});

employeeSurfaceRouter.get("/:eid/conversations", async (req, res) => {
  const { cid, eid } = req.params as Record<string, string>;
  const loaded = await loadEmpAndCompany(cid, eid);
  if (!loaded) return res.status(404).json({ error: "Not found" });
  const parsed = conversationListQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "ValidationError", issues: parsed.error.issues });
  }
  // `?archived=1` returns only archived threads, default returns only
  // active ones. The sidebar flips between the two via a disclosure.
  const wantsArchived = parsed.data.archived === "1";
  const archivedAt = wantsArchived ? Not(IsNull()) : IsNull();
  const ownedWhere = {
    employeeId: eid,
    ownerUserId: req.userId!,
    source: parsed.data.surface,
    archivedAt,
  };
  const rows = await AppDataSource.getRepository(Conversation).find({
    where: canManageLegacyConversations(req)
      ? [ownedWhere, { ...ownedWhere, ownerUserId: IsNull() }]
      : ownedWhere,
    order: { updatedAt: "DESC" },
  });
  const lastChoices = await lastChatModelChoices(
    eid,
    rows.map((r) => r.id),
  );
  res.json(rows.map((r) => serializeConversation(r, r.updatedAt, lastChoices.get(r.id) ?? null)));
});

employeeSurfaceRouter.post(
  "/:eid/conversations",
  validateBody(createConversationSchema),
  async (req, res) => {
    const { cid, eid } = req.params as Record<string, string>;
    const loaded = await loadEmpAndCompany(cid, eid);
    if (!loaded) return res.status(404).json({ error: "Not found" });
    const body = req.body as z.infer<typeof createConversationSchema>;
    const repo = AppDataSource.getRepository(Conversation);
    const conv = repo.create({
      employeeId: eid,
      ownerUserId: req.userId!,
      title: null,
      source: body.surface as ConversationSource,
      effort: body.effort ?? null,
    });
    await repo.save(conv);
    res.json(serializeConversation(conv));
  },
);

const conversationParamsSchema = z.object({
  cid: z.string().min(1),
  eid: z.string().min(1),
  convId: z.string().min(1),
});
const conversationThinkingSchema = z.object({ effort: conversationEffortSchema }).strict();

/**
 * Set how hard the AI Model thinks in this conversation — its thinking level,
 * or null for Default (the AI Model's default for chat). It sticks to the
 * conversation, across AI Models: each message resolves it against the model
 * it runs on, moving to the nearest level that model offers and the company
 * allows, and the reply records the level it ran at. Only the conversation's
 * owner sets it, from a signed-in browser, like sending to it. A level changes
 * how hard the model thinks, never what the turn may do.
 */
employeeSurfaceRouter.put(
  "/:eid/conversations/:convId/thinking",
  validateParams(conversationParamsSchema),
  validateBody(conversationThinkingSchema),
  async (req, res) => {
    const { cid, eid, convId } = req.params as Record<string, string>;
    const loaded = await loadEmpAndCompany(cid, eid);
    if (!loaded) return res.status(404).json({ error: "Not found" });
    const { effort } = req.body as z.infer<typeof conversationThinkingSchema>;
    const conv = await setConversationEffort({
      conversationId: convId,
      employeeId: eid,
      ownerUserId: req.userId!,
      effort,
    });
    if (!conv) return res.status(404).json({ error: "Not found" });
    res.json(serializeConversation(conv, conv.updatedAt, await lastChatModelChoice(eid, conv.id)));
  },
);

employeeSurfaceRouter.get("/:eid/conversations/:convId", async (req, res) => {
  const { cid, eid, convId } = req.params as Record<string, string>;
  const loaded = await loadEmpAndCompany(cid, eid);
  if (!loaded) return res.status(404).json({ error: "Not found" });
  const conv = await findAccessibleConversation({ req, employeeId: eid, conversationId: convId });
  if (!conv) return res.status(404).json({ error: "Not found" });
  res.json(await serializeConversationDetail(conv));
});

/**
 * Claim a pre-owner-column web/help conversation after an upgrade. Only an
 * owner/admin can see the legacy row, and the conditional update makes the
 * first explicit claimant win. Unattributed working turns are terminalized:
 * resuming them under the claimant's authority would silently elevate an
 * unknown historical requester.
 */
employeeSurfaceRouter.post(
  "/:eid/conversations/:convId/claim",
  async (req, res) => {
    const { cid, eid, convId } = req.params as Record<string, string>;
    const loaded = await loadEmpAndCompany(cid, eid);
    if (!loaded) return res.status(404).json({ error: "Not found" });
    if (!canManageLegacyConversations(req)) {
      return res.status(403).json({ error: "Owner or admin company role required" });
    }

    const claimed = await AppDataSource.transaction(async (manager) => {
      const conversationRepo = manager.getRepository(Conversation);
      const result = await conversationRepo.update(
        {
          id: convId,
          employeeId: eid,
          ownerUserId: IsNull(),
          source: In(["web", "help"]),
        },
        { ownerUserId: req.userId! },
      );
      if (result.affected !== 1) return null;

      await manager.getRepository(ConversationMessage).update(
        {
          conversationId: convId,
          role: "assistant",
          status: "working",
          turnRequesterUserId: IsNull(),
        },
        {
          content:
            "Genosyn couldn’t resume this legacy chat turn because its original Member authority was not recorded. Send the request again to continue safely.",
          status: "error",
          progressPercent: null,
          progressLabel: null,
          turnWorkerId: null,
          turnLeaseExpiresAt: null,
        },
      );
      return conversationRepo.findOneBy({ id: convId, employeeId: eid, ownerUserId: req.userId! });
    });

    if (!claimed) {
      const alreadyOwned = await AppDataSource.getRepository(Conversation).findOneBy({
        id: convId,
        employeeId: eid,
        ownerUserId: req.userId!,
      });
      if (alreadyOwned)
        return res.json(
          serializeConversation(
            alreadyOwned,
            alreadyOwned.updatedAt,
            await lastChatModelChoice(eid, alreadyOwned.id),
          ),
        );
      return res.status(409).json({ error: "Conversation has already been claimed" });
    }
    res.json(
      serializeConversation(claimed, claimed.updatedAt, await lastChatModelChoice(eid, claimed.id)),
    );
  },
);

employeeSurfaceRouter.post("/:eid/conversations/:convId/archive", async (req, res) => {
  const { cid, eid, convId } = req.params as Record<string, string>;
  const loaded = await loadEmpAndCompany(cid, eid);
  if (!loaded) return res.status(404).json({ error: "Not found" });
  const repo = AppDataSource.getRepository(Conversation);
  const conv = await repo.findOneBy({
    id: convId,
    employeeId: eid,
    ownerUserId: req.userId!,
  });
  if (!conv) return res.status(404).json({ error: "Not found" });
  if (!conv.archivedAt) {
    conv.archivedAt = new Date();
    await repo.save(conv);
  }
  res.json(serializeConversation(conv, conv.updatedAt, await lastChatModelChoice(eid, conv.id)));
});

employeeSurfaceRouter.post("/:eid/conversations/:convId/unarchive", async (req, res) => {
  const { cid, eid, convId } = req.params as Record<string, string>;
  const loaded = await loadEmpAndCompany(cid, eid);
  if (!loaded) return res.status(404).json({ error: "Not found" });
  const repo = AppDataSource.getRepository(Conversation);
  const conv = await repo.findOneBy({
    id: convId,
    employeeId: eid,
    ownerUserId: req.userId!,
  });
  if (!conv) return res.status(404).json({ error: "Not found" });
  if (conv.archivedAt) {
    conv.archivedAt = null;
    await repo.save(conv);
  }
  res.json(serializeConversation(conv, conv.updatedAt, await lastChatModelChoice(eid, conv.id)));
});

employeeSurfaceRouter.delete("/:eid/conversations/:convId", async (req, res) => {
  const { cid, eid, convId } = req.params as Record<string, string>;
  const loaded = await loadEmpAndCompany(cid, eid);
  if (!loaded) return res.status(404).json({ error: "Not found" });
  const convRepo = AppDataSource.getRepository(Conversation);
  const conv = await convRepo.findOneBy({
    id: convId,
    employeeId: eid,
    ownerUserId: req.userId!,
  });
  if (!conv) return res.status(404).json({ error: "Not found" });
  await AppDataSource.getRepository(ConversationActivityEvent).delete({
    conversationId: conv.id,
  });
  await AppDataSource.getRepository(ConversationMessage).delete({
    conversationId: conv.id,
  });
  await AppDataSource.getRepository(ParallelWorkerResult).delete({
    employeeId: eid,
    scopeKey: `conversation:${conv.id}`,
  });
  await convRepo.delete({ id: conv.id });
  res.json({ ok: true });
});

// ---------- Chat attachments ----------

/**
 * Upload a single file to be attached to the next chat message. Anonymous
 * until the composer sends — at which point `attachmentIds` on the send
 * payload binds the row to the user message. Storage and validation reuse
 * the workspace upload pipeline so both surfaces share one on-disk layout.
 */
employeeSurfaceRouter.post(
  "/:eid/chat-attachments",
  uploadMiddleware.single("file"),
  async (req, res) => {
    const { cid, eid } = req.params as Record<string, string>;
    const loaded = await loadEmpAndCompany(cid, eid);
    if (!loaded) return res.status(404).json({ error: "Not found" });
    const file = (req as unknown as { file?: Express.Multer.File }).file;
    if (!file) return res.status(400).json({ error: "No file uploaded" });
    const row = await recordAttachment({
      companyId: loaded.co.id,
      companySlug: loaded.co.slug,
      file,
      uploadedByUserId: req.userId!,
    });
    res.status(201).json(summarizeAttachment(row));
  },
);

employeeSurfaceRouter.get("/:eid/chat-attachments/:attachmentId", async (req, res) => {
  const { cid, eid, attachmentId } = req.params as Record<string, string>;
  const loaded = await loadEmpAndCompany(cid, eid);
  if (!loaded) return res.status(404).json({ error: "Not found" });
  const resolved = await resolveAttachmentFile(attachmentId, loaded.co.id);
  if (!resolved) {
    return res.status(404).json({ error: "Attachment not found" });
  }
  if (resolved.row.uploadedByUserId !== req.userId) {
    if (!resolved.row.messageId) {
      return res.status(404).json({ error: "Attachment not found" });
    }
    const message = await AppDataSource.getRepository(ConversationMessage).findOneBy({
      id: resolved.row.messageId,
    });
    const conversation = message
      ? await findAccessibleConversation({
          req,
          employeeId: eid,
          conversationId: message.conversationId,
        })
      : null;
    if (!conversation) {
      return res.status(404).json({ error: "Attachment not found" });
    }
  }
  res.setHeader("Content-Type", resolved.row.mimeType);
  const inline = resolved.row.mimeType.startsWith("image/");
  const disposition = inline ? "inline" : "attachment";
  res.setHeader(
    "Content-Disposition",
    `${disposition}; filename="${encodeURIComponent(resolved.row.filename)}"`,
  );
  res.sendFile(resolved.absPath);
});

const sendSchema = z.object({
  message: z.string().max(8000).default(""),
  attachmentIds: z.array(z.string().uuid()).max(20).optional().default([]),
  modelId: z.string().uuid().nullable().optional().default(null),
  /**
   * The conversation's thinking level, set by this message (null is Default).
   * Omitted, the message goes at the level the conversation already has.
   */
  effort: conversationEffortSchema.optional(),
});

/**
 * Streamed send. Responds with Server-Sent Events so the browser can paint
 * the reply token-by-token as it arrives from the agent instead of blocking
 * on a single JSON response for 5-10s per message.
 *
 * Event shape:
 *   event: user       — persisted user message row (first, so the client can
 *                       swap its optimistic bubble)
 *   event: chunk      — raw stdout delta from the CLI (`{ text: "..." }`)
 *   event: working    — durable assistant placeholder for this turn
 *   event: progress   — live employee-authored progress (`{ percent, label }`)
 *   event: context    — how full the model's context window is after the last
 *                       model turn (`{ tokens, window, percent }`, the last two
 *                       null together when the model has no known window).
 *                       Measured from the provider's token counts, not
 *                       self-reported. Same shape as a message's `context`, so
 *                       the client has one type for the live and stored value.
 *   event: turn       — the turn's identity and the server's clock
 *                       (`{ messageId, startedAt, now }`), so elapsed time is
 *                       measured on one clock whatever the browser's says.
 *   event: activity   — one recorded step as it happens: a tool call or its
 *                       result, a wait and why, a thinking summary, a stop
 *                       (`ChatActivityEvent` in `shared/chatActivity.ts`).
 *   event: heartbeat  — the server clock every few seconds, so a quiet turn
 *                       reads as quiet rather than as a dead connection.
 *   event: assistant  — persisted assistant message row (final reply text,
 *                       or an error/skipped body)
 *   event: conversation — updated conversation row (for sidebar refresh)
 *   event: done       — stream end marker; client closes the reader
 *
 * Errors from the agent seam are still serialized as a normal `assistant`
 * event with `status: "error"` so the client rendering stays uniform.
 */
employeeSurfaceRouter.post(
  "/:eid/conversations/:convId/messages",
  validateBody(sendSchema),
  async (req, res, next) => {
    const { cid, eid, convId } = req.params as Record<string, string>;
    const body = req.body as z.infer<typeof sendSchema>;
    let acceptedTurn = false;

    // Open the SSE channel early so errors below can also be reported to
    // the client via an `assistant` event instead of an HTTP error code the
    // fetch reader would struggle to surface.
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    const writeEvent = (event: string, data: unknown) => {
      if (res.writableEnded || res.destroyed) return;
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    // Keep the connection warm across long silent stretches of a turn — the
    // traffic resets the idle-read timers on any proxy between the browser and
    // this process, without which a slow reply drops mid-stream — and tell the
    // browser the server is still there, with its clock, so it can say "no
    // activity for 40s" about a quiet turn instead of "reconnecting".
    const heartbeat = setInterval(() => {
      writeEvent("heartbeat", { now: new Date().toISOString() });
    }, CHAT_STREAM_HEARTBEAT_MS);
    // Don't let the keepalive timer hold the process open on its own, and stop
    // firing the moment the client hangs up (nothing left to keep warm).
    heartbeat.unref?.();
    res.on("close", () => clearInterval(heartbeat));

    try {
      const loaded = await loadEmpAndCompany(cid, eid);
      if (!loaded) {
        writeEvent("error", { message: "Not found" });
        writeEvent("done", {});
        return res.end();
      }

      // Reject empty turns — the schema makes both fields optional so the
      // composer can decide which one is required, but a totally empty
      // submit shouldn't start an agent.
      if (!body.message.trim() && body.attachmentIds.length === 0) {
        writeEvent("error", { message: "Message or attachment required" });
        writeEvent("done", {});
        return res.end();
      }

      // Resolve the default at acceptance time and persist the concrete choice
      // with the durable turn. A later active-model switch must not change the
      // brain used by an already-queued or recovering message.
      const selectedModel = await resolveChatModel(eid, body.modelId);
      if (body.modelId && !selectedModel) {
        writeEvent("error", {
          message: "The selected AI Model does not belong to this AI Employee.",
        });
        writeEvent("done", {});
        return res.end();
      }
      // The conversation's thinking level, resolved against the model this
      // turn runs on: the nearest level it offers, within the company's
      // ceiling. Moved rather than refused, and never silently — the composer
      // showed the same result, and the reply records it.
      const requestedEffort = await conversationEffortForMessage({
        conversationId: convId,
        employeeId: eid,
        ownerUserId: req.userId!,
        effort: body.effort,
      });
      const { effort, thinking } = chatTurnThinking(selectedModel, requestedEffort);

      // User row, input attachments, durable assistant job and conversation
      // timestamp commit together. Once this returns, browser loss and process
      // loss are both recoverable.
      const enqueued = await enqueueDurableChatTurn({
        companyId: cid,
        employeeId: eid,
        conversationId: convId,
        message: body.message,
        attachmentIds: body.attachmentIds,
        modelId: selectedModel?.id ?? null,
        effort,
        thinking,
        requesterUserId: req.userId!,
        requesterSessionVersion: req.session!.sessionVersion!,
      });
      acceptedTurn = true;
      // The accepted turn is now this thread's newest one, so its model is
      // what the composer must reopen on. Resolved once here because
      // `onFinal` is synchronous and executing the turn never changes the
      // persisted choice.
      const threadChoice = await lastChatModelChoice(eid, enqueued.conversation.id);
      writeEvent("user", serializeMessage(enqueued.userMessage, enqueued.userAttachments));
      writeEvent("working", serializeMessage(enqueued.assistantMessage));
      writeEvent("turn", {
        messageId: enqueued.assistantMessage.id,
        status: enqueued.assistantMessage.status,
        startedAt: enqueued.assistantMessage.createdAt.toISOString(),
        attempt: enqueued.assistantMessage.turnAttempt,
        now: new Date().toISOString(),
      });
      writeEvent(
        "conversation",
        serializeConversation(enqueued.conversation, enqueued.conversation.updatedAt, threadChoice),
      );

      await executeDurableChatTurn(enqueued.assistantMessage.id, {
        onChunk: (chunk) => writeEvent("chunk", { text: chunk }),
        onActivity: (event) => writeEvent("activity", event),
        onProgress: (progress) => writeEvent("progress", progress),
        onContextUsage: (usage) =>
          writeEvent("context", {
            tokens: usage.promptTokens,
            window: usage.contextWindow,
            percent: usage.percent,
          }),
        onFinal: ({ message, attachments, conversation }) => {
          writeEvent("assistant", serializeMessage(message, attachments));
          writeEvent(
            "conversation",
            serializeConversation(conversation, conversation.updatedAt, threadChoice),
          );
        },
      });
      writeEvent("done", {});
      if (!res.writableEnded && !res.destroyed) res.end();
    } catch (e) {
      console.error(`[chat] turn failed company=${cid} employee=${eid} conversation=${convId}`, e);
      if (acceptedTurn) {
        // The durable row is the source of truth now. Ending without a final
        // assistant event makes the client follow that row; surfacing a local
        // transport error here would falsely claim accepted work was lost.
        writeEvent("done", {});
        if (!res.writableEnded && !res.destroyed) res.end();
        return;
      }
      // If the stream is still open, surface the error over SSE; otherwise
      // fall back to the normal Express error handler.
      if (!res.writableEnded && !res.destroyed) {
        writeEvent("error", {
          message: formatChatInfrastructureError(e, convId),
        });
        writeEvent("done", {});
        res.end();
      } else if (!res.destroyed) {
        next(e);
      }
    } finally {
      clearInterval(heartbeat);
    }
  },
);

const interruptSchema = z.object({}).strict();

/**
 * Stop the reply this thread is waiting on.
 *
 * The Member is telling the employee to put down what it is doing, usually
 * because the follow-up they already typed matters more than the answer in
 * flight. Whatever the employee had streamed so far is kept and the turn is
 * marked `interrupted`, so the composer's queue drains into a free employee
 * within the second instead of after however long the abandoned turn had left.
 *
 * Idempotent: a thread with nothing running answers `interrupted: false`
 * rather than an error, because two browsers on the same thread — or a
 * double-click — must not turn a completed turn into a failure.
 */
employeeSurfaceRouter.post(
  "/:eid/conversations/:convId/interrupt",
  validateBody(interruptSchema),
  async (req, res) => {
    const { cid, eid, convId } = req.params as Record<string, string>;
    const loaded = await loadEmpAndCompany(cid, eid);
    if (!loaded) return res.status(404).json({ error: "Not found" });
    const conv = await findAccessibleConversation({ req, employeeId: eid, conversationId: convId });
    if (!conv) return res.status(404).json({ error: "Not found" });
    const working = await AppDataSource.getRepository(ConversationMessage).find({
      where: { conversationId: conv.id, role: "assistant", status: "working" },
      order: { createdAt: "ASC" },
    });
    // A thread can hold more than one `working` row: a second turn accepted
    // from another tab sits there, unstarted and unclaimed, with the label
    // "Waiting for another reply" until the employee frees up. Stopping that
    // one would leave the reply the Member is actually watching running, so
    // prefer whichever row a worker has claimed.
    const target = working.find((message) => message.turnWorkerId !== null) ?? working[0];
    if (!target) return res.json({ interrupted: false });
    const outcome = await interruptDurableChatTurn(target.id);
    res.json({ interrupted: outcome === "interrupted" });
  },
);

// ---------- Turn activity ----------

const turnParamsSchema = z
  .object({
    cid: z.string().min(1),
    eid: z.string().min(1),
    convId: z.string().min(1),
    messageId: z.string().uuid(),
  })
  .strict();
const activityQuerySchema = z.object({
  /** The last ordinal the reader already holds; 0 reads from the start. */
  after: z.coerce.number().int().min(0).optional().default(0),
  limit: z.coerce.number().int().min(1).max(1_000).optional().default(500),
});
const activityStreamQuerySchema = z.object({
  after: z.coerce.number().int().min(0).optional().default(0),
});

/** The reply a turn belongs to, if the Member may read its conversation. */
async function findAccessibleTurn(req: Request) {
  const { cid, eid, convId, messageId } = req.params as Record<string, string>;
  const loaded = await loadEmpAndCompany(cid, eid);
  if (!loaded) return null;
  const conversation = await findAccessibleConversation({
    req,
    employeeId: eid,
    conversationId: convId,
  });
  if (!conversation) return null;
  const message = await AppDataSource.getRepository(ConversationMessage).findOneBy({
    id: messageId,
    conversationId: conversation.id,
    role: "assistant",
  });
  return message ? { loaded, conversation, message } : null;
}

/**
 * What an AI Employee did while it wrote one reply, step by step: each tool
 * call and its result, the AI Model's thinking summary, the reasons it
 * waited. Read when a Member opens a finished reply's "Worked for …" line;
 * `after` pages through a long turn. Readable by whoever can read the
 * conversation, and redacted when it was recorded.
 */
employeeSurfaceRouter.get(
  "/:eid/conversations/:convId/messages/:messageId/activity",
  validateParams(turnParamsSchema),
  validateQuery(activityQuerySchema),
  async (req, res, next) => {
    try {
      const found = await findAccessibleTurn(req);
      if (!found) return res.status(404).json({ error: "Not found" });
      const query = req.query as unknown as z.infer<typeof activityQuerySchema>;
      const events = await listChatActivity(found.message.id, query.after, query.limit + 1);
      res.json({
        events: events.slice(0, query.limit),
        more: events.length > query.limit,
        status: found.message.status,
      });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * Follow one reply live, from any browser, from the reader's cursor to its
 * end — how a reload, another tab or a dropped connection re-attaches to a
 * turn that is still running. Server-Sent Events; the stream is described on
 * `followChatTurn` (`services/chatTurnFollow.ts`). A finished turn replays
 * what the reader has not seen, sends the final reply, and ends.
 */
employeeSurfaceRouter.get(
  "/:eid/conversations/:convId/messages/:messageId/activity/stream",
  validateParams(turnParamsSchema),
  validateQuery(activityStreamQuerySchema),
  async (req, res, next) => {
    let found: Awaited<ReturnType<typeof findAccessibleTurn>>;
    try {
      found = await findAccessibleTurn(req);
    } catch (error) {
      return next(error);
    }
    if (!found) return res.status(404).json({ error: "Not found" });
    const query = req.query as unknown as z.infer<typeof activityStreamQuerySchema>;

    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();
    const writeEvent = (event: string, data: unknown) => {
      if (res.writableEnded || res.destroyed) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const stop = new AbortController();
    res.on("close", () => stop.abort());
    try {
      await followChatTurn({
        messageId: found.message.id,
        after: query.after,
        send: writeEvent,
        signal: stop.signal,
        loadFinal: async (message) => {
          const attachments = await attachmentsForMessages([message.id]);
          return serializeMessage(message, attachments.get(message.id) ?? []);
        },
      });
    } catch (error) {
      console.error(`[chat] following turn ${found.message.id} failed`, error);
      writeEvent("error", { message: "Lost track of this reply. It continues on the server." });
    } finally {
      if (!res.writableEnded && !res.destroyed) res.end();
    }
  },
);

const retrySchema = z.object({}).strict();

/**
 * Run a reply that failed again, in place: the same request, under the
 * Member who asks. Only the newest reply in a conversation with nothing
 * running can be retried. Answers the reply, now `working`; follow it with
 * `…/activity/stream`.
 */
employeeSurfaceRouter.post(
  "/:eid/conversations/:convId/messages/:messageId/retry",
  validateParams(turnParamsSchema),
  validateBody(retrySchema),
  async (req, res, next) => {
    const { cid, eid, convId, messageId } = req.params as Record<string, string>;
    try {
      const loaded = await loadEmpAndCompany(cid, eid);
      if (!loaded) return res.status(404).json({ error: "Not found" });
      const message = await retryDurableChatTurn({
        companyId: cid,
        employeeId: eid,
        conversationId: convId,
        messageId,
        requesterUserId: req.userId!,
        requesterSessionVersion: req.session!.sessionVersion!,
      });
      void executeDurableChatTurn(message.id).catch((error) => {
        console.error(`[chat] retried turn failed to start message=${message.id}`, error);
      });
      res.json({
        message: serializeMessage(message),
        startedAt: turnAcceptedAt(message).toISOString(),
      });
    } catch (error) {
      if (error instanceof ChatTurnRetryError) {
        return res.status(error.status).json({ error: error.message });
      }
      next(error);
    }
  },
);

// ---------- Journal ----------

/**
 * Paginated journal. Default 100, capped at 500, newest first. Routine runs
 * auto-emit entries via runner.ts; humans can also post free-form notes.
 */
employeeSurfaceRouter.get("/:eid/journal", async (req, res) => {
  const { cid, eid } = req.params as Record<string, string>;
  const loaded = await loadEmpAndCompany(cid, eid);
  if (!loaded) return res.status(404).json({ error: "Not found" });
  const take = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
  const entries = await AppDataSource.getRepository(JournalEntry).find({
    where: { employeeId: loaded.emp.id },
    order: { createdAt: "DESC" },
    take,
  });
  res.json(entries);
});

const journalNoteSchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().max(10_000).default(""),
});

employeeSurfaceRouter.post("/:eid/journal", validateBody(journalNoteSchema), async (req, res) => {
  const { cid, eid } = req.params as Record<string, string>;
  const loaded = await loadEmpAndCompany(cid, eid);
  if (!loaded) return res.status(404).json({ error: "Not found" });
  const body = req.body as z.infer<typeof journalNoteSchema>;
  // `req.userId` is set for a session and an API key alike; the cookie's own
  // field left a note written through the API without an author.
  const userId = req.userId ?? null;
  const repo = AppDataSource.getRepository(JournalEntry);
  const entry = repo.create({
    employeeId: loaded.emp.id,
    kind: "note",
    title: body.title,
    body: body.body,
    runId: null,
    routineId: null,
    authorUserId: userId,
  });
  await repo.save(entry);
  res.json(entry);
});

const journalPatchSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    body: z.string().max(10_000).optional(),
  })
  .refine((v) => v.title !== undefined || v.body !== undefined, {
    message: "Provide title or body",
  });

employeeSurfaceRouter.patch(
  "/:eid/journal/:entryId",
  validateBody(journalPatchSchema),
  async (req, res) => {
    const { cid, eid, entryId } = req.params as Record<string, string>;
    const loaded = await loadEmpAndCompany(cid, eid);
    if (!loaded) return res.status(404).json({ error: "Not found" });
    const repo = AppDataSource.getRepository(JournalEntry);
    const entry = await repo.findOneBy({ id: entryId, employeeId: loaded.emp.id });
    if (!entry) return res.status(404).json({ error: "Not found" });
    const body = req.body as z.infer<typeof journalPatchSchema>;
    if (body.title !== undefined) entry.title = body.title;
    if (body.body !== undefined) entry.body = body.body;
    await repo.save(entry);
    res.json(entry);
  },
);

employeeSurfaceRouter.delete("/:eid/journal/:entryId", async (req, res) => {
  const { cid, eid, entryId } = req.params as Record<string, string>;
  const loaded = await loadEmpAndCompany(cid, eid);
  if (!loaded) return res.status(404).json({ error: "Not found" });
  const repo = AppDataSource.getRepository(JournalEntry);
  const entry = await repo.findOneBy({ id: entryId, employeeId: loaded.emp.id });
  if (!entry) return res.status(404).json({ error: "Not found" });
  await repo.delete({ id: entry.id });
  res.json({ ok: true });
});

// ---------- Memory ----------

/**
 * Per-employee memory items. Each is a short durable "fact" the employee
 * should recall in every chat / routine run. Humans curate via the UI; the
 * AI can also add/update/remove via MCP so it can take notes on itself.
 */
employeeSurfaceRouter.get("/:eid/memory", async (req, res) => {
  const { cid, eid } = req.params as Record<string, string>;
  const loaded = await loadEmpAndCompany(cid, eid);
  if (!loaded) return res.status(404).json({ error: "Not found" });
  const items = await AppDataSource.getRepository(EmployeeMemory).find({
    where: { employeeId: loaded.emp.id },
    order: { createdAt: "ASC" },
  });
  res.json(items);
});

const memoryCreateSchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().max(4000).default(""),
});

employeeSurfaceRouter.post("/:eid/memory", validateBody(memoryCreateSchema), async (req, res) => {
  const { cid, eid } = req.params as Record<string, string>;
  const loaded = await loadEmpAndCompany(cid, eid);
  if (!loaded) return res.status(404).json({ error: "Not found" });
  const body = req.body as z.infer<typeof memoryCreateSchema>;
  const repo = AppDataSource.getRepository(EmployeeMemory);
  const row = repo.create({
    employeeId: loaded.emp.id,
    title: body.title,
    body: body.body,
    authorUserId: req.session?.userId ?? null,
  });
  await repo.save(row);
  res.json(row);
});

const memoryPatchSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    body: z.string().max(4000).optional(),
  })
  .refine((v) => v.title !== undefined || v.body !== undefined, {
    message: "Provide title or body",
  });

employeeSurfaceRouter.patch(
  "/:eid/memory/:itemId",
  validateBody(memoryPatchSchema),
  async (req, res) => {
    const { cid, eid, itemId } = req.params as Record<string, string>;
    const loaded = await loadEmpAndCompany(cid, eid);
    if (!loaded) return res.status(404).json({ error: "Not found" });
    const repo = AppDataSource.getRepository(EmployeeMemory);
    const row = await repo.findOneBy({ id: itemId, employeeId: loaded.emp.id });
    if (!row) return res.status(404).json({ error: "Not found" });
    const body = req.body as z.infer<typeof memoryPatchSchema>;
    if (body.title !== undefined) row.title = body.title;
    if (body.body !== undefined) row.body = body.body;
    await repo.save(row);
    res.json(row);
  },
);

employeeSurfaceRouter.delete("/:eid/memory/:itemId", async (req, res) => {
  const { cid, eid, itemId } = req.params as Record<string, string>;
  const loaded = await loadEmpAndCompany(cid, eid);
  if (!loaded) return res.status(404).json({ error: "Not found" });
  const repo = AppDataSource.getRepository(EmployeeMemory);
  const row = await repo.findOneBy({ id: itemId, employeeId: loaded.emp.id });
  if (!row) return res.status(404).json({ error: "Not found" });
  await repo.delete({ id: row.id });
  res.json({ ok: true });
});

// Also cascade-delete conversations when an employee is deleted. The employee
// delete path lives in employees.ts; we expose a helper here so that file can
// call into our storage without importing entities directly.
export async function deleteEmployeeConversations(employeeId: string): Promise<void> {
  await AppDataSource.getRepository(ParallelWorkerResult).delete({ employeeId });
  const convRepo = AppDataSource.getRepository(Conversation);
  const convs = await convRepo.find({ where: { employeeId } });
  if (convs.length === 0) return;
  const ids = convs.map((c) => c.id);
  await AppDataSource.getRepository(ConversationActivityEvent)
    .createQueryBuilder()
    .delete()
    .where("conversationId IN (:...ids)", { ids })
    .execute();
  await AppDataSource.getRepository(ConversationMessage)
    .createQueryBuilder()
    .delete()
    .where("conversationId IN (:...ids)", { ids })
    .execute();
  await convRepo.delete({ employeeId });
}
