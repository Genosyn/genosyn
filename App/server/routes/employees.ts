import fs from "node:fs";
import { Router } from "express";
import { z } from "zod";
import { In } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { Skill } from "../db/entities/Skill.js";
import { Routine } from "../db/entities/Routine.js";
import { RoutineChatMessage } from "../db/entities/RoutineChatMessage.js";
import { Run } from "../db/entities/Run.js";
import { AIModel } from "../db/entities/AIModel.js";
import { JournalEntry } from "../db/entities/JournalEntry.js";
import { ProjectMember } from "../db/entities/ProjectMember.js";
import { Approval } from "../db/entities/Approval.js";
import { McpServer } from "../db/entities/McpServer.js";
import { Team } from "../db/entities/Team.js";
import { Membership } from "../db/entities/Membership.js";
import { Customer } from "../db/entities/Customer.js";
import { Contact } from "../db/entities/Contact.js";
import { Deal } from "../db/entities/Deal.js";
import { Activity } from "../db/entities/Activity.js";
import { Partnership } from "../db/entities/Partnership.js";
import { RevenueDocument } from "../db/entities/RevenueDocument.js";
import { RevenueImportBatch } from "../db/entities/RevenueImportBatch.js";
import { EmployeeSigningGrant } from "../db/entities/EmployeeSigningGrant.js";
import { SignatureEnvelope } from "../db/entities/SignatureEnvelope.js";
import { EmployeeVaultGrant } from "../db/entities/EmployeeVaultGrant.js";
import {
  deleteResourceGrantsForEmployee,
  grantAllResourcesToEmployee,
} from "../services/resources.js";
import { deleteExploreGrantsForEmployee, grantExploreToEmployee } from "../services/explore.js";
import { VaultItem } from "../db/entities/VaultItem.js";
import { validateBody, validateParams } from "../middleware/validate.js";
import {
  requireAuth,
  requireCompanyMember,
  requireCompanyRoleForMutations,
  onRoutePaths,
} from "../middleware/auth.js";
import { toSlug } from "../lib/slug.js";
import { employeeDir, ensureDir } from "../services/paths.js";
import { isModelConnected } from "../services/providers.js";
import { effectiveActiveId } from "../services/models.js";
import { removeDir, soulTemplate, skillTemplate, routineTemplate } from "../services/files.js";
import { registerRoutine } from "../services/cron.js";
import { deleteEmployeeConversations } from "./employeeSurface.js";
import { recordAudit } from "../services/audit.js";
import { findTemplate, personalizeTemplateSoul } from "../services/templates.js";
import { archiveEmployeeDirectMessages } from "../services/workspaceChat.js";
import {
  closeAllBrowserSessionsForEmployee,
  revokeDisabledBrowserSessionsForEmployee,
} from "../services/browserAccess.js";
import { removeBrowserStorageForEmployee } from "../services/browserStorage.js";
import { removeRepositoryPrivateStateForEmployee } from "../services/repositorySshFiles.js";
import { detachEmployeeFromTldrs, ensureDefaultTldrSchedule } from "../services/tldrs.js";
import {
  deleteBrowserRecordingsForRunIds,
  markBrowserRecordingEmployeeDeleting,
} from "../services/browserRecordings.js";
import {
  applyRoutineRecommendations,
  findRoutineRecommendationDefinition,
  loadOnboardingRecommendations,
} from "../services/onboardingRecommendations.js";
import {
  avatarAbsPath,
  avatarUploadMiddleware,
  mimeFromKey,
  removeAvatarFile,
  replaceAvatarFile,
} from "../services/avatars.js";
import {
  PlanLimitError,
  assertCanHireAiEmployee,
  routineCapacityRemaining,
} from "../services/entitlements.js";
import { syncSeatCount } from "../services/billing/companyBilling.js";

