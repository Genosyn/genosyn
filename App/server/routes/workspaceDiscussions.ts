import { Router, type Response } from "express";
import { z } from "zod";

import { AppDataSource } from "../db/datasource.js";
import { Channel } from "../db/entities/Channel.js";
import { requireAuth, requireBrowserSession, requireCompanyMember } from "../middleware/auth.js";
import { validateBody, validateParams, validateQuery } from "../middleware/validate.js";
import {
  GroupDiscussionError,
  getGroupDiscussion,
  listChannelDiscussions,
  startDiscussionFollowThrough,
  startGroupDiscussion,
  stopGroupDiscussion,
  summarizeDiscussion,
  wrapUpGroupDiscussion,
} from "../services/groupDiscussions.js";
import { GROUP_DISCUSSION_LIMITS } from "../services/groupDiscussionPlan.js";
import {
  GROUP_CHAT_NAME_MAX,
  createGroupChat,
  getChannel,
  groupChatNameFromQuestion,
  userHasChannelAccess,
} from "../services/workspaceChat.js";

/**
 * Group chats and group discussions — several AI Employees working a Member's
 * question out together in Workspace, and handing back one outcome.
 *
 * Mounted beside `workspaceRouter` under `/api/companies/:cid/workspace`, so
 * a group chat is an ordinary channel to everything else: its messages, read
 * state, members and settings use the routes that already exist. What lives
 * here is what is new — opening a group chat, starting a discussion, and the
 * three controls a Member has over one: Stop, Finish (write the outcome now)
 * and Start the work.
 *
 * Starting AI work runs it under the requesting Member's authority, so the
 * routes that start any — a group chat with a question, a discussion, Finish,
 * Start the work — need a signed-in browser session, like posting a message
 * does. Stop starts nothing; an API key may press it.
 */
export const workspaceDiscussionsRouter = Router({ mergeParams: true });
workspaceDiscussionsRouter.use(requireAuth);
workspaceDiscussionsRouter.use(requireCompanyMember);

const cidOf = (req: { params: unknown }) => (req.params as Record<string, string>).cid;

function sendError(res: Response, error: unknown, fallback: string) {
  if (error instanceof GroupDiscussionError) {
    return res.status(error.status).json({ error: error.message });
  }
  const message = error instanceof Error ? error.message : fallback;
  // Cross-tenant ids read exactly like missing ones (`assertActorsInCompany`).
  if (message === "User not found" || message === "Employee not found") {
    return res.status(404).json({ error: message });
  }
  return res.status(400).json({ error: message || fallback });
}

const employeeIdsSchema = z
  .array(z.string().uuid())
  .min(GROUP_DISCUSSION_LIMITS.minParticipantsToStart)
  .max(GROUP_DISCUSSION_LIMITS.maxParticipants)
  .refine((ids) => new Set(ids).size === ids.length, { message: "List each AI Employee once." });

const roundsSchema = z.number().int().min(1).max(GROUP_DISCUSSION_LIMITS.maxRounds);

const createGroupChatSchema = z
  .object({
    /** Shown in the sidebar. Defaults to the question's first line, then the members. */
    name: z.string().max(GROUP_CHAT_NAME_MAX).optional(),
    /** AI Employees in it, the lead first. */
    employeeIds: employeeIdsSchema,
    /** Other Members to bring in. The requester is always in it. */
    memberUserIds: z.array(z.string().uuid()).max(50).optional().default([]),
    /** What they should work out. Omitted: the chat opens empty. */
    question: z.string().max(GROUP_DISCUSSION_LIMITS.maxQuestionChars).optional(),
    attachmentIds: z.array(z.string().uuid()).max(10).optional().default([]),
    maxRounds: roundsSchema.optional(),
  })
  .strict();

workspaceDiscussionsRouter.post(
  "/group-chats",
  requireBrowserSession,
  validateBody(createGroupChatSchema),
  async (req, res) => {
    const companyId = cidOf(req);
    const body = req.body as z.infer<typeof createGroupChatSchema>;
    const question = body.question?.trim() ?? "";
    try {
      const channel = await createGroupChat({
        companyId,
        createdByUserId: req.userId!,
        name: body.name?.trim() || (question ? groupChatNameFromQuestion(question) : null),
        employeeIds: body.employeeIds,
        memberUserIds: body.memberUserIds.filter((id) => id !== req.userId),
      });
      const discussion =
        question || body.attachmentIds.length > 0
          ? await startGroupDiscussion({
              channel,
              requester: { userId: req.userId!, sessionVersion: req.session!.sessionVersion! },
              question,
              attachmentIds: body.attachmentIds,
              participantIds: body.employeeIds,
              maxRounds: body.maxRounds ?? null,
              minParticipants: GROUP_DISCUSSION_LIMITS.minParticipantsToStart,
            })
          : null;
      res.status(201).json({
        channel: await getChannel(channel.id, companyId, req.userId!),
        discussion,
      });
    } catch (error) {
      sendError(res, error, "Could not start the group chat");
    }
  },
);

// `cid` is part of every params schema: the validator replaces `req.params`
// with what it parsed, and the company comes from the mount path.
const channelParamsSchema = z.object({ cid: z.string().uuid(), channelId: z.string().uuid() });
const discussionParamsSchema = z.object({
  cid: z.string().uuid(),
  discussionId: z.string().uuid(),
});

const listDiscussionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

