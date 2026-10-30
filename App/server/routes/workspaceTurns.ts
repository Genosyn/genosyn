import { Router, type Response } from "express";
import { z } from "zod";

import { requireAuth, requireBrowserSession, requireCompanyMember } from "../middleware/auth.js";
import { validateBody, validateParams, validateQuery } from "../middleware/validate.js";
import {
  ChannelTurnError,
  followChannelTurn,
  interruptChannelTurn,
  listChannelTurnsForViewer,
  readChannelTurnActivity,
  retryChannelTurn,
} from "../services/channelTurns.js";
import { summarizeChannelTurn } from "../services/channelTurnViews.js";

/**
 * What the room sees of an AI Employee's turn in a Workspace channel, DM or
 * group chat while it works: the turns still running, each one's activity as
 * this Member may see it, a live stream of it, and Stop and Retry
 * (`services/channelTurns.ts`).
 *
 * Mounted beside `workspaceRouter` under `/api/companies/:cid/workspace`.
 * Every route answers only for a room the caller can read, and a turn in a
 * room they cannot read reads as missing. What each reader sees of a turn's
 * steps is decided by `shared/turnActivityAccess.ts`: the Member whose
 * authority it ran under sees everything, the rest of the room the steps.
 *
 * Like a direct chat's activity, a turn's steps and its live stream need a
 * signed-in browser session — no API key or connected app reads what an AI
 * Employee's tools returned — and so does Retry, which starts AI work under
 * the caller's authority. The list of running turns says only who is working
 * on what, and Stop starts nothing, so an API key may use both.
 */
export const workspaceTurnsRouter = Router({ mergeParams: true });
workspaceTurnsRouter.use(requireAuth);
workspaceTurnsRouter.use(requireCompanyMember);

// `cid` is part of every params schema: the validator replaces `req.params`
// with what it parsed, and the company comes from the mount path.
const channelParamsSchema = z.object({ cid: z.string().uuid(), channelId: z.string().uuid() });
const turnParamsSchema = channelParamsSchema.extend({ turnId: z.string().uuid() });
const activityQuerySchema = z.object({
  /** The last ordinal the reader already holds; 0 reads from the start. */
  after: z.coerce.number().int().min(0).optional().default(0),
  limit: z.coerce.number().int().min(1).max(1_000).optional().default(500),
});
const streamQuerySchema = z.object({
  after: z.coerce.number().int().min(0).optional().default(0),
});
const noBodySchema = z.object({}).strict();

function sendError(res: Response, error: unknown): Response | void {
  if (error instanceof ChannelTurnError) {
    return res.status(error.status).json({ error: error.message });
  }
  throw error;
}

/**
 * The AI Employees working in this room right now — replying, taking a turn
 * in a discussion, or doing their share of its work — oldest first. Who,
 * what, under whose authority and how it stands; never its steps.
 */
workspaceTurnsRouter.get(
  "/channels/:channelId/turns",
  validateParams(channelParamsSchema),
  async (req, res, next) => {
    const { cid, channelId } = req.params as z.infer<typeof channelParamsSchema>;
    try {
      res.json(
        await listChannelTurnsForViewer({ companyId: cid, channelId, viewerUserId: req.userId! }),
      );
    } catch (error) {
      try {
        sendError(res, error);
      } catch (unexpected) {
        next(unexpected);
      }
    }
  },
);

/**
 * What an AI Employee did while it took one turn, step by step, as this
 * Member may see it (`access`): everything for the Member whose authority it
 * ran under, and the steps without what their tools read or returned for the
 * rest of the room. `after` pages through a long turn.
 */
workspaceTurnsRouter.get(
  "/channels/:channelId/turns/:turnId/activity",
  requireBrowserSession,
  validateParams(turnParamsSchema),
  validateQuery(activityQuerySchema),
  async (req, res, next) => {
    const { cid, channelId, turnId } = req.params as z.infer<typeof turnParamsSchema>;
    const query = req.query as unknown as z.infer<typeof activityQuerySchema>;
    try {
      res.json(
        await readChannelTurnActivity({
          companyId: cid,
          channelId,
          turnId,
          viewerUserId: req.userId!,
          after: query.after,
          limit: query.limit,
        }),
      );
    } catch (error) {
      try {
        sendError(res, error);
      } catch (unexpected) {
        next(unexpected);
      }
    }
  },
);