export const employeesRouter = Router({ mergeParams: true });
employeesRouter.use(requireAuth);
employeesRouter.use(requireCompanyMember);
employeesRouter.use(
  onRoutePaths(
    [/^\/$/, /^\/[^/]+(?:\/soul|\/avatar)?$/, /^\/[^/]+\/onboarding-recommendations\/routines$/],
    requireCompanyRoleForMutations("admin"),
  ),
);

async function loadCompany(cid: string): Promise<Company | null> {
  return AppDataSource.getRepository(Company).findOneBy({ id: cid });
}

async function uniqueEmpSlug(companyId: string, base: string): Promise<string> {
  const repo = AppDataSource.getRepository(AIEmployee);
  let slug = base || "employee";
  let n = 1;
  while (await repo.findOneBy({ companyId, slug })) {
    n += 1;
    slug = `${base}-${n}`;
  }
  return slug;
}

async function findEmployeeByName(
  companyId: string,
  name: string,
  excludeId?: string,
): Promise<AIEmployee | null> {
  const qb = AppDataSource.getRepository(AIEmployee)
    .createQueryBuilder("e")
    .where("e.companyId = :companyId", { companyId })
    .andWhere("LOWER(e.name) = LOWER(:name)", { name: name.trim() });
  if (excludeId) qb.andWhere("e.id != :excludeId", { excludeId });
  return qb.getOne();
}

employeesRouter.get("/", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const co = await loadCompany(cid);
  if (!co) return res.status(404).json({ error: "Company not found" });
  const emps = await AppDataSource.getRepository(AIEmployee).find({
    where: { companyId: cid },
  });
  // Include a lightweight summary of the *active* model per employee so the
  // dashboard can show connection chips from a single roundtrip. Keep it
  // minimal — the full model list lives at /employees/:eid/models.
  const models = await AppDataSource.getRepository(AIModel).find();
  const byEmp = new Map<string, AIModel[]>();
  for (const m of models) {
    const list = byEmp.get(m.employeeId);
    if (list) list.push(m);
    else byEmp.set(m.employeeId, [m]);
  }
  const rows = emps.map((e) => {
    const list = byEmp.get(e.id) ?? [];
    const activeId = effectiveActiveId(list);
    const m = list.find((x) => x.id === activeId) ?? null;
    return {
      ...e,
      model: m
        ? {
            provider: m.provider,
            model: m.model,
            status: isModelConnected(m) ? "connected" : "not_connected",
          }
        : null,
      modelCount: list.length,
    };
  });
  res.json(rows);
});

const createSchema = z.object({
  name: z.string().min(1).max(80),
  role: z.string().min(1).max(80),
  templateId: z.string().min(1).max(80).optional(),
});

