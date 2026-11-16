import { Router, type Request } from "express";
import { z } from "zod";
import { AppDataSource } from "../db/datasource.js";
import { AskAiMessage } from "../db/entities/AskAiMessage.js";
import { Company } from "../db/entities/Company.js";
import { requireAuth, requireBrowserSession, requireCompanyMember } from "../middleware/auth.js";
import { effectiveFinanceAccess } from "../middleware/financeAccess.js";
import { validateBody, validateParams, validateQuery } from "../middleware/validate.js";
import {
  ASK_AI_CONTEXT_KINDS,
  MAX_ASK_AI_CONTEXT_ID_LENGTH,
  MAX_ASK_AI_CONTEXT_REFS,
} from "../../shared/askAi.js";
import {
  followAskAiAnswer,
  listAskAiAnswerActivity,
  stopAskAiAnswer,
} from "../services/askAi/answerActivity.js";
import {
  askAiMessageAttachments,
  askAiRoster,
  askAiTurnInFlight,
  createAskAiConversation,
  deleteAskAiConversation,
  getAskAiAnswer,
  getAskAiConversation,
  lastAskAiModelId,
  listAskAiConversations,
  listAskAiMessages,
  markAskAiSuggestionExecuted,
  MAX_ASK_AI_TARGETS,
  previewAskAiContext,
  runAskAiTurn,
  serializeAskAiConversation,
  serializeAskAiMessage,
} from "../services/askAi/assistant.js";
import type { AskAiMember } from "../services/askAi/context.js";
import { recordAttachment, resolveAttachmentFile, uploadMiddleware } from "../services/uploads.js";

/**
 * Ask AI — the chat window in the top nav. Every route here is the Member's
 * own: conversations are private to whoever started them, and each turn runs
 * with that Member's authority, so anything an employee does from here is
 * still intersected with what the Member may do.
 *
 * Any Member can use it. What an employee is *shown* is decided per record in
 * `services/askAi/context.ts`, by the Member's access and the employee's
 * Grants together.
 */
export const askAiRouter = Router({ mergeParams: true });
askAiRouter.use(requireAuth);
askAiRouter.use(requireCompanyMember);

function memberOf(req: Request): AskAiMember {
  return {
    userId: req.userId!,
    role: req.companyRole!,
    financeAccess: effectiveFinanceAccess(req),
  };
}

async function loadCompany(cid: string): Promise<Company | null> {
  return AppDataSource.getRepository(Company).findOneBy({ id: cid });
}

const refSchema = z
  .object({
    kind: z.enum(ASK_AI_CONTEXT_KINDS),
    id: z.string().trim().min(1).max(MAX_ASK_AI_CONTEXT_ID_LENGTH),
    focusId: z.string().trim().min(1).max(MAX_ASK_AI_CONTEXT_ID_LENGTH).optional(),
  })
  .strict();
const refsSchema = z.array(refSchema).max(MAX_ASK_AI_CONTEXT_REFS).default([]);
const excludeSchema = z
  .array(z.string().max(MAX_ASK_AI_CONTEXT_ID_LENGTH + 40))
  .max(20)
  .default([]);
const pageSchema = z
  .object({
    path: z
      .string()
      .max(500)
      .refine((value) => value.startsWith("/"), "Path must start with /"),
    label: z.string().trim().max(120).nullable().optional().default(null),
  })
  .strict();

const conversationParamsSchema = z
  .object({ cid: z.string().min(1), conversationId: z.string().uuid() })
  .strict();
const attachmentParamsSchema = z
  .object({
    cid: z.string().min(1),
    conversationId: z.string().uuid(),
    attachmentId: z.string().uuid(),
  })
  .strict();
const suggestionParamsSchema = z
  .object({
    cid: z.string().min(1),
    conversationId: z.string().uuid(),
    messageId: z.string().uuid(),
    suggestionId: z.string().min(1).max(100),
  })
  .strict();
const messagesQuerySchema = z
  .object({ limit: z.coerce.number().int().min(1).max(200).default(100) })
  .strict();
const emptyQuerySchema = z.object({}).strict();

/** The conversation list and everyone who can be addressed. */
askAiRouter.get("/ask-ai", validateQuery(emptyQuerySchema), async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const [conversations, roster] = await Promise.all([
    listAskAiConversations(cid, req.userId!),
    askAiRoster(cid),
  ]);
  res.json({ conversations: conversations.map(serializeAskAiConversation), roster });
});

