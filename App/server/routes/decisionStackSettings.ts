import { Router, type NextFunction, type Response } from "express";
import { z } from "zod";

import { MAX_DECISION_STACK_INSTRUCTIONS_LENGTH } from "../../shared/decisionStackInstructions.js";
import {
  onRoutePaths,
  requireAuth,
  requireCompanyMember,
  requireCompanyRoleForMutations,
} from "../middleware/auth.js";
import { validateBody, validateParams } from "../middleware/validate.js";
import {
  DecisionStackSettingsError,
  readDecisionStackSettings,
  updateDecisionStackSettings,
} from "../services/decisionStackSettings.js";

/**
 * Decision stack → Settings: the company-wide switch for new Decisions and the
 * instructions every new Decision is checked against.
 *
 * Reads are member-level — every Member can see whether the stack takes new
 * questions and what it is told, the same way they can see the stack itself.
 * Changes are owner/admin-only (the gate here, and again in the service),
 * like Decision routing: they decide which questions ever reach a person.
 * The logic lives in `services/decisionStackSettings.ts`.
 */
export const decisionStackSettingsRouter = Router({ mergeParams: true });
decisionStackSettingsRouter.use(requireAuth);
decisionStackSettingsRouter.use(requireCompanyMember);
decisionStackSettingsRouter.use(
  onRoutePaths(["/decision-stack/settings"], requireCompanyRoleForMutations("admin")),
);

const companyParamsSchema = z.object({ cid: z.string().uuid() }).strict();

/**
 * Generous on purpose: the precise limits (characters on the stored text,
 * instructions per box, printable characters) are the shared rules'
 * (`shared/decisionStackInstructions.ts`), and the service answers them in a
 * sentence the box shows. This bound only stops an absurd body at the door.
 */
const settingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    instructions: z
      .string()
      .max(MAX_DECISION_STACK_INSTRUCTIONS_LENGTH * 4)
      .nullable()
      .optional(),
  })
  .strict()
  .refine((body) => body.enabled !== undefined || body.instructions !== undefined, {
    message: "Change the switch or the instructions.",
  });

function sendError(res: Response, next: NextFunction, error: unknown) {
  if (error instanceof DecisionStackSettingsError) {
    return res.status(error.status).json({ error: error.message });
  }
  return next(error);
}

decisionStackSettingsRouter.get(
  "/decision-stack/settings",
  validateParams(companyParamsSchema),
  async (req, res, next) => {
    try {
      return res.json(await readDecisionStackSettings(req.params.cid, req.companyRole));
    } catch (error) {
      return sendError(res, next, error);
    }
  },
);

decisionStackSettingsRouter.patch(
  "/decision-stack/settings",
  validateParams(companyParamsSchema),
  validateBody(settingsSchema),
  async (req, res, next) => {
    try {
      return res.json(
        await updateDecisionStackSettings({
          companyId: req.params.cid,
          actorUserId: req.userId ?? null,
          actorRole: req.companyRole,
          input: req.body as z.infer<typeof settingsSchema>,
        }),
      );
    } catch (error) {
      return sendError(res, next, error);
    }
  },
);