employeesRouter.post("/", validateBody(createSchema), async (req, res) => {
  const body = req.body as z.infer<typeof createSchema>;
  const co = await loadCompany((req.params as Record<string, string>).cid);
  if (!co) return res.status(404).json({ error: "Company not found" });
  if (await findEmployeeByName(co.id, body.name)) {
    return res.status(409).json({ error: "An employee with that name already exists" });
  }
  // Plan limit (M56): a Free-plan company on a billing-enabled install caps
  // its headcount. 402 so the client can offer the upgrade path.
  try {
    await assertCanHireAiEmployee(co.id);
  } catch (err) {
    if (!(err instanceof PlanLimitError)) throw err;
    return res.status(402).json({ error: err.message });
  }
  const repo = AppDataSource.getRepository(AIEmployee);
  const slug = await uniqueEmpSlug(co.id, toSlug(body.name));
  const template = body.templateId ? findTemplate(body.templateId) : undefined;
  if (body.templateId && !template) {
    return res.status(400).json({ error: "Unknown template" });
  }

  const soulBody = template
    ? personalizeTemplateSoul(template, body.name)
    : soulTemplate(body.name, body.role);

  const emp = repo.create({
    companyId: co.id,
    name: body.name,
    role: body.role,
    slug,
    soulBody,
  });
  await repo.save(emp);
  await ensureDefaultTldrSchedule(co.id, emp.id);
  // Hand the new hire the company's existing library. `grantResourceToAllEmployees`
  // only ever ran from resource creation, so a company that filed its material
  // before hiring gave the new employee an empty shelf and no way to notice.
  // Awaited, not fire-and-forget: a Run started in the gap would read `[]` and
  // confidently report that the company has nothing on the subject.
  await grantAllResourcesToEmployee(co.id, emp.id);
  await grantExploreToEmployee(co.id, emp.id);

  // Employee cwd is still needed on disk — the CLI spawns there, writes
  // artifacts, and resolves `.mcp.json` + credentials. Soul / Skills /
  // Routines themselves live in the DB now, so no subdirectories are
  // pre-created.
  ensureDir(employeeDir(co.slug, slug));

  // Materialize template's skills + routines directly as DB rows. Skill and
  // routine bodies land in their respective `body` columns; no filesystem
  // writes beyond the already-created employee directory.
  if (template) {
    const skillRepo = AppDataSource.getRepository(Skill);
    for (const s of template.skills) {
      const sSlug = toSlug(s.name);
      const skillRow = skillRepo.create({
        employeeId: emp.id,
        name: s.name,
        slug: sSlug,
        body: s.readme || skillTemplate(s.name),
      });
      await skillRepo.save(skillRow);
    }
    // Plan limit (M56): the hire itself never fails on Routine capacity —
    // the seeded batch is capped at what the plan still allows, and the
    // remainder is silently skipped.
    const capacity = await routineCapacityRemaining(co.id);
    const seedable = capacity === null ? template.routines : template.routines.slice(0, capacity);
    const routineRepo = AppDataSource.getRepository(Routine);
    for (const r of seedable) {
      const rSlug = toSlug(r.name);
      const rRow = routineRepo.create({
        employeeId: emp.id,
        name: r.name,
        slug: rSlug,
        cronExpr: r.cronExpr,
        enabled: true,
        lastRunAt: null,
        body: r.readme || routineTemplate(r.name, r.cronExpr),
      });
      registerRoutine(rRow);
      await routineRepo.save(rRow);
    }
  }

  // Best-effort Stripe seat sync — never blocks the hire (M56).
  void syncSeatCount(co.id);

  await recordAudit({
    companyId: co.id,
    actorUserId: req.userId ?? null,
    action: "employee.create",
    targetType: "employee",
    targetId: emp.id,
    targetLabel: emp.name,
    metadata: { role: emp.role, slug: emp.slug, templateId: template?.id ?? null },
  });
  res.json(emp);
});

const onboardingRecommendationQuerySchema = z.object({
  templateId: z.string().min(1).max(80).optional(),
});
const onboardingRecommendationParamsSchema = z.object({
  cid: z.string().uuid(),
  eid: z.string().uuid(),
});

employeesRouter.get(
  "/:eid/onboarding-recommendations",
  validateParams(onboardingRecommendationParamsSchema),
  async (req, res) => {
    const query = onboardingRecommendationQuerySchema.safeParse(req.query);
    if (!query.success) {
      return res.status(400).json({ error: "ValidationError", issues: query.error.issues });
    }
    if (query.data.templateId && !findTemplate(query.data.templateId)) {
      return res.status(400).json({ error: "Unknown template" });
    }

    const cid = (req.params as Record<string, string>).cid;
    const [company, employee] = await Promise.all([
      loadCompany(cid),
      AppDataSource.getRepository(AIEmployee).findOneBy({
        id: req.params.eid,
        companyId: cid,
      }),
    ]);
    if (!company) return res.status(404).json({ error: "Company not found" });
    if (!employee) return res.status(404).json({ error: "Not found" });

    res.json(
      await loadOnboardingRecommendations({
        company,
        employee,
        templateId: query.data.templateId,
      }),
    );
  },
);

const applyRoutineRecommendationsSchema = z.object({
  recommendationIds: z.array(z.string().min(1).max(100)).min(1).max(5),
});

