import express, {
  Router,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import { z } from "zod";
import { requireAuth, requireBrowserSession } from "../middleware/auth.js";
import { validateBody, validateQuery } from "../middleware/validate.js";
import {
  AuthRateLimitError,
  authThrottleKeys,
  consumeAuthAttempt,
} from "../services/authThrottle.js";
import {
  ConsentError,
  consentDetails,
  decideConsent,
  startAuthorization,
} from "../services/mcpOauth/authorization.js";
import {
  authenticateClient,
  clientRegistrationSchema,
  OAuthProtocolError,
  presentedClient,
  registerClient,
  REGISTRATION_RATE_LIMIT,
} from "../services/mcpOauth/clients.js";
import {
  authorizationServerMetadata,
  protectedResourceMetadata,
} from "../services/mcpOauth/metadata.js";
import {
  exchangeAuthorizationCode,
  refreshTokens,
  revokeTokenForClient,
} from "../services/mcpOauth/tokens.js";

/**
 * OAuth 2.1 for the Genosyn MCP server, so an MCP client that signs in rather
 * than sending a key — claude.ai and ChatGPT's connectors, among others — can
 * connect, as the MCP authorization spec describes:
 *
 * 1. The MCP endpoint answers a request without a credential with a 401 that
 *    points at its protected-resource metadata (`oauthDiscoveryRouter`).
 * 2. The client registers itself (`POST /api/oauth/register`).
 * 3. It sends the Member's browser to `GET /oauth/authorize`, which hands the
 *    request to the consent page; the Member signs in, picks the company if
 *    the client did not name one, and approves (`oauthConsentRouter`).
 * 4. The browser returns to the client with a code, which it exchanges, with
 *    its PKCE verifier, for an access and a refresh token
 *    (`POST /api/oauth/token`).
 *
 * The token is a connected app: it acts as that Member in that company through
 * the MCP server and nowhere else (`services/mcpOauth/`). The machine
 * endpoints read no cookie and are mounted before the session; only the
 * consent page's own calls need the Member signed in.
 */

/** Public metadata, read without credentials: any web page may read it. */
const readableByAnyOrigin: RequestHandler = (_req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  next();
};

/** RFC 9728 and RFC 8414 discovery. Mounted at `/.well-known`. */
export const oauthDiscoveryRouter = Router();

const resourceParams = z.object({ cid: z.string().uuid() });

oauthDiscoveryRouter.get(
  "/oauth-protected-resource/api/companies/:cid/mcp",
  readableByAnyOrigin,
  (req: Request, res: Response) => {
    const parsed = resourceParams.safeParse(req.params);
    if (!parsed.success) return res.status(404).json({ error: "not_found" });
    res.json(protectedResourceMetadata(parsed.data.cid.toLowerCase()));
  },
);

oauthDiscoveryRouter.get("/oauth-authorization-server", readableByAnyOrigin, (_req, res) => {
  res.json(authorizationServerMetadata());
});

// Nothing else is published under these names. Answer 404 rather than the
// App's HTML shell, so a client trying the next discovery URL moves on.
for (const name of [
  "/oauth-protected-resource",
  "/oauth-authorization-server",
  "/openid-configuration",
]) {
  oauthDiscoveryRouter.use(name, readableByAnyOrigin, (_req: Request, res: Response) => {
    res.status(404).json({ error: "not_found" });
  });
}

/** The authorization endpoint, a browser navigation. Mounted at `/oauth`. */
export const oauthAuthorizeRouter = Router();

const queryValue = z.string().max(4000).optional();

/**
 * Size and shape only. What each parameter must be — and whether a mistake is
 * shown here or sent back to the client — is `startAuthorization`'s call.
 */
const authorizeQuery = z
  .object({
    response_type: queryValue,
    client_id: queryValue,
    redirect_uri: queryValue,
    state: queryValue,
    code_challenge: queryValue,
    code_challenge_method: queryValue,
    scope: queryValue,
    resource: z.union([z.string().max(4000), z.array(z.string().max(4000)).max(5)]).optional(),
  })
  .passthrough();

oauthAuthorizeRouter.get("/authorize", (req: Request, res: Response, next: NextFunction) => {
  res.setHeader("Cache-Control", "no-store");
  const parsed = authorizeQuery.safeParse(req.query);
  if (!parsed.success) return res.redirect(302, "/oauth/consent?error=invalid_request");
  startAuthorization(parsed.data)
    .then((outcome) => res.redirect(302, outcome.location))
    .catch(next);
});

/**
 * Registration, token and revocation: called by OAuth clients' servers with no
 * cookie and no browser. Mounted at `/api/oauth`, ahead of the session.
 */
export const oauthServerRouter = Router();

const formBody = express.urlencoded({ extended: false, limit: "64kb", parameterLimit: 50 });

function noStore(res: Response): void {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
}

function sendOAuthError(res: Response, error: OAuthProtocolError, basic = false): void {
  noStore(res);
  if (error.status === 401 && basic) res.setHeader("WWW-Authenticate", 'Basic realm="Genosyn"');
  res.status(error.status).json({ error: error.error, error_description: error.description });
}

function invalidRequest(error: z.ZodError): OAuthProtocolError {
  const issue = error.issues[0];
  const field = issue?.path.join(".") || "body";
  return new OAuthProtocolError("invalid_request", `${field}: ${issue?.message ?? "invalid"}`);
}

oauthServerRouter.post("/register", async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Registration is open and writes a row, so one address may only do so
    // a few times an hour; claude.ai and ChatGPT register once per setup.
    await consumeAuthAttempt(
      authThrottleKeys(req, "mcp-oauth-registration"),
      REGISTRATION_RATE_LIMIT,
    );
  } catch (error) {
    if (!(error instanceof AuthRateLimitError)) return next(error);
    res.setHeader("Retry-After", String(error.retryAfterSeconds));
    noStore(res);
    return res.status(429).json({
      error: "temporarily_unavailable",
      error_description: `Too many registrations from this address. Try again in ${error.retryAfterSeconds} seconds.`,
    });
  }
  const parsed = clientRegistrationSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    const issue = invalidRequest(parsed.error);
    return sendOAuthError(
      res,
      new OAuthProtocolError(
        parsed.error.issues[0]?.path[0] === "redirect_uris"
          ? "invalid_redirect_uri"
          : "invalid_client_metadata",
        issue.description,
      ),
    );
  }
  try {
    const information = await registerClient(parsed.data);
    noStore(res);
    res.status(201).json(information);
  } catch (error) {
    if (error instanceof OAuthProtocolError) return sendOAuthError(res, error);
    next(error);
  }
});

