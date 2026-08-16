import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { AppDataSource } from "../db/datasource.js";
import { User } from "../db/entities/User.js";
import { requireAuth, requireBrowserSession } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import {
  beginTotpEnrollment,
  beginWebAuthnEnrollment,
  beginWebAuthnLogin,
  disableTwoFactor,
  finishTotpEnrollment,
  finishWebAuthnEnrollment,
  getTwoFactorLoginMethods,
  getTwoFactorStatus,
  regenerateRecoveryCodes,
  removeTotpCredential,
  removeWebAuthnCredential,
  TwoFactorError,
  useRecoveryCode,
  verifyTotpLogin,
  verifyWebAuthnLogin,
} from "../services/twoFactor.js";
import {
  beginTwoFactorLoginSession,
  clearWebAuthnChallenge,
  completeTwoFactorLogin,
  pendingTwoFactorUserId,
  readWebAuthnChallenge,
  recordTwoFactorFailure,
  rememberWebAuthnChallenge,
} from "../lib/twoFactorSession.js";
import {
  assertAuthAllowed,
  AuthRateLimitError,
  authThrottleKeys,
  clearAuthFailures,
  recordAuthFailure,
} from "../services/authThrottle.js";
import { capturePublicUrlFromMasterAdminRequest } from "../services/publicUrl.js";

export const twoFactorRouter = Router();

const emptySchema = z.object({}).default({});
const passwordSchema = z.object({ currentPassword: z.string().min(1).max(1000) });
const totpSchema = z.object({ code: z.string().regex(/^\d{6}$/, "Enter a 6-digit code") });
const recoverySchema = z.object({ code: z.string().min(8).max(64) });
const webAuthnResponseSchema = z
  .object({
    id: z.string().min(1).max(2048),
    rawId: z.string().min(1).max(2048),
    response: z.record(z.unknown()),
    type: z.literal("public-key"),
    clientExtensionResults: z.record(z.unknown()).optional(),
    authenticatorAttachment: z.string().nullable().optional(),
  })
  .passthrough();
const webAuthnVerifySchema = z.object({ response: webAuthnResponseSchema });
const totpEnrollmentSchema = z.object({
  currentPassword: z.string().min(1).max(1000),
  name: z.string().trim().min(1).max(100),
});
const webAuthnEnrollmentSchema = z.object({
  currentPassword: z.string().min(1).max(1000),
  name: z.string().trim().min(1).max(100),
  kind: z.enum(["passkey", "security_key"]),
});
const credentialParamsSchema = z.object({ id: z.string().uuid() });

