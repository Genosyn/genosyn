import express, {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
  Router,
} from "express";
import { z } from "zod";

import type { SupportChatVisitor } from "../db/entities/SupportChatVisitor.js";
import { SUPPORT_CHAT_LIMITS } from "../../shared/supportChat.js";
import { requireTrustedOrigin } from "../middleware/httpSecurity.js";
import { withRouteMetadata } from "../middleware/routeMetadata.js";
import { validateBody, validateQuery } from "../middleware/validate.js";
import {
  AuthRateLimitError,
  assertAuthAllowed,
  authThrottleKeys,
  recordAuthFailure,
} from "../services/authThrottle.js";
import {
  confirmChatEmail,
  lookupChatEmailConfirmation,
  requestChatEmail,
} from "../services/support/chatEmail.js";
import { receiveVisitorMessage } from "../services/support/chatIntake.js";
import {
  SupportChatThrottledError,
  throttleEmailRequest,
  throttleMessage,
  throttleNewVisitor,
  throttleRead,
} from "../services/support/chatThrottle.js";
import {
  chatMessageView,
  endVisitor,
  markConversationRead,
  mintVisitor,
  readConversation,
  visitorForToken,
} from "../services/support/chatVisitors.js";
import {
  CHAT_WIDGET_KEY,
  chatWidgetConfig,
  liveWidget,
  type LiveWidget,
} from "../services/support/chatWidgets.js";
import { isSupportError } from "../services/support/errors.js";
import { getSupportSettings } from "../services/support/settings.js";
import { publicSupportSecurityHeaders } from "./publicSupport.js";

/**
 * The Chat widget's API, at `/api/support-chat`: what a visitor's browser talks to.
 *
 * Mounted before the session, so no Member's cookie can lend a request anything, and
 * behind the trusted-origin gate, with no CORS headers. Only the widget's own frame,
 * on this install's origin, can call it from a browser. That says nothing about a
 * script with no browser, so the throttles are what bound it. A visitor's token goes
 * in `Authorization: Bearer` and never in a URL, and it reaches that visitor's own
 * conversation and nothing else (`services/support/chatVisitors.ts`).
 *
 * Every id from a browser is checked before it reaches a query: Postgres types
 * primary keys as uuid and raises on anything else, which SQLite would let pass.
 */
export const publicSupportChatRouter = Router();

/** Applied before JSON parsing too, so a 413 can't be cached or indexed. */
export const publicSupportChatHeaders: RequestHandler = publicSupportSecurityHeaders;

/** A chat line is short. Ahead of the App's 1 MB parser, so an open endpoint reads far less. */
export const publicSupportChatBody: RequestHandler = express.json({ limit: "32kb" });

publicSupportChatRouter.use(publicSupportChatHeaders);
publicSupportChatRouter.use(requireTrustedOrigin);

const NOT_AVAILABLE = "This chat is not available.";
const NOT_YOURS = "This conversation has ended. Start a new one.";
const LINK_INVALID = "This link is no longer valid.";

const widgetParams = z.object({ widgetKey: z.string().regex(CHAT_WIDGET_KEY) }).strict();
const confirmParams = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();

const emptyBody = z.object({}).strict().default({});
const messageBody = z
  .object({
    clientId: z.string().uuid(),
    text: z.string().min(1).max(SUPPORT_CHAT_LIMITS.messageChars * 2),
  })
  .strict();
const readBody = z
  .object({ seq: z.number().int().min(0).max(2_147_483_647) })
  .strict();
const emailBody = z
  .object({
    email: z.string().trim().min(3).max(320),
    name: z.string().max(SUPPORT_CHAT_LIMITS.nameChars * 2).optional(),
  })
  .strict();
const conversationQuery = z
  .object({ after: z.coerce.number().int().min(0).max(2_147_483_647).default(0) })
  .strict();

