import { Router } from "express";
import { z } from "zod";
import { AppDataSource } from "../db/datasource.js";
import { Company } from "../db/entities/Company.js";
import { validateBody } from "../middleware/validate.js";
import { requireAuth, requireCompanyMember } from "../middleware/auth.js";
import {
  addChannelMembers,
  archiveChannel,
  createChannel,
  editMessage,
  findOrCreateDM,
  getChannel,
  listChannelsForUser,
  listCompanyDirectory,
  listMessages,
  markChannelRead,
  postMessage,
  removeChannelMember,
  softDeleteMessage,
  toggleReaction,
  userHasChannelAccess,
} from "../services/workspaceChat.js";
import { mintWsToken } from "../services/realtime.js";
import {
  recordAttachment,
  resolveAttachmentFile,
  uploadMiddleware,
} from "../services/uploads.js";

/**
 * HTTP surface for the Slack-style workspace chat (channels, DMs, messages,
 * reactions, file uploads, realtime token mint).
 *
 * Conventions borrowed from the rest of the codebase:
 *   - Mounted under `/api/companies/:cid/workspace`, so `requireAuth` and
 *     `requireCompanyMember` cover every route.
 *   - Services own business logic; handlers parse input, call in, and shape
 *     the response.
 *   - Every write endpoint runs through a zod schema via `validateBody`.
 */

export const workspaceRouter = Router({ mergeParams: true });
workspaceRouter.use(requireAuth);
workspaceRouter.use(requireCompanyMember);

// Middleware that hydrates `req.company` from the URL param for routes that
// need the slug (uploads use it to compute the on-disk target dir).
workspaceRouter.use(async (req, res, next) => {
  const cid = (req.params as Record<string, string>).cid;
  const co = await AppDataSource.getRepository(Company).findOneBy({ id: cid });
  if (!co) return res.status(404).json({ error: "Company not found" });
  (req as unknown as { company: Company }).company = co;
  next();
});

function companyOf(req: { company?: Company }): Company {
  if (!req.company) throw new Error("Company context missing");
  return req.company;
}

// ───────────────────────── Directory ─────────────────────────────────────

workspaceRouter.get("/directory", async (req, res) => {
  const co = companyOf(req as unknown as { company?: Company });
  const dir = await listCompanyDirectory(co.id);
  res.json(dir);
});

// ───────────────────────── Realtime token ────────────────────────────────

workspaceRouter.post("/ws-token", async (req, res) => {
  const co = companyOf(req as unknown as { company?: Company });
  if (!req.userId) return res.status(401).json({ error: "Unauthorized" });
  const token = mintWsToken(req.userId, co.id);
  res.json({ token });
});

// ───────────────────────── Channels ──────────────────────────────────────

workspaceRouter.get("/channels", async (req, res) => {
  const co = companyOf(req as unknown as { company?: Company });
  const list = await listChannelsForUser(co.id, req.userId!);
  res.json(list);
});

workspaceRouter.get("/channels/:channelId", async (req, res) => {
  const co = companyOf(req as unknown as { company?: Company });
  const ok = await userHasChannelAccess({
    channelId: req.params.channelId,
    userId: req.userId!,
    companyId: co.id,
  });
  if (!ok) return res.status(404).json({ error: "Channel not found" });
  const c = await getChannel(req.params.channelId, co.id, req.userId!);
  if (!c) return res.status(404).json({ error: "Channel not found" });
  res.json(c);
});

const createChannelSchema = z.object({
  name: z.string().min(1).max(80),
  topic: z.string().max(280).optional().default(""),
  kind: z.enum(["public", "private"]).default("public"),
  memberUserIds: z.array(z.string().uuid()).optional().default([]),
  employeeIds: z.array(z.string().uuid()).optional().default([]),
});
workspaceRouter.post(
  "/channels",
  validateBody(createChannelSchema),
  async (req, res) => {
    const co = companyOf(req as unknown as { company?: Company });
    const body = (req as unknown as { validated: z.infer<typeof createChannelSchema> })
      .validated;
    try {
      const channel = await createChannel({
        companyId: co.id,
        name: body.name,
        topic: body.topic,
        kind: body.kind,
        createdByUserId: req.userId!,
        initialMemberUserIds: body.memberUserIds,
        initialEmployeeIds: body.employeeIds,
      });
      const hydrated = await getChannel(channel.id, co.id, req.userId!);
      res.status(201).json(hydrated);
    } catch (err) {
      res
        .status(400)
        .json({ error: err instanceof Error ? err.message : "Create failed" });
    }
  },
);

