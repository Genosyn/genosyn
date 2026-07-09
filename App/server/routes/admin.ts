import fs from "node:fs";
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { AppDataSource } from "../db/datasource.js";
import { Company } from "../db/entities/Company.js";
import { User } from "../db/entities/User.js";
import { getInstanceHealthReport } from "../services/instanceHealth.js";
import { listAdminCompanies, listAdminUsers } from "../services/adminDirectory.js";
import { deleteUserCascade, UserOwnsCompaniesError } from "../services/userDelete.js";
import { deleteCompanyCascade } from "../services/companyDelete.js";
import { avatarAbsPath, mimeFromKey, removeAvatarFile } from "../services/avatars.js";

/**
 * Instance-wide admin endpoints. Not company-scoped — these describe and manage
 * the whole deployment (health, and the directory of every user + company on
 * it) rather than a single company's data.
 *
 * Auth is `requireAuth` only, matching the install-wide backups router: the
 * Admin section is the operator surface, and on a self-hosted box access is
 * governed by who can sign in at all. There is no separate instance-admin role
 * in the data model, so introducing one here would be a product change beyond
 * this endpoint. The destructive routes below (delete user / delete company)
 * are therefore no more privileged than the existing backup-restore route,
 * which already replaces the entire data directory.
 */
export const adminRouter = Router();
adminRouter.use(requireAuth);

adminRouter.get("/instance-health", async (_req, res, next) => {
  try {
    res.json(await getInstanceHealthReport());
  } catch (err) {
    next(err);
  }
});

// ──────────────────────────────── Users ────────────────────────────────────

const idParam = z.object({ id: z.string().uuid() });

adminRouter.get("/users", async (_req, res, next) => {
  try {
    res.json(await listAdminUsers());
  } catch (err) {
    next(err);
  }
});

/**
 * Serve any user's avatar for the Admin → Users list. Company-scoped avatar
 * routes only resolve a user the caller shares a company with; the admin
 * directory spans every user, so it needs its own instance-wide reader. Guarded
 * against path traversal by looking the file up through `avatarAbsPath`, which
 * only ever returns a path inside the avatars pool.
 */
adminRouter.get("/users/:id/avatar", async (req, res, next) => {
  try {
    const parsed = idParam.safeParse(req.params);
    if (!parsed.success) return res.status(400).json({ error: "Invalid user id" });
    const user = await AppDataSource.getRepository(User).findOneBy({ id: parsed.data.id });
    if (!user || !user.avatarKey) return res.status(404).json({ error: "Not found" });
    const abs = avatarAbsPath(user.avatarKey);
    if (!abs || !fs.existsSync(abs)) return res.status(404).json({ error: "Not found" });
    res.setHeader("Content-Type", mimeFromKey(user.avatarKey));
    res.setHeader("Cache-Control", "private, max-age=60");
    res.sendFile(abs);
  } catch (err) {
    next(err);
  }
});

/**
 * Hard-delete a user and everything account-scoped to them (memberships, API
 * keys, notifications, …), unlinking authored content so history survives. The
 * shared `deleteUserCascade` refuses when the user still owns a company —
 * surfaced here as a 409 with the offending company names so the operator knows
 * to reassign or delete those first. Deleting yourself is blocked: it would
 * invalidate the very session making the request.
 */
adminRouter.delete("/users/:id", async (req, res, next) => {
  try {
    const parsed = idParam.safeParse(req.params);
    if (!parsed.success) return res.status(400).json({ error: "Invalid user id" });
    const { id } = parsed.data;

    // Compare case-insensitively: zod's uuid() accepts an uppercased id, and on
    // Postgres a uuid comparison is case-insensitive, so a naive `===` could let
    // a caller slip past this guard and delete their own account.
    if (req.userId && id.toLowerCase() === req.userId.toLowerCase()) {
      return res.status(400).json({ error: "You can't delete your own account here." });
    }

    const user = await AppDataSource.getRepository(User).findOneBy({ id });
    if (!user) return res.status(404).json({ error: "Not found" });

    const result = await deleteUserCascade({ userId: id });

    // The avatar is a flat-pool file keyed off the row — best-effort cleanup.
    removeAvatarFile(user.avatarKey);

    res.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof UserOwnsCompaniesError) {
      return res.status(409).json({
        error: "This user owns one or more companies. Reassign or delete them first.",
        companies: err.companies,
      });
    }
    next(err);
  }
});

// ─────────────────────────────── Companies ─────────────────────────────────

adminRouter.get("/companies", async (_req, res, next) => {
  try {
    res.json(await listAdminCompanies());
  } catch (err) {
    next(err);
  }
});

/**
 * Hard-delete a company and every row that hangs off it, then remove its
 * on-disk data directory. Reuses the same `deleteCompanyCascade` the
 * per-company "delete company" flow runs, so the blast radius is identical —
 * this route just lets an operator reach any company from one place instead of
 * having to switch into each one.
 */
adminRouter.delete("/companies/:id", async (req, res, next) => {
  try {
    const parsed = idParam.safeParse(req.params);
    if (!parsed.success) return res.status(400).json({ error: "Invalid company id" });
    const co = await AppDataSource.getRepository(Company).findOneBy({ id: parsed.data.id });
    if (!co) return res.status(404).json({ error: "Not found" });
    await deleteCompanyCascade({ companyId: co.id, companySlug: co.slug });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