function route(fn: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch((error: unknown) => {
      if (error instanceof SupportChatThrottledError) {
        res.setHeader("Retry-After", String(error.retryAfterSeconds));
        res.status(429).json({ error: error.message });
        return;
      }
      if (isSupportError(error)) {
        res.status(error.status).json({
          error: error.message,
          ...("code" in error ? { code: error.code } : {}),
        });
        return;
      }
      next(error);
    });
  };
}

/** Malformed, unknown and off are one answer: which keys exist is nobody's business. */
function validWidgetKey(): RequestHandler {
  return withRouteMetadata(
    (req: Request, res: Response, next: NextFunction) => {
      const parsed = widgetParams.safeParse(req.params);
      if (parsed.success) {
        next();
        return;
      }
      res.status(404).json({ error: NOT_AVAILABLE });
    },
    { kind: "requestSchema", location: "params", schema: widgetParams },
  );
}

async function widgetOr404(req: Request, res: Response): Promise<LiveWidget | null> {
  throttleRead(req);
  const live = await liveWidget(req.params.widgetKey as string);
  if (!live) res.status(404).json({ error: NOT_AVAILABLE });
  return live;
}

function bearerToken(req: Request): string | null {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization ?? "");
  return match ? match[1] : null;
}

function guessKeys(req: Request): string[] {
  // By address alone: keying on a made-up token would let a scanner fill the table.
  return authThrottleKeys(req, "public-support-chat");
}

/** Sends the 429 itself when this address has guessed too often. */
async function guessingAllowed(req: Request, res: Response): Promise<boolean> {
  try {
    await assertAuthAllowed(guessKeys(req));
    return true;
  } catch (error) {
    if (!(error instanceof AuthRateLimitError)) throw error;
    res.setHeader("Retry-After", String(error.retryAfterSeconds));
    res.status(429).json({ error: error.message });
    return false;
  }
}

/**
 * The visitor a request's token proves, or null with the answer already sent. A guess,
 * another widget's token, an ended chat and a lapsed one are all the same 401, and the
 * guesses count against the address they came from.
 */
async function visitorOr401(
  req: Request,
  res: Response,
  live: LiveWidget,
): Promise<SupportChatVisitor | null> {
  const token = bearerToken(req);
  const visitor = token ? await visitorForToken(live.widget, token) : null;
  if (visitor) {
    throttleRead(req, visitor.id);
    return visitor;
  }
  if (!(await guessingAllowed(req, res))) return null;
  await recordAuthFailure(guessKeys(req));
  res.status(401).json({ error: NOT_YOURS, code: "visitor_gone" });
  return null;
}

// ── A link confirming an address ────────────────────────────────────────────
// Ahead of the widget routes, and a key can't spell "confirm" anyway.

/** A malformed token is a guess like any other: the same 404, counted the same way. */
function validConfirmToken(): RequestHandler {
  return withRouteMetadata(
    (req: Request, res: Response, next: NextFunction) => {
      void (async () => {
        const parsed = confirmParams.safeParse(req.params);
        if (parsed.success) {
          next();
          return;
        }
        if (!(await guessingAllowed(req, res))) return;
        await recordAuthFailure(guessKeys(req));
        res.status(404).json({ error: LINK_INVALID });
      })().catch(next);
    },
    { kind: "requestSchema", location: "params", schema: confirmParams },
  );
}

async function confirmationOr404(req: Request, res: Response) {
  throttleRead(req);
  if (!(await guessingAllowed(req, res))) return null;
  const page = await lookupChatEmailConfirmation(req.params.token as string);
  if (page) return page;
  await recordAuthFailure(guessKeys(req));
  res.status(404).json({ error: LINK_INVALID });
  return null;
}

publicSupportChatRouter.get(
  "/confirm/:token",
  validConfirmToken(),
  route(async (req, res) => {
    const page = await confirmationOr404(req, res);
    if (page) res.json(page);
  }),
);

/** Nothing is confirmed by opening the link: mail scanners open every link there is. */
publicSupportChatRouter.post(
  "/confirm/:token",
  validConfirmToken(),
  validateBody(emptyBody),
  route(async (req, res) => {
    const page = await confirmationOr404(req, res);
    if (page) res.json(await confirmChatEmail(req.params.token as string));
  }),
);

