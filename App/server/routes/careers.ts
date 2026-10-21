import crypto from "node:crypto";

import type { NextFunction, Request, RequestHandler, Response } from "express";
import { Router } from "express";
import multer from "multer";
import { z } from "zod";

import { RESUME_MAX_BYTES } from "../../shared/recruiting.js";
import { validateParams, validateQuery } from "../middleware/validate.js";
import { resolveUserSession } from "../services/userSessions.js";
import {
  ApplicationFieldError,
  afterApplicationReceived,
  submitApplication,
} from "../services/recruiting/applications.js";
import { careersCompanyForHost, normalizeCustomDomain } from "../services/recruiting/domains.js";
import { recruitingErrorStatus } from "../services/recruiting/errors.js";
import { logoAbsPath, logoMimeType } from "../services/recruiting/files.js";
import {
  careersFeed,
  careersViewer,
  findSiteOpening,
  listSiteOpenings,
  publicOpeningDto,
  publicSiteDto,
  resolveSite,
  siteVisibleTo,
  type CareersViewer,
  type ResolvedSite,
} from "../services/recruiting/site.js";
import { requestHostname } from "../services/recruiting/urls.js";

/**
 * The careers site's public API, at `/api/careers`.
 *
 * Session-optional: anyone may read a public site and apply, and a signed-in
 * Member of the company also sees its internal Openings. On a careers custom
 * domain only that domain's company answers, and an internal site never does
 * — nobody is signed in there. Everything a visitor cannot see answers 404,
 * so an unlisted or internal Opening is indistinguishable from none.
 *
 * Nothing here reveals how applicants are judged: criteria, Scorecards and
 * the screener never leave the App.
 */
export const careersRouter = Router();

/** Applied to every response: public data, but per-visitor, and not for indexing as JSON. */
export const careersApiHeaders: RequestHandler = (_req, res, next) => {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Robots-Tag", "noindex");
  next();
};

careersRouter.use(careersApiHeaders);

const slugSchema = z.string().trim().min(1).max(120).regex(/^[a-z0-9][a-z0-9-]*$/);
const siteParamsSchema = z.object({ siteSlug: slugSchema }).strict();
const openingParamsSchema = z.object({ siteSlug: slugSchema, openingSlug: slugSchema }).strict();

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

/** The signed-in user, when the request carries a live session. Never fails the request. */
async function sessionUserId(req: Request): Promise<string | null> {
  if (!req.session?.userId) return null;
  try {
    return (await resolveUserSession(req.session))?.id ?? null;
  } catch {
    return null;
  }
}

type SiteContext = { site: ResolvedSite; viewer: CareersViewer };

/** The site this request may see, or a 404 / 403 already sent. */
async function siteContext(req: Request, res: Response): Promise<SiteContext | null> {
  const hostCompanyId = careersCompanyForHost(requestHostname(req));
  const site = await resolveSite(req.params.siteSlug, { hostCompanyId });
  if (!site) {
    res.status(404).json({ error: "This careers site is not available." });
    return null;
  }
  // A careers domain never carries a session; only the install's own address does.
  const viewer = await careersViewer(site.company, hostCompanyId ? null : await sessionUserId(req));
  if (!siteVisibleTo(site, viewer)) {
    res.status(403).json({ error: "This careers site is for Members. Sign in to see it." });
    return null;
  }
  return { site, viewer };
}

careersRouter.get(
  "/sites/:siteSlug",
  validateParams(siteParamsSchema),
  route(async (req, res) => {
    const context = await siteContext(req, res);
    if (!context) return;
    res.json({
      site: publicSiteDto(context.site, context.viewer),
      openings: await listSiteOpenings(context.site, context.viewer),
    });
  }),
);

