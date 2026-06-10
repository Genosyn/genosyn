import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import {
  getVapidPublicKey,
  listSubscriptionsForUser,
  removeSubscription,
  saveSubscription,
} from "../services/push.js";

/**
 * Web Push subscription management for the PWA. User-scoped (not company-
 * scoped): a device belongs to the person, and pushes are fanned out per
 * Notification row regardless of which company tab is open.
 */
export const pushRouter = Router();
pushRouter.use(requireAuth);

pushRouter.get("/vapid-public-key", async (_req, res) => {
  res.json({ key: await getVapidPublicKey() });
});

pushRouter.get("/subscriptions", async (req, res) => {
  const rows = await listSubscriptionsForUser(req.userId!);
  res.json(
    rows.map((r) => ({
      id: r.id,
      endpoint: r.endpoint,
      userAgent: r.userAgent,
      createdAt: r.createdAt.toISOString(),
    })),
  );
});

const subscribeSchema = z.object({
  endpoint: z.string().url().max(1024),
  keys: z.object({
    p256dh: z.string().min(1).max(512),
    auth: z.string().min(1).max(512),
  }),
});

pushRouter.post(
  "/subscriptions",
  validateBody(subscribeSchema),
  async (req, res) => {
    const body = req.body as z.infer<typeof subscribeSchema>;
    await saveSubscription({
      userId: req.userId!,
      endpoint: body.endpoint,
      p256dh: body.keys.p256dh,
      auth: body.keys.auth,
      userAgent: (req.headers["user-agent"] ?? "").slice(0, 255),
    });
    res.json({ ok: true });
  },
);

const unsubscribeSchema = z.object({
  endpoint: z.string().url().max(1024),
});

pushRouter.post(
  "/subscriptions/remove",
  validateBody(unsubscribeSchema),
  async (req, res) => {
    const body = req.body as z.infer<typeof unsubscribeSchema>;
    const removed = await removeSubscription({
      userId: req.userId!,
      endpoint: body.endpoint,
    });
    res.json({ ok: true, removed });
  },
);
