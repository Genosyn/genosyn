import { Router } from "express";
import { z } from "zod";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { validateBody, validateParams } from "../middleware/validate.js";
import {
  requireAuth,
  requireBrowserSession,
  requireCompanyMember,
  requireCompanyRoleForMutations,
} from "../middleware/auth.js";
import { ModelSetupError } from "../services/modelCatalog.js";
import {
  attachModel,
  attachedModels,
  detachModel,
  findAttachedModel,
  modelUsers,
  setActiveModel,
} from "../services/models.js";
import { healthByModel, toPublicModel } from "../services/modelViews.js";
import { auditEmployeeModel } from "./companyModels.js";

/**
 * One AI Employee's AI Models, mounted at
 * `/api/companies/:cid/employees/:eid/models`.
 *
 * AI Models belong to the company (`routes/companyModels.ts`, Settings → AI
 * Models). This router is only which of them this employee uses: the list,
 * with the active one marked and who else shares each; `POST /attach` puts a
 * company model on the employee; `POST /:id/activate` switches which attached
 * model its Routines and chat use; `DELETE /:id` detaches one — the model, its
 * keys and every other employee's use of it stay. Everything about the model
 * itself — its keys, sign-in, endpoint, Test connection — is a company route
 * keyed on the model.
 *
 * Any Member reads the list; owners and admins change it, from a signed-in
 * browser only — no API key, Genosyn MCP client or AI Employee tool chooses
 * an employee's brain.
 */
export const modelsRouter = Router({ mergeParams: true });
modelsRouter.use(requireAuth);
modelsRouter.use(requireCompanyMember);
modelsRouter.use(requireBrowserSession);
modelsRouter.use(requireCompanyRoleForMutations("admin"));

const collectionParamsSchema = z.object({ cid: z.string().uuid(), eid: z.string().uuid() });
const itemParamsSchema = collectionParamsSchema.extend({ id: z.string().uuid() });

type CoEmp = { co: Company; emp: AIEmployee };

async function loadContext(cid: string, eid: string): Promise<CoEmp | { error: string }> {
  const co = await AppDataSource.getRepository(Company).findOneBy({ id: cid });
  if (!co) return { error: "Company not found" };
  const emp = await AppDataSource.getRepository(AIEmployee).findOneBy({
    id: eid,
    companyId: cid,
  });
  if (!emp) return { error: "Employee not found" };
  return { co, emp };
}

/** The employee's attached models for the wire, newest attachment first. */
async function employeeModelList(co: Company, emp: AIEmployee) {
  const { models, activeId } = await attachedModels(emp.id);
  const [health, users] = await Promise.all([healthByModel(models), modelUsers(co.id)]);
  return models.map((m) =>
    toPublicModel(m, {
      isActive: m.id === activeId,
      health: health.get(m.id),
      employees: users.get(m.id) ?? [],
    }),
  );
}

/** One attached model as the employee's list shows it. */
async function employeeModelView(co: Company, emp: AIEmployee, modelId: string) {
  return (await employeeModelList(co, emp)).find((m) => m.id === modelId) ?? null;
}

// GET /api/companies/:cid/employees/:eid/models — the employee's attached
// models, newest attachment first, the active one marked.
modelsRouter.get("/", validateParams(collectionParamsSchema), async (req, res) => {
  const p = req.params as Record<string, string>;
  const ctx = await loadContext(p.cid, p.eid);
  if ("error" in ctx) return res.status(404).json({ error: ctx.error });
  res.json(await employeeModelList(ctx.co, ctx.emp));
});

// POST /api/companies/:cid/employees/:eid/models/attach — put one of the
// company's connected AI Models on this employee, as its active model unless
// `makeActive` is false. Replaces copying another employee's model: the
// employee runs on the same model, keys and all, so there is nothing to paste
// and nothing to keep in step.
const attachSchema = z
  .object({ modelId: z.string().uuid(), makeActive: z.boolean().optional() })
  .strict();

modelsRouter.post(
  "/attach",
  validateParams(collectionParamsSchema),
  validateBody(attachSchema),
  async (req, res) => {
    const p = req.params as Record<string, string>;
    const ctx = await loadContext(p.cid, p.eid);
    if ("error" in ctx) return res.status(404).json({ error: ctx.error });
    const body = req.body as z.infer<typeof attachSchema>;
    let result: Awaited<ReturnType<typeof attachModel>>;
    try {
      result = await attachModel({
        companyId: ctx.co.id,
        modelId: body.modelId,
        employeeIds: [ctx.emp.id],
        makeActive: body.makeActive,
      });
    } catch (error) {
      if (!(error instanceof ModelSetupError)) throw error;
      return res.status(error.status).json(error.responseBody());
    }
    if (result.attached.length > 0) {
      await auditEmployeeModel(req, ctx.co.id, ctx.emp, result.model, "model.attach");
    } else if (body.makeActive !== false) {
      await auditEmployeeModel(req, ctx.co.id, ctx.emp, result.model, "model.activate");
    }
    res.json(await employeeModelView(ctx.co, ctx.emp, result.model.id));
  },
);

// POST /api/companies/:cid/employees/:eid/models/:id/activate — switch brain.
modelsRouter.post("/:id/activate", validateParams(itemParamsSchema), async (req, res) => {
  const p = req.params as Record<string, string>;
  const ctx = await loadContext(p.cid, p.eid);
  if ("error" in ctx) return res.status(404).json({ error: ctx.error });
  const model = await findAttachedModel(ctx.emp.id, p.id);
  if (!model || !(await setActiveModel(ctx.co.id, ctx.emp.id, model.id))) {
    return res.status(404).json({ error: "Model not found" });
  }
  await auditEmployeeModel(req, ctx.co.id, ctx.emp, model, "model.activate");
  res.json(await employeeModelView(ctx.co, ctx.emp, model.id));
});

// DELETE /api/companies/:cid/employees/:eid/models/:id — detach one model from
// this employee. The model stays in the company with its keys, and anyone else
// using it keeps it; if it was the active one, the employee's most recently
// attached other model takes over, and Routines pinned to it go back to that.
modelsRouter.delete("/:id", validateParams(itemParamsSchema), async (req, res) => {
  const p = req.params as Record<string, string>;
  const ctx = await loadContext(p.cid, p.eid);
  if ("error" in ctx) return res.status(404).json({ error: ctx.error });
  const model = await findAttachedModel(ctx.emp.id, p.id);
  if (!model) return res.status(404).json({ error: "Model not found" });
  try {
    await detachModel({ companyId: ctx.co.id, modelId: model.id, employeeIds: [ctx.emp.id] });
  } catch (error) {
    if (!(error instanceof ModelSetupError)) throw error;
    return res.status(error.status).json(error.responseBody());
  }
  await auditEmployeeModel(req, ctx.co.id, ctx.emp, model, "model.detach");
  res.json({ ok: true });
});
