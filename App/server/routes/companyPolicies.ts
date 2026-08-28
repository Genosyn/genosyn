import { Router } from "express";
import { z } from "zod";
import { AppDataSource } from "../db/datasource.js";
import { CompanyPolicy } from "../db/entities/CompanyPolicy.js";
import {
  onRoutePaths,
  requireAuth,
  requireCompanyMember,
  requireCompanyRoleForMutations,
} from "../middleware/auth.js";
import { validateBody, validateParams } from "../middleware/validate.js";
import { recordAudit } from "../services/audit.js";
import { UNFORBIDDABLE_TOOLS, parseList } from "../services/companyPolicies.js";

/**
 * Company policies (M53). Reads member-level — every Member and employee is
 * bound by them, so everyone may read them. Mutations admin-gated.
 */
export const companyPoliciesRouter = Router({ mergeParams: true });
companyPoliciesRouter.use(requireAuth);
companyPoliciesRouter.use(requireCompanyMember);
companyPoliciesRouter.use(
  onRoutePaths(["/company-policies"], requireCompanyRoleForMutations("admin")),
);

const companyParamsSchema = z.object({ cid: z.string().uuid() }).strict();
const policyParamsSchema = z.object({ cid: z.string().uuid(), pid: z.string().uuid() }).strict();

const policySchema = z.object({
  title: z.string().min(1).max(120),
  body: z.string().max(20_000).optional(),
  blockedRecipientDomains: z.string().max(10_000).optional(),
  forbiddenTools: z.string().max(10_000).optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
  enabled: z.boolean().optional(),
});

function serializePolicy(policy: CompanyPolicy) {
  return {
    id: policy.id,
    title: policy.title,
    body: policy.body,
    blockedRecipientDomains: policy.blockedRecipientDomains,
    forbiddenTools: policy.forbiddenTools,
    sortOrder: policy.sortOrder,
    enabled: policy.enabled,
    createdAt: policy.createdAt.toISOString(),
  };
}

function rejectUnforbiddable(forbiddenTools: string | undefined): string | null {
  if (!forbiddenTools) return null;
  const reserved = parseList(forbiddenTools).find((name) => UNFORBIDDABLE_TOOLS.has(name));
  return reserved
    ? `"${reserved}" cannot be forbidden — discovery must stay reachable or refusals become invisible`
    : null;
}

companyPoliciesRouter.get(
  "/company-policies",
  validateParams(companyParamsSchema),
  async (req, res) => {
    const policies = await AppDataSource.getRepository(CompanyPolicy).find({
      where: { companyId: req.params.cid },
      order: { sortOrder: "ASC", createdAt: "ASC" },
    });
    res.json(policies.map(serializePolicy));
  },
);

companyPoliciesRouter.post(
  "/company-policies",
  validateParams(companyParamsSchema),
  validateBody(policySchema),
  async (req, res) => {
    const cid = req.params.cid;
    const body = req.body as z.infer<typeof policySchema>;
    const reserved = rejectUnforbiddable(body.forbiddenTools);
    if (reserved) return res.status(400).json({ error: reserved });
    const repo = AppDataSource.getRepository(CompanyPolicy);
    const policy = await repo.save(
      repo.create({
        companyId: cid,
        title: body.title.trim(),
        body: body.body ?? "",
        blockedRecipientDomains: body.blockedRecipientDomains ?? "",
        forbiddenTools: body.forbiddenTools ?? "",
        sortOrder: body.sortOrder ?? 0,
        enabled: body.enabled ?? true,
      }),
    );
    await recordAudit({
      companyId: cid,
      actorUserId: req.userId ?? null,
      action: "policy.create",
      targetType: "company_policy",
      targetId: policy.id,
      targetLabel: policy.title,
    });
    res.json(serializePolicy(policy));
  },
);

companyPoliciesRouter.patch(
  "/company-policies/:pid",
  validateParams(policyParamsSchema),
  validateBody(policySchema.partial()),
  async (req, res) => {
    const cid = req.params.cid;
    const body = req.body as Partial<z.infer<typeof policySchema>>;
    const reserved = rejectUnforbiddable(body.forbiddenTools);
    if (reserved) return res.status(400).json({ error: reserved });
    const repo = AppDataSource.getRepository(CompanyPolicy);
    const policy = await repo.findOneBy({ id: req.params.pid, companyId: cid });
    if (!policy) return res.status(404).json({ error: "Policy not found" });
    if (body.title !== undefined) policy.title = body.title.trim();
    if (body.body !== undefined) policy.body = body.body;
    if (body.blockedRecipientDomains !== undefined) {
      policy.blockedRecipientDomains = body.blockedRecipientDomains;
    }
    if (body.forbiddenTools !== undefined) policy.forbiddenTools = body.forbiddenTools;
    if (body.sortOrder !== undefined) policy.sortOrder = body.sortOrder;
    if (body.enabled !== undefined) policy.enabled = body.enabled;
    const saved = await repo.save(policy);
    await recordAudit({
      companyId: cid,
      actorUserId: req.userId ?? null,
      action: "policy.update",
      targetType: "company_policy",
      targetId: saved.id,
      targetLabel: saved.title,
      metadata: { fields: Object.keys(body) },
    });
    res.json(serializePolicy(saved));
  },
);

companyPoliciesRouter.delete(
  "/company-policies/:pid",
  validateParams(policyParamsSchema),
  async (req, res) => {
    const cid = req.params.cid;
    const repo = AppDataSource.getRepository(CompanyPolicy);
    const policy = await repo.findOneBy({ id: req.params.pid, companyId: cid });
    if (!policy) return res.status(404).json({ error: "Policy not found" });
    await repo.delete({ id: policy.id, companyId: cid });
    await recordAudit({
      companyId: cid,
      actorUserId: req.userId ?? null,
      action: "policy.delete",
      targetType: "company_policy",
      targetId: policy.id,
      targetLabel: policy.title,
    });
    res.json({ ok: true });
  },
);
