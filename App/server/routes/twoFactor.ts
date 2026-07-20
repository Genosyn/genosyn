import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { AppDataSource } from "../db/datasource.js";
import { User } from "../db/entities/User.js";
import { requireAuth } from "../middleware/auth.js";
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
  removeTotp,
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

function invalidLoginFactor(req: Request, res: Response, message: string): void {
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
    const methods = await getTwoFactorLoginMethods(user.id);
    if (!methods.enabled) {
      completeTwoFactorLogin(req, user.id);
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
    const { code } = req.body as z.infer<typeof totpSchema>;
    if (!(await verifyTotpLogin(user, code))) {
      return invalidLoginFactor(req, res, "That verification code is invalid or expired");
    }
    completeTwoFactorLogin(req, user.id);
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
      const { code } = req.body as z.infer<typeof recoverySchema>;
      if (!(await useRecoveryCode(user, code))) {
        return invalidLoginFactor(req, res, "That recovery code is invalid or has been used");
      }
      completeTwoFactorLogin(req, user.id);
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
        return invalidLoginFactor(req, res, "The passkey or security key could not be verified");
      }
      completeTwoFactorLogin(req, user.id);
      res.json(loginResponse(user));
    } catch (err) {
      sendError(err, res, next);
    }
  },
);

// ───────────────────── Authenticated account settings ──────────────────

twoFactorRouter.use("/two-factor", requireAuth);

twoFactorRouter.get("/two-factor", async (req, res, next) => {
  try {
    res.json(await getTwoFactorStatus(req.user!.id));
  } catch (err) {
    sendError(err, res, next);
  }
});

twoFactorRouter.post(
  "/two-factor/totp/setup",
  validateBody(passwordSchema),
  async (req, res, next) => {
    try {
      const { currentPassword } = req.body as z.infer<typeof passwordSchema>;
      const setup = await beginTotpEnrollment(req.user!, currentPassword);
      if (req.session) req.session.totpSetupExpiresAt = Date.now() + 10 * 60 * 1000;
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
      if (!req.session?.totpSetupExpiresAt || req.session.totpSetupExpiresAt <= Date.now()) {
        return res.status(400).json({ error: "Authenticator setup expired. Start again." });
      }
      const { code } = req.body as z.infer<typeof totpSchema>;
      const result = await finishTotpEnrollment(req.user!, code);
      delete req.session.totpSetupExpiresAt;
      res.json(result);
    } catch (err) {
      sendError(err, res, next);
    }
  },
);

twoFactorRouter.post(
  "/two-factor/totp/remove",
  validateBody(passwordSchema),
  async (req, res, next) => {
    try {
      const { currentPassword } = req.body as z.infer<typeof passwordSchema>;
      res.json(await removeTotp(req.user!, currentPassword));
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
