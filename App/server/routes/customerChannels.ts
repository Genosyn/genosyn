import { Router, type NextFunction, type Response } from "express";
import { z } from "zod";

import { requireAuth, requireCompanyMember, requireCompanyRole } from "../middleware/auth.js";
import { validateBody, validateParams, validateQuery } from "../middleware/validate.js";
import { recordAudit } from "../services/audit.js";
import { writeCustomerChannelNotes } from "../services/customerChannels/notes.js";
import {
  customerChannelFailure,
  linkCustomerChannel,
  listCustomerChannels,
  listLinkableChannels,
  requireCustomerChannel,
  serializeCustomerChannels,
  unlinkCustomerChannel,
  updateCustomerChannel,
} from "../services/customerChannels/store.js";
import {
  CUSTOMER_CHANNEL_INSTRUCTIONS_LIMITS,
  CUSTOMER_CHANNEL_REPLY_MODES,
  DEFAULT_CUSTOMER_CHANNEL_REPLY_MODE,
  type CustomerChannelReplyMode,
} from "../../shared/customerChannels.js";

/**
 * Customer channels — a Slack channel linked to one Customer, where an AI
 * Employee keeps notes on that Customer's timeline and may answer the people
 * in it. Mounted under `/api/companies/:cid/customer-channels`.
 *
 * Owner/admin only, reads included. Linking a channel decides what an AI
 * Employee says to a customer on the company's behalf, which Customer's record
 * it writes to, and which room's conversation it keeps, and the instructions
 * are the company's own words to its customers. None of that is a Member's to
 * change, and the channel list from Slack is the workspace's private channels.
 * The work itself lives in `services/customerChannels/`.
 */
export const customerChannelsRouter = Router({ mergeParams: true });
customerChannelsRouter.use(requireAuth);
customerChannelsRouter.use(requireCompanyMember);
customerChannelsRouter.use(requireCompanyRole("admin"));

function cid(req: { params: unknown }): string {
  return (req.params as { cid: string }).cid;
}

function fail(res: Response, next: NextFunction, err: unknown): void {
  const known = customerChannelFailure(err);
  if (known) {
    res.status(known.status).json({ error: known.message });
    return;
  }
  next(err);
}

const companyParams = z.object({ cid: z.string().uuid() }).strict();
const channelParams = z.object({ cid: z.string().uuid(), id: z.string().uuid() }).strict();

const replyMode = z.enum(
  CUSTOMER_CHANNEL_REPLY_MODES as [CustomerChannelReplyMode, ...CustomerChannelReplyMode[]],
);
// Bounded at the wire generously; the line and character rules that matter are
// the shared ones, checked by the service so every caller gets the same words.
const instructions = z.string().max(CUSTOMER_CHANNEL_INSTRUCTIONS_LIMITS.maxLength * 2);

export const listQuerySchema = z
  .object({
    connectionId: z.string().uuid().optional(),
    customerId: z.string().uuid().optional(),
  })
  .strict();

customerChannelsRouter.get(
  "/",
  validateParams(companyParams),
  validateQuery(listQuerySchema),
  async (req, res, next) => {
    try {
      const filter = req.query as unknown as z.infer<typeof listQuerySchema>;
      const rows = await listCustomerChannels(cid(req), filter);
      res.json({ channels: await serializeCustomerChannels(rows) });
    } catch (err) {
      fail(res, next, err);
    }
  },
);

export const slackChannelsQuerySchema = z.object({ connectionId: z.string().uuid() }).strict();

/** The channels the Slack app is in, for the link picker. */
customerChannelsRouter.get(
  "/slack-channels",
  validateParams(companyParams),
  validateQuery(slackChannelsQuerySchema),
  async (req, res, next) => {
    try {
      const { connectionId } = req.query as unknown as z.infer<typeof slackChannelsQuerySchema>;
      res.json({ channels: await listLinkableChannels(cid(req), connectionId) });
    } catch (err) {
      fail(res, next, err);
    }
  },
);

