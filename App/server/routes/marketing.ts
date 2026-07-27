import { type Request, type RequestHandler, type Response, Router } from "express";
import { z } from "zod";

import { MARKETING_ACCESS_LEVELS } from "../db/entities/EmployeeMarketingGrant.js";
import {
  MARKETING_AUTONOMY_MODES,
  MARKETING_CAMPAIGN_OBJECTIVES,
  MARKETING_CAMPAIGN_STATUSES,
  type MarketingCampaignStatus,
} from "../db/entities/MarketingCampaign.js";
import {
  MARKETING_CREATIVE_FORMATS,
  MARKETING_CREATIVE_STATUSES,
} from "../db/entities/MarketingCreative.js";
import { MARKETING_EXPERIMENT_STATUSES } from "../db/entities/MarketingExperiment.js";
import {
  onRoutePaths,
  requireAuth,
  requireCompanyMember,
  requireCompanyRoleForMutations,
} from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { recordAudit } from "../services/audit.js";
import {
  MarketingNotFoundError,
  MarketingValidationError,
  createMarketingCampaign,
  createMarketingCreative,
  createMarketingExperiment,
  deleteMarketingGrant,
  getMarketingCampaign,
  getMarketingOverview,
  listMarketingCampaigns,
  listMarketingCreatives,
  listMarketingExperiments,
  listMarketingGrants,
  recordMarketingPerformance,
  updateMarketingCampaign,
  updateMarketingCreative,
  updateMarketingExperiment,
  upsertMarketingGrant,
} from "../services/marketing.js";

export const marketingRouter = Router({ mergeParams: true });
marketingRouter.use(requireAuth);
marketingRouter.use(requireCompanyMember);
marketingRouter.use(
  onRoutePaths(["/marketing/ai-access"], requireCompanyRoleForMutations("admin")),
);

function cid(req: Request): string {
  return (req.params as Record<string, string>).cid;
}

function h(fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler {
  return (req, res, next) => {
    fn(req, res).catch((error: unknown) => {
      if (error instanceof MarketingValidationError) {
        res.status(400).json({ error: error.message });
        return;
      }
      if (error instanceof MarketingNotFoundError) {
        res.status(404).json({ error: error.message });
        return;
      }
      next(error);
    });
  };
}

function audit(
  req: Request,
  action: string,
  targetType: string,
  targetId: string,
  label: string,
) {
  return recordAudit({
    companyId: cid(req),
    actorUserId: req.userId ?? null,
    action,
    targetType,
    targetId,
    targetLabel: label,
  });
}

const nullableId = z.string().uuid().nullable();
const optionalDate = z.string().datetime().nullable().optional();

export const marketingCampaignInputSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    objective: z.enum(MARKETING_CAMPAIGN_OBJECTIVES as [string, ...string[]]),
    status: z.enum(MARKETING_CAMPAIGN_STATUSES as [string, ...string[]]).optional(),
    autonomyMode: z.enum(MARKETING_AUTONOMY_MODES as [string, ...string[]]).optional(),
    channel: z.string().trim().max(80).optional(),
    connectionId: nullableId.optional(),
    externalAccountId: z.string().trim().max(160).optional(),
    externalCampaignId: z.string().trim().max(160).optional(),
    ownerEmployeeId: nullableId.optional(),
    brief: z.string().trim().max(30_000).optional(),
    audience: z.string().trim().max(10_000).optional(),
    offer: z.string().trim().max(10_000).optional(),
    landingPageUrl: z.string().trim().url().or(z.literal("")).optional(),
    successMetric: z.string().trim().max(80).optional(),
    targetValue: z.string().trim().max(80).optional(),
    dailyBudgetMinor: z.number().int().min(0).max(2_147_483_647).optional(),
    currency: z.string().trim().regex(/^[A-Za-z]{3}$/).optional(),
    startsAt: optionalDate,
    endsAt: optionalDate,
  })
  .strict();

const marketingCampaignPatchSchema = marketingCampaignInputSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  { message: "At least one Campaign field is required" },
);

