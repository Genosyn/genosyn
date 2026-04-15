import { Router } from "express";
import { z } from "zod";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { Conversation } from "../db/entities/Conversation.js";
import { ConversationMessage } from "../db/entities/ConversationMessage.js";
import { JournalEntry } from "../db/entities/JournalEntry.js";
import { requireAuth, requireCompanyMember } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { chatWithEmployee } from "../services/chat.js";
import {
  buildTree,
  readWorkspaceFile,
  writeWorkspaceFile,
} from "../services/workspace.js";

/**
 * Chat + workspace endpoints. Split from `employees.ts` to keep the employee
 * CRUD file focused — these two surfaces reach into the runner seam and the
 * filesystem respectively, which is a different concern from DB bookkeeping.
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
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    lastMessageAt,
  };
}

function serializeMessage(m: ConversationMessage) {
  return {
    id: m.id,
    conversationId: m.conversationId,
    role: m.role,
    content: m.content,
    status: m.status,
    createdAt: m.createdAt,
  };
}

employeeSurfaceRouter.get("/:eid/conversations", async (req, res) => {
  const { cid, eid } = req.params as Record<string, string>;
  const loaded = await loadEmpAndCompany(cid, eid);
  if (!loaded) return res.status(404).json({ error: "Not found" });
  const rows = await AppDataSource.getRepository(Conversation).find({
    where: { employeeId: eid },
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

employeeSurfaceRouter.post(
  "/:eid/conversations/:convId/messages",
  validateBody(sendSchema),
  async (req, res, next) => {
    try {
      const { cid, eid, convId } = req.params as Record<string, string>;
      const body = req.body as z.infer<typeof sendSchema>;
      const loaded = await loadEmpAndCompany(cid, eid);
      if (!loaded) return res.status(404).json({ error: "Not found" });

      const convRepo = AppDataSource.getRepository(Conversation);
      const msgRepo = AppDataSource.getRepository(ConversationMessage);

      const conv = await convRepo.findOneBy({ id: convId, employeeId: eid });
      if (!conv) return res.status(404).json({ error: "Conversation not found" });

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
      // Bump updatedAt explicitly in case we don't change any other column —
      // @UpdateDateColumn only fires when something changes.
      conv.updatedAt = new Date();
      await convRepo.save(conv);

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

      const result = await chatWithEmployee(cid, eid, body.message, replay);

      const assistantMsg = await msgRepo.save(
        msgRepo.create({
          conversationId: conv.id,
          role: "assistant",
          content: result.reply,
          status: result.status,
        }),
      );

      // Second save to refresh updatedAt for the assistant reply.
      conv.updatedAt = new Date();
      await convRepo.save(conv);

      res.json({
        conversation: serializeConversation(conv, conv.updatedAt),
        userMessage: serializeMessage(userMsg),
        assistantMessage: serializeMessage(assistantMsg),
      });
    } catch (e) {
      next(e);
    }
  },
);

// ---------- Workspace ----------

employeeSurfaceRouter.get("/:eid/workspace/tree", async (req, res) => {
  const { cid, eid } = req.params as Record<string, string>;
  const loaded = await loadEmpAndCompany(cid, eid);
  if (!loaded) return res.status(404).json({ error: "Not found" });
  res.json(buildTree(loaded.co.slug, loaded.emp.slug));
});

employeeSurfaceRouter.get("/:eid/workspace/file", async (req, res) => {
  const { cid, eid } = req.params as Record<string, string>;
  const rel = typeof req.query.path === "string" ? req.query.path : "";
  if (!rel) return res.status(400).json({ error: "Missing path" });
  const loaded = await loadEmpAndCompany(cid, eid);
  if (!loaded) return res.status(404).json({ error: "Not found" });
  const file = readWorkspaceFile(loaded.co.slug, loaded.emp.slug, rel);
  if (file === null) return res.status(400).json({ error: "Invalid path" });
  res.json(file);
});

const writeSchema = z.object({
  path: z.string().min(1).max(1024),
  content: z.string(),
});

employeeSurfaceRouter.put(
  "/:eid/workspace/file",
  validateBody(writeSchema),
  async (req, res) => {
    const { cid, eid } = req.params as Record<string, string>;
    const body = req.body as z.infer<typeof writeSchema>;
    const loaded = await loadEmpAndCompany(cid, eid);
    if (!loaded) return res.status(404).json({ error: "Not found" });
    const result = writeWorkspaceFile(loaded.co.slug, loaded.emp.slug, body.path, body.content);
    if ("error" in result) return res.status(400).json({ error: result.error });
    res.json({ ok: true });
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