careersRouter.get(
  "/sites/:siteSlug/openings/:openingSlug",
  validateParams(openingParamsSchema),
  route(async (req, res) => {
    const context = await siteContext(req, res);
    if (!context) return;
    const opening = await findSiteOpening(context.site, req.params.openingSlug, context.viewer);
    if (!opening) {
      res.status(404).json({ error: "This opening is not available." });
      return;
    }
    res.json({
      site: publicSiteDto(context.site, context.viewer),
      opening: publicOpeningDto(opening, context.site),
    });
  }),
);

/** Resumes are held in memory only long enough to sniff, read and write them under a server-chosen name. */
const resumeUpload = multer({
  storage: multer.memoryStorage(),
  // File names arrive as UTF-8; multer would read "Zoë" as Latin-1.
  defParamCharset: "utf8",
  limits: { fileSize: RESUME_MAX_BYTES, files: 1, fields: 40, fieldSize: 256 * 1024, parts: 45 },
}).single("resume");

function acceptResume(req: Request, res: Response, next: NextFunction): void {
  resumeUpload(req, res, (error: unknown) => {
    if (!error) return next();
    if (error instanceof multer.MulterError) {
      if (error.code === "LIMIT_FILE_SIZE") {
        res.status(413).json({ error: "Keep the resume under 10 MB.", fields: { resume: "Keep the resume under 10 MB." } });
        return;
      }
      res.status(400).json({ error: "The application could not be read. Try again." });
      return;
    }
    next(error);
  });
}

const optionalText = (max: number) => z.string().max(max).optional().default("");

const applicationFieldsSchema = z
  .object({
    submissionId: z.string().uuid(),
    name: z.string().max(400),
    email: z.string().max(400),
    phone: optionalText(100),
    location: optionalText(400),
    linkedinUrl: optionalText(1_000),
    websiteUrl: optionalText(1_000),
    coverLetter: optionalText(20_000),
    answers: optionalText(200_000),
    consent: z.enum(["true", "false"]).optional().default("false"),
    /** Left empty by people; filled in by form-filling bots. */
    fax: optionalText(400),
  })
  .strict();

type SubmitBucket = { count: number; startedAt: number };
const submitBuckets = new Map<string, SubmitBucket>();
const submitSalt = crypto.randomBytes(32);
const SUBMIT_WINDOW_MS = 10 * 60_000;
const SUBMIT_MAX_PER_WINDOW = 10;
const SUBMIT_BUCKET_CAP = 10_000;

/** Ten applications per address per Opening per ten minutes: plenty for people, little for scripts. */
function consumeSubmitAttempt(req: Request, res: Response, openingKey: string): boolean {
  const now = Date.now();
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const key = crypto.createHmac("sha256", submitSalt).update(`${openingKey}:${ip}`).digest("hex");
  let bucket = submitBuckets.get(key);
  if (!bucket || now - bucket.startedAt >= SUBMIT_WINDOW_MS) {
    if (!submitBuckets.has(key) && submitBuckets.size >= SUBMIT_BUCKET_CAP) {
      for (const [candidate, value] of submitBuckets) {
        if (now - value.startedAt >= SUBMIT_WINDOW_MS) submitBuckets.delete(candidate);
      }
      if (submitBuckets.size >= SUBMIT_BUCKET_CAP) {
        const oldest = submitBuckets.keys().next().value as string | undefined;
        if (oldest) submitBuckets.delete(oldest);
      }
    }
    bucket = { count: 0, startedAt: now };
    submitBuckets.set(key, bucket);
  }
  if (bucket.count >= SUBMIT_MAX_PER_WINDOW) {
    res.setHeader("Retry-After", String(Math.max(1, Math.ceil((bucket.startedAt + SUBMIT_WINDOW_MS - now) / 1000))));
    res.status(429).json({ error: "Too many applications from this connection. Try again in a few minutes." });
    return false;
  }
  bucket.count += 1;
  return true;
}

export function resetCareersSubmitThrottleForTests(): void {
  submitBuckets.clear();
}

