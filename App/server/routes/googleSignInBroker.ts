import crypto from "node:crypto";
import { Router, json, urlencoded, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { validateBody, validateQuery } from "../middleware/validate.js";
import {
  assertAuthAllowed,
  AuthRateLimitError,
  authThrottleKeys,
  consumeAuthAttempt,
} from "../services/authThrottle.js";
import {
  authorizeGoogleSignIn,
  completeGoogleSignIn,
  getGoogleSignInBrokerOrigin,
  getGoogleSignInBrokerStatus,
  googleSignInCookieName,
  googleSignInPage,
  GoogleSignInBrokerError,
  pollGoogleSignIn,
  prepareGoogleSignIn,
  refreshGoogleSignIn,
  startGoogleSignIn,
} from "../services/googleSignInBroker.js";
import { GoogleSignInUpstreamError } from "../services/googleSignInGoogle.js";

/** Public broker protocol; mount before application-session CSRF middleware. */
export const googleSignInBrokerRouter = Router();
googleSignInBrokerRouter.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self' https://accounts.google.com; style-src 'unsafe-inline'",
  );
  next();
});

const opaqueSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const requestSchema = z.object({ requestId: opaqueSchema }).strict();
const emptyQuerySchema = z.object({}).strict();
const startSchema = z
  .object({
    codeChallenge: opaqueSchema,
    browserChallenge: opaqueSchema,
    installationOrigin: z.string().min(1).max(2048),
  })
  .strict();
const authorizeSchema = z
  .object({
    requestId: opaqueSchema,
    csrfToken: opaqueSchema,
    browserProof: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
  })
  .strict();
const pollSchema = z
  .object({
    requestId: opaqueSchema,
    codeVerifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
  })
  .strict();
const refreshSchema = z
  .object({
    clientId: z.string().min(1).max(512),
    refreshToken: z.string().min(1).max(16_384),
  })
  .strict();
const callbackSchema = z
  .object({
    state: opaqueSchema,
    code: z.string().min(1).max(8192).optional(),
    error: z.string().min(1).max(256).optional(),
  })
  .refine(
    (value) => Boolean(value.code) !== Boolean(value.error),
    "Google must return a code or an error.",
  );

type Handler = (req: Request, res: Response) => Promise<unknown>;
function handle(handler: Handler, browser = false) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      await handler(req, res);
    } catch (error) {
      if (error instanceof AuthRateLimitError) {
        res.setHeader("Retry-After", String(error.retryAfterSeconds));
        res.status(429);
        if (browser) res.type("html").send(googleSignInPage({ detail: error.message }));
        else res.json({ error: error.message });
        return;
      }
      if (error instanceof GoogleSignInBrokerError || error instanceof GoogleSignInUpstreamError) {
        res.status(error.status);
        if (browser) res.type("html").send(googleSignInPage({ detail: error.message }));
        else res.json({ error: error.message });
        return;
      }
      next(error);
    }
  };
}

function browserCookie(req: Request, token: string): string {
  const name = googleSignInCookieName(token);
  const value =
    (req.headers.cookie ?? "")
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${name}=`))
      ?.slice(name.length + 1) ?? "";
  return opaqueSchema.safeParse(value).success ? value : "";
}

function setFlowCookie(res: Response, token: string, value: string, expiresAt: number) {
  res.cookie(googleSignInCookieName(token), value, {
    httpOnly: true,
    secure: getGoogleSignInBrokerOrigin()?.startsWith("https://") ?? true,
    sameSite: "lax",
    path: "/api/google-sign-in",
    maxAge: Math.max(0, expiresAt - Date.now()),
  });
}

/** These calls are server-to-server and never authenticate using browser cookies. */
function serverJson(req: Request, res: Response, next: NextFunction) {
  if (req.headers.origin || req.headers["sec-fetch-site"] === "cross-site") {
    return res.status(403).json({ error: "Use your Genosyn installation to connect Gmail." });
  }
  if (!req.is("application/json")) {
    return res.status(415).json({ error: "A JSON request is required." });
  }
  // Also enforce the smaller bound when the main App JSON parser ran first.
  if (
    Number(req.headers["content-length"] ?? 0) > 24 * 1024 ||
    (req.body !== undefined && Buffer.byteLength(JSON.stringify(req.body)) > 24 * 1024)
  ) {
    return res.status(413).json({ error: "Gmail sign-in request is too large." });
  }
  next();
}

googleSignInBrokerRouter.get(
  "/status",
  validateQuery(emptyQuerySchema),
  handle(async (_req, res) => {
    res.json(await getGoogleSignInBrokerStatus());
  }),
);

googleSignInBrokerRouter.post(
  "/start",
  serverJson,
  json({ limit: "24kb" }),
  validateBody(startSchema),
  handle(async (req, res) => {
    await consumeAuthAttempt(authThrottleKeys(req, "gmail-broker-start"));
    res.json(await startGoogleSignIn(req.body as z.infer<typeof startSchema>));
  }),
);

googleSignInBrokerRouter.get(
  "/authorize",
  validateQuery(requestSchema),
  handle(async (req, res) => {
    await consumeAuthAttempt(authThrottleKeys(req, "gmail-broker-page"));
    const { requestId } = req.query as z.infer<typeof requestSchema>;
    const page = await prepareGoogleSignIn(requestId);
    const scriptNonce = crypto.randomBytes(18).toString("base64url");
    res.setHeader("Cross-Origin-Opener-Policy", "unsafe-none");
    // A no-referrer policy makes navigation POSTs send Origin: null. Keep the
    // exact-origin consent check usable without sending a referrer to Google.
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader(
      "Content-Security-Policy",
      `default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self' https://accounts.google.com; style-src 'unsafe-inline'; script-src 'nonce-${scriptNonce}'`,
    );
    setFlowCookie(res, requestId, page.browserNonce, page.expiresAt);
    res.type("html").send(googleSignInPage({ scriptNonce, form: { requestId, ...page } }));
  }, true),
);

