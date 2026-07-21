import fs from "node:fs";
import { Router } from "express";
import { z } from "zod";
import bcrypt from "bcrypt";
import { AppDataSource } from "../db/datasource.js";
import { User } from "../db/entities/User.js";
import { Membership } from "../db/entities/Membership.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { validateBody } from "../middleware/validate.js";
import { establishUserSession, requireAuth } from "../middleware/auth.js";
import { sendEmail } from "../services/email.js";
import { ensureUserHandle } from "../services/userHandle.js";
import { areSignupsDisabled } from "../services/signupSettings.js";
import { generateToken, hashToken } from "../lib/token.js";
import {
  avatarAbsPath,
  avatarUploadMiddleware,
  mimeFromKey,
  removeAvatarFile,
  replaceAvatarFile,
} from "../services/avatars.js";
import { config } from "../../config.js";
import { requireTwoFactorAfterPrimaryAuth } from "./twoFactor.js";
import {
  assertAuthAllowed,
  AuthRateLimitError,
  authThrottleKeys,
  clearAuthFailures,
  consumeAuthAttempt,
  recordAuthFailure,
} from "../services/authThrottle.js";
import {
  emailVerificationRequired,
  sendEmailVerification,
  verifyEmailToken,
} from "../services/emailVerification.js";

export const authRouter = Router();
const BCRYPT_ROUNDS = 12;
const PASSWORD_MIN_LENGTH = 12;

function hashOneTimeToken(token: string): string {
  return hashToken(token);
}

async function throttleAllowed(keys: string[], res: import("express").Response): Promise<boolean> {
  try {
    await assertAuthAllowed(keys);
    return true;
  } catch (error) {
    if (!(error instanceof AuthRateLimitError)) throw error;
    res.setHeader("Retry-After", String(error.retryAfterSeconds));
    res.status(429).json({ error: error.message });
    return false;
  }
}

const signupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(PASSWORD_MIN_LENGTH),
  name: z.string().min(1),
});

authRouter.post("/signup", validateBody(signupSchema), async (req, res) => {
  const { email, password, name } = req.body as z.infer<typeof signupSchema>;
  const throttleKeys = authThrottleKeys(req, "signup", email);
  if (!(await throttleAllowed(throttleKeys, res))) return;
  await consumeAuthAttempt(throttleKeys);
  const repo = AppDataSource.getRepository(User);
  const existing = await repo.findOneBy({ email: email.toLowerCase() });
  if (existing) return res.status(409).json({ error: "Email already registered" });
  // The very first account on a fresh install becomes the instance master
  // admin — the operator who stood the box up. Everyone after signs up as a
  // normal user until an existing master admin promotes them from Admin → Users.
  const isFirstUser = (await repo.count()) === 0;
  if (
    isFirstUser &&
    config.security.multiTenant &&
    email.trim().toLowerCase() !== config.security.bootstrapMasterAdminEmail.trim().toLowerCase()
  ) {
    return res.status(403).json({ error: "This email is not authorized to bootstrap the service" });
  }
  // Operators can turn off self-service sign-ups from Admin → Sign-ups. The
  // first-user bootstrap is always allowed through so an install with no users
  // can never lock itself out.
  const bootstrapEmail = config.security.bootstrapMasterAdminEmail.trim().toLowerCase();
  const isSaasBootstrap =
    config.security.multiTenant &&
    email.trim().toLowerCase() === bootstrapEmail &&
    (await repo.count({ where: { isMasterAdmin: true } })) === 0;
  if (!isFirstUser && !isSaasBootstrap && (await areSignupsDisabled())) {
    return res.status(403).json({
      error: "Sign-ups are disabled on this instance. Ask an administrator for an invitation.",
    });
  }
  const user = repo.create({
    email: email.toLowerCase(),
    name,
    passwordHash: await bcrypt.hash(password, BCRYPT_ROUNDS),
    isMasterAdmin: isFirstUser || isSaasBootstrap,
    resetToken: null,
    resetExpiresAt: null,
    emailVerifiedAt: null,
    emailVerificationTokenHash: null,
    emailVerificationExpiresAt: null,
    sessionVersion: 0,
  });
  await repo.save(user);
  await ensureUserHandle(user);
  establishUserSession(req, user);
  await sendEmailVerification(user);
  void sendEmail({
    to: user.email,
    subject: "Welcome to Genosyn",
    text: `Welcome aboard, ${user.name}. Genosyn is ready when you are.`,
    purpose: "welcome",
    triggeredByUserId: user.id,
  });
  res.json({
    id: user.id,
    email: user.email,
    name: user.name,
    emailVerificationRequired: emailVerificationRequired(user),
  });
});

/**
 * Public probe for the sign-up page: is self-service registration open right
 * now? Open when sign-ups aren't disabled, or when the install has no users yet
 * (the first account must always be creatable to bootstrap the master admin).
 * Deliberately leaks no more than that boolean.
 */