askAiRouter.post(
  "/ask-ai/conversations",
  validateBody(z.object({}).strict()),
  async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const conversation = await createAskAiConversation(cid, req.userId!);
    res.status(201).json({ conversation: serializeAskAiConversation(conversation) });
  },
);

/** One conversation's transcript, roster, and the brain it has been running on. */
askAiRouter.get(
  "/ask-ai/conversations/:conversationId",
  validateParams(conversationParamsSchema),
  validateQuery(messagesQuerySchema),
  async (req, res) => {
    const { cid, conversationId } = req.params as Record<string, string>;
    const conversation = await getAskAiConversation(cid, req.userId!, conversationId);
    if (!conversation) return res.status(404).json({ error: "Conversation not found" });
    const limit = Number((req.query as Record<string, unknown>).limit ?? 100);
    const [messages, roster] = await Promise.all([
      listAskAiMessages(conversation.id, limit),
      askAiRoster(cid),
    ]);
    const attachments = await askAiMessageAttachments(messages);
    const lastAnswered = [...messages]
      .reverse()
      .find((m) => m.role === "assistant" && m.employeeId);
    const modelId = lastAnswered?.employeeId
      ? await lastAskAiModelId(conversation.id, lastAnswered.employeeId)
      : null;
    res.json({
      conversation: serializeAskAiConversation(conversation),
      messages: messages.map((m) => serializeAskAiMessage(m, attachments.get(m.id) ?? [])),
      roster,
      modelId,
    });
  },
);

askAiRouter.delete(
  "/ask-ai/conversations/:conversationId",
  validateParams(conversationParamsSchema),
  async (req, res) => {
    const { cid, conversationId } = req.params as Record<string, string>;
    const conversation = await getAskAiConversation(cid, req.userId!, conversationId);
    if (!conversation) return res.status(404).json({ error: "Conversation not found" });
    if (await askAiTurnInFlight(conversation.id)) {
      return res
        .status(409)
        .json({ error: "Wait for the current reply to finish before deleting this conversation." });
    }
    await deleteAskAiConversation(conversation);
    res.json({ ok: true });
  },
);

const previewSchema = z
  .object({ refs: refsSchema, exclude: excludeSchema })
  .strict();

/** What the next message would carry, and who could not be shown which record. */
askAiRouter.post("/ask-ai/context", validateBody(previewSchema), async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const company = await loadCompany(cid);
  if (!company) return res.status(404).json({ error: "Company not found" });
  const body = req.body as z.infer<typeof previewSchema>;
  const preview = await previewAskAiContext({
    companyId: cid,
    companySlug: company.slug,
    member: memberOf(req),
    refs: body.refs,
    exclude: body.exclude,
  });
  res.json(preview);
});

/** Upload a file for the Member's next message; it binds to that turn on send. */
askAiRouter.post(
  "/ask-ai/attachments",
  async (req, res, next) => {
    const cid = (req.params as Record<string, string>).cid;
    const company = await loadCompany(cid);
    if (!company) return res.status(404).json({ error: "Company not found" });
    (req as unknown as { company: Company }).company = company;
    next();
  },
  uploadMiddleware.single("file"),
  async (req, res) => {
    const company = (req as unknown as { company: Company }).company;
    const file = (req as unknown as { file?: Express.Multer.File }).file;
    if (!file) return res.status(400).json({ error: "No file uploaded" });
    const row = await recordAttachment({
      companyId: company.id,
      companySlug: company.slug,
      file,
      uploadedByUserId: req.userId!,
    });
    res.status(201).json({
      attachment: {
        id: row.id,
        filename: row.filename,
        mimeType: row.mimeType,
        sizeBytes: Number(row.sizeBytes),
        isImage: row.mimeType.startsWith("image/"),
      },
    });
  },
);

/**
 * Download a file from a conversation: one bound to a turn of THIS
 * conversation, or the requester's own not-yet-sent upload. An attachment id
 * from anywhere else in the company is not readable through here.
 */
