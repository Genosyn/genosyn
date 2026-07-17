import { Router } from "express";
import { z } from "zod";
import { getPublicSsoStatus } from "../services/ssoSettings.js";
import { finishSsoLogin, startSsoLogin, SsoLoginError } from "../services/ssoLogin.js";

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
    res.json(await getPublicSsoStatus());
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

ssoRouter.get("/start", async (_req, res) => {
  try {
    const { authorizeUrl } = await startSsoLogin();
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
    const user = await finishSsoLogin({ code, state });
    req.session = { userId: user.id };
    res.redirect("/");
  } catch (err) {
    loginErrorRedirect(res, ssoErrorMessage(err));
  }
});