export const marketingCreativeInputSchema = z
  .object({
    campaignId: z.string().uuid(),
    name: z.string().trim().min(1).max(160),
    format: z.enum(MARKETING_CREATIVE_FORMATS as [string, ...string[]]).optional(),
    status: z.enum(MARKETING_CREATIVE_STATUSES as [string, ...string[]]).optional(),
    variantGroup: z.string().trim().max(120).optional(),
    concept: z.string().trim().max(10_000).optional(),
    headline: z.string().trim().max(1_000).optional(),
    body: z.string().trim().max(10_000).optional(),
    callToAction: z.string().trim().max(120).optional(),
    assetUrl: z.string().trim().url().or(z.literal("")).optional(),
    destinationUrl: z.string().trim().url().or(z.literal("")).optional(),
    externalCreativeId: z.string().trim().max(160).optional(),
    reviewNote: z.string().trim().max(10_000).optional(),
  })
  .strict();

const marketingCreativePatchSchema = marketingCreativeInputSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  { message: "At least one Creative field is required" },
);

export const marketingExperimentInputSchema = z
  .object({
    campaignId: z.string().uuid(),
    name: z.string().trim().min(1).max(160),
    hypothesis: z.string().trim().max(10_000).optional(),
    status: z.enum(MARKETING_EXPERIMENT_STATUSES as [string, ...string[]]).optional(),
    primaryMetric: z.string().trim().max(80).optional(),
    minimumSampleSize: z.string().trim().max(80).optional(),
    creativeIds: z.array(z.string().uuid()).min(2).max(20).optional(),
    winnerCreativeId: nullableId.optional(),
    decisionRationale: z.string().trim().max(10_000).optional(),
    startsAt: optionalDate,
    endsAt: optionalDate,
  })
  .strict();

const marketingExperimentPatchSchema = marketingExperimentInputSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  { message: "At least one Experiment field is required" },
);

export const marketingPerformanceInputSchema = z
  .object({
    campaignId: z.string().uuid(),
    periodStart: z.string().datetime(),
    periodEnd: z.string().datetime(),
    spendMinor: z.number().int().min(0).max(2_147_483_647),
    impressions: z.number().int().min(0).max(2_147_483_647).optional(),
    clicks: z.number().int().min(0).max(2_147_483_647).optional(),
    conversions: z.string().trim().regex(/^\d+(\.\d+)?$/).optional(),
    conversionValue: z.string().trim().regex(/^\d+(\.\d+)?$/).optional(),
    currency: z.string().trim().regex(/^[A-Za-z]{3}$/),
    source: z.string().trim().min(1).max(120),
    raw: z.record(z.unknown()).optional(),
  })
  .strict();

marketingRouter.get(
  "/marketing/overview",
  h(async (req, res) => {
    res.json(await getMarketingOverview(cid(req)));
  }),
);

marketingRouter.get(
  "/marketing/campaigns",
  h(async (req, res) => {
    const parsed = z
      .object({
        status: z.enum(MARKETING_CAMPAIGN_STATUSES as [string, ...string[]]).optional(),
        ownerEmployeeId: z.string().uuid().optional(),
        channel: z.string().trim().max(80).optional(),
        includeArchived: z.enum(["true", "false"]).optional(),
      })
      .safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid Campaign filters" });
      return;
    }
    res.json({
      rows: await listMarketingCampaigns(cid(req), {
        ...parsed.data,
        status: parsed.data.status as MarketingCampaignStatus | undefined,
        includeArchived: parsed.data.includeArchived === "true",
      }),
    });
  }),
);

marketingRouter.post(
  "/marketing/campaigns",
  validateBody(marketingCampaignInputSchema),
  h(async (req, res) => {
    const row = await createMarketingCampaign(cid(req), req.body, {
      userId: req.userId ?? null,
    });
    await audit(req, "marketing.campaign.create", "marketing_campaign", row.id, row.name);
    res.status(201).json(row);
  }),
);

marketingRouter.get(
  "/marketing/campaigns/:campaignId",
  h(async (req, res) => {
    res.json(await getMarketingCampaign(cid(req), req.params.campaignId));
  }),
);

