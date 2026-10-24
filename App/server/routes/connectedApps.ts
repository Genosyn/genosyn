import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import {
  onRoutePaths,
  requireAuth,
  requireBrowserSession,
  requireCompanyMember,
} from "../middleware/auth.js";
import { validateParams } from "../middleware/validate.js";
import { disconnectConnectedApp, listConnectedApps } from "../services/mcpOauth/connectedApps.js";

/**
 * The apps a Member connected to this company through OAuth — claude.ai,
 * ChatGPT — listed and disconnected at Settings → API keys. Personal like API
 * keys: each Member sees and disconnects only their own, and only from a
 * signed-in browser, so a key or an app cannot quietly remove the record of
 * another credential.
 */
export const connectedAppsRouter = Router({ mergeParams: true });
connectedAppsRouter.use(requireAuth);
connectedAppsRouter.use(requireCompanyMember);
connectedAppsRouter.use(onRoutePaths(["/connected-apps"], requireBrowserSession));

const cidParams = z.object({ cid: z.string().uuid() });
const appParams = cidParams.extend({ id: z.string().uuid() });

connectedAppsRouter.get(
  "/connected-apps",
  validateParams(cidParams),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(await listConnectedApps(req.params.cid, req.userId!));
    } catch (error) {
      next(error);
    }
  },
);

connectedAppsRouter.delete(
  "/connected-apps/:id",
  validateParams(appParams),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const app = await disconnectConnectedApp(req.params.cid, req.userId!, req.params.id);
      if (!app) return res.status(404).json({ error: "Not found" });
      res.json(app);
    } catch (error) {
      next(error);
    }
  },
);