employeesRouter.post(
  "/:eid/onboarding-recommendations/routines",
  validateParams(onboardingRecommendationParamsSchema),
  validateBody(applyRoutineRecommendationsSchema),
  async (req, res) => {
    const body = req.body as z.infer<typeof applyRoutineRecommendationsSchema>;
    const invalidIds = [...new Set(body.recommendationIds)].filter(
      (id) => !findRoutineRecommendationDefinition(id),
    );
    if (invalidIds.length > 0) {
      return res.status(400).json({
        error: `Unknown Routine recommendation: ${invalidIds.join(", ")}`,
      });
    }

    const cid = (req.params as Record<string, string>).cid;
    const [company, employee] = await Promise.all([
      loadCompany(cid),
      AppDataSource.getRepository(AIEmployee).findOneBy({
        id: req.params.eid,
        companyId: cid,
      }),
    ]);
    if (!company) return res.status(404).json({ error: "Company not found" });
    if (!employee) return res.status(404).json({ error: "Not found" });

    try {
      const result = await applyRoutineRecommendations({
        company,
        employee,
        recommendationIds: body.recommendationIds,
        actorUserId: req.userId ?? null,
      });
      res.json(result);
    } catch (err) {
      // Plan limit (M56): the selection would exceed the Routine cap.
      if (!(err instanceof PlanLimitError)) throw err;
      res.status(402).json({ error: err.message });
    }
  },
);

employeesRouter.get("/:eid", async (req, res) => {
  const emp = await AppDataSource.getRepository(AIEmployee).findOneBy({
    id: req.params.eid,
    companyId: (req.params as Record<string, string>).cid,
  });
  if (!emp) return res.status(404).json({ error: "Not found" });
  res.json(emp);
});

const patchSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  role: z.string().min(1).max(80).optional(),
  slug: z.string().min(1).max(80).optional(),
  teamId: z.string().uuid().nullable().optional(),
  reportsToEmployeeId: z.string().uuid().nullable().optional(),
  reportsToUserId: z.string().uuid().nullable().optional(),
  browserEnabled: z.boolean().optional(),
  // Newline-separated host globs. The materializer trims and parses;
  // empty / whitespace-only strings clear the list.
  browserAllowedHosts: z.string().max(4000).nullable().optional(),
  browserApprovalRequired: z.boolean().optional(),
});

