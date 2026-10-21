import fs from "node:fs";

import type { NextFunction, Request, RequestHandler, Response } from "express";
import { Router } from "express";
import multer from "multer";
import { z } from "zod";

import {
  COMPENSATION_PERIODS,
  EMPLOYMENT_TYPES,
  OPENING_STATUSES,
  OPENING_VISIBILITIES,
  RECRUITING_ACCESS_LEVELS,
  RECRUITING_STAGES,
  RESUME_MAX_BYTES,
  SITE_VISIBILITIES,
  WORKPLACE_TYPES,
} from "../../shared/recruiting.js";
import { AppDataSource } from "../db/datasource.js";
import { Company } from "../db/entities/Company.js";
import {
  onRoutePaths,
  requireAuth,
  requireCompanyMember,
  requireCompanyRole,
  requireCompanyRoleForMutations,
} from "../middleware/auth.js";
import { validateBody, validateParams, validateQuery } from "../middleware/validate.js";
import { recordAudit } from "../services/audit.js";
import {
  ApplicationFieldError,
  addApplication,
  afterApplicationReceived,
  addApplicationNote,
  addMemberScorecard,
  deleteApplication,
  getApplicationDetail,
  listApplications,
  type ApplicationListFilters,
  loadApplication,
  moveApplication,
  requestScreen,
} from "../services/recruiting/applications.js";
import { criteriaInputSchema, formInputSchema, questionsInputSchema } from "../services/recruiting/content.js";
import { setCustomDomain, verifyCustomDomain } from "../services/recruiting/domains.js";
import {
  RecruitingNotFoundError,
  RecruitingValidationError,
  recruitingErrorStatus,
} from "../services/recruiting/errors.js";
import { LOGO_MAX_BYTES, resumeAbsPath } from "../services/recruiting/files.js";
import {
  deleteRecruitingGrant,
  listRecruitingGrants,
  upsertRecruitingGrant,
} from "../services/recruiting/grants.js";
import {
  closeOpening,
  createOpening,
  deleteOpening,
  listOpenings,
  loadOpening,
  openingDto,
  publishOpening,
  updateOpening,
} from "../services/recruiting/openings.js";
import { recruitingOverview } from "../services/recruiting/overview.js";
import { scorecardInputSchema } from "../services/recruiting/scorecards.js";
import { suggestCriteria } from "../services/recruiting/screening.js";
import {
  ensureRecruitingSettings,
  recruitingSettingsDto,
  removeSiteLogo,
  setSiteLogo,
  updateRecruitingSettings,
} from "../services/recruiting/settings.js";

/**
 * Recruiting for Members, at `/api/companies/:cid/recruiting/...`.
 *
 * Any Member may post and edit Openings and work Applications — hiring is
 * everyone's business in a small company, and every move is on the
 * Application's timeline and in the audit log. The company-wide controls —
 * the careers site and its domain, the screener and its instructions, the
 * applicant emails, and which AI Employees may do what — are for owners and
 * admins, and so is erasing an Application.
 */
export const recruitingRouter = Router({ mergeParams: true });
recruitingRouter.use(requireAuth);
recruitingRouter.use(requireCompanyMember);
recruitingRouter.use(
  onRoutePaths(["/recruiting/settings", "/recruiting/ai-access"], requireCompanyRoleForMutations("admin")),
);

