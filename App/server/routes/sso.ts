import { Router } from "express";
import { z } from "zod";
import { billingEnabled } from "../services/billing/billingSettings.js";
import { getPublicSsoStatus } from "../services/ssoSettings.js";
import { finishSsoLogin, startSsoLogin, SsoLoginError } from "../services/ssoLogin.js";
import { requireTwoFactorAfterPrimaryAuth } from "./twoFactor.js";
import { establishUserSession } from "../middleware/auth.js";
import { capturePublicUrlFromMasterAdminRequest } from "../services/publicUrl.js";
import { claimBootstrapMasterAdminIfEligible } from "../services/emailVerification.js";
import { config } from "../../config.js";

/**
 * Public SSO sign-in surface, mounted at `/api/auth/sso` (before the main
 * auth router, so its more-specific paths win).
 *
 * Everything here is session-less until the very last step: `/status` is the
 * login page's probe, `/start` bounces the browser to the identity provider,
 * and `/callback` receives it back — trust comes from the single-use `state`
 * token minted in `startSsoLogin`, not from a cookie. Only after the code
 * exchange + userinfo read succeed does the callback write the session and
 * land the browser on the app. Failures redirect back to `/login?ssoError=…`
 * so the login page can show what happened.
 */
export const ssoRouter = Router();

ssoRouter.get("/status", async (_req, res, next) => {
  try {
    // `companySso` is true on billing-enabled (Genosyn Cloud) installs — the
    // login page uses it to offer company SSO sign-in. Company SSO itself
    // ships in a later phase; the field ships now (M56).
    res.json({ ...(await getPublicSsoStatus()), companySso: await billingEnabled() });
  } catch (err) {
    next(err);
  }
});

function loginErrorRedirect(res: import("express").Response, message: string): void {
  res.redirect(`/login?ssoError=${encodeURIComponent(message)}`);
}

function ssoErrorMessage(err: unknown): string {
  if (err instanceof SsoLoginError) return err.message;
  // eslint-disable-next-line no-console
  console.error("[sso] sign-in failed:", err);
  return "SSO sign-in failed — check the server logs for details.";
}

ssoRouter.get("/start", async (req, res) => {
  try {
    const { authorizeUrl, browserBinding } = await startSsoLogin();
    req.session = { ...(req.session ?? {}), ssoBrowserBinding: browserBinding };
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

ssoRouter.get("/callback", async (req, res) => {
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
    const browserBinding = req.session?.ssoBrowserBinding ?? "";
    const user = await finishSsoLogin({ code, state, browserBinding });
    if (req.session) delete req.session.ssoBrowserBinding;
    await claimBootstrapMasterAdminIfEligible(user);
    const methods = await requireTwoFactorAfterPrimaryAuth(req, user);
    if (methods.enabled) {
      return res.redirect("/login?twoFactor=1");
    }
    establishUserSession(req, user);
    if (user.isMasterAdmin && !config.security.multiTenant) {
      await capturePublicUrlFromMasterAdminRequest(req);
    }
    res.redirect("/");
  } catch (err) {
    loginErrorRedirect(res, ssoErrorMessage(err));
  }
});