marketingRouter.patch(
  "/marketing/campaigns/:campaignId",
  validateBody(marketingCampaignPatchSchema),
  h(async (req, res) => {
    const row = await updateMarketingCampaign(cid(req), req.params.campaignId, req.body);
    await audit(req, "marketing.campaign.update", "marketing_campaign", row.id, row.name);
    res.json(row);
  }),
);

marketingRouter.get(
  "/marketing/creatives",
  h(async (req, res) => {
    const campaignId =
      typeof req.query.campaignId === "string" ? req.query.campaignId : undefined;
    if (campaignId && !z.string().uuid().safeParse(campaignId).success) {
      res.status(400).json({ error: "Invalid Campaign id" });
      return;
    }
    res.json({ rows: await listMarketingCreatives(cid(req), campaignId) });
  }),
);

marketingRouter.post(
  "/marketing/creatives",
  validateBody(marketingCreativeInputSchema),
  h(async (req, res) => {
    const row = await createMarketingCreative(cid(req), req.body, {
      userId: req.userId ?? null,
    });
    await audit(req, "marketing.creative.create", "marketing_creative", row.id, row.name);
    res.status(201).json(row);
  }),
);

marketingRouter.patch(
  "/marketing/creatives/:creativeId",
  validateBody(marketingCreativePatchSchema),
  h(async (req, res) => {
    const row = await updateMarketingCreative(cid(req), req.params.creativeId, req.body);
    await audit(req, "marketing.creative.update", "marketing_creative", row.id, row.name);
    res.json(row);
  }),
);

marketingRouter.get(
  "/marketing/experiments",
  h(async (req, res) => {
    const campaignId =
      typeof req.query.campaignId === "string" ? req.query.campaignId : undefined;
    if (campaignId && !z.string().uuid().safeParse(campaignId).success) {
      res.status(400).json({ error: "Invalid Campaign id" });
      return;
    }
    res.json({ rows: await listMarketingExperiments(cid(req), campaignId) });
  }),
);

marketingRouter.post(
  "/marketing/experiments",
  validateBody(marketingExperimentInputSchema),
  h(async (req, res) => {
    const row = await createMarketingExperiment(cid(req), req.body, {
      userId: req.userId ?? null,
    });
    await audit(req, "marketing.experiment.create", "marketing_experiment", row.id, row.name);
    res.status(201).json(row);
  }),
);

marketingRouter.patch(
  "/marketing/experiments/:experimentId",
  validateBody(marketingExperimentPatchSchema),
  h(async (req, res) => {
    const row = await updateMarketingExperiment(cid(req), req.params.experimentId, req.body);
    await audit(req, "marketing.experiment.update", "marketing_experiment", row.id, row.name);
    res.json(row);
  }),
);

marketingRouter.post(
  "/marketing/performance",
  validateBody(marketingPerformanceInputSchema),
  h(async (req, res) => {
    const row = await recordMarketingPerformance(cid(req), req.body, {
      userId: req.userId ?? null,
    });
    await audit(
      req,
      "marketing.performance.record",
      "marketing_performance_snapshot",
      row.id,
      row.source,
    );
    res.status(201).json(row);
  }),
);

marketingRouter.get(
  "/marketing/ai-access",
  h(async (req, res) => {
    res.json({ rows: await listMarketingGrants(cid(req)) });
  }),
);

marketingRouter.put(
  "/marketing/ai-access/:employeeId",
  validateBody(
    z
      .object({
        accessLevel: z.enum(MARKETING_ACCESS_LEVELS as [string, ...string[]]),
      })
      .strict(),
  ),
  h(async (req, res) => {
    const row = await upsertMarketingGrant(cid(req), req.params.employeeId, req.body.accessLevel);
    await audit(req, "marketing.grant.upsert", "employee_marketing_grant", row.id, row.employeeId);
    res.json(row);
  }),
);

marketingRouter.delete(
  "/marketing/ai-access/:grantId",
  h(async (req, res) => {
    const deleted = await deleteMarketingGrant(cid(req), req.params.grantId);
    if (!deleted) {
      res.status(404).json({ error: "Marketing Grant not found" });
      return;
    }
    await audit(
      req,
      "marketing.grant.delete",
      "employee_marketing_grant",
      req.params.grantId,
      "",
    );
    res.status(204).end();
  }),
);