employeesRouter.patch("/:eid", validateBody(patchSchema), async (req, res) => {
  const body = req.body as z.infer<typeof patchSchema>;
  const repo = AppDataSource.getRepository(AIEmployee);
  const emp = await repo.findOneBy({
    id: req.params.eid,
    companyId: (req.params as Record<string, string>).cid,
  });
  if (!emp) return res.status(404).json({ error: "Not found" });
  const co = await loadCompany(emp.companyId);
  if (!co) return res.status(404).json({ error: "Company not found" });
  const before = { name: emp.name, role: emp.role, slug: emp.slug };
  if (body.name !== undefined) {
    if (await findEmployeeByName(emp.companyId, body.name, emp.id)) {
      return res.status(409).json({ error: "An employee with that name already exists" });
    }
    emp.name = body.name;
  }
  if (body.role !== undefined) emp.role = body.role;
  if (body.teamId !== undefined) {
    if (body.teamId === null) {
      emp.teamId = null;
    } else {
      const team = await AppDataSource.getRepository(Team).findOneBy({
        id: body.teamId,
        companyId: emp.companyId,
      });
      if (!team) {
        return res.status(400).json({ error: "Team not found in this company" });
      }
      emp.teamId = team.id;
    }
  }
  if (body.reportsToEmployeeId !== undefined) {
    if (body.reportsToEmployeeId === null) {
      emp.reportsToEmployeeId = null;
    } else {
      if (body.reportsToEmployeeId === emp.id) {
        return res.status(400).json({ error: "An employee cannot report to themselves" });
      }
      const manager = await repo.findOneBy({
        id: body.reportsToEmployeeId,
        companyId: emp.companyId,
      });
      if (!manager) {
        return res.status(400).json({ error: "Manager not found in this company" });
      }
      emp.reportsToEmployeeId = manager.id;
      // The two reporting fields are mutually exclusive — picking an AI
      // manager clears any human one and vice-versa.
      emp.reportsToUserId = null;
    }
  }
  if (body.reportsToUserId !== undefined) {
    if (body.reportsToUserId === null) {
      emp.reportsToUserId = null;
    } else {
      const human = await AppDataSource.getRepository(Membership).findOneBy({
        userId: body.reportsToUserId,
        companyId: emp.companyId,
      });
      if (!human) {
        return res.status(400).json({ error: "Manager not found in this company" });
      }
      emp.reportsToUserId = human.userId;
      emp.reportsToEmployeeId = null;
    }
  }
  if (body.browserEnabled !== undefined) {
    emp.browserEnabled = body.browserEnabled;
  }
  if (body.browserAllowedHosts !== undefined) {
    const next = body.browserAllowedHosts;
    emp.browserAllowedHosts = next === null || next.trim().length === 0 ? null : next;
  }
  if (body.browserApprovalRequired !== undefined) {
    emp.browserApprovalRequired = body.browserApprovalRequired;
  }
  if (body.slug !== undefined) {
    const normalized = toSlug(body.slug);
    if (!normalized) {
      return res.status(400).json({ error: "Slug must contain at least one letter or digit" });
    }
    if (normalized !== emp.slug) {
      const taken = await repo.findOneBy({ companyId: emp.companyId, slug: normalized });
      if (taken && taken.id !== emp.id) {
        return res.status(409).json({ error: "That slug is already taken" });
      }
      // Credentials + CLI artifacts live under the employee's directory; rename
      // it alongside the slug so relative paths (`.mcp.json`, `.claude`, …)
      // keep resolving after the rename.
      const oldDir = employeeDir(co.slug, emp.slug);
      const newDir = employeeDir(co.slug, normalized);
      if (fs.existsSync(newDir)) {
        return res.status(409).json({ error: "A data directory for that slug already exists" });
      }
      if (fs.existsSync(oldDir)) {
        try {
          fs.renameSync(oldDir, newDir);
        } catch (err) {
          return res.status(500).json({
            error: `Failed to rename employee directory: ${(err as Error).message}`,
          });
        }
      }
      emp.slug = normalized;
    }
  }
  await repo.save(emp);
  if (body.browserEnabled !== undefined) {
    await revokeDisabledBrowserSessionsForEmployee(emp.id);
  }
  await recordAudit({
    companyId: emp.companyId,
    actorUserId: req.userId ?? null,
    action: "employee.update",
    targetType: "employee",
    targetId: emp.id,
    targetLabel: emp.name,
    metadata: {
      before,
      after: { name: emp.name, role: emp.role, slug: emp.slug },
    },
  });
  res.json(emp);
});