askAiRouter.get(
  "/ask-ai/conversations/:conversationId/attachments/:attachmentId",
  validateParams(attachmentParamsSchema),
  async (req, res) => {
    const { cid, conversationId, attachmentId } = req.params as Record<string, string>;
    const missing = { error: "Attachment not found" };
    const conversation = await getAskAiConversation(cid, req.userId!, conversationId);
    if (!conversation) return res.status(404).json(missing);
    const resolved = await resolveAttachmentFile(attachmentId, cid);
    if (!resolved) return res.status(404).json(missing);
    if (resolved.row.messageId) {
      const owner = await AppDataSource.getRepository(AskAiMessage).findOneBy({
        id: resolved.row.messageId,
        conversationId: conversation.id,
        companyId: cid,
      });
      if (!owner) return res.status(404).json(missing);
    } else if (resolved.row.uploadedByUserId !== req.userId) {
      return res.status(404).json(missing);
    }
    res.setHeader("content-type", resolved.row.mimeType);
    res.setHeader("x-content-type-options", "nosniff");
    const disposition = resolved.row.mimeType.startsWith("image/") ? "inline" : "attachment";
    res.setHeader(
      "content-disposition",
      `${disposition}; filename="${encodeURIComponent(resolved.row.filename)}"`,
    );
    res.sendFile(resolved.absPath);
  },
);

/** Same keepalive cadence as employee chat — see `routes/employeeSurface.ts`. */
const ASK_AI_STREAM_HEARTBEAT_MS = 15_000;

const sendSchema = z
  .object({
    message: z.string().max(8000).default(""),
    employeeIds: z.array(z.string().uuid()).max(MAX_ASK_AI_TARGETS).optional().default([]),
    attachmentIds: z.array(z.string().uuid()).max(10).optional().default([]),
    modelId: z.string().uuid().nullable().optional().default(null),
    page: pageSchema,
    refs: refsSchema,
    exclude: excludeSchema,
  })
  .strict()
  .refine((body) => body.message.trim().length > 0 || body.attachmentIds.length > 0, {
    message: "Message or attachment required",
    path: ["message"],
  });

/**
 * One human turn, streamed over SSE: `user` → the persisted turn, `targets` →
 * who will answer, then per employee `queued` / `working` → `chunk`* →
 * `assistant`, and finally `done`. Errors arrive as events too. The turn does
 * not depend on this connection: once `working` is written, a client that
 * loses the stream re-reads the conversation and follows the same rows.
 */
