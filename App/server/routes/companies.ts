import fs from "node:fs";
import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { AppDataSource } from "../db/datasource.js";
import { Company } from "../db/entities/Company.js";
import { Membership } from "../db/entities/Membership.js";
import { Invitation } from "../db/entities/Invitation.js";
import { User } from "../db/entities/User.js";
import { In } from "typeorm";
import { validateBody, validateParams } from "../middleware/validate.js";
import {
  requireAuth,
  requireBrowserSession,
  requireCompanyMember,
  requireRecentAuthentication,
} from "../middleware/auth.js";
import { toSlug } from "../lib/slug.js";
import { generateToken, hashToken } from "../lib/token.js";
import { sendEmail } from "../services/email.js";
import { ensureDefaultNotebook } from "../services/notebooks.js";
import { loadOnboardingStatus } from "../services/onboardingStatus.js";
import { deleteCompanyCascade } from "../services/companyDelete.js";
import { companyDir } from "../services/paths.js";
import { avatarAbsPath, mimeFromKey } from "../services/avatars.js";
import { getPublicUrl } from "../services/publicUrl.js";
import { config } from "../../config.js";
import { hasTwoFactorMethod } from "../services/twoFactor.js";
import { recordAudit } from "../services/audit.js";
import { ApiKey } from "../db/entities/ApiKey.js";
import { Channel } from "../db/entities/Channel.js";
import { ChannelMember } from "../db/entities/ChannelMember.js";
import { Project } from "../db/entities/Project.js";
import { ProjectMember } from "../db/entities/ProjectMember.js";
import { Notification } from "../db/entities/Notification.js";
import { VaultItem } from "../db/entities/VaultItem.js";
import { VaultItemMemberAccess } from "../db/entities/VaultItemMemberAccess.js";
import { emitMembershipAuthorizationChange } from "../services/resourceEvents.js";

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
        mission: c.mission,
        vision: c.vision,
        role: m.role,
        requireTwoFactor: c.requireTwoFactor,
      };
    })
    .filter(Boolean);
  res.json(out);
});

const companyProfileField = z.string().trim().max(2_000).default("");
const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  mission: companyProfileField,
  vision: companyProfileField,
});

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

companiesRouter.post("/", requireBrowserSession, validateBody(createSchema), async (req, res) => {
  if (config.security.multiTenant && !req.user!.emailVerifiedAt) {
    return res.status(403).json({ error: "Verify your email before creating a company" });
  }
  const { name, mission, vision } = req.body as z.infer<typeof createSchema>;
  const coRepo = AppDataSource.getRepository(Company);
  const memRepo = AppDataSource.getRepository(Membership);
  const slug = await uniqueSlug(toSlug(name));
  const co = coRepo.create({
    name,
    slug,
    ownerId: req.userId!,
    mission,
    vision,
    requireTwoFactor: false,
  });
  await coRepo.save(co);
  await memRepo.save(memRepo.create({ companyId: co.id, userId: req.userId!, role: "owner" }));
  // Every company needs a default notebook so the create-note flow has a
  // home from day one.
  await ensureDefaultNotebook(co.id, req.userId!);
  res.json({
    id: co.id,
    name: co.name,
    slug: co.slug,
    mission: co.mission,
    vision: co.vision,
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
    mission: co.mission,
    vision: co.vision,
    requireTwoFactor: co.requireTwoFactor,
  });
});

const onboardingStatusParamsSchema = z.object({ cid: z.string().uuid() });
const onboardingStatusQuerySchema = z.object({ employeeId: z.string().uuid().optional() });

/**
 * First-run progress, derived from the company's real state rather than a
 * stored flag — see `services/onboardingStatus.ts`. Read by the guide's
 * closing summary, which names an employee, and by Home's "finish setting up"
 * banner, which asks about the company's first hire and so passes none.
 */
companiesRouter.get(
  "/:cid/onboarding-status",
  requireCompanyMember,
  validateParams(onboardingStatusParamsSchema),
  async (req, res) => {
    const query = onboardingStatusQuerySchema.safeParse(req.query);
    if (!query.success) {
      return res.status(400).json({ error: "ValidationError", issues: query.error.issues });
    }
    const co = await AppDataSource.getRepository(Company).findOneBy({ id: req.params.cid });
    if (!co) return res.status(404).json({ error: "Not found" });
    res.json(await loadOnboardingStatus(co.id, query.data.employeeId));
  },
);

const patchSchema = z
  .object({
    name: z.string().min(1).max(80).optional(),
    slug: z.string().min(1).max(80).optional(),
    mission: z.string().trim().max(2_000).optional(),
    vision: z.string().trim().max(2_000).optional(),
    requireTwoFactor: z.boolean().optional(),
  })
  .refine(
    (v) =>
      v.name !== undefined ||
      v.slug !== undefined ||
      v.mission !== undefined ||
      v.vision !== undefined ||
      v.requireTwoFactor !== undefined,
    { message: "Provide a company profile field or a two-factor policy" },
  );

const requireRecentSecondFactor = requireRecentAuthentication({ requireSecondFactor: true });
const requireRecentPrimary = requireRecentAuthentication();

/** Apply a middleware only when this PATCH changes the company MFA policy. */
function whenTwoFactorPolicyChanges(middleware: RequestHandler): RequestHandler {
  return (req, res, next) => {
    const body = req.body as Partial<z.infer<typeof patchSchema>>;
    if (body.requireTwoFactor === undefined) {
      next();
      return;
    }
    middleware(req, res, next);
  };
}

function whenGrantingAdminRole(middleware: RequestHandler): RequestHandler {
  return (req, res, next) => {
    const body = req.body as { role?: unknown };
    if (body.role !== "admin") {
      next();
      return;
    }
    middleware(req, res, next);
  };
}

