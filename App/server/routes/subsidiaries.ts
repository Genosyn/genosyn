import { Router } from "express";
import { z } from "zod";
import { requireCompanyRole } from "../middleware/auth.js";
import { requireFinanceRead, requireFinanceWrite } from "../middleware/financeAccess.js";
import { validateBody, validateParams, validateQuery } from "../middleware/validate.js";
import { recordAudit } from "../services/audit.js";
import { createSubsidiary, listSubsidiaries, updateSubsidiary } from "../services/subsidiaries.js";

export const subsidiaryWriteSchema = z.object({
  name: z.string().trim().min(1).max(200),
  address: z.string().trim().max(2000).optional(),
  country: z.string().trim().max(120).optional(),
  taxNumber: z.string().trim().max(120).optional(),
  registrationNumber: z.string().trim().max(120).optional(),
  email: z.union([z.string().trim().email().max(320), z.literal("")]).optional(),
  phone: z.string().trim().max(80).optional(),
  website: z.string().trim().max(500).optional(),
  footer: z.string().trim().max(1000).optional(),
});

const companyParams = z.object({ cid: z.string().uuid() });
const subsidiaryParams = companyParams.extend({ id: z.string().uuid() });
const patchSchema = subsidiaryWriteSchema.partial().extend({ archived: z.boolean().optional() });

/** Mounted behind the finance router's authentication and company membership. */
export const subsidiariesRouter = Router({ mergeParams: true });

subsidiariesRouter.get("/", requireFinanceRead, validateParams(companyParams), validateQuery(z.object({})), async (req, res) => {
  res.json(await listSubsidiaries(req.params.cid));
});

subsidiariesRouter.post("/", requireFinanceWrite, requireCompanyRole("admin"), validateParams(companyParams), validateBody(subsidiaryWriteSchema), async (req, res) => {
  const subsidiary = await createSubsidiary(req.params.cid, req.body as z.infer<typeof subsidiaryWriteSchema>);
  await recordAudit({
    companyId: req.params.cid,
    actorUserId: req.userId ?? null,
    action: "finance.subsidiary.create",
    targetType: "subsidiary",
    targetId: subsidiary.id,
    targetLabel: subsidiary.name,
  });
  res.status(201).json(subsidiary);
});

subsidiariesRouter.patch("/:id", requireFinanceWrite, requireCompanyRole("admin"), validateParams(subsidiaryParams), validateBody(patchSchema), async (req, res) => {
  const subsidiary = await updateSubsidiary(req.params.cid, req.params.id, req.body as z.infer<typeof patchSchema>);
  if (!subsidiary) return res.status(404).json({ error: "Subsidiary not found" });
  await recordAudit({
    companyId: req.params.cid,
    actorUserId: req.userId ?? null,
    action: "finance.subsidiary.update",
    targetType: "subsidiary",
    targetId: subsidiary.id,
    targetLabel: subsidiary.name,
    metadata: { archived: subsidiary.archived },
  });
  res.json(subsidiary);
});
