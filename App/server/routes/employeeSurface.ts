import { Router } from "express";
import { z } from "zod";
import { IsNull, MoreThan, Not } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { Conversation } from "../db/entities/Conversation.js";
import {
  ConversationMessage,
  MessageAction,
  MessageActionMetadata,
} from "../db/entities/ConversationMessage.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { JournalEntry } from "../db/entities/JournalEntry.js";
import { EmployeeMemory } from "../db/entities/EmployeeMemory.js";
import { requireAuth, requireCompanyMember } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { streamChatWithEmployee } from "../services/chat.js";

/**
 * Chat + per-employee surface endpoints. Split from `employees.ts` to keep
 * the employee CRUD file focused — these reach into the runner seam (chat
 * streaming) and the journal/memory tables.
 */
export const employeeSurfaceRouter = Router({ mergeParams: true });
employeeSurfaceRouter.use(requireAuth);
employeeSurfaceRouter.use(requireCompanyMember);

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

function serializeMessage(m: ConversationMessage) {
  return {
    id: m.id,
    conversationId: m.conversationId,
    role: m.role,
    content: m.content,
    status: m.status,
    actions: parseActions(m.actionsJson),
    createdAt: m.createdAt,
  };
}

function parseActions(raw: string | null | undefined): MessageAction[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.filter(
      (x): x is MessageAction =>
        !!x &&
        typeof x === "object" &&
        typeof (x as MessageAction).action === "string",
    );
  } catch {
    return [];
  }
}

/**
 * Narrow a persisted `metadataJson` blob down to the specific fields the
 * chat UI renders. We don't want to leak every field we happen to store
 * server-side into the client JSON — and fields of unexpected shape
 * should silently drop so one bad row can't break the pill list.
 */
function parseActionMetadata(
  raw: string | null | undefined,
): MessageActionMetadata | undefined {
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const src = parsed as Record<string, unknown>;
  const out: MessageActionMetadata = {};
  if (typeof src.via === "string") out.via = src.via;
  if (typeof src.provider === "string") out.provider = src.provider;
  if (typeof src.connectionId === "string") out.connectionId = src.connectionId;
  if (typeof src.connectionLabel === "string") {
    out.connectionLabel = src.connectionLabel;
  }
  if (typeof src.toolName === "string") out.toolName = src.toolName;
  if (src.status === "ok" || src.status === "error") out.status = src.status;
  if (typeof src.durationMs === "number" && Number.isFinite(src.durationMs)) {
    out.durationMs = src.durationMs;
  }
  if (typeof src.argsPreview === "string") out.argsPreview = src.argsPreview;
  if (typeof src.resultPreview === "string") out.resultPreview = src.resultPreview;
  if (typeof src.error === "string") out.error = src.error;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Fetch the AuditEvents this employee produced during the chat turn
 * (after `since`) and project them onto the lean MessageAction shape the
 * UI renders. Filtered to `actorKind: "ai"` so we don't accidentally
 * surface mutations from other callers (webhook, cron, human admin) that
 * happened to land in the same millisecond window.
 */
async function captureTurnActions(
  companyId: string,
  employeeId: string,
  since: Date,
): Promise<MessageAction[]> {
  const events = await AppDataSource.getRepository(AuditEvent).find({
    where: {
      companyId,
      actorEmployeeId: employeeId,
      actorKind: "ai",
      createdAt: MoreThan(since),
    },
    order: { createdAt: "ASC" },
  });
  return events.map((e) => {
    const metadata = parseActionMetadata(e.metadataJson);
    const action: MessageAction = {
      action: e.action,
      targetType: e.targetType,
      targetId: e.targetId,
      targetLabel: e.targetLabel,
    };
    if (metadata) action.metadata = metadata;
    return action;
  });
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
  res.json({
    conversation: serializeConversation(conv, conv.updatedAt),
    messages: messages.map(serializeMessage),
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

const sendSchema = z.object({
  message: z.string().min(1).max(8000),
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

      // Persist the user turn first so it survives a CLI crash / timeout.
      const userMsg = await msgRepo.save(
        msgRepo.create({
          conversationId: conv.id,
          role: "user",
          content: body.message,
          status: null,
        }),
      );

      // Set the conversation title on first send so the sidebar stops
      // showing "New conversation".
      if (!conv.title) {
        conv.title = deriveTitle(body.message);
      }
      conv.updatedAt = new Date();
      await convRepo.save(conv);

      writeEvent("user", serializeMessage(userMsg));

      // Replay the tail of the thread (excluding the just-saved user msg)
      // to the CLI so it has recent context.
      const prior = await msgRepo.find({
        where: { conversationId: conv.id },
        order: { createdAt: "ASC" },
      });
      const replay = prior
        .filter((m) => m.id !== userMsg.id)
        .slice(-MAX_REPLAY_TURNS)
        .map((m) => ({ role: m.role, content: m.content }));

      // Watermark just before the spawn — anything the employee audits
      // after this is attributable to this turn. Subtract a few ms to be
      // generous with clock skew between SQLite's `datetime('now')` default
      // and our process clock.
      const turnStart = new Date(Date.now() - 10);
      const result = await streamChatWithEmployee(
        cid,
        eid,
        body.message,
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

      conv.updatedAt = new Date();
      await convRepo.save(conv);

      writeEvent("assistant", serializeMessage(assistantMsg));
      writeEvent("conversation", serializeConversation(conv, conv.updatedAt));
      writeEvent("done", {});
      res.end();
    } catch (e) {
      // If the stream is still open, surface the error over SSE; otherwise
      // fall back to the normal Express error handler.
      if (!res.writableEnded) {
        writeEvent("error", {
          message: e instanceof Error ? e.message : String(e),
        });
        writeEvent("done", {});
        res.end();
      } else {
        next(e);
      }
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
