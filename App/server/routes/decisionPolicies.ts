import { Router } from "express";
import { z } from "zod";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { DecisionPolicy } from "../db/entities/DecisionPolicy.js";
import {
  onRoutePaths,
  requireAuth,
  requireCompanyMember,
  requireCompanyRoleForMutations,
} from "../middleware/auth.js";
import { validateBody, validateParams } from "../middleware/validate.js";
import { recordAudit } from "../services/audit.js";

/**
 * The decision-rights matrix (M53). Reads are member-level — every Member can
 * see who answers for whom, the same way they can see the stack itself.
 * Mutations are admin-gated: a rule redirects questions away from human
 * inboxes, which is a company-authority decision.
 */
export const decisionPoliciesRouter = Router({ mergeParams: true });
decisionPoliciesRouter.use(requireAuth);
decisionPoliciesRouter.use(requireCompanyMember);
decisionPoliciesRouter.use(
  onRoutePaths(["/decision-policies"], requireCompanyRoleForMutations("admin")),
);

const companyParamsSchema = z.object({ cid: z.string().uuid() }).strict();
const ruleParamsSchema = z.object({ cid: z.string().uuid(), pid: z.string().uuid() }).strict();

const ruleSchema = z
  .object({
    askingEmployeeId: z.string().uuid().nullable().optional(),
    deciderKind: z.enum(["manager", "employee"]),
    deciderEmployeeId: z.string().uuid().nullable().optional(),
    sortOrder: z.number().int().min(0).max(10_000).optional(),
    enabled: z.boolean().optional(),
  })
  .refine(
    (r) => (r.deciderKind === "employee" ? !!r.deciderEmployeeId : !r.deciderEmployeeId),
    "A named-employee rule needs a decider; a manager rule must not name one",
  );

function serializeRule(rule: DecisionPolicy) {
  return {
    id: rule.id,
    askingEmployeeId: rule.askingEmployeeId,
    deciderKind: rule.deciderKind,
    deciderEmployeeId: rule.deciderEmployeeId,
    sortOrder: rule.sortOrder,
    enabled: rule.enabled,
    createdAt: rule.createdAt.toISOString(),
  };
}

async function assertCompanyEmployee(companyId: string, employeeId: string): Promise<boolean> {
  return (
    (await AppDataSource.getRepository(AIEmployee).countBy({ id: employeeId, companyId })) > 0
  );
}

decisionPoliciesRouter.get(
  "/decision-policies",
  validateParams(companyParamsSchema),
  async (req, res) => {
    const rules = await AppDataSource.getRepository(DecisionPolicy).find({
      where: { companyId: req.params.cid },
      order: { sortOrder: "ASC", createdAt: "ASC" },
    });
    res.json(rules.map(serializeRule));
  },
);

decisionPoliciesRouter.post(
  "/decision-policies",
  validateParams(companyParamsSchema),
  validateBody(ruleSchema),
  async (req, res) => {
    const cid = req.params.cid;
    const body = req.body as z.infer<typeof ruleSchema>;
    if (body.askingEmployeeId && !(await assertCompanyEmployee(cid, body.askingEmployeeId))) {
      return res.status(400).json({ error: "Asking employee not found in this company" });
    }
    if (body.deciderEmployeeId && !(await assertCompanyEmployee(cid, body.deciderEmployeeId))) {
      return res.status(400).json({ error: "Decider employee not found in this company" });
    }
    if (body.askingEmployeeId && body.askingEmployeeId === body.deciderEmployeeId) {
      return res.status(400).json({ error: "An employee cannot answer its own questions" });
    }
    const repo = AppDataSource.getRepository(DecisionPolicy);
    const rule = await repo.save(
      repo.create({
        companyId: cid,
        askingEmployeeId: body.askingEmployeeId ?? null,
        deciderKind: body.deciderKind,
        deciderEmployeeId: body.deciderEmployeeId ?? null,
        sortOrder: body.sortOrder ?? 0,
        enabled: body.enabled ?? true,
      }),
    );
    await recordAudit({
      companyId: cid,
      actorUserId: req.userId ?? null,
      action: "decision.policy.create",
      targetType: "decision_policy",
      targetId: rule.id,
      metadata: { deciderKind: rule.deciderKind },
    });
    res.json(serializeRule(rule));
  },
);

decisionPoliciesRouter.patch(
  "/decision-policies/:pid",
  validateParams(ruleParamsSchema),
  validateBody(ruleSchema.innerType().partial()),
  async (req, res) => {
    const cid = req.params.cid;
    const body = req.body as Partial<z.infer<typeof ruleSchema>>;
    const repo = AppDataSource.getRepository(DecisionPolicy);
    const rule = await repo.findOneBy({ id: req.params.pid, companyId: cid });
    if (!rule) return res.status(404).json({ error: "Rule not found" });
    if (body.askingEmployeeId !== undefined) {
      if (body.askingEmployeeId && !(await assertCompanyEmployee(cid, body.askingEmployeeId))) {
        return res.status(400).json({ error: "Asking employee not found in this company" });
      }
      rule.askingEmployeeId = body.askingEmployeeId ?? null;
    }
    if (body.deciderKind !== undefined) rule.deciderKind = body.deciderKind;
    if (body.deciderEmployeeId !== undefined) {
      if (body.deciderEmployeeId && !(await assertCompanyEmployee(cid, body.deciderEmployeeId))) {
        return res.status(400).json({ error: "Decider employee not found in this company" });
      }
      rule.deciderEmployeeId = body.deciderEmployeeId ?? null;
    }
    if (rule.deciderKind === "employee" && !rule.deciderEmployeeId) {
      return res.status(400).json({ error: "A named-employee rule needs a decider" });
    }
    if (rule.deciderKind === "manager" && rule.deciderEmployeeId) {
      return res.status(400).json({ error: "A manager rule must not name a decider" });
    }
    if (rule.askingEmployeeId && rule.askingEmployeeId === rule.deciderEmployeeId) {
      return res.status(400).json({ error: "An employee cannot answer its own questions" });
    }
    if (body.sortOrder !== undefined) rule.sortOrder = body.sortOrder;
    if (body.enabled !== undefined) rule.enabled = body.enabled;
    const saved = await repo.save(rule);
    await recordAudit({
      companyId: cid,
      actorUserId: req.userId ?? null,
      action: "decision.policy.update",
      targetType: "decision_policy",
      targetId: saved.id,
      metadata: { fields: Object.keys(body) },
    });
    res.json(serializeRule(saved));
  },
);

decisionPoliciesRouter.delete(
  "/decision-policies/:pid",
  validateParams(ruleParamsSchema),
  async (req, res) => {
    const cid = req.params.cid;
    const repo = AppDataSource.getRepository(DecisionPolicy);
    const rule = await repo.findOneBy({ id: req.params.pid, companyId: cid });
    if (!rule) return res.status(404).json({ error: "Rule not found" });
    await repo.delete({ id: rule.id, companyId: cid });
    await recordAudit({
      companyId: cid,
      actorUserId: req.userId ?? null,
      action: "decision.policy.delete",
      targetType: "decision_policy",
      targetId: rule.id,
    });
    res.json({ ok: true });
  },
);