employeesRouter.delete("/:eid", async (req, res) => {
  const empRepo = AppDataSource.getRepository(AIEmployee);
  const emp = await empRepo.findOneBy({
    id: req.params.eid,
    companyId: (req.params as Record<string, string>).cid,
  });
  if (!emp) return res.status(404).json({ error: "Not found" });
  markBrowserRecordingEmployeeDeleting(emp.id);
  const co = await loadCompany((req.params as Record<string, string>).cid);

  await closeAllBrowserSessionsForEmployee(emp.id);
  await detachEmployeeFromTldrs(emp.companyId, emp.id);

  // Clear reporting lines that pointed at this employee so subordinates
  // don't carry a dangling manager reference.
  await empRepo.update({ reportsToEmployeeId: emp.id }, { reportsToEmployeeId: null });

  const routines = await AppDataSource.getRepository(Routine).find({
    where: { employeeId: emp.id },
    select: { id: true },
  });
  const routineIds = routines.map((routine) => routine.id);
  const runs = routineIds.length
    ? await AppDataSource.getRepository(Run).find({
        where: { routineId: In(routineIds) },
        select: { id: true },
      })
    : [];
  await AppDataSource.getRepository(Approval).delete({ employeeId: emp.id });
  await deleteBrowserRecordingsForRunIds(runs.map((run) => run.id));
  if (routineIds.length) {
    await AppDataSource.getRepository(Run).delete({ routineId: In(routineIds) });
    // The Ask AI conversation on each routine goes with the routine. Nothing
    // can reach these rows once the routine is gone — the panel resolves a
    // routine first — so leaving them behind strands transcript text, Run log
    // excerpts included, in every future backup.
    await AppDataSource.getRepository(RoutineChatMessage).delete({
      routineId: In(routineIds),
    });
  }
  await AppDataSource.getRepository(Routine).delete({ employeeId: emp.id });
  await AppDataSource.getRepository(Skill).delete({ employeeId: emp.id });
  await AppDataSource.getRepository(AIModel).delete({ employeeId: emp.id });
  await AppDataSource.getRepository(McpServer).delete({ employeeId: emp.id });
  await deleteEmployeeConversations(emp.id);
  await archiveEmployeeDirectMessages(emp.id);
  await AppDataSource.getRepository(JournalEntry).delete({ employeeId: emp.id });
  await AppDataSource.getRepository(EmployeeSigningGrant).delete({ employeeId: emp.id });
  await AppDataSource.getRepository(EmployeeVaultGrant).delete({ employeeId: emp.id });
  // Resource grants outlived their employee until M62 — only company teardown
  // ever cleared them — which left the share modal rendering a permanent
  // "Unknown" row for everyone the company had ever fired.
  await deleteResourceGrantsForEmployee(emp.id);
  await deleteExploreGrantsForEmployee(emp.id);
  await AppDataSource.getRepository(VaultItem).update(
    { createdByEmployeeId: emp.id },
    { createdByEmployeeId: null },
  );
  await AppDataSource.getRepository(SignatureEnvelope).update(
    { createdByEmployeeId: emp.id },
    { createdByEmployeeId: null },
  );
  await AppDataSource.getRepository(Customer).update(
    { ownerEmployeeId: emp.id },
    { ownerEmployeeId: null },
  );
  await AppDataSource.getRepository(Contact).update(
    { ownerEmployeeId: emp.id },
    { ownerEmployeeId: null },
  );
  await AppDataSource.getRepository(Contact).update(
    { createdByEmployeeId: emp.id },
    { createdByEmployeeId: null },
  );
  await AppDataSource.getRepository(Deal).update(
    { ownerEmployeeId: emp.id },
    { ownerEmployeeId: null },
  );
  await AppDataSource.getRepository(Deal).update(
    { createdByEmployeeId: emp.id },
    { createdByEmployeeId: null },
  );
  await AppDataSource.getRepository(Activity).update(
    { assignedEmployeeId: emp.id },
    { assignedEmployeeId: null },
  );
  await AppDataSource.getRepository(Activity).update(
    { actorEmployeeId: emp.id },
    { actorEmployeeId: null },
  );
  await AppDataSource.getRepository(Partnership).update(
    { ownerEmployeeId: emp.id },
    { ownerEmployeeId: null },
  );
  await AppDataSource.getRepository(Partnership).update(
    { createdByEmployeeId: emp.id },
    { createdByEmployeeId: null },
  );
  await AppDataSource.getRepository(RevenueDocument).update(
    { createdByEmployeeId: emp.id },
    { createdByEmployeeId: null },
  );
  await AppDataSource.getRepository(RevenueImportBatch).update(
    { createdByEmployeeId: emp.id },
    { createdByEmployeeId: null },
  );
  // Access entries are deleted, not nulled — a row whose employee is gone
  // matches nobody and would linger in the project's Access list.
  await AppDataSource.getRepository(ProjectMember).delete({ employeeId: emp.id });
  await empRepo.delete({ id: emp.id });
  // Recheck after the row is gone. A settings update that began while the
  // longer cleanup above was running may have selected this employee after
  // the first detach; its transaction-level ownership check now sees the
  // deletion, and this pass clears any assignment that committed just before
  // it.
  await detachEmployeeFromTldrs(emp.companyId, emp.id);

  await removeBrowserStorageForEmployee(emp.companyId, emp.id);
  removeRepositoryPrivateStateForEmployee(emp.companyId, emp.id);
  if (co) removeDir(employeeDir(co.slug, emp.slug));
  await recordAudit({
    companyId: emp.companyId,
    actorUserId: req.userId ?? null,
    action: "employee.delete",
    targetType: "employee",
    targetId: emp.id,
    targetLabel: emp.name,
    metadata: { role: emp.role, slug: emp.slug },
  });
  // Best-effort Stripe seat sync — never blocks the fire (M56).
  void syncSeatCount(emp.companyId);
  res.json({ ok: true });
});

