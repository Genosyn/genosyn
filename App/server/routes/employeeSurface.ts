import { Router } from "express";
import { z } from "zod";
import { IsNull, Not } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { Conversation } from "../db/entities/Conversation.js";
import { ConversationMessage } from "../db/entities/ConversationMessage.js";
import { Attachment } from "../db/entities/Attachment.js";
import { JournalEntry } from "../db/entities/JournalEntry.js";
import { EmployeeMemory } from "../db/entities/EmployeeMemory.js";
import { requireAuth, requireCompanyMember } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { streamChatWithEmployee } from "../services/chat.js";
import { captureTurnActions, parseActions } from "../services/turnActions.js";
import {
  attachmentsForMessages,
  bindAttachmentsToMessage,
  recordAttachment,
  resolveAttachmentFile,
  uploadMiddleware,
} from "../services/uploads.js";
import {
  historicalAttachmentSummaries,
  inlineAttachmentsForMessage,
} from "../services/attachmentText.js";

/**
 * Chat + per-employee surface endpoints. Split from `employees.ts` to keep
 * the employee CRUD file focused — these reach into the runner seam (chat
 * streaming) and the journal/memory tables.
 */
export const employeeSurfaceRouter = Router({ mergeParams: true });
employeeSurfaceRouter.use(requireAuth);
employeeSurfaceRouter.use(requireCompanyMember);

// Hydrate `req.company` from the URL `cid` so the multer destination
// callback (which runs before any handler) can compute the per-company
// attachments dir. Same shape as the workspace router.
employeeSurfaceRouter.use(async (req, res, next) => {
  const cid = (req.params as Record<string, string>).cid;
  if (!cid) return next();
  const co = await AppDataSource.getRepository(Company).findOneBy({ id: cid });
  if (!co) return res.status(404).json({ error: "Company not found" });
  (req as unknown as { company: Company }).company = co;
  next();
});

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
 * Up to this many prior turns are replayed to the CLI when the human sends a
 * new message. Same cap as the old browser-local chat; keeps the prompt
 * bounded regardless of how long the thread gets.
 */
const MAX_REPLAY_TURNS = 20;

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
const CHAT_STREAM_HEARTBEAT_MS = 15_000;

/** Derive a display title from the first user message. */
function deriveTitle(message: string): string {
  const firstLine = message.split("\n")[0].trim();
  if (firstLine.length <= 60) return firstLine;
  return firstLine.slice(0, 57).trimEnd() + "…";
}

function serializeConversation(c: Conversation, lastMessageAt: Date | null = null) {
  return {
    id: c.id,
    employeeId: c.employeeId,
    title: c.title,
    archivedAt: c.archivedAt,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    lastMessageAt,
    source: c.source ?? "web",
    connectionId: c.connectionId ?? null,
  };
}

type AttachmentSummary = {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  isImage: boolean;
};

function summarizeAttachment(a: Attachment): AttachmentSummary {
  return {
    id: a.id,
    filename: a.filename,
    mimeType: a.mimeType,
    sizeBytes: Number(a.sizeBytes),
    isImage: a.mimeType.startsWith("image/"),
  };
}