export const linkBodySchema = z
  .object({
    connectionId: z.string().uuid(),
    // A Slack channel id: C for public, G for older private channels.
    externalChannelId: z
      .string()
      .trim()
      .regex(/^[CG][A-Z0-9]{2,40}$/, "Pick a channel from the list"),
    customerId: z.string().uuid(),
    employeeId: z.string().uuid(),
    replyMode: replyMode.default(DEFAULT_CUSTOMER_CHANNEL_REPLY_MODE),
    instructions: instructions.default(""),
  })
  .strict();

customerChannelsRouter.post(
  "/",
  validateParams(companyParams),
  validateBody(linkBodySchema),
  async (req, res, next) => {
    try {
      const body = req.body as z.infer<typeof linkBodySchema>;
      const channel = await linkCustomerChannel({
        companyId: cid(req),
        ...body,
        userId: req.userId ?? null,
      });
      // Audited because it decides what an AI Employee says to a customer on
      // the company's behalf, and which record their words are written onto.
      await recordAudit({
        companyId: cid(req),
        actorUserId: req.userId ?? null,
        action: "customer_channel.link",
        targetType: "customer_channel",
        targetId: channel.id,
        targetLabel: channel.name ? `#${channel.name}` : channel.externalChannelId,
        metadata: {
          provider: channel.provider,
          connectionId: channel.connectionId,
          customerId: channel.customerId,
          employeeId: channel.employeeId,
          replyMode: channel.replyMode,
          shared: channel.shared,
        },
      });
      const [dto] = await serializeCustomerChannels([channel]);
      res.json(dto);
    } catch (err) {
      fail(res, next, err);
    }
  },
);

export const updateBodySchema = z
  .object({
    customerId: z.string().uuid().optional(),
    employeeId: z.string().uuid().nullable().optional(),
    replyMode: replyMode.optional(),
    instructions: instructions.optional(),
  })
  .strict();

customerChannelsRouter.patch(
  "/:id",
  validateParams(channelParams),
  validateBody(updateBodySchema),
  async (req, res, next) => {
    try {
      const { id } = req.params as unknown as z.infer<typeof channelParams>;
      const body = req.body as z.infer<typeof updateBodySchema>;
      const { before, after } = await updateCustomerChannel(cid(req), id, body);
      await recordAudit({
        companyId: cid(req),
        actorUserId: req.userId ?? null,
        action: "customer_channel.update",
        targetType: "customer_channel",
        targetId: after.id,
        targetLabel: after.name ? `#${after.name}` : after.externalChannelId,
        metadata: {
          fields: Object.keys(body),
          before: {
            customerId: before.customerId,
            employeeId: before.employeeId,
            replyMode: before.replyMode,
          },
          after: {
            customerId: after.customerId,
            employeeId: after.employeeId,
            replyMode: after.replyMode,
          },
          instructionsChanged: before.instructions !== after.instructions,
        },
      });
      const [dto] = await serializeCustomerChannels([after]);
      res.json(dto);
    } catch (err) {
      fail(res, next, err);
    }
  },
);

customerChannelsRouter.delete("/:id", validateParams(channelParams), async (req, res, next) => {
  try {
    const { id } = req.params as unknown as z.infer<typeof channelParams>;
    const removed = await unlinkCustomerChannel(cid(req), id);
    await recordAudit({
      companyId: cid(req),
      actorUserId: req.userId ?? null,
      action: "customer_channel.unlink",
      targetType: "customer_channel",
      targetId: removed.id,
      targetLabel: removed.name ? `#${removed.name}` : removed.externalChannelId,
      metadata: {
        provider: removed.provider,
        connectionId: removed.connectionId,
        customerId: removed.customerId,
      },
    });
    res.json({ ok: true });
  } catch (err) {
    fail(res, next, err);
  }
});

/**
 * Write notes now, for what the channel has said since the last ones, without
 * waiting for it to go quiet. The readiness rules still apply.
 */
customerChannelsRouter.post("/:id/notes", validateParams(channelParams), async (req, res, next) => {
  try {
    const { id } = req.params as unknown as z.infer<typeof channelParams>;
    await requireCustomerChannel(cid(req), id);
    const result = await writeCustomerChannelNotes(id, { force: true });
    const [dto] = await serializeCustomerChannels([await requireCustomerChannel(cid(req), id)]);
    res.json({ result, channel: dto });
  } catch (err) {
    fail(res, next, err);
  }
});
