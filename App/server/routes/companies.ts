import fs from "node:fs";
import { Router } from "express";
import { z } from "zod";
import { AppDataSource } from "../db/datasource.js";
import { Company } from "../db/entities/Company.js";
import { Membership } from "../db/entities/Membership.js";
import { Invitation } from "../db/entities/Invitation.js";
import { User } from "../db/entities/User.js";
import { In } from "typeorm";
import { validateBody } from "../middleware/validate.js";
import { requireAuth, requireCompanyMember } from "../middleware/auth.js";
import { toSlug } from "../lib/slug.js";
import { generateToken, hashToken } from "../lib/token.js";
import { sendEmail } from "../services/email.js";
import { ensureDefaultNotebook } from "../services/notebooks.js";
import { deleteCompanyCascade } from "../services/companyDelete.js";
import { companyDir } from "../services/paths.js";
import { avatarAbsPath, mimeFromKey } from "../services/avatars.js";
import { config } from "../../config.js";
import { hasTwoFactorMethod } from "../services/twoFactor.js";
import { recordAudit } from "../services/audit.js";
import { ApiKey } from "../db/entities/ApiKey.js";
import { Channel } from "../db/entities/Channel.js";
import { ChannelMember } from "../db/entities/ChannelMember.js";
import { Project } from "../db/entities/Project.js";
import { ProjectMember } from "../db/entities/ProjectMember.js";
import { Notification } from "../db/entities/Notification.js";

export const companiesRouter = Router();

companiesRouter.use(requireAuth);

companiesRouter.get("/", async (req, res) => {
  const mems = await AppDataSource.getRepository(Membership).find({
    where: { userId: req.userId! },
  });
  if (mems.length === 0) return res.json([]);
  const companies = await AppDataSource.getRepository(Company).find({
    where: { id: In(mems.map((m) => m.companyId)) },
  });
  const byId = new Map(companies.map((c) => [c.id, c]));
  const out = mems
    .map((m) => {
      const c = byId.get(m.companyId);
      if (!c) return null;
      return {
        id: c.id,
        name: c.name,
        slug: c.slug,
        role: m.role,
        requireTwoFactor: c.requireTwoFactor,
      };
    })
    .filter(Boolean);
  res.json(out);
});

const createSchema = z.object({ name: z.string().min(1).max(80) });

async function uniqueSlug(base: string): Promise<string> {
  const repo = AppDataSource.getRepository(Company);
  let slug = base || "company";
  let n = 1;
  while (await repo.findOneBy({ slug })) {
    n += 1;
    slug = `${base}-${n}`;
  }
  return slug;
}

companiesRouter.post("/", validateBody(createSchema), async (req, res) => {
  if (config.security.multiTenant && !req.user!.emailVerifiedAt) {
    return res.status(403).json({ error: "Verify your email before creating a company" });
  }
  const { name } = req.body as z.infer<typeof createSchema>;
  const coRepo = AppDataSource.getRepository(Company);
  const memRepo = AppDataSource.getRepository(Membership);
  const slug = await uniqueSlug(toSlug(name));
  const co = coRepo.create({ name, slug, ownerId: req.userId!, requireTwoFactor: false });
  await coRepo.save(co);
  await memRepo.save(memRepo.create({ companyId: co.id, userId: req.userId!, role: "owner" }));
  // Every company needs a default notebook so the create-note flow has a
  // home from day one.
  await ensureDefaultNotebook(co.id, req.userId!);
  res.json({
    id: co.id,
    name: co.name,
    slug: co.slug,
    role: "owner",
    requireTwoFactor: co.requireTwoFactor,
  });
});

companiesRouter.get("/:cid", requireCompanyMember, async (req, res) => {
  const co = await AppDataSource.getRepository(Company).findOneBy({ id: req.params.cid });
  if (!co) return res.status(404).json({ error: "Not found" });
  res.json({
    id: co.id,
    name: co.name,
    slug: co.slug,
    requireTwoFactor: co.requireTwoFactor,
  });
});

const patchSchema = z
  .object({
    name: z.string().min(1).max(80).optional(),
    slug: z.string().min(1).max(80).optional(),
    requireTwoFactor: z.boolean().optional(),
  })
  .refine((v) => v.name !== undefined || v.slug !== undefined || v.requireTwoFactor !== undefined, {
    message: "Provide name, slug, or a two-factor policy",
  });

