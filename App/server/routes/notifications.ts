import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireCompanyMember } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import {
  clearReadForUser,
  countUnreadForUser,
  listForUser,
  markAllRead,
  markRead,
} from "../services/notifications.js";

/**
 * Per-user notification feed for a company. The bell + panel in the top
 * bar reads from these endpoints; live deltas come over the existing WS
 * channel as `notification.new` / `notification.read` events.
 */
export const notificationsRouter = Router({ mergeParams: true });
notificationsRouter.use(requireAuth);
notificationsRouter.use(requireCompanyMember);

notificationsRouter.get("/notifications", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const limit = Math.min(
    100,
    Math.max(1, Number((req.query.limit as string | undefined) ?? 30)),
  );
  const before =
    typeof req.query.before === "string" && req.query.before
      ? req.query.before
      : undefined;
  const rows = await listForUser({
    companyId: cid,
    userId: req.userId!,
    limit,
    before,
  });
  res.json({ notifications: rows });
});

notificationsRouter.get("/notifications/unread-count", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const count = await countUnreadForUser({
    companyId: cid,
    userId: req.userId!,
  });
  res.json({ count });
});

const markReadSchema = z.object({
  notificationId: z.string().uuid(),
});

notificationsRouter.post(
  "/notifications/mark-read",
  validateBody(markReadSchema),
  async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const body = req.body as z.infer<typeof markReadSchema>;
    await markRead({
      id: body.notificationId,
      companyId: cid,
      userId: req.userId!,
    });
    res.json({ ok: true });
  },
);

notificationsRouter.post("/notifications/mark-all-read", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  await markAllRead({ companyId: cid, userId: req.userId! });
  res.json({ ok: true });
});

notificationsRouter.post("/notifications/clear-read", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const cleared = await clearReadForUser({
    companyId: cid,
    userId: req.userId!,
  });
  res.json({ cleared });
});
