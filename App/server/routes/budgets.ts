import { Router } from "express";
import { z } from "zod";
import { MoreThan } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { AdSpendEvent } from "../db/entities/AdSpendEvent.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Budget } from "../db/entities/Budget.js";
import { IntegrationConnection } from "../db/entities/IntegrationConnection.js";
import {
  onRoutePaths,
  requireAuth,
  requireCompanyMember,
  requireCompanyRoleForMutations,
} from "../middleware/auth.js";
import { validateBody, validateParams } from "../middleware/validate.js";
import { recordAudit } from "../services/audit.js";

/**
 * Monthly ad-spend Budgets (M53). Reads member-level; mutations admin-gated —
 * an envelope is spend authority. Each row reports its current-month spend so
 * the page renders headroom without a second endpoint.
 */
export const budgetsRouter = Router({ mergeParams: true });
budgetsRouter.use(requireAuth);
budgetsRouter.use(requireCompanyMember);
budgetsRouter.use(onRoutePaths(["/budgets"], requireCompanyRoleForMutations("admin")));

const companyParamsSchema = z.object({ cid: z.string().uuid() }).strict();
const budgetParamsSchema = z.object({ cid: z.string().uuid(), bid: z.string().uuid() }).strict();

const budgetSchema = z.object({
  name: z.string().min(1).max(80),
  amountMinor: z.number().int().min(1),
  currency: z.string().min(3).max(3).optional(),
  connectionId: z.string().uuid().nullable().optional(),
  employeeId: z.string().uuid().nullable().optional(),
  enabled: z.boolean().optional(),
});

function monthStart(): Date {
  const start = new Date();
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);
  return start;
}

async function spentThisMonth(companyId: string, budget: Budget): Promise<number> {
  const rows = await AppDataSource.getRepository(AdSpendEvent).find({
    where: { companyId, createdAt: MoreThan(monthStart()) },
    select: ["amountMinor", "connectionId", "employeeId"],
  });
  return rows
    .filter(
      (r) =>
        r.amountMinor > 0 &&
        (budget.connectionId === null || r.connectionId === budget.connectionId) &&
        (budget.employeeId === null || r.employeeId === budget.employeeId),
    )
    .reduce((sum, r) => sum + r.amountMinor, 0);
}

async function serializeBudget(budget: Budget) {
  return {
    id: budget.id,
    name: budget.name,
    amountMinor: budget.amountMinor,
    currency: budget.currency,
    connectionId: budget.connectionId,
    employeeId: budget.employeeId,
    enabled: budget.enabled,
    spentThisMonthMinor: await spentThisMonth(budget.companyId, budget),
    createdAt: budget.createdAt.toISOString(),
  };
}

budgetsRouter.get("/budgets", validateParams(companyParamsSchema), async (req, res) => {
  const budgets = await AppDataSource.getRepository(Budget).find({
    where: { companyId: req.params.cid },
    order: { createdAt: "ASC" },
  });
  res.json(await Promise.all(budgets.map(serializeBudget)));
});

budgetsRouter.post(
  "/budgets",
  validateParams(companyParamsSchema),
  validateBody(budgetSchema),
  async (req, res) => {
    const cid = req.params.cid;
    const body = req.body as z.infer<typeof budgetSchema>;
    if (body.connectionId) {
      const connection = await AppDataSource.getRepository(IntegrationConnection).findOneBy({
        id: body.connectionId,
        companyId: cid,
      });
      if (!connection) {
        return res.status(400).json({ error: "Connection not found in this company" });
      }
    }
    if (
      body.employeeId &&
      !(await AppDataSource.getRepository(AIEmployee).countBy({ id: body.employeeId, companyId: cid }))
    ) {
      return res.status(400).json({ error: "Employee not found in this company" });
    }
    const repo = AppDataSource.getRepository(Budget);
    const budget = await repo.save(
      repo.create({
        companyId: cid,
        name: body.name.trim(),
        amountMinor: body.amountMinor,
        currency: (body.currency ?? "USD").toUpperCase(),
        connectionId: body.connectionId ?? null,
        employeeId: body.employeeId ?? null,
        enabled: body.enabled ?? true,
        createdById: req.userId ?? null,
      }),
    );
    await recordAudit({
      companyId: cid,
      actorUserId: req.userId ?? null,
      action: "budget.create",
      targetType: "budget",
      targetId: budget.id,
      targetLabel: budget.name,
      metadata: { amountMinor: budget.amountMinor },
    });
    res.json(await serializeBudget(budget));
  },
);

budgetsRouter.patch(
  "/budgets/:bid",
  validateParams(budgetParamsSchema),
  validateBody(budgetSchema.partial()),
  async (req, res) => {
    const cid = req.params.cid;
    const body = req.body as Partial<z.infer<typeof budgetSchema>>;
    const repo = AppDataSource.getRepository(Budget);
    const budget = await repo.findOneBy({ id: req.params.bid, companyId: cid });
    if (!budget) return res.status(404).json({ error: "Budget not found" });
    if (body.name !== undefined) budget.name = body.name.trim();
    if (body.amountMinor !== undefined) budget.amountMinor = body.amountMinor;
    if (body.currency !== undefined) budget.currency = body.currency.toUpperCase();
    if (body.connectionId !== undefined) {
      if (
        body.connectionId &&
        !(await AppDataSource.getRepository(IntegrationConnection).countBy({
          id: body.connectionId,
          companyId: cid,
        }))
      ) {
        return res.status(400).json({ error: "Connection not found in this company" });
      }
      budget.connectionId = body.connectionId ?? null;
    }
    if (body.employeeId !== undefined) {
      if (
        body.employeeId &&
        !(await AppDataSource.getRepository(AIEmployee).countBy({
          id: body.employeeId,
          companyId: cid,
        }))
      ) {
        return res.status(400).json({ error: "Employee not found in this company" });
      }
      budget.employeeId = body.employeeId ?? null;
    }
    if (body.enabled !== undefined) budget.enabled = body.enabled;
    const saved = await repo.save(budget);
    await recordAudit({
      companyId: cid,
      actorUserId: req.userId ?? null,
      action: "budget.update",
      targetType: "budget",
      targetId: saved.id,
      targetLabel: saved.name,
      metadata: { fields: Object.keys(body) },
    });
    res.json(await serializeBudget(saved));
  },
);

budgetsRouter.delete("/budgets/:bid", validateParams(budgetParamsSchema), async (req, res) => {
  const cid = req.params.cid;
  const repo = AppDataSource.getRepository(Budget);
  const budget = await repo.findOneBy({ id: req.params.bid, companyId: cid });
  if (!budget) return res.status(404).json({ error: "Budget not found" });
  await repo.delete({ id: budget.id, companyId: cid });
  await recordAudit({
    companyId: cid,
    actorUserId: req.userId ?? null,
    action: "budget.delete",
    targetType: "budget",
    targetId: budget.id,
    targetLabel: budget.name,
  });
  res.json({ ok: true });
});