function parseAnswersField(raw: string): Record<string, unknown> | null {
  if (!raw.trim()) return {};
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

careersRouter.post(
  "/sites/:siteSlug/openings/:openingSlug/applications",
  validateParams(openingParamsSchema),
  acceptResume,
  route(async (req, res) => {
    const parsed = applicationFieldsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "The application could not be read. Reload the page and try again." });
      return;
    }
    const body = parsed.data;
    const context = await siteContext(req, res);
    if (!context) return;
    const opening = await findSiteOpening(context.site, req.params.openingSlug, context.viewer);
    if (!opening) {
      res.status(404).json({ error: "This opening is not available." });
      return;
    }
    if (body.fax.trim()) {
      // A bot filled the field people never see. Answer as if it worked, so it learns nothing.
      res.status(201).json({ ok: true, email: "" });
      return;
    }
    if (!consumeSubmitAttempt(req, res, opening.id)) return;
    const answers = parseAnswersField(body.answers);
    if (!answers) {
      res.status(400).json({ error: "The answers could not be read. Reload the page and try again." });
      return;
    }
    const internal = opening.visibility === "internal" || context.site.settings.siteVisibility === "internal";
    const { application, duplicate } = await submitApplication({
      opening,
      input: {
        clientSubmissionId: body.submissionId,
        name: body.name,
        email: body.email,
        phone: body.phone,
        location: body.location,
        linkedinUrl: body.linkedinUrl,
        websiteUrl: body.websiteUrl,
        coverLetter: body.coverLetter,
        answers,
        consent: body.consent === "true",
      },
      file: req.file ? { buffer: req.file.buffer, originalname: req.file.originalname } : null,
      source: internal && context.viewer.member ? "internal" : "careers_site",
      applicantUserId: context.viewer.member ? context.viewer.userId : null,
    });
    if (!duplicate) void afterApplicationReceived(application.id, { confirm: true });
    res.status(201).json({ ok: true, email: application.candidateEmail });
  }),
);

careersRouter.get(
  "/sites/:siteSlug/logo",
  validateParams(siteParamsSchema),
  route(async (req, res) => {
    const hostCompanyId = careersCompanyForHost(requestHostname(req));
    const site = await resolveSite(req.params.siteSlug, { hostCompanyId });
    const abs = site ? logoAbsPath(site.company.id, site.settings.logoKey) : null;
    if (!site || !abs || !site.settings.logoKey) {
      res.status(404).json({ error: "No logo." });
      return;
    }
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    res.type(logoMimeType(site.settings.logoKey));
    res.sendFile(abs);
  }),
);

careersRouter.get(
  "/sites/:siteSlug/feed.json",
  validateParams(siteParamsSchema),
  route(async (req, res) => {
    const hostCompanyId = careersCompanyForHost(requestHostname(req));
    const site = await resolveSite(req.params.siteSlug, { hostCompanyId });
    if (!site || site.settings.siteVisibility !== "public") {
      res.status(404).json({ error: "This careers site is not available." });
      return;
    }
    // A company's own website renders its openings from here, from any origin.
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "public, max-age=300");
    res.json(await careersFeed(site));
  }),
);

const domainCheckSchema = z.object({ domain: z.string().min(1).max(300) }).strict();

/**
 * For a reverse proxy issuing certificates on demand (Caddy's `ask`): 200 for
 * a careers domain this install serves, 404 for anything else, so the proxy
 * never requests a certificate for a name nobody verified.
 */
careersRouter.get(
  "/domains/check",
  validateQuery(domainCheckSchema),
  route(async (req, res) => {
    let domain: string;
    try {
      domain = normalizeCustomDomain(String(req.query.domain));
    } catch {
      res.status(404).json({ ok: false });
      return;
    }
    res.status(careersCompanyForHost(domain) ? 200 : 404).json({ ok: Boolean(careersCompanyForHost(domain)) });
  }),
);
