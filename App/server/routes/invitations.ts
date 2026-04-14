import { Router } from "express";
import { z } from "zod";
import { AppDataSource } from "../db/datasource.js";
import { Invitation } from "../db/entities/Invitation.js";
import { Membership } from "../db/entities/Membership.js";
import { requireAuth } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";

export const invitationsRouter = Router();
invitationsRouter.use(requireAuth);

const acceptSchema = z.object({ token: z.string().min(1) });

invitationsRouter.post("/accept", validateBody(acceptSchema), async (req, res) => {
  const { token } = req.body as z.infer<typeof acceptSchema>;
  const invRepo = AppDataSource.getRepository(Invitation);
  const inv = await invRepo.findOneBy({ token });
  if (!inv || inv.acceptedAt || inv.expiresAt < new Date()) {
    return res.status(400).json({ error: "Invalid or expired invitation" });
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