/** RFC 8187's encoding for `filename*`, which also escapes what encodeURIComponent leaves. */
function rfc8187(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function cid(req: Request): string {
  return (req.params as Record<string, string>).cid;
}

function route(handler: (req: Request, res: Response) => Promise<unknown>): RequestHandler {
  return (req, res, next: NextFunction) => {
    void handler(req, res).catch((error: unknown) => {
      if (error instanceof ApplicationFieldError) {
        res.status(400).json({ error: error.message, fields: error.fields });
        return;
      }
      const status = recruitingErrorStatus(error);
      if (status) {
        res.status(status).json({ error: (error as Error).message });
        return;
      }
      next(error);
    });
  };
}

async function company(req: Request): Promise<Company> {
  const row = await AppDataSource.getRepository(Company).findOneBy({ id: cid(req) });
  if (!row) throw new RecruitingNotFoundError("Company not found");
  return row;
}

function audit(
  req: Request,
  action: string,
  targetType: string,
  targetId: string | null,
  targetLabel: string,
  metadata?: Record<string, unknown>,
) {
  return recordAudit({
    companyId: cid(req),
    actorUserId: req.userId ?? null,
    action,
    targetType,
    targetId,
    targetLabel,
    metadata,
  });
}

function member(req: Request) {
  return { kind: "member" as const, userId: req.userId!, name: req.user?.name || req.user?.email || undefined };
}

const companyParams = z.object({ cid: z.string().uuid() }).strict();
const openingParams = companyParams.extend({ openingId: z.string().uuid() }).strict();
const applicationParams = companyParams.extend({ applicationId: z.string().uuid() }).strict();

// ── Overview ───────────────────────────────────────────────────────────────

recruitingRouter.get(
  "/recruiting/overview",
  validateParams(companyParams),
  route(async (req, res) => {
    res.json(await recruitingOverview(await company(req)));
  }),
);

// ── Settings and the careers site ───────────────────────────────────────────

const nullableTemplate = (max: number) => z.string().max(max).nullable().optional();

const settingsPatchSchema = z
  .object({
    siteEnabled: z.boolean().optional(),
    siteVisibility: z.enum(SITE_VISIBILITIES).optional(),
    siteTitle: z.string().max(120).optional(),
    siteHeadline: z.string().max(200).optional(),
    siteIntro: z.string().max(10_000).optional(),
    websiteUrl: z.string().max(500).optional(),
    privacyPolicyUrl: z.string().max(500).optional(),
    accentColor: z.string().max(20).optional(),
    allowIndexing: z.boolean().optional(),
    screenerEmployeeId: z.string().uuid().nullable().optional(),
    autoScreen: z.boolean().optional(),
    screeningInstructions: z.string().max(8_000).nullable().optional(),
    confirmationEmailEnabled: z.boolean().optional(),
    confirmationEmailSubject: nullableTemplate(400),
    confirmationEmailBody: nullableTemplate(10_000),
    rejectionEmailSubject: nullableTemplate(400),
    rejectionEmailBody: nullableTemplate(10_000),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: "At least one change is required" });

recruitingRouter.get(
  "/recruiting/settings",
  validateParams(companyParams),
  route(async (req, res) => {
    const row = await company(req);
    res.json(await recruitingSettingsDto(row, await ensureRecruitingSettings(row.id)));
  }),
);

recruitingRouter.patch(
  "/recruiting/settings",
  validateParams(companyParams),
  validateBody(settingsPatchSchema),
  route(async (req, res) => {
    const row = await company(req);
    const patch = req.body as z.infer<typeof settingsPatchSchema>;
    const settings = await updateRecruitingSettings(row.id, patch);
    await audit(req, "recruiting.settings.update", "recruiting_settings", settings.id, "Recruiting settings", {
      fields: Object.keys(patch),
    });
    res.json(await recruitingSettingsDto(row, settings));
  }),
);

const logoUpload = multer({
  storage: multer.memoryStorage(),
  defParamCharset: "utf8",
  limits: { fileSize: LOGO_MAX_BYTES, files: 1 },
}).single("file");

recruitingRouter.post(
  "/recruiting/settings/logo",
  validateParams(companyParams),
  (req, res, next) =>
    logoUpload(req, res, (error: unknown) => {
      if (!error) return next();
      res.status(error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({
        error: "Upload the logo as a PNG, JPEG, GIF or WebP image under 2 MB.",
      });
    }),
  route(async (req, res) => {
    if (!req.file) throw new RecruitingValidationError("Choose an image to upload.");
    const row = await company(req);
    const settings = await setSiteLogo(row.id, req.file.buffer);
    await audit(req, "recruiting.logo.upload", "recruiting_settings", settings.id, "Careers site logo");
    res.json(await recruitingSettingsDto(row, settings));
  }),
);

recruitingRouter.delete(
  "/recruiting/settings/logo",
  validateParams(companyParams),
  route(async (req, res) => {
    const row = await company(req);
    const settings = await removeSiteLogo(row.id);
    await audit(req, "recruiting.logo.remove", "recruiting_settings", settings.id, "Careers site logo");
    res.json(await recruitingSettingsDto(row, settings));
  }),
);

recruitingRouter.put(
  "/recruiting/settings/domain",
  validateParams(companyParams),
  validateBody(z.object({ domain: z.string().max(300).nullable() }).strict()),
  route(async (req, res) => {
    const row = await company(req);
    const settings = await setCustomDomain(await ensureRecruitingSettings(row.id), req.body.domain);
    await audit(req, "recruiting.domain.update", "recruiting_settings", settings.id, settings.customDomain ?? "None", {
      domain: settings.customDomain,
    });
    res.json(await recruitingSettingsDto(row, settings));
  }),
);

recruitingRouter.post(
  "/recruiting/settings/domain/verify",
  validateParams(companyParams),
  validateBody(z.object({}).strict().default({})),
  route(async (req, res) => {
    const row = await company(req);
    const { settings, check } = await verifyCustomDomain(await ensureRecruitingSettings(row.id));
    if (check.verified) {
      await audit(req, "recruiting.domain.verify", "recruiting_settings", settings.id, settings.customDomain ?? "");
    }
    res.json({ settings: await recruitingSettingsDto(row, settings), check });
  }),
);

// ── Openings ───────────────────────────────────────────────────────────────

const compensationSchema = z
  .object({
    min: z.number().nonnegative().max(1_000_000_000).nullable(),
    max: z.number().nonnegative().max(1_000_000_000).nullable(),
    currency: z.string().trim().regex(/^[A-Za-z]{3}$/),
    period: z.enum(COMPENSATION_PERIODS),
  })
  .strict();

export const openingInputSchema = z
  .object({
    title: z.string().trim().min(1).max(160),
    summary: z.string().max(500).optional(),
    description: z.string().max(30_000).optional(),
    department: z.string().max(120).optional(),
    location: z.string().max(160).optional(),
    workplace: z.enum(WORKPLACE_TYPES).optional(),
    employmentType: z.enum(EMPLOYMENT_TYPES).optional(),
    visibility: z.enum(OPENING_VISIBILITIES).optional(),
    compensation: compensationSchema.nullable().optional(),
    headcount: z.number().int().min(1).max(1000).optional(),
    applyBy: z.string().datetime().nullable().optional(),
    screenerEmployeeId: z.string().uuid().nullable().optional(),
    ownerUserId: z.string().uuid().nullable().optional(),
    criteria: criteriaInputSchema.optional(),
    questions: questionsInputSchema.optional(),
    form: formInputSchema.optional(),
  })
  .strict();

const openingListQuerySchema = z
  .object({ status: z.enum(OPENING_STATUSES).optional(), q: z.string().max(200).optional() })
  .strict();

const openingPatchSchema = openingInputSchema
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: "At least one change is required" });

