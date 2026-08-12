import path from "node:path";

import {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
  Router,
} from "express";
import { z } from "zod";

import { validateBody } from "../middleware/validate.js";
import {
  AuthRateLimitError,
  assertAuthAllowed,
  authThrottleKeys,
  consumeAuthAttempt,
  recordAuthFailure,
} from "../services/authThrottle.js";
import {
  SigningConflictError,
  SigningNotFoundError,
  SigningValidationError,
  completeSignatureRecipient,
  declineSignatureRecipient,
  lookupSignatureRecipientByToken,
  markSignatureViewed,
  resolvePublicSignatureDocument,
  retrySignatureEnvelopeFinalization,
  type PublicSignatureContext,
  type SignatureFieldValue,
} from "../services/signing.js";

/**
 * Token-authenticated recipient surface. Mount at `/api/sign` before the
 * app-wide trusted-origin gate: email clients and privacy browsers may omit
 * Origin, and the unguessable per-recipient token is the credential.
 */
export const publicSignaturesRouter = Router();

/** Prevent bearer-token signing pages and API payloads from being cached or indexed. */
export const publicSigningSecurityHeaders: RequestHandler = (_req, res, next) => {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  next();
};

publicSignaturesRouter.use(publicSigningSecurityHeaders);

const tokenParamsSchema = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();

const fieldValueSchema: z.ZodType<SignatureFieldValue> = z.union([
  z.string().max(255),
  z.boolean(),
  z.null(),
  z
    .object({
      kind: z.literal("typed").optional(),
      text: z.string().max(255).optional(),
      value: z.string().max(255).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("drawn"),
      dataUrl: z.string().max(700_000),
    })
    .strict(),
]);

const completeBodySchema = z
  .object({
    consent: z.literal(true),
    timezoneOffsetMinutes: z.number().int().min(-840).max(840),
    timeZone: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9._+\-/]+$/)
      .refine(
        (value) => {
          try {
            new Intl.DateTimeFormat("en", { timeZone: value }).format();
            return true;
          } catch {
            return false;
          }
        },
        { message: "timeZone must be a valid IANA timezone" },
      )
      .optional(),
    values: z
      .array(
        z
          .object({
            fieldId: z.string().uuid(),
            value: fieldValueSchema,
            type: z.string().trim().max(32).optional(),
          })
          .strict(),
      )
      .max(2_000),
  })
  .strict();

const declineBodySchema = z.object({ reason: z.string().trim().min(1).max(2_000) }).strict();
const emptyBodySchema = z.object({}).strict().default({});

function evidence(req: Request): { ipAddress?: string; userAgent?: string } {
  return {
    ipAddress: req.ip || req.socket.remoteAddress,
    userAgent: req.get("user-agent"),
  };
}

function tokenKeys(req: Request): string[] {
  // The bearer token has 256 bits of entropy, so guessing a particular token
  // is not a realistic attack. Rate-limit by source IP only: persisting one
  // identity row for every random token would let an unauthenticated scanner
  // grow the throttle table without bound.
  return authThrottleKeys(req, "public-signature");
}

function downloadKeys(req: Request): string[] {
  // Only derive a token-specific persistent key after the token has resolved
  // to a real recipient. Random probes therefore cannot grow the table, while
  // each legitimate link still receives a durable cap. Do not share an IP
  // bucket here: several recipients may legitimately sign behind one company
  // gateway, and invalid-token traffic is already limited separately.
  return authThrottleKeys(req, "public-signature-download", req.params.token).slice(1);
}

async function throttleAllowedFor(keys: string[], res: Response): Promise<boolean> {
  try {
    await assertAuthAllowed(keys);
    return true;
  } catch (error) {
    if (!(error instanceof AuthRateLimitError)) throw error;
    res.setHeader("Retry-After", String(error.retryAfterSeconds));
    res.status(429).json({ error: error.message });
    return false;
  }
}

async function throttleAllowed(req: Request, res: Response): Promise<boolean> {
  return throttleAllowedFor(tokenKeys(req), res);
}

async function consumeDownload(req: Request, res: Response): Promise<boolean> {
  try {
    await consumeAuthAttempt(downloadKeys(req));
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
    if (!(await throttleAllowed(req, res))) return;
    await recordAuthFailure(tokenKeys(req));
    res.status(404).json({ error: "This signing link is invalid or expired" });
  })().catch(next);
};

function publicRoute(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    void fn(req, res, next).catch(async (error: unknown) => {
      if (error instanceof SigningNotFoundError || error instanceof SigningConflictError) {
        // Public token failures are intentionally indistinguishable. A caller
        // cannot learn whether the envelope, recipient, or token ever existed.
        await recordAuthFailure(tokenKeys(req));
        res.status(404).json({ error: "This signing link is invalid or expired" });
        return;
      }
      if (error instanceof SigningValidationError) {
        res.status(400).json({ error: error.message });
        return;
      }
      next(error);
    });
  };
}

