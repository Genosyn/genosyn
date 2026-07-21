import { Router } from "express";
import { z } from "zod";
import { AppDataSource } from "../db/datasource.js";
import { Invitation } from "../db/entities/Invitation.js";
import { Membership } from "../db/entities/Membership.js";
import { requireAuth } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { config } from "../../config.js";
import { Company } from "../db/entities/Company.js";
import { hasTwoFactorMethod } from "../services/twoFactor.js";
import { hashToken } from "../lib/token.js";

export const invitationsRouter = Router();
invitationsRouter.use(requireAuth);

const acceptSchema = z.object({ token: z.string().min(1) });

invitationsRouter.post("/accept", validateBody(acceptSchema), async (req, res) => {
  if (config.security.multiTenant && !req.user!.emailVerifiedAt) {
    return res.status(403).json({ error: "Verify your email before accepting an invitation" });
  }
  const { token } = req.body as z.infer<typeof acceptSchema>;
  const invRepo = AppDataSource.getRepository(Invitation);
  // New invitations store only a digest. The raw fallback keeps links issued
  // before this hardening release usable through their existing expiry date.
  const inv =
    (await invRepo.findOneBy({ token: hashToken(token) })) ??
    (await invRepo.findOneBy({ token }));
  if (!inv || inv.acceptedAt || inv.expiresAt < new Date()) {
    return res.status(400).json({ error: "Invalid or expired invitation" });
  }
  if (inv.email.trim().toLowerCase() !== req.user!.email.trim().toLowerCase()) {
    return res.status(403).json({
      error: `This invitation was sent to ${inv.email}. Sign in with that email address to accept it.`,
    });
  }
  const company = await AppDataSource.getRepository(Company).findOneBy({ id: inv.companyId });
  if (company?.requireTwoFactor && !(await hasTwoFactorMethod(req.userId!))) {
    return res.status(403).json({
      error: "This company requires two-factor authentication. Enable it in Account → Security.",
    });
  }
  const memRepo = AppDataSource.getRepository(Membership);
  const exists = await memRepo.findOneBy({ companyId: inv.companyId, userId: req.userId! });
  if (!exists) {
    await memRepo.save(
      memRepo.create({ companyId: inv.companyId, userId: req.userId!, role: "member" }),
    );
  }
  inv.acceptedAt = new Date();
  await invRepo.save(inv);
  res.json({ companyId: inv.companyId });
});
