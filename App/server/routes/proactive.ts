import { Router } from "express";
import { z } from "zod";
import {
  requireAuth,
  requireBrowserSession,
  requireCompanyMember,
  requireCompanyRoleForMutations,
} from "../middleware/auth.js";
import { validateBody, validateParams, validateQuery } from "../middleware/validate.js";
import {
  getProactiveOverview,
  installProactiveStarter,
  toggleProactiveStarter,
  ProactiveSetupError,
} from "../services/proactive/setup.js";
import { PlanLimitError } from "../services/entitlements.js";

export const proactiveRouter = Router({ mergeParams: true });
proactiveRouter.use(requireAuth, requireCompanyMember);
const companyParams = z.object({ cid: z.string().uuid() });
const setupSchema = z
  .object({
    recipeId: z.string().min(1).max(80),
    employeeId: z.string().uuid(),
    accountId: z.string().uuid().nullable().optional(),
    delivery: z.enum(["draft", "soul"]).default("draft"),
    instruction: z.string().trim().min(1).max(20_000),
  })
  .strict();

proactiveRouter.get(
  "/proactive",
  validateParams(companyParams),
  validateQuery(z.object({}).strict()),
  async (req, res) => {
    res.json(await getProactiveOverview((req.params as Record<string, string>).cid));
  },
);
proactiveRouter.post(
  "/proactive",
  requireBrowserSession,
  requireCompanyRoleForMutations("admin"),
  validateParams(companyParams),
  validateBody(setupSchema),
  async (req, res) => {
    try {
      res.json(
        await installProactiveStarter(
          (req.params as Record<string, string>).cid,
          req.userId!,
          req.body as z.infer<typeof setupSchema>,
        ),
      );
    } catch (error) {
      if (error instanceof ProactiveSetupError)
        return res.status(error.status).json({ error: error.message });
      if (error instanceof PlanLimitError) return res.status(402).json({ error: error.message });
      throw error;
    }
  },
);
proactiveRouter.patch(
  "/proactive/:id",
  requireBrowserSession,
  requireCompanyRoleForMutations("admin"),
  validateParams(companyParams.extend({ id: z.string().uuid() })),
  validateBody(z.object({ enabled: z.boolean() }).strict()),
  async (req, res) => {
    try {
      await toggleProactiveStarter(
        (req.params as Record<string, string>).cid,
        req.userId!,
        req.params.id as string,
        req.body.enabled,
      );
      res.json({ ok: true });
    } catch (error) {
      if (error instanceof ProactiveSetupError)
        return res.status(error.status).json({ error: error.message });
      throw error;
    }
  },
);
