import fs from "node:fs";
import { Router } from "express";
import { z } from "zod";
import bcrypt from "bcrypt";
import { AppDataSource } from "../db/datasource.js";
import { User } from "../db/entities/User.js";
import { Membership } from "../db/entities/Membership.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { validateBody } from "../middleware/validate.js";
import { requireAuth } from "../middleware/auth.js";
import { sendEmail } from "../services/email.js";
import { generateToken } from "../lib/token.js";
import {
  avatarAbsPath,
  avatarUploadMiddleware,
  mimeFromKey,
  removeAvatarFile,
  replaceAvatarFile,
} from "../services/avatars.js";
import { config } from "../../config.js";

export const authRouter = Router();

const signupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(1),
});

authRouter.post("/signup", validateBody(signupSchema), async (req, res) => {
  const { email, password, name } = req.body as z.infer<typeof signupSchema>;
  const repo = AppDataSource.getRepository(User);
  const existing = await repo.findOneBy({ email: email.toLowerCase() });
  if (existing) return res.status(409).json({ error: "Email already registered" });
  const user = repo.create({
    email: email.toLowerCase(),
    name,
    passwordHash: await bcrypt.hash(password, 10),
    resetToken: null,
    resetExpiresAt: null,
  });
  await repo.save(user);
  req.session = { userId: user.id };
  void sendEmail({
    to: user.email,
    subject: "Welcome to Genosyn",
    text: `Welcome aboard, ${user.name}. Genosyn is ready when you are.`,
  });
  res.json({ id: user.id, email: user.email, name: user.name });
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

authRouter.post("/login", validateBody(loginSchema), async (req, res) => {
  const { email, password } = req.body as z.infer<typeof loginSchema>;
  const user = await AppDataSource.getRepository(User).findOneBy({ email: email.toLowerCase() });
  if (!user) return res.status(401).json({ error: "Invalid credentials" });
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: "Invalid credentials" });
  req.session = { userId: user.id };
  res.json({ id: user.id, email: user.email, name: user.name });
});

authRouter.post("/logout", (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

const forgotSchema = z.object({ email: z.string().email() });

authRouter.post("/forgot", validateBody(forgotSchema), async (req, res) => {
  const { email } = req.body as z.infer<typeof forgotSchema>;
  const repo = AppDataSource.getRepository(User);
  const user = await repo.findOneBy({ email: email.toLowerCase() });
  if (user) {
    user.resetToken = generateToken();
    user.resetExpiresAt = new Date(Date.now() + 1000 * 60 * 60);
    await repo.save(user);
    const link = `${config.publicUrl}/reset/${user.resetToken}`;
    await sendEmail({
      to: user.email,
      subject: "Reset your Genosyn password",
      text: `Reset link (valid 1 hour): ${link}`,
    });
  }
  res.json({ ok: true });
});

const resetSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8),
});

authRouter.post("/reset", validateBody(resetSchema), async (req, res) => {
  const { token, password } = req.body as z.infer<typeof resetSchema>;
  const repo = AppDataSource.getRepository(User);
  const user = await repo.findOneBy({ resetToken: token });
  if (!user || !user.resetExpiresAt || user.resetExpiresAt < new Date()) {
    return res.status(400).json({ error: "Invalid or expired token" });
  }
  user.passwordHash = await bcrypt.hash(password, 10);
  user.resetToken = null;
  user.resetExpiresAt = null;
  await repo.save(user);
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
  });
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
  .refine(
    (v) =>
      v.name !== undefined || v.email !== undefined || v.handle !== undefined,
    { message: "Nothing to update" },
  );

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
  res.json({
    id: user.id,
    email: user.email,
    name: user.name,
    handle: user.handle ?? null,
  });
});

const passwordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8),
});

authRouter.post("/password", requireAuth, validateBody(passwordSchema), async (req, res) => {
  const { currentPassword, newPassword } = req.body as z.infer<typeof passwordSchema>;
  const user = req.user!;
  const ok = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!ok) return res.status(400).json({ error: "Current password is incorrect" });
  user.passwordHash = await bcrypt.hash(newPassword, 10);
  user.resetToken = null;
  user.resetExpiresAt = null;
  await AppDataSource.getRepository(User).save(user);
  res.json({ ok: true });
});