/**
 * Follow one turn live, from the reader's cursor to its end — how a room
 * watches an AI Employee work, and how a reload or a dropped connection
 * re-attaches. Server-Sent Events: `turn`, `activity`, `snapshot`, `chunk`,
 * `progress`, `heartbeat`, then `final` (the turn as it ended and the reply
 * it wrote) and `done`. The frames are described on `followChatTurn`
 * (`services/chatTurnFollow.ts`).
 */
workspaceTurnsRouter.get(
  "/channels/:channelId/turns/:turnId/activity/stream",
  requireBrowserSession,
  validateParams(turnParamsSchema),
  validateQuery(streamQuerySchema),
  async (req, res, next) => {
    const { cid, channelId, turnId } = req.params as z.infer<typeof turnParamsSchema>;
    const query = req.query as unknown as z.infer<typeof streamQuerySchema>;
    let opened = false;
    const writeEvent = (event: string, data: unknown) => {
      if (!opened) {
        opened = true;
        res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        res.flushHeaders?.();
      }
      if (res.writableEnded || res.destroyed) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const stop = new AbortController();
    res.on("close", () => stop.abort());
    try {
      await followChannelTurn({
        companyId: cid,
        channelId,
        turnId,
        viewerUserId: req.userId!,
        after: query.after,
        send: writeEvent,
        signal: stop.signal,
      });
    } catch (error) {
      if (!opened) {
        try {
          sendError(res, error);
        } catch (unexpected) {
          next(unexpected);
        }
        return;
      }
      // eslint-disable-next-line no-console
      console.error(`[channel-turns] following turn ${turnId} failed`, error);
      writeEvent("error", { message: "Lost track of this reply. It continues on the server." });
    }
    if (!res.writableEnded && !res.destroyed) res.end();
  },
);

/**
 * Stop a reply, running or still waiting — for its AI Model, or for another
 * reply. Anyone who can read the room may; what it had written is kept as
 * the reply, and its activity names who stopped it. A discussion's turns
 * stop with the discussion. Answers whether there was anything to stop.
 */
workspaceTurnsRouter.post(
  "/channels/:channelId/turns/:turnId/stop",
  validateParams(turnParamsSchema),
  validateBody(noBodySchema),
  async (req, res, next) => {
    const { cid, channelId, turnId } = req.params as z.infer<typeof turnParamsSchema>;
    try {
      const outcome = await interruptChannelTurn({
        companyId: cid,
        channelId,
        turnId,
        byUserId: req.userId!,
      });
      res.json({ interrupted: outcome === "interrupted" });
    } catch (error) {
      try {
        sendError(res, error);
      } catch (unexpected) {
        next(unexpected);
      }
    }
  },
);

/**
 * Ask a failed reply again: a new reply to the same message by the same AI
 * Employee, told an earlier attempt did not finish. Under the caller's
 * authority when the failed one ran under a Member's; under the same as
 * before otherwise. Answers the new turn; follow it with `…/activity/stream`.
 */
workspaceTurnsRouter.post(
  "/channels/:channelId/turns/:turnId/retry",
  requireBrowserSession,
  validateParams(turnParamsSchema),
  validateBody(noBodySchema),
  async (req, res, next) => {
    const { cid, channelId, turnId } = req.params as z.infer<typeof turnParamsSchema>;
    try {
      const turn = await retryChannelTurn({
        companyId: cid,
        channelId,
        turnId,
        requester: { userId: req.userId!, sessionVersion: req.session!.sessionVersion! },
      });
      res.status(201).json(await summarizeChannelTurn(turn));
    } catch (error) {
      try {
        sendError(res, error);
      } catch (unexpected) {
        next(unexpected);
      }
    }
  },
);
