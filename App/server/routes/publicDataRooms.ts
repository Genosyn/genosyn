import {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
  Router,
} from "express";
import { z } from "zod";

import { DATA_ROOM_LIMITS } from "../../shared/dataRooms.js";
import { validateBody, validateQuery } from "../middleware/validate.js";
import {
  AuthRateLimitError,
  assertAuthAllowed,
  authThrottleKeys,
  recordAuthFailure,
} from "../services/authThrottle.js";
import { DataRoomNotFoundError, isDataRoomError } from "../services/dataRooms/errors.js";
import {
  type Evidence,
  type GuestContext,
  acceptTerms,
  askQuestion,
  guestDocumentFile,
  guestDocumentText,
  guestRoomView,
  lookupGuest,
  openDocumentView,
  recordHeartbeat,
  recordVisit,
} from "../services/dataRooms/portal.js";
import { contentDisposition } from "../services/dataRooms/storage.js";

/**
 * A guest's way into a data room. Mount at `/api/room`, before the session and
 * the trusted-origin gate, like signing links: a guest has no account, and the
 * unguessable token in their link is the only credential they hold.
 *
 * A link that never was and a link that does not resolve answer the same 404,
 * so a caller cannot learn whether a guess was close. A known link that no
 * longer opens the room — closed, revoked, expired — says so, since only the
 * person it was sent to holds it. Guessing is throttled by source address.
 */
export const publicDataRoomsRouter = Router();

/** Bearer-token pages and payloads are never cached or indexed. */
export const publicDataRoomSecurityHeaders: RequestHandler = (_req, res, next) => {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
};

publicDataRoomsRouter.use(publicDataRoomSecurityHeaders);

const NOT_FOUND = "This data room link is invalid.";

const tokenParams = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();
const documentParams = z
  .object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/), documentId: z.string().uuid() })
  .strict();
const viewParams = z
  .object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/), viewId: z.string().uuid() })
  .strict();

const emptyBody = z.object({}).strict().default({});
const termsBody = z
  .object({ name: z.string().trim().min(2).max(160), accept: z.literal(true) })
  .strict();
const viewBody = z.object({ documentId: z.string().uuid() }).strict();
const heartbeatBody = z.object({ seconds: z.number().int().min(1).max(120) }).strict();
const questionBody = z
  .object({
    question: z.string().trim().min(3).max(DATA_ROOM_LIMITS.questionChars),
    documentId: z.string().uuid().nullable().optional(),
  })
  .strict();
const fileQuery = z.object({ download: z.enum(["0", "1"]).optional() }).strict();

function throttleKeys(req: Request): string[] {
  // The token has 256 bits of entropy; only the source address is worth
  // limiting, and keying on random tokens would let a scanner grow the table.
  return authThrottleKeys(req, "public-data-room");
}

function evidence(req: Request): Evidence {
  return { ipAddress: req.ip || req.socket.remoteAddress, userAgent: req.get("user-agent") };
}

/**
 * Params are validated here rather than with `validateParams`, so a malformed
 * token answers exactly like an unknown one — and counts as a failed guess.
 */
function withParams(schema: z.ZodTypeAny): RequestHandler {
  return (req, res, next) => {
    void (async () => {
      const parsed = schema.safeParse(req.params);
      if (parsed.success) {
        req.params = parsed.data;
        next();
        return;
      }
      if (!(await throttleAllowed(req, res))) return;
      await recordAuthFailure(throttleKeys(req));
      res.status(404).json({ error: NOT_FOUND });
    })().catch(next);
  };
}

