import type { NextFunction, Request, Response } from "express";
import { Router } from "express";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { z } from "zod";
import { config } from "../../config.js";
import { validateBody } from "../middleware/validate.js";
import { establishUserSession } from "../middleware/auth.js";
import {
  AuthRateLimitError,
  authThrottleKeys,
  clearAuthFailures,
  consumeAuthAttempt,
} from "../services/authThrottle.js";
import {
  finishPasskeyLogin,
  PasskeyLoginStateError,
  startPasskeyLogin,
} from "../services/passkeyLogin.js";
import { capturePublicUrlFromMasterAdminRequest } from "../services/publicUrl.js";
import {
  claimBootstrapMasterAdminIfEligible,
  emailVerificationRequired,
} from "../services/emailVerification.js";

export const passkeyLoginRouter = Router();

const emptySchema = z.object({}).default({});
const authenticationResponseSchema = z
  .object({
    id: z.string().min(1).max(2048),
    rawId: z.string().min(1).max(2048),
    response: z.object({
      authenticatorData: z.string().min(1).max(8192),
      clientDataJSON: z.string().min(1).max(8192),
      signature: z.string().min(1).max(8192),
      userHandle: z.string().min(1).max(1024).nullable().optional(),
    }),
    type: z.literal("public-key"),
    clientExtensionResults: z.record(z.unknown()).optional(),
    authenticatorAttachment: z.string().nullable().optional(),
  })
  .passthrough();
const verifySchema = z.object({
  flowToken: z.string().min(1).max(512),
  response: authenticationResponseSchema,
});

async function consumeThrottle(
  keys: string[],
  res: Response,
  next: NextFunction,
): Promise<boolean> {
  try {
    await consumeAuthAttempt(keys);
    return true;
  } catch (error) {
    if (!(error instanceof AuthRateLimitError)) {
      next(error);
      return false;
    }
    res.setHeader("Retry-After", String(error.retryAfterSeconds));
    res.status(429).json({ error: error.message });
    return false;
  }
}

passkeyLoginRouter.post(
  "/login/passkey/options",
  validateBody(emptySchema),
  async (req, res, next) => {
    const throttleKeys = authThrottleKeys(req, "passkey-login-options");
    if (!(await consumeThrottle(throttleKeys, res, next))) return;
    try {
      // Challenge creation writes encrypted, short-lived state. Count every
      // issuance so an unauthenticated caller cannot turn that write into an
      // unbounded database/cleanup workload.
      const started = await startPasskeyLogin(req.session?.passkeyBrowserBinding);
      req.session = { ...(req.session ?? {}), passkeyBrowserBinding: started.browserBinding };
      res.json({ options: started.options, flowToken: started.flowToken });
    } catch (error) {
      next(error);
    }
  },
);

passkeyLoginRouter.post(
  "/login/passkey/verify",
  validateBody(verifySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    const { flowToken, response } = req.body as z.infer<typeof verifySchema>;
    const throttleKeys = authThrottleKeys(req, "passkey-login", response.id);
    if (!(await consumeThrottle(throttleKeys, res, next))) return;
    const browserBinding = req.session?.passkeyBrowserBinding ?? "";
    try {
      const user = await finishPasskeyLogin({
        flowToken,
        browserBinding,
        response: response as unknown as AuthenticationResponseJSON,
      });
      if (!user) {
        return res.status(401).json({ error: "The passkey could not be verified" });
      }
      await claimBootstrapMasterAdminIfEligible(user);
      await clearAuthFailures([...throttleKeys, ...authThrottleKeys(req, "passkey-login-options")]);
      await establishUserSession(req, user, { secondFactor: true });
      // Keep the browser nonce so another tab that started before this one
      // completed can finish its own independent ceremony.
      req.session = { ...req.session!, passkeyBrowserBinding: browserBinding };
      if (user.isMasterAdmin && user.emailVerifiedAt && !config.security.multiTenant) {
        await capturePublicUrlFromMasterAdminRequest(req);
      }
      res.json({
        id: user.id,
        email: user.email,
        name: user.name,
        emailVerificationRequired: emailVerificationRequired(user),
      });
    } catch (error) {
      if (error instanceof PasskeyLoginStateError) {
        return res.status(400).json({ error: error.message });
      }
      next(error);
    }
  },
);