companiesRouter.patch(
  "/:cid",
  requireCompanyMember,
  validateBody(patchSchema),
  async (req, res) => {
    const role = (req as unknown as { role: string }).role;
    if (role !== "owner" && role !== "admin") return res.status(403).json({ error: "Forbidden" });
    const repo = AppDataSource.getRepository(Company);
    const co = await repo.findOneBy({ id: req.params.cid });
    if (!co) return res.status(404).json({ error: "Not found" });
    const body = req.body as z.infer<typeof patchSchema>;

    if (body.name !== undefined) co.name = body.name;

    if (body.requireTwoFactor !== undefined) {
      if (body.requireTwoFactor && !(await hasTwoFactorMethod(req.userId!))) {
        return res.status(400).json({
          error: "Enable two-factor authentication on your account before requiring it",
        });
      }
      co.requireTwoFactor = body.requireTwoFactor;
    }

    if (body.slug !== undefined) {
      const normalized = toSlug(body.slug);
      if (!normalized) {
        return res.status(400).json({ error: "Slug must contain at least one letter or digit" });
      }
      if (normalized !== co.slug) {
        const existing = await repo.findOneBy({ slug: normalized });
        if (existing && existing.id !== co.id) {
          return res.status(409).json({ error: "That slug is already taken" });
        }
        const oldDir = companyDir(co.slug);
        const newDir = companyDir(normalized);
        if (fs.existsSync(newDir)) {
          return res.status(409).json({ error: "A data directory for that slug already exists" });
        }
        if (fs.existsSync(oldDir)) {
          try {
            fs.renameSync(oldDir, newDir);
          } catch (err) {
            return res
              .status(500)
              .json({ error: `Failed to rename data directory: ${(err as Error).message}` });
          }
        }
        co.slug = normalized;
      }
    }

    await repo.save(co);
    res.json({
      id: co.id,
      name: co.name,
      slug: co.slug,
      requireTwoFactor: co.requireTwoFactor,
    });
  },
);

companiesRouter.delete("/:cid", requireCompanyMember, async (req, res) => {
  const co = await AppDataSource.getRepository(Company).findOneBy({ id: req.params.cid });
  if (!co) return res.status(404).json({ error: "Not found" });
  if (co.ownerId !== req.userId) return res.status(403).json({ error: "Owner only" });
  await deleteCompanyCascade({ companyId: co.id, companySlug: co.slug });
  res.json({ ok: true });
});

const inviteSchema = z.object({ email: z.string().email() });

companiesRouter.post(
  "/:cid/invitations",
  requireCompanyMember,
  validateBody(inviteSchema),
  async (req, res) => {
    const role = (req as unknown as { role: string }).role;
    if (role !== "owner" && role !== "admin") return res.status(403).json({ error: "Forbidden" });
    const { email } = req.body as z.infer<typeof inviteSchema>;
    const repo = AppDataSource.getRepository(Invitation);
    const token = generateToken();
    const inv = repo.create({
      companyId: req.params.cid,
      email: email.toLowerCase(),
      token: hashToken(token),
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 7),
      acceptedAt: null,
    });
    await repo.save(inv);
    const link = `${config.publicUrl}/invite/${token}`;
    await sendEmail({
      to: email,
      subject: "You're invited to a Genosyn company",
      text: `Accept the invite: ${link}`,
      companyId: req.params.cid,
      purpose: "invitation",
      triggeredByUserId: req.userId ?? null,
    });
    res.json({ id: inv.id, email: inv.email, token });
  },
);

companiesRouter.get("/:cid/members", requireCompanyMember, async (req, res) => {
  const mems = await AppDataSource.getRepository(Membership).find({
    where: { companyId: req.params.cid },
  });
  const userIds = mems.map((m) => m.userId);
  const users = userIds.length
    ? await AppDataSource.getRepository(User).find({ where: { id: In(userIds) } })
    : [];
  const byId = new Map(users.map((u) => [u.id, u]));
  res.json(
    mems.map((m) => ({
      userId: m.userId,
      role: m.role,
      email: byId.get(m.userId)?.email ?? null,
      name: byId.get(m.userId)?.name ?? null,
      avatarKey: byId.get(m.userId)?.avatarKey ?? null,
    })),
  );
});