async function throttleAllowed(req: Request, res: Response): Promise<boolean> {
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

/** Resolve the link, or answer for it: 404 unknown, 403 known but no longer open. */
async function guestFor(req: Request, res: Response): Promise<GuestContext | null> {
  if (!(await throttleAllowed(req, res))) return null;
  const lookup = await lookupGuest(req.params.token);
  if (!lookup) {
    await recordAuthFailure(throttleKeys(req));
    res.status(404).json({ error: NOT_FOUND });
    return null;
  }
  if (!lookup.ok) {
    const message =
      lookup.block === "closed"
        ? `${lookup.companyName} has closed this data room.`
        : lookup.block === "expired"
          ? "Your access to this data room has ended."
          : "Your access to this data room was withdrawn.";
    res.status(403).json({
      error: message,
      blocked: lookup.block,
      companyName: lookup.companyName,
      roomName: lookup.roomName,
    });
    return null;
  }
  return lookup.context;
}

function guestRoute(
  fn: (req: Request, res: Response, context: GuestContext, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    void (async () => {
      const context = await guestFor(req, res);
      if (!context) return;
      await fn(req, res, context, next);
    })().catch((error: unknown) => {
      if (isDataRoomError(error)) {
        res
          .status(error.status)
          .json({ error: error instanceof DataRoomNotFoundError ? "Not found" : error.message });
        return;
      }
      next(error);
    });
  };
}

publicDataRoomsRouter.get(
  "/:token",
  withParams(tokenParams),
  guestRoute(async (_req, res, context) => {
    res.json(await guestRoomView(context));
  }),
);

publicDataRoomsRouter.post(
  "/:token/visit",
  withParams(tokenParams),
  validateBody(emptyBody),
  guestRoute(async (req, res, context) => {
    await recordVisit(context, evidence(req));
    res.status(204).end();
  }),
);

publicDataRoomsRouter.post(
  "/:token/terms",
  withParams(tokenParams),
  validateBody(termsBody),
  guestRoute(async (req, res, context) => {
    await acceptTerms(context, { name: req.body.name, ...evidence(req) });
    const fresh = await lookupGuest(req.params.token);
    res.json(fresh?.ok ? await guestRoomView(fresh.context) : await guestRoomView(context));
  }),
);

publicDataRoomsRouter.get(
  "/:token/documents/:documentId/file",
  withParams(documentParams),
  validateQuery(fileQuery),
  guestRoute(async (req, res, context) => {
    const query = req.query as z.infer<typeof fileQuery>;
    const download = query.download === "1";
    const file = await guestDocumentFile(context, req.params.documentId, {
      download,
      ...evidence(req),
    });
    res.setHeader("Content-Type", file.mimeType);
    res.setHeader(
      "Content-Disposition",
      contentDisposition(file.filename, download ? "attachment" : "inline"),
    );
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (file.kind === "bytes") {
      res.setHeader("Content-Length", String(file.bytes.length));
      res.end(file.bytes);
      return;
    }
    res.setHeader("Content-Length", String(file.sizeBytes));
    res.sendFile(file.path);
  }),
);

publicDataRoomsRouter.get(
  "/:token/documents/:documentId/text",
  withParams(documentParams),
  guestRoute(async (req, res, context) => {
    res.json(await guestDocumentText(context, req.params.documentId));
  }),
);

publicDataRoomsRouter.post(
  "/:token/views",
  withParams(tokenParams),
  validateBody(viewBody),
  guestRoute(async (req, res, context) => {
    res.status(201).json(await openDocumentView(context, req.body.documentId, evidence(req)));
  }),
);

publicDataRoomsRouter.post(
  "/:token/views/:viewId/heartbeat",
  withParams(viewParams),
  validateBody(heartbeatBody),
  guestRoute(async (req, res, context) => {
    await recordHeartbeat(context, req.params.viewId, req.body.seconds);
    res.status(204).end();
  }),
);

publicDataRoomsRouter.post(
  "/:token/questions",
  withParams(tokenParams),
  validateBody(questionBody),
  guestRoute(async (req, res, context) => {
    const question = await askQuestion(context, {
      body: req.body.question,
      documentId: req.body.documentId ?? null,
      ...evidence(req),
    });
    res.status(201).json(question);
  }),
);