askAiRouter.post(
  "/ask-ai/conversations/:conversationId/messages",
  requireBrowserSession,
  validateParams(conversationParamsSchema),
  validateBody(sendSchema),
  async (req, res, next) => {
    const { cid, conversationId } = req.params as Record<string, string>;
    const body = req.body as z.infer<typeof sendSchema>;
    const conversation = await getAskAiConversation(cid, req.userId!, conversationId);
    if (!conversation) return res.status(404).json({ error: "Conversation not found" });
    const company = await loadCompany(cid);
    if (!company) return res.status(404).json({ error: "Company not found" });

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
    const heartbeat = setInterval(() => {
      if (!res.writableEnded && !res.destroyed) res.write(`: keepalive\n\n`);
    }, ASK_AI_STREAM_HEARTBEAT_MS);
    heartbeat.unref?.();
    res.on("close", () => clearInterval(heartbeat));

    try {
      await runAskAiTurn({
        companyId: cid,
        companySlug: company.slug,
        conversation,
        member: memberOf(req),
        requesterSessionVersion: req.session!.sessionVersion!,
        message: body.message,
        page: { path: body.page.path, label: body.page.label ?? null },
        refs: body.refs,
        exclude: body.exclude,
        employeeIds: body.employeeIds,
        attachmentIds: body.attachmentIds,
        modelId: body.modelId,
        callbacks: {
          onUser: (msg) => writeEvent("user", msg),
          onTargets: (employees) => writeEvent("targets", { employees }),
          onQueued: (msg) => writeEvent("queued", msg),
          onWorking: (msg) => writeEvent("working", msg),
          onChunk: (text) => writeEvent("chunk", { text }),
          onAssistant: (msg) => writeEvent("assistant", msg),
        },
      });
      writeEvent("done", {});
      if (!res.writableEnded && !res.destroyed) res.end();
    } catch (e) {
      if (!res.writableEnded && !res.destroyed) {
        writeEvent("error", { message: e instanceof Error ? e.message : String(e) });
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

// ───────────────────────────── an answer's work ─────────────────────────────

const answerParamsSchema = z
  .object({
    cid: z.string().min(1),
    conversationId: z.string().uuid(),
    messageId: z.string().uuid(),
  })
  .strict();
const activityQuerySchema = z
  .object({
    /** The last ordinal the reader already holds; 0 reads from the start. */
    after: z.coerce.number().int().min(0).optional().default(0),
    limit: z.coerce.number().int().min(1).max(1_000).optional().default(500),
  })
  .strict();
const activityStreamQuerySchema = z
  .object({ after: z.coerce.number().int().min(0).optional().default(0) })
  .strict();

/** An answer in one of the Member's own conversations; anyone else's is not found. */
async function findOwnedAnswer(req: Request) {
  const { cid, conversationId, messageId } = req.params as Record<string, string>;
  const conversation = await getAskAiConversation(cid, req.userId!, conversationId);
  if (!conversation) return null;
  const answer = await getAskAiAnswer(conversation.id, messageId);
  return answer ? { conversation, answer } : null;
}

/**
 * What an AI Employee did while it wrote one answer, step by step: each tool
 * call and its result, the AI Model's thinking summary, the reasons it waited.
 * Read when the Member opens a finished answer's "Worked for …" line; `after`
 * pages through a long one. Redacted when it was recorded.
 */
askAiRouter.get(
  "/ask-ai/conversations/:conversationId/messages/:messageId/activity",
  requireBrowserSession,
  validateParams(answerParamsSchema),
  validateQuery(activityQuerySchema),
  async (req, res, next) => {
    try {
      const found = await findOwnedAnswer(req);
      if (!found) return res.status(404).json({ error: "Answer not found" });
      const query = req.query as unknown as z.infer<typeof activityQuerySchema>;
      res.json(await listAskAiAnswerActivity(found.answer, query.after, query.limit));
    } catch (error) {
      next(error);
    }
  },
);

/**
 * Follow one answer live, from the reader's cursor to its end — its steps, its
 * text as it is written, and what the AI Model is doing this moment. How the
 * panel watches an answer, and how a reload, another tab or a dropped
 * connection picks it up again. Server-Sent Events, as `followChatTurn`
 * (`services/chatTurnFollow.ts`) describes them; a finished answer replays
 * what the reader has not seen, sends the answer as `assistant`, and ends.
 */
askAiRouter.get(
  "/ask-ai/conversations/:conversationId/messages/:messageId/activity/stream",
  requireBrowserSession,
  validateParams(answerParamsSchema),
  validateQuery(activityStreamQuerySchema),
  async (req, res, next) => {
    let found: Awaited<ReturnType<typeof findOwnedAnswer>>;
    try {
      found = await findOwnedAnswer(req);
    } catch (error) {
      return next(error);
    }
    if (!found) return res.status(404).json({ error: "Answer not found" });
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
      await followAskAiAnswer({
        messageId: found.answer.id,
        after: query.after,
        send: writeEvent,
        signal: stop.signal,
        loadFinal: async (row) => {
          const attachments = await askAiMessageAttachments([row]);
          return serializeAskAiMessage(row, attachments.get(row.id) ?? []);
        },
      });
    } catch (error) {
      console.error(`[ask-ai] following answer ${found.answer.id} failed`, error);
      writeEvent("error", { message: "Lost track of this answer. It continues on the server." });
    } finally {
      if (!res.writableEnded && !res.destroyed) res.end();
    }
  },
);

/**
 * Stop an answer the Member is waiting on. What it wrote so far is kept, and
 * so is whatever it already did. One still waiting behind another AI Employee
 * never starts. `stopped` is false when it had already finished.
 */
askAiRouter.post(
  "/ask-ai/conversations/:conversationId/messages/:messageId/stop",
  requireBrowserSession,
  validateParams(answerParamsSchema),
  validateBody(z.object({}).strict()),
  async (req, res, next) => {
    try {
      const found = await findOwnedAnswer(req);
      if (!found) return res.status(404).json({ error: "Answer not found" });
      const outcome = await stopAskAiAnswer(found.answer);
      const row = (await getAskAiAnswer(found.conversation.id, found.answer.id)) ?? found.answer;
      res.json({ stopped: outcome === "stopped", message: serializeAskAiMessage(row) });
    } catch (error) {
      next(error);
    }
  },
);

/** Stamp a suggestion button as run (idempotence guard after a reload). */
askAiRouter.post(
  "/ask-ai/conversations/:conversationId/messages/:messageId/suggestions/:suggestionId/executed",
  validateParams(suggestionParamsSchema),
  async (req, res) => {
    const { cid, conversationId, messageId, suggestionId } = req.params as Record<string, string>;
    const conversation = await getAskAiConversation(cid, req.userId!, conversationId);
    if (!conversation) return res.status(404).json({ error: "Suggestion not found" });
    const row = await markAskAiSuggestionExecuted(conversation, messageId, suggestionId);
    if (!row) return res.status(404).json({ error: "Suggestion not found" });
    res.json({ message: serializeAskAiMessage(row) });
  },
);