authRouter.get("/signup-status", async (_req, res) => {
  const userCount = await AppDataSource.getRepository(User).count();
  const closed = userCount > 0 && (await areSignupsDisabled());
  res.json({ open: !closed });
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

authRouter.post("/login", validateBody(loginSchema), async (req, res) => {
  const { email, password } = req.body as z.infer<typeof loginSchema>;
  const throttleKeys = authThrottleKeys(req, "login", email);
  if (!(await throttleAllowed(throttleKeys, res))) return;
  const user = await AppDataSource.getRepository(User).findOneBy({ email: email.toLowerCase() });
  if (!user) {
    await recordAuthFailure(throttleKeys);
    return res.status(401).json({ error: "Invalid credentials" });
  }
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    await recordAuthFailure(throttleKeys);
    return res.status(401).json({ error: "Invalid credentials" });
  }
  await clearAuthFailures(throttleKeys);
  const methods = await requireTwoFactorAfterPrimaryAuth(req, user);
  if (methods.enabled) {
    return res.json({ requiresTwoFactor: true, methods });
  }
  establishUserSession(req, user);
  res.json({
    id: user.id,
    email: user.email,
    name: user.name,
    requiresTwoFactor: false,
    emailVerificationRequired: emailVerificationRequired(user),
  });
});

authRouter.post("/logout", (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

const forgotSchema = z.object({ email: z.string().email() });

authRouter.post("/forgot", validateBody(forgotSchema), async (req, res) => {
  const { email } = req.body as z.infer<typeof forgotSchema>;
  const throttleKeys = authThrottleKeys(req, "forgot", email);
  if (!(await throttleAllowed(throttleKeys, res))) return;
  await consumeAuthAttempt(throttleKeys);
  const repo = AppDataSource.getRepository(User);
  const user = await repo.findOneBy({ email: email.toLowerCase() });
  if (user) {
    const token = generateToken();
    user.resetToken = hashOneTimeToken(token);
    user.resetExpiresAt = new Date(Date.now() + 1000 * 60 * 60);
    await repo.save(user);
    const link = `${config.publicUrl}/reset/${token}`;
    await sendEmail({
      to: user.email,
      subject: "Reset your Genosyn password",
      text: `Reset link (valid 1 hour): ${link}`,
      purpose: "password_reset",
      triggeredByUserId: user.id,
    });
  }
  res.json({ ok: true });
});

const resetSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(PASSWORD_MIN_LENGTH),
});

authRouter.post("/reset", validateBody(resetSchema), async (req, res) => {
  const { token, password } = req.body as z.infer<typeof resetSchema>;
  const throttleKeys = authThrottleKeys(req, "reset", token);
  if (!(await throttleAllowed(throttleKeys, res))) return;
  const repo = AppDataSource.getRepository(User);
  const user = await repo.findOneBy({ resetToken: hashOneTimeToken(token) });
  if (!user || !user.resetExpiresAt || user.resetExpiresAt < new Date()) {
    await recordAuthFailure(throttleKeys);
    return res.status(400).json({ error: "Invalid or expired token" });
  }
  user.passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  user.resetToken = null;
  user.resetExpiresAt = null;
  user.sessionVersion += 1;
  await repo.save(user);
  await clearAuthFailures(throttleKeys);
  res.json({ ok: true });
});

authRouter.get("/me", requireAuth, async (req, res) => {
  const u = req.user!;
  res.json({
    id: u.id,
    email: u.email,
    name: u.name,
    handle: u.handle ?? null,
    avatarKey: u.avatarKey ?? null,
    isMasterAdmin: u.isMasterAdmin,
    emailVerified: Boolean(u.emailVerifiedAt),
    emailVerificationRequired: emailVerificationRequired(u),
  });
});

const verifyEmailSchema = z.object({ token: z.string().min(1) });

authRouter.post("/verify-email", validateBody(verifyEmailSchema), async (req, res) => {
  const { token } = req.body as z.infer<typeof verifyEmailSchema>;
  const throttleKeys = authThrottleKeys(req, "verify-email", token);
  if (!(await throttleAllowed(throttleKeys, res))) return;
  const user = await verifyEmailToken(token);
  if (!user) {
    await recordAuthFailure(throttleKeys);
    return res.status(400).json({ error: "Invalid or expired verification link" });
  }
  await clearAuthFailures(throttleKeys);
  res.json({ ok: true });
});

authRouter.post("/resend-verification", requireAuth, async (req, res) => {
  const user = req.user!;
  if (user.emailVerifiedAt) return res.json({ ok: true });
  const throttleKeys = authThrottleKeys(req, "resend-verification", user.email);
  if (!(await throttleAllowed(throttleKeys, res))) return;
  await consumeAuthAttempt(throttleKeys);
  await sendEmailVerification(user);
  res.json({ ok: true });
});

// ─────────────────── Profile avatar (current user) ──────────────────────
//
// GET serves `req.user`'s own avatar by bytes. POST accepts a multipart
// `file` and swaps it in; DELETE clears both the row and the on-disk blob.
// For peeking at *another* user's avatar, the company-scoped route on the
// companies router handles authorization via `requireCompanyMember`.

authRouter.get("/me/avatar", requireAuth, async (req, res) => {
  const u = req.user!;
  if (!u.avatarKey) return res.status(404).json({ error: "Not found" });
  const abs = avatarAbsPath(u.avatarKey);
  if (!abs || !fs.existsSync(abs)) {
    return res.status(404).json({ error: "Not found" });
  }
  res.setHeader("Content-Type", mimeFromKey(u.avatarKey));
  res.setHeader("Cache-Control", "private, max-age=60");
  res.sendFile(abs);
});

authRouter.post(
  "/me/avatar",
  requireAuth,
  avatarUploadMiddleware.single("file"),
  async (req, res) => {
    const file = (req as unknown as { file?: Express.Multer.File }).file;
    if (!file) return res.status(400).json({ error: "No file uploaded" });
    const user = req.user!;
    const previous = user.avatarKey;
    user.avatarKey = file.filename;
    await AppDataSource.getRepository(User).save(user);
    replaceAvatarFile(previous, file.filename);
    res.json({ avatarKey: user.avatarKey });
  },
);

authRouter.delete("/me/avatar", requireAuth, async (req, res) => {
  const user = req.user!;
  const previous = user.avatarKey;
  user.avatarKey = null;
  await AppDataSource.getRepository(User).save(user);
  removeAvatarFile(previous);
  res.json({ ok: true });
});

const HANDLE_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

const updateMeSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    email: z.string().email().optional(),
    // `null` → user explicitly wants to clear their handle;
    // undefined → leave it alone. Validation of the format below.
    handle: z.string().nullable().optional(),
  })
  .refine((v) => v.name !== undefined || v.email !== undefined || v.handle !== undefined, {
    message: "Nothing to update",
  });