recruitingRouter.get(
  "/recruiting/openings",
  validateParams(companyParams),
  validateQuery(openingListQuerySchema),
  route(async (req, res) => {
    res.json({
      rows: await listOpenings(await company(req), req.query as z.infer<typeof openingListQuerySchema>),
    });
  }),
);

recruitingRouter.post(
  "/recruiting/openings",
  validateParams(companyParams),
  validateBody(openingInputSchema),
  route(async (req, res) => {
    const row = await company(req);
    const opening = await createOpening(row.id, req.body, member(req));
    await audit(req, "recruiting.opening.create", "recruiting_opening", opening.id, opening.title);
    res.status(201).json(await openingDto(row, opening));
  }),
);

recruitingRouter.get(
  "/recruiting/openings/:openingId",
  validateParams(openingParams),
  route(async (req, res) => {
    const row = await company(req);
    res.json(await openingDto(row, await loadOpening(row.id, req.params.openingId)));
  }),
);

recruitingRouter.patch(
  "/recruiting/openings/:openingId",
  validateParams(openingParams),
  validateBody(openingPatchSchema),
  route(async (req, res) => {
    const row = await company(req);
    const opening = await updateOpening(row.id, req.params.openingId, req.body, member(req));
    await audit(req, "recruiting.opening.update", "recruiting_opening", opening.id, opening.title, {
      fields: Object.keys(req.body),
    });
    res.json(await openingDto(row, opening));
  }),
);

recruitingRouter.delete(
  "/recruiting/openings/:openingId",
  validateParams(openingParams),
  route(async (req, res) => {
    const row = await company(req);
    const opening = await deleteOpening(row.id, req.params.openingId);
    await audit(req, "recruiting.opening.delete", "recruiting_opening", opening.id, opening.title);
    res.status(204).end();
  }),
);

recruitingRouter.post(
  "/recruiting/openings/:openingId/publish",
  validateParams(openingParams),
  validateBody(z.object({}).strict().default({})),
  route(async (req, res) => {
    const row = await company(req);
    const opening = await publishOpening(row.id, req.params.openingId);
    await audit(req, "recruiting.opening.publish", "recruiting_opening", opening.id, opening.title);
    res.json(await openingDto(row, opening));
  }),
);

recruitingRouter.post(
  "/recruiting/openings/:openingId/close",
  validateParams(openingParams),
  validateBody(z.object({}).strict().default({})),
  route(async (req, res) => {
    const row = await company(req);
    const opening = await closeOpening(row.id, req.params.openingId);
    await audit(req, "recruiting.opening.close", "recruiting_opening", opening.id, opening.title);
    res.json(await openingDto(row, opening));
  }),
);