googleSignInBrokerRouter.post(
  "/authorize",
  urlencoded({ extended: false, limit: "4kb", parameterLimit: 3 }),
  validateBody(authorizeSchema),
  handle(async (req, res) => {
    await consumeAuthAttempt(authThrottleKeys(req, "gmail-broker-authorize"));
    const { requestId, csrfToken, browserProof } = req.body as z.infer<typeof authorizeSchema>;
    const nonce = browserCookie(req, requestId);
    // The broker origin is operator-owned. Never compare Origin with request Host.
    if (
      req.headers.origin !== getGoogleSignInBrokerOrigin() ||
      req.headers["sec-fetch-site"] === "cross-site" ||
      !nonce ||
      !crypto.timingSafeEqual(Buffer.from(nonce), Buffer.from(csrfToken))
    ) {
      throw new GoogleSignInBrokerError(
        "This Gmail sign-in request did not come from the sign-in page.",
        403,
      );
    }
    const started = await authorizeGoogleSignIn({ requestId, browserNonce: nonce, browserProof });
    setFlowCookie(res, requestId, "", 0);
    setFlowCookie(res, started.state, nonce, started.expiresAt);
    res.redirect(303, started.authorizeUrl);
  }, true),
);

googleSignInBrokerRouter.get(
  "/callback",
  validateQuery(callbackSchema),
  handle(async (req, res) => {
    await consumeAuthAttempt(authThrottleKeys(req, "gmail-broker-callback"));
    const callback = req.query as z.infer<typeof callbackSchema>;
    const completed = await completeGoogleSignIn({
      ...callback,
      browserNonce: browserCookie(req, callback.state),
    });
    setFlowCookie(res, callback.state, "", 0);
    res.type("html").send(googleSignInPage({ detail: completed.detail }));
  }, true),
);

googleSignInBrokerRouter.post(
  "/poll",
  serverJson,
  json({ limit: "24kb" }),
  validateBody(pollSchema),
  handle(async (req, res) => {
    const keys = authThrottleKeys(req, "gmail-broker-poll");
    await assertAuthAllowed(keys);
    try {
      res.json(await pollGoogleSignIn(req.body as z.infer<typeof pollSchema>));
    } catch (error) {
      if (error instanceof GoogleSignInBrokerError && error.status === 403)
        await consumeAuthAttempt(keys);
      throw error;
    }
  }),
);

googleSignInBrokerRouter.post(
  "/refresh",
  serverJson,
  json({ limit: "24kb" }),
  validateBody(refreshSchema),
  handle(async (req, res) => {
    const body = req.body as z.infer<typeof refreshSchema>;
    const keys = authThrottleKeys(req, "gmail-broker-refresh", body.refreshToken);
    // Every token has its own persistent budget; a shared installation can renew
    // different mailboxes without exhausting one tiny login-attempt IP bucket.
    await assertAuthAllowed(keys.slice(0, 1));
    await consumeAuthAttempt(keys.slice(1));
    try {
      res.json(await refreshGoogleSignIn(body));
    } catch (error) {
      if (
        (error instanceof GoogleSignInBrokerError || error instanceof GoogleSignInUpstreamError) &&
        error.status === 401
      ) {
        await consumeAuthAttempt(keys.slice(0, 1));
      }
      throw error;
    }
  }),
);