// ── The widget ──────────────────────────────────────────────────────────────

publicSupportChatRouter.get(
  "/:widgetKey",
  validWidgetKey(),
  route(async (req, res) => {
    const live = await widgetOr404(req, res);
    if (live) res.json(await chatWidgetConfig(live));
  }),
);

/**
 * Start a visitor: the token, on its own, before the first message. Were it handed
 * out with a message's answer, a response lost on the way would lose the only copy,
 * and the retry could prove nothing.
 */
publicSupportChatRouter.post(
  "/:widgetKey/visitors",
  validWidgetKey(),
  validateBody(emptyBody),
  route(async (req, res) => {
    const live = await widgetOr404(req, res);
    if (!live) return;
    if (live.inbox.status !== "active") {
      res.status(409).json({ error: "This chat is closed just now.", code: "closed" });
      return;
    }
    await throttleNewVisitor(req, await getSupportSettings(live.widget.companyId));
    const { token } = await mintVisitor({ widget: live.widget });
    res.status(201).json({ token });
  }),
);

/** The visitor's own conversation after a place in it. The widget polls this. */
publicSupportChatRouter.get(
  "/:widgetKey/conversation",
  validWidgetKey(),
  validateQuery(conversationQuery),
  route(async (req, res) => {
    const live = await widgetOr404(req, res);
    if (!live) return;
    const visitor = await visitorOr401(req, res, live);
    if (!visitor) return;
    const { after } = conversationQuery.parse(req.query);
    res.json(await readConversation({ visitor, after }));
  }),
);

publicSupportChatRouter.post(
  "/:widgetKey/messages",
  validWidgetKey(),
  validateBody(messageBody),
  route(async (req, res) => {
    const live = await widgetOr404(req, res);
    if (!live) return;
    const visitor = await visitorOr401(req, res, live);
    if (!visitor) return;
    const body = req.body as z.infer<typeof messageBody>;
    await throttleMessage(req, visitor, await getSupportSettings(visitor.companyId));
    const { message, replayed } = await receiveVisitorMessage({
      live,
      visitor,
      clientId: body.clientId,
      text: body.text,
    });
    res.status(replayed ? 200 : 201).json({ message: chatMessageView(message) });
  }),
);

/** How far they have read, which is what decides whether a reply also goes by email. */
publicSupportChatRouter.post(
  "/:widgetKey/read",
  validWidgetKey(),
  validateBody(readBody),
  route(async (req, res) => {
    const live = await widgetOr404(req, res);
    if (!live) return;
    const visitor = await visitorOr401(req, res, live);
    if (!visitor) return;
    const readSeq = await markConversationRead(visitor, (req.body as z.infer<typeof readBody>).seq);
    res.json({ readSeq });
  }),
);

/**
 * Ask for replies at an address. The answer is the same whatever becomes of it, so
 * this can't say who is on the do-not-email list or was recently asked about.
 */
publicSupportChatRouter.post(
  "/:widgetKey/email",
  validWidgetKey(),
  validateBody(emailBody),
  route(async (req, res) => {
    const live = await widgetOr404(req, res);
    if (!live) return;
    const visitor = await visitorOr401(req, res, live);
    if (!visitor) return;
    await throttleEmailRequest(req, visitor);
    const body = req.body as z.infer<typeof emailBody>;
    res.status(202).json({
      email: await requestChatEmail({ live, visitor, email: body.email, name: body.name }),
    });
  }),
);

/** End the chat: nothing opens it after this. The Ticket stays, as the company's record. */
publicSupportChatRouter.delete(
  "/:widgetKey/visitor",
  validWidgetKey(),
  route(async (req, res) => {
    const live = await widgetOr404(req, res);
    if (!live) return;
    const visitor = await visitorOr401(req, res, live);
    if (!visitor) return;
    await endVisitor(visitor);
    res.json({ ok: true });
  }),
);
