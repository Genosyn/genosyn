import {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
  Router,
} from "express";
import { z } from "zod";

import { SUPPORT_LIMITS } from "../../shared/support.js";
import { withRouteMetadata } from "../middleware/routeMetadata.js";
import { validateBody } from "../middleware/validate.js";
import {
  AuthRateLimitError,
  assertAuthAllowed,
  authThrottleKeys,
  recordAuthFailure,
} from "../services/authThrottle.js";
import { isSupportError } from "../services/support/errors.js";
import { lookupRating, ratingPage, submitRating } from "../services/support/ratings.js";

/**
 * A customer rating how a ticket went. Mount at `/api/feedback`, before the
 * session and the trusted-origin gate: a customer has no account, and the
 * unguessable token in the link they were emailed is the only credential. It
 * reaches the ticket's subject and a rating box, and nothing else.
 */
export const publicSupportRouter = Router();

/** Bearer-token pages and payloads are never cached or indexed. */
export const publicSupportSecurityHeaders: RequestHandler = (_req, res, next) => {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
};

publicSupportRouter.use(publicSupportSecurityHeaders);

const NOT_FOUND = "This link is invalid.";
const tokenParams = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();
const ratingBody = z
  .object({
    score: z.number().int().min(1).max(5),
    comment: z.string().trim().max(SUPPORT_LIMITS.ratingCommentChars).optional(),
  })
  .strict();

function throttleKeys(req: Request): string[] {
  return authThrottleKeys(req, "public-support-feedback");
}

/** A malformed token is a guess like any other: the same 404, counted the same way. */
function validToken(): RequestHandler {
  return withRouteMetadata(
    (req: Request, res: Response, next: NextFunction) => {
      void (async () => {
        const parsed = tokenParams.safeParse(req.params);
        if (parsed.success) {
          req.params = parsed.data;
          next();
          return;
        }
        if (!(await allowed(req, res))) return;
        await recordAuthFailure(throttleKeys(req));
        res.status(404).json({ error: NOT_FOUND });
      })().catch(next);
    },
    { kind: "requestSchema", location: "params", schema: tokenParams },
  );
}

async function allowed(req: Request, res: Response): Promise<boolean> {
  try {
    await assertAuthAllowed(throttleKeys(req));
    return true;
  } catch (error) {
    if (!(error instanceof AuthRateLimitError)) throw error;
    res.setHeader("Retry-After", String(error.retryAfterSeconds));
    res.status(429).json({ error: error.message });
    return false;
  }
}

function route(fn: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch((error: unknown) => {
      if (isSupportError(error)) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      next(error);
    });
  };
}

publicSupportRouter.get(
  "/:token",
  validToken(),
  route(async (req, res) => {
    if (!(await allowed(req, res))) return;
    const context = await lookupRating(req.params.token as string);
    if (!context) {
      await recordAuthFailure(throttleKeys(req));
      res.status(404).json({ error: NOT_FOUND });
      return;
    }
    res.json(ratingPage(context));
  }),
);

publicSupportRouter.post(
  "/:token",
  validToken(),
  validateBody(ratingBody),
  route(async (req, res) => {
    if (!(await allowed(req, res))) return;
    const body = req.body as z.infer<typeof ratingBody>;
    const existing = await lookupRating(req.params.token as string);
    if (!existing) {
      await recordAuthFailure(throttleKeys(req));
      res.status(404).json({ error: NOT_FOUND });
      return;
    }
    res.json(
      ratingPage(
        await submitRating({
          token: req.params.token as string,
          score: body.score,
          comment: body.comment,
        }),
      ),
    );
  }),
);
