import { Router } from "express";
import { z } from "zod";
import bcrypt from "bcrypt";
import { AppDataSource } from "../db/datasource.js";
import { User } from "../db/entities/User.js";
import { validateBody } from "../middleware/validate.js";
import { requireAuth } from "../middleware/auth.js";
import { sendEmail } from "../services/email.js";
import { generateToken } from "../lib/token.js";
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
  res.json({ id: u.id, email: u.email, name: u.name });
});