// Soul — stored on the AIEmployee row as `soulBody`.
employeesRouter.get("/:eid/soul", async (req, res) => {
  const emp = await AppDataSource.getRepository(AIEmployee).findOneBy({
    id: req.params.eid,
    companyId: (req.params as Record<string, string>).cid,
  });
  if (!emp) return res.status(404).json({ error: "Not found" });
  res.json({ content: emp.soulBody });
});

const soulSchema = z.object({ content: z.string() });

employeesRouter.put("/:eid/soul", validateBody(soulSchema), async (req, res) => {
  const repo = AppDataSource.getRepository(AIEmployee);
  const emp = await repo.findOneBy({
    id: req.params.eid,
    companyId: (req.params as Record<string, string>).cid,
  });
  if (!emp) return res.status(404).json({ error: "Not found" });
  emp.soulBody = (req.body as z.infer<typeof soulSchema>).content;
  await repo.save(emp);
  res.json({ ok: true });
});

// ───────────────────────────── Avatar ──────────────────────────────
//
// GET is public-to-company-members (requireCompanyMember above already gates)
// so the UI can embed a bare `<img src>` without wiring headers. POST accepts
// a single `file` multipart field; DELETE clears the avatar on disk + DB.

employeesRouter.get("/:eid/avatar", async (req, res) => {
  const repo = AppDataSource.getRepository(AIEmployee);
  const emp = await repo.findOneBy({
    id: req.params.eid,
    companyId: (req.params as Record<string, string>).cid,
  });
  if (!emp || !emp.avatarKey) return res.status(404).json({ error: "Not found" });
  const abs = avatarAbsPath(emp.avatarKey);
  if (!abs || !fs.existsSync(abs)) {
    return res.status(404).json({ error: "Not found" });
  }
  res.setHeader("Content-Type", mimeFromKey(emp.avatarKey));
  res.setHeader("Cache-Control", "private, max-age=60");
  res.sendFile(abs);
});

employeesRouter.post("/:eid/avatar", avatarUploadMiddleware.single("file"), async (req, res) => {
  const file = (req as unknown as { file?: Express.Multer.File }).file;
  if (!file) return res.status(400).json({ error: "No file uploaded" });
  const repo = AppDataSource.getRepository(AIEmployee);
  const emp = await repo.findOneBy({
    id: req.params.eid,
    companyId: (req.params as Record<string, string>).cid,
  });
  if (!emp) {
    // Row missing — drop the freshly-written file so we don't orphan it.
    removeAvatarFile(file.filename);
    return res.status(404).json({ error: "Not found" });
  }
  const previousKey = emp.avatarKey;
  emp.avatarKey = file.filename;
  await repo.save(emp);
  replaceAvatarFile(previousKey, file.filename);
  res.json({ avatarKey: emp.avatarKey });
});

employeesRouter.delete("/:eid/avatar", async (req, res) => {
  const repo = AppDataSource.getRepository(AIEmployee);
  const emp = await repo.findOneBy({
    id: req.params.eid,
    companyId: (req.params as Record<string, string>).cid,
  });
  if (!emp) return res.status(404).json({ error: "Not found" });
  const previous = emp.avatarKey;
  emp.avatarKey = null;
  await repo.save(emp);
  removeAvatarFile(previous);
  res.json({ ok: true });
});