recruitingRouter.post(
  "/recruiting/openings/:openingId/suggest-criteria",
  validateParams(openingParams),
  validateBody(z.object({ employeeId: z.string().uuid() }).strict()),
  route(async (req, res) => {
    res.json({
      criteria: await suggestCriteria({
        companyId: cid(req),
        openingId: req.params.openingId,
        employeeId: req.body.employeeId,
      }),
    });
  }),
);

const resumeUpload = multer({
  storage: multer.memoryStorage(),
  // File names arrive as UTF-8; multer would read "Zoë" as Latin-1.
  defParamCharset: "utf8",
  limits: { fileSize: RESUME_MAX_BYTES, files: 1, fields: 30, fieldSize: 64 * 1024 },
}).single("resume");

const manualApplicationSchema = z
  .object({
    name: z.string().max(400),
    email: z.string().max(400),
    phone: z.string().max(100).optional(),
    location: z.string().max(400).optional(),
    linkedinUrl: z.string().max(1_000).optional(),
    websiteUrl: z.string().max(1_000).optional(),
    coverLetter: z.string().max(20_000).optional(),
    resumeText: z.string().max(60_000).optional(),
    sourceDetail: z.string().max(500).optional(),
  })
  .strict();

recruitingRouter.post(
  "/recruiting/openings/:openingId/applications",
  validateParams(openingParams),
  (req, res, next) =>
    resumeUpload(req, res, (error: unknown) => {
      if (!error) return next();
      res.status(error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({
        error: "Attach the resume as one file under 10 MB.",
      });
    }),
  route(async (req, res) => {
    const parsed = manualApplicationSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "ValidationError", issues: parsed.error.issues });
      return;
    }
    const { sourceDetail, resumeText, ...input } = parsed.data;
    const application = await addApplication({
      companyId: cid(req),
      openingId: req.params.openingId,
      input,
      file: req.file ? { buffer: req.file.buffer, originalname: req.file.originalname } : null,
      resumeText,
      source: "manual",
      sourceDetail,
      actor: member(req),
    });
    await audit(req, "recruiting.application.add", "recruiting_application", application.id, application.candidateName);
    void afterApplicationReceived(application.id, { confirm: false });
    res.status(201).json(await getApplicationDetail(cid(req), application.id));
  }),
);

// ── Applications ───────────────────────────────────────────────────────────

const listQuerySchema = z
  .object({
    openingId: z.string().uuid().optional(),
    stage: z.enum([...RECRUITING_STAGES, "active"] as [string, ...string[]]).optional(),
    q: z.string().max(200).optional(),
    sort: z.enum(["newest", "oldest", "score"]).optional(),
    screenStatus: z.enum(["none", "queued", "running", "scored", "failed"]).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    offset: z.coerce.number().int().min(0).max(100_000).optional(),
  })
  .strict();

recruitingRouter.get(
  "/recruiting/applications",
  validateParams(companyParams),
  validateQuery(listQuerySchema),
  route(async (req, res) => {
    res.json(await listApplications(cid(req), req.query as ApplicationListFilters));
  }),
);

recruitingRouter.get(
  "/recruiting/applications/:applicationId",
  validateParams(applicationParams),
  route(async (req, res) => {
    res.json(await getApplicationDetail(cid(req), req.params.applicationId));
  }),
);

recruitingRouter.post(
  "/recruiting/applications/:applicationId/move",
  validateParams(applicationParams),
  validateBody(
    z
      .object({
        stage: z.enum(RECRUITING_STAGES),
        reason: z.string().max(2_000).optional(),
        notifyCandidate: z.boolean().optional(),
      })
      .strict(),
  ),
  route(async (req, res) => {
    const row = await company(req);
    const result = await moveApplication({
      company: row,
      applicationId: req.params.applicationId,
      toStage: req.body.stage,
      reason: req.body.reason,
      notifyCandidate: req.body.notifyCandidate,
      actor: member(req),
      triggeredByUserId: req.userId ?? null,
    });
    if (result.changed) {
      await audit(req, "recruiting.application.move", "recruiting_application", result.application.id, result.application.candidateName, {
        stage: req.body.stage,
        emailed: result.email?.status ?? null,
      });
    }
    res.json({
      application: await getApplicationDetail(row.id, result.application.id),
      email: result.email ? { status: result.email.status, error: result.email.errorMessage } : null,
    });
  }),
);