function projectPublic(context: PublicSignatureContext) {
  const mayExposeValues =
    context.envelope.status !== "completed" && context.recipient.status !== "completed";
  return {
    envelope: {
      id: context.envelope.id,
      title: context.envelope.title,
      message: context.envelope.message,
      status: context.envelope.status,
      routingMode: context.envelope.routingMode,
      expiresAt: context.envelope.expiresAt,
      sentAt: context.envelope.sentAt,
      completedAt: context.envelope.completedAt,
      finalizationPending: context.envelope.finalizationPending,
      filename: context.envelope.originalFilename,
      originalPageCount: context.envelope.originalPageCount,
      companyName: context.company.name,
    },
    recipient: {
      id: context.recipient.id,
      name: context.recipient.name,
      email: context.recipient.email,
      role: context.recipient.role,
      status: context.recipient.status,
      viewedAt: context.recipient.viewedAt,
      completedAt: context.recipient.completedAt,
    },
    fields: context.fields.map((field) => ({
      id: field.id,
      recipientId: field.recipientId,
      type: field.type,
      label: field.label,
      placeholder: field.placeholder,
      required: field.required,
      pageNumber: field.pageNumber,
      x: field.x,
      y: field.y,
      width: field.width,
      height: field.height,
      sortOrder: field.sortOrder,
      value: mayExposeValues ? field.value : null,
    })),
    sender: { companyName: context.company.name },
  };
}

async function requireContext(req: Request, res: Response): Promise<PublicSignatureContext | null> {
  if (!(await throttleAllowed(req, res))) return null;
  const context = await lookupSignatureRecipientByToken({ token: req.params.token });
  if (!context) {
    await recordAuthFailure(tokenKeys(req));
    res.status(404).json({ error: "This signing link is invalid or expired" });
    return null;
  }
  return context;
}

function contentDisposition(filename: string, disposition: "inline" | "attachment"): string {
  const utf8 =
    path
      .basename(filename)
      .replace(/[\r\n]/g, "_")
      .slice(0, 255) || "document.pdf";
  const ascii = utf8.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(utf8)}`;
}

async function sendPublicDocument(
  req: Request,
  res: Response,
  variant: "original" | "completed",
): Promise<void> {
  if (!(await throttleAllowed(req, res))) return;
  try {
    const context = await lookupSignatureRecipientByToken({ token: req.params.token });
    if (!context) {
      await recordAuthFailure(tokenKeys(req));
      res.status(404).json({ error: "This signing link is invalid or expired" });
      return;
    }
    if (!(await consumeDownload(req, res))) return;
    const document = await resolvePublicSignatureDocument({
      token: req.params.token,
      variant,
      ...evidence(req),
    });
    res.setHeader("Content-Type", document.mimeType);
    res.setHeader("Content-Length", String(document.sizeBytes));
    res.setHeader(
      "Content-Disposition",
      contentDisposition(document.filename, variant === "original" ? "inline" : "attachment"),
    );
    res.setHeader("ETag", `"sha256-${document.sha256}"`);
    res.sendFile(document.path);
  } catch (error) {
    if (error instanceof SigningNotFoundError || error instanceof SigningConflictError) {
      await recordAuthFailure(tokenKeys(req));
      res.status(404).json({ error: "This signing link is invalid or expired" });
      return;
    }
    throw error;
  }
}

publicSignaturesRouter.get(
  "/:token",
  validatePublicToken,
  publicRoute(async (req, res) => {
    const context = await requireContext(req, res);
    if (context) res.json(projectPublic(context));
  }),
);

publicSignaturesRouter.get(
  "/:token/document",
  validatePublicToken,
  publicRoute(async (req, res) => sendPublicDocument(req, res, "original")),
);

publicSignaturesRouter.post(
  "/:token/view",
  validatePublicToken,
  validateBody(emptyBodySchema),
  publicRoute(async (req, res) => {
    if (!(await throttleAllowed(req, res))) return;
    const context = await markSignatureViewed({ token: req.params.token, ...evidence(req) });
    res.json(projectPublic(context));
  }),
);

publicSignaturesRouter.post(
  "/:token/complete",
  validatePublicToken,
  validateBody(completeBodySchema),
  publicRoute(async (req, res) => {
    if (!(await throttleAllowed(req, res))) return;
    const result = await completeSignatureRecipient({
      token: req.params.token,
      consent: req.body.consent,
      timezoneOffsetMinutes: req.body.timezoneOffsetMinutes,
      timeZone: req.body.timeZone,
      values: req.body.values,
      ...evidence(req),
    });
    res.json(result);
  }),
);

publicSignaturesRouter.post(
  "/:token/finalize",
  validatePublicToken,
  validateBody(emptyBodySchema),
  publicRoute(async (req, res) => {
    if (!(await throttleAllowed(req, res))) return;
    const result = await retrySignatureEnvelopeFinalization({ token: req.params.token });
    res.json(result);
  }),
);

publicSignaturesRouter.post(
  "/:token/decline",
  validatePublicToken,
  validateBody(declineBodySchema),
  publicRoute(async (req, res) => {
    if (!(await throttleAllowed(req, res))) return;
    const result = await declineSignatureRecipient({
      token: req.params.token,
      reason: req.body.reason,
      ...evidence(req),
    });
    res.json(result);
  }),
);

publicSignaturesRouter.get(
  "/:token/completed",
  validatePublicToken,
  publicRoute(async (req, res) => sendPublicDocument(req, res, "completed")),
);