function sendError(err: unknown, res: Response, next: NextFunction): void {
  if (err instanceof TwoFactorError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  next(err);
}

async function pendingUser(req: Request): Promise<User | null> {
  const userId = pendingTwoFactorUserId(req);
  if (!userId) return null;
  const user = await AppDataSource.getRepository(User).findOneBy({ id: userId });
  if (!user) req.session = null;
  return user;
}

function loginResponse(user: User) {
  return { id: user.id, email: user.email, name: user.name };
}

async function completeLogin(req: Request, user: User): Promise<void> {
  completeTwoFactorLogin(req, user.id, user.sessionVersion);
  if (user.isMasterAdmin && user.emailVerifiedAt) {
    await capturePublicUrlFromMasterAdminRequest(req);
  }
}

function twoFactorThrottleKeys(req: Request, userId: string): string[] {
  return authThrottleKeys(req, "two-factor", userId);
}

async function assertTwoFactorAllowed(
  req: Request,
  res: Response,
  userId: string,
): Promise<string[] | null> {
  const keys = twoFactorThrottleKeys(req, userId);
  try {
    await assertAuthAllowed(keys);
    return keys;
  } catch (error) {
    if (!(error instanceof AuthRateLimitError)) throw error;
    res.setHeader("Retry-After", String(error.retryAfterSeconds));
    res.status(429).json({ error: error.message });
    return null;
  }
}

async function invalidLoginFactor(
  req: Request,
  res: Response,
  keys: string[],
  message: string,
): Promise<void> {
  await recordAuthFailure(keys);
  const locked = recordTwoFactorFailure(req);
  res.status(401).json({
    error: locked ? "Too many failed attempts. Sign in with your password again." : message,
  });
}

// ───────────────────── Password/SSO second step ────────────────────────

twoFactorRouter.get("/login/two-factor", async (req, res, next) => {
  try {
    const user = await pendingUser(req);
    if (!user) {
      return res.status(401).json({ error: "Two-factor session expired. Sign in again." });
    }
    if (!(await assertTwoFactorAllowed(req, res, user.id))) return;
    const methods = await getTwoFactorLoginMethods(user.id);
    if (!methods.enabled) {
      // This branch covers a factor removed between primary auth and this
      // probe. It does not mint second-factor evidence.
      req.session = {
        userId: user.id,
        sessionVersion: user.sessionVersion,
        authenticatedAt: req.session?.primaryAuthenticatedAt ?? Date.now(),
      };
      return res.json({ requiresTwoFactor: false });
    }
    res.json({ requiresTwoFactor: true, methods });
  } catch (err) {
    sendError(err, res, next);
  }
});

twoFactorRouter.post("/login/two-factor/totp", validateBody(totpSchema), async (req, res, next) => {
  try {
    const user = await pendingUser(req);
    if (!user) {
      return res.status(401).json({ error: "Two-factor session expired. Sign in again." });
    }
    const throttleKeys = await assertTwoFactorAllowed(req, res, user.id);
    if (!throttleKeys) return;
    const { code } = req.body as z.infer<typeof totpSchema>;
    if (!(await verifyTotpLogin(user, code))) {
      await invalidLoginFactor(
        req,
        res,
        throttleKeys,
        "That verification code is invalid or expired",
      );
      return;
    }
    await clearAuthFailures(throttleKeys);
    await completeLogin(req, user);
    res.json(loginResponse(user));
  } catch (err) {
    sendError(err, res, next);
  }
});

twoFactorRouter.post(
  "/login/two-factor/recovery",
  validateBody(recoverySchema),
  async (req, res, next) => {
    try {
      const user = await pendingUser(req);
      if (!user) {
        return res.status(401).json({ error: "Two-factor session expired. Sign in again." });
      }
      const throttleKeys = await assertTwoFactorAllowed(req, res, user.id);
      if (!throttleKeys) return;
      const { code } = req.body as z.infer<typeof recoverySchema>;
      if (!(await useRecoveryCode(user, code))) {
        await invalidLoginFactor(
          req,
          res,
          throttleKeys,
          "That recovery code is invalid or has been used",
        );
        return;
      }
      await clearAuthFailures(throttleKeys);
      await completeLogin(req, user);
      res.json(loginResponse(user));
    } catch (err) {
      sendError(err, res, next);
    }
  },
);

twoFactorRouter.post(
  "/login/two-factor/webauthn/options",
  validateBody(emptySchema),
  async (req, res, next) => {
    try {
      const user = await pendingUser(req);
      if (!user) {
        return res.status(401).json({ error: "Two-factor session expired. Sign in again." });
      }
      if (!(await assertTwoFactorAllowed(req, res, user.id))) return;
      const options = await beginWebAuthnLogin(user.id);
      rememberWebAuthnChallenge(req, { challenge: options.challenge, purpose: "login" });
      res.json(options);
    } catch (err) {
      sendError(err, res, next);
    }
  },
);

twoFactorRouter.post(
  "/login/two-factor/webauthn/verify",
  validateBody(webAuthnVerifySchema),
  async (req, res, next) => {
    try {
      const user = await pendingUser(req);
      if (!user) {
        return res.status(401).json({ error: "Two-factor session expired. Sign in again." });
      }
      const throttleKeys = await assertTwoFactorAllowed(req, res, user.id);
      if (!throttleKeys) return;
      const challenge = readWebAuthnChallenge(req, "login");
      if (!challenge) {
        return res.status(400).json({ error: "Security-key challenge expired. Try again." });
      }
      const { response } = req.body as z.infer<typeof webAuthnVerifySchema>;
      const verified = await verifyWebAuthnLogin({
        userId: user.id,
        expectedChallenge: challenge.challenge,
        response: response as unknown as AuthenticationResponseJSON,
      });
      if (!verified) {
        clearWebAuthnChallenge(req);
        await invalidLoginFactor(
          req,
          res,
          throttleKeys,
          "The passkey or security key could not be verified",
        );
        return;
      }
      await clearAuthFailures(throttleKeys);
      await completeLogin(req, user);
      res.json(loginResponse(user));
    } catch (err) {
      sendError(err, res, next);
    }
  },
);

// ───────────────────── Authenticated account settings ──────────────────

twoFactorRouter.use("/two-factor", requireAuth, requireBrowserSession);

twoFactorRouter.get("/two-factor", async (req, res, next) => {
  try {
    res.json(await getTwoFactorStatus(req.user!.id));
  } catch (err) {
    sendError(err, res, next);
  }
});

twoFactorRouter.post(
  "/two-factor/totp/setup",
  validateBody(totpEnrollmentSchema),
  async (req, res, next) => {
    try {
      const body = req.body as z.infer<typeof totpEnrollmentSchema>;
      const setup = await beginTotpEnrollment(req.user!, body.currentPassword, body.name);
      if (req.session) {
        req.session.totpSetupId = setup.credentialId;
        req.session.totpSetupExpiresAt = Date.now() + 10 * 60 * 1000;
      }
      res.json(setup);
    } catch (err) {
      sendError(err, res, next);
    }
  },
);

twoFactorRouter.post(
  "/two-factor/totp/verify",
  validateBody(totpSchema),
  async (req, res, next) => {
    try {
      const setupId = req.session?.totpSetupId;
      if (
        !setupId ||
        !req.session?.totpSetupExpiresAt ||
        req.session.totpSetupExpiresAt <= Date.now()
      ) {
        return res.status(400).json({ error: "Authenticator setup expired. Start again." });
      }
      const { code } = req.body as z.infer<typeof totpSchema>;
      const result = await finishTotpEnrollment(req.user!, setupId, code);
      delete req.session.totpSetupId;
      delete req.session.totpSetupExpiresAt;
      res.json(result);
    } catch (err) {
      sendError(err, res, next);
    }
  },
);

twoFactorRouter.post(
  "/two-factor/totp/:id/remove",
  validateBody(passwordSchema),
  async (req, res, next) => {
    const params = credentialParamsSchema.safeParse(req.params);
    if (!params.success) {
      return res.status(400).json({ error: "Invalid authenticator id" });
    }
    try {
      const { currentPassword } = req.body as z.infer<typeof passwordSchema>;
      res.json(
        await removeTotpCredential({
          user: req.user!,
          credentialId: params.data.id,
          password: currentPassword,
        }),
      );
    } catch (err) {
      sendError(err, res, next);
    }
  },
);

twoFactorRouter.post(
  "/two-factor/webauthn/options",
  validateBody(webAuthnEnrollmentSchema),
  async (req, res, next) => {
    try {
      const body = req.body as z.infer<typeof webAuthnEnrollmentSchema>;
      const options = await beginWebAuthnEnrollment({
        user: req.user!,
        password: body.currentPassword,
        kind: body.kind,
      });
      rememberWebAuthnChallenge(req, {
        challenge: options.challenge,
        purpose: "registration",
        credentialName: body.name,
        credentialKind: body.kind,
      });
      res.json(options);
    } catch (err) {
      sendError(err, res, next);
    }
  },
);

twoFactorRouter.post(
  "/two-factor/webauthn/verify",
  validateBody(webAuthnVerifySchema),
  async (req, res, next) => {
    try {
      const challenge = readWebAuthnChallenge(req, "registration");
      if (!challenge?.credentialName || !challenge.credentialKind) {
        return res.status(400).json({ error: "Registration challenge expired. Try again." });
      }
      const { response } = req.body as z.infer<typeof webAuthnVerifySchema>;
      const result = await finishWebAuthnEnrollment({
        user: req.user!,
        expectedChallenge: challenge.challenge,
        response: response as unknown as RegistrationResponseJSON,
        name: challenge.credentialName,
        kind: challenge.credentialKind,
      });
      clearWebAuthnChallenge(req);
      res.json(result);
    } catch (err) {
      clearWebAuthnChallenge(req);
      sendError(err, res, next);
    }
  },
);

twoFactorRouter.post(
  "/two-factor/webauthn/:id/remove",
  validateBody(passwordSchema),
  async (req, res, next) => {
    const params = credentialParamsSchema.safeParse(req.params);
    if (!params.success) {
      return res.status(400).json({ error: "Invalid credential id" });
    }
    try {
      const { currentPassword } = req.body as z.infer<typeof passwordSchema>;
      res.json(
        await removeWebAuthnCredential({
          user: req.user!,
          credentialId: params.data.id,
          password: currentPassword,
        }),
      );
    } catch (err) {
      sendError(err, res, next);
    }
  },
);

twoFactorRouter.post(
  "/two-factor/recovery/regenerate",
  validateBody(passwordSchema),
  async (req, res, next) => {
    try {
      const { currentPassword } = req.body as z.infer<typeof passwordSchema>;
      res.json(await regenerateRecoveryCodes(req.user!, currentPassword));
    } catch (err) {
      sendError(err, res, next);
    }
  },
);

twoFactorRouter.post(
  "/two-factor/disable",
  validateBody(passwordSchema),
  async (req, res, next) => {
    try {
      const { currentPassword } = req.body as z.infer<typeof passwordSchema>;
      res.json(await disableTwoFactor(req.user!, currentPassword));
    } catch (err) {
      sendError(err, res, next);
    }
  },
);

/** Shared by password and SSO entrypoints after their primary check passes. */
export async function requireTwoFactorAfterPrimaryAuth(
  req: Request,
  user: User,
): Promise<ReturnType<typeof getTwoFactorLoginMethods>> {
  const methods = await getTwoFactorLoginMethods(user.id);
  if (methods.enabled) beginTwoFactorLoginSession(req, user.id);
  return methods;
}