const tokenRequest = z
  .object({
    grant_type: z.string().max(100),
    code: z.string().max(512).optional(),
    redirect_uri: z.string().max(2000).optional(),
    code_verifier: z.string().max(256).optional(),
    refresh_token: z.string().max(512).optional(),
    resource: z.string().max(2000).optional(),
    scope: z.string().max(1000).optional(),
    client_id: z.string().max(200).optional(),
    client_secret: z.string().max(512).optional(),
  })
  .passthrough();

oauthServerRouter.post(
  "/token",
  formBody,
  async (req: Request, res: Response, next: NextFunction) => {
    const parsed = tokenRequest.safeParse(req.body ?? {});
    if (!parsed.success) return sendOAuthError(res, invalidRequest(parsed.error));
    const body = parsed.data;
    const presented = presentedClient(req.headers.authorization, body);
    try {
      const client = await authenticateClient(presented);
      let tokens;
      if (body.grant_type === "authorization_code") {
        if (!body.code) throw new OAuthProtocolError("invalid_request", "code is required.");
        tokens = await exchangeAuthorizationCode({
          client,
          code: body.code,
          redirectUri: body.redirect_uri,
          codeVerifier: body.code_verifier,
          resource: body.resource,
        });
      } else if (body.grant_type === "refresh_token") {
        if (!body.refresh_token) {
          throw new OAuthProtocolError("invalid_request", "refresh_token is required.");
        }
        tokens = await refreshTokens({
          client,
          refreshToken: body.refresh_token,
          resource: body.resource,
        });
      } else {
        throw new OAuthProtocolError(
          "unsupported_grant_type",
          "grant_type must be authorization_code or refresh_token.",
        );
      }
      noStore(res);
      res.json(tokens);
    } catch (error) {
      if (error instanceof OAuthProtocolError) return sendOAuthError(res, error, presented.basic);
      next(error);
    }
  },
);

const revocationRequest = z
  .object({
    token: z.string().min(1).max(512),
    token_type_hint: z.string().max(100).optional(),
    client_id: z.string().max(200).optional(),
    client_secret: z.string().max(512).optional(),
  })
  .passthrough();

oauthServerRouter.post(
  "/revoke",
  formBody,
  async (req: Request, res: Response, next: NextFunction) => {
    const parsed = revocationRequest.safeParse(req.body ?? {});
    if (!parsed.success) return sendOAuthError(res, invalidRequest(parsed.error));
    const presented = presentedClient(req.headers.authorization, parsed.data);
    try {
      const client = await authenticateClient(presented);
      await revokeTokenForClient(client, parsed.data.token);
      noStore(res);
      res.status(200).end();
    } catch (error) {
      if (error instanceof OAuthProtocolError) return sendOAuthError(res, error, presented.basic);
      next(error);
    }
  },
);

// A body that is not form data or JSON, or is too large, still gets an OAuth error.
oauthServerRouter.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
  const type = (error as { type?: unknown } | null)?.type;
  if (
    type === "entity.parse.failed" ||
    type === "entity.too.large" ||
    type === "parameters.too.many"
  ) {
    return sendOAuthError(
      res,
      new OAuthProtocolError("invalid_request", "The request body could not be read."),
    );
  }
  next(error);
});

/**
 * The consent page's own calls: what the app asked for, and the Member's
 * answer. A signed-in browser session only — never a key or a connected app,
 * so no credential can approve more of them.
 */
export const oauthConsentRouter = Router();
oauthConsentRouter.use(requireAuth);
oauthConsentRouter.use(requireBrowserSession);

const sealedRequest = z
  .string()
  .min(1)
  .max(8000)
  .describe("The sealed authorization request from the consent page's URL.");

oauthConsentRouter.get(
  "/",
  validateQuery(z.object({ request: sealedRequest })),
  async (req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      res.json(await consentDetails(String(req.query.request), req.user!));
    } catch (error) {
      if (!(error instanceof ConsentError)) return next(error);
      res.status(error.status).json({ error: error.message });
    }
  },
);

const consentDecision = z.object({
  request: sealedRequest,
  decision: z.enum(["allow", "deny"]),
  companyId: z
    .string()
    .uuid()
    .optional()
    .describe("The company to connect the app to, when the app did not name one."),
});

oauthConsentRouter.post(
  "/",
  validateBody(consentDecision),
  async (req: Request, res: Response, next: NextFunction) => {
    const body = req.body as z.infer<typeof consentDecision>;
    res.setHeader("Cache-Control", "no-store");
    try {
      res.json(
        await decideConsent({
          sealed: body.request,
          user: req.user!,
          decision: body.decision,
          companyId: body.companyId,
        }),
      );
    } catch (error) {
      if (!(error instanceof ConsentError)) return next(error);
      res.status(error.status).json({ error: error.message });
    }
  },
);
