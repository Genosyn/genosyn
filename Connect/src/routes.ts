import crypto from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import type { Broker } from "./broker.js";
import { ConnectError, RateLimitError } from "./errors.js";
import { consentPage, messagePage, type PageLinks } from "./pages.js";
import { RULES, Throttle } from "./throttle.js";
import { isResultKey, SEALED_TOKEN_PATTERN } from "./tokens.js";

const opaque = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const verifier = z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/);
const sealed = z.string().regex(SEALED_TOKEN_PATTERN);
const scope = z.string().regex(/^[\x21-\x7e]{1,256}$/);

const startSchema = z
  .object({
    browserChallenge: opaque,
    installationOrigin: z.string().min(1).max(512),
    returnUrl: z.string().min(1).max(512),
    /** The installation's correlation value, echoed back with the result. */
    state: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
    resultKey: z.string().refine(isResultKey),
    scopes: z.array(scope).min(1).max(32),
  })
  .strict();
const requestSchema = z.object({ requestId: sealed }).strict();
const emptyQuerySchema = z.object({}).strict();
const authorizeSchema = z
  .object({ requestId: sealed, csrfToken: opaque, browserProof: verifier })
  .strict();
const refreshSchema = z
  .object({
    clientId: z.string().min(1).max(512),
    refreshToken: z.string().min(1).max(16_384),
  })
  .strict();
/** Providers append parameters of their own (scope, authuser, iss, …); only these matter. */
const callbackSchema = z
  .object({
    state: sealed,
    code: z.string().min(1).max(8192).optional(),
    error: z.string().min(1).max(256).optional(),
  })
  .refine((value) => Boolean(value.code) !== Boolean(value.error));

const MAX_SERVER_BODY = 24 * 1024;

function nonce(): string {
  return crypto.randomBytes(18).toString("base64url");
}

type RouterDeps = { publicUrl: string; throttle: Throttle; links: PageLinks };

/**
 * One provider under one protocol path. Browser routes answer with pages;
 * installation routes are JSON, server-to-server only.
 */
export function createProtocolRouter(broker: Broker, deps: RouterDeps): express.Router {
  return buildRouter(broker, deps, "sign-in");
}

/**
 * Renewal alone, for a path that once issued Connections but starts no new
 * sign-ins: every Connection renews on the path that issued it, for as long as
 * it exists.
 */
export function createRenewalRouter(broker: Broker, deps: RouterDeps): express.Router {
  return buildRouter(broker, deps, "renewal");
}

