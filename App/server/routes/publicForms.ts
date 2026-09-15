import crypto from "node:crypto";

import type { NextFunction, Request, RequestHandler, Response } from "express";
import { Router } from "express";
import { z } from "zod";

import { validateBody } from "../middleware/validate.js";
import {
  AuthRateLimitError,
  assertAuthAllowed,
  authThrottleKeys,
  recordAuthFailure,
} from "../services/authThrottle.js";
import {
  BaseFormRequestError,
  PublicBaseFormClosedError,
  PublicBaseFormNotFoundError,
  baseFormResponseExists,
  baseFormTokenExists,
  publicBaseFormDto,
  resolvePublicBaseForm,
  submitBaseFormResponse,
  type PublicBaseFormValue,
} from "../services/baseForms.js";

/** Bearer-token Forms are deliberately independent of a Member session. */
export const publicFormsRouter = Router();

/** Applied before JSON parsing too, so a 413 cannot be cached or indexed. */
export const publicFormsSecurityHeaders: RequestHandler = (_req, res, next) => {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  next();
};

publicFormsRouter.use(publicFormsSecurityHeaders);

const tokenParamsSchema = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();

const publicValueSchema: z.ZodType<PublicBaseFormValue> = z.union([
  z.string().max(50_000),
  z.number().finite(),
  z.boolean(),
  z.array(z.string().max(255)).max(100),
  z.null(),
]);

const responseBodySchema = z
  .object({
    submissionId: z.string().uuid(),
    values: z.record(z.string().uuid(), publicValueSchema).superRefine((values, ctx) => {
      if (Object.keys(values).length > 100) {
        ctx.addIssue({
          code: z.ZodIssueCode.too_big,
          type: "array",
          maximum: 100,
          inclusive: true,
          message: "A response may contain at most 100 answers",
        });
      }
    }),
  })
  .strict();

function probeKeys(req: Request): string[] {
  // Do not persist random bearer candidates: IP-only keys prevent scanners
  // from using the throttle table itself as unbounded storage.
  return authThrottleKeys(req, "public-form");
}

async function recordUnknownTokenProbe(req: Request): Promise<void> {
  if (!(await baseFormTokenExists(req.params.token))) {
    await recordAuthFailure(probeKeys(req));
  }
}

async function probeAllowed(req: Request, res: Response): Promise<boolean> {
  try {
    await assertAuthAllowed(probeKeys(req));
    return true;
  } catch (error) {
    if (!(error instanceof AuthRateLimitError)) throw error;
    res.setHeader("Retry-After", String(error.retryAfterSeconds));
    res.status(429).json({ error: error.message });
    return false;
  }
}

const validatePublicToken: RequestHandler = (req, res, next) => {
  void (async () => {
    const parsed = tokenParamsSchema.safeParse(req.params);
    if (parsed.success) {
      req.params = parsed.data;
      next();
      return;
    }
    if (!(await probeAllowed(req, res))) return;
    await recordAuthFailure(probeKeys(req));
    res.status(404).json({ error: "This form link is invalid or unavailable" });
  })().catch(next);
};

type SubmitBucket = { count: number; startedAt: number };
const submitBuckets = new Map<string, SubmitBucket>();
const submitThrottleSalt = crypto.randomBytes(32);
const SUBMIT_WINDOW_MS = 60_000;
const SUBMIT_MAX = 30;
const SUBMIT_BUCKET_CAP = 10_000;
let lastSubmitBucketSweep = 0;

function submitBucketKey(req: Request, formId: string): string {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  return crypto.createHmac("sha256", submitThrottleSalt).update(`${formId}:${ip}`).digest("hex");
}

function consumeSubmitAttempt(req: Request, res: Response, formId: string): boolean {
  const now = Date.now();
  const key = submitBucketKey(req, formId);
  let bucket = submitBuckets.get(key);
  if (!bucket || now - bucket.startedAt >= SUBMIT_WINDOW_MS) {
    if (now - lastSubmitBucketSweep >= SUBMIT_WINDOW_MS) {
      for (const [candidateKey, candidate] of submitBuckets) {
        if (now - candidate.startedAt >= SUBMIT_WINDOW_MS) submitBuckets.delete(candidateKey);
      }
      lastSubmitBucketSweep = now;
    }
    if (!submitBuckets.has(key) && submitBuckets.size >= SUBMIT_BUCKET_CAP) {
      const oldestKey = submitBuckets.keys().next().value as string | undefined;
      if (oldestKey) submitBuckets.delete(oldestKey);
    }
    bucket = { count: 0, startedAt: now };
    submitBuckets.set(key, bucket);
  }
  if (bucket.count >= SUBMIT_MAX) {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((bucket.startedAt + SUBMIT_WINDOW_MS - now) / 1_000),
    );
    res.setHeader("Retry-After", String(retryAfterSeconds));
    res.status(429).json({ error: "Too many responses. Try again shortly." });
    return false;
  }
  bucket.count += 1;

  return true;
}

/** Isolate focused route tests from this process-local abuse-control state. */
export function resetPublicFormSubmitThrottleForTests(): void {
  submitBuckets.clear();
  lastSubmitBucketSweep = 0;
}

function publicRoute(handler: (req: Request, res: Response) => Promise<unknown>): RequestHandler {
  return (req, res, next: NextFunction) => {
    void handler(req, res).catch(async (error: unknown) => {
      if (error instanceof PublicBaseFormNotFoundError) {
        await recordUnknownTokenProbe(req);
        res.status(404).json({ error: "This form link is invalid or unavailable" });
        return;
      }
      if (error instanceof PublicBaseFormClosedError) {
        res.status(409).json({ error: error.message });
        return;
      }
      if (error instanceof BaseFormRequestError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      next(error);
    });
  };
}

async function requirePublicContext(req: Request, res: Response) {
  if (!(await probeAllowed(req, res))) return null;
  const context = await resolvePublicBaseForm(req.params.token);
  if (!context) {
    await recordUnknownTokenProbe(req);
    res.status(404).json({ error: "This form link is invalid or unavailable" });
    return null;
  }
  return context;
}

publicFormsRouter.get(
  "/:token",
  validatePublicToken,
  publicRoute(async (req, res) => {
    const context = await requirePublicContext(req, res);
    if (context) res.json(publicBaseFormDto(context));
  }),
);

publicFormsRouter.post(
  "/:token/responses",
  validatePublicToken,
  validateBody(responseBodySchema),
  publicRoute(async (req, res) => {
    const context = await requirePublicContext(req, res);
    if (!context) return;
    const body = req.body as z.infer<typeof responseBodySchema>;
    if (await baseFormResponseExists(context.form.id, body.submissionId)) {
      res.json({ ok: true });
      return;
    }
    if (!context.form.acceptingResponses) throw new PublicBaseFormClosedError();
    if (!consumeSubmitAttempt(req, res, context.form.id)) return;
    res.json(
      await submitBaseFormResponse({
        token: req.params.token,
        clientSubmissionId: body.submissionId,
        values: body.values,
      }),
    );
  }),
);