const memberRoleSchema = z.object({ role: z.enum(["member", "admin"]) });

companiesRouter.patch(
  "/:cid/members/:uid",
  requireCompanyMember,
  validateBody(memberRoleSchema),
  async (req, res) => {
    if (req.companyRole !== "owner") {
      return res.status(403).json({ error: "Only the company owner can change roles" });
    }
    const { cid, uid } = req.params;
    const membership = await AppDataSource.getRepository(Membership).findOneBy({
      companyId: cid,
      userId: uid,
    });
    if (!membership) return res.status(404).json({ error: "Member not found" });
    if (membership.role === "owner") {
      return res.status(400).json({ error: "The owner role cannot be changed here" });
    }
    const { role } = req.body as z.infer<typeof memberRoleSchema>;
    membership.role = role;
    await AppDataSource.getRepository(Membership).save(membership);
    await recordAudit({
      companyId: cid,
      actorUserId: req.userId ?? null,
      action: "member.role.update",
      targetType: "member",
      targetId: uid,
      metadata: { role },
    });
    res.json({ userId: uid, role });
  },
);

companiesRouter.delete("/:cid/members/:uid", requireCompanyMember, async (req, res) => {
  const { cid, uid } = req.params;
  const membership = await AppDataSource.getRepository(Membership).findOneBy({
    companyId: cid,
    userId: uid,
  });
  if (!membership) return res.status(404).json({ error: "Member not found" });
  if (membership.role === "owner") {
    return res.status(400).json({ error: "The company owner cannot be removed" });
  }
  const removingSelf = uid === req.userId;
  const allowed =
    req.companyRole === "owner" ||
    (req.companyRole === "admin" && (membership.role === "member" || removingSelf)) ||
    removingSelf;
  if (!allowed) return res.status(403).json({ error: "Forbidden" });
  await AppDataSource.transaction(async (manager) => {
    const [channels, projects] = await Promise.all([
      manager.getRepository(Channel).find({ where: { companyId: cid }, select: { id: true } }),
      manager.getRepository(Project).find({ where: { companyId: cid }, select: { id: true } }),
    ]);
    if (channels.length > 0) {
      await manager.getRepository(ChannelMember).delete({
        channelId: In(channels.map((channel) => channel.id)),
        userId: uid,
      });
    }
    if (projects.length > 0) {
      await manager.getRepository(ProjectMember).delete({
        projectId: In(projects.map((project) => project.id)),
        userId: uid,
      });
    }
    await manager.getRepository(ApiKey).update(
      { companyId: cid, userId: uid },
      { revokedAt: new Date() },
    );
    await manager.getRepository(Notification).delete({ companyId: cid, userId: uid });
    await manager.getRepository(Membership).delete({ companyId: cid, userId: uid });
  });
  await recordAudit({
    companyId: cid,
    actorUserId: req.userId ?? null,
    action: removingSelf ? "member.leave" : "member.remove",
    targetType: "member",
    targetId: uid,
  });
  res.json({ ok: true });
});

/**
 * Serve a teammate's avatar inside a company scope. Mounted on the companies
 * router (not auth) because the authorization we want is "you must share
 * this company with that user" — `requireCompanyMember` already checks the
 * caller; the membership lookup on the target ensures the caller can't
 * enumerate random user ids.
 */
companiesRouter.get("/:cid/members/:uid/avatar", requireCompanyMember, async (req, res) => {
  const targetMembership = await AppDataSource.getRepository(Membership).findOneBy({
    companyId: req.params.cid,
    userId: req.params.uid,
  });
  if (!targetMembership) return res.status(404).json({ error: "Not found" });
  const user = await AppDataSource.getRepository(User).findOneBy({
    id: req.params.uid,
  });
  if (!user || !user.avatarKey) {
    return res.status(404).json({ error: "Not found" });
  }
  const abs = avatarAbsPath(user.avatarKey);
  if (!abs || !fs.existsSync(abs)) {
    return res.status(404).json({ error: "Not found" });
  }
  res.setHeader("Content-Type", mimeFromKey(user.avatarKey));
  res.setHeader("Cache-Control", "private, max-age=60");
  res.sendFile(abs);
});