workspaceRouter.post("/channels/:channelId/archive", async (req, res) => {
  const co = companyOf(req as unknown as { company?: Company });
  const ok = await userHasChannelAccess({
    channelId: req.params.channelId,
    userId: req.userId!,
    companyId: co.id,
  });
  if (!ok) return res.status(404).json({ error: "Channel not found" });
  await archiveChannel(req.params.channelId);
  res.json({ ok: true });
});

const addMembersSchema = z.object({
  userIds: z.array(z.string().uuid()).optional().default([]),
  employeeIds: z.array(z.string().uuid()).optional().default([]),
});
workspaceRouter.post(
  "/channels/:channelId/members",
  validateBody(addMembersSchema),
  async (req, res) => {
    const co = companyOf(req as unknown as { company?: Company });
    const ok = await userHasChannelAccess({
      channelId: req.params.channelId,
      userId: req.userId!,
      companyId: co.id,
    });
    if (!ok) return res.status(404).json({ error: "Channel not found" });
    const body = (req as unknown as { validated: z.infer<typeof addMembersSchema> })
      .validated;
    await addChannelMembers({
      channelId: req.params.channelId,
      userIds: body.userIds,
      employeeIds: body.employeeIds,
    });
    const hydrated = await getChannel(req.params.channelId, co.id, req.userId!);
    res.json(hydrated);
  },
);

workspaceRouter.delete(
  "/channels/:channelId/members/:memberId",
  async (req, res) => {
    const co = companyOf(req as unknown as { company?: Company });
    const ok = await userHasChannelAccess({
      channelId: req.params.channelId,
      userId: req.userId!,
      companyId: co.id,
    });
    if (!ok) return res.status(404).json({ error: "Channel not found" });
    await removeChannelMember(req.params.channelId, req.params.memberId);
    res.json({ ok: true });
  },
);

workspaceRouter.post("/channels/:channelId/read", async (req, res) => {
  const co = companyOf(req as unknown as { company?: Company });
  const ok = await userHasChannelAccess({
    channelId: req.params.channelId,
    userId: req.userId!,
    companyId: co.id,
  });
  if (!ok) return res.status(404).json({ error: "Channel not found" });
  await markChannelRead({
    channelId: req.params.channelId,
    userId: req.userId!,
  });
  res.json({ ok: true });
});

// ───────────────────────── DMs ───────────────────────────────────────────

const openDMSchema = z.object({
  targetUserId: z.string().uuid().optional(),
  targetEmployeeId: z.string().uuid().optional(),
});
workspaceRouter.post(
  "/dms",
  validateBody(openDMSchema),
  async (req, res) => {
    const co = companyOf(req as unknown as { company?: Company });
    const body = (req as unknown as { validated: z.infer<typeof openDMSchema> })
      .validated;
    if (!body.targetUserId && !body.targetEmployeeId) {
      return res.status(400).json({ error: "Must specify a target" });
    }
    if (body.targetUserId === req.userId) {
      return res.status(400).json({ error: "Cannot DM yourself" });
    }
    const target = body.targetUserId
      ? ({ kind: "user", userId: body.targetUserId } as const)
      : ({ kind: "ai", employeeId: body.targetEmployeeId! } as const);
    const channel = await findOrCreateDM({
      companyId: co.id,
      fromUserId: req.userId!,
      target,
    });
    const hydrated = await getChannel(channel.id, co.id, req.userId!);
    res.json(hydrated);
  },
);

// ───────────────────────── Messages ──────────────────────────────────────

workspaceRouter.get("/channels/:channelId/messages", async (req, res) => {
  const co = companyOf(req as unknown as { company?: Company });
  const ok = await userHasChannelAccess({
    channelId: req.params.channelId,
    userId: req.userId!,
    companyId: co.id,
  });
  if (!ok) return res.status(404).json({ error: "Channel not found" });
  const before = typeof req.query.before === "string" ? req.query.before : undefined;
  const limitRaw = typeof req.query.limit === "string" ? Number(req.query.limit) : 50;
  const limit = Math.max(1, Math.min(200, Number.isFinite(limitRaw) ? limitRaw : 50));
  const rows = await listMessages({
    channelId: req.params.channelId,
    companyId: co.id,
    viewerUserId: req.userId!,
    before,
    limit,
  });
  res.json(rows);
});