authRouter.patch("/me", requireAuth, validateBody(updateMeSchema), async (req, res) => {
  const { name, email, handle } = req.body as z.infer<typeof updateMeSchema>;
  const user = req.user!;
  const repo = AppDataSource.getRepository(User);
  if (typeof name === "string") user.name = name.trim();
  if (typeof email === "string") {
    const next = email.toLowerCase();
    if (next !== user.email) {
      const taken = await repo.findOneBy({ email: next });
      if (taken && taken.id !== user.id) {
        return res.status(409).json({ error: "Email already registered" });
      }
      user.email = next;
      user.emailVerifiedAt = null;
      user.emailVerificationTokenHash = null;
      user.emailVerificationExpiresAt = null;
    }
  }
  if (handle !== undefined) {
    if (handle === null || handle.trim() === "") {
      user.handle = null;
    } else {
      const next = handle.trim().toLowerCase();
      if (!HANDLE_RE.test(next)) {
        return res.status(400).json({
          error:
            "Handle must be 2–32 chars, lowercase letters/digits/hyphens, starting and ending with a letter or digit.",
        });
      }
      if (next !== user.handle) {
        const taken = await repo.findOneBy({ handle: next });
        if (taken && taken.id !== user.id) {
          return res.status(409).json({ error: "Handle is already taken" });
        }
        // Also reject a handle that collides with an AI-employee slug in
        // any company this user is a member of — otherwise `@next` in a
        // workspace chat can't resolve uniquely.
        const mems = await AppDataSource.getRepository(Membership).findBy({
          userId: user.id,
        });
        if (mems.length > 0) {
          const collision = await AppDataSource.getRepository(AIEmployee)
            .createQueryBuilder("e")
            .where("e.companyId IN (:...companyIds)", {
              companyIds: mems.map((m) => m.companyId),
            })
            .andWhere("e.slug = :slug", { slug: next })
            .getOne();
          if (collision) {
            return res.status(409).json({
              error: `Handle conflicts with an AI employee named "${collision.name}" — pick something else.`,
            });
          }
        }
        user.handle = next;
      }
    }
  }
  await repo.save(user);
  if (typeof email === "string" && !user.emailVerifiedAt) {
    await sendEmailVerification(user);
  }
  res.json({
    id: user.id,
    email: user.email,
    name: user.name,
    handle: user.handle ?? null,
  });
});

const passwordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(PASSWORD_MIN_LENGTH),
});

authRouter.post("/password", requireAuth, validateBody(passwordSchema), async (req, res) => {
  const { currentPassword, newPassword } = req.body as z.infer<typeof passwordSchema>;
  const user = req.user!;
  const ok = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!ok) return res.status(400).json({ error: "Current password is incorrect" });
  user.passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
  user.resetToken = null;
  user.resetExpiresAt = null;
  user.sessionVersion += 1;
  await AppDataSource.getRepository(User).save(user);
  establishUserSession(req, user);
  res.json({ ok: true });
});
