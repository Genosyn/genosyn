import { Router } from "express";
import { z } from "zod";
import {
  confirmCompanySsoLink,
  finishCompanySsoLogin,
  getCompanySsoPublicStatus,
  startCompanySsoLogin,
} from "../services/companySso.js";
import { SsoLoginError } from "../services/ssoLogin.js";
import { establishUserSession } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { requireTwoFactorAfterPrimaryAuth } from "./twoFactor.js";
import {
  assertAuthAllowed,
  AuthRateLimitError,
  authThrottleKeys,
  clearAuthFailures,
  recordAuthFailure,
} from "../services/authThrottle.js";

/**
 * Public per-company SSO surface (M56 Phase B), mounted at
 * `/api/auth/sso/company` — before the session-gated routers, like the
 * instance `/api/auth/sso`.
 *
 * `/:companySlug/status` is the login page's probe, `/:companySlug/start`
 * bounces the browser to the company's identity provider, and `/callback`
 * (shared — the state token carries the company) receives it back. `/link`
 * is the one JSON POST: it redeems the link-confirmation token minted when a
 * company IdP asserted an email that already belongs to a Genosyn account —
 * the person proves that account's password before the identity is bound.
 */
export const companySsoAuthRouter = Router();

function loginErrorRedirect(res: import("express").Response, message: string): void {
  res.redirect(`/login?ssoError=${encodeURIComponent(message)}`);
}

function ssoErrorMessage(err: unknown): string {
  if (err instanceof SsoLoginError) return err.message;
  // eslint-disable-next-line no-console
  console.error("[company-sso] sign-in failed:", err);
  return "SSO sign-in failed — check the server logs for details.";
}

const slugParamsSchema = z.object({ companySlug: z.string().min(1).max(200) });

companySsoAuthRouter.get("/:companySlug/status", async (req, res, next) => {
  const params = slugParamsSchema.safeParse(req.params);
  if (!params.success) {
    // Deliberately indistinguishable from an unknown slug.
    return res.json({ enabled: false, buttonLabel: null });
  }
  try {
    res.json(await getCompanySsoPublicStatus(params.data.companySlug));
  } catch (err) {
    next(err);
  }
});

companySsoAuthRouter.get("/:companySlug/start", async (req, res) => {
  const params = slugParamsSchema.safeParse(req.params);
  if (!params.success) {
    return loginErrorRedirect(res, "SSO sign-in is not available for this workspace.");
  }
  try {
    const { authorizeUrl, browserBinding } = await startCompanySsoLogin(params.data.companySlug);
    req.session = { ...(req.session ?? {}), companySsoBrowserBinding: browserBinding };
    res.redirect(authorizeUrl);
  } catch (err) {
    loginErrorRedirect(res, ssoErrorMessage(err));
  }
});

const callbackQuerySchema = z.object({
  code: z.string().optional(),
  state: z.string().optional(),
  error: z.string().optional(),
  error_description: z.string().optional(),
});

companySsoAuthRouter.get("/callback", async (req, res) => {
  const parsed = callbackQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return loginErrorRedirect(res, "SSO callback was malformed — try again.");
  }
  const { code, state, error, error_description: errorDescription } = parsed.data;
  if (error) {
    return loginErrorRedirect(
      res,
      error === "access_denied"
        ? "Sign-in was cancelled at the identity provider."
        : errorDescription || `The identity provider returned an error: ${error}`,
    );
  }
  if (!code || !state) {
    return loginErrorRedirect(res, "SSO callback was missing its code or state — try again.");
  }
  try {
    const browserBinding = req.session?.companySsoBrowserBinding ?? "";
    const result = await finishCompanySsoLogin({ code, state, browserBinding });
    if (req.session) delete req.session.companySsoBrowserBinding;
    if (result.kind === "link-required") {
      // An existing account matched by email only — never bound silently.
      // The login page collects that account's password and POSTs /link.
      return res.redirect(`/login?ssoLink=${encodeURIComponent(result.token)}`);
    }
    const methods = await requireTwoFactorAfterPrimaryAuth(req, result.user);
    if (methods.enabled) {
      return res.redirect("/login?twoFactor=1");
    }
    establishUserSession(req, result.user);
    res.redirect("/");
  } catch (err) {
    loginErrorRedirect(res, ssoErrorMessage(err));
  }
});

const linkSchema = z.object({
  token: z.string().min(1).max(500),
  password: z.string().min(1).max(1000),
});

companySsoAuthRouter.post("/link", validateBody(linkSchema), async (req, res, next) => {
  const { token, password } = req.body as z.infer<typeof linkSchema>;
  // Same throttle the password login uses — this endpoint accepts a password.
  const throttleKeys = authThrottleKeys(req, "company-sso-link");
  try {
    await assertAuthAllowed(throttleKeys);
  } catch (err) {
    if (!(err instanceof AuthRateLimitError)) return next(err);
    res.setHeader("Retry-After", String(err.retryAfterSeconds));
    return res.status(429).json({ error: err.message });
  }
  try {
    const outcome = await confirmCompanySsoLink({ token, password });
    if (outcome.status === "invalid-password") {
      await recordAuthFailure(throttleKeys);
      // The token is single-use, so the person restarts the SSO sign-in. An
      // SSO-only account has an unusable random hash — resetting mints one.
      return res.status(401).json({
        error:
          "That password is incorrect — start the SSO sign-in again to retry. If this account has never had a password, reset it from the login page first.",
      });
    }
    await clearAuthFailures(throttleKeys);
    const methods = await requireTwoFactorAfterPrimaryAuth(req, outcome.user);
    if (methods.enabled) {
      // Same shape the password login returns, so the client reuses its 2FA UI.
      return res.json({ requiresTwoFactor: true, methods });
    }
    establishUserSession(req, outcome.user);
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof SsoLoginError) {
      return res.status(400).json({ error: err.message });
    }
    next(err);
  }
});
