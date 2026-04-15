import { Router } from "express";
import { z } from "zod";
import cron from "node-cron";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { Routine } from "../db/entities/Routine.js";
import { Run } from "../db/entities/Run.js";
import { Approval } from "../db/entities/Approval.js";
import fs from "node:fs";
import crypto from "node:crypto";
import { validateBody } from "../middleware/validate.js";
import { requireAuth, requireCompanyMember } from "../middleware/auth.js";
import { toSlug } from "../lib/slug.js";
import { routineDir, routineReadme } from "../services/paths.js";
import { readText, removeDir, routineTemplate, writeText } from "../services/files.js";
import { registerRoutine, unregisterRoutine } from "../services/cron.js";
import { runRoutine } from "../services/runner.js";
import { recordAudit } from "../services/audit.js";

export const routinesRouter = Router({ mergeParams: true });
routinesRouter.use(requireAuth);
routinesRouter.use(requireCompanyMember);

async function loadEmp(cid: string, eid: string) {
  return AppDataSource.getRepository(AIEmployee).findOneBy({ id: eid, companyId: cid });
}
async function loadCo(cid: string) {
  return AppDataSource.getRepository(Company).findOneBy({ id: cid });
}

async function uniqueSlug(employeeId: string, base: string): Promise<string> {
  const repo = AppDataSource.getRepository(Routine);
  let slug = base || "routine";
  let n = 1;
  while (await repo.findOneBy({ employeeId, slug })) {
    n += 1;
    slug = `${base}-${n}`;
  }
  return slug;
}

routinesRouter.get("/employees/:eid/routines", async (req, res) => {
  const emp = await loadEmp((req.params as Record<string, string>).cid, req.params.eid);
  if (!emp) return res.status(404).json({ error: "Employee not found" });
  const routines = await AppDataSource.getRepository(Routine).find({
    where: { employeeId: emp.id },
  });
  res.json(routines);
});

const createSchema = z.object({
  name: z.string().min(1).max(80),
  cronExpr: z.string().refine((v) => cron.validate(v), "Invalid cron expression"),
});

routinesRouter.post(
  "/employees/:eid/routines",
  validateBody(createSchema),
  async (req, res) => {
    const emp = await loadEmp((req.params as Record<string, string>).cid, req.params.eid);
    if (!emp) return res.status(404).json({ error: "Employee not found" });
    const co = await loadCo((req.params as Record<string, string>).cid);
    if (!co) return res.status(404).json({ error: "Company not found" });
    const body = req.body as z.infer<typeof createSchema>;
    const slug = await uniqueSlug(emp.id, toSlug(body.name));
    const repo = AppDataSource.getRepository(Routine);
    const r = repo.create({
      employeeId: emp.id,
      name: body.name,
      slug,
      cronExpr: body.cronExpr,
      enabled: true,
      lastRunAt: null,
    });
    await repo.save(r);
    writeText(routineReadme(co.slug, emp.slug, slug), routineTemplate(body.name, body.cronExpr));
    registerRoutine(r);
    await recordAudit({
      companyId: co.id,
      actorUserId: req.userId ?? null,
      action: "routine.create",
      targetType: "routine",
      targetId: r.id,
      targetLabel: r.name,
      metadata: { employeeId: emp.id, cronExpr: r.cronExpr },
    });
    res.json(r);
  },
);

async function loadRoutine(cid: string, rid: string) {
  const r = await AppDataSource.getRepository(Routine).findOneBy({ id: rid });
  if (!r) return null;
  const emp = await AppDataSource.getRepository(AIEmployee).findOneBy({
    id: r.employeeId,
    companyId: cid,
  });
  if (!emp) return null;
  const co = await loadCo(cid);
  if (!co) return null;
  return { routine: r, emp, co };
}

const patchSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  cronExpr: z
    .string()
    .refine((v) => cron.validate(v), "Invalid cron expression")
    .optional(),
  enabled: z.boolean().optional(),
  timeoutSec: z.number().int().min(10).max(6 * 60 * 60).optional(),
  requiresApproval: z.boolean().optional(),
});

routinesRouter.patch(
  "/routines/:rid",
  validateBody(patchSchema),
  async (req, res) => {
    const found = await loadRoutine((req.params as Record<string, string>).cid, req.params.rid);
    if (!found) return res.status(404).json({ error: "Not found" });
    const body = req.body as z.infer<typeof patchSchema>;
    const r = found.routine;
    if (body.name !== undefined) r.name = body.name;
    if (body.cronExpr !== undefined) r.cronExpr = body.cronExpr;
    if (body.enabled !== undefined) r.enabled = body.enabled;
    if (body.timeoutSec !== undefined) r.timeoutSec = body.timeoutSec;
    if (body.requiresApproval !== undefined) r.requiresApproval = body.requiresApproval;
    await AppDataSource.getRepository(Routine).save(r);
    registerRoutine(r);
    await recordAudit({
      companyId: found.co.id,
      actorUserId: req.userId ?? null,
      action: "routine.update",
      targetType: "routine",
      targetId: r.id,
      targetLabel: r.name,
      metadata: { changes: body },
    });
    res.json(r);
  },
);

