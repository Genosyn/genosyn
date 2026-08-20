import { type Request, type RequestHandler, type Response, Router } from "express";
import { z } from "zod";

import { TLDR_CADENCES } from "../db/entities/TldrSettings.js";
import {
  onRoutePaths,
  requireAuth,
  requireCompanyMember,
  requireCompanyRoleForMutations,
} from "../middleware/auth.js";
import { validateBody, validateParams } from "../middleware/validate.js";
import { recordAudit } from "../services/audit.js";
import {
  dismissTldr,
  generateTldrNow,
  getTldrSettings,
  listTldrs,
  serializeTldr,
  updateTldrSettings,
} from "../services/tldrs.js";

export const tldrsRouter = Router({ mergeParams: true });
tldrsRouter.use(requireAuth);
tldrsRouter.use(requireCompanyMember);
tldrsRouter.use(
  onRoutePaths(["/tldrs/settings", "/tldrs/generate"], requireCompanyRoleForMutations("admin")),
);

function cid(req: Request): string {
  return (req.params as Record<string, string>).cid;
}

function h(fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler {
  return (req, res, next) => {
    fn(req, res).catch((error: unknown) => {
      const status =
        error && typeof error === "object" && "status" in error
          ? Number((error as { status: unknown }).status)
          : 0;
      if (status >= 400 && status < 600) {
        res.status(status).json({
          error: error instanceof Error ? error.message : "TLDR request failed.",
        });
        return;
      }
      next(error);
    });
  };
}

const listQuerySchema = z
  .object({
    before: z.string().datetime().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(30),
  })
  .strict();

const settingsBodySchema = z
  .object({
    enabled: z.boolean(),
    cadence: z.enum(TLDR_CADENCES),
    employeeId: z.string().uuid().nullable(),
  })
  .strict();

const tldrParamsSchema = z.object({ cid: z.string().uuid(), id: z.string().uuid() }).strict();

const emptyBodySchema = z.object({}).strict().default({});

tldrsRouter.get(
  "/tldrs",
  h(async (req, res) => {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "ValidationError", issues: parsed.error.issues });
      return;
    }
    res.json(
      await listTldrs({
        companyId: cid(req),
        userId: req.userId!,
        limit: parsed.data.limit,
        before: parsed.data.before ? new Date(parsed.data.before) : undefined,
      }),
    );
  }),
);

tldrsRouter.get(
  "/tldrs/settings",
  h(async (req, res) => {
    res.json(await getTldrSettings(cid(req)));
  }),
);

tldrsRouter.put(
  "/tldrs/settings",
  validateBody(settingsBodySchema),
  h(async (req, res) => {
    const body = req.body as z.infer<typeof settingsBodySchema>;
    const settings = await updateTldrSettings(cid(req), body);
    await recordAudit({
      companyId: cid(req),
      actorUserId: req.userId ?? null,
      action: "tldr.settings.update",
      targetType: "tldr_settings",
      targetId: settings.id,
      targetLabel: "TLDR settings",
      metadata: {
        enabled: settings.enabled,
        cadence: settings.cadence,
        employeeId: settings.employeeId,
      },
    });
    res.json(settings);
  }),
);

tldrsRouter.post(
  "/tldrs/generate",
  validateBody(emptyBodySchema),
  h(async (req, res) => {
    const tldr = await generateTldrNow(cid(req));
    await recordAudit({
      companyId: cid(req),
      actorUserId: req.userId ?? null,
      action: "tldr.generate.manual",
      targetType: "tldr",
      targetId: tldr?.id ?? null,
      targetLabel: tldr?.title ?? "Empty TLDR window",
      metadata: tldr
        ? { sourceStats: JSON.parse(tldr.sourceStatsJson) as unknown }
        : { empty: true },
    });
    if (!tldr) {
      res.json({ status: "empty" });
      return;
    }
    res.json({ status: "created", tldr: serializeTldr(tldr, false) });
  }),
);

tldrsRouter.post(
  "/tldrs/:id/dismiss",
  validateParams(tldrParamsSchema),
  validateBody(emptyBodySchema),
  h(async (req, res) => {
    const result = await dismissTldr({
      companyId: cid(req),
      tldrId: req.params.id,
      userId: req.userId!,
    });
    if (result.created) {
      await recordAudit({
        companyId: cid(req),
        actorUserId: req.userId ?? null,
        action: "tldr.dismiss",
        targetType: "tldr",
        targetId: result.tldr.id,
        targetLabel: result.tldr.title,
      });
    }
    res.json(serializeTldr(result.tldr, true));
  }),
);