workspaceDiscussionsRouter.get(
  "/channels/:channelId/discussions",
  validateParams(channelParamsSchema),
  validateQuery(listDiscussionsQuerySchema),
  async (req, res) => {
    const companyId = cidOf(req);
    const { channelId } = req.params as z.infer<typeof channelParamsSchema>;
    const query = req.query as unknown as z.infer<typeof listDiscussionsQuerySchema>;
    const ok = await userHasChannelAccess({ channelId, userId: req.userId!, companyId });
    if (!ok) return res.status(404).json({ error: "Channel not found" });
    res.json(await listChannelDiscussions(companyId, channelId, query.limit));
  },
);

const startDiscussionSchema = z
  .object({
    question: z.string().trim().min(1).max(GROUP_DISCUSSION_LIMITS.maxQuestionChars),
    /** Who takes part, the lead first. Omitted: every AI Employee in the channel. */
    employeeIds: employeeIdsSchema.optional(),
    attachmentIds: z.array(z.string().uuid()).max(10).optional().default([]),
    maxRounds: roundsSchema.optional(),
  })
  .strict();

workspaceDiscussionsRouter.post(
  "/channels/:channelId/discussions",
  requireBrowserSession,
  validateParams(channelParamsSchema),
  validateBody(startDiscussionSchema),
  async (req, res) => {
    const companyId = cidOf(req);
    const { channelId } = req.params as z.infer<typeof channelParamsSchema>;
    const body = req.body as z.infer<typeof startDiscussionSchema>;
    const ok = await userHasChannelAccess({ channelId, userId: req.userId!, companyId });
    const channel = ok
      ? await AppDataSource.getRepository(Channel).findOneBy({ id: channelId, companyId })
      : null;
    if (!channel) return res.status(404).json({ error: "Channel not found" });
    try {
      const discussion = await startGroupDiscussion({
        channel,
        requester: { userId: req.userId!, sessionVersion: req.session!.sessionVersion! },
        question: body.question,
        attachmentIds: body.attachmentIds,
        participantIds: body.employeeIds ?? null,
        maxRounds: body.maxRounds ?? null,
        minParticipants: GROUP_DISCUSSION_LIMITS.minParticipantsToStart,
      });
      res.status(201).json(discussion);
    } catch (error) {
      sendError(res, error, "Could not start the discussion");
    }
  },
);

/** A discussion the caller may see: in this company, in a channel they can read. */
async function visibleDiscussion(companyId: string, discussionId: string, userId: string) {
  const discussion = await getGroupDiscussion(companyId, discussionId);
  if (!discussion) return null;
  const ok = await userHasChannelAccess({ channelId: discussion.channelId, userId, companyId });
  return ok ? discussion : null;
}

workspaceDiscussionsRouter.get(
  "/discussions/:discussionId",
  validateParams(discussionParamsSchema),
  async (req, res) => {
    const companyId = cidOf(req);
    const { discussionId } = req.params as z.infer<typeof discussionParamsSchema>;
    const discussion = await visibleDiscussion(companyId, discussionId, req.userId!);
    if (!discussion) return res.status(404).json({ error: "Discussion not found" });
    res.json(await summarizeDiscussion(discussion));
  },
);

const noBodySchema = z.object({}).strict();

workspaceDiscussionsRouter.post(
  "/discussions/:discussionId/stop",
  validateParams(discussionParamsSchema),
  validateBody(noBodySchema),
  async (req, res) => {
    const companyId = cidOf(req);
    const { discussionId } = req.params as z.infer<typeof discussionParamsSchema>;
    const discussion = await visibleDiscussion(companyId, discussionId, req.userId!);
    if (!discussion) return res.status(404).json({ error: "Discussion not found" });
    try {
      res.json(await stopGroupDiscussion({ companyId, discussionId, userId: req.userId! }));
    } catch (error) {
      sendError(res, error, "Could not stop the discussion");
    }
  },
);

workspaceDiscussionsRouter.post(
  "/discussions/:discussionId/finish",
  requireBrowserSession,
  validateParams(discussionParamsSchema),
  validateBody(noBodySchema),
  async (req, res) => {
    const companyId = cidOf(req);
    const { discussionId } = req.params as z.infer<typeof discussionParamsSchema>;
    const discussion = await visibleDiscussion(companyId, discussionId, req.userId!);
    if (!discussion) return res.status(404).json({ error: "Discussion not found" });
    try {
      res.json(await wrapUpGroupDiscussion({ companyId, discussionId, userId: req.userId! }));
    } catch (error) {
      sendError(res, error, "Could not finish the discussion");
    }
  },
);

workspaceDiscussionsRouter.post(
  "/discussions/:discussionId/start-work",
  requireBrowserSession,
  validateParams(discussionParamsSchema),
  validateBody(noBodySchema),
  async (req, res) => {
    const companyId = cidOf(req);
    const { discussionId } = req.params as z.infer<typeof discussionParamsSchema>;
    const discussion = await visibleDiscussion(companyId, discussionId, req.userId!);
    if (!discussion) return res.status(404).json({ error: "Discussion not found" });
    try {
      res.json(
        await startDiscussionFollowThrough({
          companyId,
          discussionId,
          requester: { userId: req.userId!, sessionVersion: req.session!.sessionVersion! },
        }),
      );
    } catch (error) {
      sendError(res, error, "Could not start the work");
    }
  },
);