const sendMessageSchema = z.object({
  content: z.string().max(16_000),
  parentMessageId: z.string().uuid().nullable().optional(),
  attachmentIds: z.array(z.string().uuid()).optional().default([]),
});
workspaceRouter.post(
  "/channels/:channelId/messages",
  validateBody(sendMessageSchema),
  async (req, res) => {
    const co = companyOf(req as unknown as { company?: Company });
    const body = (req as unknown as { validated: z.infer<typeof sendMessageSchema> })
      .validated;
    const ok = await userHasChannelAccess({
      channelId: req.params.channelId,
      userId: req.userId!,
      companyId: co.id,
    });
    if (!ok) return res.status(404).json({ error: "Channel not found" });
    if (!body.content.trim() && body.attachmentIds.length === 0) {
      return res.status(400).json({ error: "Empty message" });
    }
    try {
      const msg = await postMessage({
        channelId: req.params.channelId,
        companyId: co.id,
        authorUserId: req.userId!,
        content: body.content,
        parentMessageId: body.parentMessageId ?? null,
        attachmentIds: body.attachmentIds,
      });
      res.status(201).json(msg);
    } catch (err) {
      res
        .status(400)
        .json({ error: err instanceof Error ? err.message : "Send failed" });
    }
  },
);

const editMessageSchema = z.object({ content: z.string().min(1).max(16_000) });
workspaceRouter.patch(
  "/messages/:messageId",
  validateBody(editMessageSchema),
  async (req, res) => {
    const body = (req as unknown as { validated: z.infer<typeof editMessageSchema> })
      .validated;
    try {
      const updated = await editMessage({
        messageId: req.params.messageId,
        userId: req.userId!,
        content: body.content,
      });
      res.json(updated);
    } catch (err) {
      res
        .status(400)
        .json({ error: err instanceof Error ? err.message : "Edit failed" });
    }
  },
);

workspaceRouter.delete("/messages/:messageId", async (req, res) => {
  try {
    await softDeleteMessage({
      messageId: req.params.messageId,
      userId: req.userId!,
    });
    res.json({ ok: true });
  } catch (err) {
    res
      .status(400)
      .json({ error: err instanceof Error ? err.message : "Delete failed" });
  }
});

const reactionSchema = z.object({
  emoji: z.string().min(1).max(32),
});
workspaceRouter.post(
  "/messages/:messageId/reactions",
  validateBody(reactionSchema),
  async (req, res) => {
    const co = companyOf(req as unknown as { company?: Company });
    const body = (req as unknown as { validated: z.infer<typeof reactionSchema> })
      .validated;
    try {
      const r = await toggleReaction({
        messageId: req.params.messageId,
        emoji: body.emoji,
        userId: req.userId!,
        companyId: co.id,
      });
      res.json(r);
    } catch (err) {
      res
        .status(400)
        .json({ error: err instanceof Error ? err.message : "Reaction failed" });
    }
  },
);

// ─────────────────────── Uploads + download ──────────────────────────────

workspaceRouter.post(
  "/attachments",
  uploadMiddleware.single("file"),
  async (req, res) => {
    const co = companyOf(req as unknown as { company?: Company });
    const file = (req as unknown as { file?: Express.Multer.File }).file;
    if (!file) return res.status(400).json({ error: "No file uploaded" });
    const row = await recordAttachment({
      companyId: co.id,
      companySlug: co.slug,
      file,
      uploadedByUserId: req.userId!,
    });
    res.status(201).json({
      id: row.id,
      filename: row.filename,
      mimeType: row.mimeType,
      sizeBytes: Number(row.sizeBytes),
      isImage: row.mimeType.startsWith("image/"),
    });
  },
);

workspaceRouter.get("/attachments/:id", async (req, res) => {
  const co = companyOf(req as unknown as { company?: Company });
  const resolved = await resolveAttachmentFile(req.params.id, co.id);
  if (!resolved) return res.status(404).json({ error: "Attachment not found" });
  res.setHeader("Content-Type", resolved.row.mimeType);
  const inline = resolved.row.mimeType.startsWith("image/");
  const disposition = inline ? "inline" : "attachment";
  res.setHeader(
    "Content-Disposition",
    `${disposition}; filename="${encodeURIComponent(resolved.row.filename)}"`,
  );
  res.sendFile(resolved.absPath);
});