recruitingRouter.post(
  "/recruiting/applications/:applicationId/notes",
  validateParams(applicationParams),
  validateBody(z.object({ body: z.string().min(1).max(5_000) }).strict()),
  route(async (req, res) => {
    await addApplicationNote({
      companyId: cid(req),
      applicationId: req.params.applicationId,
      body: req.body.body,
      actor: member(req),
    });
    res.status(201).json(await getApplicationDetail(cid(req), req.params.applicationId));
  }),
);

recruitingRouter.post(
  "/recruiting/applications/:applicationId/scorecards",
  validateParams(applicationParams),
  validateBody(scorecardInputSchema),
  route(async (req, res) => {
    const scorecard = await addMemberScorecard({
      companyId: cid(req),
      applicationId: req.params.applicationId,
      input: req.body,
      userId: req.userId!,
      userName: req.user?.name || req.user?.email || "A Member",
    });
    await audit(req, "recruiting.application.score", "recruiting_application", scorecard.applicationId, scorecard.authorName, {
      score: scorecard.score,
    });
    res.status(201).json(await getApplicationDetail(cid(req), req.params.applicationId));
  }),
);

recruitingRouter.post(
  "/recruiting/applications/:applicationId/screen",
  validateParams(applicationParams),
  validateBody(z.object({}).strict().default({})),
  route(async (req, res) => {
    await requestScreen(cid(req), req.params.applicationId);
    res.json(await getApplicationDetail(cid(req), req.params.applicationId));
  }),
);

recruitingRouter.get(
  "/recruiting/applications/:applicationId/resume",
  validateParams(applicationParams),
  validateQuery(z.object({ download: z.enum(["1"]).optional() }).strict()),
  route(async (req, res) => {
    const application = await loadApplication(cid(req), req.params.applicationId);
    const abs = resumeAbsPath(cid(req), application.resumeFileKey);
    if (!abs || !fs.existsSync(abs)) {
      res.status(404).json({ error: "No resume on file." });
      return;
    }
    const inline = application.resumeMimeType === "application/pdf" && req.query.download !== "1";
    const filename = application.resumeFileName || "resume";
    res.setHeader("Content-Type", inline ? "application/pdf" : "application/octet-stream");
    res.setHeader(
      "Content-Disposition",
      `${inline ? "inline" : "attachment"}; filename="${filename.replace(/[^\x20-\x7e]|["\\]/g, "_")}"; filename*=UTF-8''${rfc8187(filename)}`,
    );
    res.setHeader("X-Content-Type-Options", "nosniff");
    // A download is inert whatever it holds; an inline resume is a file the
    // server sniffed as a PDF, rendered by the browser's PDF viewer (which a
    // sandboxed document cannot load) — the Resources rule.
    if (!inline) res.setHeader("Content-Security-Policy", "sandbox");
    res.setHeader("Cache-Control", "private, no-store");
    res.sendFile(abs);
  }),
);

recruitingRouter.delete(
  "/recruiting/applications/:applicationId",
  validateParams(applicationParams),
  requireCompanyRole("admin"),
  route(async (req, res) => {
    const application = await deleteApplication(cid(req), req.params.applicationId);
    await audit(req, "recruiting.application.delete", "recruiting_application", application.id, application.candidateName);
    res.status(204).end();
  }),
);

// ── AI access ──────────────────────────────────────────────────────────────

recruitingRouter.get(
  "/recruiting/ai-access",
  validateParams(companyParams),
  route(async (req, res) => {
    res.json({ rows: await listRecruitingGrants(cid(req)) });
  }),
);

recruitingRouter.put(
  "/recruiting/ai-access/:employeeId",
  validateParams(companyParams.extend({ employeeId: z.string().uuid() }).strict()),
  validateBody(z.object({ accessLevel: z.enum(RECRUITING_ACCESS_LEVELS) }).strict()),
  route(async (req, res) => {
    const grant = await upsertRecruitingGrant(cid(req), req.params.employeeId, req.body.accessLevel);
    await audit(req, "recruiting.grant.upsert", "employee_recruiting_grant", grant.id, grant.employeeId, {
      accessLevel: grant.accessLevel,
    });
    res.json(grant);
  }),
);

recruitingRouter.delete(
  "/recruiting/ai-access/:grantId",
  validateParams(companyParams.extend({ grantId: z.string().uuid() }).strict()),
  route(async (req, res) => {
    const deleted = await deleteRecruitingGrant(cid(req), req.params.grantId);
    if (!deleted) {
      res.status(404).json({ error: "Recruiting Grant not found" });
      return;
    }
    await audit(req, "recruiting.grant.delete", "employee_recruiting_grant", req.params.grantId, "");
    res.status(204).end();
  }),
);