function whenGrantingFullFinanceAccess(middleware: RequestHandler): RequestHandler {
  return (req, res, next) => {
    const body = req.body as { financeAccess?: unknown };
    if (body.financeAccess !== "full") {
      next();
      return;
    }
    middleware(req, res, next);
  };
}

const requireSecondFactorWhenRemovingAnotherMember: RequestHandler = (req, res, next) => {
  if (req.params.uid === req.userId) {
    next();
    return;
  }
  requireRecentSecondFactor(req, res, next);
};

companiesRouter.patch(
  "/:cid",
  requireCompanyMember,
  validateBody(patchSchema),
  whenTwoFactorPolicyChanges(requireBrowserSession),
  whenTwoFactorPolicyChanges(requireRecentSecondFactor),
  async (req, res) => {
    const role = (req as unknown as { role: string }).role;
    if (role !== "owner" && role !== "admin") return res.status(403).json({ error: "Forbidden" });
    const repo = AppDataSource.getRepository(Company);
    const co = await repo.findOneBy({ id: req.params.cid });
    if (!co) return res.status(404).json({ error: "Not found" });
    const body = req.body as z.infer<typeof patchSchema>;

    if (body.name !== undefined) co.name = body.name;
    if (body.mission !== undefined) co.mission = body.mission;
    if (body.vision !== undefined) co.vision = body.vision;

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
      mission: co.mission,
      vision: co.vision,
      requireTwoFactor: co.requireTwoFactor,
    });
  },
);

companiesRouter.delete(
  "/:cid",
  requireCompanyMember,
  requireBrowserSession,
  requireRecentSecondFactor,
  async (req, res) => {
    const co = await AppDataSource.getRepository(Company).findOneBy({ id: req.params.cid });
    if (!co) return res.status(404).json({ error: "Not found" });
    if (co.ownerId !== req.userId) return res.status(403).json({ error: "Owner only" });
    await deleteCompanyCascade({ companyId: co.id, companySlug: co.slug });
    res.json({ ok: true });
  },
);

const inviteSchema = z.object({ email: z.string().email() });

companiesRouter.post(
  "/:cid/invitations",
  requireCompanyMember,
  requireBrowserSession,
  requireRecentPrimary,
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
    const link = `${getPublicUrl()}/invite/${token}`;
    await sendEmail({
      to: email,
      subject: "You're invited to a Genosyn company",
      text: `Accept the invite: ${link}`,
      bodyPreview: "Company invitation link redacted. The invitation expires in 7 days.",
      companyId: req.params.cid,
      purpose: "invitation",
      triggeredByUserId: req.userId ?? null,
    });
    res.json({ id: inv.id, email: inv.email });
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
      financeAccess: m.financeAccess,
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
  requireBrowserSession,
  requireRecentPrimary,
  validateBody(memberRoleSchema),
  whenGrantingAdminRole(requireRecentSecondFactor),
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
    emitMembershipAuthorizationChange(cid);
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

const memberFinanceAccessSchema = z.object({
  financeAccess: z.enum(["none", "read", "full"]),
});

// Set a member's finance access level (M33 A4). Owners and admins can dial a
// member down to read-only or none; the level is inert for owners/admins
// themselves (they are always treated as full) but we allow setting it so the
// UI needn't special-case them.
companiesRouter.patch(
  "/:cid/members/:uid/finance-access",
  requireCompanyMember,
  requireBrowserSession,
  requireRecentPrimary,
  validateBody(memberFinanceAccessSchema),
  whenGrantingFullFinanceAccess(requireRecentSecondFactor),
  async (req, res) => {
    if (req.companyRole !== "owner" && req.companyRole !== "admin") {
      return res.status(403).json({ error: "Only owners and admins can change finance access" });
    }
    const { cid, uid } = req.params;
    const membership = await AppDataSource.getRepository(Membership).findOneBy({
      companyId: cid,
      userId: uid,
    });
    if (!membership) return res.status(404).json({ error: "Member not found" });
    const { financeAccess } = req.body as z.infer<typeof memberFinanceAccessSchema>;
    membership.financeAccess = financeAccess;
    await AppDataSource.getRepository(Membership).save(membership);
    await recordAudit({
      companyId: cid,
      actorUserId: req.userId ?? null,
      action: "member.finance_access.update",
      targetType: "member",
      targetId: uid,
      metadata: { financeAccess },
    });
    res.json({ userId: uid, financeAccess });
  },
);

companiesRouter.delete(
  "/:cid/members/:uid",
  requireCompanyMember,
  requireBrowserSession,
  requireRecentPrimary,
  requireSecondFactorWhenRemovingAnotherMember,
  async (req, res) => {
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
      await manager
        .getRepository(ApiKey)
        .update({ companyId: cid, userId: uid }, { revokedAt: new Date() });
      await manager.getRepository(Notification).delete({ companyId: cid, userId: uid });
      await manager.getRepository(VaultItemMemberAccess).delete({ companyId: cid, userId: uid });
      // Leaving a company must not let a later re-invite silently resurrect the
      // creator's full Vault rights. Preserve the item for the company, but
      // hand management to the remaining owners/admins.
      await manager
        .getRepository(VaultItem)
        .update({ companyId: cid, createdByUserId: uid }, { createdByUserId: null });
      await manager.getRepository(Membership).delete({ companyId: cid, userId: uid });
    });
    emitMembershipAuthorizationChange(cid);
    await recordAudit({
      companyId: cid,
      actorUserId: req.userId ?? null,
      action: removingSelf ? "member.leave" : "member.remove",
      targetType: "member",
      targetId: uid,
    });
    res.json({ ok: true });
  },
);

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