routinesRouter.delete("/routines/:rid", async (req, res) => {
  const found = await loadRoutine((req.params as Record<string, string>).cid, req.params.rid);
  if (!found) return res.status(404).json({ error: "Not found" });
  unregisterRoutine(found.routine.id);
  await AppDataSource.getRepository(Approval).delete({ routineId: found.routine.id });
  await AppDataSource.getRepository(Routine).delete({ id: found.routine.id });
  removeDir(routineDir(found.co.slug, found.emp.slug, found.routine.slug));
  await recordAudit({
    companyId: found.co.id,
    actorUserId: req.userId ?? null,
    action: "routine.delete",
    targetType: "routine",
    targetId: found.routine.id,
    targetLabel: found.routine.name,
    metadata: { employeeId: found.emp.id },
  });
  res.json({ ok: true });
});

routinesRouter.get("/routines/:rid/readme", async (req, res) => {
  const found = await loadRoutine((req.params as Record<string, string>).cid, req.params.rid);
  if (!found) return res.status(404).json({ error: "Not found" });
  res.json({
    content: readText(routineReadme(found.co.slug, found.emp.slug, found.routine.slug)),
  });
});

const readmeSchema = z.object({ content: z.string() });

routinesRouter.put(
  "/routines/:rid/readme",
  validateBody(readmeSchema),
  async (req, res) => {
    const found = await loadRoutine((req.params as Record<string, string>).cid, req.params.rid);
    if (!found) return res.status(404).json({ error: "Not found" });
    writeText(
      routineReadme(found.co.slug, found.emp.slug, found.routine.slug),
      (req.body as z.infer<typeof readmeSchema>).content,
    );
    res.json({ ok: true });
  },
);

/**
 * Turn webhook on (generates a fresh 48-hex token) or off (clears the token).
 * Regenerating a token is accomplished by calling this twice: once with
 * `enabled=false`, then again with `enabled=true`.
 */
const webhookSchema = z.object({ enabled: z.boolean() });
routinesRouter.post(
  "/routines/:rid/webhook",
  validateBody(webhookSchema),
  async (req, res) => {
    const found = await loadRoutine((req.params as Record<string, string>).cid, req.params.rid);
    if (!found) return res.status(404).json({ error: "Not found" });
    const body = req.body as z.infer<typeof webhookSchema>;
    const r = found.routine;
    r.webhookEnabled = body.enabled;
    r.webhookToken = body.enabled ? crypto.randomBytes(24).toString("hex") : null;
    await AppDataSource.getRepository(Routine).save(r);
    await recordAudit({
      companyId: found.co.id,
      actorUserId: req.userId ?? null,
      action: body.enabled ? "routine.webhook.enable" : "routine.webhook.disable",
      targetType: "routine",
      targetId: r.id,
      targetLabel: r.name,
    });
    res.json(r);
  },
);

routinesRouter.post("/routines/:rid/run", async (req, res) => {
  const found = await loadRoutine((req.params as Record<string, string>).cid, req.params.rid);
  if (!found) return res.status(404).json({ error: "Not found" });
  await recordAudit({
    companyId: found.co.id,
    actorUserId: req.userId ?? null,
    action: "routine.run.manual",
    targetType: "routine",
    targetId: found.routine.id,
    targetLabel: found.routine.name,
  });
  const run = await runRoutine(found.routine);
  res.json(run);
});

/**
 * List recent runs for a routine, newest-first. Returns the full Run row
 * (sans log contents) so the UI can render a history timeline with status
 * badges and exit codes; log text is fetched lazily via /runs/:runId/log.
 */
routinesRouter.get("/routines/:rid/runs", async (req, res) => {
  const found = await loadRoutine((req.params as Record<string, string>).cid, req.params.rid);
  if (!found) return res.status(404).json({ error: "Not found" });
  const runs = await AppDataSource.getRepository(Run).find({
    where: { routineId: found.routine.id },
    order: { startedAt: "DESC" },
    take: 50,
  });
  res.json(runs);
});

/**
 * Stream the captured log file for a single run. We cap at 256KB — routine
 * logs should stay terse, and anything larger is almost certainly a runaway
 * that would blow up the browser.
 */
routinesRouter.get("/runs/:runId/log", async (req, res) => {
  const run = await AppDataSource.getRepository(Run).findOneBy({ id: req.params.runId });
  if (!run) return res.status(404).json({ error: "Not found" });
  // Confirm the caller has access to the parent routine (company scope).
  const found = await loadRoutine(
    (req.params as Record<string, string>).cid,
    run.routineId,
  );
  if (!found) return res.status(404).json({ error: "Not found" });
  if (!run.logsPath || !fs.existsSync(run.logsPath)) {
    return res.json({ content: "", missing: true });
  }
  const MAX = 256 * 1024;
  const stat = fs.statSync(run.logsPath);
  let content: string;
  let truncated = false;
  if (stat.size <= MAX) {
    content = fs.readFileSync(run.logsPath, "utf8");
  } else {
    const fd = fs.openSync(run.logsPath, "r");
    const buf = Buffer.alloc(MAX);
    fs.readSync(fd, buf, 0, MAX, stat.size - MAX);
    fs.closeSync(fd);
    content = buf.toString("utf8");
    truncated = true;
  }
  res.json({ content, truncated, size: stat.size });
});