function serializeMessage(
  m: ConversationMessage,
  attachments: Attachment[] = [],
) {
  return {
    id: m.id,
    conversationId: m.conversationId,
    role: m.role,
    content: m.content,
    status: m.status,
    actions: parseActions(m.actionsJson),
    attachments: attachments.map(summarizeAttachment),
    createdAt: m.createdAt,
  };
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

employeeSurfaceRouter.get("/:eid/conversations", async (req, res) => {
  const { cid, eid } = req.params as Record<string, string>;
  const loaded = await loadEmpAndCompany(cid, eid);
  if (!loaded) return res.status(404).json({ error: "Not found" });
  // `?archived=1` returns only archived threads, default returns only
  // active ones. The sidebar flips between the two via a disclosure.
  const wantsArchived = req.query.archived === "1";
  const rows = await AppDataSource.getRepository(Conversation).find({
    where: {
      employeeId: eid,
      archivedAt: wantsArchived ? Not(IsNull()) : IsNull(),
    },
    order: { updatedAt: "DESC" },
  });
  res.json(rows.map((r) => serializeConversation(r, r.updatedAt)));
});

employeeSurfaceRouter.post("/:eid/conversations", async (req, res) => {
  const { cid, eid } = req.params as Record<string, string>;
  const loaded = await loadEmpAndCompany(cid, eid);
  if (!loaded) return res.status(404).json({ error: "Not found" });
  const repo = AppDataSource.getRepository(Conversation);
  const conv = repo.create({ employeeId: eid, title: null });
  await repo.save(conv);
  res.json(serializeConversation(conv));
});

employeeSurfaceRouter.get("/:eid/conversations/:convId", async (req, res) => {
  const { cid, eid, convId } = req.params as Record<string, string>;
  const loaded = await loadEmpAndCompany(cid, eid);
  if (!loaded) return res.status(404).json({ error: "Not found" });
  const conv = await AppDataSource.getRepository(Conversation).findOneBy({
    id: convId,
    employeeId: eid,
  });
  if (!conv) return res.status(404).json({ error: "Not found" });
  const messages = await AppDataSource.getRepository(ConversationMessage).find({
    where: { conversationId: conv.id },
    order: { createdAt: "ASC" },
  });
  const attachmentsByMsg = await attachmentsForMessages(messages.map((m) => m.id));
  res.json({
    conversation: serializeConversation(conv, conv.updatedAt),
    messages: messages.map((m) =>
      serializeMessage(m, attachmentsByMsg.get(m.id) ?? []),
    ),
  });
});

employeeSurfaceRouter.post(
  "/:eid/conversations/:convId/archive",
  async (req, res) => {
    const { cid, eid, convId } = req.params as Record<string, string>;
    const loaded = await loadEmpAndCompany(cid, eid);
    if (!loaded) return res.status(404).json({ error: "Not found" });
    const repo = AppDataSource.getRepository(Conversation);
    const conv = await repo.findOneBy({ id: convId, employeeId: eid });
    if (!conv) return res.status(404).json({ error: "Not found" });
    if (!conv.archivedAt) {
      conv.archivedAt = new Date();
      await repo.save(conv);
    }
    res.json(serializeConversation(conv, conv.updatedAt));
  },
);

employeeSurfaceRouter.post(
  "/:eid/conversations/:convId/unarchive",
  async (req, res) => {
    const { cid, eid, convId } = req.params as Record<string, string>;
    const loaded = await loadEmpAndCompany(cid, eid);
    if (!loaded) return res.status(404).json({ error: "Not found" });
    const repo = AppDataSource.getRepository(Conversation);
    const conv = await repo.findOneBy({ id: convId, employeeId: eid });
    if (!conv) return res.status(404).json({ error: "Not found" });
    if (conv.archivedAt) {
      conv.archivedAt = null;
      await repo.save(conv);
    }
    res.json(serializeConversation(conv, conv.updatedAt));
  },
);

employeeSurfaceRouter.delete("/:eid/conversations/:convId", async (req, res) => {
  const { cid, eid, convId } = req.params as Record<string, string>;
  const loaded = await loadEmpAndCompany(cid, eid);
  if (!loaded) return res.status(404).json({ error: "Not found" });
  const convRepo = AppDataSource.getRepository(Conversation);
  const conv = await convRepo.findOneBy({ id: convId, employeeId: eid });
  if (!conv) return res.status(404).json({ error: "Not found" });
  await AppDataSource.getRepository(ConversationMessage).delete({
    conversationId: conv.id,
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

employeeSurfaceRouter.get(
  "/:eid/chat-attachments/:attachmentId",
  async (req, res) => {
    const { cid, eid, attachmentId } = req.params as Record<string, string>;
    const loaded = await loadEmpAndCompany(cid, eid);
    if (!loaded) return res.status(404).json({ error: "Not found" });
    const resolved = await resolveAttachmentFile(attachmentId, loaded.co.id);
    if (!resolved) {
      return res.status(404).json({ error: "Attachment not found" });
    }
    res.setHeader("Content-Type", resolved.row.mimeType);
    const inline = resolved.row.mimeType.startsWith("image/");
    const disposition = inline ? "inline" : "attachment";
    res.setHeader(
      "Content-Disposition",
      `${disposition}; filename="${encodeURIComponent(resolved.row.filename)}"`,
    );
    res.sendFile(resolved.absPath);
  },
);

const sendSchema = z.object({
  message: z.string().max(8000).default(""),
  attachmentIds: z.array(z.string().uuid()).max(20).optional().default([]),
});

/**
 * Streamed send. Responds with Server-Sent Events so the browser can paint
 * the reply token-by-token as it arrives from the CLI instead of blocking
 * on a single JSON response for 5-10s per message.
 *
 * Event shape:
 *   event: user       — persisted user message row (first, so the client can
 *                       swap its optimistic bubble)
 *   event: chunk      — raw stdout delta from the CLI (`{ text: "..." }`)
 *   event: assistant  — persisted assistant message row (final reply text,
 *                       or an error/skipped body)
 *   event: conversation — updated conversation row (for sidebar refresh)
 *   event: done       — stream end marker; client closes the reader
 *
 * Errors from the CLI seam are still serialized as a normal `assistant`
 * event with `status: "error"` so the client rendering stays uniform.
 */
employeeSurfaceRouter.post(
  "/:eid/conversations/:convId/messages",
  validateBody(sendSchema),
  async (req, res, next) => {
    const { cid, eid, convId } = req.params as Record<string, string>;
    const body = req.body as z.infer<typeof sendSchema>;

    // Open the SSE channel early so errors below can also be reported to
    // the client via an `assistant` event instead of an HTTP error code the
    // fetch reader would struggle to surface.
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    const writeEvent = (event: string, data: unknown) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    // Keep the connection warm across long silent stretches of a turn. SSE
    // comment lines (`:`-prefixed) are ignored by the client parser but count
    // as traffic, so they reset the idle-read timers on any proxy between the
    // browser and this process — without them a slow reply drops mid-stream.
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(`: keepalive\n\n`);
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

      const convRepo = AppDataSource.getRepository(Conversation);
      const msgRepo = AppDataSource.getRepository(ConversationMessage);

      const conv = await convRepo.findOneBy({ id: convId, employeeId: eid });
      if (!conv) {
        writeEvent("error", { message: "Conversation not found" });
        writeEvent("done", {});
        return res.end();
      }

      // Reject empty turns — the schema makes both fields optional so the
      // composer can decide which one is required, but a totally empty
      // submit shouldn't spawn a CLI.
      if (!body.message.trim() && body.attachmentIds.length === 0) {
        writeEvent("error", { message: "Message or attachment required" });
        writeEvent("done", {});
        return res.end();
      }

      // Persist the user turn first so it survives a CLI crash / timeout.
      const userMsg = await msgRepo.save(
        msgRepo.create({
          conversationId: conv.id,
          role: "user",
          content: body.message,
          status: null,
        }),
      );

      const boundAttachments = body.attachmentIds.length
        ? await bindAttachmentsToMessage(body.attachmentIds, userMsg.id, cid)
        : [];

      // Title comes from the typed text when present; falls back to the
      // first attachment's filename for upload-only turns.
      if (!conv.title) {
        const seed = body.message.trim() || boundAttachments[0]?.filename || "";
        if (seed) conv.title = deriveTitle(seed);
      }
      conv.updatedAt = new Date();
      await convRepo.save(conv);

      writeEvent("user", serializeMessage(userMsg, boundAttachments));

      // Replay the tail of the thread (excluding the just-saved user msg)
      // to the CLI so it has recent context. History gets a brief
      // "(attached: foo.pdf)" annotation per turn so the employee can tell
      // when an earlier message shipped files; the trigger message gets
      // the full extracted text inlined below.
      const prior = await msgRepo.find({
        where: { conversationId: conv.id },
        order: { createdAt: "ASC" },
      });
      const priorIds = prior
        .filter((m) => m.id !== userMsg.id)
        .map((m) => m.id);
      const priorAttachmentNotes = await historicalAttachmentSummaries(priorIds);
      const replay = prior
        .filter((m) => m.id !== userMsg.id)
        .slice(-MAX_REPLAY_TURNS)
        .map((m) => {
          const note = priorAttachmentNotes.get(m.id);
          return {
            role: m.role,
            content: note ? `${m.content}\n[attached: ${note}]` : m.content,
          };
        });

      // Inline the just-uploaded attachments (full extracted text, capped)
      // into the user-facing prompt so the AI can read PDFs / docs the
      // teammate just dropped into the composer.
      const attachmentBlock = boundAttachments.length
        ? await inlineAttachmentsForMessage(userMsg.id, cid)
        : "";
      const promptMessage = attachmentBlock
        ? body.message.trim()
          ? `${body.message}\n\n${attachmentBlock}`
          : attachmentBlock
        : body.message;

      // Watermark just before the spawn — anything the employee audits
      // after this is attributable to this turn. Subtract a few ms to be
      // generous with clock skew between SQLite's `datetime('now')` default
      // and our process clock.
      const turnStart = new Date(Date.now() - 10);
      const result = await streamChatWithEmployee(
        cid,
        eid,
        promptMessage,
        replay,
        (chunk) => writeEvent("chunk", { text: chunk }),
        { conversationId: conv.id },
      );

      const actions = await captureTurnActions(cid, eid, turnStart);

      const assistantMsg = await msgRepo.save(
        msgRepo.create({
          conversationId: conv.id,
          role: "assistant",
          content: result.reply,
          status: result.status,
          actionsJson: actions.length > 0 ? JSON.stringify(actions) : "",
        }),
      );

      // Bind any files the AI uploaded mid-turn (via the
      // `send_chat_attachment` MCP tool) to the assistant message so the
      // human sees them as download chips on the reply bubble.
      const replyAttachments = result.attachmentIds.length
        ? await bindAttachmentsToMessage(result.attachmentIds, assistantMsg.id, cid)
        : [];

      conv.updatedAt = new Date();
      await convRepo.save(conv);

      writeEvent("assistant", serializeMessage(assistantMsg, replyAttachments));
      writeEvent("conversation", serializeConversation(conv, conv.updatedAt));
      writeEvent("done", {});
      res.end();
    } catch (e) {
      console.error(
        `[chat] turn failed company=${cid} employee=${eid} conversation=${convId}`,
        e,
      );
      // If the stream is still open, surface the error over SSE; otherwise
      // fall back to the normal Express error handler.
      if (!res.writableEnded) {
        writeEvent("error", {
          message: formatChatInfrastructureError(e, convId),
        });
        writeEvent("done", {});
        res.end();
      } else {
        next(e);
      }
    } finally {
      clearInterval(heartbeat);
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

employeeSurfaceRouter.post(
  "/:eid/journal",
  validateBody(journalNoteSchema),
  async (req, res) => {
    const { cid, eid } = req.params as Record<string, string>;
    const loaded = await loadEmpAndCompany(cid, eid);
    if (!loaded) return res.status(404).json({ error: "Not found" });
    const body = req.body as z.infer<typeof journalNoteSchema>;
    const userId = req.session?.userId ?? null;
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
  },
);

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

employeeSurfaceRouter.post(
  "/:eid/memory",
  validateBody(memoryCreateSchema),
  async (req, res) => {
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
  },
);

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
  const convRepo = AppDataSource.getRepository(Conversation);
  const convs = await convRepo.find({ where: { employeeId } });
  if (convs.length === 0) return;
  const ids = convs.map((c) => c.id);
  await AppDataSource.getRepository(ConversationMessage)
    .createQueryBuilder()
    .delete()
    .where("conversationId IN (:...ids)", { ids })
    .execute();
  await convRepo.delete({ employeeId });
}