function buildRouter(
  broker: Broker,
  deps: RouterDeps,
  routes: "sign-in" | "renewal",
): express.Router {
  const router = express.Router();
  const { protocol, provider } = broker;
  const { throttle, links } = deps;
  const secureCookies = deps.publicUrl.startsWith("https://");
  const bucket = (req: Request, action: string) =>
    Throttle.key(provider.id, action, req.ip ?? req.socket.remoteAddress ?? "unknown");

  function pageCsp(res: Response, styleNonce: string, scriptNonce?: string, formAction = "'none'") {
    res.setHeader(
      "Content-Security-Policy",
      `default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action ${formAction}; img-src 'self'; style-src 'nonce-${styleNonce}'${scriptNonce ? `; script-src 'nonce-${scriptNonce}'` : ""}`,
    );
  }

  function sendError(res: Response, status: number, detail: string) {
    const styleNonce = nonce();
    pageCsp(res, styleNonce);
    res
      .status(status)
      .type("html")
      .send(
        messagePage({
          title: "Sign-in could not continue",
          detail,
          tone: "error",
          styleNonce,
          links,
        }),
      );
  }

  type Handler = (req: Request, res: Response) => Promise<unknown>;
  function handle(handler: Handler, browser = false) {
    return async (req: Request, res: Response, next: NextFunction) => {
      try {
        await handler(req, res);
      } catch (error) {
        if (!(error instanceof ConnectError)) return next(error);
        if (error instanceof RateLimitError) {
          res.setHeader("Retry-After", String(error.retryAfterSeconds));
        }
        if (browser) {
          sendError(res, error.status, error.message);
        } else {
          res.status(error.status).json({ error: error.message });
        }
      }
    };
  }

  function validate<T>(schema: z.ZodType<T>, source: "body" | "query", browser = false) {
    return (req: Request, res: Response, next: NextFunction) => {
      const parsed = schema.safeParse(req[source]);
      if (parsed.success) {
        (req as unknown as Record<string, unknown>)[source === "body" ? "body" : "validQuery"] =
          parsed.data;
        return next();
      }
      if (browser) {
        return sendError(
          res,
          400,
          "This sign-in link is not valid. Return to your Genosyn installation and start again.",
        );
      }
      return res.status(400).json({ error: "Invalid request" });
    };
  }
  const query = <T>(req: Request) => (req as unknown as { validQuery: T }).validQuery;

  function browserCookie(req: Request, token: string): string {
    const name = broker.cookieName(token);
    const value =
      (req.headers.cookie ?? "")
        .split(";")
        .map((part) => part.trim())
        .find((part) => part.startsWith(`${name}=`))
        ?.slice(name.length + 1) ?? "";
    return opaque.safeParse(value).success ? value : "";
  }

  function setFlowCookie(res: Response, token: string, value: string, expiresAt: number) {
    res.cookie(broker.cookieName(token), value, {
      httpOnly: true,
      secure: secureCookies,
      sameSite: "lax",
      path: protocol.basePath,
      maxAge: Math.max(0, expiresAt - Date.now()),
    });
  }

  /** Installation endpoints are called by servers. A browser never authenticates here. */
  function serverJson(req: Request, res: Response, next: NextFunction) {
    if (req.headers.origin !== undefined || req.headers["sec-fetch-site"] !== undefined) {
      return res
        .status(403)
        .json({ error: "Use your Genosyn installation to connect an Integration." });
    }
    if (!req.is("application/json")) {
      return res.status(415).json({ error: "A JSON request is required." });
    }
    if (Number(req.headers["content-length"] ?? 0) > MAX_SERVER_BODY) {
      return res.status(413).json({ error: "Sign-in request is too large." });
    }
    next();
  }
  const json = express.json({ limit: MAX_SERVER_BODY, strict: true });
  /** body-parser rejections (size, syntax, charset) are the client's fault, never a 500. */
  function parserStatus(error: unknown): number | null {
    const { type, status } = (error ?? {}) as { type?: unknown; status?: unknown };
    return typeof type === "string" && typeof status === "number" && status >= 400 && status < 500
      ? status
      : null;
  }
  function jsonErrors(error: unknown, _req: Request, res: Response, next: NextFunction) {
    const status = parserStatus(error);
    if (status === null) return next(error);
    res
      .status(status)
      .json({ error: status === 413 ? "Sign-in request is too large." : "Invalid request" });
  }
  function formErrors(error: unknown, _req: Request, res: Response, next: NextFunction) {
    const status = parserStatus(error);
    if (status === null) return next(error);
    sendError(
      res,
      status,
      "This sign-in request is not valid. Return to your Genosyn installation and start again.",
    );
  }

  router.post(
    "/refresh",
    serverJson,
    json,
    jsonErrors,
    validate(refreshSchema, "body"),
    handle(async (req, res) => {
      const body = req.body as z.infer<typeof refreshSchema>;
      const failures = bucket(req, "refresh-failure");
      throttle.check(failures);
      throttle.consume(
        Throttle.key(provider.id, "refresh-token", body.refreshToken),
        RULES.refreshToken,
      );
      try {
        res.json(await broker.refresh(body));
      } catch (error) {
        if (error instanceof ConnectError && error.status === 401) {
          throttle.record(failures, RULES.refreshFailure);
        }
        throw error;
      }
    }),
  );

  if (routes === "sign-in") {
    router.get(
      "/status",
      validate(emptyQuerySchema, "query"),
      handle(async (_req, res) => {
        res.json(await broker.status());
      }),
    );

    router.post(
      "/start",
      serverJson,
      json,
      jsonErrors,
      validate(startSchema, "body"),
      handle(async (req, res) => {
        throttle.consume(bucket(req, "start"), RULES.start);
        res.json(await broker.start(req.body as z.infer<typeof startSchema>));
      }),
    );

    router.get(
      "/authorize",
      validate(requestSchema, "query", true),
      handle(async (req, res) => {
        throttle.consume(bucket(req, "page"), RULES.page);
        const { requestId } = query<z.infer<typeof requestSchema>>(req);
        const prepared = await broker.prepare(requestId);
        const styleNonce = nonce();
        const scriptNonce = nonce();
        // The page talks to the window that opened it, so it must keep its opener.
        res.setHeader("Cross-Origin-Opener-Policy", "unsafe-none");
        // A no-referrer policy makes the form POST send `Origin: null`; the
        // exact-origin check needs the real one. Nothing is sent cross-origin.
        res.setHeader("Referrer-Policy", "same-origin");
        pageCsp(res, styleNonce, scriptNonce, `'self' ${provider.authorizationOrigin}`);
        setFlowCookie(res, requestId, prepared.browserNonce, prepared.expiresAt);
        res.type("html").send(
          consentPage({
            providerName: provider.name,
            continueLabel: provider.continueLabel,
            protocol,
            requestId,
            browserNonce: prepared.browserNonce,
            installationOrigin: prepared.installationOrigin,
            access: prepared.access,
            styleNonce,
            scriptNonce,
            links,
          }),
        );
      }, true),
    );

    router.post(
      "/authorize",
      express.urlencoded({ extended: false, limit: "16kb", parameterLimit: 3 }),
      formErrors,
      validate(authorizeSchema, "body", true),
      handle(async (req, res) => {
        throttle.consume(bucket(req, "authorize"), RULES.authorize);
        const { requestId, csrfToken, browserProof } = req.body as z.infer<typeof authorizeSchema>;
        const nonceValue = browserCookie(req, requestId);
        // The service's own configured origin, never one derived from the request.
        if (
          req.headers.origin !== deps.publicUrl ||
          req.headers["sec-fetch-site"] === "cross-site" ||
          !nonceValue ||
          !crypto.timingSafeEqual(Buffer.from(nonceValue), Buffer.from(csrfToken))
        ) {
          throw new ConnectError("This sign-in request did not come from the sign-in page.", 403);
        }
        const started = await broker.authorize({
          requestId,
          browserNonce: nonceValue,
          browserProof,
        });
        setFlowCookie(res, requestId, "", 0);
        setFlowCookie(res, started.state, nonceValue, started.expiresAt);
        res.setHeader("Referrer-Policy", "no-referrer");
        res.redirect(303, started.authorizeUrl);
      }, true),
    );

    router.get(
      "/callback",
      validate(callbackSchema, "query", true),
      handle(async (req, res) => {
        throttle.consume(bucket(req, "callback"), RULES.callback);
        const callback = query<z.infer<typeof callbackSchema>>(req);
        const completed = await broker.complete({
          ...callback,
          browserNonce: browserCookie(req, callback.state),
        });
        setFlowCookie(res, callback.state, "", 0);
        // Back to the installation's own page. The result is in the fragment,
        // which the browser keeps to itself; no referrer carries this URL on.
        res.setHeader("Referrer-Policy", "no-referrer");
        res.redirect(303, completed.location);
      }, true),
    );
  }

  router.use((_req, res) => {
    res.status(404).json({ error: "Sign-in endpoint not found" });
  });

  return router;
}
