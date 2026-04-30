import fs from "node:fs";
import { Router } from "express";
import { z } from "zod";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { Skill } from "../db/entities/Skill.js";
import { Routine } from "../db/entities/Routine.js";
import { AIModel } from "../db/entities/AIModel.js";
import { JournalEntry } from "../db/entities/JournalEntry.js";
import { Approval } from "../db/entities/Approval.js";
import { McpServer } from "../db/entities/McpServer.js";
import { Team } from "../db/entities/Team.js";
import { Membership } from "../db/entities/Membership.js";
import { validateBody } from "../middleware/validate.js";
import { requireAuth, requireCompanyMember } from "../middleware/auth.js";
import { toSlug } from "../lib/slug.js";
import { employeeDir, ensureDir } from "../services/paths.js";
import { isModelConnected } from "../services/providers.js";
import { removeDir, soulTemplate, skillTemplate, routineTemplate } from "../services/files.js";
import { registerRoutine } from "../services/cron.js";
import { deleteEmployeeConversations } from "./employeeSurface.js";
import { recordAudit } from "../services/audit.js";
import { findTemplate } from "../services/templates.js";
import {
  avatarAbsPath,
  avatarUploadMiddleware,
  mimeFromKey,
  removeAvatarFile,
  replaceAvatarFile,
} from "../services/avatars.js";

export const employeesRouter = Router({ mergeParams: true });
employeesRouter.use(requireAuth);
employeesRouter.use(requireCompanyMember);

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
  // Include a lightweight model summary per employee so the dashboard can
  // show connection chips from a single roundtrip. Keep it minimal — the
  // full model shape lives at /employees/:eid/model.
  const models = await AppDataSource.getRepository(AIModel).find();
  const byEmp = new Map(models.map((m) => [m.employeeId, m]));
  const rows = emps.map((e) => {
    const m = byEmp.get(e.id);
    return {
      ...e,
      model: m
        ? {
            provider: m.provider,
            model: m.model,
            status: isModelConnected(m, co, e) ? "connected" : "not_connected",
          }
        : null,
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
    return res
      .status(409)
      .json({ error: "An employee with that name already exists" });
  }
  const repo = AppDataSource.getRepository(AIEmployee);
  const slug = await uniqueEmpSlug(co.id, toSlug(body.name));
  const template = body.templateId ? findTemplate(body.templateId) : undefined;
  if (body.templateId && !template) {
    return res.status(400).json({ error: "Unknown template" });
  }

  const soulBody = template
    ? template.soul.replace(
        /\b(Casey|Wren|Sam|Ivy|Sage|Remy|Juno|Quinn|Pax|Nova)\b/g,
        body.name,
      )
    : soulTemplate(body.name, body.role);

  const emp = repo.create({
    companyId: co.id,
    name: body.name,
    role: body.role,
    slug,
    soulBody,
  });
  await repo.save(emp);

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
    const routineRepo = AppDataSource.getRepository(Routine);
    for (const r of template.routines) {
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
});

employeesRouter.patch("/:eid", validateBody(patchSchema), async (req, res) => {
  const body = req.body as z.infer<typeof patchSchema>;
  const repo = AppDataSource.getRepository(AIEmployee);
  const emp = await repo.findOneBy({ id: req.params.eid, companyId: (req.params as Record<string, string>).cid });
  if (!emp) return res.status(404).json({ error: "Not found" });
  const co = await loadCompany(emp.companyId);
  if (!co) return res.status(404).json({ error: "Company not found" });
  const before = { name: emp.name, role: emp.role, slug: emp.slug };
  if (body.name !== undefined) {
    if (await findEmployeeByName(emp.companyId, body.name, emp.id)) {
      return res
        .status(409)
        .json({ error: "An employee with that name already exists" });
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
        return res
          .status(400)
          .json({ error: "An employee cannot report to themselves" });
      }
      const manager = await repo.findOneBy({
        id: body.reportsToEmployeeId,
        companyId: emp.companyId,
      });
      if (!manager) {
        return res
          .status(400)
          .json({ error: "Manager not found in this company" });
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
        return res
          .status(400)
          .json({ error: "Manager not found in this company" });
      }
      emp.reportsToUserId = human.userId;
      emp.reportsToEmployeeId = null;
    }
  }
  if (body.slug !== undefined) {
    const normalized = toSlug(body.slug);
    if (!normalized) {
      return res
        .status(400)
        .json({ error: "Slug must contain at least one letter or digit" });
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
        return res
          .status(409)
          .json({ error: "A data directory for that slug already exists" });
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
  const emp = await empRepo.findOneBy({ id: req.params.eid, companyId: (req.params as Record<string, string>).cid });
  if (!emp) return res.status(404).json({ error: "Not found" });
  const co = await loadCompany((req.params as Record<string, string>).cid);

  // Clear reporting lines that pointed at this employee so subordinates
  // don't carry a dangling manager reference.
  await empRepo.update(
    { reportsToEmployeeId: emp.id },
    { reportsToEmployeeId: null },
  );

  await AppDataSource.getRepository(Approval).delete({ employeeId: emp.id });
  await AppDataSource.getRepository(Routine).delete({ employeeId: emp.id });
  await AppDataSource.getRepository(Skill).delete({ employeeId: emp.id });
  await AppDataSource.getRepository(AIModel).delete({ employeeId: emp.id });
  await AppDataSource.getRepository(McpServer).delete({ employeeId: emp.id });
  await deleteEmployeeConversations(emp.id);
  await AppDataSource.getRepository(JournalEntry).delete({ employeeId: emp.id });
  await empRepo.delete({ id: emp.id });

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

employeesRouter.post(
  "/:eid/avatar",
  avatarUploadMiddleware.single("file"),
  async (req, res) => {
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
  },
);

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

